// Prints a running VibeApp's usage report through its Remote access API (read-only).
//
//   npm run usage -- [--days 7] [--project yay] [--json] [--api <file>]
//
// --api is a connection file like the one VibeApp writes for its MCP server
// ({ url, token, ca }); the default is this computer's own VibeApp. Point it at
// another computer's file (e.g. a paired DevBox) to read that one. The token is
// never printed.

import { existsSync, readFileSync } from 'node:fs'
import { request as httpsRequest } from 'node:https'
import { request as httpRequest } from 'node:http'
import { join } from 'node:path'

const args = process.argv.slice(2)
const opt = (name) => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 ? args[i + 1] : undefined
}
const days = Number(opt('days') ?? 7)
const project = opt('project')
const json = args.includes('--json')

const candidates = [
  opt('api'),
  process.env.VIBEAPP_API_FILE,
  process.env.APPDATA && join(process.env.APPDATA, 'VibeApp', 'remote-api.json'),
  process.env.APPDATA && join(process.env.APPDATA, 'vibeapp', 'remote-api.json')
].filter(Boolean)
const apiFile = candidates.find((f) => existsSync(f))
if (!apiFile) {
  console.error(`No connection file found (tried ${candidates.join(', ')}). Turn on Remote access in VibeApp's Settings, or pass --api <file>.`)
  process.exit(1)
}
const { url, token, ca } = JSON.parse(readFileSync(apiFile, 'utf-8'))

function invoke(channel, ...rest) {
  const target = new URL('/api/invoke', url)
  const send = target.protocol === 'https:' ? httpsRequest : httpRequest
  return new Promise((resolve, reject) => {
    const req = send(target, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, ...(ca ? { ca } : {}) }, (res) => {
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
        res.statusCode === 200 ? resolve(parsed.result) : reject(new Error(parsed.error || `VibeApp answered ${res.statusCode}`))
      })
    })
    req.on('error', (err) => reject(new Error(`Couldn't reach VibeApp at ${url} (${err.message}). Is it running with Remote access on?`)))
    req.end(JSON.stringify({ channel, args: rest }))
  })
}

try {
  let projectId
  if (project) {
    const list = await invoke('vibe:project:list')
    const found = list.find((p) => p.id === project || p.name.toLowerCase() === project.toLowerCase())
    if (!found) throw new Error(`No project called "${project}". Projects: ${list.map((p) => p.name).join(', ')}`)
    projectId = found.id
  }
  if (json) console.log(JSON.stringify(await invoke('vibe:usage:requests', days, projectId), null, 1))
  else console.log(await invoke('vibe:usage:report', days, projectId))
} catch (err) {
  console.error(err.message)
  process.exit(1)
}
