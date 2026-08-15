// Every review that found something is archived as markdown under
// `<historyDir>/<repo-name>/<timestamp>.md`, so it survives a hook timeout, a
// closed terminal, or an agent that ignored the feedback. Nothing here throws.
import { mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { findRepoRoot } from "../git/exec.js";
import { log, warn } from "../shared/log.js";
import { renderAnnotations } from "../review/annotations.js";
import { hasFindings } from "../review/report.js";
import type { DiffFile, ReviewSubmission } from "../shared/types.js";

/** What `saveHistory` needs beyond the review itself. */
export interface HistoryMeta {
  /** Where the review ran; used to find the repository name. */
  cwd: string;
  /** Copilot's session id (or "cli" for a skill-driven review). */
  sessionId?: string;
  /** Human-readable scope label, e.g. `main..feature`. */
  scope?: string;
  branch?: string | null;
  mode?: "diff" | "plan";
  /** True when the untracked scan failed; the archive says so too. */
  untrackedScanFailed?: boolean;
  /** How many changed files were dropped for a line break in their path. */
  droppedPaths?: number;
  /** False when `--no-history` was passed. */
  enabled?: boolean;
  /** `--history-dir`; overrides the env var and the default location. */
  historyDir?: string;
  /** Injectable clock, so tests get a deterministic file name. */
  now?: Date;
}

/** `--history-dir` beats `$REVGATE_HISTORY_DIR`, which beats `~/.revgate/history`. */
export function historyRoot(explicit?: string): string {
  const dir = explicit?.trim() || process.env.REVGATE_HISTORY_DIR?.trim();
  if (dir) return path.resolve(dir);
  return path.join(os.homedir(), ".revgate", "history");
}

/** Reduce a repo name to one safe path segment, so a repo called `..` cannot climb out. */
export function sanitizeSegment(name: string): string {
  const cleaned = name
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^[-.]+/, "")
    .replace(/[-.]+$/, "");
  return cleaned || "no-repo";
}

/**
 * The git toplevel's basename, sanitized; `no-repo` outside a repository. Via
 * `findRepoRoot`, so `core.quotePath=false` applies and a non-ASCII repo name is
 * not archived under a C-quoted directory.
 */
export async function repoSegment(cwd: string): Promise<string> {
  const top = await findRepoRoot(cwd);
  return top ? sanitizeSegment(path.basename(top)) : "no-repo";
}

/** File name for a review taken at `now`: an ISO stamp with `:`/`.` made safe. */
export function timestampName(now: Date): string {
  return `${now.toISOString().replace(/[:.]/g, "-")}.md`;
}

/** The frontmatter facts for one archived review; the last two are as on `HistoryMeta`. */
export interface HistoryDocumentContext {
  date: Date;
  repo: string;
  sessionId?: string;
  scope?: string;
  branch?: string | null;
  mode?: "diff" | "plan";
  untrackedScanFailed?: boolean;
  droppedPaths?: number;
}

/**
 * Quote a frontmatter value so the block stays parseable YAML — a plan scope is
 * `plan: <title>`, and a title with its own colon would break the header.
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
  // Two reviews in one millisecond are far-fetched, but a collision would
  // silently overwrite the earlier one.
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

/** Persist a review that has something to act on, or return null. Never throws. */
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
