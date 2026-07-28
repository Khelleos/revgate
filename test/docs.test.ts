/**
 * Documentation drift guards.
 *
 * `test/skills.test.ts` keeps the SKILL.md files honest against `parseArgs`;
 * this does the same for the two documents a human reads — README.md and
 * agents.md. A flag that gets renamed in cli.ts and not in the README is a bug
 * report waiting to happen, and the README is also where the exit-code and
 * history contracts are promised.
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { helpText, parseArgs } from "../src/cli.js";
import { commandLines, expectedCommand, toArgv } from "./helpers/docs.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function doc(name: string): Promise<string> {
  return (await readFile(path.join(repoRoot, name), "utf8")).replace(/\r\n/g, "\n");
}

const readme = await doc("README.md");
const agents = await doc("agents.md");

test("README: every documented revgate command parses as the command it documents", () => {
  const commands = commandLines(readme);
  assert.ok(commands.length >= 10, `README documents only ${commands.length} revgate commands`);

  // Each command is parsed in the form it is written, not rewritten into a
  // `review`: `revgate copilot-plan` re-parsed as `review copilot-plan` is a
  // valid review of a ref named copilot-plan, so a renamed or deleted subcommand
  // would leave the README stale with a green suite.
  let sawHook = false;
  for (const command of commands) {
    const argv = toArgv(command);
    const parsed = parseArgs(argv);
    assert.equal(
      parsed.command,
      expectedCommand(argv),
      `documented command resolves to the wrong entry point: ${command}`,
    );
    // Only `review` reports usage errors — the hook paths must never fail argv.
    assert.equal(
      parsed.command === "review" ? parsed.error : undefined,
      undefined,
      `documented command does not parse: ${command}`,
    );
    if (parsed.command !== "review") sawHook = true;
  }
  assert.ok(sawHook, "README documents no hook invocation — the check above proves nothing");
});

test("README: documents every flag the CLI accepts", () => {
  // Pull the flags straight out of --help so a new flag cannot land undocumented.
  const flags = new Set(helpText().match(/(?<![\w-])--?[A-Za-z][\w-]*/g) ?? []);
  assert.ok(flags.size >= 12, `only found ${flags.size} flags in the help text`);

  for (const flag of flags) {
    assert.ok(readme.includes(flag), `README never mentions ${flag}`);
  }
});

test("README: documents both invocation models", () => {
  assert.match(readme, /Two ways to run revgate/);
  // The on-demand command and the one automatic hook each need to be findable
  // by name — and the removed diff gate must not resurface as a live feature.
  assert.match(readme, /preToolUse/);
  assert.match(readme, /\/revgate-review/);
  assert.match(readme, /\/revgate-plan/);
  assert.match(readme, /revgate copilot-plan/);
  assert.doesNotMatch(readme, /agentStop hook is installed|gates finished turns/i);
});

test("README: documents the annotation format and the exit codes", () => {
  assert.match(readme, /## path:LINE \(\+\)/);
  assert.match(readme, /## path:START-END \(\+\)/);
  // Continuation-line indentation is the one rule a consumer must know.
  assert.match(readme, /indented by one space/);
  for (const code of ["`0`", "`10`", "`1`", "`2`"]) {
    assert.ok(readme.includes(code), `README never documents exit code ${code}`);
  }
  assert.match(readme, /--exit-code-on-comments/);
});

test("README: documents where history lives", () => {
  assert.match(readme, /~\/\.revgate\/history/);
  assert.match(readme, /\$REVGATE_HISTORY_DIR/);
  assert.match(readme, /--history-dir/);
  assert.match(readme, /<repo-name>\/<timestamp>\.md/);
});

test("README: documents the plugin manifests that actually exist", () => {
  for (const file of [
    ".github/plugin/marketplace.json",
    "copilot-plugin/plugin.json",
    "copilot-plugin/hooks.json",
    "copilot-plugin/skills/",
  ]) {
    assert.ok(readme.includes(file), `README never mentions ${file}`);
  }
  assert.match(readme, /\/plugin marketplace add/);
  assert.match(readme, /\/plugin install revgate-copilot@revgate/);
  // -Skills is the non-plugin route to the same slash commands.
  assert.match(readme, /install\.ps1 -Skills/);
});

test("README: credits revdiff and records what was deferred", () => {
  assert.match(readme, /Design notes: what we took from revdiff/);
  assert.match(readme, /github\.com\/umputun\/revdiff/);
  for (const deferred of ["TUI", "themes", "blame", "Jujutsu", "--stdin", "--only", "config file"]) {
    assert.ok(
      new RegExp(deferred.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i").test(readme),
      `README does not say whether ${deferred} was adopted`,
    );
  }
});

test("agents.md: lists every src module and the project commands", () => {
  for (const mod of [
    "index.ts",
    "cli.ts",
    "git.ts",
    "diff.ts",
    "plan.ts",
    "copilot.ts",
    "server.ts",
    "feedback.ts",
    "output.ts",
    "history.ts",
    "log.ts",
    "types.ts",
  ]) {
    assert.ok(agents.includes(mod), `agents.md never mentions src/${mod}`);
  }
  for (const cmd of ["npm test", "npm run build", "npm run sync:skills", "npm run demo"]) {
    assert.ok(agents.includes(cmd), `agents.md never mentions ${cmd}`);
  }
});

test("agents.md: states the stdout contract and the fail-open rule", () => {
  assert.match(agents, /stdout is a contract/i);
  assert.match(agents, /stderr/);
  assert.match(agents, /fail open/i);
  assert.match(agents, /exit 0/);
});
