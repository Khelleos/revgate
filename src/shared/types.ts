/** The payload Copilot pipes to a hook on stdin; `readHookPayload` normalizes both known forms. */
export interface HookPayload {
  sessionId: string;
  timestamp: number | string;
  cwd: string;
  /** The tool about to run. Only `exit_plan_mode` is gated. */
  toolName?: string;
  /** Plan markdown. Present => review the plan instead of a git diff. */
  plan?: string;
}

/** A review's verdict in hook terms; "block" carries the feedback in `reason`. Internal only. */
export interface HookDecision {
  decision: "block" | "allow";
  reason?: string;
}

/** What a `preToolUse` hook writes to stdout. Copilot also accepts "ask"; revgate never emits it. */
export interface PermissionDecision {
  permissionDecision: "allow" | "deny";
  permissionDecisionReason?: string;
}

/** "plan" lines belong to a synthetic plan document, not a git diff. */
export type LineType = "add" | "del" | "context" | "plan";

/** One line of a hunk. The numbers are 1-based, and null where the line does not exist. */
export interface DiffLine {
  type: LineType;
  content: string;
  oldLine: number | null;
  newLine: number | null;
}

/** One `@@` hunk of a file's diff. */
export interface DiffHunk {
  header: string;
  oldStart: number;
  newStart: number;
  lines: DiffLine[];
}

/** Staged in full, in part, not at all (or untracked), or conflicted — which has no toggle. */
export type StageState = "yes" | "partial" | "no" | "unmerged";

/** One changed file, as the parser produces it and the UI renders it. */
export interface DiffFile {
  oldPath: string;
  newPath: string;
  /** Display path, prefers the new path. */
  path: string;
  isNew: boolean;
  isDeleted: boolean;
  isRenamed: boolean;
  isBinary: boolean;
  additions: number;
  deletions: number;
  hunks: DiffHunk[];
  /** Index/staging state; absent when the cwd isn't a git repo. */
  staged?: StageState;
}

/** A comment anchored to a line or a contiguous range of lines, GitHub-style. */
export interface LineComment {
  file: string;
  /** 1-based inclusive range; 0 on both means the whole file. */
  startLine: number;
  endLine: number;
  side: "new" | "old";
  body: string;
}

/** The review the user submits from the web UI. */
export interface ReviewSubmission {
  decision: "approve" | "request_changes";
  summary: string;
  comments: LineComment[];
}
