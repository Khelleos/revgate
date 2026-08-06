import assert from "node:assert/strict";
import test from "node:test";
import {
  hasFindings,
  renderAnnotations,
  renderNoReview,
  renderDroppedPaths,
  renderNothingInScope,
  renderUntrackedScanFailed,
  reviewExitCode,
  reviewReport,
} from "../src/output.js";
import type { DiffFile, LineComment, ReviewSubmission } from "../src/types.js";

const file = (path: string): DiffFile => ({
  oldPath: path,
  newPath: path,
  path,
  isNew: false,
  isDeleted: false,
  isRenamed: false,
  isBinary: false,
  additions: 1,
  deletions: 0,
  hunks: [],
});

const files = [file("src/app.ts"), file("other.ts")];

const comment = (over: Partial<LineComment> = {}): LineComment => ({
  file: "src/app.ts",
  startLine: 2,
  endLine: 2,
  side: "new",
  body: "Use const.",
  ...over,
});

const review = (over: Partial<ReviewSubmission> = {}): ReviewSubmission => ({
  decision: "request_changes",
  summary: "",
  comments: [],
  ...over,
});

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

// --- exit codes ------------------------------------------------------------

test("hasFindings: comments or a request-changes verdict count", () => {
  assert.equal(hasFindings(review({ decision: "approve" })), false);
  assert.equal(hasFindings(review({ decision: "approve", comments: [comment()] })), true);
  assert.equal(hasFindings(review()), true);
  assert.equal(hasFindings(review({ comments: [comment()] })), true);
});

test("reviewExitCode: 10 only when opted in and something was captured", () => {
  assert.equal(reviewExitCode(review({ decision: "approve" }), true), 0);
  assert.equal(reviewExitCode(review(), true), 10);
  assert.equal(reviewExitCode(review({ decision: "approve", comments: [comment()] }), true), 10);
  // Without the flag a review that found problems still exits 0.
  assert.equal(reviewExitCode(review(), false), 0);
  assert.equal(reviewExitCode(review({ decision: "approve" }), false), 0);
});

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

// --- reviewReport ----------------------------------------------------------
//
// The one decision an agent must never see wrong: whether a human approved.
// `revgate review` owns three mutually exclusive reports, and the code that
// picks between them cannot be reached in-process (src/index.ts runs main() on
// import), so the choice lives here as a pure function and is tested directly.

