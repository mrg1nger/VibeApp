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
- [ ] **Takeover when Claude's limit is reached.** Today VibeApp only shifts work toward Codex as Claude runs low (under 25% left); once Claude is actually out, nothing runs until the window resets. Send the message straight to Codex (same memory, key facts, Go Nutz setting, undo snapshot and preview) with a banner such as "Claude is out until 4:12 PM. Codex is handling this," switch back automatically on reset, and let the user choose automatic or ask-first. Trade-offs: no Claude planning and no Codex double-check on those turns. Cline could be the next fallback after Codex. The low-Claude routing itself has never been tested against a plan that is actually running low.
- [ ] **Plan first, then build** (#7). For big requests, Claude shows a short checklist to approve, then ticks items off as it works.
- [ ] **Starter templates** (#8). "A website," "a game," "a Discord bot" instead of a blank folder, ready for the preview and Publish.
- [ ] **Automatic app updates.** VibeApp downloads new versions itself instead of reinstalling from a zip. Needs somewhere to host releases, e.g. GitHub Releases.
- [ ] **Extensions screen.** Tools for Claude and Codex (an MCP server plus instructions), installed once and available in every project, switchable on and off. Extensions that change VibeApp's own screens are a much bigger step, left until these prove not to be enough.
- [ ] **Self-editing with a safety net.** Open VibeApp's own source as a project, have Claude change it, then "Rebuild & restart," keeping the last working version and rolling back automatically if the new one won't start.
- [ ] **Preview for Python apps.** Flask, Django, Streamlit and the like currently show "Nothing to preview."

## Loose ends to check

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
