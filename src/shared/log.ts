/** Log to stderr. stdout carries an output contract Copilot parses. */
export function log(...args: unknown[]): void {
  process.stderr.write(`[revgate] ${args.map(String).join(" ")}\n`);
}

/** Warn to stderr, under the same rule as `log`. */
export function warn(...args: unknown[]): void {
  process.stderr.write(`[revgate] WARN ${args.map(String).join(" ")}\n`);
}
