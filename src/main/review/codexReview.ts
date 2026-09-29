import type { ReviewFinding } from '@shared/types'
import { runCodexExec } from '../cli/codexExec'
import { diffSnapshots } from '../git/snapshots'
import { getSettings } from '../settings/store'

const MAX_DIFF_CHARS = 80_000

// Strict-mode structured output: every property required, no extras.
const REVIEW_SCHEMA = {
  type: 'object',
  properties: {
    summary: { type: 'string' },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          severity: { type: 'string', enum: ['high', 'medium', 'low'] },
          file: { type: 'string' },
          line: { type: ['integer', 'null'] },
          title: { type: 'string' },
          detail: { type: 'string' }
        },
        required: ['severity', 'file', 'line', 'title', 'detail'],
        additionalProperties: false
      }
    }
  },
  required: ['summary', 'findings'],
  additionalProperties: false
}

export interface ReviewResult {
  summary: string
  findings: ReviewFinding[]
}

export function reviewPrompt(request: string, diff: string): string {
  const truncated = diff.length > MAX_DIFF_CHARS
  return `You are reviewing code changes that another AI coding agent (Claude) just made in this project. You're in a read-only sandbox: read any files you need for context, but don't change anything.

What the user asked Claude for:
${request.slice(0, 2000)}

The changes${truncated ? ' (diff truncated; read the files for the rest)' : ''}:
\`\`\`diff
${diff.slice(0, MAX_DIFF_CHARS)}
\`\`\`

Report only real problems in these changes: bugs, crashes, broken or missing functionality the user asked for, security issues (exposed secrets or API keys, injection, unsafe handling of user input), and data loss. Don't report style preferences, naming, or matters of taste. Severity: high = broken, insecure, or loses data; medium = likely bug or edge case that will bite; low = minor. Use line: null when a problem isn't tied to one line.

If the changes look correct, return an empty findings list. The summary is one or two plain-English sentences for a non-programmer.`
}

/** The change between two snapshots, or '' when nothing changed. */
export function changesBetween(projectPath: string, before: string, after: string): Promise<string> {
  return diffSnapshots(projectPath, before, after)
}

/** Has Codex review a diff. Throws if Codex can't run or returns something unusable. */
export async function reviewChanges(
  projectPath: string,
  diff: string,
  request: string,
  signal?: AbortSignal
): Promise<ReviewResult> {
  const result = await runCodexExec({
    signal,
    prompt: reviewPrompt(request, diff),
    cwd: projectPath,
    readOnly: true,
    ephemeral: true,
    outputSchema: REVIEW_SCHEMA,
    model: getSettings().codexModel ?? undefined,
    timeoutMs: 300_000
  })
  if (result.exitCode !== 0 && !result.finalMessage) {
    throw new Error(`Codex exited with code ${result.exitCode}`)
  }
  let parsed: ReviewResult
  try {
    parsed = JSON.parse(result.finalMessage) as ReviewResult
  } catch {
    throw new Error("Codex's review wasn't in the expected format")
  }
  return {
    summary: String(parsed.summary ?? ''),
    findings: Array.isArray(parsed.findings) ? parsed.findings : []
  }
}

/** The follow-up message asking Claude to deal with the review. */
export function fixPrompt(findings: ReviewFinding[]): string {
  const list = findings
    .map(
      (f, i) =>
        `${i + 1}. [${f.severity}] ${f.file}${f.line ? `:${f.line}` : ''}: ${f.title}. ${f.detail}`
    )
    .join('\n')
  return `[VibeApp note: this message is automatic, not from the user. Codex reviewed the changes you just made and flagged the issues below. Check each against the code: fix the real problems, and for any you believe are false alarms, say so in one line with the reason. Then briefly tell the user what you changed.]

${list}`
}
