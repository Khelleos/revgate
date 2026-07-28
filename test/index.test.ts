import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRepo, type TempRepo } from "./helpers/repo.js";

/**
 * End-to-end tests for the entry point. `src/index.ts` runs `main()` on import
 * and owns two mutually exclusive output contracts (annotations on stdout for
 * `review`, preToolUse JSON for `copilot-plan`), so it is exercised as a real
 * process — that is the only way to observe exit codes and stream discipline
 * honestly.
 */
const ENTRY = fileURLToPath(new URL("../src/index.ts", import.meta.url));
// The child is plain `node`, so it needs tsx's loader to run TypeScript.
// `import.meta.resolve` is unavailable under tsx's transform; require.resolve is.
// `--import` needs a file:// URL — on Windows a bare `D:\...` path is rejected.
const TSX_LOADER = pathToFileURL(createRequire(import.meta.url).resolve("tsx")).href;

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

interface RunOptions {
  cwd?: string;
  /** Written to stdin, which is then closed. Hook paths read a payload here. */
  stdin?: string;
  env?: Record<string, string>;
}

function launch(args: string[], opts: RunOptions = {}): ChildProcessWithoutNullStreams {
  return spawn(process.execPath, ["--import", TSX_LOADER, ENTRY, ...args], {
    cwd: opts.cwd ?? process.cwd(),
    windowsHide: true,
    env: {
      ...process.env,
      // Never let a test touch the developer's real review history.
      REVGATE_HISTORY_DIR: path.join(os.tmpdir(), "revgate-test-history-unused"),
      ...opts.env,
    },
  }) as ChildProcessWithoutNullStreams;
}

function collect(child: ChildProcessWithoutNullStreams): {
  stdout: () => string;
  stderr: () => string;
  done: Promise<RunResult>;
} {
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (c: Buffer) => (stdout += c.toString("utf8")));
  child.stderr.on("data", (c: Buffer) => (stderr += c.toString("utf8")));
  const done = new Promise<RunResult>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code) => resolve({ code: code ?? -1, stdout, stderr }));
  });
  return { stdout: () => stdout, stderr: () => stderr, done };
}

/** Run to completion. Only for invocations that never open the review UI. */
async function run(args: string[], opts: RunOptions = {}): Promise<RunResult> {
  const child = launch(args, opts);
  const streams = collect(child);
  if (opts.stdin !== undefined) child.stdin.end(opts.stdin);
  else child.stdin.end();
  return streams.done;
}

/** Wait for the review server's URL to show up on stderr. */
async function waitForUrl(read: () => string, done: Promise<RunResult>): Promise<string> {
  const deadline = Date.now() + 20_000;
  for (;;) {
    const m = /http:\/\/127\.0\.0\.1:\d+\//.exec(read());
    if (m) return m[0];
    if (Date.now() > deadline) throw new Error(`timed out waiting for the UI url; stderr:\n${read()}`);
    const exited = await Promise.race([
      done.then(() => true),
      new Promise<false>((r) => setTimeout(() => r(false), 50)),
    ]);
    if (exited) throw new Error(`process exited before serving; stderr:\n${read()}`);
  }
}

/**
 * The headers our own review page sends on a POST. The server rejects an
 * origin-less POST — that is how a cross-site form would forge a verdict — and
 * `fetch` under Node, unlike a browser, does not attach Origin by itself.
 */
function pageHeaders(url: string): Record<string, string> {
  return { origin: new URL(url).origin };
}

/** A repo with one committed file and no pending changes. */
async function cleanRepo(t: { after(fn: () => Promise<void>): void }): Promise<TempRepo> {
  const repo = await createRepo({ "a.txt": "one\n" });
  t.after(() => repo.cleanup());
  return repo;
}

/**
 * A throwaway directory that is always removed again.
 *
 * Bare `mkdtemp` calls left a fake $COPILOT_HOME, a history tree or an output
 * directory in %TEMP% for every run of the suite — a dozen per `npm test`, none
 * of them ever collected. Taking `t` makes the cleanup impossible to forget.
 */
async function tempDir(
  t: { after(fn: () => Promise<void>): void },
  label: string,
): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), `revgate-${label}-`));
  t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 3 }));
  return dir;
}

// --- usage -----------------------------------------------------------------

test("review --help: prints every flag on stdout and exits 0", async () => {
  const { code, stdout, stderr } = await run(["review", "--help"]);
  assert.equal(code, 0);
  assert.equal(stderr, "");
  for (const flag of [
    "--staged",
    "--include",
    "--exclude",
    "--plan",
    "--output",
    "--exit-code-on-comments",
    "--history-dir",
    "--no-history",
    "--no-open",
    "--demo",
    "--help",
  ]) {
    assert.ok(stdout.includes(flag), `--help should document ${flag}`);
  }
  assert.match(stdout, /Exit codes:/);
  assert.match(stdout, /^ {2}10 {2}comments were captured/m);
});

test("review: an unknown flag is bad usage — exit 2, nothing on stdout", async () => {
  const { code, stdout, stderr } = await run(["review", "--bogus"]);
  assert.equal(code, 2);
  assert.equal(stdout, "");
  assert.match(stderr, /unknown flag: --bogus/);
  assert.match(stderr, /revgate review --help/);
});

test("review: an unresolvable ref is bad usage, not a crash", async (t) => {
  const repo = await cleanRepo(t);
  const { code, stdout, stderr } = await run(["review", "does-not-exist"], { cwd: repo.dir });
  assert.equal(code, 2);
  assert.equal(stdout, "");
  assert.match(stderr, /does-not-exist/);
});

