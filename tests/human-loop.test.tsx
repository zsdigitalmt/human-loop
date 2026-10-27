import { describe, expect, mock, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'

import { answerText, close, isStale, liveOthers, ordered, parseAsk, prune } from '../hooks/lib'
import type { Ask, SessionNeeds } from '../types'

const ASK = 'mcp__human-loop__ask_human'
const T0 = 1_800_000_000_000

const PANE = {
  plugin: 'human-loop',
  component: 'Pane',
  requestId: 'needs-human',
  props: {
    title: 'Needs Human',
    isFocused: false,
    bodyColumns: 100,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 40 },
    view: {},
  },
} as const

type On = Parameters<TestBody>[1]
type Engine = Parameters<TestBody>[0]

// The engine beneath the plugin, with a clock the test moves and a record of submitted prompts.
async function boot($: Engine, on: On, files: SessionNeeds[] = [], store: Record<string, unknown> = {}) {
  mock.env(on, { HOME: '/h', PWD: '/w', CLAUDE_SESSION_NAME: 'self' })
  mock.store(on, store)
  const clock = mock.clock(on, { now: T0 })
  const sent: string[] = []
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('tool.register', (_, e) => ({ value: { tool: `mcp__human-loop__${e.name}` } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.id', () => ({ value: 'self-id' }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
  on('fs.exists', () => ({ value: true }))
  on('fs.write', () => ({ value: undefined }))
  on('fs.list', () => ({ value: files.map((f, i) => ({ kind: 'file', name: `o${i}.json`, mtimeMs: T0, size: 1, isLink: false })) }))
  on('fs.read', (_, e) => ({ value: JSON.stringify(files[Number(/o(\d+)\.json$/.exec(String(e.path))?.[1] ?? 0)]) }))
  on('prompt.submit', (_, e) => {
    sent.push(e.text)
    return { text: e.text }
  })
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  return { clock, sent }
}

// The mod's tools are not in the generated tool table, so calls go through one loose signature.
const call = ($: Engine, tool: string, input: Record<string, unknown>) =>
  ($.tool as unknown as { call: (e: Record<string, unknown>) => Promise<unknown> }).call({ tool, ...input })

const AUDIT = {
  question: 'Audit PRs #48 #49 #52: merge them?',
  options: [
    { key: 'A', label: 'merge all three', cost: '2 min' },
    { key: 'B', label: 'wait for review' },
  ],
  recommended: 'B',
  context: 'One-line records, checks green.',
}

describe('lib', () => {
  test('parseAsk defaults keys and rejects a bad recommendation', () => {
    const a = parseAsk({ question: 'Q?', options: [{ label: 'x' }, { label: 'y' }] }, 'NH-1', T0)
    expect(typeof a === 'string' ? a : a.options.map(o => o.key)).toEqual(['A', 'B'])
    expect(parseAsk({ question: 'Q?', options: [{ label: 'x' }], recommended: 'Z' }, 'NH-1', T0)).toBe('recommended "Z" is not an option key')
    expect(parseAsk({ options: [] }, 'NH-1', T0)).toBe('question is required')
  })
  test('answerText carries id and question', () => {
    const a = parseAsk(AUDIT, 'NH-4', T0) as Ask
    expect(answerText(a, 'B: wait for review')).toBe('NH-4 answer: B: wait for review\n(Question: Audit PRs #48 #49 #52: merge them?)')
  })
  test('G6 ordered puts the recommended option first', () => {
    expect(ordered(parseAsk(AUDIT, 'NH-1', T0) as Ask).map(o => o.key)).toEqual(['B', 'A'])
  })
  test('G8 isStale after 24h', () => {
    const a = parseAsk(AUDIT, 'NH-1', T0) as Ask
    expect(isStale(a, T0 + 23 * 3600e3)).toBe(false)
    expect(isStale(a, T0 + 25 * 3600e3)).toBe(true)
  })
  test('close and prune keep history a week', () => {
    const a = parseAsk(AUDIT, 'NH-1', T0) as Ask
    const closed = close([a], 'NH-1', 'answered', T0, 'A')
    expect(closed[0]?.status).toBe('answered')
    expect(prune(closed, T0 + 6 * 86400e3)).toHaveLength(1)
    expect(prune(closed, T0 + 8 * 86400e3)).toHaveLength(0)
  })
  test('G9 liveOthers drops self, closed and stale', () => {
    const open = parseAsk(AUDIT, 'NH-2', T0) as Ask
    const shut = { ...open, id: 'NH-3', status: 'answered' as const }
    const mk = (sessionId: string, updatedAt: number, needs: Ask[]): SessionNeeds => ({ session: sessionId, sessionId, updatedAt, needs })
    const out = liveOthers([mk('self', T0, [open]), mk('old', 0, [open]), mk('done', T0, [shut]), mk('live', T0, [open, shut])], 'self', T0)
    expect(out.map(f => [f.sessionId, f.needs.map(n => n.id)])).toEqual([['live', ['NH-2']]])
  })
})

for (const surface of ['terminal', 'desktop'] as const) {
  describe(`pane on ${surface}`, () => {
    test('G1 G6 ask_human draws the question with one button per option, recommended first', async ($, on) => {
      await boot($, on)
      await call($, ASK, AUDIT)
      const ui = await $.ui.mount({ ...PANE, surface })
      expect((await ui.find({ text: /NH-1/ }))?.text).toContain('Audit PRs #48 #49 #52')
      const buttons = (await ui.findAll({ type: 'Button' })).map(b => b.key).filter(k => k?.startsWith('opt-'))
      expect(buttons).toEqual(['opt-NH-1-B', 'opt-NH-1-A'])
      expect((await ui.find({ key: 'opt-NH-1-B' }))?.text).toContain('★')
      await ui.unmount()
    })

    test('G2 one press submits once, naming id, question and option, and the row goes', async ($, on) => {
      const { sent } = await boot($, on)
      await call($, ASK, AUDIT)
      const ui = await $.ui.mount({ ...PANE, surface })
      await ui.press({ key: 'opt-NH-1-A' })
      expect(sent).toEqual(['NH-1 answer: A: merge all three\n(Question: Audit PRs #48 #49 #52: merge them?)'])
      expect(await ui.find({ key: 'opt-NH-1-A' })).toBeUndefined()
      expect((await ui.find({ text: /Needs Human/ }))?.text).toContain('0 open')
      await ui.unmount()
    })

    test('G3 Other… submits the typed answer', async ($, on) => {
      const { sent } = await boot($, on)
      await call($, ASK, AUDIT)
      const ui = await $.ui.mount({ ...PANE, surface })
      await ui.press({ key: 'other-NH-1' })
      await ui.input({ key: 'input-NH-1', text: 'merge #52 only' })
      expect(sent).toEqual(['NH-1 answer: merge #52 only\n(Question: Audit PRs #48 #49 #52: merge them?)'])
      await ui.unmount()
    })

    test('G7 a second press on a sent question submits nothing', async ($, on) => {
      const { sent } = await boot($, on)
      await call($, ASK, AUDIT)
      const ui = await $.ui.mount({ ...PANE, surface })
      await Promise.all([ui.press({ key: 'opt-NH-1-A' }), ui.press({ key: 'opt-NH-1-B' })])
      expect(sent).toHaveLength(1)
      await ui.unmount()
    })

    test('G8 a question open past 24h is tagged STALE', async ($, on) => {
      const old = parseAsk(AUDIT, 'NH-1', T0 - 25 * 3600e3) as Ask
      await boot($, on, [], { 'asks:self-id': [old] })
      const ui = await $.ui.mount({ ...PANE, surface })
      expect((await ui.find({ text: /STALE/ }))?.text).toContain('STALE')
      await ui.unmount()
    })

    test('G9 other sessions are listed read-only', async ($, on) => {
      const theirs = parseAsk({ question: 'Publish pricing copy?', options: [{ label: 'yes' }] }, 'NH-9', T0) as Ask
      const { clock } = await boot($, on, [{ session: 'other-session', sessionId: 'other', updatedAt: T0, needs: [theirs] }])
      await clock.advance(5000)
      const ui = await $.ui.mount({ ...PANE, surface })
      expect((await ui.find({ text: /Publish pricing copy/ }))?.text).toContain('other-session')
      expect(await ui.find({ key: 'opt-NH-9-A' })).toBeUndefined()
      await ui.unmount()
    })
  })
}

test('G4 an answered question stays gone after the session starts again', async ($, on) => {
  await boot($, on)
  await call($, ASK, AUDIT)
  await call($, ASK, { question: 'Still open?', options: [{ label: 'y' }] })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'opt-NH-1-A' })
  await ui.unmount()
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  const again = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await again.find({ key: 'opt-NH-1-A' })).toBeUndefined()
  expect(await again.find({ key: 'opt-NH-2-A' })).toBeDefined()
  await again.unmount()
})

test('G10 withdraw_need and resolve_need remove rows without a prompt', async ($, on) => {
  const { sent } = await boot($, on)
  await call($, ASK, AUDIT)
  await call($, ASK, { question: 'Second?', options: [{ label: 'y' }] })
  await call($, 'mcp__human-loop__withdraw_need', { id: 'NH-1' })
  await call($, 'mcp__human-loop__resolve_need', { id: 'NH-2', answer: 'y (typed in chat)' })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.find({ text: /Needs Human/ }))?.text).toContain('0 open')
  expect(sent).toHaveLength(0)
  await ui.unmount()
})

test('tool results are strings the engine accepts', async ($, on) => {
  await boot($, on)
  const r = (await call($, ASK, AUDIT)) as { result?: unknown }
  expect(typeof r.result).toBe('string')
  const l = (await call($, 'mcp__human-loop__list_needs', {})) as { result?: unknown }
  expect(typeof l.result).toBe('string')
  const w = (await call($, 'mcp__human-loop__withdraw_need', { id: 'NH-1' })) as { result?: unknown }
  expect(typeof w.result).toBe('string')
})
