import assert from "node:assert/strict";
import test from "node:test";
import { helpText, parseArgs, type CliOptions, type ParsedArgs } from "../src/cli.js";

/** parseArgs for a `review` invocation, asserting it parsed cleanly. */
function review(...argv: string[]): CliOptions {
  const parsed = parseArgs(["review", ...argv]);
  assert.equal(parsed.command, "review");
  assert.equal(
    parsed.command === "review" ? parsed.error : undefined,
    undefined,
    `unexpected error for ${JSON.stringify(argv)}`,
  );
  return (parsed as Extract<ParsedArgs, { command: "review" }>).options;
}

/** The error message from a `review` invocation that should have failed. */
function reviewError(...argv: string[]): string | undefined {
  const parsed = parseArgs(["review", ...argv]);
  assert.equal(parsed.command, "review");
  return (parsed as Extract<ParsedArgs, { command: "review" }>).error;
}

test("parseArgs: no args is bad usage, not a hook", () => {
  // Bare `revgate` used to be the agentStop diff gate. That hook is gone, and a
  // stale hooks.json still invoking it must get a loud exit-2 explanation, not
  // a review UI or a silent success.
  const parsed = parseArgs([]);
  assert.equal(parsed.command, "review");
  assert.match(
    (parsed as Extract<ParsedArgs, { command: "review" }>).error ?? "",
    /missing the `review` subcommand/,
  );
});

test("parseArgs: legacy agentStop hook shapes are bad usage now", () => {
  // Every flag-only invocation was once a legitimate agentStop hook command
  // line. None of them may open a review or pass silently any more.
  for (const argv of [
    ["--plan"],
    ["--plan", "PLAN.md"],
    ["--no-open", "--no-history"],
    ["--history-dir", "/tmp/hist"],
  ]) {
    const parsed = parseArgs(argv);
    assert.equal(parsed.command, "review", `${argv.join(" ")} must not run as a hook`);
    assert.match(
      (parsed as Extract<ParsedArgs, { command: "review" }>).error ?? "",
      /missing the `review` subcommand/,
      argv.join(" "),
    );
  }
});

test("parseArgs: bare --help is a usage request, not an error", () => {
  const parsed = parseArgs(["--help"]);
  assert.equal(parsed.command, "review");
  assert.equal((parsed as Extract<ParsedArgs, { command: "review" }>).error, undefined);
  assert.equal(parsed.options.help, true);
  const short = parseArgs(["-h"]);
  assert.equal((short as Extract<ParsedArgs, { command: "review" }>).error, undefined);
  assert.equal(short.options.help, true);
});

test("parseArgs: `review` selects the CLI command", () => {
  const parsed = parseArgs(["review"]);
  assert.equal(parsed.command, "review");
});

test("parseArgs: a mistyped subcommand is bad usage with the word named", () => {
  // A bare word is a mistyped CLI call and must be reported as one — never
  // treated as a git ref of a review nobody asked for. The word is looked for
  // among the *positionals*, not at argv[0], so a flag written before the typo
  // (`revgate --no-open reviw`) is caught the same way.
  const mistyped: Array<[string[], string]> = [
    [["reviw"], "reviw"],
    [["reveiw", "--exit-code-on-comments"], "reveiw"],
    [["HEAD~3"], "HEAD~3"],
    [["--no-open", "reviw"], "reviw"],
    [["--include", "src", "reveiw", "--exit-code-on-comments"], "reveiw"],
  ];
  for (const [argv, word] of mistyped) {
    const parsed = parseArgs(argv);
    assert.equal(parsed.command, "review", `${argv.join(" ")} must not run as a hook`);
    assert.match(
      (parsed as Extract<ParsedArgs, { command: "review" }>).error ?? "",
      new RegExp(`unknown command: ${word}`),
    );
  }
});

test("parseArgs: a review flag without the subcommand is bad usage too", () => {
  // A dropped `review` must not silently change what the flags mean. Every one
  // of these exits 2; the same command line with `review` in front parses.
  const dropped: string[][] = [
    ["--exit-code-on-comments"],
    ["--staged"],
    ["-o", "out.md"],
    ["--output=out.md"],
    ["-I", "src"],
    ["--include", "src"],
    ["-X", "dist"],
    ["--exclude", "dist"],
    ["--no-open", "-o", "out.md", "--exit-code-on-comments"],
  ];
  for (const argv of dropped) {
    const parsed = parseArgs(argv);
    assert.equal(parsed.command, "review", `${argv.join(" ")} must not run as a hook`);
    assert.match(
      (parsed as Extract<ParsedArgs, { command: "review" }>).error ?? "",
      /missing the `review` subcommand/,
      argv.join(" "),
    );
  }

  assert.equal(review("-o", "out.md", "--exit-code-on-comments").output, "out.md");
});

