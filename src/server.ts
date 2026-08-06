import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { log, warn } from "./log.js";
import { getStageStates, setStaged } from "./git.js";
import { isKnownThemeId, listThemes, writeThemeConfig } from "./theme.js";
import type { DiffFile, HookPayload, LineComment, ReviewSubmission, StageState } from "./types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// public/ sits next to dist/ at the package root, so go up one from dist/.
const PUBLIC_DIR = path.resolve(__dirname, "..", "public");

export interface ReviewContext {
  payload: HookPayload;
  branch: string | null;
  files: DiffFile[];
  isRepo: boolean;
  /**
   * Whether the stage/unstage toggle applies to what is being reviewed.
   *
   * Staging acts on the *working tree*, so it only lines up with a worktree or
   * staged scope. In a ref/range review the reviewed content came from commits
   * and the index has no bearing on it: the toggle would report a state that
   * says nothing about the diff on screen, and clicking it would `git add` a
   * working-tree copy the reviewer never saw. Off by default so a context built
   * by hand can never opt in by accident.
   */
  canStage?: boolean;
  /** "diff" reviews the working tree; "plan" reviews a proposed plan document. */
  mode: "diff" | "plan";
  /** Short heading for a plan review (mode === "plan" only). */
  planTitle?: string;
  /** What was diffed, e.g. `main..feature` (mode === "diff" only). */
  scope?: string;
  note?: string;
  /**
   * Something is wrong with the diff on screen that changes what approving it
   * means — currently only "the untracked scan failed, so new files are
   * missing". Rendered as a banner above the file list: the reviewer is looking
   * at the page, not at the caller's stderr, and a diff that silently omits
   * files still looks complete.
   */
  warning?: string;
}

export interface ServerHandle {
  url: string;
  /** Resolves when the user submits a review, or rejects if the server closes first. */
  waitForSubmission: Promise<ReviewSubmission>;
  close: () => void;
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
};

function json(res: ServerResponse, status: number, body: unknown): void {
  const s = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(s);
}

/**
 * Cap on a request body. A review's comments are prose typed by a human; 4 MB is
 * orders of magnitude past anything the page sends.
 */
const MAX_BODY_BYTES = 4 * 1024 * 1024;

/** Raised by `readBody` when a request body runs past `MAX_BODY_BYTES`. */
class BodyTooLarge extends Error {}

/**
 * Read a request body into a string, refusing one that is too big.
 *
 * The Origin guard keeps a web page from reaching these routes at all, but a
 * local non-browser client is not covered by it — and this process is a blocking
 * hook, so buffering an unbounded body until the heap gives out does not just
 * lose a review, it stalls the agent's turn until the hook timeout.
 *
 * Past the cap the rest is drained and discarded rather than the request being
 * destroyed. Memory is bounded either way, but tearing the socket down mid-upload
 * reaches the client as a connection reset — the 413 saying *why* never arrives,
 * and the page's own error handling has nothing to show the reviewer.
 */
