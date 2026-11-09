# Tests

```
npm test                    # unit tests: fast, offline, no plan usage
npm run smoke               # smoke tests against the real Claude Code and Codex CLIs
npm run smoke -- takeover   # only smoke files whose name contains "takeover"
npm run e2e                 # the real app, end to end (builds it, opens it, clicks through it)
npm run e2e:remote          # Remote access: the API, a real browser, the MCP server, HTTPS mode
npm run e2e:mobile          # every screen on a phone-sized browser: fits the width, controls big enough to tap
npm run eval -- teamwork    # teamwork evaluation: real tasks, measuring who did what and what it cost
npm run eval -- helpers     # background-job evaluation: saving memory on Haiku vs Cline models, scored
npm run smoke -- cline      # the real Cline CLI: building, the safety hook, memory, Stop, background jobs, a hand-off
npm run usage               # a running VibeApp's usage report (add --api <file> for another computer, --json for raw rows)
```
Add `-- --packaged` to either e2e command to test the installed-style build in release/win-unpacked (run `npm run package` first).

- **unit/** checks VibeApp's own logic: question detection, routing and the balance slider, the diff digest, memory rules (the number check, de-duplication, conventions), the Chat tab history, extensions and keys.
- **smoke/** drives the real CLIs the way the app does: a Claude session, compaction (and Stop during it), helper agents, Claude handing work to Codex, takeovers, Ask mode, the Chat tab's Claude/Codex switch, procedures and the project brief, extensions for both agents, and the usage meters. Both CLIs must be installed and logged in. A full run takes about 10-15 minutes and uses a little of both plans (Claude runs on Haiku).

- **e2e/** opens the built app with its own data folder and a fresh test project (your real projects, memory and settings are never touched) and drives the screens through the Chrome DevTools protocol: opening a project, Claude editing a file and Codex reviewing it, Undo, Ask mode, a plain question answered the cheap way, compaction, Stop, the Chat tab with both agents, Settings, Extensions and Memory. Screenshots of every step go to test-results/e2e/. About 3 minutes.

- **eval/** is the teamwork evaluation: three small tasks on a fixed test game (a feature, a bug fix, and an approved plan ending in the saved Deploy), built for real the way the app does it (routing note, slider, plan note, run_deploy). Each request is measured like the app's usage report measures real ones (Claude's steps by kind, Claude and Codex tokens, hand-offs, minutes) and the result is checked (the new code works, the tests pass, the Deploy put it live). Results are saved to test-results/eval/ and printed next to the previous run of the same setup, so a change to the instructions or routing shows up as a percentage. Codex-led on Sonnet by default; `VIBEAPP_EVAL_BALANCE=claude` for Claude-led, `VIBEAPP_EVAL_MODEL=haiku` to spend less, `VIBEAPP_EVAL_ONLY=bugfix` for one task, `VIBEAPP_EVAL_BUILDER=cline` to have Cline build instead of Codex. About 10-20 minutes; uses real plan usage. The background-job evaluation (`helpers`) runs five memory-saving cases (a project rule, a one-off instruction, a rule for every project, a key that must not be saved, an outdated fact) on Haiku and each Cline model in `VIBEAPP_EVAL_HELPERS`, and prints how many each got right, the time and the tokens.

The Cline smoke tests need `npm i -g cline` and `cline auth` (ClinePass). They check what VibeApp promises about Cline: it builds and reports its steps and tokens; a destructive command, a file outside the project and the account connectors (Gmail, Drive) are refused; a review changes nothing; it uses the shared memory; Stop ends it; background jobs come back in the right format (a long one through a task file); and Claude can hand it a task.

Run the smoke tests after updating Claude Code, Codex or the Agent SDK: VibeApp depends on some of their less-documented behaviour (the usage call, `/compact`, Codex's CLI flags), and these tests are how a change there shows up.

Tests run under plain Node: `scripts/test.mjs` bundles each file with esbuild, swaps Electron for `support/electron-stub.cjs` (app data goes to a temp folder) and runs it with Node's test runner. Smoke tests need the app built once (`npm run build`); the runner does that if needed.
