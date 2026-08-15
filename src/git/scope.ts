import type { DiffFile } from "../shared/types.js";
import { git } from "./exec.js";

/** Which changes a review covers. Declared once, so the parser and the collector cannot drift. */
export interface DiffScope {
  kind: "worktree" | "staged" | "ref" | "range";
  /** `[]` for worktree/staged, `[ref]` for a single ref, `[a, b]` for a range. */
  refs: string[];
  /** ".." compares the endpoints, "..." compares from the merge base. */
  dots?: ".." | "...";
  /** Path prefixes to keep (empty keeps all) and to drop. */
  include: string[];
  exclude: string[];
}

/** A scope git cannot honour. Distinct from a crash, so callers report bad usage (exit 2). */
export class ScopeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ScopeError";
  }
}

/** The label shown in the UI header, in log lines, and as the report's `scope:`. */
export function describeScope(scope: DiffScope): string {
  let label: string;
  switch (scope.kind) {
    case "staged":
      label = "staged changes";
      break;
    case "ref":
      label = `${scope.refs[0]} vs working tree`;
      break;
    case "range":
      label = `${scope.refs[0]}${scope.dots ?? ".."}${scope.refs[1]}`;
      break;
    default:
      label = "working tree vs HEAD";
  }

  // Filters belong in the label: they are why a busy scope can come back empty.
  // The label is the report's `scope:` header verbatim, so a filter, which is
  // user text, must not carry a line break into it.
  const oneLine = (p: string): string => p.replace(/[\r\n]+/g, " ");
  const filters = [
    ...scope.include.filter(Boolean).map((p) => `+${oneLine(p)}`),
    ...scope.exclude.filter(Boolean).map((p) => `-${oneLine(p)}`),
  ];
  return filters.length ? `${label} [${filters.join(" ")}]` : label;
}

/** Check a scope carries the refs its kind implies; `undefined` would crash execFile. */
export function verifyArity(scope: DiffScope): void {
  const want = scope.kind === "ref" ? 1 : scope.kind === "range" ? 2 : 0;
  if (scope.refs.length !== want) {
    throw new ScopeError(
      `a ${scope.kind} scope needs exactly ${want} ref(s), got ${scope.refs.length}`,
    );
  }
}

/** Resolve a ref before `git diff` sees it, so a typo is bad usage and not a git crash. */
export async function verifyRef(cwd: string, ref: string): Promise<void> {
  // A leading dash would be read by git as a flag.
  if (!ref || ref.startsWith("-")) {
    throw new ScopeError(`invalid git ref: ${ref || "(empty)"}`);
  }
  try {
    await git(cwd, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
  } catch {
    throw new ScopeError(`unknown git ref: ${ref}`);
  }
}

/** Compare paths with forward slashes so a Windows-style prefix still matches. */
function normalizePath(p: string): string {
  return p.replace(/\\/g, "/");
}

/** Reduce a `-I`/`-X` prefix to the root-relative form `git diff` emits; `""` is the tree. */
function normalizePrefix(prefix: string): string {
  let clean = normalizePath(prefix).replace(/\/+$/, "");
  while (clean.startsWith("./")) clean = clean.slice(2);
  if (clean === ".") return "";
  return clean.replace(/^\/+/, "");
}

/** Does `p` sit at or under `prefix`? A raw `startsWith` over-excludes on a string boundary. */
function matchesPrefix(p: string, prefix: string): boolean {
  const clean = normalizePrefix(prefix);
  if (!clean) return true;
  return p === clean || p.startsWith(`${clean}/`);
}

/** Narrow a parsed diff to the requested paths: include first, then exclude from what survived. */
export function filterFiles(files: DiffFile[], scope: Pick<DiffScope, "include" | "exclude">): DiffFile[] {
  const include = scope.include.map(normalizePath).filter(Boolean);
  const exclude = scope.exclude.map(normalizePath).filter(Boolean);
  if (!include.length && !exclude.length) return files;

  return files.filter((f) => {
    const p = normalizePath(f.path);
    if (include.length && !include.some((prefix) => matchesPrefix(p, prefix))) return false;
    return !exclude.some((prefix) => matchesPrefix(p, prefix));
  });
}
