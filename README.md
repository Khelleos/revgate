# revgate

Tiny local web UI that gates Copilot agent stops so you can review them like a GitHub PR.

- Pipe Copilot's agentStop event to revgate, review diffs in your browser,
  leave comments or an overall decision, and revgate returns a compact
  decision JSON to stdout for Copilot to consume.

Quick install

```bash
npm install
npm run build
```

Quick run

```bash
node dist/index.js --demo
```

Wire into Copilot by copying hooks/revgate.json to `~/.copilot/hooks/revgate.json`
(or `.github/hooks/revgate.json`) and point the script to `dist/index.js`.

That's it — concise review gate for Copilot agent stops.
