import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { findCopilotPlanContent } from "../../src/integrations/copilot.js";

const SESSION_A = "11111111-2222-3333-4444-555555555555";
const SESSION_B = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

/** Every fake Copilot home this file made, removed once its tests finish. */
const temps: string[] = [];
after(async () => {
  for (const dir of temps) await rm(dir, { recursive: true, force: true });
});

/**
 * A fake `~/.copilot` tree. `findCopilotPlanContent` reads $COPILOT_HOME first,
 * so pointing it here keeps the test off the developer's real Copilot state.
 */
async function copilotHome(
  t: { after(fn: () => void): void },
  plans: Record<string, string | null> = {},
): Promise<string> {
  const home = await mkdtemp(path.join(os.tmpdir(), "revgate-copilot-"));
  // Only the env var was restored before, so every test left a fake session-state
  // tree behind in the developer's temp directory.
  temps.push(home);
  for (const [session, content] of Object.entries(plans)) {
    const dir = path.join(home, "session-state", session);
    await mkdir(dir, { recursive: true });
    // A null plan means "the session directory exists but holds no plan.md".
    if (content !== null) await writeFile(path.join(dir, "plan.md"), content, "utf8");
  }

  const saved = process.env.COPILOT_HOME;
  process.env.COPILOT_HOME = home;
  t.after(() => {
    if (saved === undefined) delete process.env.COPILOT_HOME;
    else process.env.COPILOT_HOME = saved;
  });
  return home;
}

/** Force a plan.md's mtime so "newest wins" is deterministic. */
async function touch(home: string, session: string, whenMs: number): Promise<void> {
  const p = path.join(home, "session-state", session, "plan.md");
  await utimes(p, new Date(whenMs), new Date(whenMs));
}

// --- no state to read ------------------------------------------------------

test("findCopilotPlanContent: no session-state directory at all", async (t) => {
  await copilotHome(t);
  assert.equal(findCopilotPlanContent(SESSION_A), null);
  assert.equal(findCopilotPlanContent(), null);
});

test("findCopilotPlanContent: session-state exists but holds no plans", async (t) => {
  await copilotHome(t, { [SESSION_A]: null, [SESSION_B]: null });
  assert.equal(findCopilotPlanContent(), null);
  assert.equal(findCopilotPlanContent(SESSION_A), null);
});

// --- keyed on the session that fired the hook ------------------------------

test("findCopilotPlanContent: reads THIS session's plan.md", async (t) => {
  await copilotHome(t, { [SESSION_A]: "# Plan A\n", [SESSION_B]: "# Plan B\n" });
  assert.equal(findCopilotPlanContent(SESSION_A), "# Plan A\n");
  assert.equal(findCopilotPlanContent(SESSION_B), "# Plan B\n");
});

test("findCopilotPlanContent: a known session with no plan never borrows another's", async (t) => {
  await copilotHome(t, { [SESSION_A]: null, [SESSION_B]: "# Plan B\n" });
  // Reviewing another session's plan would gate the wrong turn — null is correct.
  assert.equal(findCopilotPlanContent(SESSION_A), null);
});

test("findCopilotPlanContent: a session id that isn't a UUID is rejected", async (t) => {
  await copilotHome(t, { [SESSION_A]: "# Plan A\n" });
  for (const id of ["manual", "cli", "latest", "..", "../..", "not-a-uuid"]) {
    assert.equal(findCopilotPlanContent(id), null, `expected null for ${id}`);
  }
});

test("findCopilotPlanContent: nothing the id filter accepts can escape the sessions dir", async (t) => {
  const home = await copilotHome(t, { [SESSION_A]: "# Plan A\n" });
  // A plan.md one level up: if a session id could ever climb out, this is what
  // it would reach — the wrong session's plan, gating the wrong turn.
  await writeFile(path.join(home, "plan.md"), "# Outside\n", "utf8");
  assert.equal(findCopilotPlanContent("../".repeat(12)), null);

  // The real guarantee is structural, not a list of rejected strings: every id
  // the filter lets through must resolve to a direct child of the sessions dir.
  // The extremes of what `/^[a-f0-9-]{36}$/i` allows — note it has no dot and
  // no separator, which is exactly why none of these can traverse.
  const accepted = [
    SESSION_A,
    "a".repeat(36),
    "------------------------------------",
    "0f0f0f0f-0f0f-0f0f-0f0f-0f0f0f0f0f0f",
    "-0-0-0-0-0-0-0-0-0-0-0-0-0-0-0-0-0-0",
  ];
  for (const id of accepted) {
    assert.match(id, /^[a-f0-9-]{36}$/i, `${id} is not what the filter accepts`);
    const rel = path.relative(home, path.join(home, id, "plan.md"));
    assert.equal(rel.startsWith(".."), false, `${id} escaped the sessions dir`);
    assert.equal(path.dirname(rel), id, `${id} did not resolve to a direct child`);
  }
});

// --- fallback: newest plan across sessions ---------------------------------

test("findCopilotPlanContent: with no session id, the newest plan.md wins", async (t) => {
  const home = await copilotHome(t, { [SESSION_A]: "# Older\n", [SESSION_B]: "# Newer\n" });
  await touch(home, SESSION_A, Date.parse("2026-07-01T00:00:00Z"));
  await touch(home, SESSION_B, Date.parse("2026-07-29T00:00:00Z"));
  assert.equal(findCopilotPlanContent(), "# Newer\n");

  // Flip the order: the answer follows the mtime, not the directory listing.
  await touch(home, SESSION_A, Date.parse("2026-07-30T00:00:00Z"));
  assert.equal(findCopilotPlanContent(), "# Older\n");
});

test("findCopilotPlanContent: sessions without a plan.md are skipped, not fatal", async (t) => {
  const home = await copilotHome(t, { [SESSION_A]: null, [SESSION_B]: "# Only one\n" });
  // A stray file next to the session directories must not be mistaken for one.
  await writeFile(path.join(home, "session-state", "loose.txt"), "noise\n", "utf8");
  assert.equal(findCopilotPlanContent(), "# Only one\n");
});

test("findCopilotPlanContent: an empty session id falls back like none at all", async (t) => {
  await copilotHome(t, { [SESSION_A]: "# Plan A\n" });
  assert.equal(findCopilotPlanContent(""), "# Plan A\n");
});

// --- an empty plan.md is "no plan" -------------------------------------------

test("findCopilotPlanContent: an empty plan.md is no plan, not a plan", async (t) => {
  // Returning "" would beat the inline plan in the hook's `?? inlinePlan`
  // fallback, so a truncated plan.md skipped the gate with usable plan text
  // carried in the very tool call being gated.
  await copilotHome(t, { [SESSION_A]: "", [SESSION_B]: "   \n\t\n" });
  assert.equal(findCopilotPlanContent(SESSION_A), null);
  assert.equal(findCopilotPlanContent(SESSION_B), null);
});

test("findCopilotPlanContent: the no-session fallback treats an empty newest plan as none", async (t) => {
  const home = await copilotHome(t, { [SESSION_A]: "# Older\n", [SESSION_B]: "" });
  await touch(home, SESSION_A, Date.parse("2026-07-01T00:00:00Z"));
  await touch(home, SESSION_B, Date.parse("2026-07-29T00:00:00Z"));
  assert.equal(findCopilotPlanContent(), null);
});
