import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Bookmark, Need, SessionNeeds } from '../types'
import { age, askOf, clip, clock, doneOf, kindLabel, liveOthers, markId, marksOf, withNeed, withoutKinds, withoutNeed } from './lib'

const PANE = 'needs-human'
const needs = atom({ plugin: 'human-loop', key: 'needs' } as const, [])
const others = atom({ plugin: 'human-loop', key: 'others' } as const, [])
const bookmarks = atom({ plugin: 'human-loop', key: 'bookmarks' } as const, [])

type Seen = { id: string; isUser: boolean }

// Module state: rebuilt on reload as rows draw again.
const S = {
  stamps: new Map<string, number>(),
  order: [] as Seen[],
  cursor: -1,
  startedAt: 0,
  selfId: '',
  selfName: '',
  dir: '',
  lastOthers: '',
  flush: null as { cancel: () => void } | null,
}

const now = (): number => Date.now()

function persistStamps($: EngineInterface): void {
  S.flush?.cancel()
  S.flush = $.clock.after(2000, () => {
    const entries = [...S.stamps.entries()].slice(-3000)
    void $.store.set(`stamps:${S.selfId}`, Object.fromEntries(entries))
  })
}

async function writeOwn($: EngineInterface): Promise<void> {
  if (!S.dir) return
  const file: SessionNeeds = { session: S.selfName, sessionId: S.selfId, updatedAt: now(), needs: await read($, needs) }
  await $.fs.write(`${S.dir}/${S.selfId}.json`, JSON.stringify(file))
}

async function showStatus($: EngineInterface): Promise<void> {
  const own = (await read($, needs)).length
  const rest = (await read($, others)).reduce((n, f) => n + f.needs.length, 0)
  const total = own + rest
  $.ui.status(total === 0 ? '⚑ 0' : `⚑ ${total} need you${rest > 0 ? ` (${rest} other)` : ''} · /needs`)
}

async function changeNeeds($: EngineInterface, fn: (list: readonly Need[]) => Need[]): Promise<void> {
  await update($, needs, fn)
  await writeOwn($)
  await showStatus($)
}

async function pollOthers($: EngineInterface): Promise<void> {
  if (!S.dir || !(await $.fs.exists(S.dir))) return
  const entries = await $.fs.list(S.dir)
  const files: SessionNeeds[] = []
  for (const entry of entries) {
    if (entry.kind !== 'file' || !entry.name.endsWith('.json')) continue
    if (now() - entry.mtimeMs > 24 * 3600 * 1000) continue
    try {
      files.push(JSON.parse(String(await $.fs.read(`${S.dir}/${entry.name}`))) as SessionNeeds)
    } catch {
      // half-written file; next poll gets it
    }
  }
  const live = liveOthers(files, S.selfId, now())
  const key = JSON.stringify(live.map(f => [f.sessionId, f.needs.map(n => n.id)]))
  if (key === S.lastOthers) return
  const before = new Set((await read($, others)).flatMap(f => f.needs.map(n => n.id)))
  const fresh = live.flatMap(f => f.needs.filter(n => !before.has(n.id)).map(n => `${f.session}: ${n.text}`))
  const first = fresh[0]
  if (S.lastOthers !== '' && first) $.ui.toast(`⚑ ${clip(first, 90)}`)
  S.lastOthers = key
  await update($, others, () => live)
  await showStatus($)
}

async function scrollTo($: EngineInterface, requestId: string): Promise<string> {
  const res = await $.ui.scroll({ to: { requestId }, block: 'start' })
  return 'deny' in res && res.deny ? `Could not scroll: ${res.deny}` : ''
}

async function jumpLast($: EngineInterface): Promise<string> {
  const last = S.order[S.order.length - 1]
  if (!last) return 'No messages yet.'
  S.cursor = S.order.length - 1
  return (await scrollTo($, last.id)) || ''
}

