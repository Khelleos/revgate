import { warn } from "../shared/log.js";
import type { StageState } from "../shared/types.js";
import { git, gitErrorMessage, repoRoot } from "./exec.js";

/** The `git status` column pairs that mean "conflict" — see the staging rule in agents.md. */
function isUnmerged(x: string, y: string): boolean {
  return x === "U" || y === "U" || (x === "A" && y === "A") || (x === "D" && y === "D");
}

/**
 * Whether each changed path's changes are staged, from `git status --porcelain`.
 * The two columns are X (index vs HEAD) and Y (working tree vs index).
 */
export async function getStageStates(cwd: string): Promise<Record<string, StageState>> {
  const states: Record<string, StageState> = Object.create(null); // see agents.md
  let out: string;
  try {
    // NUL-terminated records: the only form git emits verbatim.
    out = await git(cwd, ["status", "--porcelain=v1", "-z"]);
  } catch (err) {
    warn(`could not read git status: ${(err as Error).message}`);
    return states;
  }

  const tokens = out.split("\0");
  for (let i = 0; i < tokens.length; i++) {
    const rec = tokens[i];
    if (rec.length < 3) continue;
    const x = rec[0];
    const y = rec[1];
    const p = rec.slice(3);
    // A rename/copy carries its origin in the NEXT NUL field, on either column.
    // Unskipped, that origin parses as a record whose bogus key overwrites a real one.
    if (x === "R" || x === "C" || y === "R" || y === "C") i++;

    if (x === "?") {
      // `git rm --cached x` leaves both a tracked and an untracked record, and git
      // emits `??` last. The tracked one describes the index, so it stands.
      if (!Object.hasOwn(states, p)) states[p] = "no"; // untracked — nothing staged
    } else if (isUnmerged(x, y)) {
      states[p] = "unmerged"; // a conflict: staging is not a meaningful action
    } else if (x !== " " && y !== " ") {
      states[p] = "partial"; // staged, but the working tree diverged again
    } else if (x !== " ") {
      states[p] = "yes"; // fully staged
    } else {
      states[p] = "no"; // only a working-tree change
    }
  }
  return states;
}

/** Stage or unstage one path, returning refreshed states — a rename can reclassify neighbours. */
export async function setStaged(
  cwd: string,
  file: string,
  staged: boolean,
): Promise<Record<string, StageState>> {
  // `file` is root-relative and git resolves a pathspec against the cwd.
  const root = await repoRoot(cwd);
  try {
    if (staged) {
      // `add` handles modified, new, and deleted paths alike.
      await git(root, ["add", "--", file]);
    } else {
      // `reset` unstages whether or not HEAD exists (fresh repos included).
      await git(root, ["reset", "-q", "--", file]);
    }
  } catch (err) {
    // Propagated: a 200 with unchanged states cannot say "git refused".
    throw new Error(
      gitErrorMessage(err, `could not ${staged ? "stage" : "unstage"} ${file}`),
    );
  }
  return getStageStates(root);
}
