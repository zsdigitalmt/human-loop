import { describe, expect, test } from 'claude-code/testing'

import { age, askOf, clip, doneOf, liveOthers, markId, marksOf, withNeed, withoutKinds } from '../hooks/lib'
import type { Need, SessionNeeds } from '../types'

const BAND = {
  component: 'AbovePrompt' as const,
  props: { hasSurvey: false, isWorking: false, maxRows: 3, bodyColumns: 100, scroll: { offset: 0, bodyRows: 1 }, view: {} },
}

const PANE = {
  component: 'Pane' as const,
  requestId: 'needs-human',
  props: {
    title: 'Needs you · bookmarks',
    isFocused: false,
    bodyColumns: 60,
    placement: 'dock' as const,
    scroll: { offset: 0, bodyRows: 30 },
    view: {},
  },
}

describe('askOf: what a finished turn asks of the person', () => {
  test('a closing question is a need', () => {
    expect(askOf('Built it.\n\nShould I ship it?')).toBe('Should I ship it?')
  })
  test('a question mid-reply that is then answered is not', () => {
    expect(askOf('Why did it fail? The key was stale.\nFixed.')).toBeNull()
  })
  test('the explicit marker wins anywhere', () => {
    expect(askOf('Done. [NEEDS-HUMAN] approve the prod flag flip\nmore text')).toBe('approve the prod flag flip')
  })
  test('markdown dressing around the question is ignored', () => {
    expect(askOf('Options above.\n\n**Go with A?**')).toBe('Go with A?')
  })
})

describe('need lists', () => {
  const at = 1_000
  const a: Need = { id: 'a', kind: 'question', text: 'x', at }
  const b: Need = { id: 'b', kind: 'ask', text: 'y', at }
  test('withNeed replaces by id', () => {
    expect(withNeed([a], { ...a, text: 'z' })).toEqual([{ ...a, text: 'z' }])
  })
  test('withoutKinds keeps other kinds', () => {
    expect(withoutKinds([a, b], ['question'])).toEqual([b])
  })
  test('liveOthers drops self, empty and stale files', () => {
    const mk = (sessionId: string, updatedAt: number, needs: Need[]): SessionNeeds => ({ session: sessionId, sessionId, updatedAt, needs })
    const now = 100 * 3600 * 1000
    const out = liveOthers([mk('self', now, [a]), mk('empty', now, []), mk('old', 0, [a]), mk('live', now - 1000, [b])], 'self', now)
    expect(out.map(f => f.sessionId)).toEqual(['live'])
  })
  test('clip and age format', () => {
    expect(clip('a   b\nc', 10)).toBe('a b c')
    expect(clip('abcdefghij', 5)).toBe('abcd…')
    expect(age(0, 90_000)).toBe('2m')
  })
})

describe('drawn through the engine', () => {
  test('band hides at zero, then shows the flag and jump buttons after /need', async ($, on) => {
    on('ui.render', ($, e) => {
      const { Text } = $.ui.resolve(e)
      return <Text>engine</Text>
    })
    const empty = await $.ui.mount({ plugin: 'human-loop', surface: 'terminal', ...BAND })
    expect(await empty.find({ key: 'needs' })).toBeUndefined()
    await empty.unmount()
    const { text } = await $.command.run({
      command: 'need',
      args: 'approve the migration',
      origin: { kind: 'composer' },
      presentation: { isFullscreen: true, columns: 120 },
    })
    expect(text).toContain('Flagged')
    const ui = await $.ui.mount({ plugin: 'human-loop', surface: 'terminal', ...BAND })
    expect((await ui.find({ key: 'needs' }))?.text).toContain('1 need you')
    expect(await ui.find({ key: 'prev' })).toBeDefined()
    expect(await ui.find({ key: 'mark' })).toBeDefined()
    await ui.unmount()

    const pane = await $.ui.mount({ plugin: 'human-loop', surface: 'terminal', ...PANE })
    expect(await pane.find({ text: /approve the migration/ })).toBeDefined()
    const done = await pane.find({ type: 'Button', text: '✓' })
    expect(done?.key).toMatch(/^done-manual-/)
    await pane.press({ key: done?.key ?? '' })
    expect(await pane.find({ text: /nothing waiting on you/ })).toBeDefined()
    await pane.unmount()
  })
})

describe('sticky marker flags', () => {
  test('a reply with markers flags each one, and [NEEDS-DONE] clears one', async ($, on) => {
    on('ui.render', ($, e) => {
      const { Text } = $.ui.resolve(e)
      return <Text>engine</Text>
    })
    on('turn.complete', (_, e) => ({ text: e.answer }))
    const end = (answer: string) =>
      $.turn.complete({ answer, reason: 'answer', durationMs: 1, isAborted: false, turnId: 't' })
    await end('Done.\n[NEEDS-KEITH] pick repo A or B\n[NEEDS-KEITH] send the email')
    const pane = await $.ui.mount({ plugin: 'human-loop', surface: 'terminal', ...PANE })
    expect(await pane.find({ text: /pick repo A or B/ })).toBeDefined()
    expect(await pane.find({ text: /send the email/ })).toBeDefined()
    await pane.unmount()
    await end('ok [NEEDS-DONE] pick repo')
    const after = await $.ui.mount({ plugin: 'human-loop', surface: 'terminal', ...PANE })
    expect(await after.find({ text: /pick repo A or B/ })).toBeUndefined()
    expect(await after.find({ text: /send the email/ })).toBeDefined()
    await after.unmount()
  })
  test('every [NEEDS-KEITH] line is its own flag', () => {
    expect(marksOf('Done.\n[NEEDS-KEITH] pick repo A or B\nmore\n[NEEDS-HUMAN] approve send')).toEqual(['pick repo A or B', 'approve send'])
  })
  test('no marker, no flags', () => {
    expect(marksOf('All done?')).toEqual([])
  })
  test('the same text keeps the same id across turns', () => {
    expect(markId('Pick repo A or B')).toBe(markId('pick repo a or b'))
    expect(markId('x')).not.toBe(markId('y'))
  })
  test('[NEEDS-DONE] names what was settled', () => {
    expect(doneOf('ok [NEEDS-DONE] Pick repo')).toEqual(['pick repo'])
  })
})
