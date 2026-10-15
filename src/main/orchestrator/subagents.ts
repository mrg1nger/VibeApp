import type { AgentDefinition } from '@anthropic-ai/claude-agent-sdk'

// Helpers Claude can start for a self-contained job, each with its own small
// conversation, so the main (often huge) conversation isn't re-read for them.
// The project folder is written into every definition: a sub-agent doesn't
// see this chat, and left to guess it may search somewhere else entirely.

const MEMORY_LOOKUPS = ['mcp__vibe_memory__where', 'mcp__vibe_memory__recall', 'mcp__vibe_memory__history']

export function buildSubagents(projectPath: string): Record<string, AgentDefinition> {
  const scope = `The project folder is ${projectPath}. Work ONLY inside it: start every search there and never read or search anywhere else. If you can't find something in it, say so rather than guessing. You can't see the conversation that started you, so rely on the task you were given and on the files.`

  return {
    explorer: {
      description:
        'Read-only searcher on a fast, cheap model. Use it to find where something is defined or how a feature works across several files, or to survey part of the code, instead of reading many files yourself. Give it a precise question; it returns file paths, line numbers and short quotes.',
      prompt: `You answer one question about a software project by searching its files. You never change anything. ${scope} Search with the where tool (a map of the source files) first, then Grep/Glob/Read. Answer in a short list: file, line, what it does. Quote only the lines that matter.`,
      tools: ['Read', 'Grep', 'Glob', ...MEMORY_LOOKUPS],
      model: 'haiku'
    },
    reviewer: {
      description:
        'Reads code and reports real problems: bugs, security holes, broken edge cases, and anything that contradicts the conventions you pass along. Use it after a large or risky change. Tell it which files or what change to review and which rules apply. It never edits.',
      prompt: `You review code changes for correctness and security. You never change anything. ${scope} Check the files you were pointed at, and the code around them that they depend on. Report only real problems, most serious first, each with file and line and a one-sentence reason. If it looks fine, say so in one line. Don't pad with style opinions.`,
      tools: ['Read', 'Grep', 'Glob', ...MEMORY_LOOKUPS],
      model: 'sonnet'
    },
    'test-runner': {
      description:
        "Runs the project's tests or checks (or a command you name) and reports the outcome briefly: what passed, what failed, and the relevant error lines. Use it when the output would be long, so it doesn't fill your conversation.",
      prompt: `You run the project's tests or a given check command and report concisely. ${scope} Use package.json scripts or the command you were given. Don't fix anything or edit files; just run and report: pass/fail counts, then each failure's name and its key error lines (not the whole log). If there is no test setup, say so.`,
      tools: ['Read', 'Grep', 'Glob', 'Bash'],
      model: 'haiku'
    },
    // Replaces the built-in general helper so it, too, knows where the project is.
    'general-purpose': {
      description:
        'General helper for a self-contained task that needs searching and several steps (research, a large read-through, a contained piece of work).',
      prompt: `You carry out one self-contained task for a software project and report the result concisely. ${scope} Report exact file names and values.`
    }
  }
}
