# Changelog

The version goes up with each improvement that ships: the middle number for new features, the last for fixes only. Settings shows the version a computer is running.

## 0.5.2 (2026-11-10)

- **"Default" means the same Cline model everywhere.** With no model chosen, hand-offs ran on ClinePass's default (Kimi K3.1 Pro) but background jobs and Test Cline on whatever the computer's own Cline setup defaulted to (MiniMax on one machine). They now all use ClinePass's default, so "Same as hand-offs" is true.

## 0.5.1 (2026-11-10)

- **Settings → Cline has real model menus.** They list the ClinePass models Cline offers right now (read from Cline, with their proper names), each with VibeApp's own test results, and say which model "ClinePass's default" means. A model ClinePass refuses or no longer offers is marked. The old suggestions were out of date, and one of them (Qwen3.7 Plus) is refused by ClinePass.
- **Every ClinePass model tested** on hand-off coding (three tasks checked by the project's own tests) and on saving memory. All 10 models ClinePass runs did the coding tasks; five it lists are refused (Qwen3.7 Plus and Max, MiniMax M3, MiMo V2.6 Flash and Pro). **Kimi K3.1 Pro** (ClinePass's default) is recommended for both: 3/3 at ~19 s per task, and 14/15 memory cases at under 4 s.
- Fixed: VibeApp's automatic `npm test` check after a hand-off could report a pass for failing tests when VibeApp itself ran under a test runner (found by the new coding test, which had the same flaw).

## 0.5.0 (2026-11-10)

Cline hand-offs run on a Cline that stays running, the way editors such as Zed and JetBrains host it (`cline --acp`):
- **No start-up wait.** A one-off Cline took 4–12 s just to start; the hosted one starts in about a second, once. A second hand-off in the same request starts at once (1.3 s for a short one in testing) and remembers the first.
- **Every step is checked twice.** VibeApp's safety hook still runs first (and tells Cline why something was refused), and now Cline also asks VibeApp's permission for each step, which VibeApp answers with the same rules.
- **Always on ClinePass.** Left to itself, a hosted Cline starts on Cline's pay-as-you-go billing; VibeApp pins ClinePass and checks the model before sending anything.
- Token usage still shows in the usage report (read from Cline's own session record).
- If the hosted Cline can't start, the hand-off runs the old way. Background jobs and reviews still use one-off runs.
- Hand-offs with no model chosen now use ClinePass's default for hosted sessions (Kimi K3.1 Pro); pick one under Settings → Cline.

## 0.4.3 (2026-11-10)

- **Fewer background jobs fall back to Claude.** Cline's newer default model sometimes left out an empty list in its answer, and VibeApp threw the whole answer away and asked Haiku instead (half the memory saves on one computer). A left-out list now counts as empty.
- Tested nine ClinePass models on saving memory: **MiniMax M3.1 Flash** got all 15 cases right and was the fastest, so it's the one to choose under Settings → Cline for background jobs. Three models in ClinePass's list (Qwen3.7 Plus, Qwen3.7 Max, MiMo V2.6 Flash) are currently refused.

## 0.4.2 (2026-11-10)

- **Plan mode really changes nothing now.** It used to rely on Claude following its instructions: Claude Code's own plan mode lets commands run, and VibeApp approved its own tools (Deploy, hand-offs to Codex and Cline) in every mode. Found on a real install, where a "done" sent while the switch was still on Plan deployed, migrated a production database over ssh and handed work to Codex. Now VibeApp checks every step while planning, Go Nutz or not: reading, searching, read-only commands (`git status`, `ls`…), memory, notes, to-dos and drafts are fine; edits, other commands (ssh included), Deploy, hand-offs and installs are turned away.
- **One prompt to leave Plan mode.** When your message needs something done now, Claude asks once, saying what and why: **Switch to Build and allow** (the rest of the request is a normal Build, and the switch moves to Build) or **Keep planning** (it carries on planning and doesn't ask again in that request).

## 0.4.1 (2026-11-10)

- **After an update, VibeApp says so once:** "VibeApp was updated to 0.4.2 (from 0.4.1)", with a What's new link. It starts with the update after this one, since versions before 0.4.1 didn't record which version ran last.

## 0.4.0 (2026-11-10)

VibeApp updates itself from GitHub Releases:
- **A banner when there's a new version,** across the top of every screen. It has a **What's new** link to the release page, **Update and restart**, **Skip this version** (a newer one still shows) and **Not now**.
- **Update and restart** downloads the new installer and checks it against the release's SHA-512. VibeApp then closes, installs it quietly and opens again. If a project is still working, it asks first.
- **Settings → Updates:** the running version, **Check for updates**, a link to all releases, **Look for new versions automatically** (on; at start and every 6 hours), and **Remind me again** for a skipped version.
- Remote browsers see the banner too, but installing happens on the computer.
- For whoever makes releases: `npm run release` publishes the packaged version with the files the updater needs, and the changelog section as the notes.

## 0.3.1 (2026-11-09)

Security check before the code goes public:
- **Links can only open web pages or email.** The window used to hand any kind of link (file:, ms-…: and other program launchers) to Windows, and nothing stopped it leaving VibeApp's own screens.
- **Pairing codes can't be guessed from many addresses.** After 20 wrong codes from anywhere in 10 minutes, pairing pauses for everyone and the code changes.
- **Remote access "This computer" mode only answers to localhost**, so a website can't reach it by pointing its own name at this computer (DNS rebinding).
- Updated dependencies with known security problems (zod and others); `npm audit` finds none in what the app ships.
- The node-pty patch holds only its one real change, no build files.

## 0.3.0 (2026-11-09)

Cline (on the ClinePass plan) joins Claude and Codex:
- **Background jobs on Cline.** Saving memory, the tidy-up, the project brief, file summaries and chat summaries no longer use Claude's plan. Haiku steps in if Cline can't do one.
- **Claude can hand straightforward work to Cline** (`run_cline_subtask`). Codex reviews what Cline changed.
- **Cline takes a request when Claude and Codex are both out.**
- **Safety:** every Cline tool call goes through VibeApp's check. Cline works only inside the project, destructive commands are swapped for a "blocked" message, and the account connectors (Gmail, Drive) are switched off and refused.
- **Settings → Cline (ClinePass):** on/off for each use, the models, and Test Cline.
- **The usage report counts Cline separately.** New evaluations: `npm run eval -- helpers` and `VIBEAPP_EVAL_BUILDER=cline`.

## 0.2.0 (2026-11-09)

The first numbered step. Everything built up to here, including:
- Codex-led really hands off the work: Codex builds and tests, Claude plans and judges the report.
- Claude deploys with the saved Deploy (run_deploy), and Claude Code can too through the connector.
- Usage evaluations: every request recorded, Settings → Detailed report, `npm run usage`, `npm run eval`.
- Memory lives in the open project (🧠 Memory next to History).
- GitHub backup and sync, Schedules, Remote access, Deploy.

## 0.1.0

Everything before version numbers were stepped.
