/**
 * Helpers for the documentation drift guards.
 *
 * Both `test/docs.test.ts` (README.md, agents.md) and `test/skills.test.ts`
 * (the SKILL.md files) pull `revgate …` command lines out of markdown and push
 * them through `parseArgs`. The extraction rules are identical, so they live
 * here — two copies would drift, and the guard that catches drift must not be
 * the thing that has it.
 */

/**
 * Every `revgate …` command a document shows: lines inside fenced code blocks,
 * plus inline code spans. Prose is ignored, so a sentence that merely opens with
 * the word "revgate" is never mistaken for a command.
 */
export function commandLines(body: string): string[] {
  const found: string[] = [];

  let inFence = false;
  for (const line of body.split("\n")) {
    if (/^\s*```/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence && line.trim().startsWith("revgate ")) found.push(line.trim());
  }

  for (const [, span] of body.matchAll(/`([^`\n]+)`/g)) {
    if (span.trim().startsWith("revgate ")) found.push(span.trim());
  }
  return found;
}

/**
 * Turn a documented command line into a concrete argv, in the form it is
 * documented — the command name included.
 *
 * Docs use placeholders the CLI would never see: `<file>` stands for a value,
 * `[…]` marks an optional group, `...` marks a repeatable flag, and a trailing
 * `# …` is a comment for the reader. Substitute rather than skip, so the *shape*
 * of every documented invocation — which subcommand, flag names, whether a flag
 * takes a value, how many positionals — is still checked.
 */
export function toArgv(command: string): string[] {
  return command
    .replace(/\s+#.*$/, "")
    .split(/\s+/)
    .slice(1) // drop the `revgate` program name
    .map((t) => (t.startsWith("[") && t.endsWith("]") ? t.slice(1, -1) : t))
    .filter((t) => t && t !== "..." && t !== "…")
    .map((t) => (t.startsWith("<") && t.endsWith(">") ? "placeholder" : t));
}

/**
 * Which command `parseArgs` must resolve a documented argv to, read off the doc
 * itself. Without this the check is vacuous: `revgate copilot-plan` re-parsed as
 * `review copilot-plan` is a valid review of a git ref named `copilot-plan`, so a
 * renamed or deleted subcommand would leave the docs stale on a green suite.
 * Anything that is not the plan hook must be a `review` invocation — there is no
 * other entry point left for a doc to mean.
 */
export function expectedCommand(argv: string[]): "review" | "copilot-plan" {
  return argv[0] === "copilot-plan" ? "copilot-plan" : "review";
}
