// Shared by `docs.test.ts` and `skills.test.ts`: the guard that catches doc
// drift must not have any.

/** Every documented `revgate` command: fenced code blocks and inline spans, never prose. */
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

/** Turn a documented command line into argv, substituting placeholders rather than skipping them. */
export function toArgv(command: string): string[] {
  return command
    .replace(/\s+#.*$/, "")
    .split(/\s+/)
    .slice(1) // drop the `revgate` program name
    .map((t) => (t.startsWith("[") && t.endsWith("]") ? t.slice(1, -1) : t))
    .filter((t) => t && t !== "..." && t !== "…")
    .map((t) => (t.startsWith("<") && t.endsWith(">") ? "placeholder" : t));
}

/** Which command a documented argv must resolve to; `copilot-plan` also parses as a ref name. */
export function expectedCommand(argv: string[]): "review" | "copilot-plan" {
  return argv[0] === "copilot-plan" ? "copilot-plan" : "review";
}
