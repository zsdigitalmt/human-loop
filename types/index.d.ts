export type NeedKind = 'ask' | 'permission' | 'question' | 'manual'

export type Need = {
  id: string
  kind: NeedKind
  text: string
  at: number
  requestId?: string
}

export type SessionNeeds = { session: string; sessionId: string; updatedAt: number; needs: Need[] }

export type Bookmark = { requestId: string; label: string; at: number }

declare module 'claude-code' {
  interface PluginState {
    'human-loop': {
      needs: Need[]
      others: SessionNeeds[]
      bookmarks: Bookmark[]
    }
  }
}
