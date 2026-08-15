#!/usr/bin/env node
// Entry point, dispatch only. Every piece of logic lives in `src/cli/`, which is
// what makes it testable: this file runs `main()` on import.
import { ScopeError } from "./git/scope.js";
import { parseArgs } from "./cli/args.js";
import { helpText } from "./cli/help.js";
import { emitPermission, runCopilotPlanHook } from "./cli/plan-hook.js";
import { runReviewCommand } from "./cli/review-command.js";
import { warn } from "./shared/log.js";

async function main(): Promise<void> {
  const cli = parseArgs(process.argv.slice(2));

  if (cli.command === "copilot-plan") {
    await runCopilotPlanHook(cli.options);
    return;
  }

  // A bad command line stays bad with --help appended: an agent recovering from
  // a usage error that way must not read exit 0 as success.
  if (cli.command === "review" && cli.error) {
    warn(cli.error);
    if (cli.options.help) process.stdout.write(helpText());
    else warn("run `revgate review --help` for usage");
    process.exitCode = 2;
    return;
  }

  // stdout is right here: no hook passes --help, and nothing else has used it.
  if (cli.options.help) {
    process.stdout.write(helpText());
    return;
  }

  try {
    await runReviewCommand(cli.options);
  } catch (err) {
    // A ref that doesn't resolve is bad usage, not a crash.
    if (!(err instanceof ScopeError)) throw err;
    warn(err.message);
    warn("run `revgate review --help` for usage");
    process.exitCode = 2;
  }
}

main().catch((err) => {
  warn(`fatal: ${(err as Error).stack ?? err}`);
  // Which contract this run owes stdout, from the same routing main() used.
  const { command } = parseArgs(process.argv.slice(2));
  if (command === "review") {
    process.exitCode = 1;
    return;
  }
  // The hook must fail open: a non-zero exit denies the tool. Set the code and
  // let the loop drain, since process.exit can truncate the decision on a pipe.
  emitPermission({ permissionDecision: "allow" });
  process.exitCode = 0;
});