test("parseArgs: copilot-plan parses before any flag validation", () => {
  // The plan gate is a hook: a usage error there would fail *closed*, so argv
  // must never be rejected — not even a flag we have never heard of.
  for (const argv of [
    ["copilot-plan"],
    ["copilot-plan", "--totally-bogus"],
    ["copilot-plan", "a", "b", "c", "--include"],
  ]) {
    const parsed = parseArgs(argv);
    assert.equal(parsed.command, "copilot-plan");
    // No `error` field exists on this variant at all — there is nothing a
    // caller could accidentally turn into a non-zero exit.
    assert.equal((parsed as Record<string, unknown>).error, undefined);
  }
});

test("parseArgs: copilot-plan still honours the flags it understands", () => {
  // The hook is configured as one command line in hooks.json, so the only way a
  // user can opt out of history on the plan gate is a flag after the subcommand.
  const parsed = parseArgs(["copilot-plan", "--no-history", "--no-open"]);
  assert.equal(parsed.command, "copilot-plan");
  assert.equal(parsed.command === "copilot-plan" && parsed.options.history, false);
  assert.equal(parsed.command === "copilot-plan" && parsed.options.open, false);

  const dir = parseArgs(["copilot-plan", "--history-dir", "/tmp/hist"]);
  assert.equal(dir.command === "copilot-plan" && dir.options.historyDir, "/tmp/hist");
});

test("parseArgs: an unknown flag without a subcommand keeps its own error", () => {
  // The parse error is more specific than the missing-subcommand fallback, and
  // the first problem is the one that explains the rest.
  const parsed = parseArgs(["--totally-bogus"]);
  assert.equal(parsed.command, "review");
  assert.match(
    (parsed as Extract<ParsedArgs, { command: "review" }>).error ?? "",
    /unknown flag: --totally-bogus/,
  );
});

// --- ref forms -------------------------------------------------------------

test("parseArgs: no refs means the working tree", () => {
  assert.deepEqual(review().scope, { kind: "worktree", refs: [], include: [], exclude: [] });
});

test("parseArgs: a single ref", () => {
  const scope = review("HEAD~3").scope;
  assert.equal(scope.kind, "ref");
  assert.deepEqual(scope.refs, ["HEAD~3"]);
  assert.equal(scope.dots, undefined);
});

test("parseArgs: two refs are a two-dot range", () => {
  const scope = review("main", "feature").scope;
  assert.equal(scope.kind, "range");
  assert.deepEqual(scope.refs, ["main", "feature"]);
  assert.equal(scope.dots, "..");
});

test("parseArgs: dotted two-dot range", () => {
  const scope = review("main..feature").scope;
  assert.equal(scope.kind, "range");
  assert.deepEqual(scope.refs, ["main", "feature"]);
  assert.equal(scope.dots, "..");
});

test("parseArgs: dotted three-dot range", () => {
  const scope = review("main...feature").scope;
  assert.equal(scope.kind, "range");
  assert.deepEqual(scope.refs, ["main", "feature"]);
  assert.equal(scope.dots, "...");
});

test("parseArgs: an omitted range side defaults to HEAD", () => {
  assert.deepEqual(review("main..").scope.refs, ["main", "HEAD"]);
  assert.deepEqual(review("..feature").scope.refs, ["HEAD", "feature"]);
  assert.deepEqual(review("main...").scope.refs, ["main", "HEAD"]);
  assert.deepEqual(review("...feature").scope.refs, ["HEAD", "feature"]);
});

test("parseArgs: a ref with a tilde or caret is not mistaken for a range", () => {
  assert.equal(review("HEAD^").scope.kind, "ref");
  assert.equal(review("origin/main~10").scope.kind, "ref");
});

test("parseArgs: a third positional is an error", () => {
  assert.match(String(reviewError("a", "b", "c")), /unexpected argument: c/);
});

// --- flags -----------------------------------------------------------------

test("parseArgs: --staged", () => {
  const scope = review("--staged").scope;
  assert.equal(scope.kind, "staged");
  assert.deepEqual(scope.refs, []);
});

