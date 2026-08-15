// The comment-density guard. The rule is in agents.md: a one-line JSDoc per
// export plus short "why" notes, with the full reasoning in the Rules there. A
// file that drifts back to narrative prose fails here instead of at review time.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { repoRoot, walk } from "./helpers/tree.js";

/** The ceiling every file is held to, as a fraction of its lines. */
const MAX_COMMENT_RATIO = 0.2;

/**
 * Files the ceiling cannot apply to. `log.ts` has two exported one-liners in a
 * nine-line file, so its two required JSDoc lines are already over.
 */
const EXEMPT = new Set(["src/shared/log.ts"]);

/** A file's comment lines, their 0-based line numbers, and its total line count. */
function commentStats(source: string): {
  comments: string[];
  commentAt: Set<number>;
  lines: number;
} {
  const lines = source.split(/\r?\n/);
  if (lines.length && lines[lines.length - 1] === "") lines.pop();
  let inBlock = false;
  const comments: string[] = [];
  const commentAt = new Set<number>();
  lines.forEach((line, i) => {
    const t = line.trim();
    if (inBlock) {
      comments.push(t);
      commentAt.add(i);
      if (t.includes("*/")) inBlock = false;
      return;
    }
    if (t.startsWith("/*")) {
      comments.push(t);
      commentAt.add(i);
      if (!t.includes("*/")) inBlock = true;
      return;
    }
    if (t.startsWith("//")) {
      comments.push(t);
      commentAt.add(i);
    }
  });
  return { comments, commentAt, lines: lines.length };
}

const files = [
  ...(await walk(path.join(repoRoot, "src"), ".ts")),
  ...(await walk(path.join(repoRoot, "test"), ".ts")),
];

test("the file list is non-empty, so the ceiling below is not vacuous", () => {
  assert.ok(files.length > 40, `expected the whole tree, found ${files.length} file(s)`);
});

test("no file is more than 20% comment lines", async () => {
  const over: string[] = [];
  for (const rel of files) {
    if (EXEMPT.has(rel)) continue;
    const { comments, lines } = commentStats(await readFile(path.join(repoRoot, rel), "utf8"));
    const ratio = comments.length / lines;
    if (ratio > MAX_COMMENT_RATIO) {
      over.push(`${rel}: ${comments.length}/${lines} = ${(ratio * 100).toFixed(1)}%`);
    }
  }
  assert.deepEqual(over, [], `over the comment ceiling:\n  ${over.join("\n  ")}`);
});

test("every exempt path still exists, so the list cannot rot", async () => {
  for (const rel of EXEMPT) {
    assert.ok(files.includes(rel), `${rel} is exempt but no longer exists`);
  }
});

test("commentStats counts block, line and trailing comments the way the rule means", () => {
  const source = [
    "/**",
    " * A block.",
    " */",
    "export const a = 1; // trailing, not a comment line",
    "// a line comment",
    "/* one-liner */",
    "const b = 2;",
  ].join("\n");
  const { comments, commentAt, lines } = commentStats(source);
  assert.equal(lines, 7);
  assert.deepEqual(comments, ["/**", "* A block.", "*/", "// a line comment", "/* one-liner */"]);
  assert.deepEqual([...commentAt].sort((a, b) => a - b), [0, 1, 2, 4, 5]);
});

test("every exported symbol in src/ carries a doc comment", async () => {
  const declaration = /^export (?:async function|function|const|let|interface|class|type|enum)\s/;
  const undocumented: string[] = [];
  for (const rel of files.filter((f) => f.startsWith("src/"))) {
    const source = await readFile(path.join(repoRoot, rel), "utf8");
    const { commentAt } = commentStats(source);
    source.split(/\r?\n/).forEach((line, i) => {
      if (!declaration.test(line) || commentAt.has(i - 1)) return;
      undocumented.push(`${rel}:${i + 1} ${line.trim().slice(0, 60)}`);
    });
  }
  assert.deepEqual(undocumented, [], `undocumented exports:\n  ${undocumented.join("\n  ")}`);
});

test("no comment carries narrative or historical prose", async () => {
  // The pattern lives here as source, not in a comment, so this guard cannot
  // trip over its own text.
  const banned = new RegExp(
    ["this used to", "used to be", "earlier versions?", "in the past", "previously,"].join("|"),
    "i",
  );
  const offenders: string[] = [];
  for (const rel of files) {
    const { comments } = commentStats(await readFile(path.join(repoRoot, rel), "utf8"));
    const hit = comments.find((c) => banned.test(c));
    if (hit) offenders.push(`${rel}: ${hit}`);
  }
  assert.deepEqual(offenders, [], `history belongs in agents.md, not the code:\n  ${offenders.join("\n  ")}`);
});
