import { connect } from 'net'
import type { DatabaseSync } from 'node:sqlite'
import { getMeta } from './store'

// How a memory tool process asks the running app to search by meaning. The
// language model lives in the app only (one copy in memory, not one per agent);
// the app listens on a local pipe (searchPipe.ts), not on the network, and says
// where in the shared database. No Electron imports: the memory server bundles this.

/** Where the app's pipe is, written by the app when it starts and removed when it quits. */
export const SEARCH_PIPE_META = 'search_pipe'

export interface SearchPipeAddress {
  path: string
  /** Sent with every question; the app answers nobody else. */
  token: string
  pid: number
}

export interface SearchQuestion {
  kind: 'facts' | 'code'
  projectId: string
  text: string
  limit: number
}

const ANSWER_WITHIN_MS = 6000

/**
 * The ids of the facts (or the paths of the files) the app finds, best first. Null when
 * the app can't be asked (not running, too slow, an older version): search by keyword then.
 */
export function askApp(db: DatabaseSync, question: SearchQuestion): Promise<string[] | null> {
  let address: SearchPipeAddress
  try {
    address = JSON.parse(getMeta(db, SEARCH_PIPE_META) ?? 'null') as SearchPipeAddress
  } catch {
    return Promise.resolve(null)
  }
  if (!address?.path || !address.token) return Promise.resolve(null)
  return new Promise((resolve) => {
    let received = ''
    let done = false
    const finish = (found: string[] | null): void => {
      if (done) return
      done = true
      clearTimeout(timer)
      socket.destroy()
      resolve(found)
    }
    const socket = connect(address.path)
    const timer = setTimeout(() => finish(null), ANSWER_WITHIN_MS)
    socket.setEncoding('utf8')
    socket.on('connect', () => socket.write(`${JSON.stringify({ token: address.token, ...question })}\n`))
    socket.on('data', (chunk: string) => {
      received += chunk
      const end = received.indexOf('\n')
      if (end < 0) return
      try {
        const answer = JSON.parse(received.slice(0, end)) as { found?: unknown }
        finish(Array.isArray(answer.found) ? answer.found.filter((x): x is string => typeof x === 'string') : null)
      } catch {
        finish(null)
      }
    })
    socket.on('error', () => finish(null))
    socket.on('close', () => finish(null))
  })
}