test("parseArgs: --staged with refs is an error", () => {
  assert.match(String(reviewError("--staged", "main..feature")), /--staged cannot be combined/);
  assert.match(String(reviewError("HEAD~1", "--staged")), /--staged cannot be combined/);
});

test("parseArgs: --include repeats and accepts both spellings", () => {
  assert.deepEqual(review("--include", "src").scope.include, ["src"]);
  assert.deepEqual(review("--include=src").scope.include, ["src"]);
  assert.deepEqual(review("-I", "src").scope.include, ["src"]);
  assert.deepEqual(
    review("--include", "src", "-I", "test", "--include=docs").scope.include,
    ["src", "test", "docs"],
  );
});

test("parseArgs: --exclude repeats and accepts both spellings", () => {
  assert.deepEqual(review("--exclude", "dist").scope.exclude, ["dist"]);
  assert.deepEqual(review("--exclude=dist").scope.exclude, ["dist"]);
  assert.deepEqual(review("-X", "dist", "-X", "node_modules").scope.exclude, [
    "dist",
    "node_modules",
  ]);
});

test("parseArgs: include and exclude compose with refs", () => {
  const scope = review("main..feature", "-I", "src", "-X", "src/generated").scope;
  assert.equal(scope.kind, "range");
  assert.deepEqual(scope.refs, ["main", "feature"]);
  assert.deepEqual(scope.include, ["src"]);
  assert.deepEqual(scope.exclude, ["src/generated"]);
});

test("parseArgs: a value flag with no value is an error", () => {
  assert.match(String(reviewError("--include")), /--include requires a value/);
  assert.match(String(reviewError("--include", "--staged")), /--include requires a value/);
  assert.match(String(reviewError("--exclude=")), /--exclude requires a value/);
});

test("parseArgs: --no-open", () => {
  assert.equal(review().open, true);
  assert.equal(review("--no-open").open, false);
});

test("parseArgs: --output accepts both spellings and an inline value", () => {
  assert.equal(review().output, undefined);
  assert.equal(review("--output", "review.md").output, "review.md");
  assert.equal(review("--output=review.md").output, "review.md");
  assert.equal(review("-o", "review.md").output, "review.md");
});

test("parseArgs: an empty separate-token value is an error too", () => {
  // The inline form already failed; the separate token used to be consumed and
  // then dropped by the `if (v)` at the call site. `-o ""` left the annotations
  // on stdout and `-I ""` reviewed the whole tree — a skill interpolating an
  // unset shell variable got neither what it asked for nor an error.
  for (const flag of ["-I", "--include", "-X", "--exclude", "-o", "--output", "--history-dir"]) {
    assert.match(String(reviewError(flag, "")), new RegExp(`${flag} requires a value`), flag);
  }
});

test("parseArgs: --output with no value is an error", () => {
  assert.match(String(reviewError("--output")), /--output requires a value/);
  assert.match(String(reviewError("--output=")), /--output requires a value/);
});

test("parseArgs: --exit-code-on-comments", () => {
  assert.equal(review().exitCodeOnComments, false);
  assert.equal(review("--exit-code-on-comments").exitCodeOnComments, true);
});

test("parseArgs: --no-history opts out of persistence", () => {
  assert.equal(review().history, true);
  assert.equal(review("--no-history").history, false);
  // The plan hook gets the same default, so the gate saves its review too.
  const hook = parseArgs(["copilot-plan"]);
  assert.equal(hook.command === "copilot-plan" && hook.options.history, true);
});

test("parseArgs: --history-dir accepts both spellings", () => {
  assert.equal(review().historyDir, undefined);
  assert.equal(review("--history-dir", "reviews").historyDir, "reviews");
  assert.equal(review("--history-dir=reviews").historyDir, "reviews");
});

test("parseArgs: --history-dir with no value is an error", () => {
  assert.match(String(reviewError("--history-dir")), /--history-dir requires a value/);
  assert.match(String(reviewError("--history-dir=")), /--history-dir requires a value/);
});

test("parseArgs: a boolean switch rejects an inline value instead of inverting it", () => {
  // `--no-history=false` reads as "keep history" but used to be parsed as bare
  // `--no-history`, i.e. the exact opposite, silently. The caller here is an LLM
  // that has no way to notice; an explicit usage error sends it to exit 2.
  for (const flag of [
    "--no-history",
    "--staged",
    "--exit-code-on-comments",
    "--no-open",
    "--help",
  ]) {
    for (const value of ["false", "true", ""]) {
      assert.match(
        String(reviewError(`${flag}=${value}`)),
        new RegExp(`${flag} does not take a value`),
        `${flag}=${value}`,
      );
    }
  }
  // The bare spellings are untouched.
  assert.equal(review("--no-history").history, false);
  assert.equal(review("--exit-code-on-comments").exitCodeOnComments, true);
});

