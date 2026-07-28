/**
 * Review history: every review that found something is written to disk as
 * markdown, so a review survives a hook timeout, a closed terminal, or an agent
 * that ignored the feedback.
 *
 * Layout mirrors revdiff: `<historyDir>/<repo-name>/<timestamp>.md`, where
 * `historyDir` is `--history-dir`, else `$REVGATE_HISTORY_DIR`, else
 * `~/.revgate/history`. The body is the same annotation format the `review`
 * command prints (see output.ts), prefixed with YAML frontmatter recording the
 * scope, branch, session and timestamp — frontmatter can't collide with the
 * `##` records below it.
 *
 * Nothing here is allowed to fail a review: a read-only home directory must
 * never wedge a gate, so every error path warns to stderr and returns null.
 */
import { mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { findRepoRoot } from "./git.js";
import { log, warn } from "./log.js";
import { hasFindings, renderAnnotations } from "./output.js";
import type { DiffFile, ReviewSubmission } from "./types.js";

export interface HistoryMeta {
  /** Where the review ran — used to find the repository name. */
  cwd: string;
  /** Copilot's session id (or "cli" for a skill-driven review). */
  sessionId?: string;
  /** Human-readable scope label, e.g. `main..feature`. */
  scope?: string;
  branch?: string | null;
  mode?: "diff" | "plan";
  /**
   * True when listing untracked files failed, so new files are missing from the
   * reviewed diff. The archived copy has to carry it for the same reason the
   * live report does: history is where a review whose output was lost gets
   * re-read, and a copy without this line reads as a complete review of the turn.
   */
  untrackedScanFailed?: boolean;
  /**
   * How many changed files were dropped for carrying a line break in their path.
   * Archived for the same reason as `untrackedScanFailed`: a copy that omits the
   * `dropped-paths:` line reads as a complete review of the turn.
   */
  droppedPaths?: number;
  /** False when `--no-history` was passed. */
  enabled?: boolean;
  /** `--history-dir`; overrides the env var and the default location. */
  historyDir?: string;
  /** Injectable clock, so tests get a deterministic file name. */
  now?: Date;
}

/**
 * Where history lives: `--history-dir` beats `$REVGATE_HISTORY_DIR`, which
 * beats `~/.revgate/history`.
 */
export function historyRoot(explicit?: string): string {
  const dir = explicit?.trim() || process.env.REVGATE_HISTORY_DIR?.trim();
  if (dir) return path.resolve(dir);
  return path.join(os.homedir(), ".revgate", "history");
}

/**
 * Reduce a repository name to one safe path segment. Anything that isn't
 * `[A-Za-z0-9._-]` collapses to a dash, and leading/trailing dots go too — so a
 * repo called `..` can never climb out of the history directory.
 */
export function sanitizeSegment(name: string): string {
  const cleaned = name
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^[-.]+/, "")
    .replace(/[-.]+$/, "");
  return cleaned || "no-repo";
}

/**
 * The git toplevel's basename, sanitized; `no-repo` outside a repository.
 *
 * Goes through git.ts's `findRepoRoot` rather than running its own `rev-parse`,
 * so the `core.quotePath=false` hardening centralised there applies here too — a
 * repository whose name has a non-ASCII byte would otherwise arrive C-quoted
 * (`"caf\303\251"`) and be archived under a mangled directory.
 */
export async function repoSegment(cwd: string): Promise<string> {
  const top = await findRepoRoot(cwd);
  return top ? sanitizeSegment(path.basename(top)) : "no-repo";
}

/** File name for a review taken at `now`: an ISO stamp with `:`/`.` made safe. */
export function timestampName(now: Date): string {
  return `${now.toISOString().replace(/[:.]/g, "-")}.md`;
}

export interface HistoryDocumentContext {
  date: Date;
  repo: string;
  sessionId?: string;
  scope?: string;
  branch?: string | null;
  mode?: "diff" | "plan";
  /** See the same field on `HistoryMeta`. */
  untrackedScanFailed?: boolean;
  /** See the same field on `HistoryMeta`. */
  droppedPaths?: number;
}

/**
 * Quote a frontmatter value so the block stays parseable YAML.
 *
 * Scope labels are the reason this exists: a plan review's scope is
 * `plan: <the plan's own title>`, and a title like "Fix: the parser" would
 * otherwise emit `scope: plan: Fix: the parser` — a YAML syntax error that
 * corrupts the whole header. JSON string syntax is valid YAML double-quoted
 * scalar syntax, so JSON.stringify is exactly the escaping needed.
 */
function yamlValue(value: string): string {
  return JSON.stringify(value);
}

/** The full markdown document: frontmatter header + the annotation records. */
export function renderHistoryDocument(
  review: ReviewSubmission,
  files: DiffFile[],
  ctx: HistoryDocumentContext,
): string {
  const front = ["---", `date: ${ctx.date.toISOString()}`, `repo: ${yamlValue(ctx.repo)}`];
  front.push(`mode: ${ctx.mode ?? "diff"}`);
  if (ctx.sessionId) front.push(`session: ${yamlValue(ctx.sessionId)}`);
  if (ctx.scope) front.push(`scope: ${yamlValue(ctx.scope)}`);
  if (ctx.branch) front.push(`branch: ${yamlValue(ctx.branch)}`);
  front.push("---", "");

  return (
    front.join("\n") +
    "\n" +
    renderAnnotations(review, files, {
      mode: ctx.mode,
      scope: ctx.scope,
      branch: ctx.branch,
      untrackedScanFailed: ctx.untrackedScanFailed,
      droppedPaths: ctx.droppedPaths,
    })
  );
}

/** Write `content` under a name that isn't taken yet, and return the path. */
async function writeUnique(dir: string, name: string, content: string): Promise<string> {
  const ext = path.extname(name);
  const stem = name.slice(0, name.length - ext.length);
  // Two reviews inside the same millisecond are far-fetched, but a collision
  // would silently overwrite the earlier one — cheap to rule out.
  for (let i = 0; i < 100; i++) {
    const dest = path.join(dir, i === 0 ? name : `${stem}-${i}${ext}`);
    try {
      await writeFile(dest, content, { encoding: "utf8", flag: "wx" });
      return dest;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    }
  }
  throw new Error(`could not find a free history file name in ${dir}`);
}

/**
 * Persist a submitted review, returning the file written or null if nothing was.
 *
 * Only reviews with something to act on are saved — an approval with no comments
 * would just be noise. Never throws.
 */
export async function saveHistory(
  review: ReviewSubmission,
  files: DiffFile[],
  meta: HistoryMeta,
): Promise<string | null> {
  if (meta.enabled === false) return null;

  try {
    // Inside the try: a malformed submission must not turn "could not archive
    // this review" into a thrown error the caller reads as "no review at all".
    if (!hasFindings(review)) return null;

    const date = meta.now ?? new Date();
    const repo = await repoSegment(meta.cwd);
    const dir = path.join(historyRoot(meta.historyDir), repo);
    await mkdir(dir, { recursive: true });

    const content = renderHistoryDocument(review, files, {
      date,
      repo,
      sessionId: meta.sessionId,
      scope: meta.scope,
      branch: meta.branch,
      mode: meta.mode,
      untrackedScanFailed: meta.untrackedScanFailed,
      droppedPaths: meta.droppedPaths,
    });
    const dest = await writeUnique(dir, timestampName(date), content);
    log(`review saved to ${dest}`);
    return dest;
  } catch (err) {
    // History is a convenience; losing it must never cost the caller a review.
    warn(`could not save review history: ${(err as Error).message}`);
    return null;
  }
}
