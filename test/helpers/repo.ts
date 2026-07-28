import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * A throwaway git repository on disk. Used by the git/history tests that need
 * a real repo to run `git diff` against — nothing here touches the user's own
 * repo or global git config.
 */
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

/**
 * Create a temp git repo. `files` (if given) are written and committed as the
 * initial commit, so the repo always has a resolvable HEAD unless it is empty.
 */
export async function createRepo(files?: Record<string, string>): Promise<TempRepo> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "revgate-test-"));

  // Real isolation from the contributor's git config, not just local overrides.
  // Both config paths point at files that are never created: git treats a
  // missing config file as empty, which is portable in a way `os.devNull` is
  // not. Without this, `~/.gitconfig` is read in full inside these temp repos —
  // so a contributor with `diff.relative` or `diff.mnemonicPrefix` set would
  // watch the git/index suites fail for reasons the tests do not explain, while
  // CI (which has no global config) stayed green. That is also the class of bug
  // HARDENED_CONFIG in src/git.ts defends against, and these tests are supposed
  // to be able to prove it.
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
