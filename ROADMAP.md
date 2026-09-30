# VibeApp roadmap

Everything recommended so far, in one place. Tick items off as they ship.

## Next up

- [x] **Stop button.** Stop Claude partway through a request instead of waiting for it to finish and then undoing. Also stops Codex hand-offs and skips a running review.
- [x] **Shorter action labels.** Show `src/player.js` instead of the full `C:\Users\…\MrgRPG\src\player.js` path in the chat.
- [x] **Paste images** (#10). Paste, drop, or 📎 a screenshot or sketch: "make it look like this." Originals are kept so Claude can use them as project files.

## Bigger features

- [ ] **Bake-off mode** (#4). Claude and Codex each build the same request in their own copy of the project; you compare the two previews and keep the one you like.
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
- [x] Smart model switching (#6), with Haiku judging each request: Haiku for quick edits, Opus for complex work when a lighter model is chosen, Sonnet when Claude usage is low, and Codex asked to build straightforward work
- [x] Publish to Vercel (working on the VM) and back up to GitHub (#9)
- [x] Secrets, with protection against keys in chat, files and publishes (#11)
- [x] Claude's questions shown as a card you can answer
- [x] Fixes from VM testing: console window pop-ups, Vercel sign-in and project names, disappearing usage meters, packaging retry
