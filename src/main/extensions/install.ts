import { cpSync, existsSync, mkdirSync, rmSync, statSync } from 'fs'
import { basename, join, resolve, sep } from 'path'
import { addExtension, extensionsDir, freeId, launcher } from './store'
import { selfTestServer } from './selftest'

export interface AgentInstallRequest {
  name: string
  description?: string
  /** Program that runs the server, e.g. "node" or "npx". */
  command: string
  /** Arguments; "{{dir}}" stands for the folder the server's files are copied to. */
  args: string[]
  /** A folder inside the project holding the server's code, to be copied into VibeApp's data. */
  sourceDir?: string
  /** When the agents should use it. */
  instructions?: string
  /** Names of keys it needs; the user supplies the values in the Extensions screen. */
  keys?: string[]
}

export type Confirm = (details: { reason: string; input: Record<string, unknown> }) => Promise<boolean>

const NAME_OK = /^[A-Za-z0-9_]{1,64}$/

function isInside(parent: string, child: string): boolean {
  const p = resolve(parent)
  const c = resolve(child)
  return c === p || c.startsWith(p + sep)
}

/**
 * Registers an MCP server an agent built, after the user confirms: copies its
 * files somewhere permanent, starts it once to check it works, then installs
 * it for both Claude and Codex. Returns a message for the agent.
 */
export async function installExtensionForAgent(
  req: AgentInstallRequest,
  projectPath: string,
  confirm: Confirm
): Promise<{ ok: boolean; message: string }> {
  const name = req.name.trim()
  const command = req.command.trim()
  if (!name || !command) return { ok: false, message: 'A name and a program to run are both required.' }
  const keys = (req.keys ?? []).map((k) => k.trim()).filter(Boolean)
  const badKey = keys.find((k) => !NAME_OK.test(k))
  if (badKey) return { ok: false, message: `"${badKey}" isn't a valid key name (letters, numbers, underscores).` }

  let source: string | undefined
  if (req.sourceDir) {
    source = resolve(projectPath, req.sourceDir)
    if (!isInside(projectPath, source)) {
      return { ok: false, message: 'sourceDir must be a folder inside the project.' }
    }
    if (!existsSync(source) || !statSync(source).isDirectory()) {
      return { ok: false, message: `${req.sourceDir} isn't a folder that exists.` }
    }
  }
  if (!source && req.args.some((a) => a.includes('{{dir}}'))) {
    return { ok: false, message: 'The arguments use {{dir}} but no sourceDir was given.' }
  }

  const approved = await confirm({
    reason: `Claude wants to install a tool called "${name}" for every project. It will run this on your computer: ${[
      command,
      ...req.args
    ].join(' ')}${source ? ` (its files get copied from ${basename(source)} into VibeApp's data folder)` : ''}${
      keys.length ? `. It needs these keys from you afterwards: ${keys.join(', ')}` : ''
    }.`,
    input: { name, program: command, arguments: req.args, copiedFrom: source ?? null, keysNeeded: keys }
  })
  if (!approved) return { ok: false, message: 'The user declined to install it. Do not try again unless they ask.' }

  // Keep the files somewhere that survives this project being removed.
  const id = freeId(name)
  const folder = source ? join(extensionsDir(), id) : undefined
  if (source && folder) {
    mkdirSync(extensionsDir(), { recursive: true })
    rmSync(folder, { recursive: true, force: true })
    cpSync(source, folder, { recursive: true, filter: (p) => basename(p) !== '.git' })
  }
  const args = req.args.map((a) => (folder ? a.split('{{dir}}').join(folder.replace(/\\/g, '/')) : a))

  // Start it once, the way the agents will, with stand-in values for any keys.
  const launch = launcher(command, args)
  const dummyEnv = Object.fromEntries(keys.map((k) => [k, 'test']))
  const test = await selfTestServer(launch.command, launch.args, dummyEnv, projectPath)
  if (!test.ok && keys.length === 0) {
    if (folder) rmSync(folder, { recursive: true, force: true })
    return {
      ok: false,
      message: `It was not installed: the server failed its start-up check. ${test.error}\nFix that, then call install_extension again.`
    }
  }

  addExtension({
    name,
    description: req.description,
    command,
    args,
    env: {},
    instructions: req.instructions,
    needsKeys: keys,
    folder,
    // A server that needs keys stays off until the user has supplied them.
    enabled: keys.length === 0
  })

  if (keys.length) {
    return {
      ok: true,
      message: `Installed "${name}" but it is switched off until the user adds ${keys.join(', ')} in VibeApp's Extensions screen.${
        test.ok ? ` Start-up check passed; tools: ${test.tools.join(', ') || '(none)'}.` : ' It could not be fully checked without real keys.'
      } Tell them where to add the keys.`
    }
  }
  return {
    ok: true,
    message: `Installed "${name}" and switched it on. Start-up check passed; tools: ${
      test.ok ? test.tools.join(', ') || '(none listed)' : ''
    }. Claude gets the tools from the user's next message; Codex has them on its next hand-off.`
  }
}
