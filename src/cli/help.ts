// `test/docs.test.ts` pulls every flag out of this template and requires the
// README to document it, so a flag added to `args.ts` but not here goes
// unchecked — keep the two in step by hand.

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