test("a mistyped subcommand is bad usage — never a hook-shaped allow at exit 0", async (t) => {
  // `revgate reviw` used to fall through to the agentStop hook, where "reviw"
  // became a git ref: the ref failed to resolve, the fail-open contract wrote
  // `{"decision":"allow"}` to stdout, and the process exited 0. Both skills read
  // exit 0 as "approved, nothing to act on", so one dropped letter turned a
  // review that never happened into a clean bill of health.
  const repo = await cleanRepo(t);
  await repo.write("a.txt", "one\ntwo\n");

  const { code, stdout, stderr } = await run(["reviw", "--exit-code-on-comments"], {
    cwd: repo.dir,
  });
  assert.equal(code, 2, "a typo must be reported, not absorbed by the hook contract");
  assert.equal(stdout, "", "nothing may reach stdout — least of all a decision");
  assert.match(stderr, /unknown command: reviw/);
  assert.match(stderr, /revgate review --help/);
});

test("review: a fatal git failure is reported honestly, never as an approval", async (t) => {
  // The trigger is a reviewer's own gitconfig rather than a bug of ours:
  // `diff.algorithm` is validated only when a diff actually runs, so `rev-parse`
  // still succeeds and the failure lands inside collectDiff. There is no hook
  // to wedge on this path, and a silent 0 would read as an approval.
  const repo = await cleanRepo(t);
  await repo.write("a.txt", "one\ntwo\n");
  const configFile = path.join(await tempDir(t, "badconfig"), "gitconfig");
  await writeFile(configFile, "[diff]\n\talgorithm = nonsense\n", "utf8");

  const cli = await run(["review", "--no-open", "--no-history"], {
    cwd: repo.dir,
    env: { GIT_CONFIG_GLOBAL: configFile },
  });
  assert.notEqual(cli.code, 0, "the CLI must not report a git failure as success");
  assert.doesNotMatch(cli.stdout, /APPROVED/);
  assert.doesNotMatch(cli.stdout, /"decision"/, "the CLI path never writes hook JSON");
});

test("copilot-plan: a fatal error emits the permission shape and exits 0", async (t) => {
  // main()'s last-resort handler. preToolUse fails CLOSED, so a handler that
  // exited non-zero — or wrote anything but a PermissionDecision — would deny
  // every tool call for the session.
  //
  // The trigger: `plan.md` as a *directory*. `existsSync` passes, so
  // findCopilotPlanContent goes on to `readFileSync` and throws EISDIR out of
  // runCopilotPlanHook, past every catch on the way to main()'s last resort.
  const home = await tempDir(t, "copilot-home");
  const sessionId = "3f2504e0-4f89-11d3-9a0c-0305e82c3301";
  await mkdir(path.join(home, "session-state", sessionId, "plan.md"), { recursive: true });

  const { code, stdout, stderr } = await run(["copilot-plan"], {
    env: { COPILOT_HOME: home },
    stdin: JSON.stringify({
      sessionId,
      toolCalls: [{ id: "1", name: "exit_plan_mode", args: "{}" }],
    }),
  });
  assert.equal(code, 0, "a non-zero exit from preToolUse denies the tool");
  assert.equal(stdout, '{"permissionDecision":"allow"}\n');
  assert.doesNotMatch(stdout, /"decision"/, "any other JSON shape is unparseable to preToolUse");
  assert.match(stderr, /fatal:/);
});

