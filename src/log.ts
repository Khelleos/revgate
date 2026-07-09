/**
 * Everything logs to stderr. stdout is reserved exclusively for the final
 * HookDecision JSON, because Copilot parses our stdout as the hook result —
 * a stray console.log there would corrupt it.
 */
export function log(...args: unknown[]): void {
  process.stderr.write(`[revgate] ${args.map(String).join(" ")}\n`);
}

export function warn(...args: unknown[]): void {
  process.stderr.write(`[revgate] WARN ${args.map(String).join(" ")}\n`);
}
