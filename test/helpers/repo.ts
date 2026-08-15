import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** A throwaway git repo on disk; nothing here touches the user's own repo or config. */
export interface TempRepo {
  /** Absolute path to the repository working tree. */
  dir: string;
  /** Run a git command inside the repo and return stdout. */
  git(...args: string[]): Promise<string>;
  /** Write a file (creating parent dirs) relative to the repo root. */
  write(relPath: string, content: string): Promise<void>;
  /** Stage everything and commit. Returns the new commit SHA. */
  commit(message: string): Promise<string>;
  /** Remove the repo from disk. Safe to call twice. */
  cleanup(): Promise<void>;
}

/** Create a temp repo. Any `files` become the initial commit, so HEAD resolves. */
export async function createRepo(files?: Record<string, string>): Promise<TempRepo> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "revgate-test-"));

  // Real isolation from the contributor's git config, not just local overrides.
  // Both paths name files that are never created, and git reads a missing config
  // as empty. Without this a contributor with `diff.relative` set watches these
  // suites fail while CI, which has no global config, stays green.
  const env = {
    ...process.env,
    GIT_CONFIG_GLOBAL: path.join(dir, ".no-global-gitconfig"),
    GIT_CONFIG_SYSTEM: path.join(dir, ".no-system-gitconfig"),
    GIT_CONFIG_NOSYSTEM: "1",
  };

  const git = async (...args: string[]): Promise<string> => {
    const { stdout } = await execFileAsync("git", args, {
      cwd: dir,
      env,
      maxBuffer: 16 * 1024 * 1024,
      windowsHide: true,
    });
    return stdout;
  };

  const write = async (relPath: string, content: string): Promise<void> => {
    const abs = path.join(dir, relPath);
    await mkdir(path.dirname(abs), { recursive: true });
    await writeFile(abs, content, "utf8");
  };

  const commit = async (message: string): Promise<string> => {
    await git("add", "-A");
    await git("commit", "-m", message);
    return (await git("rev-parse", "HEAD")).trim();
  };

  // A committable identity, and no signing prompt on `commit`.
  await git("init", "--initial-branch=main");
  await git("config", "user.email", "test@revgate.local");
  await git("config", "user.name", "revgate test");
  await git("config", "commit.gpgsign", "false");
  await git("config", "core.autocrlf", "false");
  // A global `core.hooksPath` would otherwise run the contributor's own hooks
  // against these repos; point it at a directory that is never created.
  await git("config", "core.hooksPath", path.join(dir, ".no-hooks"));

  const repo: TempRepo = {
    dir,
    git,
    write,
    commit,
    cleanup: async () => {
      await rm(dir, { recursive: true, force: true, maxRetries: 3 });
    },
  };

  if (files) {
    for (const [rel, content] of Object.entries(files)) await write(rel, content);
    await commit("initial");
  }

  return repo;
}
