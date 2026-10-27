import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, ToolCallResult } from 'claude-code'

import type { Ask, Bookmark, SessionNeeds, Wait } from '../types'
import { age, answerText, clip, clock, close, isLive, isStale, liveOthers, nextId, optionAnswer, ordered, parseAsk, prune } from './lib'

const PANE = 'needs-human'
const asks = atom({ plugin: 'human-loop', key: 'asks' } as const, [])
const waits = atom({ plugin: 'human-loop', key: 'waits' } as const, [])
const others = atom({ plugin: 'human-loop', key: 'others' } as const, [])
const bookmarks = atom({ plugin: 'human-loop', key: 'bookmarks' } as const, [])
const expanded = atom({ plugin: 'human-loop', key: 'expanded' } as const, '')
const typing = atom({ plugin: 'human-loop', key: 'typing' } as const, '')

const ASK_TOOL = 'mcp__human-loop__ask_human'
const RESOLVE_TOOL = 'mcp__human-loop__resolve_need'
const WITHDRAW_TOOL = 'mcp__human-loop__withdraw_need'
const LIST_TOOL = 'mcp__human-loop__list_needs'

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
  sending: new Set<string>(),
}

const now = (): number => Date.now()

function persistStamps($: EngineInterface): void {
  S.flush?.cancel()
  S.flush = $.clock.after(2000, () => {
    const entries = [...S.stamps.entries()].slice(-3000)
    void $.store.set(`stamps:${S.selfId}`, Object.fromEntries(entries))
  })
}

async function writeOwn($: EngineInterface, live = true): Promise<void> {
  if (!S.dir) return
  const open = live ? (await read($, asks)).filter(isLive) : []
  const file: SessionNeeds = { session: S.selfName, sessionId: S.selfId, updatedAt: await $.clock.now(), needs: open }
  await $.fs.write(`${S.dir}/${S.selfId}.json`, JSON.stringify(file))
}

async function showStatus($: EngineInterface): Promise<void> {
  const own = (await read($, asks)).filter(isLive).length + (await read($, waits)).length
  const rest = (await read($, others)).reduce((n, f) => n + f.needs.length, 0)
  const total = own + rest
  $.ui.status(total === 0 ? 'NH 0' : `NH ${own}${rest > 0 ? ` (+${rest} other)` : ''} · /needs`)
}

async function changeAsks($: EngineInterface, fn: (list: readonly Ask[]) => Ask[]): Promise<void> {
  const t = await $.clock.now()
  await update($, asks, list => prune(fn(list), t))
  await $.store.set(`asks:${S.selfId}`, await read($, asks))
  await writeOwn($)
  await showStatus($)
}

async function changeWaits($: EngineInterface, fn: (list: readonly Wait[]) => Wait[]): Promise<void> {
  await update($, waits, fn)
  await showStatus($)
}

// The id counter is shared by every session, so ids stay unique across them.
async function mintId($: EngineInterface): Promise<string> {
  const ids = [...(await read($, asks)), ...(await read($, others)).flatMap(f => f.needs)]
    .map(a => Number(/^NH-(\d+)$/.exec(a.id)?.[1] ?? 0))
  const stored = Number((await $.store.get('nh-seq')) ?? 0)
  const seq = Math.max(stored, ...ids, 0) + 1
  await $.store.set('nh-seq', seq)
  return nextId(seq)
}

// One press answers: the row goes to `sent` first, so a second press finds
// nothing open and submits nothing.
async function answer($: EngineInterface, id: string, text: string): Promise<void> {
  // Claimed before any await: two presses in the same tick must not both pass.
  if (S.sending.has(id) || !text.trim()) return
  S.sending.add(id)
  try {
    await send($, id, text)
  } finally {
    S.sending.delete(id)
  }
}

