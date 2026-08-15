import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import path from "node:path";
import { homedir } from "node:os";

/**
 * Locate the plan text for a Copilot plan-mode turn. Copilot writes it to
 * `plan.md` under `~/.copilot/session-state/<sessionId>/` rather than passing it
 * through the tool arguments, so the hook reads it off disk.
 */
export function findCopilotPlanContent(sessionId?: string): string | null {
  const copilotHome = process.env.COPILOT_HOME || path.join(homedir(), ".copilot");
  const sessionsDir = path.join(copilotHome, "session-state");
  if (!existsSync(sessionsDir)) return null;

  // With a session id, trust ONLY that session's plan.md: another session's is
  // the wrong plan for this turn. The UUID check keeps a payload in the directory.
  if (sessionId) {
    if (/^[a-f0-9-]{36}$/i.test(sessionId)) {
      const planPath = path.join(sessionsDir, sessionId, "plan.md");
      if (existsSync(planPath)) {
        const text = readFileSync(planPath, "utf8");
        // An empty plan.md is "no plan": "" would beat the caller's `??` fallback.
        if (text.trim()) return text;
      }
    }
    return null;
  }

  // Only when the hook gave us no sessionId: the newest plan.md anywhere.
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
  const text = readFileSync(candidates[0].path, "utf8");
  return text.trim() ? text : null;
}