async function jumpPrev($: EngineInterface): Promise<string> {
  const from = S.cursor < 0 ? S.order.length : S.cursor
  for (let i = from - 1; i >= 0; i--) {
    const seen = S.order[i]
    if (seen?.isUser) {
      S.cursor = i
      return (await scrollTo($, seen.id)) || ''
    }
  }
  return 'No earlier prompt.'
}

async function jumpNext($: EngineInterface): Promise<string> {
  for (let i = S.cursor + 1; i < S.order.length; i++) {
    const seen = S.order[i]
    if (seen?.isUser) {
      S.cursor = i
      return (await scrollTo($, seen.id)) || ''
    }
  }
  return jumpLast($)
}

async function mark($: EngineInterface, label: string): Promise<string> {
  const target = S.cursor >= 0 && S.cursor < S.order.length - 1 ? S.order[S.cursor] : S.order[S.order.length - 1]
  if (!target) return 'Nothing to bookmark yet.'
  const at = S.stamps.get(target.id) ?? now()
  const bm: Bookmark = { requestId: target.id, label: label || `${target.isUser ? 'prompt' : 'reply'} ${clock(at)}`, at }
  await update($, bookmarks, list => [...list.filter(b => b.requestId !== bm.requestId), bm].slice(-40))
  await $.store.set(`bookmarks:${S.selfId}`, await read($, bookmarks))
  return `★ Bookmarked: ${bm.label}`
}

function openPane($: EngineInterface) { return $.ui.open({ id: PANE, title: 'Needs you · bookmarks' }) }

// Timestamps: first time a row is seen live; rows replayed at start stay unstamped.
function stampOf($: EngineInterface, id: string, isUser: boolean): number | undefined {
  if (!S.order.some(s => s.id === id)) S.order.push({ id, isUser })
  const known = S.stamps.get(id)
  if (known !== undefined) return known
  if (now() - S.startedAt < 4000) return undefined
  const at = now()
  S.stamps.set(id, at)
  persistStamps($)
  return at
}


