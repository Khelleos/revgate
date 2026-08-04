#!/usr/bin/env node
import { spawn } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { collectDiff, describeScope, filterFiles, getStageStates, ScopeError } from "./git.js";
import { parseUnifiedDiff } from "./diff.js";
import { buildDecision } from "./feedback.js";
import { saveHistory } from "./history.js";
import { reviewReport, type ReviewOutcomeSummary } from "./output.js";
import { planToFiles, planTitle } from "./plan.js";
import { findCopilotPlanContent } from "./copilot.js";
import { startReviewServer, type ReviewContext } from "./server.js";
import { parseArgs, helpText, type CliOptions } from "./cli.js";
import { log, warn } from "./log.js";
import type {
  HookDecision,
  HookPayload,
  PermissionDecision,
  ReviewSubmission,
} from "./types.js";

/**
 * Everything one review produced. The report fields live on
 * `ReviewOutcomeSummary` (output.ts), the type `reviewReport` consumes, so the
 * two cannot drift; this adds only what the hook paths need on top.
 */
interface ReviewOutcome extends ReviewOutcomeSummary {
  /**
   * The hook verdict, set only by the plan path: `runCopilotPlanHook` turns it
   * into preToolUse JSON. A diff review's verdict reaches the agent as
   * annotations instead, so `reviewDiff` never builds one.
   */
  decision?: HookDecision;
}

/** Emit a `preToolUse` permission decision (the plan hook's output contract). */
function emitPermission(decision: PermissionDecision): void {
  process.stdout.write(JSON.stringify(decision) + "\n");
}

