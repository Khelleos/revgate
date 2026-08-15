import assert from "node:assert/strict";
import { Readable } from "node:stream";
import test from "node:test";
import { gatePlan, readHookPayload } from "../../src/cli/plan-hook.js";
import type { CliOptions } from "../../src/cli/args.js";
import type { HookPayload } from "../../src/shared/types.js";

/**
 * Unit tests for the two halves of the plan gate that are worth exercising
 * in-process. `test/index.test.ts` still owns the contract-level cases — exit
 * codes and what reaches stdout can only be observed on a real process — but the
 * payload shapes and the verdict translation are plain functions now that they
 * live outside `src/index.ts`.
 */

/** A payload stream the way Copilot pipes one: bytes, then EOF. */
function stdin(text: string): Readable & { isTTY?: boolean } {
  return Readable.from([Buffer.from(text, "utf8")]);
}

/**
 * Swallow stderr and hand back the review URL the server logs there.
 *
 * `gatePlan` never returns its handle — the URL only ever reaches a human, on
 * stderr — so this is the only way to drive a submission from inside the
 * process. Restored in an after-hook, and node:test runs the tests of one file
 * sequentially, so nothing else is writing while it is patched.
 */
function captureStderr(t: { after(fn: () => void): void }): Promise<string> {
  const original = process.stderr.write;
  let seen = "";
  let resolve: (url: string) => void;
  let reject: (e: Error) => void;
  const url = new Promise<string>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  // A deadline, because node:test has no default timeout: without it a server
  // that never logs its URL hangs `npm test` forever instead of failing it.
  const timer = setTimeout(() => {
    reject(new Error(`no review URL on stderr within 20s; captured:\n${seen}`));
  }, 20_000);
  timer.unref();
  process.stderr.write = ((chunk: unknown) => {
    seen += typeof chunk === "string" ? chunk : String(chunk);
    const m = /http:\/\/127\.0\.0\.1:\d+\//.exec(seen);
    if (m) resolve(m[0]);
    return true;
  }) as typeof process.stderr.write;
  t.after(() => {
    clearTimeout(timer);
    process.stderr.write = original;
  });
  return url;
}

function options(over: Partial<CliOptions> = {}): CliOptions {
  return {
    scope: { kind: "worktree", refs: [], include: [], exclude: [] },
    open: false,
    plan: true,
    exitCodeOnComments: false,
    // Off by default: a unit test must never write to anyone's history tree.
    history: false,
    help: false,
    ...over,
  };
}

function payload(over: Partial<HookPayload> = {}): HookPayload {
  return { sessionId: "unit", timestamp: 0, cwd: process.cwd(), ...over };
}

/** POST the way the review page does: the server rejects an origin-less POST. */
async function submit(url: string, body: unknown): Promise<Response> {
  return fetch(`${url}api/submit`, {
    method: "POST",
    headers: { origin: new URL(url).origin },
    body: JSON.stringify(body),
  });
}

// --- readHookPayload -------------------------------------------------------

test("readHookPayload: reads Copilot's toolCalls shape, with args as a JSON string", async () => {
  const p = await readHookPayload(
    stdin(
      JSON.stringify({
        sessionId: "abc",
        toolCalls: [
          { id: "1", name: "exit_plan_mode", args: JSON.stringify({ plan: "# Plan: ship it\n" }) },
        ],
      }),
    ),
  );
  assert.equal(p?.toolName, "exit_plan_mode");
  assert.equal(p?.plan, "# Plan: ship it\n");
  assert.equal(p?.sessionId, "abc");
});

test("readHookPayload: args given as an object are accepted too", async () => {
  const p = await readHookPayload(
    stdin(
      JSON.stringify({
        sessionId: "abc",
        toolCalls: [{ id: "1", name: "exit_plan_mode", args: { summary: "# Plan\n" } }],
      }),
    ),
  );
  assert.equal(p?.toolName, "exit_plan_mode");
  assert.equal(p?.plan, "# Plan\n");
});

test("readHookPayload: the plan tool is found past an unrelated first tool call", async () => {
  // The gate self-filters on `toolName`, so picking toolCalls[0] blindly would
  // let a real plan through unreviewed whenever it is not the first call.
  const p = await readHookPayload(
    stdin(
      JSON.stringify({
        toolCalls: [
          { id: "1", name: "shell", args: JSON.stringify({ summary: "not a plan" }) },
          { id: "2", name: "exit_plan_mode", args: JSON.stringify({ plan: "# Plan: real\n" }) },
        ],
      }),
    ),
  );
  assert.equal(p?.toolName, "exit_plan_mode");
  assert.equal(p?.plan, "# Plan: real\n");
});

