import type { Need, SessionNeeds } from '../types'

export const MARKER = /\[NEEDS-(?:HUMAN|KEITH)\]\s*([^\n]*)/i

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

// What a finished turn asks of the person: an explicit marker wins, else a
// closing line that ends in a question mark.
export const askOf = (text: string): string | null => {
  const marked = MARKER.exec(text)
  if (marked) return clip(marked[1] || 'needs you', 160)
  const lines = text
    .split('\n')
    .map(line => line.replace(/[*_`>#-]+/g, '').trim())
    .filter(line => line.length > 0)
  const last = lines[lines.length - 1]
  if (!last || !last.endsWith('?')) return null
  return clip(last, 160)
}

const MARKERS = /\[NEEDS-(?:HUMAN|KEITH)\]\s*([^\n]*)/gi
const DONE = /\[NEEDS-DONE\]\s*([^\n]*)/gi

// Every explicit marker in a reply: each is its own sticky need.
export const marksOf = (text: string): string[] =>
  [...text.matchAll(MARKERS)].map(m => clip(m[1] || 'needs you', 160))

// [NEEDS-DONE] <text>: the agent settled an earlier flag itself.
export const doneOf = (text: string): string[] =>
  [...text.matchAll(DONE)].map(m => clip(m[1] ?? '', 160).toLowerCase()).filter(t => t.length > 0)

export const markId = (text: string): string => {
  let h = 0
  for (const ch of text.toLowerCase()) h = (h * 31 + ch.charCodeAt(0)) | 0
  return `mark-${(h >>> 0).toString(36)}`
}

export const withNeed = (list: readonly Need[], need: Need): Need[] =>
  [...list.filter(n => n.id !== need.id), need].slice(-50)

export const withoutNeed = (list: readonly Need[], id: string): Need[] =>
  list.filter(n => n.id !== id)

export const withoutKinds = (list: readonly Need[], kinds: readonly Need['kind'][]): Need[] =>
  list.filter(n => !kinds.includes(n.kind))

// Other sessions' files: drop our own, empty ones and anything stale.
export const liveOthers = (
  files: readonly SessionNeeds[],
  selfId: string,
  now: number,
  maxAgeMs = 24 * 3600 * 1000,
): SessionNeeds[] =>
  files
    .filter(f => f.sessionId !== selfId && f.needs.length > 0 && now - f.updatedAt < maxAgeMs)
    .sort((a, b) => b.updatedAt - a.updatedAt)

export const kindLabel: Record<Need['kind'], string> = {
  ask: 'question',
  permission: 'permission',
  question: 'reply',
  manual: 'flag',
}
