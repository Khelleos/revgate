import assert from "node:assert/strict";
import test from "node:test";
import { buildDecision } from "../src/feedback.js";
import type { DiffFile, ReviewSubmission } from "../src/types.js";

const appFile: DiffFile = {
  oldPath: "src/app.ts",
  newPath: "src/app.ts",
  path: "src/app.ts",
  isNew: false,
  isDeleted: false,
  isRenamed: false,
  isBinary: false,
  additions: 3,
  deletions: 0,
  hunks: [
    {
      header: "@@ -1,1 +1,2 @@",
      oldStart: 1,
      newStart: 1,
      lines: [
        { type: "context", content: 'import a from "a";', oldLine: 1, newLine: 1 },
        { type: "add", content: "let x = 1;", oldLine: null, newLine: 2 },
      ],
    },
    {
      header: "@@ -11,0 +12,2 @@",
      oldStart: 11,
      newStart: 12,
      lines: [
        { type: "add", content: "  const big = compute();", oldLine: null, newLine: 12 },
        { type: "add", content: "  return big;", oldLine: null, newLine: 13 },
      ],
    },
  ],
};

const otherFile: DiffFile = {
  oldPath: "other.ts",
  newPath: "other.ts",
  path: "other.ts",
  isNew: false,
  isDeleted: false,
  isRenamed: false,
  isBinary: false,
  additions: 0,
  deletions: 1,
  hunks: [
    {
      header: "@@ -1 +0,0 @@",
      oldStart: 1,
      newStart: 1,
      lines: [{ type: "del", content: "const gone = true;", oldLine: 1, newLine: null }],
    },
  ],
};

const files = [appFile, otherFile];

const review = (over: Partial<ReviewSubmission> = {}): ReviewSubmission => ({
  decision: "request_changes",
  summary: "",
  comments: [],
  ...over,
});

test("buildDecision: approve allows with no reason", () => {
  const decision = buildDecision(review({ decision: "approve", summary: "ship it" }), files);
  assert.deepEqual(decision, { decision: "allow" });
});

/** Snapshot of the exact block prompt the plan hook feeds back to the agent. */
test("buildDecision: request_changes renders the full block prompt", () => {
  const decision = buildDecision(
    review({
      summary: "Looks risky.",
      comments: [
        { file: "src/app.ts", startLine: 2, endLine: 2, side: "new", body: "Use const." },
        {
          file: "src/app.ts",
          startLine: 12,
          endLine: 13,
          side: "new",
          body: "Extract this.\nSeriously.",
        },
        { file: "other.ts", startLine: 1, endLine: 1, side: "old", body: "Why removed?" },
      ],
    }),
    files,
  );

  assert.equal(decision.decision, "block");
  assert.equal(
    decision.reason,
    [
      "A human reviewer looked at the plan you proposed and left the review below.",
      "Revise the plan to address every point before you start implementing, then briefly note what you changed.",
      "",
      "## Review verdict: REQUEST CHANGES",
      "",
      "## Overall feedback",
      "Looks risky.",
      "",
      "## Plan comments",
      "",
      "### src/app.ts",
      "- **src/app.ts:2**  (`let x = 1;`)",
      "  Use const.",
      "- **src/app.ts:12-13**",
      "  ```",
      "    const big = compute();",
      "    return big;",
      "  ```",
      "  Extract this.",
      "  Seriously.",
      "",
      "### other.ts",
      "- **other.ts:1**  (`const gone = true;`)",
      "  Why removed?",
      "",
    ].join("\n"),
  );
});

test("buildDecision: single-line comment quotes the line inline", () => {
  const decision = buildDecision(
    review({
      comments: [{ file: "src/app.ts", startLine: 2, endLine: 2, side: "new", body: "No." }],
    }),
    files,
  );
  const reason = decision.reason ?? "";
  assert.match(reason, /^- \*\*src\/app\.ts:2\*\* {2}\(`let x = 1;`\)$/m);
  assert.doesNotMatch(reason, /```/);
});

test("buildDecision: range comment quotes the lines as a fenced block", () => {
  const decision = buildDecision(
    review({
      comments: [{ file: "src/app.ts", startLine: 12, endLine: 13, side: "new", body: "No." }],
    }),
    files,
  );
  const reason = decision.reason ?? "";
  assert.match(reason, /- \*\*src\/app\.ts:12-13\*\*\n {2}```\n {4}const big = compute\(\);\n/);
});

