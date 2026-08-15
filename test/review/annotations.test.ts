import assert from "node:assert/strict";
import test from "node:test";
import {
  renderAnnotations,
  renderNoReview,
  renderDroppedPaths,
  renderNothingInScope,
  renderUntrackedScanFailed,
} from "../../src/review/annotations.js";
import { comment, files, review } from "../helpers/review.js";

/** The records only — everything from the first `## ` header on, split per record. */
function records(text: string): string[] {
  const lines = text.split("\n");
  const start = lines.findIndex((l) => l.startsWith("## "));
  if (start === -1) return [];
  return lines
    .slice(start)
    .join("\n")
    .trim()
    .split(/\n\n(?=## )/)
    .map((r) => r.trim());
}

// `locationHeader` itself now lives in feedback.ts, shared with the hook prose —
// its own tests moved there with it. What stays here is that the records use it.

// --- full render -----------------------------------------------------------

test("renderAnnotations: verdict, scope and counts lead the output", () => {
  const text = renderAnnotations(
    review({ summary: "Looks risky.", comments: [comment()] }),
    files,
    { mode: "diff", scope: "main..feature", branch: "feature" },
  );
  const head = text.split("\n").slice(0, 5);
  assert.deepEqual(head, [
    "# revgate review: REQUEST CHANGES",
    "scope: main..feature",
    "branch: feature",
    "files: 2",
    "comments: 1",
  ]);
});

test("renderAnnotations: approve says so without any records", () => {
  const text = renderAnnotations(review({ decision: "approve" }), files, { scope: "staged changes" });
  assert.match(text, /^# revgate review: APPROVED$/m);
  assert.doesNotMatch(text, /^## /m);
  assert.match(text, /No comments were left\./);
});

test("renderAnnotations: the note explains an empty review", () => {
  const text = renderAnnotations(review({ decision: "approve" }), [], {
    note: "No changes to review in staged changes.",
  });
  assert.match(text, /No changes to review in staged changes\./);
  assert.match(text, /^files: 0$/m);
});

test("renderAnnotations: plan mode is flagged in the header", () => {
  const text = renderAnnotations(review({ comments: [comment({ file: "Plan" })] }), [], {
    mode: "plan",
  });
  assert.match(text, /^mode: plan$/m);
});

test("renderAnnotations: one record per comment, grouped by file", () => {
  const text = renderAnnotations(
    review({
      comments: [
        comment({ startLine: 2, endLine: 2, body: "Use const." }),
        comment({ file: "other.ts", startLine: 1, endLine: 1, side: "old", body: "Why removed?" }),
        comment({ startLine: 12, endLine: 13, body: "Extract this." }),
      ],
    }),
    files,
  );

  assert.deepEqual(records(text), [
    "## src/app.ts:2 (+)\nUse const.",
    // The third comment is on src/app.ts, so it sorts up next to the first.
    "## src/app.ts:12-13 (+)\nExtract this.",
    "## other.ts:1 (-)\nWhy removed?",
  ]);
});

test("renderAnnotations: continuation lines are indented so they cannot open a record", () => {
  const text = renderAnnotations(
    review({ comments: [comment({ body: "Use const.\n## not a header\nreally" })] }),
    files,
  );
  assert.equal(
    records(text)[0],
    ["## src/app.ts:2 (+)", "Use const.", " ## not a header", " really"].join("\n"),
  );
  // Exactly one record survives a body that tried to look like a header.
  assert.equal(records(text).length, 1);
});

test("renderAnnotations: a body whose FIRST line looks like a header is indented too", () => {
  const text = renderAnnotations(review({ comments: [comment({ body: "## sneaky" })] }), files);
  assert.equal(records(text)[0], "## src/app.ts:2 (+)\n ## sneaky");
});

test("renderAnnotations: a summary that looks like a header is indented", () => {
  const text = renderAnnotations(review({ summary: "## totals\nall bad" }), files);
  assert.match(text, /^ ## totals\n all bad$/m);
  assert.doesNotMatch(text, /^## /m);
});

test("renderAnnotations: an empty comment body leaves the header alone", () => {
  const text = renderAnnotations(review({ comments: [comment({ body: "   \n " })] }), files);
  assert.equal(records(text)[0], "## src/app.ts:2 (+)");
});

test("renderAnnotations: file-level comment has no line suffix", () => {
  const text = renderAnnotations(
    review({ comments: [comment({ startLine: 0, endLine: 0, body: "Split this file." })] }),
    files,
  );
  assert.equal(records(text)[0], "## src/app.ts\nSplit this file.");
});

test("renderAnnotations: output always ends with exactly one newline", () => {
  for (const r of [review(), review({ comments: [comment()] }), review({ summary: "hi" })]) {
    const text = renderAnnotations(r, files);
    assert.ok(text.endsWith("\n"), "missing trailing newline");
    assert.ok(!text.endsWith("\n\n"), "trailing blank line");
  }
});

test("renderAnnotations: an empty request_changes still reports the verdict", () => {
  const text = renderAnnotations(review(), files);
  assert.match(text, /^# revgate review: REQUEST CHANGES$/m);
  assert.match(text, /^comments: 0$/m);
});

test("renderAnnotations: a clean scan adds no untracked-scan line", () => {
  // The negative half: this line means "something is missing", so it must never
  // appear on an ordinary review.
  assert.doesNotMatch(renderAnnotations(review({ summary: "Fine." }), files, {}), /untracked-scan/);
});

// --- the no-verdict reports ------------------------------------------------

test("renderNoReview: reports the absence of a verdict, never an approval", () => {
  const out = renderNoReview("No review was captured (server closed before submission).", {
    mode: "diff",
    scope: "main..feature",
    branch: "feature",
  });
  assert.match(out, /^# revgate review: NO REVIEW CAPTURED\n/);
  assert.doesNotMatch(out, /APPROVED/);
  assert.match(out, /scope: main\.\.feature/);
  assert.match(out, /branch: feature/);
  assert.match(out, /server closed before submission/);
  assert.ok(out.endsWith("\n"));
});

test("renderUntrackedScanFailed: carries the scope/branch header lines", () => {
  const text = renderUntrackedScanFailed({ scope: "working tree vs HEAD", branch: "feature" });
  assert.match(text, /^# revgate review: SCAN FAILED$/m);
  assert.match(text, /^scope: working tree vs HEAD$/m);
  assert.match(text, /^branch: feature$/m);
  assert.match(text, /^untracked-scan: failed$/m);
  assert.ok(text.endsWith("\n"));
});

test("renderDroppedPaths: carries the scope/branch header lines", () => {
  const text = renderDroppedPaths(2, { scope: "main..feature", branch: "feature" });
  assert.match(text, /^# revgate review: PATHS DROPPED$/m);
  assert.match(text, /^scope: main\.\.feature$/m);
  assert.match(text, /^branch: feature$/m);
  assert.match(text, /^dropped-paths: 2$/m);
  assert.ok(text.endsWith("\n"));
});

test("renderNothingInScope: carries the plan/scope/branch header lines", () => {
  const text = renderNothingInScope(1, { scope: "main..feature", branch: "feature" });
  assert.match(text, /^# revgate review: NOTHING IN SCOPE$/m);
  assert.match(text, /^scope: main\.\.feature$/m);
  assert.match(text, /^branch: feature$/m);
  assert.match(text, /^filtered-out: 1$/m);
  assert.ok(text.endsWith("\n"));
});
