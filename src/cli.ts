/**
 * argv parsing for every revgate entry point.
 *
 * revgate is an on-demand CLI (`revgate review`) plus exactly one Copilot hook:
 * the `preToolUse` plan gate (`revgate copilot-plan`). The hook has a fail-open
 * contract — it must never exit non-zero, so it must never reject argv either.
 * Everything else is the `review` command, which reports usage errors honestly.
 */

import type { DiffScope } from "./git.js";

export interface CliOptions {
  /**
   * Which changes a review covers. `DiffScope` itself, not an alias: `parseArgs`
   * produces exactly the shape `collectDiff` consumes, and one declaration (in
   * git.ts) is the reason the two can never drift apart. `import type` is erased
   * at compile time, so this adds no runtime coupling to git.
   */
  scope: DiffScope;
  /**
   * `--demo`: open the UI even with nothing to review — a real working-tree diff
   * on the diff path, the bundled sample plan with `--plan`.
   */
  demo: boolean;
  /** False when `--no-open` was passed. */
  open: boolean;
  /** `--plan` was passed: review a plan document instead of a diff. */
  plan: boolean;
  /** The optional path given to `--plan`. */
  planFile?: string;
  /** `--output <file>` / `-o`: write annotations here instead of stdout. */
  output?: string;
  /** `--exit-code-on-comments`: exit 10 when the review captured anything. */
  exitCodeOnComments: boolean;
  /** False when `--no-history` was passed: don't persist the review. */
  history: boolean;
  /** `--history-dir <dir>`: where to persist reviews (beats $REVGATE_HISTORY_DIR). */
  historyDir?: string;
  /** `--help` / `-h`. */
  help: boolean;
}

export type ParsedArgs =
  | { command: "copilot-plan"; options: CliOptions }
  | { command: "review"; options: CliOptions; error?: string };

const HELP = `revgate — human-in-the-loop, GitHub-style code review

Usage:
  revgate review [<refs>] [options]     open a review for the given scope
  revgate copilot-plan                  preToolUse plan gate (reads its payload on stdin)

Scopes (mirroring revdiff):
  (none)                  working tree vs HEAD
  <ref>                   <ref> vs the working tree     e.g. revgate review HEAD~3
  <a> <b>                 <a> vs <b>                    e.g. revgate review main feature
  <a>..<b>                same as two refs              e.g. revgate review main..feature
  <a>...<b>               <a> vs <b> from their merge base

Options:
      --staged            review staged changes only (cannot be combined with refs)
  -I, --include <path>    only review paths starting with <path> (repeatable)
  -X, --exclude <path>    skip paths starting with <path> (repeatable)
      --plan [<file>]     review a plan document instead of a diff
  -o, --output <file>     write the review annotations to <file> instead of stdout
      --exit-code-on-comments
                          exit 10 when the review captured comments or requested changes
      --history-dir <dir> save reviews under <dir> (default: $REVGATE_HISTORY_DIR
                          or ~/.revgate/history)
      --no-history        do not save the review to the history directory
      --no-open           do not open the browser automatically
      --demo              open the UI even when there is nothing to review
                          (with --plan, review a bundled sample plan)
  -h, --help              show this help

Exit codes:
  0   review completed (or there was nothing to review)
  1   unexpected error
  2   bad usage
  10  comments were captured (only with --exit-code-on-comments)
`;

/** The `--help` output. Ends with a newline. */
export function helpText(): string {
  return HELP;
}

/** Split `a..b` / `a...b`, defaulting an omitted side to HEAD the way git does. */
function splitRange(arg: string): { refs: [string, string]; dots: ".." | "..." } | null {
  const three = arg.indexOf("...");
  if (three !== -1) {
    return {
      refs: [arg.slice(0, three) || "HEAD", arg.slice(three + 3) || "HEAD"],
      dots: "...",
    };
  }
  const two = arg.indexOf("..");
  if (two !== -1) {
    return {
      refs: [arg.slice(0, two) || "HEAD", arg.slice(two + 2) || "HEAD"],
      dots: "..",
    };
  }
  return null;
}

function defaultOptions(): CliOptions {
  return {
    scope: { kind: "worktree", refs: [], include: [], exclude: [] },
    demo: false,
    open: true,
    plan: false,
    exitCodeOnComments: false,
    history: true,
    help: false,
  };
}

/**
 * Parse `process.argv.slice(2)`.
 *
 * Never throws: a malformed `review` invocation comes back as `error`, which the
 * caller turns into exit 2. The hook command ignores anything it doesn't know.
 */
export function parseArgs(argv: string[]): ParsedArgs {
  // The plan gate is recognized before ANY validation: it is a hook, and a
  // usage error there would fail closed and silently deny an unrelated tool.
  // Its flags are still honoured (--no-history, --history-dir, --no-open); only
  // the *reporting* of a bad one is dropped, because this path cannot fail.
  if (argv[0] === "copilot-plan") {
    return { command: "copilot-plan", options: parseOptions(argv.slice(1)).options };
  }

  const isReview = argv[0] === "review";
  const { options, error, positionals } = parseOptions(isReview ? argv.slice(1) : argv);

  if (isReview) return error ? { command: "review", options, error } : { command: "review", options };

  // `revgate --help` / `revgate -h` with nothing else is a legitimate ask for
  // usage, not a mistyped invocation.
  if (!positionals.length && options.help && !error) return { command: "review", options };

  // Everything else without the `review` subcommand is bad usage. There is no
  // hook to fall through to any more: the agentStop diff gate was removed, and
  // the one remaining hook is recognized by its explicit `copilot-plan` word
  // above. Routing the leftovers to `review` with an error keeps the exit-2
  // contract — a typo (`revgate reviw`), a bare `revgate`, or a legacy hook
  // invocation must not open a review or forge a clean one.
  const reason = positionals.length
    ? `unknown command: ${positionals[0]}`
    : "missing the `review` subcommand — the agentStop hook entry was removed; " +
      "re-run install.ps1 if a hook still invokes bare `revgate`";
  return { command: "review", options, error: error ?? reason };
}