async function send($: EngineInterface, id: string, text: string): Promise<void> {
  const ask = (await read($, asks)).find(a => a.id === id)
  if (!ask || ask.status !== 'open') return
  await update($, typing, () => '')
  await changeAsks($, list => list.map(a => (a.id === id ? { ...a, status: 'sent', answer: text } : a)))
  try {
    await $.prompt.submit({ text: answerText(ask, text) })
    const t = await $.clock.now()
    await changeAsks($, list => close(list, id, 'answered', t, text))
  } catch {
    await changeAsks($, list => list.map(a => (a.id === id ? { ...a, status: 'open', answer: undefined } : a)))
    $.ui.toast(`${id}: could not send, try again`)
  }
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
  const live = liveOthers(files, S.selfId, await $.clock.now())
  const key = JSON.stringify(live.map(f => [f.sessionId, f.needs.map(n => n.id)]))
  if (key === S.lastOthers) return
  const before = new Set((await read($, others)).flatMap(f => f.needs.map(n => n.id)))
  const fresh = live.flatMap(f => f.needs.filter(n => !before.has(n.id)).map(n => `${f.session} ${n.id}: ${n.question}`))
  const first = fresh[0]
  if (S.lastOthers !== '' && first) $.ui.toast(`NH ${clip(first, 90)}`)
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

function openPane($: EngineInterface) { return $.ui.open({ id: PANE, title: 'Needs Human' }) }

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



const OPTION_SCHEMA = {
  type: 'object',
  properties: {
    key: { type: 'string', description: 'Short key, e.g. "A". Defaults to A, B, C… by position.' },
    label: { type: 'string', description: 'The choice in a few words, shown on its button.' },
    cost: { type: 'string', description: 'What choosing it costs (time, risk), shown when the row is expanded.' },
  },
  required: ['label'],
}

const TOOLS = [
  {
    name: 'ask_human',
    description:
      'Put a question to your human in the Needs Human pane and keep working. Use it for every decision, approval or missing input you need from them instead of asking in prose. They answer with one click; the answer arrives as their next message, starting "NH-<n> answer:". Give 2-4 options with the recommended one named. Returns the question id.',
    inputSchema: {
      type: 'object',
      properties: {
        question: { type: 'string', description: 'One line, under ~90 characters: what you need decided.' },
        options: { type: 'array', items: OPTION_SCHEMA, description: 'The choices. The human can always type another answer.' },
        recommended: { type: 'string', description: 'The key of the option you recommend.' },
        context: { type: 'string', description: 'One or two lines shown when the row is expanded.' },
      },
      required: ['question', 'options'],
    },
  },
  {
    name: 'resolve_need',
    description: 'Close an open Needs Human question the human answered some other way (typed in chat). Sends nothing.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'e.g. NH-4' }, answer: { type: 'string', description: 'What they answered.' } },
      required: ['id'],
    },
  },
  {
    name: 'withdraw_need',
    description: 'Remove an open Needs Human question that no longer needs the human (resolved, superseded or wrong). Sends nothing.',
    inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
  },
  {
    name: 'list_needs',
    description: 'List this session\'s open Needs Human questions and their ids.',
    inputSchema: { type: 'object', properties: {} },
  },
]

type ToolArgs = Record<string, unknown>
const argsOf = (e: unknown): ToolArgs => {
  const r = e as ToolArgs
  return (r.input && typeof r.input === 'object' ? r.input : r) as ToolArgs
}


