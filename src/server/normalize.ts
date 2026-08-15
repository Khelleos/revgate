import { warn } from "../shared/log.js";
import type { LineComment, ReviewSubmission } from "../shared/types.js";

/**
 * Coerce one posted entry into a well-formed LineComment, or null. Downstream
 * reads the fields unchecked, and a throw there reports the review as approved.
 */
export function normalizeComment(entry: unknown, known: Set<string>): LineComment | null {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return null;
  const o = entry as Record<string, unknown>;
  // A comment with no file has nowhere to point.
  if (typeof o.file !== "string" || !o.file) return null;
  // Only a file in this review: an arbitrary path splices a phantom record into
  // the annotations and the feedback prompt.
  if (!known.has(o.file)) {
    warn(`dropped a comment on a file outside this review: ${JSON.stringify(o.file)}`);
    return null;
  }

  // 0 is the file-level sentinel: an unusable number degrades, never drops.
  const start = Number(o.startLine);
  const startLine = Number.isInteger(start) && start >= 1 ? start : 0;
  const end = Number(o.endLine);
  // endLine follows it, or the renderers disagree about which one applies.
  const endLine = startLine === 0 ? 0 : Number.isInteger(end) && end >= startLine ? end : startLine;

  return {
    file: o.file,
    startLine,
    endLine,
    side: o.side === "old" ? "old" : "new",
    body: typeof o.body === "string" ? o.body : "",
  };
}

/** Coerce a posted body into a ReviewSubmission, or null. The only entry point a verdict passes. */
export function normalizeSubmission(body: unknown, known: Set<string>): ReviewSubmission | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const o = body as Record<string, unknown>;
  if (o.decision !== "approve" && o.decision !== "request_changes") return null;

  const comments = Array.isArray(o.comments)
    ? o.comments
        .map((entry) => normalizeComment(entry, known))
        .filter((c): c is LineComment => c !== null)
    : [];
  return {
    decision: o.decision,
    summary: typeof o.summary === "string" ? o.summary : "",
    comments,
  };
}
