import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import path from "node:path";
import { homedir } from "node:os";

/**
 * Locate the plan text for a Copilot CLI plan-mode turn.
 *
 * Copilot writes the proposed plan to `plan.md` inside its per-session state
 * directory (`~/.copilot/session-state/<sessionId>/`) rather than passing the
 * text through the `exit_plan_mode` tool arguments, so the preToolUse hook has
 * to read it off disk. We key on the hook's `sessionId` when we have it and
 * fall back to the most recently written `plan.md` otherwise.
 *
 * Mirrors plannotator's Copilot session parser.
 */
export function findCopilotPlanContent(sessionId?: string): string | null {
  const copilotHome = process.env.COPILOT_HOME || path.join(homedir(), ".copilot");
  const sessionsDir = path.join(copilotHome, "session-state");
  if (!existsSync(sessionsDir)) return null;

  // Primary: the session that fired the hook. Validate the id as a UUID first
  // so a hostile payload can't walk us out of the sessions directory. When we
  // have a sessionId we trust ONLY that session's plan.md — never fall back to
  // another session's plan, or we'd review the wrong plan for this turn.
  if (sessionId) {
    if (/^[a-f0-9-]{36}$/i.test(sessionId)) {
      const planPath = path.join(sessionsDir, sessionId, "plan.md");
      if (existsSync(planPath)) {
        const text = readFileSync(planPath, "utf8");
        // An empty (or whitespace-only) plan.md is "no plan", not a plan.
        // Returning "" would beat the inline plan in the caller's `?? inlinePlan`
        // fallback, skipping the gate with usable plan text in hand.
        if (text.trim()) return text;
      }
    }
    return null;
  }

  // Fallback (only when the hook gave us no sessionId): newest plan.md.
  const candidates = readdirSync(sessionsDir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => {
      const p = path.join(sessionsDir, e.name, "plan.md");
      try {
        return { path: p, mtime: statSync(p).mtimeMs };
      } catch {
        return null;
      }
    })
    .filter((x): x is { path: string; mtime: number } => x !== null);

  if (candidates.length === 0) return null;
  candidates.sort((a, b) => b.mtime - a.mtime);
  // Same rule as above: an empty newest plan.md is "no plan", not a plan.
  const text = readFileSync(candidates[0].path, "utf8");
  return text.trim() ? text : null;
}
