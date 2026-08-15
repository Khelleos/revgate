import assert from "node:assert/strict";
import test from "node:test";
import { helpText } from "../../src/cli/help.js";

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
