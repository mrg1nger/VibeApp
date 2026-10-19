#!/usr/bin/env node
// VibeApp's MCP server: lets Claude Code (or any MCP client) use a running
// VibeApp on this computer, through its Remote access API. VibeApp copies this
// file into its data folder; add it to Claude Code with
//   claude mcp add vibeapp -- node "<VibeApp data folder>/vibeapp-mcp.cjs"
// It reads the address and token VibeApp writes next to it (remote-api.json),
// so Remote access must be switched on in VibeApp's Settings.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import { readFileSync } from 'fs'
import { join } from 'path'
import { request as httpRequest } from 'http'
import { request as httpsRequest } from 'https'

const API_FILE = process.env.VIBEAPP_API_FILE || join(__dirname, 'remote-api.json')

function config() {
  try {
    return JSON.parse(readFileSync(API_FILE, 'utf-8'))
  } catch {
    throw new Error("VibeApp's Remote access isn't on. Switch it on in VibeApp: Settings, Remote access.")
  }
}

/** One HTTP(S) request to VibeApp. A self-signed certificate is trusted only if it's VibeApp's own. */
function call(method, path, body, onData) {
  const { url, token, ca } = config()
  const target = new URL(path, url)
  const send = target.protocol === 'https:' ? httpsRequest : httpRequest
  return new Promise((resolve, reject) => {
    const req = send(
      target,
      {
        method,
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        ...(ca ? { ca } : {})
      },
      (res) => {
        if (onData) {
          if (res.statusCode !== 200) return reject(new Error(`VibeApp answered ${res.statusCode}`))
          res.setEncoding('utf-8')
          res.on('data', onData)
          res.on('end', () => resolve(null))
          return resolve(res)
        }
        let text = ''
        res.setEncoding('utf-8')
        res.on('data', (c) => (text += c))
        res.on('end', () => {
          let parsed = {}
          try {
            parsed = JSON.parse(text)
          } catch {
            // not JSON
          }
          if (res.statusCode !== 200) reject(new Error(parsed.error || `VibeApp answered ${res.statusCode}`))
          else resolve(parsed.result ?? null)
        })
      }
    )
    req.on('error', (err) =>
      reject(new Error(`Couldn't reach VibeApp (${err.message}). Is it running with Remote access on?`))
    )
    if (body !== undefined) req.write(JSON.stringify(body))
    req.end()
  })
}

const invoke = (channel, ...args) => call('POST', '/api/invoke', { channel, args })

// ---- events: one stream, buffered per project ------------------------------------------

const buffers = new Map() // projectId -> events since last read
let stream = null
let waiters = []

function ensureStream() {
  if (stream) return stream
  let partial = ''
  stream = call('GET', '/api/events', undefined, (chunk) => {
    partial += chunk
    const blocks = partial.split('\n\n')
    partial = blocks.pop()
    for (const block of blocks) {
      const line = block.split('\n').find((l) => l.startsWith('data: '))
      if (!line) continue
      let message
      try {
        message = JSON.parse(line.slice(6))
      } catch {
        continue
      }
      const [projectId, payload] = message.args ?? []
      if (message.channel !== 'vibe:chat:event' && message.channel !== 'vibe:chat:confirmationRequest') continue
      const entry = message.channel === 'vibe:chat:event' ? { event: payload } : { prompt: payload }
      if (!buffers.has(projectId)) buffers.set(projectId, [])
      buffers.get(projectId).push(entry)
      for (const w of waiters) w()
    }
  })
    .then((res) => {
      // VibeApp restarted or stopped: reconnect on the next call.
      res.on('close', () => (stream = null))
      return res
    })
    .catch((err) => {
      stream = null
      throw err
    })
  return stream
}

/** Waits until the project's request finishes, or Claude asks something, or time runs out. */
async function collect(projectId, timeoutMs) {
  const seen = []
  const end = Date.now() + timeoutMs
  for (;;) {
    const buf = buffers.get(projectId) ?? []
    buffers.set(projectId, [])
    for (const entry of buf) {
      seen.push(entry)
      if (entry.prompt) return { status: 'waiting_for_answer', seen }
      if (entry.event?.type === 'turn_complete') return { status: 'done', seen }
    }
    const left = end - Date.now()
    if (left <= 0) return { status: 'still_running', seen }
    await new Promise((r) => {
      const t = setTimeout(r, Math.min(left, 5000))
      waiters.push(() => {
        clearTimeout(t)
        r()
      })
    })
    waiters = []
  }
}

