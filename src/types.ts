/**
 * The JSON payload Copilot CLI pipes to an `agentStop` hook on stdin.
 * Copilot emits either a camelCase form or a VS Code-compatible snake_case
 * form; we normalize both into this shape (see index.ts:readHookPayload).
 */
export interface HookPayload {
  sessionId: string;
  timestamp: number | string;
  cwd: string;
  transcriptPath?: string;
  stopReason?: string;
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
 * What the `agentStop` hook writes to stdout to steer Copilot's next move.
 * (The `preToolUse` plan hook uses PermissionDecision instead — see below.)
 */
export interface HookDecision {
  /** "block" forces another agent turn using `reason` as the prompt. */
  decision: "block" | "allow";
  reason?: string;
}

/**
 * What a `preToolUse` hook writes to stdout to allow or veto the pending tool.
 * Copilot's contract differs from `agentStop`: "deny" blocks the tool and feeds
 * `permissionDecisionReason` back to the agent; "allow" lets it run.
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
 * - "yes"     — fully staged (index matches the working tree)
 * - "partial" — some changes staged, some still only in the working tree
 * - "no"      — nothing staged (or untracked)
 */
export type StageState = "yes" | "partial" | "no";

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
