import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { log, warn } from "../shared/log.js";
import { getStageStates, setStaged } from "../git/staging.js";
import { isKnownThemeId } from "../store/palettes.js";
import { listThemes, writeThemeConfig } from "../store/theme-config.js";
import {
  BodyTooLarge,
  isLoopbackAuthority,
  json,
  MIME,
  readBody,
  setFrameHeaders,
} from "./http.js";
import { normalizeSubmission } from "./normalize.js";
import type { DiffFile, HookPayload, ReviewSubmission, StageState } from "../shared/types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// public/ sits next to dist/ at the package root, and the compiled file is
// dist/server/index.js — one level deeper than dist/, hence two steps up.
export const PUBLIC_DIR = path.resolve(__dirname, "..", "..", "public");

/** Everything the review page renders, served as-is by `GET /api/review`. */
export interface ReviewContext {
  payload: HookPayload;
  branch: string | null;
  files: DiffFile[];
  isRepo: boolean;
  /** Whether the stage toggle applies. Off by default, so nothing opts in by accident. */
  canStage?: boolean;
  /** "diff" reviews the working tree; "plan" reviews a proposed plan document. */
  mode: "diff" | "plan";
  /** Short heading for a plan review (mode === "plan" only). */
  planTitle?: string;
  /** What was diffed, e.g. `main..feature` (mode === "diff" only). */
  scope?: string;
  note?: string;
  /** Something on screen changes what approving means. Rendered as a banner. */
  warning?: string;
}

/** A running review server and the verdict it is waiting for. */
export interface ServerHandle {
  url: string;
  /** Resolves when the user submits a review, or rejects if the server closes first. */
  waitForSubmission: Promise<ReviewSubmission>;
  close: () => void;
}

/**
 * One queue per process for index work: `.git/index.lock` makes a concurrent
 * `git add`/`reset` fail outright, and a mid-write snapshot describes neither state.
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

/** Bind the review UI on a random loopback port and serve it until `close()`. */
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

      setFrameHeaders(res);

      // Both guards run before routing, so a new route inherits them. A missing
      // Origin is rejected, not waved through: a cross-site form POST carries
      // none, and a genuine loopback Host. See agents.md.
      if (!isLoopbackAuthority(req.headers.host, port)) {
        warn(`rejected request to ${pathname} for host ${req.headers.host}`);
        json(res, 403, { error: "unexpected host" });
        return;
      }
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

      // Every palette at once, so a loaded page cannot end up half-themed.
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
        // Outside the try: `.id` on a valid-JSON `null` throws, and that is not
        // an unparseable body.
        const id = (parsed as { id?: unknown } | null)?.id;
        // Set membership is the whole surface: the id is the only user value here.
        if (!isKnownThemeId(id)) {
          json(res, 400, { error: "unknown theme" });
          return;
        }
        // A failed write goes to stderr only: the page has already applied the
        // palette, and an error would make it undo a visible change.
        await writeThemeConfig(id);
        json(res, 200, { ok: true });
        return;
      }

      if ((pathname === "/api/stage" || pathname === "/api/unstage") && req.method === "POST") {
        if (!ctx.isRepo) {
          json(res, 409, { error: "not a git repository" });
          return;
        }
        // The route is reachable even where the UI hides the toggle, and staging
        // there would touch content outside the reviewed range.
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
        // `--` stops a flag or a ref, but not pathspec magic: `:/` matches the
        // whole repository. Accept only a path from this review.
        if (!ctx.files.some((f) => f.path === file)) {
          json(res, 400, { error: "unknown file" });
          return;
        }
        const stage = pathname === "/api/stage";
        // Read and write are one critical section; nothing writes `res` inside it.
        const result = await serializeIndexWork<{ status: number; body: unknown }>(async () => {
          // A conflict has no split to toggle, and unstaging drops its stages.
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
            // JSON, not the outer plain-text 500: the page calls `res.json()`
            // before `res.ok`. `before` snaps the checkbox back correctly.
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
          // Keeps the review pending: a dropped verdict is not an approval.
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
      // Here rather than per route, so a later one cannot miss it.
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

  // An unlistened `error` becomes an uncaughtException outside main()'s catch,
  // so the hook paths would exit non-zero and fail *closed*.
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

  // Past listen an error is survivable, but never an uncaughtException.
  server.on("error", (err) => warn(`review server error: ${err.message}`));

  server.on("close", () => {
    rejectSubmission(new Error("server closed before submission"));
  });

  return {
    url,
    waitForSubmission,
    close: () => {
      // `close()` alone waits on the browser's keep-alive socket: 5 s on Node
      // 18.x. Optional call, since `closeAllConnections` landed in 18.2.
      server.closeAllConnections?.();
      server.close();
    },
  };
}
