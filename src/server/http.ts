import type { IncomingMessage, ServerResponse } from "node:http";

/** Content types for everything `public/` holds; anything else is served as bytes. */
export const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
};

/** Answer with a JSON body and a status. */
export function json(res: ServerResponse, status: number, body: unknown): void {
  const s = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(s);
}

/** Refuse to be framed: a framed UI turns a stray click into a guard-passing approval. */
export function setFrameHeaders(res: ServerResponse): void {
  res.setHeader("content-security-policy", "frame-ancestors 'none'");
  res.setHeader("x-frame-options", "DENY");
}

/** Cap on a request body; a review's comments are prose typed by a human. */
const MAX_BODY_BYTES = 4 * 1024 * 1024;

/** Raised by `readBody` past `MAX_BODY_BYTES`. */
export class BodyTooLarge extends Error {}

/** Read a request body, draining rather than destroying past the cap so the 413 arrives. */
export async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  let tooLarge = false;
  for await (const c of req) {
    const chunk = c as Buffer;
    size += chunk.length;
    if (tooLarge) continue;
    if (size > MAX_BODY_BYTES) {
      tooLarge = true;
      chunks.length = 0;
      continue;
    }
    chunks.push(chunk);
  }
  if (tooLarge) throw new BodyTooLarge(`request body exceeds ${MAX_BODY_BYTES} bytes`);
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * Whether `authority` (a `host:port` or an origin URL) names our own loopback
 * listener. One answer for the Host and Origin guards alike, so they cannot
 * drift; see the trust-boundary rule in agents.md.
 */
export function isLoopbackAuthority(authority: string | undefined, port: number): boolean {
  if (authority === undefined) return true;
  try {
    // A bare `host:port` is not a URL; a full origin already carries its scheme.
    const u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(authority) ? authority : `http://${authority}`);
    const name = u.hostname.replace(/^\[|\]$/g, "");
    return (
      Number(u.port) === port && (name === "127.0.0.1" || name === "localhost" || name === "::1")
    );
  } catch {
    return false;
  }
}
