# Tests

```
npm test                    # unit tests: fast, offline, no plan usage
npm run smoke               # smoke tests against the real Claude Code and Codex CLIs
npm run smoke -- takeover   # only smoke files whose name contains "takeover"
```

- **unit/** checks VibeApp's own logic: question detection, routing and the balance slider, the diff digest, memory rules (the number check, de-duplication, conventions), the Chat tab history, extensions and keys.
- **smoke/** drives the real CLIs the way the app does: a Claude session, compaction (and Stop during it), helper agents, Claude handing work to Codex, takeovers, Ask mode, the Chat tab's Claude/Codex switch, procedures and the project brief, extensions for both agents, and the usage meters. Both CLIs must be installed and logged in. A full run takes about 10-15 minutes and uses a little of both plans (Claude runs on Haiku).

Run the smoke tests after updating Claude Code, Codex or the Agent SDK: VibeApp depends on some of their less-documented behaviour (the usage call, `/compact`, Codex's CLI flags), and these tests are how a change there shows up.

Tests run under plain Node: `scripts/test.mjs` bundles each file with esbuild, swaps Electron for `support/electron-stub.cjs` (app data goes to a temp folder) and runs it with Node's test runner. Smoke tests need the app built once (`npm run build`); the runner does that if needed.
