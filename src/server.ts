import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { log, warn } from "./log.js";
import { setStaged } from "./git.js";
import type { DiffFile, HookPayload, ReviewSubmission } from "./types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// public/ sits next to dist/ at the package root, so go up one from dist/.
const PUBLIC_DIR = path.resolve(__dirname, "..", "public");

export interface ReviewContext {
  payload: HookPayload;
  branch: string | null;
  files: DiffFile[];
  isRepo: boolean;
  note?: string;
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

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

export async function startReviewServer(ctx: ReviewContext): Promise<ServerHandle> {
  let resolveSubmission!: (r: ReviewSubmission) => void;
  let rejectSubmission!: (e: Error) => void;
  const waitForSubmission = new Promise<ReviewSubmission>((resolve, reject) => {
    resolveSubmission = resolve;
    rejectSubmission = reject;
  });

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      const pathname = url.pathname;

      if (pathname === "/api/review" && req.method === "GET") {
        json(res, 200, ctx);
        return;
      }

      if ((pathname === "/api/stage" || pathname === "/api/unstage") && req.method === "POST") {
        if (!ctx.isRepo) {
          json(res, 409, { error: "not a git repository" });
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
        const stage = pathname === "/api/stage";
        const states = await setStaged(ctx.payload.cwd, file, stage);
        log(`${stage ? "staged" : "unstaged"} ${file}`);
        json(res, 200, { states });
        return;
      }

      if (pathname === "/api/submit" && req.method === "POST") {
        const raw = await readBody(req);
        let submission: ReviewSubmission;
        try {
          submission = JSON.parse(raw);
        } catch {
          json(res, 400, { error: "invalid JSON" });
          return;
        }
        json(res, 200, { ok: true });
        log(`review submitted: ${submission.decision} (${submission.comments?.length ?? 0} comments)`);
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
      warn(`request error: ${(err as Error).message}`);
      try {
        res.writeHead(500).end("internal error");
      } catch {
        /* headers already sent */
      }
    }
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address() as AddressInfo;
  const url = `http://127.0.0.1:${addr.port}/`;

  server.on("close", () => {
    rejectSubmission(new Error("server closed before submission"));
  });

  return {
    url,
    waitForSubmission,
    close: () => server.close(),
  };
}
