#!/usr/bin/env node
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { collectWorkingTreeDiff, getStageStates } from "./git.js";
import { parseUnifiedDiff } from "./diff.js";
import { buildDecision } from "./feedback.js";
import { planToFiles, planTitle } from "./plan.js";
import { findCopilotPlanContent } from "./copilot.js";
import { startReviewServer, type ReviewContext } from "./server.js";
import { log, warn } from "./log.js";
import type { HookDecision, HookPayload, PermissionDecision } from "./types.js";

/** A stand-in plan for `--demo --plan`, so the plan UI is easy to try. */
const SAMPLE_PLAN = `# Plan: add rate limiting to the public API

## Goal
Stop a single client from exhausting the API by capping requests per minute.

## Steps
1. Add a token-bucket limiter keyed by API key (60 req/min, burst 10).
2. Store buckets in the existing Redis instance; fall back to in-memory if Redis is down.
3. Return HTTP 429 with a \`Retry-After\` header when the bucket is empty.
4. Emit a \`ratelimit.rejected\` metric so we can watch for abuse.

## Out of scope
- Per-endpoint limits (a follow-up).
- Billing / quota enforcement.
`;

/** Emit the `agentStop` hook result. This is the ONLY thing allowed on stdout. */
function emit(decision: HookDecision): void {
  process.stdout.write(JSON.stringify(decision) + "\n");
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
    const done = () => {
      if (!settled) {
        settled = true;
        resolve(Buffer.concat(chunks).toString("utf8"));
      }
    };
    // Guard against a hung stdin that never closes.
    const t = setTimeout(done, 2000);
    process.stdin.on("data", (c) => chunks.push(c as Buffer));
    process.stdin.on("end", () => {
      clearTimeout(t);
      done();
    });
    process.stdin.on("error", () => {
      clearTimeout(t);
      done();
    });
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
      const planCall = toolCalls.find((t) => t?.name === "exit_plan_mode") ?? toolCalls[0];
      toolName = (planCall?.name as string | undefined) ?? toolName;
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
      transcriptPath: (o.transcriptPath ?? o.transcript_path) as string | undefined,
      stopReason: (o.stopReason ?? o.stop_reason) as string | undefined,
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
  try {
    if (platform === "win32") {
      // `start` is a cmd builtin; the empty title arg avoids quoting pitfalls.
      spawn("cmd", ["/c", "start", "", url], { detached: true, stdio: "ignore" }).unref();
    } else if (platform === "darwin") {
      spawn("open", [url], { detached: true, stdio: "ignore" }).unref();
    } else {
      spawn("xdg-open", [url], { detached: true, stdio: "ignore" }).unref();
    }
  } catch (err) {
    warn(`could not auto-open browser: ${(err as Error).message}`);
  }
}

/** Read a `--plan` / `--plan <path>` / `--plan=<path>` flag from argv. */
function readPlanFlag(argv: string[]): { present: boolean; value?: string } {
  const eq = argv.find((a) => a.startsWith("--plan="));
  if (eq) return { present: true, value: eq.slice("--plan=".length) };
  const i = argv.indexOf("--plan");
  if (i === -1) return { present: false };
  const next = argv[i + 1];
  // A following token that isn't itself a flag is the plan file path.
  return { present: true, value: next && !next.startsWith("-") ? next : undefined };
}

/**
 * Resolve the plan text to review, or null to fall back to diff mode.
 * Priority: hook payload > --plan <file> > $REVGATE_PLAN_FILE > demo sample.
 */