/** The flag/positional loop shared by every entry point. Never throws. */
function parseOptions(rest: string[]): {
  options: CliOptions;
  error?: string;
  positionals: string[];
} {
  const options = defaultOptions();
  const positionals: string[] = [];
  let staged = false;
  let error: string | undefined;
  /** Keep the FIRST problem — it is the one that explains the rest. */
  const fail = (message: string) => {
    if (!error) error = message;
  };

  for (let i = 0; i < rest.length; i++) {
    const raw = rest[i];

    // Long flags may carry their value inline as `--flag=value`.
    let name = raw;
    let inline: string | undefined;
    if (raw.startsWith("--")) {
      const eq = raw.indexOf("=");
      if (eq !== -1) {
        name = raw.slice(0, eq);
        inline = raw.slice(eq + 1);
      }
    }

    /** Read a required value, either inline or from the next token. */
    const takeValue = (): string | undefined => {
      if (inline !== undefined) {
        if (!inline) fail(`${name} requires a value`);
        return inline || undefined;
      }
      const next = rest[i + 1];
      if (next === undefined || next.startsWith("-")) {
        fail(`${name} requires a value`);
        return undefined;
      }
      i++;
      // An empty token is the same non-value as `--flag=`, and every call site
      // guards with `if (v)` — so `-o ""` used to consume the token and leave
      // the annotations on stdout, and `-I ""` used to drop the filter and
      // review the whole tree. A skill interpolating an unset shell variable
      // (`-o "$OUT"`, `-I "$SCOPE"`) gets silently different behaviour than it
      // asked for, which is what `rejectValue` exists to prevent.
      if (!next) {
        fail(`${name} requires a value`);
        return undefined;
      }
      return next;
    };

    /**
     * Reject `--flag=value` on a switch that takes no value. Accepting and
     * discarding the value inverts the caller's intent in silence: the primary
     * caller is an LLM, which readily writes `--no-history=false` meaning "keep
     * history" or `--exit-code-on-comments=false` meaning "plain exit codes",
     * and each of those used to turn the switch ON. `revgate review` rejects
     * unknown flags outright, so failing here is the consistent answer.
     */
    const rejectValue = () => {
      if (inline !== undefined) fail(`${name} does not take a value`);
    };

    switch (name) {
      case "-h":
      case "--help":
        rejectValue();
        options.help = true;
        break;
      case "--demo":
        rejectValue();
        options.demo = true;
        break;
      case "--no-open":
        rejectValue();
        options.open = false;
        break;
      case "--staged":
        rejectValue();
        staged = true;
        break;
      case "-I":
      case "--include": {
        const v = takeValue();
        if (v) options.scope.include.push(v);
        break;
      }
      case "-X":
      case "--exclude": {
        const v = takeValue();
        if (v) options.scope.exclude.push(v);
        break;
      }
      case "-o":
      case "--output": {
        const v = takeValue();
        if (v) options.output = v;
        break;
      }
      case "--exit-code-on-comments":
        rejectValue();
        options.exitCodeOnComments = true;
        break;
      case "--no-history":
        rejectValue();
        options.history = false;
        break;
      case "--history-dir": {
        const v = takeValue();
        if (v) options.historyDir = v;
        break;
      }
      case "--plan": {
        options.plan = true;
        if (inline !== undefined) {
          if (inline) options.planFile = inline;
          else fail("--plan= requires a path");
        } else {
          // The path is OPTIONAL: only a following non-flag token counts.
          const next = rest[i + 1];
          if (next !== undefined && !next.startsWith("-")) {
            // Consume it either way, so an empty token cannot fall through to
            // the positional handling and be reported as a bad subcommand. An
            // empty one is NOT a path, though: `--plan "$PLAN"` with $PLAN unset
            // means the skill asked for a plan review without naming a file, and
            // recording "" here would suppress the $REVGATE_PLAN_FILE fallback —
            // the same silent divergence `takeValue` rejects empty values for.
            if (next) options.planFile = next;
            i++;
          }
        }
        break;
      }
      default:
        if (raw.startsWith("-") && raw !== "-") fail(`unknown flag: ${raw}`);
        else positionals.push(raw);
    }
  }

  const scope = options.scope;
  if (positionals.length > 2) fail(`unexpected argument: ${positionals[2]}`);

  const refs = positionals.slice(0, 2);
  if (refs.length === 1) {
    const range = splitRange(refs[0]);
    if (range) {
      scope.kind = "range";
      scope.refs = range.refs;
      scope.dots = range.dots;
    } else {
      scope.kind = "ref";
      scope.refs = [refs[0]];
    }
  } else if (refs.length === 2) {
    scope.kind = "range";
    scope.refs = refs;
    scope.dots = "..";
  }

  if (staged) {
    if (scope.kind === "worktree") scope.kind = "staged";
    else fail("--staged cannot be combined with refs");
  }

  // A plan review has no git diff behind it, so runReviewCommand discards the
  // scope entirely. Saying so beats accepting the flags and silently reviewing
  // something other than what the caller asked for.
  if (options.plan && (staged || refs.length || scope.include.length || scope.exclude.length)) {
    fail("--plan reviews a plan document, not a diff — it cannot be combined with refs, --staged, -I or -X");
  }

  return { options, error, positionals };
}
