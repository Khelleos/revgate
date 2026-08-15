/**
 * argv parsing for every revgate entry point: the `review` command, which
 * reports usage errors honestly, and the `copilot-plan` hook, which has a
 * fail-open contract and so must never reject argv.
 */

import type { DiffScope } from "../git/scope.js";

/** Everything a parsed command line carries. */
export interface CliOptions {
  /**
   * Which changes a review covers. `DiffScope` itself, not an alias, so the
   * parser produces exactly the shape `collectDiff` consumes. `import type` is
   * erased at compile time, so this adds no runtime coupling to git.
   */
  scope: DiffScope;
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

/** What `parseArgs` returns: the command to run, and why it is unusable. */
export type ParsedArgs =
  | { command: "copilot-plan"; options: CliOptions }
  | { command: "review"; options: CliOptions; error?: string };

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
    open: true,
    plan: false,
    exitCodeOnComments: false,
    history: true,
    help: false,
  };
}

/**
 * Parse `process.argv.slice(2)`. Never throws: a malformed `review` invocation
 * comes back as `error`, which the caller turns into exit 2.
 */
export function parseArgs(argv: string[]): ParsedArgs {
  // The plan gate is recognized before ANY validation: it is a hook, and a usage
  // error there would fail closed and silently deny an unrelated tool. Its flags
  // still apply; only the *reporting* of a bad one is dropped.
  if (argv[0] === "copilot-plan") {
    return { command: "copilot-plan", options: parseOptions(argv.slice(1)).options };
  }

  const isReview = argv[0] === "review";
  const { options, error, positionals } = parseOptions(isReview ? argv.slice(1) : argv);

  if (isReview) return error ? { command: "review", options, error } : { command: "review", options };

  // `revgate --help` with nothing else is a legitimate ask for usage.
  if (!positionals.length && options.help && !error) return { command: "review", options };

  // Everything else without the `review` subcommand is bad usage: there is no
  // hook left to fall through to, and a typo or a legacy hook invocation must
  // not open a review or forge a clean one.
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
      // An empty token is the same non-value as `--flag=`: a skill interpolating
      // an unset variable (`-o "$OUT"`, `-I "$SCOPE"`) must not silently get
      // different behaviour than it asked for.
      if (!next) {
        fail(`${name} requires a value`);
        return undefined;
      }
      return next;
    };

    /**
     * Reject `--flag=value` on a switch that takes no value. Accepting and
     * discarding it inverts the caller's intent in silence: an LLM readily
     * writes `--no-history=false` meaning "keep history".
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
            // Consumed either way, so an empty token cannot be reported as a bad
            // subcommand — but an empty one is not a path, and recording it would
            // suppress the $REVGATE_PLAN_FILE fallback.
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

  // A plan review has no git diff behind it, so the scope is discarded. Saying so
  // beats silently reviewing something other than what the caller asked for.
  if (options.plan && (staged || refs.length || scope.include.length || scope.exclude.length)) {
    fail("--plan reviews a plan document, not a diff — it cannot be combined with refs, --staged, -I or -X");
  }

  return { options, error, positionals };
}