test("readHookPayload: a non-plan tool's `summary` is never harvested as a plan", async () => {
  // `summary` is a common argument name. Taking it from an unrelated tool would
  // open a plan review over someone else's arguments.
  const p = await readHookPayload(
    stdin(
      JSON.stringify({
        toolCalls: [{ id: "1", name: "write_file", args: JSON.stringify({ summary: "# Nope\n" }) }],
      }),
    ),
  );
  assert.equal(p?.toolName, "write_file");
  assert.equal(p?.plan, undefined);
});

test("readHookPayload: VS Code's snake_case shape is understood", async () => {
  const p = await readHookPayload(
    stdin(
      JSON.stringify({
        session_id: "abc",
        tool_name: "exit_plan_mode",
        tool_input: { plan: "# Plan: vs code\n" },
      }),
    ),
  );
  assert.equal(p?.sessionId, "abc");
  assert.equal(p?.toolName, "exit_plan_mode");
  assert.equal(p?.plan, "# Plan: vs code\n");
});

test("readHookPayload: a `tool_input` that is itself a JSON string is parsed", async () => {
  const p = await readHookPayload(
    stdin(
      JSON.stringify({
        tool_name: "exit_plan_mode",
        tool_input: JSON.stringify({ plan: "# Plan: nested\n" }),
      }),
    ),
  );
  assert.equal(p?.plan, "# Plan: nested\n");
});

test("readHookPayload: a leading UTF-8 BOM is stripped", async () => {
  // JSON.parse rejects it, so without the strip the whole payload is lost — and
  // with it the tool name, which turns a real plan into a pass-through.
  const p = await readHookPayload(
    stdin("﻿" + JSON.stringify({ sessionId: "bom", toolName: "exit_plan_mode" })),
  );
  assert.equal(p?.sessionId, "bom");
  assert.equal(p?.toolName, "exit_plan_mode");
});

test("readHookPayload: an empty or unparseable payload is null, never a throw", async (t) => {
  // The caller substitutes an empty payload and allows; a throw here would reach
  // main()'s last-resort handler instead.
  captureStderr(t);
  assert.equal(await readHookPayload(stdin("")), null);
  assert.equal(await readHookPayload(stdin("   \n")), null);
  assert.equal(await readHookPayload(stdin("not json at all")), null);
});

test("readHookPayload: an interactive TTY has no piped payload", async () => {
  const tty = stdin(JSON.stringify({ toolName: "exit_plan_mode" }));
  tty.isTTY = true;
  assert.equal(await readHookPayload(tty), null);
});

test("readHookPayload: missing fields fall back rather than failing", async () => {
  const p = await readHookPayload(stdin(JSON.stringify({})));
  assert.equal(p?.sessionId, "");
  assert.equal(p?.cwd, process.cwd());
  assert.equal(p?.toolName, undefined);
  assert.equal(p?.plan, undefined);
});

// --- gatePlan --------------------------------------------------------------

test("gatePlan: an approval becomes an allow decision", async (t) => {
  const url = captureStderr(t);
  const gate = gatePlan(payload(), "# Plan: ship it\n\nStep one.\n", options());

  const res = await submit(await url, { decision: "approve", summary: "", comments: [] });
  assert.equal(res.status, 200);

  const outcome = await gate;
  assert.deepEqual(outcome.decision, { decision: "allow" });
  // The plan is reviewed as one synthetic file, which is what lets the whole
  // diff pipeline run over it unchanged.
  assert.equal(outcome.files.length, 1);
  assert.equal(outcome.files[0].path, "Plan");
  assert.equal(outcome.interrupted, undefined);
});

test("gatePlan: request-changes blocks and carries the feedback back", async (t) => {
  const url = captureStderr(t);
  const gate = gatePlan(payload(), "# Plan: ship it\n\nStep one.\n", options());

  await submit(await url, {
    decision: "request_changes",
    summary: "Add a rollback step.",
    comments: [{ file: "Plan", startLine: 3, endLine: 3, side: "new", body: "Say how." }],
  });

  const outcome = await gate;
  assert.equal(outcome.decision.decision, "block");
  assert.match(outcome.decision.reason ?? "", /Add a rollback step\./);
  assert.match(outcome.decision.reason ?? "", /Plan:3 \(\+\)/);
  assert.match(outcome.decision.reason ?? "", /Say how\./);
  assert.equal(outcome.review?.decision, "request_changes");
});