async function readBody(req: IncomingMessage): Promise<string> {
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
 * Coerce one posted entry into a well-formed LineComment, or null if it can't be
 * one.
 *
 * Being an object is not enough: every downstream consumer reads the *fields*
 * without checking them — `c.body.trim()` in the prompt renderer, `c.file` as a
 * Map key in the grouper, `c.startLine` in the annotation header. A comment
 * missing `body` throws in there, inside the fail-open handler, which reports
 * the whole review as an approval. Fill in every field here instead.
 */
function normalizeComment(entry: unknown, known: Set<string>): LineComment | null {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return null;
  const o = entry as Record<string, unknown>;
  // A comment with no file has nowhere to point; there is nothing to salvage.
  if (typeof o.file !== "string" || !o.file) return null;
  // The UI only ever anchors a comment to a file in this review, and everything
  // downstream is line-oriented: the annotation renderer writes `## <file>:<line>`
  // and the feedback prompt `### <file>`. An arbitrary path — one carrying a
  // newline above all — would splice a phantom record into both, so the agent
  // reads a directive against a file nobody commented on. `/api/stage` already
  // refuses paths outside this set; a verdict may not be laxer.
  if (!known.has(o.file)) {
    warn(`dropped a comment on a file outside this review: ${JSON.stringify(o.file)}`);
    return null;
  }

  // 0 is the file-level sentinel the annotation renderer already understands,
  // so an unusable line number degrades to "about the whole file" rather than
  // being dropped — a comment the reviewer wrote must survive.
  const start = Number(o.startLine);
  const startLine = Number.isInteger(start) && start >= 1 ? start : 0;
  const end = Number(o.endLine);
  // Once startLine has degraded to the file-level sentinel, endLine must follow
  // it: the annotation renderer keys "whole file" off startLine < 1, while the
  // feedback renderer keys "is a range" off endLine > startLine. Leaving a live
  // endLine behind makes the two disagree — one says "whole file", the other
  // quotes lines 1-N back to the agent as a range the reviewer never selected.
  const endLine = startLine === 0 ? 0 : Number.isInteger(end) && end >= startLine ? end : startLine;

  return {
    file: o.file,
    startLine,
    endLine,
    side: o.side === "old" ? "old" : "new",
    body: typeof o.body === "string" ? o.body : "",
  };
}

/**
 * Coerce a posted body into a well-formed ReviewSubmission, or null if it isn't
 * one at all.
 *
 * Everything downstream — the feedback prompt, the annotation renderer, the
 * history writer — assumes `summary` is a string and `comments` an array of
 * fully-populated comments. A body missing any of it used to throw deep inside
 * those callers, where the fail-open handler would swallow it and report an
 * *approval* — the exact inversion of a request-changes verdict. Normalize here
 * instead, at the only entry point.
 */
function normalizeSubmission(body: unknown, known: Set<string>): ReviewSubmission | null {
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

/**
 * Whether `authority` (a `host:port` or a full origin URL) names our own
 * loopback listener. `undefined` passes, which only the Host caller relies on: a
 * request with no Host at all is a non-browser client (HTTP/1.0, curl), which
 * cannot mount the rebinding attack. The POST caller requires Origin to be
 * *present* before asking this — see the call site.
 *
 * Both guards ask the same question of two different headers, so they share one
 * answer — a change to the loopback allow-list cannot land on the read path and
 * be forgotten on the write path:
 *
 * - `Host` guards reads. `GET /api/review` hands out the entire reviewed diff,
 *   and a page on any origin whose DNS is rebound to 127.0.0.1 can scan loopback
 *   ports and read it as same-origin — the browser believes it *is* the same
 *   origin, so no CORS rule applies. A rebound request still carries the
 *   attacker's hostname, which is what they cannot forge away.
 * - `Origin` guards writes. The random port is obscurity, not a boundary: any
 *   page the user has open can brute-force 64k ports and POST a forged approval
 *   to `/api/submit`, or drive `git add` through `/api/stage`. A fetch from our
 *   own page carries our origin.
 */
function isLoopbackAuthority(authority: string | undefined, port: number): boolean {
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

/**
 * Run `task` after every previously queued one, never concurrently.
 *
 * The stage routes mutate the git index, and git guards it with `.git/index.lock`
 * — a second `git add`/`git reset` running against the same repository fails
 * outright rather than waiting. The reviewer can easily have several in flight
 * (ticking file checkboxes as fast as they read), and a failed write now surfaces
 * as a 500 the page shows, so the honest fix is not to overlap them. The
 * `getStageStates` read is inside the same critical section: a snapshot taken
 * between another request's read and its write describes neither.
 */
let indexQueue: Promise<unknown> = Promise.resolve();

function serializeIndexWork<T>(task: () => Promise<T>): Promise<T> {
  // Chained off a swallowed copy, so one rejection cannot poison the queue.
  const run = indexQueue.then(task, task);
  indexQueue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

export async function startReviewServer(ctx: ReviewContext): Promise<ServerHandle> {
  let resolveSubmission!: (r: ReviewSubmission) => void;
  let rejectSubmission!: (e: Error) => void;
  const waitForSubmission = new Promise<ReviewSubmission>((resolve, reject) => {
    resolveSubmission = resolve;
    rejectSubmission = reject;
  });

  // Set once the listener is bound; every request is served after that.
  let port = 0;

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      const pathname = url.pathname;

      // On every response, before any of it is written: the Origin guard below
      // rejects a cross-origin POST, but it cannot see a click. A hostile page
      // that brute-forces the port — which the Origin comment already concedes is
      // feasible — can iframe this UI and float its own content over the Approve
      // button, and the resulting submission is genuinely same-origin, so both
      // guards pass and a forged approval resolves the gate. Refusing to be framed
      // is the only thing that closes that path. `frame-ancestors` covers modern
      // browsers, `X-Frame-Options` the ones that ignore it; both are scoped to
      // framing only, so the page's own inline scripts and styles still run.
      res.setHeader("content-security-policy", "frame-ancestors 'none'");
      res.setHeader("x-frame-options", "DENY");

      // Before routing anything, on every method: reads leak the diff just as
      // surely as writes forge a verdict.
      if (!isLoopbackAuthority(req.headers.host, port)) {
        warn(`rejected request to ${pathname} for host ${req.headers.host}`);
        json(res, 403, { error: "unexpected host" });
        return;
      }

      // Guard every mutating route in one place, before any of them run. A missing
      // Origin is rejected rather than waved through the way a missing Host is: a
      // cross-site `<form method="POST" enctype="text/plain">` needs no Origin to
      // reach us, can shape its body into valid JSON via the field name, and
      // carries the genuine loopback Host — so the Host guard above cannot see it.
      // That is a forged human verdict, the one thing this gate exists to require.
      // Our own page uses `fetch`, which always sends Origin on a POST, so nothing
      // legitimate depends on the escape.
      if (
        req.method === "POST" &&
        (req.headers.origin === undefined || !isLoopbackAuthority(req.headers.origin, port))
      ) {
        warn(`rejected cross-origin POST to ${pathname} from ${req.headers.origin ?? "no origin"}`);
        json(res, 403, { error: "cross-origin request rejected" });
        return;
      }

      if (pathname === "/api/review" && req.method === "GET") {
        json(res, 200, ctx);
        return;
      }

      // Every palette in one response, not one fetch per theme: switching then
      // costs nothing but a repaint, and a page that has already loaded can
      // never end up half-themed because a second round trip failed.
      if (pathname === "/api/themes" && req.method === "GET") {
        json(res, 200, await listThemes());
        return;
      }

      if (pathname === "/api/theme" && req.method === "POST") {
        const raw = await readBody(req);
        let parsed: unknown;
        try {
          parsed = JSON.parse(raw);
        } catch {
          json(res, 400, { error: "invalid JSON" });
          return;
        }
        // Reading the field is kept out of the try: `null`, a bare string and an
        // array are all valid JSON, and reaching for `.id` on them throws — which
        // inside the catch would report the body as unparseable when the real
        // answer is that it carries no theme.
        const id = (parsed as { id?: unknown } | null)?.id;
        // Set membership is the entire validation surface, and deliberately so:
        // every palette is a literal compiled into the build, so the id is the
        // only user-supplied value in the feature. Writing an unknown one would
        // not break anything today — the read path falls back to `system` — but
        // the user would silently get a theme they did not pick.
        if (!isKnownThemeId(id)) {
          json(res, 400, { error: "unknown theme" });
          return;
        }
        // A write that fails is reported to stderr by writeThemeConfig and no
        // further: the page has already applied the palette, and answering an
        // error here would have it undo a change the user can plainly see. A
        // cosmetic subsystem may never wedge — or visibly fight — the gate.
        await writeThemeConfig(id);
        json(res, 200, { ok: true });
        return;
      }

      if ((pathname === "/api/stage" || pathname === "/api/unstage") && req.method === "POST") {
        if (!ctx.isRepo) {
          json(res, 409, { error: "not a git repository" });
          return;
        }
        // The UI hides the toggle outside a worktree/staged scope, but the route
        // is reachable regardless — and `git add` here would stage a working-tree
        // change that is not part of the reviewed range, while the unstage
        // direction would drop the user's real staged work.
        if (!ctx.canStage) {
          json(res, 409, { error: "staging does not apply to this review scope" });
          return;
        }
        const raw = await readBody(req);
        let file: string;
        try {
          file = String((JSON.parse(raw) as { file?: unknown }).file ?? "");
        } catch {
          json(res, 400, { error: "invalid JSON" });
          return;
        }
        if (!file) {
          json(res, 400, { error: "missing file" });
          return;
        }
        // `--` stops git reading the argument as a flag or a ref, but it does
        // NOT disable pathspec magic: `:/` matches the whole repository, and
        // `:(exclude)`/`:(glob)` reach outside the reviewed set — so a POST of
        // `{"file": ":/"}` would `git add` everything. The UI only ever sends a
        // path from this review, so accept nothing else.
        if (!ctx.files.some((f) => f.path === file)) {
          json(res, 400, { error: "unknown file" });
          return;
        }
        const stage = pathname === "/api/stage";
        // The read and the write are one critical section, queued behind every
        // other index request — see `serializeIndexWork`. Responding is left to
        // the caller so nothing writes to `res` from inside the queue.
        const result = await serializeIndexWork<{ status: number; body: unknown }>(async () => {
          // A conflicted path has no staged/unstaged split to toggle: its index
          // entry holds conflict stages 1/2/3, and `git reset -- <path>` would
          // drop them. Status then flips from `UU` to ` M` while MERGE_HEAD and
          // the conflict markers remain, so the conflict looks resolved and the
          // next commit records the markers as the resolution.
          const before = await getStageStates(ctx.payload.cwd);
          if (before[file] === "unmerged") {
            return {
              status: 409,
              body: { error: "unmerged path — resolve the conflict in git first", states: before },
            };
          }
          let states: Record<string, StageState>;
          try {
            states = await setStaged(ctx.payload.cwd, file, stage);
          } catch (err) {
            // Answer JSON, not the outer handler's plain-text 500: the page does
            // `await res.json()` before checking `res.ok`, so a text body throws
            // and lands in its silent catch — the reviewer would see the checkbox
            // revert with no explanation. `before` is the accurate state now that
            // the write failed, so it snaps the checkbox back correctly.
            warn(`stage request failed: ${(err as Error).message}`);
            return { status: 500, body: { error: (err as Error).message, states: before } };
          }
          return { status: 200, body: { states } };
        });
        if (result.status === 200) log(`${stage ? "staged" : "unstaged"} ${file}`);
        json(res, result.status, result.body);
        return;
      }

      if (pathname === "/api/submit" && req.method === "POST") {
        const raw = await readBody(req);
        let parsed: unknown;
        try {
          parsed = JSON.parse(raw);
        } catch {
          json(res, 400, { error: "invalid JSON" });
          return;
        }
        const submission = normalizeSubmission(parsed, new Set(ctx.files.map((f) => f.path)));
        if (!submission) {
          // Rejecting keeps the review pending, which is right: a dropped
          // verdict must not resolve the gate as an approval.
          json(res, 400, { error: "expected { decision: 'approve' | 'request_changes', … }" });
          return;
        }
        json(res, 200, { ok: true });
        log(`review submitted: ${submission.decision} (${submission.comments.length} comments)`);
        resolveSubmission(submission);
        return;
      }

      // Static files from public/.
      let file = pathname === "/" ? "/index.html" : pathname;
      const abs = path.join(PUBLIC_DIR, path.normalize(file));
      if (!abs.startsWith(PUBLIC_DIR)) {
        res.writeHead(403).end("forbidden");
        return;
      }
      try {
        const data = await readFile(abs);
        const ext = path.extname(abs);
        res.writeHead(200, { "content-type": MIME[ext] ?? "application/octet-stream" });
        res.end(data);
      } catch {
        res.writeHead(404).end("not found");
      }
    } catch (err) {
      // Answered here rather than at each POST route so no body-reading route
      // can be added later and miss it. JSON, not the plain-text 500 below: the
      // page does `await res.json()` before checking `res.ok`, and a text body
      // throws inside its own catch — the reviewer would see the action fail
      // with no explanation. A rejected /api/submit stays pending, which is
      // right: a dropped verdict must not resolve the gate as an approval.
      if (err instanceof BodyTooLarge) {
        warn(`rejected oversized request to ${req.url}: ${err.message}`);
        try {
          json(res, 413, { error: "request body too large" });
        } catch {
          /* headers already sent */
        }
        return;
      }
      warn(`request error: ${(err as Error).message}`);
      try {
        res.writeHead(500).end("internal error");
      } catch {
        /* headers already sent */
      }
    }
  });

  // An `error` event with no listener is re-thrown by the EventEmitter on a
  // later tick, which surfaces as an uncaughtException — outside main()'s catch,
  // so the hook paths would exit non-zero and fail *closed*. Bind the failure to
  // this promise instead, where the caller's own error handling can see it.
  await new Promise<void>((resolve, reject) => {
    const onError = (err: Error) => reject(new Error(`could not start review server: ${err.message}`));
    server.once("error", onError);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", onError);
      resolve();
    });
  });
  const addr = server.address() as AddressInfo;
  port = addr.port;
  const url = `http://127.0.0.1:${port}/`;

  // Past listen, an error is not fatal to the review: keep a listener attached
  // so a stray socket error can never become an uncaughtException.
  server.on("error", (err) => warn(`review server error: ${err.message}`));

  server.on("close", () => {
    rejectSubmission(new Error("server closed before submission"));
  });

  return {
    url,
    waitForSubmission,
    close: () => {
      // `close()` alone stops accepting new connections but waits on established
      // ones, and the reviewer's browser holds a keep-alive socket open for the
      // agent's whole turn. On Node 18.x that idle socket keeps the `close` event
      // — and the process — waiting for `keepAliveTimeout` (5 s) after the
      // verdict, which on a hook path is 5 s the agent spends blocked on nothing.
      // Optional call because `closeAllConnections` landed in 18.2, and `engines`
      // allows 18.0.
      server.closeAllConnections?.();
      server.close();
    },
  };
}