/** Tool args reach us as a nested object or a JSON string; normalize to an object. */
function parseToolArgs(a: unknown): Record<string, unknown> | undefined {
  if (a && typeof a === "object") return a as Record<string, unknown>;
  if (typeof a === "string" && a.trim()) {
    try {
      return JSON.parse(a) as Record<string, unknown>;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

/** Read Copilot's hook payload from stdin, normalizing both known formats. */
async function readHookPayload(): Promise<HookPayload | null> {
  // If stdin is an interactive TTY there is no piped payload (e.g. manual run).
  if (process.stdin.isTTY) return null;

  const chunks: Buffer[] = [];
  const raw: string = await new Promise((resolve) => {
    let settled = false;
    const onData = (c: Buffer) => chunks.push(c);
    const done = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // Detach and stop reading. Resolving alone is not enough: an attached
      // `data` listener keeps stdin flowing and referenced, so a parent that
      // never closes the pipe would keep this process alive forever — exactly
      // the hang the timeout below exists to prevent.
      process.stdin.off("data", onData);
      process.stdin.off("end", done);
      process.stdin.off("error", done);
      process.stdin.pause();
      resolve(Buffer.concat(chunks).toString("utf8"));
    };
    // Guard against a hung stdin that never closes.
    const timer = setTimeout(done, 2000);
    process.stdin.on("data", onData);
    process.stdin.on("end", done);
    process.stdin.on("error", done);
  });

  // Strip a leading UTF-8 BOM — some shells/pipes prepend one to stdin.
  const clean = raw.replace(/^﻿/, "").trim();
  if (!clean) return null;
  try {
    const o = JSON.parse(clean) as Record<string, unknown>;

    // Copilot's `preToolUse` payload carries a `toolCalls` array — each entry is
    // { id, name, args } where `args` is a JSON *string*. This is the shape the
    // CLI actually emits (the plan tool name is toolCalls[].name, and the plan
    // rides in the tool's `summary`/`plan` arg), so parse it first.
    let toolName = (o.toolName ?? o.tool_name) as string | undefined;
    let inlinePlan: string | undefined;
    const toolCalls = Array.isArray(o.toolCalls) ? (o.toolCalls as Record<string, unknown>[]) : null;
    if (toolCalls && toolCalls.length) {
      const planCall = toolCalls.find((t) => t?.name === "exit_plan_mode");
      toolName = ((planCall ?? toolCalls[0])?.name as string | undefined) ?? toolName;
      // Only the plan tool's arguments carry a plan. `summary` is a common
      // argument name on unrelated tools, and harvesting it from whatever
      // happened to be first would open a plan review over someone else's args.
      const args = parseToolArgs(planCall?.args);
      inlinePlan = (args?.plan ?? args?.summary) as string | undefined;
    }

    // Other shapes (postToolUse / VS Code / manual): plan sits top-level or in
    // tool_input. `toolArgs`/`tool_input` may itself be a JSON string.
    const toolInput = parseToolArgs(o.toolArgs ?? o.tool_input ?? o.toolInput ?? o.input);
    const plan = (o.plan ?? inlinePlan ?? toolInput?.plan) as string | undefined;

    // Accept camelCase or VS Code snake_case field names.
    return {
      sessionId: String(o.sessionId ?? o.session_id ?? ""),
      timestamp: (o.timestamp as number | string) ?? Date.now(),
      cwd: String(o.cwd ?? process.cwd()),
      toolName,
      plan: typeof plan === "string" ? plan : undefined,
    };
  } catch (err) {
    warn(`could not parse hook payload: ${(err as Error).message}`);
    return null;
  }
}

function openBrowser(url: string): void {
  const platform = process.platform;
  const [command, args] =
    platform === "win32"
      // `start` is a cmd builtin; the empty title arg avoids quoting pitfalls.
      ? ["cmd", ["/c", "start", "", url]]
      : platform === "darwin"
        ? ["open", [url]]
        : ["xdg-open", [url]];
  try {
    const child = spawn(command as string, args as string[], { detached: true, stdio: "ignore" });
    // A missing opener (xdg-open on a headless box) surfaces as an ASYNC `error`
    // event, which the try/catch cannot see. Without a listener Node rethrows it
    // as an uncaughtException and kills the process — and preToolUse fails CLOSED
    // on a non-zero exit, so not opening a browser would deny every plan.
    child.once("error", (err) => warn(`could not auto-open browser: ${err.message}`));
    child.unref();
  } catch (err) {
    warn(`could not auto-open browser: ${(err as Error).message}`);
  }
}

/**
 * Resolve the plan text to review, or null when `--plan` was not asked for.
 * Priority: --plan <file> > $REVGATE_PLAN_FILE.
 *
 * Strict on purpose: the caller is `revgate review`, whose skill reads exit 0
 * as "the plan is approved, start implementing" — so a typo'd path silently
 * reviewing the working tree instead would forge a plan approval. A missing or
 * empty plan is bad usage (exit 2), never a silent fallback. (The plan *hook*
 * never reaches this: `runCopilotPlanHook` resolves its plan from the payload
 * and Copilot's session state, and fails open instead.)
 */
async function resolvePlan(options: CliOptions, cwd: string): Promise<string | null> {
  if (!options.plan) return null;

  // `||`, not `??`: an empty planFile is "no path was given", and falling back
  // to the env var is exactly what bare `--plan` documents.
  const file = options.planFile || process.env.REVGATE_PLAN_FILE;
  if (file) {
    try {
      const text = await readFile(path.resolve(cwd, file), "utf8");
      // An existing-but-empty file is not a plan. Returning "" would open a
      // review of a blank document that the reviewer can only approve — a
      // sign-off on nothing. Fall through to the no-plan-found handling below.
      if (text.trim()) return text;
      warn(`plan file ${file} is empty`);
    } catch (err) {
      throw new ScopeError(`could not read plan file ${file}: ${(err as Error).message}`);
    }
  }
  // --plan was requested but no plan text was found: don't gate on an empty plan.
  throw new ScopeError(
    "--plan was given but no plan text was found — pass a file or set $REVGATE_PLAN_FILE",
  );
}

async function main(): Promise<void> {
  const cli = parseArgs(process.argv.slice(2));

  // `revgate copilot-plan` is Copilot's preToolUse plan gate — the one hook
  // entry point, with its own output contract (permissionDecision).
  if (cli.command === "copilot-plan") {
    await runCopilotPlanHook(cli.options);
    return;
  }

  // A bad command line stays bad even with --help appended. Checking help first
  // would exit 0 on `revgate review --bogus --help`, and an agent recovering
  // from a usage error by adding --help would read that as success and loop.
  // Print the usage it asked for, but keep the exit-2 contract.
  if (cli.command === "review" && cli.error) {
    warn(cli.error);
    if (cli.options.help) process.stdout.write(helpText());
    else warn("run `revgate review --help` for usage");
    process.exitCode = 2;
    return;
  }

  // A human asked for usage, so stdout is the right stream: no hook ever passes
  // --help, and nothing else has been written to stdout at this point.
  if (cli.options.help) {
    process.stdout.write(helpText());
    return;
  }

  try {
    await runReviewCommand(cli.options);
  } catch (err) {
    // A ref that doesn't resolve is bad usage, not a crash.
    if (!(err instanceof ScopeError)) throw err;
    warn(err.message);
    warn("run `revgate review --help` for usage");
    process.exitCode = 2;
  }
}

/**
 * `revgate review` — the on-demand entry point the skill drives. This is NOT a
 * hook: there is no payload on stdin, no hook JSON on stdout, and real exit
 * codes are fair game.
 */
async function runReviewCommand(options: CliOptions): Promise<void> {
  const cwd = process.cwd();
  const payload: HookPayload = { sessionId: "cli", timestamp: Date.now(), cwd };

  const planText = await resolvePlan(options, cwd);
  const outcome = planText != null
    ? await gatePlan(payload, planText, options)
    : await reviewDiff(payload, options);

  // Deliver the report the same way on every path: to --output when asked,
  // otherwise to stdout — the only thing this path ever writes there, never
  // hook JSON.
  const deliver = async (text: string) => {
    if (!options.output) {
      process.stdout.write(text);
      return;
    }
    const dest = path.resolve(cwd, options.output);
    try {
      await writeFile(dest, text, "utf8");
      log(`annotations written to ${dest}`);
    } catch (err) {
      // The human has already reviewed. Letting this throw would lose their
      // verdict entirely and surface as exit 1 — which both skills read as
      // "no verdict was captured", the exact inversion of a review that did
      // happen. stdout is the fallback the caller can still read.
      warn(`could not write ${dest}: ${(err as Error).message}`);
      warn("writing the annotations to stdout instead");
      process.stdout.write(text);
    }
  };

  const report = reviewReport(
    outcome,
    planText != null ? "plan" : "diff",
    options.exitCodeOnComments,
  );
  if (report.kind === "interrupted") {
    warn("no verdict was captured — reporting an error rather than an approval");
  } else if (report.kind === "not-a-repo") {
    warn("not a git repository — nothing was reviewed");
    warn("run `revgate review` from inside a repository");
  } else if (report.kind === "scan-failed") {
    warn("the untracked-file scan failed — reporting an error rather than an approval");
  } else if (report.kind === "dropped-paths") {
    warn("every changed file was dropped for a line break in its path — not an approval");
  }
  await deliver(report.text);
  process.exitCode = report.exitCode;
}

/**
 * Open the diff review UI and resolve to an outcome. Only the caller (`revgate
 * review`) decides what reaches stdout. Never throws: an interrupted review
 * resolves to "allow", which `reviewReport` renders as NO REVIEW CAPTURED.
 */
async function reviewDiff(payload: HookPayload, options: CliOptions): Promise<ReviewOutcome> {
  const cwd = payload.cwd || process.cwd();
  log(`session ${payload.sessionId} — reviewing ${describeScope(options.scope)} in ${cwd}`);

  const repo = await collectDiff(cwd, options.scope);
  // Seeded with the untracked files `collectDiff` refused to synthesize: both
  // halves were dropped for the same reason (a line break in the path), so the
  // report counts them together rather than accounting for one and losing the
  // other to stderr.
  let droppedPaths = repo.droppedUntracked ?? 0;
  const changed = parseUnifiedDiff(repo.unified, () => {
    droppedPaths++;
  });
  const files = filterFiles(changed, options.scope);

  // An -I/-X pair that matches nothing would otherwise be indistinguishable from
  // an empty scope below: both take the "nothing to review" branch. A mistyped or
  // wrongly-anchored prefix must not turn a busy diff into a clean bill of health,
  // so it is both said out loud here and carried on the outcome — stderr does not
  // reach an agent reading only `-o <file>`, and `reviewReport` turns the count
  // into a NOTHING IN SCOPE report and exit 2 instead of APPROVED and exit 0.
  const filteredOut = changed.length > 0 && files.length === 0 ? changed.length : 0;
  if (filteredOut) {
    warn(
      `every one of the ${changed.length} changed file(s) was removed by the path ` +
        `filters — nothing is being reviewed in ${repo.scopeLabel}`,
    );
    warn("-I/--include and -X/--exclude prefixes are relative to the repository root");
  }

  // No changes: nothing to review, let Copilot proceed.
  if (files.length === 0) {
    const note = repo.isRepo
      ? `No changes to review in ${repo.scopeLabel}.`
      : "Not a git repository — no diff available.";
    log(`${note} Allowing.`);
    return {
      review: null,
      files,
      scope: repo.scopeLabel,
      branch: repo.branch,
      note,
      isRepo: repo.isRepo,
      filteredOut,
      // Carried for the same reason as `filteredOut`: an empty diff whose
      // untracked scan failed is not a clean tree, and stderr does not reach an
      // agent reading only `-o <file>`.
      untrackedScanFailed: repo.untrackedScanFailed,
      // Same again: a diff left empty by dropping the only changed file is not
      // an empty diff.
      droppedPaths,
    };
  }

  // Annotate each file with its staging state so the UI can offer a toggle.
  // Only where staging is meaningful: in a ref/range scope the index has no
  // bearing on what is being reviewed, so the toggle would lie — and acting on
  // it would touch working-tree content that is not in the reviewed diff.
  const scopeKind = options.scope.kind;
  const canStage = repo.isRepo && (scopeKind === "worktree" || scopeKind === "staged");
  if (canStage) {
    const states = await getStageStates(cwd);
    for (const f of files) f.staged = states[f.path] ?? "no";
  }

  // A failed untracked scan does not stop the tracked diff from rendering, so
  // this branch (unlike the empty one above) shows a review that looks complete
  // while every new file is missing from it. The reviewer approves what they can
  // see, and neither the page nor the annotation report said anything — only
  // stderr did, which is exactly what a browser and an `-o <file>` reader don't
  // read. Say it in both places instead.
  const scanWarning = repo.untrackedScanFailed
    ? "Listing untracked files failed — any new file in this scope is missing from this diff."
    : undefined;
  if (scanWarning) warn(scanWarning);

  const ctx: ReviewContext = {
    // The resolved cwd, not the raw payload's: `payload.cwd` may be empty, and
    // the stage routes run git in it. Handing over the raw value would let the
    // diff and the staging action disagree about which directory they mean.
    payload: { ...payload, cwd },
    branch: repo.branch,
    files,
    isRepo: repo.isRepo,
    canStage,
    mode: "diff",
    scope: repo.scopeLabel,
    note: repo.isRepo ? undefined : "Not a git repository — no diff available.",
    warning: scanWarning,
  };

  const server = await startReviewServer(ctx);
  log(`review UI at ${server.url}`);
  log(`${files.length} file(s) changed — ${options.open ? "opening browser…" : "open it to review"}`);
  if (options.open) openBrowser(server.url);

  try {
    // ONLY the await is inside the fail-open catch. "Interrupted" means no
    // verdict arrived; once one has, a later throw (history, a broken stderr
    // pipe) must not be reported as "no review captured" — that would turn a
    // request-changes verdict into an approval, the exact inversion this
    // handler is supposed to prevent.
    let review: ReviewSubmission;
    try {
      review = await server.waitForSubmission;
    } catch (err) {
      // Server closed / interrupted before a review arrived: don't block Copilot.
      const note = `No review was captured (${(err as Error).message}).`;
      warn(`${note} Allowing.`);
      return {
        review: null,
        files,
        scope: repo.scopeLabel,
        branch: repo.branch,
        note,
        interrupted: true,
        isRepo: repo.isRepo,
        untrackedScanFailed: repo.untrackedScanFailed,
      };
    }

    // Persist before returning: the annotations may be handed to an agent that
    // ignores them, and the archive is what survives that.
    await saveHistory(review, files, {
      cwd,
      sessionId: payload.sessionId,
      scope: repo.scopeLabel,
      branch: repo.branch,
      mode: "diff",
      // Carried for the same reason the returned outcome carries it: the archive
      // is what gets re-read when the live report is lost, and a copy that drops
      // this line reads as a complete review of the turn.
      untrackedScanFailed: repo.untrackedScanFailed,
      // Same again: the archive must not present a diff a changed file never
      // reached as a review of every changed file.
      droppedPaths,
      enabled: options.history,
      historyDir: options.historyDir,
    });
    log(
      review.decision === "request_changes"
        ? `changes requested (${review.comments.length} comment(s))`
        : "approved",
    );
    return {
      review,
      files,
      scope: repo.scopeLabel,
      branch: repo.branch,
      isRepo: repo.isRepo,
      // Carried even alongside a real verdict: the verdict covers the files that
      // made it into the diff, and the report has to say which ones didn't.
      untrackedScanFailed: repo.untrackedScanFailed,
      droppedPaths,
    };
  } finally {
    // Always: a throw between the submission and the return would otherwise
    // leave the listener open and hang the process instead of exiting.
    server.close();
  }
}

/**
 * Open the plan review UI and resolve to a decision. Approve -> allow (the agent
 * proceeds); request-changes -> block with the feedback prompt (the agent revises
 * the plan first). Never throws: an interrupted review resolves to "allow" so we
 * don't wedge the agent on our own failure.
 */
async function gatePlan(
  payload: HookPayload,
  planText: string,
  options: CliOptions,
): Promise<ReviewOutcome & { decision: HookDecision }> {
  const open = options.open;
  const files = planToFiles(planText);
  const ctx: ReviewContext = {
    payload,
    branch: null,
    files,
    isRepo: false,
    mode: "plan",
    planTitle: planTitle(planText),
  };

  log(`session ${payload.sessionId} — reviewing proposed plan`);
  const server = await startReviewServer(ctx);
  log(`plan review UI at ${server.url}${open ? " — opening browser…" : ""}`);
  if (open) openBrowser(server.url);

  try {
    // Only the await is fail-open — see reviewDiff for why the rest must not be.
    let review: ReviewSubmission;
    try {
      review = await server.waitForSubmission;
    } catch (err) {
      const note = `No plan review was captured (${(err as Error).message}).`;
      warn(`${note} Allowing.`);
      return { decision: { decision: "allow" }, review: null, files, note, interrupted: true };
    }

    const decision = buildDecision(review, files);
    await saveHistory(review, files, {
      cwd: payload.cwd || process.cwd(),
      sessionId: payload.sessionId,
      scope: ctx.planTitle ? `plan: ${ctx.planTitle}` : "plan",
      mode: "plan",
      enabled: options.history,
      historyDir: options.historyDir,
    });
    // Neutral wording on purpose: this path is shared between the plan hook
    // (which hands the verdict to Copilot) and `revgate review --plan` (which
    // hands nothing to any agent).
    log(decision.decision === "block" ? "plan changes requested" : "plan approved");
    return { decision, review, files };
  } finally {
    server.close();
  }
}

/**
 * Copilot `preToolUse` entry (`revgate copilot-plan`). This hook fires before
 * EVERY tool call and carries no matcher, so we self-filter: any tool other than
 * the plan tool passes straight through. For `exit_plan_mode` we open the plan
 * review and translate the verdict into Copilot's permission contract.
 *
 * Fail open on every error path: a crash/non-zero exit would fail *closed* and
 * silently deny the tool, so we always emit an explicit "allow" and exit 0.
 */
async function runCopilotPlanHook(options: CliOptions): Promise<void> {
  const payload = (await readHookPayload()) ?? {
    sessionId: "",
    timestamp: Date.now(),
    cwd: process.cwd(),
  };

  // Only gate the plan tool. The hook fires before EVERY tool, so anything we
  // can't positively identify as exit_plan_mode passes straight through — better
  // to miss a gate than to pop a bogus plan review in front of an unrelated tool.
  if (payload.toolName !== "exit_plan_mode") {
    if (!payload.toolName) warn("preToolUse payload had no identifiable tool — allowing");
    emitPermission({ permissionDecision: "allow" });
    return;
  }

  // Prefer the full plan Copilot wrote to plan.md for THIS session; fall back to
  // the (condensed) plan carried inline in the exit_plan_mode tool arguments.
  //
  // With no session id there is no "this session" to key on, and
  // findCopilotPlanContent would hand back the newest plan.md across *every*
  // session — including one from another repository. The plan this very tool
  // call carries is the one thing we know belongs to the turn being gated, so
  // it wins there; the cross-session scan stays as a last resort for a payload
  // that identifies neither.
  const inlinePlan = payload.plan && payload.plan.trim() ? payload.plan : null;
  const planText = payload.sessionId
    ? findCopilotPlanContent(payload.sessionId) ?? inlinePlan
    : inlinePlan ?? findCopilotPlanContent();

  if (!planText || !planText.trim()) {
    log("no plan text found for plan hook — allowing the tool to proceed");
    emitPermission({ permissionDecision: "allow" });
    return;
  }

  const { decision } = await gatePlan(payload, planText, options);
  if (decision.decision === "block") {
    emitPermission({
      permissionDecision: "deny",
      permissionDecisionReason: decision.reason ?? "The reviewer requested changes to the plan.",
    });
  } else {
    emitPermission({ permissionDecision: "allow" });
  }
}

main().catch((err) => {
  warn(`fatal: ${(err as Error).stack ?? err}`);
  // Which contract this run owes stdout. Derived from parseArgs — the same
  // routing main() used — rather than re-reading argv here, so the two cannot
  // disagree about what a command line means.
  const { command } = parseArgs(process.argv.slice(2));
  // `review` is a plain CLI command, not a hook: report the failure honestly.
  if (command === "review") {
    process.exitCode = 1;
    return;
  }
  // The plan hook must never leave Copilot hanging on our failure. A non-zero
  // exit fails *closed* for preToolUse (denies the tool), so we emit an
  // explicit allow and exit 0. Set the code and let the event loop drain
  // instead of calling process.exit: stdout to a pipe is asynchronous, and
  // exiting here can truncate the very decision JSON this handler exists to
  // deliver.
  emitPermission({ permissionDecision: "allow" });
  process.exitCode = 0;
});
