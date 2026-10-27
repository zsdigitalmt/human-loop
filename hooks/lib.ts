import type { Ask, Option, SessionNeeds } from '../types'

export const STALE_MS = 24 * 3600 * 1000
export const HISTORY_MS = 7 * 24 * 3600 * 1000

const pad = (n: number): string => String(n).padStart(2, '0')

export const clock = (ms: number): string => {
  const d = new Date(ms)
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`
}

export const age = (ms: number, now: number): string => {
  const s = Math.max(0, Math.round((now - ms) / 1000))
  if (s < 60) return `${s}s`
  if (s < 3600) return `${Math.round(s / 60)}m`
  return `${Math.round(s / 3600)}h`
}

export const clip = (text: string, max: number): string => {
  const one = text.replace(/\s+/g, ' ').trim()
  return one.length <= max ? one : `${one.slice(0, Math.max(1, max - 1))}…`
}

export const isStale = (ask: Ask, now: number): boolean => now - ask.at > STALE_MS

// Recommended option first; the rest keep the order the agent gave.
export const ordered = (ask: Ask): Option[] => {
  const rec = ask.options.find(o => o.key === ask.recommended)
  return rec ? [rec, ...ask.options.filter(o => o !== rec)] : [...ask.options]
}

export const isLive = (ask: Ask): boolean => ask.status === 'open' || ask.status === 'sent'

// What the session receives when the human picks an answer. The question
// travels with it, so the answer stays readable after a compaction.
export const answerText = (ask: Ask, answer: string): string =>
  `${ask.id} answer: ${answer}\n(Question: ${ask.question})`

export const optionAnswer = (option: Option): string => `${option.key}: ${option.label}`

export const nextId = (seq: number): string => `NH-${seq}`

type AskInput = { question?: unknown; options?: unknown; recommended?: unknown; context?: unknown }

// Validates `ask_human`'s input; a string is a refusal reason.
export const parseAsk = (input: AskInput, id: string, at: number): Ask | string => {
  const question = typeof input.question === 'string' ? input.question.trim() : ''
  if (!question) return 'question is required'
  const raw = Array.isArray(input.options) ? input.options : []
  const options: Option[] = []
  for (const [i, o] of raw.entries()) {
    const r = (o ?? {}) as Record<string, unknown>
    const label = typeof r.label === 'string' ? r.label.trim() : ''
    if (!label) return `option ${i + 1} needs a label`
    const key = typeof r.key === 'string' && r.key.trim() ? r.key.trim() : String.fromCharCode(65 + i)
    const cost = typeof r.cost === 'string' && r.cost.trim() ? r.cost.trim() : undefined
    options.push(cost ? { key, label, cost } : { key, label })
  }
  if (options.length > 6) return 'at most 6 options'
  if (new Set(options.map(o => o.key)).size !== options.length) return 'option keys must be unique'
  const recommended = typeof input.recommended === 'string' ? input.recommended.trim() : undefined
  if (recommended && !options.some(o => o.key === recommended)) return `recommended "${recommended}" is not an option key`
  const context = typeof input.context === 'string' && input.context.trim() ? input.context.trim() : undefined
  return { id, question, options, recommended: recommended || undefined, context, at, status: 'open' }
}

export const close = (list: readonly Ask[], id: string, status: 'answered' | 'withdrawn', at: number, answer?: string): Ask[] =>
  list.map(a => (a.id === id && isLive(a) ? { ...a, status, answer: answer ?? a.answer, closedAt: at } : a))

// Closed questions are kept a week for history, then dropped.
export const prune = (list: readonly Ask[], now: number): Ask[] =>
  list.filter(a => isLive(a) || now - (a.closedAt ?? a.at) < HISTORY_MS).slice(-200)

// Other sessions' files: drop our own, empty ones and anything stale.
export const liveOthers = (
  files: readonly SessionNeeds[],
  selfId: string,
  now: number,
  maxAgeMs = 24 * 3600 * 1000,
): SessionNeeds[] =>
  files
    .map(f => ({ ...f, needs: (f.needs ?? []).filter(n => n && typeof n.question === 'string' && isLive(n)) }))
    .filter(f => f.sessionId !== selfId && f.needs.length > 0 && now - f.updatedAt < maxAgeMs)
    .sort((a, b) => b.updatedAt - a.updatedAt)
