import { dirname, join } from 'path'

/**
 * The SDK locates its native binary relative to its own module URL, which in
 * a packaged app points inside app.asar. Electron's fs patch makes that path
 * pass existsSync, but the OS can't spawn a file inside the archive, so the
 * launch fails. Resolve it ourselves and point at the unpacked copy.
 */
export function resolveClaudeExecutable(): string | undefined {
  try {
    const pkg = `@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}`
    const binary = process.platform === 'win32' ? 'claude.exe' : 'claude'
    const resolved = join(dirname(require.resolve(`${pkg}/package.json`)), binary)
    return resolved.replace(/app\.asar([\\/])/, 'app.asar.unpacked$1')
  } catch {
    return undefined
  }
}
