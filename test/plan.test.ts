import assert from "node:assert/strict";
import test from "node:test";
import { planToFiles, planTitle } from "../src/plan.js";

const planLines = (text: string) => planToFiles(text)[0].hunks[0].lines;

test("planToFiles: produces one synthetic file with plan metadata", () => {
  const files = planToFiles("step one\nstep two");
  assert.equal(files.length, 1);
  const f = files[0];
  assert.equal(f.path, "Plan");
  assert.equal(f.newPath, "PLAN");
  assert.equal(f.oldPath, "");
  assert.equal(f.isNew, false);
  assert.equal(f.isDeleted, false);
  assert.equal(f.isRenamed, false);
  assert.equal(f.isBinary, false);
  assert.equal(f.additions, 0);
  assert.equal(f.deletions, 0);
  assert.equal(f.hunks.length, 1);
  assert.equal(f.hunks[0].header, "");
  assert.equal(f.hunks[0].oldStart, 0);
  assert.equal(f.hunks[0].newStart, 1);
});

test("planToFiles: numbers every line from 1 on the new side", () => {
  assert.deepEqual(
    planLines("alpha\nbeta\ngamma").map((l) => [l.type, l.content, l.oldLine, l.newLine]),
    [
      ["plan", "alpha", null, 1],
      ["plan", "beta", null, 2],
      ["plan", "gamma", null, 3],
    ],
  );
});

test("planToFiles: normalizes CRLF", () => {
  assert.deepEqual(
    planLines("alpha\r\nbeta\r\ngamma").map((l) => l.content),
    ["alpha", "beta", "gamma"],
  );
});

test("planToFiles: strips trailing whitespace and blank lines", () => {
  assert.deepEqual(planLines("alpha\nbeta\n\n\n  ").map((l) => l.content), ["alpha", "beta"]);
  assert.deepEqual(planLines("alpha\r\nbeta\r\n").map((l) => l.content), ["alpha", "beta"]);
});

test("planToFiles: keeps interior blank lines commentable", () => {
  assert.deepEqual(
    planLines("alpha\n\nbeta").map((l) => [l.content, l.newLine]),
    [
      ["alpha", 1],
      ["", 2],
      ["beta", 3],
    ],
  );
});

test("planToFiles: empty plan still yields one commentable line", () => {
  for (const empty of ["", "   ", "\n\n"]) {
    const lines = planLines(empty);
    assert.deepEqual(
      lines.map((l) => [l.content, l.newLine]),
      [["", 1]],
      `empty input ${JSON.stringify(empty)}`,
    );
  }
});

test("planTitle: uses the first H1", () => {
  assert.equal(planTitle("# Rewrite the parser\n\nbody text"), "Rewrite the parser");
});

test("planTitle: uses an H2 when there is no H1", () => {
  assert.equal(planTitle("intro\n\n## Phase one\n\n# Later heading"), "Phase one");
});

test("planTitle: trims surrounding whitespace and CRLF", () => {
  assert.equal(planTitle("#   Spaced title  \nbody"), "Spaced title");
  assert.equal(planTitle("# CRLF title\r\nbody"), "CRLF title");
});

test("planTitle: ignores H3 and deeper", () => {
  assert.equal(planTitle("### Too deep\n#### Deeper"), "Proposed plan");
});

test("planTitle: ignores a hash with no space", () => {
  assert.equal(planTitle("#NoSpace\nbody"), "Proposed plan");
});

test("planTitle: falls back to a generic label", () => {
  assert.equal(planTitle("just some prose\nand more"), "Proposed plan");
  assert.equal(planTitle(""), "Proposed plan");
});
