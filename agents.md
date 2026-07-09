# revgate: Agents Guide

Human-in-the-loop review for Copilot CLI: on agentStop, open a local web UI to review diffs and return a compact decision JSON to stdout.

Agents at a glance

- task — runs builds, tests, and lint (e.g., `npm run build`, `npm run demo`)
- explore — quick codebase discovery and edge-case investigation
- code-review — audit changes for correctness or security
- general-purpose — implement features or complex refactors

Core modules: index.ts, git.ts, diff.ts, server.ts, feedback.ts, types.ts, log.ts

Quick checks: Test with `npm run demo`.

- The project follows a planner-style architecture (like Plannator). Agents act as planners and executors: they propose plans, run tasks, and surface diffs for human review via the local web UI. This emphasizes human-in-the-loop decisioning and modular agent workflows.