async function resolvePlan(
  flag: { present: boolean; value?: string },
  payload: HookPayload,
  cwd: string,
  isDemo: boolean,
): Promise<string | null> {
  if (payload.plan && payload.plan.trim()) return payload.plan;
  if (!flag.present) return null;

  const file = flag.value ?? process.env.REVGATE_PLAN_FILE;
  if (file) {
    try {
      return await readFile(path.resolve(cwd, file), "utf8");
    } catch (err) {
      warn(`could not read plan file ${file}: ${(err as Error).message}`);
    }
  }
  if (isDemo) return SAMPLE_PLAN;
  // --plan was requested but no plan text was found: don't gate on an empty plan.
  warn("plan mode requested but no plan text found — falling back to diff review");
  return null;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);

  // `revgate copilot-plan` is Copilot's preToolUse plan gate — a distinct output
  // contract (permissionDecision) from the agentStop diff review below.
  if (argv[0] === "copilot-plan") {
    await runCopilotPlanHook();
    return;
  }

  const isDemo = argv.includes("--demo");
  const planFlag = readPlanFlag(argv);

  const payload =
    (await readHookPayload()) ??
    ({
      sessionId: isDemo ? "demo" : "manual",
      timestamp: Date.now(),
      cwd: process.cwd(),
      stopReason: "end_turn",
    } satisfies HookPayload);

  const cwd = payload.cwd || process.cwd();

  const planText = await resolvePlan(planFlag, payload, cwd, isDemo);
  if (planText != null) {
    await reviewPlan(payload, planText);
    return;
  }

  log(`session ${payload.sessionId} — reviewing changes in ${cwd}`);

  const repo = await collectWorkingTreeDiff(cwd);
  const files = parseUnifiedDiff(repo.unified);

  // No changes and not a demo: nothing to review, let Copilot proceed.
  if (files.length === 0 && !isDemo) {
    log(repo.isRepo ? "no changes to review — allowing" : "not a git repo — allowing");
    emit({ decision: "allow" });
    return;
  }

  // Annotate each file with its staging state so the UI can offer a toggle.
  if (repo.isRepo) {
    const states = await getStageStates(cwd);
    for (const f of files) f.staged = states[f.path] ?? "no";
  }

  const ctx: ReviewContext = {
    payload,
    branch: repo.branch,
    files,
    isRepo: repo.isRepo,
    mode: "diff",
    note: repo.isRepo ? undefined : "Not a git repository — no diff available.",
  };

  const server = await startReviewServer(ctx);
  log(`review UI at ${server.url}`);
  log(`${files.length} file(s) changed — opening browser…`);
  openBrowser(server.url);

  try {
    const review = await server.waitForSubmission;
    const decision = buildDecision(review, files, "diff");
    server.close();
    if (decision.decision === "block") {
      log("changes requested — sending feedback to Copilot as next prompt");
    } else {
      log("approved — Copilot will stop");
    }
    emit(decision);
  } catch (err) {
    // Server closed / interrupted before a review arrived: don't block Copilot.
    warn(`no review captured (${(err as Error).message}) — allowing`);
    emit({ decision: "allow" });
  }
}

/**
 * Open the plan review UI and resolve to a decision. Approve -> allow (the agent
 * proceeds); request-changes -> block with the feedback prompt (the agent revises
 * the plan first). Never throws: an interrupted review resolves to "allow" so we
 * don't wedge the agent on our own failure.
 */
async function gatePlan(payload: HookPayload, planText: string): Promise<HookDecision> {
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
  log(`plan review UI at ${server.url} — opening browser…`);
  openBrowser(server.url);

  try {
    const review = await server.waitForSubmission;
    const decision = buildDecision(review, files, "plan");
    server.close();
    if (decision.decision === "block") {
      log("plan changes requested — sending feedback to the agent as next prompt");
    } else {
      log("plan approved — the agent will proceed");
    }
    return decision;
  } catch (err) {
    warn(`no plan review captured (${(err as Error).message}) — allowing`);
    return { decision: "allow" };
  }
}

/** Review a proposed plan and emit an `agentStop`-style decision. */
async function reviewPlan(payload: HookPayload, planText: string): Promise<void> {
  emit(await gatePlan(payload, planText));
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
async function runCopilotPlanHook(): Promise<void> {
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
  const planText =
    findCopilotPlanContent(payload.sessionId) ??
    (payload.plan && payload.plan.trim() ? payload.plan : null);

  if (!planText || !planText.trim()) {
    log("no plan text found for plan hook — allowing the tool to proceed");
    emitPermission({ permissionDecision: "allow" });
    return;
  }

  const decision = await gatePlan(payload, planText);
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
  // Never leave Copilot hanging on our failure. A non-zero exit fails *closed*
  // for preToolUse (denies the tool), so we emit an explicit allow and exit 0.
  // Each hook has its own output contract — pick the one matching this run.
  if (process.argv[2] === "copilot-plan") {
    emitPermission({ permissionDecision: "allow" });
  } else {
    emit({ decision: "allow" });
  }
  process.exit(0);
});
