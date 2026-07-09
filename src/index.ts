#!/usr/bin/env node
import { spawn } from "node:child_process";
import { collectWorkingTreeDiff, getStageStates } from "./git.js";
import { parseUnifiedDiff } from "./diff.js";
import { buildDecision } from "./feedback.js";
import { startReviewServer, type ReviewContext } from "./server.js";
import { log, warn } from "./log.js";
import type { HookDecision, HookPayload } from "./types.js";

/** Emit the hook result. This is the ONLY thing allowed on stdout. */
function emit(decision: HookDecision): void {
  process.stdout.write(JSON.stringify(decision) + "\n");
}

/** Read Copilot's hook payload from stdin, normalizing both known formats. */
async function readHookPayload(): Promise<HookPayload | null> {
  // If stdin is an interactive TTY there is no piped payload (e.g. manual run).
  if (process.stdin.isTTY) return null;

  const chunks: Buffer[] = [];
  const raw: string = await new Promise((resolve) => {
    let settled = false;
    const done = () => {
      if (!settled) {
        settled = true;
        resolve(Buffer.concat(chunks).toString("utf8"));
      }
    };
    // Guard against a hung stdin that never closes.
    const t = setTimeout(done, 2000);
    process.stdin.on("data", (c) => chunks.push(c as Buffer));
    process.stdin.on("end", () => {
      clearTimeout(t);
      done();
    });
    process.stdin.on("error", () => {
      clearTimeout(t);
      done();
    });
  });

  // Strip a leading UTF-8 BOM — some shells/pipes prepend one to stdin.
  const clean = raw.replace(/^﻿/, "").trim();
  if (!clean) return null;
  try {
    const o = JSON.parse(clean) as Record<string, unknown>;
    // Accept camelCase or VS Code snake_case field names.
    return {
      sessionId: String(o.sessionId ?? o.session_id ?? ""),
      timestamp: (o.timestamp as number | string) ?? Date.now(),
      cwd: String(o.cwd ?? process.cwd()),
      transcriptPath: (o.transcriptPath ?? o.transcript_path) as string | undefined,
      stopReason: (o.stopReason ?? o.stop_reason) as string | undefined,
    };
  } catch (err) {
    warn(`could not parse hook payload: ${(err as Error).message}`);
    return null;
  }
}

function openBrowser(url: string): void {
  const platform = process.platform;
  try {
    if (platform === "win32") {
      // `start` is a cmd builtin; the empty title arg avoids quoting pitfalls.
      spawn("cmd", ["/c", "start", "", url], { detached: true, stdio: "ignore" }).unref();
    } else if (platform === "darwin") {
      spawn("open", [url], { detached: true, stdio: "ignore" }).unref();
    } else {
      spawn("xdg-open", [url], { detached: true, stdio: "ignore" }).unref();
    }
  } catch (err) {
    warn(`could not auto-open browser: ${(err as Error).message}`);
  }
}

async function main(): Promise<void> {
  const isDemo = process.argv.includes("--demo");

  const payload =
    (await readHookPayload()) ??
    ({
      sessionId: isDemo ? "demo" : "manual",
      timestamp: Date.now(),
      cwd: process.cwd(),
      stopReason: "end_turn",
    } satisfies HookPayload);

  const cwd = payload.cwd || process.cwd();
  log(`session ${payload.sessionId} — reviewing changes in ${cwd}`);

  const repo = await collectWorkingTreeDiff(cwd);
  const files = parseUnifiedDiff(repo.unified);

  // No changes and not a demo: nothing to review, let Copilot proceed.
  if (files.length === 0 && !isDemo) {
    log(repo.isRepo ? "no changes to review — allowing" : "not a git repo — allowing");
    emit({ decision: "allow" });
    return;
  }

  // Annotate each file with its staging state so the UI can offer a toggle.
  if (repo.isRepo) {
    const states = await getStageStates(cwd);
    for (const f of files) f.staged = states[f.path] ?? "no";
  }

  const ctx: ReviewContext = {
    payload,
    branch: repo.branch,
    files,
    isRepo: repo.isRepo,
    note: repo.isRepo ? undefined : "Not a git repository — no diff available.",
  };

  const server = await startReviewServer(ctx);
  log(`review UI at ${server.url}`);
  log(`${files.length} file(s) changed — opening browser…`);
  openBrowser(server.url);

  try {
    const review = await server.waitForSubmission;
    const decision = buildDecision(review, files);
    server.close();
    if (decision.decision === "block") {
      log("changes requested — sending feedback to Copilot as next prompt");
    } else {
      log("approved — Copilot will stop");
    }
    emit(decision);
  } catch (err) {
    // Server closed / interrupted before a review arrived: don't block Copilot.
    warn(`no review captured (${(err as Error).message}) — allowing`);
    emit({ decision: "allow" });
  }
}

main().catch((err) => {
  warn(`fatal: ${(err as Error).stack ?? err}`);
  // Never leave Copilot hanging on our failure.
  emit({ decision: "allow" });
  process.exit(0);
});