// The mod's own tools; served from the one unmatched tool.call hook.
async function serveTool($: EngineInterface, tool: string, e: unknown): Promise<ToolCallResult | undefined> {
  if (tool === ASK_TOOL) {
    const id = await mintId($)
    const ask = parseAsk(argsOf(e), id, await $.clock.now())
    if (typeof ask === 'string') return { deny: `ask_human: ${ask}` }
    await changeAsks($, list => [...list, ask])
    return { result: `${id} is open in the Needs Human pane. Keep working; the answer arrives as a message starting "${id} answer:".` }
  }
  if (tool === RESOLVE_TOOL || tool === WITHDRAW_TOOL) {
    const status = tool === RESOLVE_TOOL ? 'answered' : 'withdrawn'
    const args = argsOf(e)
    const id = typeof args.id === 'string' ? args.id.trim() : ''
    const found = (await read($, asks)).find(a => a.id === id && isLive(a))
    if (!found) return { deny: `${id || 'id'} is not an open question in this session` }
    const said = typeof args.answer === 'string' ? args.answer : undefined
    const t = await $.clock.now()
    await changeAsks($, list => close(list, id, status, t, said))
    return { result: `${id} ${status}.` }
  }
  if (tool === LIST_TOOL) {
    const open = (await read($, asks)).filter(isLive)
    return { result: open.length ? open.map(a => `${a.id} [${a.status}] ${a.question}`).join('\n') : 'No open questions.' }
  }
  return undefined
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
    const savedAsks = (await $.store.get(`asks:${S.selfId}`)) as Ask[] | undefined
    const t0 = await $.clock.now()
    if (savedAsks && (await read($, asks)).length === 0) await update($, asks, () => prune(savedAsks, t0))

    for (const tool of TOOLS) await $.tool.register({ ...tool, isDeferred: false })

    for (const [name, description] of [
      ['needs', 'Open the Needs Human pane'],
      ['bm', 'Bookmark the current message: /bm [label]'],
      ['last', 'Jump to the latest message'],
      ['prev', 'Jump to the previous prompt'],
      ['next', 'Jump to the next prompt'],
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

  // Other sessions stop listing this one's questions; they are kept in the store.
  on('session.end', async ($, e, next) => {
    await writeOwn($, false)
    return next(e)
  })


  on('command.run', { command: 'needs' }, async $ => {
    await openPane($)
    return { text: 'Needs Human pane opened.' }
  })
  on('command.run', { command: 'bm' }, async ($, e) => ({ text: await mark($, e.args.trim()) }))
  on('command.run', { command: 'last' }, async $ => ({ text: (await jumpLast($)) || '↓ latest' }))
  on('command.run', { command: 'prev' }, async $ => ({ text: (await jumpPrev($)) || '↑ previous prompt' }))
  on('command.run', { command: 'next' }, async $ => ({ text: (await jumpNext($)) || '↓ next prompt' }))

  on('prompt.submit', async ($, e, next) => {
    S.cursor = -1
    return next(e)
  })

  // Engine waits: shown while they last, never sticky.
  on('tool.check', async ($, e, next) => {
    const verdict = await next(e)
    if (verdict.decision === 'ask' && e.tool_use_id && e.tool !== 'AskUserQuestion') {
      const input = e.input as Record<string, unknown> | null
      const detail = typeof input?.command === 'string' ? input.command : typeof input?.file_path === 'string' ? input.file_path : ''
      const id = `perm-${e.tool_use_id}`
      const text = clip(`permission: ${e.tool}${detail ? ` ${detail}` : ''}`, 160)
      const at = await $.clock.now()
      await changeWaits($, list => [...list.filter(w => w.id !== id), { id, text, at, requestId: e.tool_use_id }])
    }
    return verdict
  })

  on('tool.call', async ($, e, next) => {
    const own = await serveTool($, e.tool, e)
    if (own) return own
    // An AskUserQuestion is a wait while it is on screen.
    const isAsk = e.tool === 'AskUserQuestion'
    if (isAsk) {
      const input = argsOf(e) as { questions?: { question?: string }[] }
      const text = clip(input.questions?.[0]?.question ?? 'Question for you', 160)
      const id = `perm-${e.tool_use_id}`
      const at = await $.clock.now()
      await changeWaits($, list => [...list.filter(w => w.id !== id), { id, text, at, requestId: e.tool_use_id }])
    }
    try {
      return await next(e)
    } finally {
      const id = `perm-${e.tool_use_id}`
      if ((await read($, waits)).some(w => w.id === id)) await changeWaits($, list => list.filter(w => w.id !== id))
    }
  })

  on('ui.render', { component: 'UserMessage' }, async ($, e, next) => {
    if (e.props.origin.kind !== 'composer') return next(e)
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
    const own = (await read($, asks)).filter(isLive).length + (await read($, waits)).length
    const rest = (await read($, others)).reduce((n, f) => n + f.needs.length, 0)
    // The count lives in the status line; the band shows only when something waits.
    if (own + rest === 0) return next(e)
    const { Box, Button, Text } = $.ui.resolve(e)
    return (
      <Box>
        <Button key="needs" plain hotkey="n" onPress={() => void openPane($)}>
          <Text color="yellow" bold>NH {own}</Text>
          {rest > 0 && <Text dimColor> (+{rest} other)</Text>}
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
    const els = $.ui.resolve(e)
    const { Box, Button, Text } = els
    const Input = 'Input' in els ? els.Input : undefined
    const live = (await read($, asks)).filter(isLive)
    const done = (await read($, asks)).filter(a => !isLive(a)).slice(-3).reverse()
    const engineWaits = await read($, waits)
    const rest = await read($, others)
    const marks = await read($, bookmarks)
    const open = await read($, expanded)
    const typingId = await read($, typing)
    const width = Math.max(20, (e.props.bodyColumns ?? 60) - 12)
    const t = await $.clock.now()
    return (
      <Box flexDirection="column">
        <Text bold>Needs Human · {live.length} open</Text>
        {live.length === 0 && engineWaits.length === 0 && <Text dimColor>  nothing waiting on you</Text>}
        {engineWaits.map(w => (
          <Button key={`wait-${w.id}`} plain onPress={() => (w.requestId ? void scrollTo($, w.requestId) : undefined)}>
            <Text color="yellow">⏳ </Text>
            {clip(w.text, width)} <Text dimColor>{age(w.at, t)}</Text>
          </Button>
        ))}
        {live.map(a => (
          <Box key={`ask-${a.id}`} flexDirection="column" marginTop={1}>
            <Button key={`head-${a.id}`} plain onPress={() => void update($, expanded, cur => (cur === a.id ? '' : a.id))}>
              <Text color="yellow" bold>{a.id}</Text> {open === a.id ? a.question : clip(a.question, width - 8)}{' '}
              {isStale(a, t) && <Text color="red">STALE </Text>}
              <Text dimColor>{age(a.at, t)}</Text>
            </Button>
            {open === a.id && a.context && <Text dimColor>  {a.context}</Text>}
            {open === a.id &&
              ordered(a).map(o => (
                <Text key={`cost-${a.id}-${o.key}`} dimColor>
                  {'  '}
                  {o.key === a.recommended ? '★ ' : ''}
                  {o.key}: {o.label}
                  {o.cost ? ` (${o.cost})` : ''}
                </Text>
              ))}
            {a.status === 'sent' ? (
              <Text dimColor>  sent: {clip(a.answer ?? '', width)}</Text>
            ) : (
              <Box flexWrap="wrap">
                {ordered(a).map(o => (
                  <Box key={`optbox-${a.id}-${o.key}`} marginRight={1}>
                    <Button key={`opt-${a.id}-${o.key}`} onPress={() => void answer($, a.id, optionAnswer(o))}>
                      {o.key === a.recommended ? <Text color="green">★ {o.key} {clip(o.label, 28)}</Text> : `${o.key} ${clip(o.label, 28)}`}
                    </Button>
                  </Box>
                ))}
                <Button key={`other-${a.id}`} plain label="Other…" onPress={() => void update($, typing, cur => (cur === a.id ? '' : a.id))} />
              </Box>
            )}
            {Input && typingId === a.id && a.status === 'open' && (
              <Input
                key={`input-${a.id}`}
                autoFocus
                placeholder="Type your answer"
                submitLabel="send"
                onSubmit={(value: string) => void answer($, a.id, value.trim())}
              />
            )}
          </Box>
        ))}
        {done.length > 0 && <Text> </Text>}
        {done.map(a => (
          <Text key={`done-${a.id}`} dimColor>
            ✓ {a.id} {clip(a.question, width - 24)} → {a.status === 'withdrawn' ? 'withdrawn' : clip(a.answer ?? '', 18)}
          </Text>
        ))}
        <Text> </Text>
        <Text bold>Other sessions</Text>
        {rest.length === 0 && <Text dimColor>  all quiet</Text>}
        {rest.flatMap(f =>
          f.needs.map(n => (
            <Text key={`other-${f.sessionId}-${n.id}`}>
              <Text color="cyan">{clip(f.session, 16)}</Text> {n.id} {clip(n.question, width - 22)} <Text dimColor>{age(n.at, t)}</Text>
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