function describe(result) {
  const lines = []
  for (const { event, prompt } of result.seen) {
    if (prompt) {
      if (prompt.questions?.length) {
        lines.push(`QUESTION (prompt id ${prompt.id}):`)
        for (const q of prompt.questions) lines.push(`- ${q.question} Options: ${q.options.map((o) => o.label).join(' / ')}`)
      } else {
        lines.push(`PERMISSION NEEDED (prompt id ${prompt.id}): ${prompt.reason} ${JSON.stringify(prompt.input).slice(0, 300)}`)
      }
      continue
    }
    switch (event?.type) {
      case 'assistant_text':
        lines.push(event.text)
        break
      case 'tool_call':
        if (!event.parentToolUseId) lines.push(`[${event.friendlyLabel.slice(0, 200)}]`)
        break
      case 'route':
        lines.push(`(${event.label}: ${event.reason})`)
        break
      case 'plan_proposed':
        lines.push(`PLAN PROPOSED (plan id ${event.toolUseId}):
${event.plan}

To build it call approve_plan; to change it call send_message with mode "plan" and what should change.`)
        break
      case 'plan_progress':
        lines.push(`(Step ${event.step}: ${event.status})`)
        break
      case 'review_result':
        lines.push(`(Codex review: ${event.summary})`)
        break
      case 'takeover_started':
        lines.push('(Claude is out of plan: Codex is handling this directly.)')
        break
      case 'takeover_offer':
        lines.push('(Claude is out of plan. VibeApp is asking whether Codex should do it; answer in the app.)')
        break
      case 'error':
        lines.push(`ERROR: ${event.message}`)
        break
      case 'stopped':
        lines.push('(Stopped.)')
        break
      case 'usage':
        lines.push(`(${event.steps} steps · ${event.fresh} new · ${event.cached} cached · ${event.output} written)`)
        break
    }
  }
  const status =
    result.status === 'done'
      ? 'Finished.'
      : result.status === 'waiting_for_answer'
        ? 'Waiting for an answer: call answer_prompt, then wait_for_reply.'
        : 'Still working: call wait_for_reply to keep waiting.'
  return [...lines, '', status].join('\n').trim()
}

async function findProject(nameOrId) {
  const projects = await invoke('vibe:project:list')
  const want = String(nameOrId).toLowerCase()
  const found =
    projects.find((p) => p.id === nameOrId) ??
    projects.find((p) => p.name.toLowerCase() === want) ??
    projects.find((p) => p.name.toLowerCase().includes(want))
  if (!found) throw new Error(`No project called "${nameOrId}". Projects: ${projects.map((p) => p.name).join(', ') || 'none'}`)
  return found
}

const text = (t) => ({ content: [{ type: 'text', text: t }] })
const fail = (err) => ({ content: [{ type: 'text', text: err.message }], isError: true })
const guard = (fn) => async (args) => {
  try {
    return await fn(args)
  } catch (err) {
    return fail(err)
  }
}

// ---- tools -----------------------------------------------------------------------------

const server = new McpServer({ name: 'vibeapp', version: '1.0.0' })

server.registerTool(
  'list_projects',
  { description: 'List the projects in VibeApp (name, id, folder).', inputSchema: {} },
  guard(async () => {
    const projects = await invoke('vibe:project:list')
    return text(projects.map((p) => `${p.name} (id ${p.id}) - ${p.path}`).join('\n') || 'No projects yet.')
  })
)

server.registerTool(
  'send_message',
  {
    description:
      "Send a message to a project's chat in VibeApp, as if typed there, and wait for the reply. VibeApp's Claude (working with Codex) does the work in that project; the desktop window shows it live. mode: 'build' (make changes), 'plan' (Claude proposes a plan and changes nothing; then call approve_plan to build it), 'ask' (answer only, change nothing) or 'auto' (VibeApp decides; plain questions are answered as Ask).",
    inputSchema: {
      project: z.string().describe('Project name or id'),
      message: z.string(),
      mode: z.enum(['auto', 'build', 'plan', 'ask']).optional(),
      timeout_seconds: z.number().optional().describe('How long to wait for the reply (default 600).')
    }
  },
  guard(async ({ project, message, mode = 'auto', timeout_seconds = 600 }) => {
    const p = await findProject(project)
    await ensureStream()
    buffers.set(p.id, [])
    if (mode === 'ask') await invoke('vibe:chat:ask', p.id, p.path, message)
    else if (mode === 'plan') await invoke('vibe:chat:send', p.id, p.path, message, undefined, undefined, true, { mode: 'plan' })
    else await invoke('vibe:chat:send', p.id, p.path, message, undefined, undefined, mode === 'build')
    return text(describe(await collect(p.id, timeout_seconds * 1000)))
  })
)

