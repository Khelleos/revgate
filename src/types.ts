/**
 * The JSON payload Copilot CLI pipes to a hook on stdin (for revgate, the
 * `preToolUse` plan gate). Copilot emits either a camelCase form or a VS
 * Code-compatible snake_case form; we normalize both into this shape (see
 * index.ts:readHookPayload). `revgate review` builds a synthetic one, since
 * the review pipeline is keyed on it.
 */
export interface HookPayload {
  sessionId: string;
  timestamp: number | string;
  cwd: string;
  /**
   * The tool Copilot is about to run, on a `preToolUse` hook. We only gate the
   * plan tool (`exit_plan_mode`) and pass every other tool straight through.
   */
  toolName?: string;
  /**
   * Plan markdown, when the hook fires on a plan-proposal event (e.g. an
   * ExitPlanMode-style tool call). Present => revgate reviews the plan instead
   * of a git diff. See index.ts:readHookPayload for the fields we accept.
   */
  plan?: string;
}

/**
 * A review's verdict in hook terms: "block" carries the reviewer's feedback as
 * `reason`. Internal only — never written to stdout as-is. The plan hook
 * translates it into a PermissionDecision (see below); `revgate review`
 * renders it as annotations.
 */
export interface HookDecision {
  /** "block" means changes were requested, with the feedback in `reason`. */
  decision: "block" | "allow";
  reason?: string;
}

/**
 * What a `preToolUse` hook writes to stdout to allow or veto the pending tool.
 * "deny" blocks the tool and feeds `permissionDecisionReason` back to the
 * agent; "allow" lets it run.
 */
export interface PermissionDecision {
  permissionDecision: "allow" | "deny" | "ask";
  permissionDecisionReason?: string;
}

/** "plan" lines belong to a synthetic plan document, not a git diff (see plan.ts). */
export type LineType = "add" | "del" | "context" | "plan";

export interface DiffLine {
  type: LineType;
  content: string;
  /** 1-based line number in the old file (null for added lines). */
  oldLine: number | null;
  /** 1-based line number in the new file (null for deleted lines). */
  newLine: number | null;
}

export interface DiffHunk {
  header: string;
  oldStart: number;
  newStart: number;
  lines: DiffLine[];
}

/**
 * Whether a file's changes are staged in git's index:
 * - "yes"      — fully staged (index matches the working tree)
 * - "partial"  — some changes staged, some still only in the working tree
 * - "no"       — nothing staged (or untracked)
 * - "unmerged" — a merge conflict: the index holds conflict stages, not a
 *   staged/unstaged split, so the toggle does not apply (see git.ts).
 */
export type StageState = "yes" | "partial" | "no" | "unmerged";

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

/**
 * A comment anchored to a line or a contiguous range of lines, GitHub-style.
 * A single-line comment has startLine === endLine.
 */
export interface LineComment {
  file: string;
  /** First line of the range (1-based, inclusive). */
  startLine: number;
  /** Last line of the range (1-based, inclusive). Equals startLine for a single line. */
  endLine: number;
  /** Which side of the diff the range belongs to. */
  side: "new" | "old";
  body: string;
}

/** The review the user submits from the web UI. */
export interface ReviewSubmission {
  decision: "approve" | "request_changes";
  summary: string;
  comments: LineComment[];
}
