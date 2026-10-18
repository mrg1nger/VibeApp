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
- [x] Memory that survives a long project: the note-taker now sees the real commands that were run (secrets scrubbed) and saves working routines as "Procedure - <name>" facts (long ones stay searchable rather than key); a thorough save pass runs right before every fresh session; a project brief (about 500 words: what it is, how it's built, run/test/deploy, services, rules, status, pitfalls) is kept in the database, shown on the Memory screen with a rewrite button, and given to new Claude sessions and to Codex; Claude and Codex are told to look up how an operational job was done before and reuse it. Tested with real Haiku calls on a sample deploy. Not done: a memory health check that compares memory with the project and lists gaps; measuring the real token cost on a large project (usage is logged under "scribe" and "brief").
- [x] Compaction: long conversations are compacted in place (Claude Code's /compact with instructions to keep rules, procedures, services, decisions, work in progress and open questions), after the save pass and a brief refresh. Automatic past the chosen size (on by default, 120k), a "Compact now" button in the chat-size note, a PreCompact hook so Claude Code's own automatic compaction also saves memory first, a notice in the chat, and an estimated entry in the usage log (the SDK reports no usage for it). Replaces the automatic fresh session, which stays as a manual button. Tested through the real session: 37k to a 3k summary in 11s, rules and facts kept. Not yet timed on a 250k-token chat.
- [x] Test suite: `npm test` (13 offline unit tests: question detection, routing and balance, diff digest, memory rules, Chat tab history, extensions) and `npm run smoke` (14 tests against the real Claude Code and Codex CLIs: session, compaction and Stop during it, helper agents, Claude-to-Codex hand-offs including two at once, takeover and Stop, Ask, the Chat tab switch, procedures and brief, extensions for both agents, usage meters; about 6 minutes). Run the smoke tests after any Claude Code, Codex or SDK update. Collaboration fixes found while writing them: hand-offs run one at a time (insurance: Claude Code already seemed to serialise them), a failed or stopped hand-off now lists the files Codex changed, and the default hand-off limit is 15 minutes instead of 5.
- [x] End-to-end app test (`npm run e2e`): the built app with its own data folder, driven by clicks and typing through 14 steps (project, Claude edit + Codex review, Undo, Ask, auto-Ask, compaction, Stop, Chat tab with both agents, Settings, Extensions, Memory, no memory saved when switched off), screenshots in out/e2e/. Bugs it found: Undo turned Unix line endings into Windows ones when git's autocrlf is on (would break shell scripts deployed to Linux); the save pass before compacting ignored "Save memory automatically" being off; memory and Claude never heard about an Undo, so a fact about undone code was saved and Claude would still believe it existed. All fixed.
- [x] Broader tests: the app test now has 27 steps (adds live preview, Point, the "Something broke" banner, checkpoints and History, images, Claude's questions, Allow/Deny including two prompts at once, Go Nutz, secrets and the leak banner, both takeover modes via a test-only switch, removing a project) and runs against the packaged app (`npm run e2e -- --packaged`, 27/27). Smoke tests add the Claude/Codex slider (Codex-led hands the build to Codex; Claude-led builds itself). Found and fixed: outside Go Nutz, every PowerShell command on Windows (even running the tests) raised an Allow prompt, so safe commands that stay in the project now run without asking; Undo could also turn Windows line endings into Unix ones (snapshots now read every file fresh); a Deny was reported to the user as "blocked by your hook settings"; the installer packed anything left in out/ (test logs once corrupted the archive), so it now packs only the app.
- [x] Remote access (Settings): VibeApp's screens in any browser and an API for other tools, off by default. "This computer only" listens on 127.0.0.1; "local network" uses HTTPS with a certificate VibeApp makes itself. Every browser or tool pairs once with a 6-digit code (single use; 5 wrong tries lock an address out for 10 minutes) and gets a token stored only as a hash; devices are listed with Disconnect; a read-only mode; remote callers can't change Remote access settings; cookie requests and WebSockets from other sites are refused. Same actions as the desktop window (one shared registry; events reach every open screen). In a browser: the live preview is relayed (with Point, reload and error capture), and folders are browsed on the computer. Claude Code tools via VibeApp's MCP server (list projects, send a message and wait, answer prompts, read the chat, stop, compact, memory, usage): `claude mcp add vibeapp -- node "<VibeApp data>/vibeapp-mcp.cjs"`. Tested end to end (14 steps, also on the packaged app). Not done: the desktop and a browser showing the same prompt both stay up until one answers; preview links open on the computer, not the browser's device; the login terminal on the Accounts screen hasn't been tried from a browser.
- [x] Plan mode: a third switch (Build / Plan / Ask). Claude explores read-only (Claude Code's own plan mode) and writes a short plan, numbered steps tagged (Claude) or (Codex) following the balance slider; it's shown as a card with Approve and build, Change it (feedback, Claude revises) and Cancel. Approving builds it with the plan's steps ticking off (a plan_progress tool), saves the plan's steps to memory, and gets the usual Codex review. Plan mode refuses to run when Claude is out (a Codex takeover would skip the approval). Also in the MCP tools (send_message mode "plan", approve_plan) and on phones. Found while testing: inside the app Claude Code sends the plan as a permission request, so it showed a generic Allow prompt (and Allow would have built without approval); VibeApp now answers it itself. Tested in the app test (propose, change, approve and build, cancel) and the phone test.
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
