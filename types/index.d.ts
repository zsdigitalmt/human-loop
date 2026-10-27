export type Option = { key: string; label: string; cost?: string }

export type AskStatus = 'open' | 'sent' | 'answered' | 'withdrawn'

// A question the agent put to its human through `ask_human`.
export type Ask = {
  id: string
  question: string
  options: Option[]
  recommended?: string
  context?: string
  at: number
  status: AskStatus
  answer?: string
  closedAt?: number
}

// Transient waits the engine raises: a permission prompt or an AskUserQuestion.
export type Wait = { id: string; text: string; at: number; requestId?: string }

export type SessionNeeds = { session: string; sessionId: string; updatedAt: number; needs: Ask[] }

export type Bookmark = { requestId: string; label: string; at: number }

declare module 'claude-code' {
  interface PluginState {
    'human-loop': {
      asks: Ask[]
      waits: Wait[]
      others: SessionNeeds[]
      bookmarks: Bookmark[]
      expanded: string
      typing: string
    }
  }
}
