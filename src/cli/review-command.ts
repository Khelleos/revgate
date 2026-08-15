// The `revgate review` command. NOT a hook: no payload on stdin, no hook JSON on
// stdout, real exit codes. The plan half reuses `gatePlan` from the hook module.
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { collectDiff } from "../git/collect.js";
import { describeScope, filterFiles, ScopeError } from "../git/scope.js";
import { getStageStates } from "../git/staging.js";
import { parseUnifiedDiff } from "../review/diff.js";
import { reviewReport, type ReviewOutcomeSummary } from "../review/report.js";
import { openBrowser } from "../server/browser.js";
import { startReviewServer, type ReviewContext } from "../server/index.js";
import { log, warn } from "../shared/log.js";
import { saveHistory } from "../store/history.js";
import type { HookDecision, HookPayload, ReviewSubmission } from "../shared/types.js";
import type { CliOptions } from "./args.js";
import { gatePlan } from "./plan-hook.js";

/** One review's output: `ReviewOutcomeSummary` plus what only the hook paths need. */
export interface ReviewOutcome extends ReviewOutcomeSummary {
  /** The hook verdict, set only by the plan path. */
  decision?: HookDecision;
}

/**
 * The plan text to review, or null when `--plan` was not asked for: `--plan
 * <file>` beats `$REVGATE_PLAN_FILE`. Strict, because the skill reads exit 0 as
 * "approved, start implementing" — a missing plan is bad usage (exit 2).
 */
export async function resolvePlan(options: CliOptions, cwd: string): Promise<string | null> {
  if (!options.plan) return null;

  // `||`, not `??`: an empty planFile is "no path was given", and falling back
  // to the env var is exactly what bare `--plan` documents.
  const file = options.planFile || process.env.REVGATE_PLAN_FILE;
  if (file) {
    try {
      const text = await readFile(path.resolve(cwd, file), "utf8");
      // An existing-but-empty file is not a plan: reviewing a blank document the
      // reviewer can only approve is a sign-off on nothing.
      if (text.trim()) return text;
      warn(`plan file ${file} is empty`);
    } catch (err) {
      throw new ScopeError(`could not read plan file ${file}: ${(err as Error).message}`);
    }
  }
  throw new ScopeError(
    "--plan was given but no plan text was found — pass a file or set $REVGATE_PLAN_FILE",
  );
}

/** `revgate review` — the on-demand entry point the skill drives. */
export async function runReviewCommand(options: CliOptions): Promise<void> {
  const cwd = process.cwd();
  const payload: HookPayload = { sessionId: "cli", timestamp: Date.now(), cwd };

  const planText = await resolvePlan(options, cwd);
  const outcome = planText != null
    ? await gatePlan(payload, planText, options)
    : await reviewDiff(payload, options);

  // `--output` when asked, otherwise stdout: the only thing this command ever
  // writes there, and never hook JSON.
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
      // The human has already reviewed, and exit 1 reads as "no verdict".
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

/** Open the diff review UI and resolve to an outcome. Never throws. */
export async function reviewDiff(
  payload: HookPayload,
  options: CliOptions,
): Promise<ReviewOutcome> {
  const cwd = payload.cwd || process.cwd();
  log(`session ${payload.sessionId} — reviewing ${describeScope(options.scope)} in ${cwd}`);

  const repo = await collectDiff(cwd, options.scope);
  // Seeded with the untracked files `collectDiff` refused: one count, one report.
  let droppedPaths = repo.droppedUntracked ?? 0;
  const changed = parseUnifiedDiff(repo.unified, () => {
    droppedPaths++;
  });
  const files = filterFiles(changed, options.scope);

  // An -I/-X pair matching nothing is otherwise an empty scope. Carried on the
  // outcome, because stderr does not reach an agent reading only `-o <file>`.
  const filteredOut = changed.length > 0 && files.length === 0 ? changed.length : 0;
  if (filteredOut) {
    warn(
      `every one of the ${changed.length} changed file(s) was removed by the path ` +
        `filters — nothing is being reviewed in ${repo.scopeLabel}`,
    );
    warn("-I/--include and -X/--exclude prefixes are relative to the repository root");
  }

  // No changes: nothing to review.
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
      // Same reason as `filteredOut`: an empty diff is not always a clean tree.
      untrackedScanFailed: repo.untrackedScanFailed,
      droppedPaths,
    };
  }

  // Only where staging is meaningful: in a ref/range scope the index says
  // nothing about the reviewed content, and acting on it would reach outside it.
  const scopeKind = options.scope.kind;
  const canStage = repo.isRepo && (scopeKind === "worktree" || scopeKind === "staged");
  if (canStage) {
    const states = await getStageStates(cwd);
    for (const f of files) f.staged = states[f.path] ?? "no";
  }

  // Unlike the empty branch above, a failed scan here leaves a review that looks
  // complete while every new file is missing. Say it on the page and the report.
  const scanWarning = repo.untrackedScanFailed
    ? "Listing untracked files failed — any new file in this scope is missing from this diff."
    : undefined;
  if (scanWarning) warn(scanWarning);

  const ctx: ReviewContext = {
    // The resolved cwd: the stage routes run git in it, and the raw one may be empty.
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
    // ONLY the await is fail-open: once a verdict has arrived, a later throw must
    // not be reported as "no review captured" and invert it into an approval.
    let review: ReviewSubmission;
    try {
      review = await server.waitForSubmission;
    } catch (err) {
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
        droppedPaths,
      };
    }

    // Persist first: the archive is what survives an agent that ignores the report.
    await saveHistory(review, files, {
      cwd,
      sessionId: payload.sessionId,
      scope: repo.scopeLabel,
      branch: repo.branch,
      mode: "diff",
      untrackedScanFailed: repo.untrackedScanFailed,
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
      // Carried even beside a verdict: it covers only the files that got in.
      untrackedScanFailed: repo.untrackedScanFailed,
      droppedPaths,
    };
  } finally {
    // Always: a throw after the submission would leave the listener open.
    server.close();
  }
}
