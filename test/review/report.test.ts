import assert from "node:assert/strict";
import test from "node:test";
import { hasFindings, reviewExitCode, reviewReport } from "../../src/review/report.js";
import { comment, files, review } from "../helpers/review.js";

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