server.registerTool(
  'wait_for_reply',
  {
    description: "Keep waiting for a project's current request to finish (after send_message said it was still working, or after answering a prompt).",
    inputSchema: { project: z.string(), timeout_seconds: z.number().optional() }
  },
  guard(async ({ project, timeout_seconds = 600 }) => {
    const p = await findProject(project)
    await ensureStream()
    return text(describe(await collect(p.id, timeout_seconds * 1000)))
  })
)

server.registerTool(
  'approve_plan',
  {
    description: "Approve the plan VibeApp's Claude proposed for a project (after send_message with mode 'plan'), so it gets built, and wait for the result.",
    inputSchema: { project: z.string(), timeout_seconds: z.number().optional() }
  },
  guard(async ({ project, timeout_seconds = 600 }) => {
    const p = await findProject(project)
    const entries = await invoke('vibe:chat:loadTranscript', p.id)
    const decided = new Set(entries.filter((e) => e.event?.type === 'plan_decided').map((e) => e.event.toolUseId))
    const pending = entries.filter((e) => e.event?.type === 'plan_proposed' && !decided.has(e.event.toolUseId)).at(-1)?.event
    if (!pending) return text('There is no plan waiting for approval in that project.')
    await ensureStream()
    buffers.set(p.id, [])
    await invoke('vibe:chat:planDecided', p.id, pending.toolUseId, 'approved')
    await invoke('vibe:chat:send', p.id, p.path, 'Approved the plan. Go ahead and build it.', undefined, undefined, true, { approvedPlan: pending.plan })
    return text(describe(await collect(p.id, timeout_seconds * 1000)))
  })
)

server.registerTool(
  'answer_prompt',
  {
    description:
      'Answer a prompt VibeApp is showing for a project: an Allow/Deny permission (allow true or false) or Claude\'s question (answers: question text -> chosen option label).',
    inputSchema: {
      project: z.string(),
      prompt_id: z.string(),
      allow: z.boolean().optional(),
      answers: z.record(z.string(), z.string()).optional()
    }
  },
  guard(async ({ project, prompt_id, allow, answers }) => {
    const p = await findProject(project)
    await invoke('vibe:chat:confirmationResponse', p.id, prompt_id, answers ? true : allow !== false, answers)
    return text('Answered. Call wait_for_reply to see what happens next.')
  })
)

server.registerTool(
  'stop',
  { description: "Stop a project's running request (like pressing Stop).", inputSchema: { project: z.string() } },
  guard(async ({ project }) => {
    const p = await findProject(project)
    await invoke('vibe:chat:stop', p.id)
    return text('Stopped.')
  })
)

server.registerTool(
  'read_chat',
  {
    description: "Read the latest part of a project's chat in VibeApp (what was asked, replies, and what was done).",
    inputSchema: { project: z.string(), last: z.number().optional().describe('How many entries (default 40).') }
  },
  guard(async ({ project, last = 40 }) => {
    const p = await findProject(project)
    const entries = await invoke('vibe:chat:loadTranscript', p.id)
    const lines = []
    for (const e of entries) {
      if (e.direction === 'user' && e.text) lines.push(`USER: ${e.text}`)
      else if (e.event?.type === 'assistant_text') lines.push(`VIBEAPP: ${e.event.text}`)
      else if (e.event?.type === 'tool_call' && !e.event.parentToolUseId) lines.push(`  [${e.event.friendlyLabel.slice(0, 160)}]`)
      else if (e.event?.type === 'error') lines.push(`  ERROR: ${e.event.message}`)
    }
    return text(lines.slice(-last).join('\n') || 'Nothing in this chat yet.')
  })
)

server.registerTool(
  'compact',
  { description: "Compact a project's long conversation in VibeApp (saves memory first).", inputSchema: { project: z.string() } },
  guard(async ({ project }) => {
    const p = await findProject(project)
    const r = await invoke('vibe:chat:compactNow', p.id, p.path)
    return text(r?.ok ? `Compacted: about ${r.before} tokens became ${r.after}.` : r?.message ?? 'Could not compact.')
  })
)