test("review: path filters that match nothing are reported, not quietly approved", async (t) => {
  // An -I prefix that matches nothing produces the same empty file list as a
  // clean tree. Reported as APPROVED at exit 0 that is a clean bill of health for
  // a diff nobody saw, so it takes the NOTHING IN SCOPE / exit-2 path instead —
  // in the report itself, because stderr does not reach an agent reading only the
  // `-o` file.
  const repo = await cleanRepo(t);
  await repo.write("a.txt", "one\ntwo\n");

  const { code, stdout, stderr } = await run(
    ["review", "--no-open", "--no-history", "-I", "no-such-dir"],
    { cwd: repo.dir },
  );
  assert.equal(code, 2, "filters that hide the whole diff are bad usage, not an approval");
  assert.match(stdout, /^# revgate review: NOTHING IN SCOPE$/m);
  assert.doesNotMatch(stdout, /APPROVED/);
  assert.match(stdout, /^filtered-out: 1$/m);
  assert.match(stdout, /relative to the repository root/);
  assert.match(stdout, /^scope: working tree vs HEAD \[\+no-such-dir\]$/m);
  assert.match(stderr, /removed by the path filters/);
  assert.match(stderr, /relative to the repository root/);
});

test("review: a filter matching nothing from a subdirectory still fails loudly", async (t) => {
  // The prefixes match repo-root-relative paths, so the cwd-relative spelling an
  // agent invoked from a subdirectory reaches for (`-I b.txt` for `pkg/b.txt`)
  // matches nothing. That must surface as an error the caller can act on rather
  // than as a review of an empty diff — this is the case the root-relative
  // documentation exists for.
  const repo = await cleanRepo(t);
  await repo.write("pkg/b.txt", "one\ntwo\n");
  const sub = path.join(repo.dir, "pkg");

  const missed = await run(["review", "--no-open", "--no-history", "-I", "b.txt"], { cwd: sub });
  assert.equal(missed.code, 2);
  assert.match(missed.stdout, /^# revgate review: NOTHING IN SCOPE$/m);

  // The documented root-relative spelling matches from that same cwd, so the diff
  // is found and the review opens instead (killed here rather than submitted).
  const child = launch(["review", "--no-open", "--no-history", "-I", "pkg"], { cwd: sub });
  const streams = collect(child);
  child.stdin.end();
  try {
    await waitForUrl(streams.stderr, streams.done);
    assert.match(streams.stderr(), /1 file\(s\) changed/);
    assert.doesNotMatch(streams.stdout(), /NOTHING IN SCOPE/);
  } finally {
    // Awaited, not left to an after-hook: this child's cwd is *inside* the temp
    // repo, and Windows locks a process's working directory — so the repo cleanup
    // hook fails with EBUSY unless the process is really gone first.
    child.kill();
    await streams.done;
  }
});

// --- nothing to review -----------------------------------------------------

test("review: a clean tree exits 0 with annotations explaining why", async (t) => {
  const repo = await cleanRepo(t);
  const { code, stdout } = await run(["review", "--no-open"], { cwd: repo.dir });
  assert.equal(code, 0);
  assert.match(stdout, /^# revgate review: APPROVED$/m);
  assert.match(stdout, /^files: 0$/m);
  assert.match(stdout, /^comments: 0$/m);
  assert.match(stdout, /No changes to review/);
});

test("review: --exit-code-on-comments still exits 0 when there is nothing to say", async (t) => {
  const repo = await cleanRepo(t);
  const { code } = await run(["review", "--no-open", "--exit-code-on-comments"], { cwd: repo.dir });
  assert.equal(code, 0);
});

test("review -o: annotations go to the file and stdout stays empty", async (t) => {
  const repo = await cleanRepo(t);
  const out = path.join(await tempDir(t, "out"), "review.md");

  const { code, stdout, stderr } = await run(["review", "--no-open", "-o", out], { cwd: repo.dir });
  assert.equal(code, 0);
  assert.equal(stdout, "");
  assert.match(stderr, /annotations written to/);
  assert.match(await readFile(out, "utf8"), /^# revgate review: APPROVED$/m);
});

test("review: outside a git repository it is bad usage, not an approval", async (t) => {
  // "Nothing to review" and "you are in the wrong directory" are the same
  // decision for a hook but not the same report: exit 0 with an APPROVED banner
  // would hand the agent a human sign-off on work nobody looked at.
  const dir = await tempDir(t, "norepo");
  const { code, stdout, stderr } = await run(["review", "--no-open"], { cwd: dir });
  assert.equal(code, 2);
  assert.match(stdout, /^# revgate review: NO REVIEW CAPTURED$/m);
  assert.doesNotMatch(stdout, /APPROVED/);
  assert.match(stdout, /Not a git repository/);
  assert.match(stderr, /not a git repository/i);
});

test("review: --help does not launder a bad command line into exit 0", async () => {
  // An agent recovering from a usage error by appending --help must not read
  // the result as success and loop.
  const { code, stdout, stderr } = await run(["review", "--bogus", "--help"]);
  assert.equal(code, 2);
  assert.match(stderr, /unknown flag: --bogus/);
  assert.match(stdout, /Exit codes:/, "the requested usage text is still printed");
});

// --- a full review round trip ----------------------------------------------

test("review: a submitted request-changes lands on stdout and exits 10", async (t) => {
  const repo = await cleanRepo(t);
  await repo.write("a.txt", "one\ntwo\n");

  const child = launch(["review", "--no-open", "--exit-code-on-comments", "--no-history"], {
    cwd: repo.dir,
  });
  const streams = collect(child);
  child.stdin.end();
  t.after(async () => {
    child.kill();
  });

  const url = await waitForUrl(streams.stderr, streams.done);
  const res = await fetch(`${url}api/submit`, {
    method: "POST",
    headers: pageHeaders(url),
    body: JSON.stringify({
      decision: "request_changes",
      summary: "One nit.",
      comments: [
        { file: "a.txt", startLine: 2, endLine: 2, side: "new", body: "Drop this line.\nIt is dead." },
      ],
    }),
  });
  assert.equal(res.status, 200);

  const { code, stdout } = await streams.done;
  assert.equal(code, 10, "comments captured must signal exit 10");
  assert.match(stdout, /^# revgate review: REQUEST CHANGES$/m);
  assert.match(stdout, /^comments: 1$/m);
  assert.match(stdout, /^## a\.txt:2 \(\+\)$/m);
  // The header carries the branch, as the README and the review skill both
  // show it — and as the archived copy of the same review records it.
  assert.match(stdout, /^scope: working tree vs HEAD$/m);
  assert.match(stdout, /^branch: main$/m);
  // Continuation lines are indented so they can never read as a new record.
  assert.match(stdout, /^Drop this line\.\n It is dead\.$/m);
  // stdout is the annotation contract only — never hook JSON.
  assert.doesNotMatch(stdout, /"decision"/);
});

test("review: an approval writes history under --history-dir and exits 0", async (t) => {
  const repo = await cleanRepo(t);
  await repo.write("a.txt", "one\ntwo\n");
  const historyDir = await tempDir(t, "hist-e2e");

  const child = launch(
    ["review", "--no-open", "--exit-code-on-comments", "--history-dir", historyDir],
    { cwd: repo.dir },
  );
  const streams = collect(child);
  child.stdin.end();
  t.after(async () => {
    child.kill();
  });

  const url = await waitForUrl(streams.stderr, streams.done);
  await fetch(`${url}api/submit`, {
    method: "POST",
    headers: pageHeaders(url),
    body: JSON.stringify({
      decision: "approve",
      summary: "Looks good.",
      comments: [{ file: "a.txt", startLine: 2, endLine: 2, side: "new", body: "Nice." }],
    }),
  });

  const { code, stdout } = await streams.done;
  assert.equal(code, 10, "a comment counts even on an approval");
  assert.match(stdout, /^# revgate review: APPROVED$/m);

  const { readdir } = await import("node:fs/promises");
  const repos = await readdir(historyDir);
  assert.equal(repos.length, 1);
  const saved = await readdir(path.join(historyDir, repos[0]));
  assert.equal(saved.length, 1);
  assert.match(await readFile(path.join(historyDir, repos[0], saved[0]), "utf8"), /Nice\./);
});

// --- staging is scoped to the working tree ---------------------------------

test("review: a ref scope does not offer staging; the working-tree scope does", async (t) => {
  // Staging acts on the working tree. In a ref review the diff comes from
  // commits, so `git add` would stage content that is not in the reviewed diff
  // and `git reset` would drop the user's real staged work.
  const repo = await cleanRepo(t);
  await repo.write("a.txt", "one\ntwo\n");
  await repo.git("add", "a.txt");
  await repo.git("commit", "-m", "second");
  await repo.write("a.txt", "one\ntwo\nthree\n");

  const read = async (args: string[]) => {
    const child = launch(["review", ...args, "--no-open", "--no-history"], { cwd: repo.dir });
    const streams = collect(child);
    child.stdin.end();
    const url = await waitForUrl(streams.stderr, streams.done);
    const ctx = (await (await fetch(`${url}api/review`)).json()) as {
      canStage?: boolean;
      files: { staged?: string }[];
    };
    const stage = await fetch(`${url}api/stage`, {
      method: "POST",
      headers: pageHeaders(url),
      body: JSON.stringify({ file: "a.txt" }),
    });
    child.kill();
    await streams.done;
    return { ctx, stageStatus: stage.status };
  };

  const ref = await read(["HEAD~1"]);
  assert.equal(ref.ctx.canStage, false, "a ref scope must not advertise staging");
  assert.equal(ref.ctx.files[0].staged, undefined, "no staging state is computed for a ref scope");
  assert.equal(ref.stageStatus, 409, "the route must refuse even though the UI hides the toggle");

  const worktree = await read([]);
  assert.equal(worktree.ctx.canStage, true);
  assert.equal(worktree.stageStatus, 200);

  // The third value the predicate accepts, and the one nothing covered: a
  // `--staged` review reads the index, which is exactly what the toggle acts on.
  // The worktree read above already staged a.txt, so this scope is non-empty.
  const staged = await read(["--staged"]);
  assert.equal(staged.ctx.canStage, true, "the staged scope must offer staging");
  assert.equal(staged.stageStatus, 200);
});

// --- plan mode -------------------------------------------------------------

test("review --plan <file>: reviews the document instead of the diff", async (t) => {
  const repo = await cleanRepo(t);
  await repo.write("PLAN.md", "# Plan: ship it\n\nStep one.\n");

  const child = launch(["review", "--plan", "PLAN.md", "--no-open", "--no-history"], {
    cwd: repo.dir,
  });
  const streams = collect(child);
  child.stdin.end();
  t.after(async () => {
    child.kill();
  });

  const url = await waitForUrl(streams.stderr, streams.done);
  const ctx = (await (await fetch(`${url}api/review`)).json()) as {
    mode: string;
    planTitle?: string;
  };
  assert.equal(ctx.mode, "plan");
  assert.equal(ctx.planTitle, "Plan: ship it");

  await fetch(`${url}api/submit`, {
    method: "POST",
    headers: pageHeaders(url),
    body: JSON.stringify({
      decision: "approve",
      summary: "",
      // "Plan" is the synthetic file planToFiles names, and the only path the UI
      // can anchor a plan comment to — so it must survive the submit-side check
      // that comments name a file in this review.
      comments: [{ file: "Plan", startLine: 3, endLine: 3, side: "new", body: "Say how." }],
    }),
  });
  const { code, stdout } = await streams.done;
  assert.equal(code, 0);
  assert.match(stdout, /^mode: plan$/m);
  assert.match(stdout, /^## Plan:3 \(\+\)$/m);
  assert.match(stdout, /^Say how\.$/m);
});

test("review --plan <missing>: is bad usage, never a silent diff review", async (t) => {
  // The skill reads exit 0 as "the plan is approved, start implementing". A
  // typo'd path that quietly reviewed the working tree instead would hand back
  // an approval for a plan nobody ever saw.
  const repo = await cleanRepo(t);
  const { code, stdout, stderr } = await run(["review", "--plan", "nope.md", "--no-open"], {
    cwd: repo.dir,
  });
  assert.equal(code, 2);
  assert.match(stderr, /could not read plan file nope\.md/);
  assert.doesNotMatch(stdout, /^# revgate review: APPROVED$/m);
  assert.doesNotMatch(stdout, /^mode: plan$/m);
});

test("review --plan with no file and no env var: bad usage, not a diff review", async (t) => {
  const repo = await cleanRepo(t);
  const { code, stdout, stderr } = await run(["review", "--plan", "--no-open"], {
    cwd: repo.dir,
    env: { REVGATE_PLAN_FILE: "" },
  });
  assert.equal(code, 2);
  assert.match(stderr, /no plan text was found/);
  assert.doesNotMatch(stdout, /^# revgate review: APPROVED$/m);
});

test("review --plan <empty file>: is bad usage, not an approval of a blank plan", async (t) => {
  // An existing-but-empty file is not a plan — the agent may have created it
  // before writing to it. Reviewing it would show a blank document the reviewer
  // can only approve, and exit 0 tells the skill to start implementing.
  const repo = await cleanRepo(t);
  await repo.write("PLAN.md", "   \n\n");
  const { code, stdout, stderr } = await run(["review", "--plan", "PLAN.md", "--no-open"], {
    cwd: repo.dir,
  });
  assert.equal(code, 2);
  assert.match(stderr, /plan file PLAN\.md is empty/);
  assert.match(stderr, /no plan text was found/);
  assert.doesNotMatch(stdout, /^# revgate review: APPROVED$/m);
  assert.doesNotMatch(stdout, /^mode: plan$/m);
});

test("legacy agentStop invocations exit 2 with a migration hint, not hook JSON", async (t) => {
  // These command lines were the agentStop diff gate before it was removed. A
  // stale hooks.json still running them must get a loud usage error — never a
  // review UI, and never a `{"decision":"allow"}` that Copilot would read as a
  // completed gate.
  const repo = await cleanRepo(t);
  await repo.write("PLAN.md", "# Plan: ship it\n");
  const payload = JSON.stringify({ sessionId: "abc", cwd: repo.dir, stopReason: "end_turn" });
  for (const argv of [[], ["--no-open"], ["--plan", "PLAN.md", "--no-open"], ["--demo"]]) {
    const { code, stdout, stderr } = await run(argv, { cwd: repo.dir, stdin: payload });
    assert.equal(code, 2, `revgate ${argv.join(" ")} must be bad usage`);
    assert.equal(stdout, "", "nothing may reach stdout — least of all a decision");
    assert.match(stderr, /missing the `review` subcommand/);
    assert.match(stderr, /re-run install\.ps1/);
  }
});

test("review --plan: $REVGATE_PLAN_FILE supplies the plan when no path is given", async (t) => {
  // This is how the /revgate-plan skill's second documented form works.
  const repo = await cleanRepo(t);
  await repo.write("PLAN.md", "# Plan: from the env\n\nStep one.\n");

  const child = launch(["review", "--plan", "--no-open", "--no-history"], {
    cwd: repo.dir,
    env: { REVGATE_PLAN_FILE: path.join(repo.dir, "PLAN.md") },
  });
  const streams = collect(child);
  child.stdin.end();
  t.after(() => {
    child.kill();
  });

  const url = await waitForUrl(streams.stderr, streams.done);
  const ctx = (await (await fetch(`${url}api/review`)).json()) as {
    mode: string;
    planTitle?: string;
  };
  assert.equal(ctx.mode, "plan");
  assert.equal(ctx.planTitle, "Plan: from the env");

  await fetch(`${url}api/submit`, {
    method: "POST",
    headers: pageHeaders(url),
    body: JSON.stringify({ decision: "approve", summary: "", comments: [] }),
  });
  const { code, stdout } = await streams.done;
  assert.equal(code, 0);
  assert.match(stdout, /^mode: plan$/m);
});

// --- hook payload robustness (the plan gate owns readHookPayload now) --------

test("copilot-plan: an unparseable payload warns and still allows", async () => {
  const { code, stdout, stderr } = await run(["copilot-plan"], { stdin: "not json at all" });
  assert.equal(code, 0);
  assert.equal(stdout, '{"permissionDecision":"allow"}\n');
  assert.match(stderr, /could not parse hook payload/);
});

test("copilot-plan: stdin that is never closed still completes, via the read timeout", async (t) => {
  // Every other test ends the pipe. A parent that does not would otherwise keep
  // the `data` listener attached and the process alive until Copilot's own
  // timeout — the hang the 2s guard in readHookPayload exists to prevent.
  const child = launch(["copilot-plan", "--no-open"]);
  const streams = collect(child);
  t.after(() => {
    child.kill();
  });
  // Written but deliberately NOT ended.
  child.stdin.write("");

  const { code, stdout } = await streams.done;
  assert.equal(code, 0);
  assert.equal(stdout, '{"permissionDecision":"allow"}\n');
});

// --- --demo ----------------------------------------------------------------

test("review --demo --plan: opens the bundled sample plan", async (t) => {
  // `npm run demo:plan`, and the first thing the installer tells a new user to
  // try. Nothing else exercises SAMPLE_PLAN.
  const repo = await cleanRepo(t);
  const child = launch(["review", "--demo", "--plan", "--no-open", "--no-history"], {
    cwd: repo.dir,
  });
  const streams = collect(child);
  t.after(() => {
    child.kill();
  });
  child.stdin.end();

  const url = await waitForUrl(streams.stderr, streams.done);
  const ctx = (await (await fetch(`${url}api/review`)).json()) as { mode: string; planTitle?: string };
  assert.equal(ctx.mode, "plan");
  assert.equal(ctx.planTitle, "Plan: add rate limiting to the public API");

  await fetch(`${url}api/submit`, {
    method: "POST",
    headers: pageHeaders(url),
    body: JSON.stringify({ decision: "approve", summary: "", comments: [] }),
  });
  const { code, stdout } = await streams.done;
  assert.equal(code, 0);
  assert.match(stdout, /^mode: plan$/m);
});

test("review --demo: outside a repo, a submitted verdict is reported, not discarded", async (t) => {
  // --demo opens the UI even with nothing to review, so a human can reach the
  // submit button on a run that carries `isRepo: false`. Reporting NO REVIEW
  // CAPTURED there would throw away the verdict they just typed — the same
  // "the report disagrees with the reviewer" failure as forging an approval,
  // only inverted.
  const dir = await tempDir(t, "demo-norepo");
  const child = launch(["review", "--demo", "--no-open", "--no-history"], { cwd: dir });
  const streams = collect(child);
  t.after(() => {
    child.kill();
  });
  child.stdin.end();

  const url = await waitForUrl(streams.stderr, streams.done);
  await fetch(`${url}api/submit`, {
    method: "POST",
    headers: pageHeaders(url),
    body: JSON.stringify({ decision: "request_changes", summary: "Please fix.", comments: [] }),
  });

  const { code, stdout } = await streams.done;
  assert.equal(code, 0, "a captured verdict is not a usage error");
  assert.match(stdout, /^# revgate review: REQUEST CHANGES$/m);
  assert.match(stdout, /Please fix\./);
  assert.doesNotMatch(stdout, /NO REVIEW CAPTURED/);
});

// --- the preToolUse plan gate contract -------------------------------------

test("copilot-plan: a tool that is not exit_plan_mode passes straight through", async () => {
  const { code, stdout } = await run(["copilot-plan"], {
    stdin: JSON.stringify({
      sessionId: "abc",
      toolCalls: [{ id: "1", name: "shell", args: '{"command":"ls"}' }],
    }),
  });
  assert.equal(code, 0);
  assert.equal(stdout, '{"permissionDecision":"allow"}\n');
});

test("copilot-plan: an unidentifiable tool warns and allows", async () => {
  const { code, stdout, stderr } = await run(["copilot-plan"], { stdin: JSON.stringify({}) });
  assert.equal(code, 0);
  assert.equal(stdout, '{"permissionDecision":"allow"}\n');
  assert.match(stderr, /no identifiable tool/);
});

test("copilot-plan: exit_plan_mode with no plan text allows rather than gating", async (t) => {
  const home = await tempDir(t, "copilot-home");
  const { code, stdout, stderr } = await run(["copilot-plan"], {
    env: { COPILOT_HOME: home },
    stdin: JSON.stringify({
      sessionId: "abc",
      toolCalls: [{ id: "1", name: "exit_plan_mode", args: "{}" }],
    }),
  });
  assert.equal(code, 0);
  assert.equal(stdout, '{"permissionDecision":"allow"}\n');
  assert.match(stderr, /no plan text found/);
});

test("copilot-plan: a requested change becomes a deny carrying the feedback", async (t) => {
  const home = await tempDir(t, "copilot-home");
  // --no-open: without it this test shells out to the real browser opener, so
  // `npm test` pops a tab and what the test exercises depends on the machine.
  const child = launch(["copilot-plan", "--no-open"], {
    env: { COPILOT_HOME: home, REVGATE_HISTORY_DIR: path.join(home, "history") },
  });
  const streams = collect(child);
  t.after(async () => {
    child.kill();
  });
  child.stdin.end(
    JSON.stringify({
      sessionId: "abc",
      toolCalls: [
        {
          id: "1",
          name: "exit_plan_mode",
          args: JSON.stringify({ plan: "# Plan: ship it\n\nStep one.\n" }),
        },
      ],
    }),
  );

  const url = await waitForUrl(streams.stderr, streams.done);
  await fetch(`${url}api/submit`, {
    method: "POST",
    headers: pageHeaders(url),
    body: JSON.stringify({
      decision: "request_changes",
      summary: "Add a rollback step.",
      comments: [],
    }),
  });

  const { code, stdout } = await streams.done;
  assert.equal(code, 0, "the plan gate must never exit non-zero — that fails closed");
  const decision = JSON.parse(stdout) as { permissionDecision: string; permissionDecisionReason: string };
  assert.equal(decision.permissionDecision, "deny");
  assert.match(decision.permissionDecisionReason, /Add a rollback step\./);
});

test("copilot-plan: an approved plan allows the tool to proceed", async (t) => {
  const home = await tempDir(t, "copilot-home");
  // --no-open for the same reason as the request-changes test above.
  const child = launch(["copilot-plan", "--no-open"], {
    env: { COPILOT_HOME: home, REVGATE_HISTORY_DIR: path.join(home, "history") },
  });
  const streams = collect(child);
  t.after(async () => {
    child.kill();
  });
  child.stdin.end(
    JSON.stringify({
      sessionId: "abc",
      toolCalls: [
        { id: "1", name: "exit_plan_mode", args: JSON.stringify({ summary: "# Plan\n\nDo it.\n" }) },
      ],
    }),
  );

  const url = await waitForUrl(streams.stderr, streams.done);
  await fetch(`${url}api/submit`, {
    method: "POST",
    headers: pageHeaders(url),
    body: JSON.stringify({ decision: "approve", summary: "", comments: [] }),
  });

  const { code, stdout } = await streams.done;
  assert.equal(code, 0);
  assert.equal(stdout, '{"permissionDecision":"allow"}\n');
});

// --- hook payload shapes ---------------------------------------------------

test("copilot-plan: a non-plan tool's `summary` argument is never mistaken for a plan", async () => {
  // toolCalls[0] is not exit_plan_mode, and `summary` is a common argument name
  // on unrelated tools. Harvesting it would open a plan review over someone
  // else's arguments.
  const { code, stdout } = await run(["copilot-plan"], {
    stdin: JSON.stringify({
      sessionId: "abc",
      toolCalls: [{ id: "1", name: "write_file", args: JSON.stringify({ summary: "# Not a plan\n" }) }],
    }),
  });
  assert.equal(code, 0);
  assert.equal(stdout, '{"permissionDecision":"allow"}\n');
});

test("copilot-plan: VS Code's snake_case payload is understood too", async () => {
  // tool_name + tool_input, no toolCalls array — the other shape readHookPayload
  // claims to accept. If it silently stopped working the gate would just never
  // fire, and every plan would sail through unreviewed.
  const { code, stdout, stderr } = await run(["copilot-plan"], {
    env: { COPILOT_HOME: path.join(os.tmpdir(), "revgate-no-such-home") },
    stdin: JSON.stringify({
      session_id: "abc",
      tool_name: "exit_plan_mode",
      tool_input: { plan: "" },
    }),
  });
  assert.equal(code, 0);
  assert.equal(stdout, '{"permissionDecision":"allow"}\n');
  // Identified as the plan tool (not "no identifiable tool"), then allowed only
  // because the plan text itself was empty.
  assert.match(stderr, /no plan text found/);
  assert.doesNotMatch(stderr, /no identifiable tool/);
});

test("copilot-plan: tool args given as an object, not a JSON string", async (t) => {
  const home = await tempDir(t, "copilot-home");
  const child = launch(["copilot-plan", "--no-open", "--no-history"], {
    env: { COPILOT_HOME: home },
  });
  const streams = collect(child);
  t.after(() => {
    child.kill();
  });
  child.stdin.end(
    JSON.stringify({
      sessionId: "abc",
      toolCalls: [{ id: "1", name: "exit_plan_mode", args: { plan: "# Plan: object args\n" } }],
    }),
  );

  const url = await waitForUrl(streams.stderr, streams.done);
  const ctx = (await (await fetch(`${url}api/review`)).json()) as { mode: string; planTitle?: string };
  assert.equal(ctx.mode, "plan");
  assert.equal(ctx.planTitle, "Plan: object args");

  await fetch(`${url}api/submit`, {
    method: "POST",
    headers: pageHeaders(url),
    body: JSON.stringify({ decision: "approve", summary: "", comments: [] }),
  });
  const { code, stdout } = await streams.done;
  assert.equal(code, 0);
  assert.equal(stdout, '{"permissionDecision":"allow"}\n');
});

test("copilot-plan: --no-history is honoured after the subcommand", async (t) => {
  // The hook is one command line in hooks.json; a flag there is the only way to
  // opt out of history on the plan gate.
  const home = await tempDir(t, "copilot-home");
  const historyDir = path.join(home, "history");
  const child = launch(["copilot-plan", "--no-open", "--no-history"], {
    env: { COPILOT_HOME: home, REVGATE_HISTORY_DIR: historyDir },
  });
  const streams = collect(child);
  t.after(() => {
    child.kill();
  });
  child.stdin.end(
    JSON.stringify({
      sessionId: "abc",
      toolCalls: [
        { id: "1", name: "exit_plan_mode", args: JSON.stringify({ plan: "# Plan: ship it\n" }) },
      ],
    }),
  );

  const url = await waitForUrl(streams.stderr, streams.done);
  await fetch(`${url}api/submit`, {
    method: "POST",
    headers: pageHeaders(url),
    body: JSON.stringify({ decision: "request_changes", summary: "No.", comments: [] }),
  });
  await streams.done;
  await assert.rejects(readdir(historyDir), "--no-history was ignored on the plan gate");
});

/** Write a session's plan.md under a sandboxed $COPILOT_HOME. */
async function writeSessionPlan(home: string, sessionId: string, body: string): Promise<void> {
  const dir = path.join(home, "session-state", sessionId);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "plan.md"), body, "utf8");
}

test("copilot-plan: the session's plan.md beats the condensed inline plan", async (t) => {
  // Every other plan-gate test uses a non-UUID sessionId, which the id filter
  // rejects — so only the inline fallback is ever exercised. In production
  // Copilot passes a UUID and writes the FULL plan to disk; if that lookup broke
  // the reviewer would silently approve the condensed summary instead.
  const home = await tempDir(t, "copilot-home");
  const sessionId = "3f2504e0-4f89-11d3-9a0c-0305e82c3301";
  await writeSessionPlan(home, sessionId, "# Plan: the full one from disk\n\nStep one.\n");

  const child = launch(["copilot-plan", "--no-open", "--no-history"], { env: { COPILOT_HOME: home } });
  const streams = collect(child);
  t.after(() => {
    child.kill();
  });
  child.stdin.end(
    JSON.stringify({
      sessionId,
      toolCalls: [
        {
          id: "1",
          name: "exit_plan_mode",
          args: JSON.stringify({ plan: "# Plan: the condensed inline one\n" }),
        },
      ],
    }),
  );

  const url = await waitForUrl(streams.stderr, streams.done);
  const ctx = (await (await fetch(`${url}api/review`)).json()) as { planTitle?: string };
  assert.equal(ctx.planTitle, "Plan: the full one from disk");

  await fetch(`${url}api/submit`, {
    method: "POST",
    headers: pageHeaders(url),
    body: JSON.stringify({ decision: "approve", summary: "", comments: [] }),
  });
  const { code, stdout } = await streams.done;
  assert.equal(code, 0);
  assert.equal(stdout, '{"permissionDecision":"allow"}\n');
});

test("copilot-plan: with no session id, the inline plan beats another session's plan.md", async (t) => {
  // A payload that names no session gets `sessionId: ""`, which drops the disk
  // lookup into its "newest plan.md anywhere" fallback — including sessions for
  // other repositories. The plan this very tool call carries is the only one we
  // know belongs to the turn being gated, so it has to win.
  const home = await tempDir(t, "copilot-home");
  await writeSessionPlan(home, "3f2504e0-4f89-11d3-9a0c-0305e82c3301", "# Plan: someone else's\n");

  const child = launch(["copilot-plan", "--no-open", "--no-history"], { env: { COPILOT_HOME: home } });
  const streams = collect(child);
  t.after(() => {
    child.kill();
  });
  child.stdin.end(
    JSON.stringify({
      toolCalls: [
        { id: "1", name: "exit_plan_mode", args: JSON.stringify({ plan: "# Plan: this turn's\n" }) },
      ],
    }),
  );

  const url = await waitForUrl(streams.stderr, streams.done);
  const ctx = (await (await fetch(`${url}api/review`)).json()) as { planTitle?: string };
  assert.equal(ctx.planTitle, "Plan: this turn's");

  await fetch(`${url}api/submit`, {
    method: "POST",
    headers: pageHeaders(url),
    body: JSON.stringify({ decision: "approve", summary: "", comments: [] }),
  });
  await streams.done;
});

test("copilot-plan: a gated plan is archived under the plan's own title", async (t) => {
  const home = await tempDir(t, "copilot-home");
  const historyDir = path.join(home, "history");
  const child = launch(["copilot-plan", "--no-open"], {
    env: { COPILOT_HOME: home, REVGATE_HISTORY_DIR: historyDir },
  });
  const streams = collect(child);
  t.after(() => {
    child.kill();
  });
  child.stdin.end(
    JSON.stringify({
      sessionId: "abc",
      toolCalls: [
        {
          id: "1",
          name: "exit_plan_mode",
          args: JSON.stringify({ plan: "# Plan: add rate limiting\n\nStep one.\n" }),
        },
      ],
    }),
  );

  const url = await waitForUrl(streams.stderr, streams.done);
  await fetch(`${url}api/submit`, {
    method: "POST",
    headers: pageHeaders(url),
    body: JSON.stringify({ decision: "request_changes", summary: "Add a rollback.", comments: [] }),
  });
  await streams.done;

  // History exists so a review survives a hook timeout — the plan gate is where
  // that matters most, and its scope label is built nowhere else.
  const repos = await readdir(historyDir);
  assert.equal(repos.length, 1);
  const saved = await readdir(path.join(historyDir, repos[0]));
  assert.equal(saved.length, 1);
  const content = await readFile(path.join(historyDir, repos[0], saved[0]), "utf8");
  assert.match(content, /^mode: plan$/m);
  assert.match(content, /^scope: "plan: Plan: add rate limiting"$/m);
});

// --- --output failures -----------------------------------------------------

test("review -o: an unwritable destination falls back to stdout, not to exit 1", async (t) => {
  // The human has already reviewed by the time we write. Letting the write throw
  // would surface as exit 1, which both skills read as "no verdict was captured
  // — do not treat it as an approval": a completed review reported as one that
  // never happened, with the annotations nowhere at all.
  const repo = await cleanRepo(t);
  const { code, stdout, stderr } = await run(
    ["review", "--no-open", "-o", path.join(repo.dir, "nope", "out.md")],
    { cwd: repo.dir },
  );
  assert.equal(code, 0, "a delivered report keeps the verdict's own exit code");
  assert.match(stdout, /^# revgate review: APPROVED$/m);
  assert.match(stderr, /could not write/);
  assert.match(stderr, /writing the annotations to stdout instead/);
});

test("copilot-plan: a top-level `plan` field is accepted as the inline plan", async (t) => {
  // `HookPayload.plan` is a documented input shape (types.ts) that nothing else
  // exercises: a top-level `plan` beside the tool name must open a plan review.
  const home = await tempDir(t, "copilot-home");
  const child = launch(["copilot-plan", "--no-open", "--no-history"], {
    env: { COPILOT_HOME: home },
  });
  const streams = collect(child);
  t.after(() => {
    child.kill();
  });
  child.stdin.end(
    JSON.stringify({
      sessionId: "abc",
      toolName: "exit_plan_mode",
      plan: "# Plan: from the payload\n\nStep one.\n",
    }),
  );

  const url = await waitForUrl(streams.stderr, streams.done);
  const ctx = (await (await fetch(`${url}api/review`)).json()) as {
    mode: string;
    planTitle?: string;
  };
  assert.equal(ctx.mode, "plan");
  assert.equal(ctx.planTitle, "Plan: from the payload");

  await fetch(`${url}api/submit`, {
    method: "POST",
    headers: pageHeaders(url),
    body: JSON.stringify({ decision: "approve", summary: "", comments: [] }),
  });
  const { code, stdout } = await streams.done;
  assert.equal(code, 0);
  assert.equal(stdout, '{"permissionDecision":"allow"}\n');
});

test("review: $REVGATE_PLAN_FILE alone does not turn a diff review into a plan review", async (t) => {
  // resolvePlan only consults the env var once --plan asked for plan mode. If
  // that guard inverted, every review would become a plan review for anyone who
  // exports the variable — and the actual changes would go unreviewed. A clean
  // tree makes the diff review resolve immediately, so a plan review opening
  // instead is the difference between exit 0 and a hang.
  const repo = await cleanRepo(t);
  const planFile = path.join(await tempDir(t, "planfile"), "PLAN.md");
  await writeFile(planFile, "# Plan: not this one\n", "utf8");

  const { code, stdout, stderr } = await run(["review", "--no-open"], {
    cwd: repo.dir,
    env: { REVGATE_PLAN_FILE: planFile },
  });
  assert.equal(code, 0);
  assert.match(stdout, /No changes to review/, "the diff review is what should have run");
  assert.doesNotMatch(stdout, /^mode: plan$/m);
  assert.doesNotMatch(stderr, /proposed plan/, "the env var must not have opened a plan review");
});

// --- hook payload robustness ------------------------------------------------

test("copilot-plan: a payload with a leading UTF-8 BOM is still parsed", async () => {
  // Some shells and pipes prepend one. JSON.parse rejects it, so without the
  // strip in readHookPayload the whole payload is lost \u2014 and with it the tool
  // name, which turns a real payload into a warned pass-through.
  const { code, stdout, stderr } = await run(["copilot-plan"], {
    stdin:
      "\uFEFF" +
      JSON.stringify({
        sessionId: "bom",
        toolCalls: [{ id: "1", name: "shell", args: '{"command":"ls"}' }],
      }),
  });
  assert.equal(code, 0);
  assert.equal(stdout, '{"permissionDecision":"allow"}\n');
  assert.doesNotMatch(stderr, /could not parse hook payload/);
  assert.doesNotMatch(stderr, /no identifiable tool/, "the payload's own fields must have survived");
});

test("copilot-plan: an unparseable args string allows instead of crashing", async () => {
  // toolCalls[].args is a JSON *string* in Copilot's payload. A malformed one
  // must degrade to "no plan text" — this hook fails closed on a non-zero exit,
  // so a throw here would deny the tool.
  const { code, stdout, stderr } = await run(["copilot-plan"], {
    env: { COPILOT_HOME: path.join(os.tmpdir(), "revgate-no-such-home") },
    stdin: JSON.stringify({
      sessionId: "abc",
      toolCalls: [{ id: "1", name: "exit_plan_mode", args: "{not json" }],
    }),
  });
  assert.equal(code, 0);
  assert.equal(stdout, '{"permissionDecision":"allow"}\n');
  assert.match(stderr, /no plan text found/);
});
