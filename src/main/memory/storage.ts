import {
  closeSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync
} from 'fs'
import { dirname } from 'path'
import type { MemoryFact } from '@shared/types'

// Shared by the Electron main process (Memory screen) and every memory MCP
// server process (one per Claude session, one per Codex run). Several of
// those can write the same file at once, so every change is a locked
// read-modify-write, and files are replaced atomically so a reader never
// sees half a file.

interface MemoryFile {
  facts: MemoryFact[]
}

const LOCK_STALE_MS = 10_000
const LOCK_WAIT_MS = 5_000

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

function withLock<T>(path: string, fn: () => T): T {
  const dir = dirname(path)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  const lock = `${path}.lock`
  const started = Date.now()
  for (;;) {
    try {
      const fd = openSync(lock, 'wx')
      writeSync(fd, String(process.pid))
      closeSync(fd)
      break
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
      // A holder only keeps the lock for milliseconds; one this old belongs
      // to a process that died mid-write.
      let age = 0
      try {
        age = Date.now() - statSync(lock).mtimeMs
      } catch {
        continue // released between our attempts
      }
      if (age > LOCK_STALE_MS || Date.now() - started > LOCK_WAIT_MS) {
        rmSync(lock, { force: true })
        continue
      }
      sleepSync(10 + Math.random() * 20)
    }
  }
  try {
    return fn()
  } finally {
    rmSync(lock, { force: true })
  }
}

function readMemoryFile(path: string): MemoryFile {
  if (!existsSync(path)) return { facts: [] }
  try {
    const data = JSON.parse(readFileSync(path, 'utf-8')) as MemoryFile
    return Array.isArray(data.facts) ? data : { facts: [] }
  } catch {
    return { facts: [] }
  }
}

function writeMemoryFile(path: string, data: MemoryFile): void {
  const temp = `${path}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`
  writeFileSync(temp, JSON.stringify(data, null, 2), 'utf-8')
  // Windows refuses to replace a file another process has open for reading
  // at that instant; those reads are brief, so retry.
  for (let attempt = 0; ; attempt++) {
    try {
      renameSync(temp, path)
      return
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (attempt >= 50 || (code !== 'EPERM' && code !== 'EBUSY' && code !== 'EACCES')) {
        rmSync(temp, { force: true })
        throw err
      }
      sleepSync(10)
    }
  }
}

/** Locked read-modify-write of one memory file. */
function mutate<T>(path: string, change: (data: MemoryFile) => T): T {
  return withLock(path, () => {
    let data: MemoryFile
    try {
      data = existsSync(path) ? (JSON.parse(readFileSync(path, 'utf-8')) as MemoryFile) : { facts: [] }
      if (!Array.isArray(data.facts)) throw new Error('no facts array')
    } catch {
      // Don't overwrite a file we can't read with a near-empty one: keep a
      // copy so nothing is silently lost.
      copyFileSync(path, `${path}.unreadable-${Date.now()}`)
      data = { facts: [] }
    }
    const result = change(data)
    writeMemoryFile(path, data)
    return result
  })
}

export function addFact(path: string, text: string, source: MemoryFact['source'] | string): MemoryFact {
  const fact: MemoryFact = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    text,
    createdAt: new Date().toISOString(),
    source: source as MemoryFact['source']
  }
  mutate(path, (data) => data.facts.push(fact))
  return fact
}

export function listFacts(path: string): MemoryFact[] {
  return readMemoryFile(path).facts
}

export function deleteFact(path: string, id: string): boolean {
  return mutate(path, (data) => {
    const before = data.facts.length
    data.facts = data.facts.filter((f) => f.id !== id)
    return data.facts.length !== before
  })
}

export function updateFact(path: string, id: string, text: string): boolean {
  return mutate(path, (data) => {
    const fact = data.facts.find((f) => f.id === id)
    if (fact) fact.text = text
    return !!fact
  })
}