export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    S.startedAt = now()
    S.selfId = await $.session.id()
    const home = (await $.env.get('HOME')) ?? ''
    const pwd = (await $.env.get('PWD')) ?? ''
    S.selfName = (await $.env.get('CLAUDE_SESSION_NAME')) || `${pwd.split('/').pop() || 'session'}·${S.selfId.slice(0, 4)}`
    S.dir = home ? `${home}/.claude/needs-human` : ''

    const saved = (await $.store.get(`stamps:${S.selfId}`)) as Record<string, number> | undefined
    for (const [id, at] of Object.entries(saved ?? {})) S.stamps.set(id, at)
    const savedMarks = (await $.store.get(`bookmarks:${S.selfId}`)) as Bookmark[] | undefined
    if (savedMarks && (await read($, bookmarks)).length === 0) await update($, bookmarks, () => savedMarks)

    for (const [name, description] of [
      ['needs', 'Open the needs-you / bookmarks pane'],
      ['bm', 'Bookmark the current message: /bm [label]'],
      ['last', 'Jump to the latest message'],
      ['prev', 'Jump to the previous prompt'],
      ['next', 'Jump to the next prompt'],
      ['need', 'Flag something as needing a human: /need <text>'],
      ['needs-clear', "Clear this session's needs"],
    ] as const) {
      // One name taken (a skill, another mod) must not cost the rest of start-up.
      try {
        await $.command.register({ name, description })
      } catch {
        $.ui.log(`human-loop: /${name} is taken, skipped`, { to: 'debug' })
      }
    }

    await writeOwn($)
    await showStatus($)
    void pollOthers($)
    $.clock.every(5000, () => void pollOthers($))
    return next(e)
  })

  on('session.end', async ($, e, next) => {
    await update($, needs, () => [])
    await writeOwn($)
    return next(e)
  })

  on('command.run', { command: 'needs' }, async $ => {
    await openPane($)
    return { text: 'Needs pane opened.' }
  })
  on('command.run', { command: 'bm' }, async ($, e) => ({ text: await mark($, e.args.trim()) }))
  on('command.run', { command: 'last' }, async $ => ({ text: (await jumpLast($)) || '↓ latest' }))
  on('command.run', { command: 'prev' }, async $ => ({ text: (await jumpPrev($)) || '↑ previous prompt' }))
  on('command.run', { command: 'next' }, async $ => ({ text: (await jumpNext($)) || '↓ next prompt' }))
  on('command.run', { command: 'need' }, async ($, e) => {
    const text = e.args.trim() || 'needs you'
    await changeNeeds($, list => withNeed(list, { id: `manual-${now()}`, kind: 'manual', text, at: now(), requestId: S.order[S.order.length - 1]?.id }))
    return { text: `⚑ Flagged: ${text}` }
  })
  on('command.run', { command: 'needs-clear' }, async $ => {
    await changeNeeds($, () => [])
    return { text: 'Cleared.' }
  })

  // The person answered: replies and pending permission asks are settled.
  on('prompt.submit', async ($, e, next) => {
    S.cursor = -1
    await changeNeeds($, list => withoutKinds(list, ['question', 'permission']))
    return next(e)
  })

  on('tool.call', { tool: 'AskUserQuestion' }, async ($, e, next) => {
    const input = e as unknown as { questions?: { question?: string }[] }
    const text = clip(input.questions?.[0]?.question ?? 'Question for you', 160)
    const id = `ask-${e.tool_use_id}`
    await changeNeeds($, list => withNeed(list, { id, kind: 'ask', text, at: now(), requestId: e.tool_use_id }))
    try {
      return await next(e)
    } finally {
      await changeNeeds($, list => withoutNeed(list, id))
    }
  })

  on('tool.check', async ($, e, next) => {
    const verdict = await next(e)
    if (verdict.decision === 'ask' && e.tool_use_id && e.tool !== 'AskUserQuestion') {
      const input = e.input as Record<string, unknown> | null
      const detail = typeof input?.command === 'string' ? input.command : typeof input?.file_path === 'string' ? input.file_path : ''
      const id = `perm-${e.tool_use_id}`
      await changeNeeds($, list =>
        withNeed(list, { id, kind: 'permission', text: clip(`${e.tool}${detail ? `: ${detail}` : ''}`, 160), at: now(), requestId: e.tool_use_id }),
      )
    }
    return verdict
  })

  on('tool.call', async ($, e, next) => {
    try {
      return await next(e)
    } finally {
      const id = `perm-${e.tool_use_id}`
      if ((await read($, needs)).some(n => n.id === id)) await changeNeeds($, list => withoutNeed(list, id))
    }
  })

  on('turn.complete', async ($, e, next) => {
    const text = typeof e.answer === 'string' ? e.answer : ''
    const marks = e.reason === 'refusal' ? [] : marksOf(text)
    const done = doneOf(text)
    const ask = e.reason === 'refusal' || marks.length > 0 ? null : askOf(text)
    const lastReply = [...S.order].reverse().find(s => !s.isUser)
    await changeNeeds($, list => {
      // Marker flags are sticky: they outlive later prompts until ✓ or [NEEDS-DONE].
      let kept = withoutKinds(list, ['permission']).filter(
        n => !(n.kind === 'manual' && done.some(d => n.text.toLowerCase().startsWith(d))),
      )
      for (const m of marks) {
        const id = markId(m)
        const prior = kept.find(n => n.id === id)
        kept = withNeed(kept, { id, kind: 'manual', text: m, at: prior?.at ?? now(), requestId: lastReply?.id })
      }
      if (!ask) return kept
      return withNeed(kept, { id: 'reply', kind: 'question', text: ask, at: now(), requestId: lastReply?.id })
    })
    return next(e)
  })

  on('ui.render', { component: 'UserMessage' }, async ($, e, next) => {
    if (e.props.origin.kind !== 'composer') {
      return next(e)
    }
    const at = stampOf($, e.requestId, true)
    const drawn = await next(e)
    if (at === undefined) return drawn
    const { Box, Text } = $.ui.resolve(e)
    return (
      <Box flexDirection="column">
        <Text dimColor>── {clock(at)}</Text>
        {drawn}
      </Box>
    )
  })

  on('ui.render', { component: 'AssistantMessage' }, async ($, e, next) => {
    if (!e.props.isFirstOfReply) return next(e)
    const at = stampOf($, e.requestId, false)
    const drawn = await next(e)
    if (at === undefined) return drawn
    const { Box, Text } = $.ui.resolve(e)
    return (
      <Box flexDirection="column">
        <Text dimColor>── {clock(at)}</Text>
        {drawn}
      </Box>
    )
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const own = await read($, needs)
    const rest = await read($, others)
    const count = own.length + rest.reduce((n, f) => n + f.needs.length, 0)
    // The count lives in the status line; the band shows only when something waits.
    if (count === 0) return next(e)
    const { Box, Button, Text } = $.ui.resolve(e)
    return (
      <Box>
        <Button key="needs" plain hotkey="n" onPress={() => void openPane($)}>
          {count > 0 ? <Text color="yellow" bold>⚑ {count} need you</Text> : <Text dimColor>⚑ 0</Text>}
        </Button>
        <Text dimColor> · </Text>
        <Button key="prev" plain hotkey="p" label="↑ prev" onPress={() => void jumpPrev($)} />
        <Text> </Text>
        <Button key="next" plain hotkey="j" label="↓ next" onPress={() => void jumpNext($)} />
        <Text> </Text>
        <Button key="last" plain hotkey="l" label="⤓ last" onPress={() => void jumpLast($)} />
        <Text> </Text>
        <Button key="mark" plain hotkey="m" label="★ mark" onPress={async () => $.ui.toast(await mark($, ''))} />
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Button, Text } = $.ui.resolve(e)
    const own = await read($, needs)
    const rest = await read($, others)
    const marks = await read($, bookmarks)
    const width = Math.max(20, (e.props.bodyColumns ?? 60) - 14)
    const t = now()
    return (
      <Box flexDirection="column">
        <Text bold>This session</Text>
        {own.length === 0 && <Text dimColor>  nothing waiting on you</Text>}
        {own.map(n => (
          <Box key={`own-${n.id}`}>
            <Button key={`go-${n.id}`} plain onPress={() => (n.requestId ? void scrollTo($, n.requestId) : undefined)}>
              <Text color="yellow">⚑ </Text>
              {clip(n.text, width)} <Text dimColor>{kindLabel[n.kind]} · {age(n.at, t)}</Text>
            </Button>
            <Text> </Text>
            <Button key={`done-${n.id}`} plain label="✓" onPress={() => void changeNeeds($, list => withoutNeed(list, n.id))} />
          </Box>
        ))}
        <Text> </Text>
        <Text bold>Other sessions</Text>
        {rest.length === 0 && <Text dimColor>  all quiet</Text>}
        {rest.flatMap(f =>
          f.needs.map(n => (
            <Text key={`other-${f.sessionId}-${n.id}`}>
              <Text color="cyan">{clip(f.session, 18)}</Text> {clip(n.text, width - 6)}{' '}
              <Text dimColor>{kindLabel[n.kind]} · {age(n.at, t)}</Text>
            </Text>
          )),
        )}
        <Text> </Text>
        <Text bold>Bookmarks</Text>
        {marks.length === 0 && <Text dimColor>  /bm [label] or ★ mark</Text>}
        {marks.map(b => (
          <Box key={`bm-${b.requestId}`}>
            <Button key={`bmgo-${b.requestId}`} plain onPress={() => void scrollTo($, b.requestId)}>
              ★ {clip(b.label, width)} <Text dimColor>{clock(b.at)}</Text>
            </Button>
            <Text> </Text>
            <Button
              key={`bmdel-${b.requestId}`}
              plain
              label="✕"
              onPress={async () => {
                await update($, bookmarks, list => list.filter(x => x.requestId !== b.requestId))
                await $.store.set(`bookmarks:${S.selfId}`, await read($, bookmarks))
              }}
            />
          </Box>
        ))}
      </Box>
    )
  })
}