server.registerTool(
  'memory',
  {
    description: "Read a project's memory in VibeApp: its project brief and remembered facts (optionally only those matching a search).",
    inputSchema: { project: z.string(), search: z.string().optional() }
  },
  guard(async ({ project, search }) => {
    const p = await findProject(project)
    const [facts, brief] = await Promise.all([invoke('vibe:memory:list', p.id, 'project', false), invoke('vibe:memory:brief', p.id)])
    const want = (search ?? '').toLowerCase()
    const shown = facts.filter((f) => !want || f.text.toLowerCase().includes(want))
    return text(
      [
        brief?.text ? `PROJECT BRIEF\n${brief.text}` : '(No project brief yet.)',
        '',
        `FACTS (${shown.length})`,
        ...shown.map((f) => `- [${f.category}${f.key ? ', key' : ''}] ${f.text}`)
      ].join('\n')
    )
  })
)

server.registerTool(
  'todos',
  {
    description:
      "A project's to-do list in VibeApp (its Notes tab), and optionally change it: add an item, tick one off (done), or put one back (undone). Items are matched by their id or their text.",
    inputSchema: {
      project: z.string(),
      add: z.string().optional().describe('A new to-do, as one short line.'),
      done: z.string().optional().describe('The id or text of an item to tick off.'),
      undone: z.string().optional().describe('The id or text of a finished item to put back on the list.')
    }
  },
  guard(async ({ project, add, done, undone }) => {
    const p = await findProject(project)
    let list = await invoke('vibe:todos:list', p.id)
    const find = (key, wantDone) => {
      const k = key.trim().toLowerCase()
      const pool = list.filter((t) => t.done === wantDone)
      return pool.find((t) => t.id === key.trim()) ?? pool.find((t) => t.text.toLowerCase() === k) ?? pool.find((t) => t.text.toLowerCase().includes(k))
    }
    const changes = []
    if (add?.trim()) {
      list = await invoke('vibe:todos:add', p.id, add)
      changes.push(`Added: ${add.trim()}`)
    }
    for (const [key, wantDone] of [
      [done, false],
      [undone, true]
    ]) {
      if (!key?.trim()) continue
      const item = find(key, wantDone)
      if (!item) throw new Error(`No ${wantDone ? 'finished' : 'open'} to-do matches "${key}".`)
      list = await invoke('vibe:todos:update', p.id, item.id, { done: !wantDone })
      changes.push(`${wantDone ? 'Put back' : 'Ticked off'}: ${item.text}`)
    }
    const open = list.filter((t) => !t.done)
    const finished = list.filter((t) => t.done)
    return text(
      [
        ...changes,
        changes.length ? '' : undefined,
        `OPEN (${open.length})`,
        ...open.map((t) => `- ${t.text} (id ${t.id}${t.source !== 'user' ? `, from ${t.source}` : ''})`),
        finished.length ? `\nDONE (${finished.length})` : undefined,
        ...finished.slice(0, 10).map((t) => `- ${t.text}`)
      ]
        .filter((l) => l !== undefined)
        .join('\n')
    )
  })
)

server.registerTool(
  'notes',
  {
    description: "Read a project's notes in VibeApp (its Notes tab), or replace them with new text.",
    inputSchema: {
      project: z.string(),
      replace_with: z.string().optional().describe('New text for the whole notes page (replaces what is there).')
    }
  },
  guard(async ({ project, replace_with }) => {
    const p = await findProject(project)
    if (replace_with !== undefined) {
      await invoke('vibe:notes:set', p.id, replace_with)
      return text('Notes saved.')
    }
    const notes = await invoke('vibe:notes:get', p.id)
    return text(notes.text.trim() ? notes.text : '(No notes yet.)')
  })
)

server.registerTool(
  'usage',
  { description: 'How much of the Claude and Codex plans is left, as VibeApp shows it.', inputSchema: {} },
  guard(async () => {
    const out = []
    for (const cli of ['claude', 'codex']) {
      const u = await invoke('vibe:usage:get', cli, false)
      out.push(
        u.status === 'ok'
          ? `${cli}: ${u.windows.map((w) => `${w.label} ${Math.round(100 - w.usedPercent)}% left`).join(', ')}`
          : `${cli}: ${u.message ?? 'unavailable'}`
      )
    }
    return text(out.join('\n'))
  })
)

void server.connect(new StdioServerTransport())