test("buildDecision: old-side comment resolves against deleted lines", () => {
  const decision = buildDecision(
    review({
      comments: [{ file: "other.ts", startLine: 1, endLine: 1, side: "old", body: "Why?" }],
    }),
    files,
  );
  assert.match(decision.reason ?? "", /- \*\*other\.ts:1\*\* {2}\(`const gone = true;`\)/);
});

test("buildDecision: comment on an unknown file omits the code reference", () => {
  const decision = buildDecision(
    review({
      comments: [{ file: "missing.ts", startLine: 5, endLine: 5, side: "new", body: "Hmm." }],
    }),
    files,
  );
  const reason = decision.reason ?? "";
  assert.match(reason, /^- \*\*missing\.ts:5\*\*$/m);
});

test("buildDecision: empty request_changes falls back to an ask-the-human prompt", () => {
  const decision = buildDecision(review(), files);
  assert.equal(
    decision.reason,
    [
      "A human reviewer looked at the plan you proposed and left the review below.",
      "Revise the plan to address every point before you start implementing, then briefly note what you changed.",
      "",
      "## Review verdict: REQUEST CHANGES",
      "",
      "The reviewer requested changes but left no specific notes. Ask them what to change.",
    ].join("\n"),
  );
});

test("buildDecision: whitespace-only summary counts as empty", () => {
  const decision = buildDecision(review({ summary: "   \n  " }), files);
  const reason = decision.reason ?? "";
  assert.doesNotMatch(reason, /## Overall feedback/);
  assert.match(reason, /left no specific notes/);
});

test("buildDecision: summary with comments skips the fallback line", () => {
  const decision = buildDecision(
    review({
      summary: "Fix it.",
      comments: [{ file: "src/app.ts", startLine: 2, endLine: 2, side: "new", body: "here" }],
    }),
    files,
  );
  assert.doesNotMatch(decision.reason ?? "", /left no specific notes/);
});

test("buildDecision: a file-level comment is not quoted back as line 0", () => {
  // normalizeComment degrades an unusable line number to 0 — the file-level
  // sentinel the annotation renderer shows as a bare `## path`. Rendering it as
  // `src/app.ts:0` here would point the agent at a line no file has, and make
  // the two output contracts disagree about a sentinel one of them introduced.
  const decision = buildDecision(
    review({
      summary: "",
      comments: [{ file: "src/app.ts", startLine: 0, endLine: 0, side: "new", body: "Whole file." }],
    }),
    files,
  );
  const reason = decision.reason ?? "";
  assert.match(reason, /^- \*\*src\/app\.ts\*\*$/m);
  assert.doesNotMatch(reason, /src\/app\.ts:0/);
  assert.match(reason, /^ {2}Whole file\.$/m);
});

test("buildDecision: a rename does not steal a comment on a new file at the old path", () => {
  // `git mv a.txt b.txt` plus a fresh `a.txt` puts both in the diff, and the
  // renamed entry still carries `oldPath: "a.txt"`. Matching path/newPath/oldPath
  // at equal priority resolved a comment on `a.txt` to the RENAMED file, so the
  // agent read a correct location with a different file's code quoted under it.
  const renamed: DiffFile = {
    oldPath: "a.txt",
    newPath: "b.txt",
    path: "b.txt",
    isNew: false,
    isDeleted: false,
    isRenamed: true,
    isBinary: false,
    additions: 1,
    deletions: 0,
    hunks: [
      {
        header: "@@ -1 +1 @@",
        oldStart: 1,
        newStart: 1,
        lines: [{ type: "add", content: "moved content", oldLine: null, newLine: 1 }],
      },
    ],
  };
  const recreated: DiffFile = {
    oldPath: "/dev/null",
    newPath: "a.txt",
    path: "a.txt",
    isNew: true,
    isDeleted: false,
    isRenamed: false,
    isBinary: false,
    additions: 1,
    deletions: 0,
    hunks: [
      {
        header: "@@ -0,0 +1 @@",
        oldStart: 0,
        newStart: 1,
        lines: [{ type: "add", content: "brand new content", oldLine: null, newLine: 1 }],
      },
    ],
  };

  const decision = buildDecision(
    review({
      summary: "",
      comments: [{ file: "a.txt", startLine: 1, endLine: 1, side: "new", body: "Check this." }],
    }),
    // Renamed entry first, so a first-match-wins lookup picks the wrong one.
    [renamed, recreated],
  );
  const reason = decision.reason ?? "";
  assert.match(reason, /brand new content/);
  assert.doesNotMatch(reason, /moved content/);
});
