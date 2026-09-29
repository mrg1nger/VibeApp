/** Recognizable API key formats, with a suggested environment variable name for each. */
export const SECRET_PATTERNS: { label: string; name: string; pattern: RegExp }[] = [
  { label: 'Anthropic API key', name: 'ANTHROPIC_API_KEY', pattern: /\bsk-ant-[A-Za-z0-9_-]{20,}/ },
  { label: 'OpenAI API key', name: 'OPENAI_API_KEY', pattern: /\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{32,}/ },
  { label: 'Stripe secret key', name: 'STRIPE_SECRET_KEY', pattern: /\b[sr]k_live_[A-Za-z0-9]{20,}/ },
  { label: 'Stripe webhook secret', name: 'STRIPE_WEBHOOK_SECRET', pattern: /\bwhsec_[A-Za-z0-9]{20,}/ },
  { label: 'GitHub token', name: 'GITHUB_TOKEN', pattern: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}|\bgithub_pat_[A-Za-z0-9_]{40,}/ },
  { label: 'AWS access key', name: 'AWS_ACCESS_KEY_ID', pattern: /\bAKIA[0-9A-Z]{16}\b/ },
  { label: 'Google API key', name: 'GOOGLE_API_KEY', pattern: /\bAIza[0-9A-Za-z_-]{35}/ },
  { label: 'Slack token', name: 'SLACK_TOKEN', pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}/ },
  { label: 'Discord bot token', name: 'DISCORD_TOKEN', pattern: /\b[MN][A-Za-z\d]{23,25}\.[\w-]{6}\.[\w-]{27,}/ },
  { label: 'Hugging Face token', name: 'HF_TOKEN', pattern: /\bhf_[A-Za-z0-9]{30,}/ },
  { label: 'Supabase service key', name: 'SUPABASE_SERVICE_ROLE_KEY', pattern: /\bsbp_[A-Za-z0-9]{30,}/ },
  { label: 'private key', name: 'PRIVATE_KEY', pattern: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/ }
]

export interface DetectedSecret {
  label: string
  name: string
  value: string
}

export function detectSecrets(text: string): DetectedSecret[] {
  const found: DetectedSecret[] = []
  for (const { label, name, pattern } of SECRET_PATTERNS) {
    const match = new RegExp(pattern.source, 'g')
    for (const m of text.matchAll(match)) {
      if (!found.some((f) => f.value === m[0])) found.push({ label, name, value: m[0] })
    }
  }
  return found
}

/** Environment variables a secret may not replace: the app and the tools need them. */
export const RESERVED_ENV_NAMES =
  /^(PATH|PATHEXT|HOME|USERPROFILE|APPDATA|LOCALAPPDATA|SYSTEMROOT|WINDIR|COMSPEC|TEMP|TMP|PORT|NODE_OPTIONS|NODE_ENV|ELECTRON_.*)$/i

/**
 * Secrets the user's app may need but Claude Code itself must never see:
 * an ANTHROPIC_API_KEY in its environment would switch it from the user's
 * subscription login to billing that key.
 */
export const HIDDEN_FROM_AGENTS = /^(ANTHROPIC_|CLAUDE_|CODEX_|OPENAI_BASE_URL$)/i

export const SECRET_NAME = /^[A-Z_][A-Z0-9_]{0,63}$/
