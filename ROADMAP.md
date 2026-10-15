# VibeApp roadmap

Everything recommended so far, in one place. Tick items off as they ship.

## Next up

- [x] **Stop button.** Stop Claude partway through a request instead of waiting for it to finish and then undoing. Also stops Codex hand-offs and skips a running review.
- [x] **Shorter action labels.** Show `src/player.js` instead of the full `C:\Users\…\MrgRPG\src\player.js` path in the chat.
- [x] **Paste images** (#10). Paste, drop, or 📎 a screenshot or sketch: "make it look like this." Originals are kept so Claude can use them as project files.

## Bigger features

- [ ] **Bake-off mode** (#4). Claude and Codex each build the same request in their own copy of the project; you compare the two previews and keep the one you like.
- [ ] **Cline as a third agent (ClinePass).** Add the Cline CLI alongside Claude and Codex, signed in with a ClinePass subscription ($9.99/month flat, open-weight models such as Qwen, GLM, Kimi and DeepSeek, its own 5-hour/weekly/monthly limits, separate from the Claude and Codex plans). What it would add:
  - a cheap place for straightforward implementation work Claude would otherwise spend its own plan on;
  - a more independent second reviewer (a different model family from Claude and Codex);
  - a third contestant for bake-off mode;
  - a fallback when Claude's limit is reached (order: Claude, then Codex, then Cline).

  Start with a trial before building anything (needs `npm i -g cline` and the user's own ClinePass sign-in): run it on real tasks with `--json`, and check three unknowns:
  - **Safety:** auto-approval is on by default and no sandbox or read-only mode has been found, so check whether plan mode (`-p`) truly blocks edits before using it as a reviewer; until then keep it behind Go Nutz or undo snapshots, since VibeApp's destructive-command prompts don't cover it.
  - **Shared memory:** whether `cline mcp` / `--config <dir>` can give it the vibe_memory tools per run.
  - **Windows:** whether it can be launched hidden (no console-window flashes, as fixed for Codex).

  Also unknown: no usage API found (dashboard only), so possibly no third meter; model list churns; quality on hard multi-file work is expected to be below Claude and Codex (untested). Check ClinePass terms before selling VibeApp with it built in. Docs: [ClinePass](https://docs.cline.bot/getting-started/clinepass), [CLI](https://docs.cline.bot/cline-cli/getting-started).
- [ ] **Plan first, then build** (#7). For big requests, Claude shows a short checklist to approve, then ticks items off as it works.
- [ ] **Starter templates** (#8). "A website," "a game," "a Discord bot" instead of a blank folder, ready for the preview and Publish.
- [ ] **Automatic app updates.** VibeApp downloads new versions itself instead of reinstalling from a zip. Needs somewhere to host releases, e.g. GitHub Releases.
- [ ] **Self-editing with a safety net.** Open VibeApp's own source as a project, have Claude change it, then "Rebuild & restart," keeping the last working version and rolling back automatically if the new one won't start.
- [ ] **Preview for Python apps.** Flask, Django, Streamlit and the like currently show "Nothing to preview."

## Loose ends to check

- [ ] **Keep measuring.** The usage log exists now; compare a week of real use with the scribe, hand-off resume and (if tried) fresh sessions on, and decide the defaults from the numbers. So far only small tests: on a task with durable facts the scribe cut Claude's steps from 4 to 2-3 and its cached reads by 30-55%, at about 1.8k Haiku tokens.
- [ ] **Scribe quality.** Haiku sometimes over-saves (task-only instructions as preferences) or fills in typical details. Mitigated with stricter rules, a check that numbers must appear in the exchange, and retiring (not overwriting) corrected facts, but watch the "Saved automatically" facts on the Memory screen.
- [ ] **Fresh-session summaries lose detail.** Off by default; needs real long-project use before it's worth enabling.
- [ ] **Run the same checks after Claude's own edits.** They only run after Codex hand-offs today.
- [ ] **Code map accuracy on big projects.** Capped at 600 files, 80 summarised per run, only the first ~1,200 characters of each file are read; large or unusual projects may be mapped partially.
- [ ] **Real GitHub backup.** Vercel publishing is confirmed working on the VM; the GitHub side (install, sign-in, first push) hasn't had a real run.
- [ ] **No window flashes during Codex reviews and hand-offs.** Fixed for the usage check; not yet tested while Codex runs its own commands.
- [ ] **Allow/Deny banner queue.** The logic is tested, but nobody has clicked through two stacked requests in the app.
- [ ] **Claude usage meter depends on an experimental SDK call.** If an SDK update breaks it, the meter shows "—"; switch to the stable API once there is one.
- [x] **Quick-edit detection was keyword-based.** Haiku now judges each request (size, and how much suits Codex); keyword rules remain only as the fallback.
- [ ] **`npm start` apps restart after every reply.** Plain servers can't reload their own code; a few seconds each time.

## Ideas considered, not planned

From the OpenClaw comparison. Worth revisiting only if VibeApp grows beyond coding:

- Message VibeApp from your phone or chat apps (Slack, Discord).
- A library of ready-made agent skills.

Dropped:

- Voice input (the other half of #10). Not needed.

## Done

- [x] Accounts: install and sign in to Claude Code, Codex, Node and Git from inside the app
- [x] Projects with automatic git, checkpoints, history and restore
- [x] Claude hands tasks to Codex; shared project and global memory
- [x] Shared context database (conversation history, hand-off log, code map): relevant facts and files pre-fetched into each request; Codex gets the user's own words, pasted images and recent hand-offs automatically; `history`, `handoffs` and `where` tools for both agents
- [x] Token efficiency pass: usage logged per request (new / cached / written tokens, shown under replies and in Settings by kind of work); a background Haiku scribe saves memory so agents don't spend a step on it; hand-off results are short with a capped diff and automatic checks (script syntax, JSON, the project's npm test); several Codex hand-offs in one request continue one Codex session
- [x] Optional (off by default): fresh Claude session for very long conversations; key facts exported to an AGENTS.md block
- [x] Claude/Codex balance slider in the top bar (Claude-led .. Codex-led, plus Auto that follows whichever plan has more left); shifts how much goes to Codex, uses a lighter Claude model when Codex is building (never above the chosen model), and skips the Codex review when Codex built the change
- [x] Takeover when Claude's plan limit is reached: the request goes straight to Codex (same memory, key facts, Go Nutz setting, undo snapshot, live feed, automatic checks) with a banner naming the reset time; Settings choice of automatic / ask first / off; a catch-up note tells Claude what Codex did when it returns; optional Haiku helpers (code map, memory saving, tidy, request judging) stand down when Claude is nearly out. Tested with the real Codex CLI (runner, follow-up, Stop); the limit signal itself was captured from a real rejection. Not yet exercised: the full in-app reactive path against a live limit (needs Claude out again).
- [x] Extensions screen: tools (MCP servers plus instructions) installed once for every project and switchable on and off, for both Claude and Codex. Short built-in list (Context7 docs, Playwright browser testing, step-by-step thinking; all need Node.js) plus "add your own". Keys are encrypted with the Windows account and reach Codex through its environment, not the command line. Tested with a real MCP server on both agents. Not done: extensions that change VibeApp's own screens; per-project on/off; a larger catalog.
- [x] Agents can install their own MCP servers: Claude builds one in the project, then an install tool (with a confirmation naming exactly what will run) copies it into VibeApp's data folder, starts it once to check it works, and registers it for both Claude and Codex. A server that needs keys stays off until the user adds them in the Extensions screen. Tested: declined, broken server, folder outside the project, keys flow, and Claude (Haiku) calling the real tool. Not tested: a full build-and-install conversation in the app UI.
- [x] Chat without building: an Ask/Build switch in every project (Ask = read-only answers from the files and memory, no snapshot, review or hand-off; Haiku by default, never Opus; Codex answers read-only when Claude is out), and a standalone Chat tab with no project where each message goes to whichever of Claude or Codex is selected, switchable mid-conversation (history is replayed, so context carries over). Conversations are saved in the app's data folder. Not done: chat memory (the Chat tab doesn't read or write project memory); images and file attachments in the Chat tab.
- [x] Cheaper small messages: plain questions typed in Build are answered through Ask automatically (setting, with a "Do it in Build instead" button on the reply); quick edits no longer step down to Haiku inside a big conversation (the prompt cache is per model, so the switch cost more than it saved); Build chats over about 60k tokens show a note about what each message re-reads, with a switch to Ask. The question detector is deliberately cautious (anything asking for a change stays Build). Not yet measured on a large real project.
- [x] Fresh sessions with safeguards: a "Start a fresh session" button in the chat-size note (warns if there are uncommitted changes), a size setting for the automatic version (60k-200k, still opt-in), a summary that keeps standing rules, work in progress and open questions (shown in the chat so the user can check it, and passed to Claude as binding), and Codex takeover sessions that start over after 3 requests or about 5M tokens instead of growing forever. Tested: the summary prompt on a sample conversation with a "never touch X" rule. Not yet exercised on a real 250k-token project.
- [x] Helper sub-agents: Claude can start an explorer (Haiku, read-only), reviewer (Sonnet, read-only), test-runner (Haiku) or general helper for self-contained jobs, each with its own small conversation, so the big one isn't re-read for them. Each has the project folder written into its instructions (found by testing: without it the general helper searched elsewhere and returned a formula from the wrong codebase). Helpers run inside the request (background tasks are off, otherwise they report after the turn was already declared done). Their steps show nested under the helper's card. Defining these does not limit Claude to them; the built-in kinds still work. Not done: parallel helpers editing in separate worktrees, per-helper cost display, user-defined helpers. Side effect to know: Claude's own background shell commands are also off.
- [x] Live Codex activity feed under each hand-off card: its narration, files it creates or edits, commands with output and pass/fail (wrapper stripped, secrets hidden), a running clock, folded into "Codex's work · N steps" afterwards and kept when the chat is reopened
- [x] Memory v2 on SQLite: key facts given up front, the rest searchable; Claude and Codex can update and forget facts; duplicates merge; Haiku tidy-up sorts, merges and retires outdated facts (restorable); quick edits skip memory
- [x] Go Nutz mode, destructive-command confirmations, MCP servers loaded on the fly
- [x] Model picker, themes (Midnight, Sakura Neon), theme generator and theme files
- [x] Claude and Codex plan-usage meters
- [x] Live preview with "Point" (#1)
- [x] "Something broke" banner with Fix it (#2)
- [x] Undo and redo for every message (#3)
- [x] Codex double-checks Claude's changes (#5)
- [x] Smart model switching (#6), with Haiku judging each request: Haiku for quick edits, Sonnet when Claude usage is low, and Codex asked to build straightforward work. The chosen model is a ceiling; stepping up to Opus for complex requests is an opt-in setting
- [x] Publish to Vercel (working on the VM) and back up to GitHub (#9)
- [x] Secrets, with protection against keys in chat, files and publishes (#11)
- [x] Claude's questions shown as a card you can answer
- [x] Replies rendered as Markdown (headings, lists, tables, code blocks with Copy); multi-line chat box (Shift+Enter, auto-grow, resizable)
- [x] Fixes from VM testing: console window pop-ups, Vercel sign-in and project names, disappearing usage meters, packaging retry
