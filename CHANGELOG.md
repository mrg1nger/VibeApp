# Changelog

The version goes up with each improvement that ships: the middle number for new features, the last for fixes only. Settings shows the version a computer is running.

## 0.7.0 (2026-11-11)

Third step of the memory work (Memory v3): **memory knows when it may be old.**
- **Facts are linked to the files they are about.** When the note-taker saves something after a request, it is linked to the files that request changed and the fact is about. A fact that names a file ("prices are in shop.js") is linked to it too.
- **"May be out of date."** Every request's changes are counted against the facts about those files. When a file has changed by about its own length since, or is deleted, Claude, Codex and Cline see the fact marked "may be out of date" (and why), and so does the Memory screen.
- **The tidy-up checks those first.** It reads the files as they are now and retires a fact they clearly contradict; one they don't contradict is kept and counts as up to date again. Tested on the background models: Kimi K3.1 Pro and MiniMax M3.1 Flash got all 24 cases right over three runs, Haiku all 8.
- **Facts nobody looks up are retired**: none looked up (searched, or attached to a request) for 60 days and 30 of the project's requests. Never key facts or your preferences for every project, and a project you leave alone for a while loses nothing. Retired facts stay under Show forgotten.
- **Which fact replaced which.** A corrected or merged fact says what replaced it, under Show forgotten.
- **On the Memory screen:** a "Useful lately" order (most recently looked up first); the files each fact is about; whether memory is searched by meaning on this computer; and approved plans, which open in full (from their fact, or the new Approved plans list).

## 0.6.0 (2026-11-10)

Second step of the memory work (Memory v3): **memory is searched by what you mean, not by matching words.**
- **"Put it online" finds the fact about deploying**, even though they share no word. A small language model (gte-small, 34 MB) reads every remembered fact and every file summary and compares meanings. It runs on your own computer, inside VibeApp; nothing is sent anywhere for it.
- **Claude, Codex and Cline all get it.** Their memory tools (`recall`, `where`) ask the running VibeApp, over a private channel on this computer that nothing on the network can reach. An exact name such as an error message is still found by its letters.
- **Fewer, better facts are attached to each request.** Before, any distinctive word in common was enough, so "ok do it" often came with unrelated facts. Now a fact or file is attached only when it is close in meaning.
- **Measured.** On the search test (120 questions with known answers): the right fact or file among the first five 93% of the time, against 70% before; 80% against 0% when the question shares no word with its answer. On 50 real requests from two real projects, judged without knowing which search found what: a directly useful fact among the first five for 44 requests instead of 38; three quarters of the attached facts useful instead of under half; and of 18 messages like "ok do it", 3 got a fact attached instead of 12.
- **The first start after updating** takes a moment in the background to read through everything already remembered (about a hundredth of a second per fact or file). Until that is done, and on a computer where the model can't run, memory is searched by keyword as before.
- The installer is 31 MB bigger (245 MB instead of 214 MB): the model and the program that runs it.
- For developers: the model is fetched by `npm install` (it isn't in the repository), comparing is done by the sqlite-vec add-on, and `npm run package` now checks that only the built app went into the installer.

## 0.5.5 (2026-11-10)

First step of the memory work planned in the roadmap (Memory v3):
- **Approved plans are kept whole.** A plan you approve is saved in full, and Claude, Codex and Cline can read it back (the new `plans` memory tool). Before, memory kept only the steps squeezed onto one line and cut at 950 characters. The Memory screen now shows one line per plan, such as "Approved 2026-11-10: Security review of FNotes (plan #3…)". Plans saved before are moved over once, with what was kept of them.
- **The memory test was wrong about "every project" rules, not the note-taker.** The test let a rule saved by one model count as already known to the next, so every model after the first looked as if it missed the rule. Fixed, with a harder case added. Every model ClinePass runs gets 6 of 6; Kimi K3.1 Pro and MiniMax M3.1 Flash 18 of 18 over three runs. The note-taker's instructions are unchanged, and the scores in Settings → Cline are corrected.

## 0.5.4 (2026-11-10)

- **Approved plans are remembered with all their letters.** A plan approved without numbered steps (a look over the project, a review) was saved to memory with every "s" taken out ("Thi reque t wa ju t…"), since plan mode first shipped. Those saved plans can't be repaired, so VibeApp forgets them once on start; they stay under Show forgotten.

## 0.5.3 (2026-11-10)

- **Publish remembers the last GitHub backup after a restart.** The time was only kept in memory, so after an update (which restarts VibeApp) Publish said nothing about the last backup until the next one. Backups themselves were never affected.
- **A Cline model typed into Settings can't undo a newer choice.** The text box (used only when Cline's model list can't be read) kept the value it opened with and saved it back when clicked out of, over a change made from another window, a phone or the API. Seen on 0.5.0's box, which put a background-job model back.

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
