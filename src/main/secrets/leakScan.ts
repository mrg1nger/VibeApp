import { execFile } from 'child_process'
import { openSync, readSync, closeSync, readFileSync, statSync } from 'fs'
import { join } from 'path'
import { promisify } from 'util'
import type { SecretLeak } from '@shared/types'
import { SECRET_PATTERNS } from '@shared/secretPatterns'

const execFileAsync = promisify(execFile)
const MAX_FILE_BYTES = 1024 * 1024

type Known = { name: string; value: string }[]

function checkLine(text: string, known: Known): string | undefined {
  for (const { name, value } of known) if (text.includes(value)) return name
  for (const { label, pattern } of SECRET_PATTERNS) if (pattern.test(text)) return label
  return undefined
}

/** Secrets in the lines a unified diff adds. */
export function scanDiff(diff: string, known: Known): SecretLeak[] {
  const leaks: SecretLeak[] = []
  let file = ''
  let line = 0
  for (const raw of diff.split('\n')) {
    if (raw.startsWith('+++ ')) {
      file = raw.slice(4).replace(/^b\//, '')
    } else if (raw.startsWith('@@')) {
      line = Number(/\+(\d+)/.exec(raw)?.[1] ?? 0)
    } else if (raw.startsWith('+')) {
      const what = checkLine(raw.slice(1), known)
      if (what && file !== '/dev/null') leaks.push({ file, line, what })
      line++
    } else if (!raw.startsWith('-')) {
      line++
    }
  }
  return leaks
}

function looksBinary(path: string): boolean {
  const fd = openSync(path, 'r')
  try {
    const buffer = Buffer.alloc(8000)
    const n = readSync(fd, buffer, 0, buffer.length, 0)
    return buffer.subarray(0, n).includes(0)
  } finally {
    closeSync(fd)
  }
}

/**
 * Secrets anywhere in the files git would pick up (tracked, or untracked
 * and not ignored) -- i.e. what a push or deployment would upload.
 */
export async function scanProject(projectPath: string, known: Known): Promise<SecretLeak[]> {
  const { stdout } = await execFileAsync('git', ['ls-files', '-co', '--exclude-standard', '-z'], {
    cwd: projectPath,
    windowsHide: true,
    maxBuffer: 64 * 1024 * 1024
  })
  const leaks: SecretLeak[] = []
  for (const file of stdout.split('\0').filter(Boolean)) {
    const full = join(projectPath, file)
    try {
      if (statSync(full).size > MAX_FILE_BYTES || looksBinary(full)) continue
      readFileSync(full, 'utf-8')
        .split('\n')
        .forEach((text, i) => {
          const what = checkLine(text, known)
          if (what) leaks.push({ file, line: i + 1, what })
        })
    } catch {
      // Deleted or unreadable since listing; nothing to upload either way.
    }
  }
  return leaks
}

export function describeLeaks(leaks: SecretLeak[]): string {
  return leaks
    .slice(0, 10)
    .map((l) => `${l.file}:${l.line} (${l.what})`)
    .join('\n')
}
