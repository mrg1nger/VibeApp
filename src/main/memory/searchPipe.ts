import { createServer, type Server, type Socket } from 'net'
import { randomBytes, timingSafeEqual } from 'crypto'
import { chmodSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { memoryDb } from './paths'
import { fillVectorsInBackground, findCode, recallFacts, searchStatus } from './meaning'
import { SEARCH_PIPE_META, type SearchPipeAddress, type SearchQuestion } from './searchClient'

/** Where the app notes how memory is searched (a SearchStatus), for looking into "why didn't it find that". */
export const SEARCH_STATUS_META = 'search_status'
import { getMeta, setMeta } from './store'

// The app's end of searchClient.ts: the memory tools of every agent (Claude,
// Codex, Cline) ask here for a search by meaning, so the language model is
// loaded once, in the app. A local pipe, not a network port: nothing outside
// this computer can reach it, and every question must carry the token the app
// wrote into the memory database. Answers are fact ids and file paths only;
// the asker reads the rest from the database itself.

let server: Server | undefined
let address: SearchPipeAddress | undefined

const MAX_QUESTION_CHARS = 20_000

function same(a: string, b: string): boolean {
  const x = Buffer.from(a)
  const y = Buffer.from(b)
  return x.length === y.length && timingSafeEqual(x, y)
}

async function answer(line: string): Promise<string[] | null> {
  const q = JSON.parse(line) as Partial<SearchQuestion> & { token?: string }
  if (!address || typeof q.token !== 'string' || !same(q.token, address.token)) return null
  if (typeof q.projectId !== 'string' || typeof q.text !== 'string' || !q.projectId) return null
  const limit = Math.min(30, Math.max(1, Math.floor(Number(q.limit) || 10)))
  if (q.kind === 'facts') return (await recallFacts(memoryDb(), q.projectId, q.text, limit)).map((f) => f.id)
  if (q.kind === 'code') return (await findCode(memoryDb(), q.projectId, q.text, limit)).map((f) => f.path)
  return null
}

function serve(socket: Socket): void {
  let received = ''
  let answered = false
  socket.setEncoding('utf8')
  socket.setTimeout(15_000, () => socket.destroy())
  socket.on('error', () => socket.destroy())
  socket.on('data', (chunk: string) => {
    if (answered) return
    received += chunk
    if (received.length > MAX_QUESTION_CHARS) return void socket.destroy()
    const end = received.indexOf('\n')
    if (end < 0) return
    answered = true
    answer(received.slice(0, end))
      .catch(() => null)
      .then((found) => socket.end(`${JSON.stringify({ found })}\n`))
  })
}

/**
 * Starts listening and tells the memory tools where (done when the returned promise settles);
 * then makes any missing vectors in the background. Never throws.
 */
export function startMemorySearch(): Promise<void> {
  if (server) return Promise.resolve()
  const name = `vibeapp-memory-${randomBytes(8).toString('hex')}`
  const path = process.platform === 'win32' ? `\\\\.\\pipe\\${name}` : join(tmpdir(), `${name}.sock`)
  const listening = createServer(serve)
  server = listening
  // Not in the way of starting up: the first run after an update makes a vector for everything remembered.
  setTimeout(() => {
    void (async () => {
      try {
        const db = memoryDb()
        await fillVectorsInBackground(db)
        setMeta(db, SEARCH_STATUS_META, JSON.stringify(await searchStatus(db)))
      } catch (err) {
        console.warn('Making the search vectors failed:', (err as Error).message)
      }
    })()
  }, 4000).unref()
  return new Promise((resolve) => {
    listening.on('error', (err) => {
      console.warn('The memory search pipe failed (agents search by keyword):', err.message)
      resolve()
    })
    listening.listen(path, () => {
      try {
        // A socket file is made the user's alone. Either way, the token is what lets a question in.
        if (process.platform !== 'win32') chmodSync(path, 0o600)
        address = { path, token: randomBytes(32).toString('hex'), pid: process.pid }
        setMeta(memoryDb(), SEARCH_PIPE_META, JSON.stringify(address))
      } catch (err) {
        console.warn('The memory search pipe could not be announced:', (err as Error).message)
      }
      resolve()
    })
  })
}

export function stopMemorySearch(): void {
  if (!server) return
  try {
    // Only our own entry: a second copy of the app with the same data folder may have written a newer one.
    const db = memoryDb()
    const current = JSON.parse(getMeta(db, SEARCH_PIPE_META) ?? 'null') as SearchPipeAddress | null
    if (current?.pid === process.pid) db.prepare('DELETE FROM meta WHERE key = ?').run(SEARCH_PIPE_META)
  } catch {
    // The entry is harmless when stale: nothing answers there, and the tools search by keyword.
  }
  server.close()
  if (address && process.platform !== 'win32') rmSync(address.path, { force: true })
  server = undefined
  address = undefined
}
