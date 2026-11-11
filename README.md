<a href="https://www.buymeacoffee.com/mrginger" target="_blank"><img src="https://cdn.buymeacoffee.com/buttons/v2/default-violet.png" alt="Buy Me a Coffee" width="217" height="60"></a>

# VibeApp

A friendly Windows desktop app for building software by chatting with AI coding agents. **Claude Code** leads, **Codex** builds and double-checks, and optionally **Cline** takes the routine work. They share one memory of your project, and every change can be undone.

VibeApp is for "vibe coding": you describe what you want, watch it appear in a live preview, and keep going. There's no editor to learn and no terminal to manage. It runs on your own subscriptions (Claude, ChatGPT, and optionally ClinePass), so there's nothing extra to pay for and no API keys to paste.

> **Status:** a personal project, shared as is. It's used daily on Windows 11. macOS and Linux build targets are configured but have never been tried.

---

## Contents

- [What it does](#what-it-does)
- [How the agents work together](#how-the-agents-work-together)
- [Install](#install)
- [First run](#first-run)
- [Using it](#using-it)
- [Safety and privacy](#safety-and-privacy)
- [Remote access and phones](#remote-access-and-phones)
- [Building from source](#building-from-source)
- [Tests](#tests)
- [Project layout](#project-layout)
- [Known limits](#known-limits)
- [License](#license)

---

## What it does

**Building**
- **Chat to build.** Pick a mode for each message:
  - **Build** makes the change.
  - **Plan** shows a step-by-step plan for you to approve, change or cancel.
  - **Ask** answers from your files without changing anything.
- **Live preview** of your app beside the chat. Use **Point** to click on the part you mean, and **Something broke** to fix an error in one click.
- **Undo and redo for every message**, plus named checkpoints and a full history to restore from. Git runs underneath; you never have to touch it.
- **Notes and to-dos** for each project. Press **▶ Build this** on a to-do to send it to the chat. The agents can add their own leftovers to the list.
- **One-click Deploy.** Claude writes the deploy recipe once from how you've deployed before, and you check it. After that, VibeApp runs it without AI, with a site check and optional rollback.
- **Schedules.** A request, a deploy or a site check can run on a timetable: at a time of day, every few hours, or after each deploy. Each one has a daily cap and a usage guard.
- **Publish to Vercel and back up to GitHub.** It can back up automatically after each request, and pick up newer work made on another computer.

**Memory and context**
- **Shared memory** in a local SQLite database. Claude, Codex and Cline all read and write the same facts, procedures, to-dos and project brief.
- **Found by meaning.** "Put it online" finds the fact about deploying, even with no word in common. A small language model does this on your own computer; nothing is sent anywhere for it.
- **Knows when it may be old.** Facts are linked to the files they are about. When those files change a lot or are deleted, the agents are told the fact may be out of date, and the tidy-up checks it against the files. Facts nobody has looked up in two months of use are retired (restorable, as always).
- **Background helpers** keep the memory tidy. They save what's worth remembering, merge duplicates, keep a ~500-word project brief and map the code.
- **Long chats are compacted in place.** Rules, decisions and work in progress are kept, and a meter shows how full the chat is.

**Control and cost**
- **A Claude/Codex balance slider:** Claude-led, balanced, Codex-led, or Auto (follows whichever plan has more left).
- **Usage meters** for Claude and Codex, and a detailed report of where the usage went.
- **Smart model switching:** Haiku for quick edits, Sonnet when Claude's plan is running low. Your chosen model is a ceiling.
- **Takeover.** When Claude's plan limit is reached, Codex carries on with the same memory, and Claude is told what happened when it returns.

**Extras**
- **Extensions:** MCP tool servers (Context7 docs, Playwright browser testing, or your own), installed once for all projects and both agents.
- **Secrets:** keys stored encrypted with your Windows account. Your app gets them as environment variables, and VibeApp warns if one turns up in the chat, a file or a publish.
- **Remote access:** use VibeApp from a browser or phone on your network, and drive it from Claude Code through its MCP server.
- **System tray mode,** Windows notifications and phone alerts (through the free ntfy app).
- **Updates itself** from GitHub Releases, with a banner to update, skip that version, or not now.
- **Themes**, including RedAstra (RedAstra Labs' own colours) and a theme generator.
- **Backups** of VibeApp's own data, with restore and export to move to another PC.

---

## How the agents work together

| Agent | Role | Needs |
|---|---|---|
| **Claude Code** | Leads: talks with you, plans, edits, decides what to hand off | A Claude subscription (Pro or Max) |
| **Codex** | Builds work Claude hands it, reviews Claude's changes, takes over when Claude is out | A ChatGPT plan with Codex |
| **Cline** *(optional)* | Runs the background memory jobs, takes straightforward hand-offs, and is the last fallback when both are out | A ClinePass plan |

- **Hand-offs carry the full context.** When Claude hands a task to Codex or Cline, the request goes with your own words, pasted images, the project brief and the key facts. The result comes back with the files changed and a short diff, and VibeApp runs automatic checks (script syntax, JSON, the project's `npm test`).
- **Every change gets a second look.** Codex reviews Claude's changes, and Claude judges Codex's.
- **Codex can be left out.** VibeApp works with Claude Code alone, and Codex and Cline add capacity. If Cline isn't installed, everything it would do falls back to Claude.
- **Cline stays running for hand-offs**, the way an editor hosts it (`cline --acp`): no start-up wait, and a second hand-off in the same request carries on where the first left off. It always runs on ClinePass, never Cline's pay-as-you-go billing.

---

## Install

1. Download `VibeApp-<version>-setup.exe` from the [Releases](../../releases) page.
2. Run it. **The installer isn't code-signed**, so Windows SmartScreen will say it "protected your PC". Choose **More info → Run anyway**. If you'd rather not, [build it yourself](#building-from-source).
3. Open VibeApp from the Start menu or the desktop shortcut.

Requires Windows 10 or 11 (64-bit).

**Updates:** VibeApp looks for new versions on this repository's Releases. When there's one, a banner shows across the top with **What's new**, **Update and restart**, **Skip this version** and **Not now**. Updating downloads the installer, checks it against the release's SHA-512, and restarts VibeApp into the new version. To turn the automatic checks off or check by hand, go to **Settings → Updates**.

---

## First run

The **Accounts** screen sets up everything VibeApp drives, from inside the app:

- **Claude Code:** installs it, then you sign in with your Claude account in the built-in terminal.
- **Codex:** installs it, then you sign in with your ChatGPT account.
- **Node.js** and **Git:** installs them if they're missing. Node.js 22.5 or newer is needed, because the shared memory server uses Node's built-in SQLite.

**Optional: Cline.** In a terminal, run `npm i -g cline`, then `cline auth`, and choose ClinePass. Then press **Test Cline** under **Settings → Cline (ClinePass)**.

Then go to **Projects**. Start a new project in an empty folder, open an existing one, or get one from GitHub.

---

## Using it

**The three modes**
- **Build:** the agents change your project. You'll be asked first before anything destructive (deleting folders, force-pushing, wiping git history).
- **Plan:** a read-only look around, then a numbered plan card. Each step is marked *(Claude)* or *(Codex)*. Approve it and the steps tick off as they're built. Nothing changes while planning, Go Nutz or not: VibeApp turns away edits, commands that aren't read-only, Deploy and hand-offs. If your message needs something done now, Claude asks once, saying what and why, and switches to Build only if you allow it.
- **Ask:** read-only answers, on a cheaper model. Plain questions typed in Build are answered this way automatically.

**Go Nutz.** This switch lets the agents run without asking for confirmation. Some things stay blocked even then: deleting GitHub repositories, changing who can see them, and reading your GitHub sign-in.

**Settings** covers the models (for Claude, Codex and Cline), automatic memory, when to compact, takeover behaviour, smart routing, backups, phone alerts, schedules, remote access, the tray, and the usage report.

---

## Safety and privacy

**Where your code and chats go.** Your code, chats and memory stay on your computer, in VibeApp's data folder and your project folders, except for what you send to the AI services you've signed in to:

| Service | What it receives |
|---|---|
| Anthropic | What Claude reads and writes |
| OpenAI | What Codex reads and writes |
| ClinePass *(only if Cline is switched on)* | Chat and code excerpts for the background jobs and hand-offs, sent to Cline's model providers. Each use can be switched off in Settings. |
| ntfy *(only if phone alerts are on)* | A project name and what's waiting. Never code or chat text. |

Searching memory by meaning sends nothing anywhere: the language model for it comes with VibeApp and runs on your computer.

**How it's protected**
- **Secrets** are encrypted with your Windows account (DPAPI) and stored outside your projects. Some are never given to the agents at all. VibeApp warns before a key ends up in the chat, a file, a commit or a published site.
- **Destructive commands need your OK** outside Go Nutz.
- **Cline approves its own actions**, so VibeApp checks every one before it runs (twice for hand-offs: its safety hook, then Cline asks VibeApp's permission for each step):
  - Cline only works inside the project.
  - Commands that delete folders, push or wipe history are replaced with a "blocked" message.
  - Cline's account connectors (Gmail, Drive and the like) are switched off.
- **The preview** only shows `localhost`, with no access to VibeApp's own controls. Links elsewhere open in your browser.
- **Your sign-ins** stay with Claude Code, Codex, Cline and the GitHub CLI. VibeApp never stores or reads them.

**Reporting a vulnerability:** please use GitHub's [private vulnerability reporting](../../security/advisories/new) rather than a public issue.

---

## Remote access and phones

Remote access is off by default. Turn it on in **Settings → Remote access**. There are two modes:
- **This computer only:** listens on `127.0.0.1`, for tools like Claude Code on the same PC.
- **Local network:** HTTPS with a certificate VibeApp makes itself.

**How a device connects**
- Each browser or tool **pairs once** with a 6-digit code. The code works once, and wrong guesses are rate-limited.
- The device gets its own token, which VibeApp stores only as a hash.
- In Settings you can list the paired devices, disconnect any of them, or make them read-only.
- A remote device can never change the remote-access settings.

> **Never expose VibeApp to the internet** (no port forwarding). It can run commands on your computer. To reach it from outside your home, use [Tailscale](https://tailscale.com). With MagicDNS and HTTPS certificates turned on in Tailscale, VibeApp gets a trusted certificate, and phones can install it as an app.

**Driving VibeApp from Claude Code:**

```
claude mcp add vibeapp -- node "<VibeApp data folder>/vibeapp-mcp.cjs"
```

Settings shows the exact command. The tools list projects, send a message and wait for the answer, approve plans, read the chat, deploy, and report usage.

---

## Building from source

**You'll need**
- Windows 10/11 x64.
- **Node.js 22.5+** and **Git**.
- **Visual Studio 2022 Build Tools** with the *Desktop development with C++* workload **and the "Spectre-mitigated libraries"** component, for the `node-pty` terminal. Install the Spectre libraries from an elevated (administrator) installer.
- Python 3, which node-gyp uses.

**Commands**

```powershell
git clone https://github.com/mrg1nger/VibeApp.git
cd VibeApp
npm install          # also applies patches/ and rebuilds node-pty for Electron
npm run dev          # run with hot reload
npm run build        # build into out/
npm run package      # make release/VibeApp-<version>-setup.exe
npm run typecheck
```

**Making a release** (for maintainers):
1. Step the version with `npm version X.Y.Z --no-git-tag-version`.
2. Add a `## X.Y.Z` section to CHANGELOG.md.
3. Run `npm run package`, then `npm run release` (add `-- --draft` to check it on GitHub first).

The release script uploads the installer, its `.blockmap` and `latest.yml`. The in-app updater needs `latest.yml`, so publish releases this way rather than by hand. It uses the GitHub CLI's own sign-in (`gh auth login`).

**Gotchas**
- **`ELECTRON_RUN_AS_NODE` must not be set.** If Electron starts as plain Node, `electron.app` is undefined; clear that variable and run it again.
- **The node-pty patch** drops the old winpty build target, which doesn't build on modern Windows. node-pty uses ConPTY instead.

**Built with** Electron, electron-vite, React, TypeScript, the [Claude Agent SDK](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk), the Codex CLI (`codex exec --json`), the Cline CLI, SQLite (`node:sqlite`) with [sqlite-vec](https://github.com/asg017/sqlite-vec), the [gte-small](https://huggingface.co/Xenova/gte-small) language model on the ONNX runtime (`onnxruntime-node`), xterm.js and node-pty. The model isn't in this repository: `npm install` fetches it (34 MB, checked against a checksum) into `resources/models/`.

---

## Tests

```
npm test               # unit tests: fast, offline, no plan usage
npm run smoke          # against the real Claude Code and Codex CLIs (uses a little of both plans)
npm run smoke -- cline # the real Cline CLI, including its safety checks
npm run e2e            # the built app, clicked through end to end, with its own data folder
npm run e2e:remote     # Remote access: the API, a real browser, the MCP server, HTTPS
npm run e2e:mobile     # every screen at phone size
npm run eval           # evaluations: real tasks, measuring who did what and what it cost
```

The tests never touch your real projects, memory or settings: they run against a temporary data folder. See [tests/README.md](tests/README.md) for details. Run the smoke tests after updating Claude Code, Codex or the Agent SDK, because VibeApp relies on some of their less-documented behaviour.

---

## Project layout

```
src/main/           Electron main process
  orchestrator/     Claude sessions, routing, takeover, plans, command safety
  delegation/       hand-offs to Codex and Cline
  cli/              running Claude Code, Codex and Cline
  cline/            Cline's safety hook
  memory/           shared SQLite memory, its MCP server, search by meaning, scribe, tidy, brief, code map
  remote/           Remote access server, pairing, Tailscale certificates, MCP server
  review/ deploy/ schedule/ backup/ github/ publish/ secrets/ preview/ ...
src/preload/        the bridge between the window and the main process
src/renderer/       the React UI
src/remote-bridge/  the same UI in a browser
shared/             types and logic used on both sides
tests/              unit, smoke, e2e and eval tests
patches/            patch-package fixes for dependencies
```

[ROADMAP.md](ROADMAP.md) lists what's done, what's planned and the loose ends. [CHANGELOG.md](CHANGELOG.md) lists what changed in each version.

---

## Known limits

- **Windows only in practice.** The command handling assumes Windows (PowerShell, Git Bash, `.cmd` shims).
- **It depends on the CLIs' behaviour.** A Claude Code, Codex or Cline update can change things VibeApp relies on; the smoke tests are how that shows up.
- **Bring your own subscriptions.** VibeApp drives the official CLIs with your own sign-ins. Check each provider's current terms for how you use them.
- **No ClinePass usage meter**, because the Cline CLI doesn't report plan limits. VibeApp notices "limit reached" and falls back to Claude for a while.
- **Not code-signed.** Windows SmartScreen warns on first install. Updates are checked against the release's SHA-512, which protects against a damaged download but not against someone who controls the GitHub account.

---

## License

[MIT](LICENSE) © 2026 Mr.Ginger

The installer also carries, under their own licences: the gte-small language model (trained by Alibaba DAMO Academy, whose model card gives the licence as MIT; shipped in Xenova's ONNX conversion), the ONNX runtime (MIT) and sqlite-vec (MIT or Apache-2.0).