test("reviewReport: an interrupted review is exit 1 and never an approval", () => {
  const report = reviewReport(
    {
      review: null,
      files,
      interrupted: true,
      isRepo: true,
      note: "No review was captured (x).",
      scope: "main..feature",
    },
    "diff",
    false,
  );
  assert.equal(report.kind, "interrupted");
  assert.equal(report.exitCode, 1, "exit 0 would read as a human sign-off nobody gave");
  assert.match(report.text, /^# revgate review: NO REVIEW CAPTURED$/m);
  assert.doesNotMatch(report.text, /APPROVED/);
  assert.match(report.text, /No review was captured/);
});

test("reviewReport: interrupted wins over every other signal", () => {
  // Ordering matters: an interrupted run outside a repo, or one carrying a stale
  // review object, must still report "no verdict" rather than a verdict.
  const report = reviewReport({ review: null, files: [], interrupted: true, isRepo: false }, "diff", true);
  assert.equal(report.kind, "interrupted");
  assert.equal(report.exitCode, 1);
});

test("reviewReport: outside a repository with no verdict is exit 2, not an approval", () => {
  const report = reviewReport({ review: null, files: [], isRepo: false }, "diff", false);
  assert.equal(report.kind, "not-a-repo");
  assert.equal(report.exitCode, 2, "a wrong directory is bad usage, not an approval");
  assert.match(report.text, /^# revgate review: NO REVIEW CAPTURED$/m);
  assert.match(report.text, /Not a git repository/);
});

test("reviewReport: outside a repository WITH a verdict reports the verdict", () => {
  // A plan review opens the UI outside a repo, so a human can reach submit on a
  // run carrying isRepo: false. Discarding what they typed is the same
  // "report disagrees with the reviewer" failure, inverted.
  const report = reviewReport(
    { review: review({ summary: "Please fix." }), files: [], isRepo: false },
    "plan",
    false,
  );
  assert.equal(report.kind, "verdict");
  assert.equal(report.exitCode, 0);
  assert.match(report.text, /^# revgate review: REQUEST CHANGES$/m);
  assert.match(report.text, /Please fix\./);
  assert.doesNotMatch(report.text, /NO REVIEW CAPTURED/);
});

test("reviewReport: nothing to review is a real approval at exit 0", () => {
  const report = reviewReport(
    {
      review: null,
      files: [],
      isRepo: true,
      note: "No changes to review in main..feature.",
      scope: "main..feature",
    },
    "diff",
    true,
  );
  assert.equal(report.kind, "verdict");
  assert.equal(report.exitCode, 0, "--exit-code-on-comments must not fire on an empty review");
  assert.match(report.text, /^# revgate review: APPROVED$/m);
  assert.match(report.text, /No changes to review in main\.\.feature\./);
});

test("reviewReport: a captured verdict honours --exit-code-on-comments", () => {
  const captured = { review: review({ comments: [comment()] }), files, isRepo: true };
  assert.equal(reviewReport(captured, "diff", true).exitCode, 10);
  assert.equal(reviewReport(captured, "diff", false).exitCode, 0);
  assert.equal(reviewReport(captured, "diff", true).kind, "verdict");
});

test("reviewReport: filters that removed every file are exit 2, not an approval", () => {
  // The dangerous inversion this branch exists for: a busy diff, an -I/-X pair
  // that hid all of it, and a report the agent reads as a clean bill of health.
  const report = reviewReport(
    {
      review: null,
      files: [],
      isRepo: true,
      filteredOut: 3,
      note: "No changes to review.",
      scope: "working tree vs HEAD [+no-such-dir]",
    },
    "diff",
    true,
  );
  assert.equal(report.kind, "filtered-out");
  assert.equal(report.exitCode, 2, "hiding the whole diff is bad usage, not an approval");
  assert.match(report.text, /^# revgate review: NOTHING IN SCOPE$/m);
  assert.doesNotMatch(report.text, /APPROVED/);
  assert.match(report.text, /^filtered-out: 3$/m);
  assert.match(report.text, /^scope: working tree vs HEAD \[\+no-such-dir\]$/m);
  // The fix the caller has to make is named in the report, not only on stderr:
  // with -o <file> the report is the only thing an agent reads.
  assert.match(report.text, /relative to the repository root/);
});

test("reviewReport: a verdict beats filteredOut", () => {
  // A plan review opens the UI on an empty file list, so a human can submit on
  // a run that also filtered everything out. What they typed wins, as with isRepo.
  const report = reviewReport(
    { review: review({ summary: "Looks fine." }), files: [], isRepo: true, filteredOut: 2 },
    "diff",
    false,
  );
  assert.equal(report.kind, "verdict");
  assert.equal(report.exitCode, 0);
  assert.doesNotMatch(report.text, /NOTHING IN SCOPE/);
});

test("reviewReport: an empty diff with no filters stays an approval", () => {
  // filteredOut: 0 must not be read as "filters emptied it" — a clean tree is a
  // real "approve, nothing to act on".
  const report = reviewReport({ review: null, files: [], isRepo: true, filteredOut: 0 }, "diff", false);
  assert.equal(report.kind, "verdict");
  assert.equal(report.exitCode, 0);
  assert.match(report.text, /^# revgate review: APPROVED$/m);
});

test("reviewReport: a failed untracked scan over an empty diff is exit 2, not an approval", () => {
  // The same inversion as filteredOut, from the other direction: `ls-files` failed,
  // so every new file is missing from the diff — and a turn whose whole output is
  // new files then looks exactly like a clean tree. APPROVED/0 there is a sign-off
  // on code nobody was shown.
  const report = reviewReport(
    {
      review: null,
      files: [],
      isRepo: true,
      untrackedScanFailed: true,
      note: "No changes to review.",
      scope: "working tree vs HEAD",
    },
    "diff",
    true,
  );
  assert.equal(report.kind, "scan-failed");
  assert.equal(report.exitCode, 2);
  assert.match(report.text, /^# revgate review: SCAN FAILED$/m);
  assert.doesNotMatch(report.text, /APPROVED/);
  assert.match(report.text, /^untracked-scan: failed$/m);
  // With -o <file> the report is all an agent reads, so it has to say so itself.
  assert.match(report.text, /not an approval/);
});

test("reviewReport: a verdict beats a failed untracked scan", () => {
  // Same rule as filteredOut and isRepo: a human who looked at the tracked files
  // and submitted still gets their decision reported, not overridden.
  const report = reviewReport(
    { review: review({ summary: "Fine." }), files, isRepo: true, untrackedScanFailed: true },
    "diff",
    false,
  );
  assert.equal(report.kind, "verdict");
  assert.equal(report.exitCode, 0);
  assert.doesNotMatch(report.text, /SCAN FAILED/);
  // But it is still said out loud. The verdict covers the files that reached the
  // diff; without this line an APPROVED report is indistinguishable from one over
  // a complete diff, and the agent has no way to learn its new files went unseen.
  assert.match(report.text, /^untracked-scan: failed$/m);
});

test("renderAnnotations: a clean scan adds no untracked-scan line", () => {
  // The negative half: this line means "something is missing", so it must never
  // appear on an ordinary review.
  assert.doesNotMatch(renderAnnotations(review({ summary: "Fine." }), files, {}), /untracked-scan/);
});

test("renderUntrackedScanFailed: carries the scope/branch header lines", () => {
  const text = renderUntrackedScanFailed({ scope: "working tree vs HEAD", branch: "feature" });
  assert.match(text, /^# revgate review: SCAN FAILED$/m);
  assert.match(text, /^scope: working tree vs HEAD$/m);
  assert.match(text, /^branch: feature$/m);
  assert.match(text, /^untracked-scan: failed$/m);
  assert.ok(text.endsWith("\n"));
});

test("reviewReport: a diff emptied by dropped paths is not an approval", () => {
  // The parser drops a file whose path carries a line break (it would splice
  // forged records into this very report). If it was the only change, the file
  // list is empty — and an empty file list otherwise reads as "nothing to
  // review, approve", a clean bill of health for code nobody saw.
  const report = reviewReport(
    {
      review: null,
      files: [],
      isRepo: true,
      droppedPaths: 1,
      note: "No changes to review.",
      scope: "working tree vs HEAD",
    },
    "diff",
    true,
  );
  assert.equal(report.kind, "dropped-paths");
  assert.equal(report.exitCode, 2);
  assert.match(report.text, /^# revgate review: PATHS DROPPED$/m);
  assert.doesNotMatch(report.text, /APPROVED/);
  assert.match(report.text, /^dropped-paths: 1$/m);
  assert.match(report.text, /not an approval/);
});

test("reviewReport: a dropped path alongside reviewed files is a header line, not a report", () => {
  // Something WAS reviewed here, so the verdict stands — the report just has to
  // say it does not cover everything that changed.
  const report = reviewReport(
    { review: review({ summary: "Fine." }), files, isRepo: true, droppedPaths: 1 },
    "diff",
    false,
  );
  assert.equal(report.kind, "verdict");
  assert.equal(report.exitCode, 0);
  assert.match(report.text, /^dropped-paths: 1$/m);
});

test("reviewReport: no dropped-paths line when nothing was dropped", () => {
  const report = reviewReport({ review: review({ summary: "Fine." }), files, isRepo: true }, "diff", false);
  assert.doesNotMatch(report.text, /dropped-paths/);
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
