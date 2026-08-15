import type { DiffFile, LineComment, ReviewSubmission } from "../../src/shared/types.js";

/** A changed file with no hunks — enough for renderers that only count files. */
export const file = (path: string): DiffFile => ({
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

/** The two-file fixture the annotation and report tests share. */
export const files: DiffFile[] = [file("src/app.ts"), file("other.ts")];

/** A line comment on `src/app.ts:2`, with any field overridden. */
export const comment = (over: Partial<LineComment> = {}): LineComment => ({
  file: "src/app.ts",
  startLine: 2,
  endLine: 2,
  side: "new",
  body: "Use const.",
  ...over,
});

/** A request-changes submission with no summary and no comments, overridable. */
export const review = (over: Partial<ReviewSubmission> = {}): ReviewSubmission => ({
  decision: "request_changes",
  summary: "",
  comments: [],
  ...over,
});
