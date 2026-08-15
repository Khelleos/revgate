"""The `--help` output.

A byte-exact constant. README.md documents every flag that appears here, so
a flag added to `grammar.py` but not to this text goes undocumented — keep
the three in step by hand.
"""

HELP = (
    "revgate — human-in-the-loop, GitHub-style code review\n"
    "\n"
    "Usage:\n"
    "  revgate review [<refs>] [options]     open a review for the given scope\n"
    "  revgate plan                          preToolUse plan gate (reads its payload on stdin)\n"
    "\n"
    "Scopes:\n"
    "  (none)                  working tree vs HEAD\n"
    "  <ref>                   <ref> vs the working tree     e.g. revgate review HEAD~3\n"
    "  <a> <b>                 <a> vs <b>                    e.g. revgate review main feature\n"
    "  <a>..<b>                same as two refs              e.g. revgate review main..feature\n"
    "  <a>...<b>               <a> vs <b> from their merge base\n"
    "\n"
    "Options:\n"
    "      --staged            review staged changes only (cannot be combined with refs)\n"
    "  -I, --include <path>    only review paths starting with <path> (repeatable)\n"
    "  -X, --exclude <path>    skip paths starting with <path> (repeatable)\n"
    "      --plan [<file>]     review a plan document instead of a diff\n"
    "  -o, --output <file>     write the review annotations to <file> instead of stdout\n"
    "      --exit-code-on-comments\n"
    "                          exit 10 when the review captured comments or requested changes\n"
    "      --history-dir <dir> save reviews under <dir> (default: $REVGATE_HISTORY_DIR\n"
    "                          or ~/.revgate/history)\n"
    "      --no-history        do not save the review to the history directory\n"
    "      --no-open           do not open the browser automatically\n"
    "  -h, --help              show this help\n"
    "\n"
    "Exit codes:\n"
    "  0   review completed (or there was nothing to review)\n"
    "  1   unexpected error\n"
    "  2   bad usage\n"
    "  10  comments were captured (only with --exit-code-on-comments)\n"
)


def help_text() -> str:
    """The `--help` output. Ends with a newline."""
    return HELP
