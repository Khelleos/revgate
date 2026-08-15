import { spawn } from "node:child_process";
import { warn } from "../shared/log.js";

/** Open `url` in the platform's default browser. Never throws. */
export function openBrowser(url: string): void {
  const platform = process.platform;
  const [command, args] =
    platform === "win32"
      // `start` is a cmd builtin; the empty title arg avoids quoting pitfalls.
      ? ["cmd", ["/c", "start", "", url]]
      : platform === "darwin"
        ? ["open", [url]]
        : ["xdg-open", [url]];
  try {
    const child = spawn(command as string, args as string[], { detached: true, stdio: "ignore" });
    // A missing opener raises an ASYNC `error` the try/catch cannot see, which
    // unlistened kills the process; preToolUse fails CLOSED on a non-zero exit.
    child.once("error", (err) => warn(`could not auto-open browser: ${err.message}`));
    child.unref();
  } catch (err) {
    warn(`could not auto-open browser: ${(err as Error).message}`);
  }
}