test("parseArgs: the skill's full invocation parses cleanly", () => {
  const o = review("main..feature", "-I", "src", "-X", "dist", "--no-open", "--exit-code-on-comments");
  assert.equal(o.scope.kind, "range");
  assert.equal(o.exitCodeOnComments, true);
  assert.equal(o.open, false);
});

test("parseArgs: --help", () => {
  assert.equal(review("--help").help, true);
  assert.equal(review("-h").help, true);
  assert.equal(review().help, false);
});

// --- --plan ----------------------------------------------------------------

test("parseArgs: bare --plan has no file", () => {
  const o = review("--plan");
  assert.equal(o.plan, true);
  assert.equal(o.planFile, undefined);
});

test("parseArgs: --plan <path>", () => {
  const o = review("--plan", "docs/plan.md");
  assert.equal(o.plan, true);
  assert.equal(o.planFile, "docs/plan.md");
});

test("parseArgs: --plan=<path>", () => {
  const o = review("--plan=docs/plan.md");
  assert.equal(o.plan, true);
  assert.equal(o.planFile, "docs/plan.md");
});

test("parseArgs: --plan followed by a flag keeps the path empty", () => {
  const o = review("--plan", "--no-open");
  assert.equal(o.plan, true);
  assert.equal(o.planFile, undefined);
  assert.equal(o.open, false);
});

test("parseArgs: --plan= with an empty value is an error", () => {
  assert.match(String(reviewError("--plan=")), /--plan= requires a path/);
});

test("parseArgs: --plan with an empty token is no path, not an empty path", () => {
  // `--plan "$PLAN"` with $PLAN unset. Recording "" as the path would suppress
  // the documented $REVGATE_PLAN_FILE fallback, since resolvePlan only falls
  // back when no path was given at all.
  const o = review("--plan", "");
  assert.equal(o.plan, true);
  assert.equal(o.planFile, undefined);
  // It is still consumed: leaving it behind makes it a positional, which the
  // subcommand check would reject as a mistyped command.
  assert.equal(o.open, true);
});

// --- unknown flags ---------------------------------------------------------

test("parseArgs: an unknown flag is an error on the review path", () => {
  assert.match(String(reviewError("--nope")), /unknown flag: --nope/);
  assert.match(String(reviewError("-Z")), /unknown flag: -Z/);
});

test("parseArgs: the first problem is the one reported", () => {
  assert.match(String(reviewError("--nope", "--also-nope")), /unknown flag: --nope/);
});

// --- help text -------------------------------------------------------------

test("helpText: lists every flag and command", () => {
  const help = helpText();
  for (const token of [
    "revgate review",
    "copilot-plan",
    "--staged",
    "--include",
    "-I",
    "--exclude",
    "-X",
    "--plan",
    "--output",
    "-o",
    "--exit-code-on-comments",
    "--history-dir",
    "--no-history",
    "--no-open",
    "--help",
    "-h",
  ]) {
    assert.ok(help.includes(token), `help text is missing ${token}`);
  }
  assert.ok(help.endsWith("\n"));
});

test("helpText: documents the exit codes, including 10", () => {
  const help = helpText();
  for (const line of [/^ {2}0 {3}/m, /^ {2}1 {3}/m, /^ {2}2 {3}/m, /^ {2}10 {2}/m]) {
    assert.match(help, line);
  }
});

test("parseArgs: --plan cannot be combined with a diff scope", () => {
  // runReviewCommand discards the scope on the plan path, so accepting these
  // would silently review something other than what was asked for.
  for (const argv of [
    ["--plan", "p.md", "--staged"],
    ["--plan", "p.md", "main..feature"],
    ["--plan", "p.md", "--include", "src"],
    ["--plan", "p.md", "--exclude", "src/generated"],
  ]) {
    assert.match(
      reviewError(...argv) ?? "",
      /--plan reviews a plan document/,
      `${argv.join(" ")} was accepted`,
    );
  }

  // A plan review with its own flags still parses.
  assert.equal(review("--plan", "p.md", "--no-open", "--exit-code-on-comments").plan, true);
});
