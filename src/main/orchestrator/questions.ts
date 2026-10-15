// Spots a message that is only a question about the project, so it can be
// answered by the cheap Ask path instead of the full coding session. It is
// deliberately cautious: when unsure, the message stays a normal Build request.

const ACK = /^(?:ok|okay|looks good|looks great|great|good|thanks|thank you|thx|nice|cool|awesome|perfect|got it|sounds good|yep|yes|alright)\W*$/i

const CHANGE_WORDS =
  /\b(add|change|make|fix|build|create|update|remove|delete|implement|refactor|rename|write|install|deploy|publish|replace|improve|redesign|tweak|adjust|increase|decrease|enable|disable|convert|integrate|optimi[sz]e|commit|push|revert|undo|generate|rewrite|swap|hook up|wire up|set up|clean up)\b/i

const QUESTION_PREFIX = /^(?:quick question|just a question|question|real quick|just wondering|curious)\b[\s:,.-]*/i

const QUESTION_WORD =
  /^(?:what|what's|whats|which|who|whom|whose|where|when|why|how|is|are|was|were|do|does|did|can|could|would|will|should|has|have|any|tell me)\b/i

const MAX_CHARS = 400

/** True when the whole message is a plain question (nothing asked to be changed). */
export function isPlainQuestion(text: string): boolean {
  const trimmed = text.trim()
  if (!trimmed || trimmed.length > MAX_CHARS || !trimmed.includes('?')) return false
  if (CHANGE_WORDS.test(trimmed)) return false
  // Code or paths mean it's about specifics; leave those to the full session.
  if (/```/.test(trimmed)) return false

  const sentences = trimmed.split(/(?<=[.!?])\s+/).map((s) => s.trim()).filter(Boolean)
  let questions = 0
  for (const sentence of sentences) {
    if (ACK.test(sentence)) continue
    const body = sentence.replace(QUESTION_PREFIX, '').trim()
    const looksLikeQuestion = QUESTION_WORD.test(body) || (sentence.endsWith('?') && body.length > 0)
    // "Can you ..."/"could you ..." asking for an action is a request, not a question.
    if (/^(?:can|could|would|will) you\b/i.test(body)) return false
    if (!looksLikeQuestion) return false
    questions++
  }
  return questions > 0
}
