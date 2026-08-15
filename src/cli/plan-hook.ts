// Copilot's `preToolUse` plan gate. Fail-open throughout: a non-zero exit reads
// as a denial, so every error path ends in an explicit `allow` at exit 0.
// `gatePlan` is shared with `revgate review --plan`, so it returns a decision.
import type { Readable } from "node:stream";
import { findCopilotPlanContent } from "../integrations/copilot.js";
import { buildDecision } from "../review/feedback.js";
import { planToFiles, planTitle } from "../review/plan.js";
import { openBrowser } from "../server/browser.js";
import { startReviewServer, type ReviewContext } from "../server/index.js";
import { log, warn } from "../shared/log.js";
import { saveHistory } from "../store/history.js";
import type {
  HookDecision,
  HookPayload,
  PermissionDecision,
  ReviewSubmission,
} from "../shared/types.js";
import type { CliOptions } from "./args.js";
// Type-only, so it is erased at compile time and this back-reference adds no
// cycle: `review-command.ts` imports `gatePlan` from here at runtime.
import type { ReviewOutcome } from "./review-command.js";

/** Emit a `preToolUse` permission decision (the plan hook's output contract). */
export function emitPermission(decision: PermissionDecision): void {
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

/** Read the hook payload from stdin, normalizing both known formats. */
export async function readHookPayload(
  stdin: Readable & { isTTY?: boolean } = process.stdin,
): Promise<HookPayload | null> {
  // An interactive TTY means there is no piped payload (e.g. a manual run).
  if (stdin.isTTY) return null;

  const chunks: Buffer[] = [];
  const raw: string = await new Promise((resolve) => {
    let settled = false;
    const onData = (c: Buffer) => chunks.push(c);
    const done = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // Detach: resolving alone leaves stdin flowing and referenced, so a
      // parent that never closes the pipe keeps this process alive forever.
      stdin.off("data", onData);
      stdin.off("end", done);
      stdin.off("error", done);
      stdin.pause();
      resolve(Buffer.concat(chunks).toString("utf8"));
    };
    const timer = setTimeout(done, 2000);
    stdin.on("data", onData);
    stdin.on("end", done);
    stdin.on("error", done);
  });

  // Strip a leading UTF-8 BOM — some shells and pipes prepend one.
  const clean = raw.replace(/^﻿/, "").trim();
  if (!clean) return null;
  try {
    const o = JSON.parse(clean) as Record<string, unknown>;

    // The shape the CLI emits: `toolCalls` of { id, name, args }, args a JSON
    // string, the plan in the plan tool's own `plan`/`summary`. Taking `summary`
    // off whatever came first would review an unrelated tool's arguments.
    let toolName = (o.toolName ?? o.tool_name) as string | undefined;
    let inlinePlan: string | undefined;
    const toolCalls = Array.isArray(o.toolCalls) ? (o.toolCalls as Record<string, unknown>[]) : null;
    if (toolCalls && toolCalls.length) {
      const planCall = toolCalls.find((t) => t?.name === "exit_plan_mode");
      toolName = ((planCall ?? toolCalls[0])?.name as string | undefined) ?? toolName;
      const args = parseToolArgs(planCall?.args);
      inlinePlan = (args?.plan ?? args?.summary) as string | undefined;
    }

    // Other shapes (postToolUse, VS Code, manual): the plan sits top-level or in
    // tool_input, which may itself be a JSON string.
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

/** Open the plan review UI: approve -> allow, request-changes -> block. Never throws. */
export async function gatePlan(
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
    // ONLY the await is fail-open — see reviewDiff for why the rest must not be.
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
    // Neutral wording: this path is shared with `revgate review --plan`, which
    // hands nothing to any agent.
    log(decision.decision === "block" ? "plan changes requested" : "plan approved");
    return { decision, review, files };
  } finally {
    server.close();
  }
}

/**
 * The `revgate copilot-plan` entry. The hook fires before EVERY tool and carries
 * no matcher, so anything not positively `exit_plan_mode` passes through: better
 * to miss a gate than to gate an unrelated tool.
 */
export async function runCopilotPlanHook(options: CliOptions): Promise<void> {
  const payload = (await readHookPayload()) ?? {
    sessionId: "",
    timestamp: Date.now(),
    cwd: process.cwd(),
  };

  if (payload.toolName !== "exit_plan_mode") {
    if (!payload.toolName) warn("preToolUse payload had no identifiable tool — allowing");
    emitPermission({ permissionDecision: "allow" });
    return;
  }

  // Prefer the full plan Copilot wrote for THIS session, else the condensed one
  // in the tool arguments. With no session id the cross-session scan could return
  // another repository's plan, so there the inline plan wins and the scan is last.
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
