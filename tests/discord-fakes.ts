/**
 * Lightweight Discord/MCP fakes that satisfy the structural shapes used by
 * bot-app handlers. Each fake records calls so tests can assert behavior.
 */

import type { Message, ButtonInteraction } from 'discord.js'
import type { AppDeps, DiscordChannel, SessionEntry } from '../bot-app'
import type { SessionConfig } from '../config'

// ─── Fake Message ──────────────────────────────────────────────────────────

export interface FakeReply {
  id: string
  content: string
  edits: string[]
  edit(content: string): Promise<FakeReply>
  delete(): Promise<void>
}

export interface FakeMessage {
  id: string
  content: string
  channelId: string
  channel: unknown
  author: { id: string; username: string; bot: boolean }
  createdAt: Date
  replies: FakeReply[]
  reactions: string[]
  reply(content: string): Promise<FakeReply>
  react(emoji: string): Promise<unknown>
  asDiscordMessage(): Message
}

interface FakeMessageOpts {
  id?: string
  content: string
  channelId: string
  channel?: unknown
  author?: { id?: string; username?: string; bot?: boolean }
  createdAt?: Date
}

export function fakeMessage(opts: FakeMessageOpts): FakeMessage {
  const replies: FakeReply[] = []
  const reactions: string[] = []
  let replyCounter = 0

  const msg: FakeMessage = {
    id: opts.id ?? `msg-${Math.random().toString(36).slice(2, 8)}`,
    content: opts.content,
    channelId: opts.channelId,
    channel: opts.channel,
    author: {
      id: opts.author?.id ?? 'user-1',
      username: opts.author?.username ?? 'tester',
      bot: opts.author?.bot ?? false,
    },
    createdAt: opts.createdAt ?? new Date('2026-05-12T00:00:00.000Z'),
    replies,
    reactions,
    async reply(content: string): Promise<FakeReply> {
      const id = `reply-${++replyCounter}`
      const edits: string[] = []
      const reply: FakeReply = {
        id,
        content,
        edits,
        async edit(newContent: string) {
          edits.push(newContent)
          reply.content = newContent
          return reply
        },
        async delete() {},
      }
      replies.push(reply)
      return reply
    },
    async react(emoji: string) {
      reactions.push(emoji)
      return {}
    },
    asDiscordMessage() {
      return msg as unknown as Message
    },
  }
  return msg
}

// ─── Fake Channel ──────────────────────────────────────────────────────────

export interface SentMessage {
  id: string
  opts: any
  edits: string[]
  edit(content: string): Promise<unknown>
}

export interface FakeChannel extends DiscordChannel {
  id: string
  sent: SentMessage[]
  textBased: boolean
  isTextBased(): boolean
  send(opts: any): Promise<{ id: string }>
  messages: {
    fetch(idOrOpts: any): Promise<any>
    stored: Map<string, SentMessage>
  }
}

export function fakeChannel(opts?: {
  id?: string
  textBased?: boolean
  // optional fetch-by-id (returns SentMessage already in `sent` if known)
}): FakeChannel {
  const sent: SentMessage[] = []
  const stored = new Map<string, SentMessage>()
  let counter = 0
  const channel: FakeChannel = {
    id: opts?.id ?? 'channel-1',
    sent,
    textBased: opts?.textBased ?? true,
    isTextBased() {
      return this.textBased
    },
    async send(sendOpts: any) {
      const id = `sent-${++counter}`
      const edits: string[] = []
      const m: SentMessage = {
        id,
        opts: sendOpts,
        edits,
        async edit(content: string) {
          edits.push(content)
          return m
        },
      }
      sent.push(m)
      stored.set(id, m)
      return { id }
    },
    messages: {
      stored,
      async fetch(idOrOpts: any) {
        if (typeof idOrOpts === 'string') {
          const m = stored.get(idOrOpts)
          if (!m) throw new Error(`fake message not found: ${idOrOpts}`)
          return m
        }
        // fetch({limit}) — caller should swap the channel.messages.fetch for thread tests
        return new Map()
      },
    },
  }
  return channel
}

// ─── Fake Thread ───────────────────────────────────────────────────────────

export interface FakeThreadMessage {
  id: string
  content: string
  author: { username: string; bot: boolean }
  createdAt: Date
}

export interface FakeThread extends FakeChannel {
  parentId: string | null
  isThread(): boolean
  transcript: FakeThreadMessage[]
}

export function fakeThread(opts: {
  id?: string
  parentId: string | null
  transcript?: FakeThreadMessage[]
}): FakeThread {
  const base = fakeChannel({ id: opts.id ?? 'thread-1' })
  const transcript = opts.transcript ?? []
  const thread = base as FakeThread
  thread.parentId = opts.parentId
  thread.isThread = () => true
  thread.transcript = transcript
  // Override messages.fetch so handleSummaryCommand gets a Map-like with .values()
  thread.messages = {
    stored: base.messages.stored,
    async fetch(idOrOpts: any) {
      if (typeof idOrOpts === 'string') return base.messages.fetch(idOrOpts)
      const map = new Map<string, FakeThreadMessage>()
      for (const m of transcript) map.set(m.id, m)
      return map
    },
  }
  return thread
}

// ─── Fake Interaction (button click) ───────────────────────────────────────

export interface FakeInteraction {
  customId: string
  message: { id: string; deleted: boolean; delete(): Promise<void> }
  replies: Array<{ content: string; ephemeral?: boolean }>
  deferred: boolean
  reply(opts: { content: string; ephemeral?: boolean }): Promise<void>
  deferUpdate(): Promise<void>
  asButtonInteraction(): ButtonInteraction
}

export function fakeInteraction(customId: string): FakeInteraction {
  let deleted = false
  const replies: Array<{ content: string; ephemeral?: boolean }> = []
  const interaction: FakeInteraction = {
    customId,
    message: {
      id: 'btn-msg',
      get deleted() {
        return deleted
      },
      async delete() {
        deleted = true
      },
    },
    replies,
    deferred: false,
    async reply(opts) {
      replies.push(opts)
    },
    async deferUpdate() {
      interaction.deferred = true
    },
    asButtonInteraction() {
      return interaction as unknown as ButtonInteraction
    },
  }
  return interaction
}

// ─── Deps factory ──────────────────────────────────────────────────────────

export interface DepsSpy {
  postCalls: Array<{ url: string; body: unknown; response: { ok: boolean; status: number; body: unknown } }>
  scriptCalls: string[]
  reloadCount: number
}

export interface FakeDepsConfig {
  routes?: Map<string, SessionConfig>
  summarySession?: SessionConfig
  sessions?: SessionConfig[]
  // Channel lookups go through this map; fallback returns null.
  channels?: Map<string, FakeChannel>
  // runScript: by default returns "" success. Set per-arg-match to override or throw.
  runScript?: (args: string) => string
  // postJSON: by default returns 200 ok. Set per-url-match to override.
  postJSON?: (url: string, body: unknown) => { ok?: boolean; status?: number; body?: unknown }
  listRecentSessions?: (repoPath: string, limit: number) => SessionEntry[]
  uuid?: () => string
  now?: () => Date
}

export function makeFakeDeps(cfg: FakeDepsConfig = {}): {
  deps: AppDeps
  spy: DepsSpy
} {
  const spy: DepsSpy = { postCalls: [], scriptCalls: [], reloadCount: 0 }
  const routes = cfg.routes ?? new Map<string, SessionConfig>()
  const channels = cfg.channels ?? new Map<string, FakeChannel>()

  const deps: AppDeps = {
    routes: () => routes,
    reloadRoutes: () => {
      spy.reloadCount += 1
    },
    findSummarySession: () => cfg.summarySession,
    loadSessions: () => cfg.sessions ?? [],
    runScript: (args, _timeoutMs) => {
      spy.scriptCalls.push(args)
      return cfg.runScript ? cfg.runScript(args) : ''
    },
    listRecentSessions: (repo, limit) =>
      cfg.listRecentSessions ? cfg.listRecentSessions(repo, limit) : [],
    postJSON: async (url, body) => {
      const override = cfg.postJSON?.(url, body)
      const ok = override?.ok ?? true
      const status = override?.status ?? (ok ? 200 : 500)
      const respBody = override?.body ?? { ok }
      const res = new Response(JSON.stringify(respBody), {
        status,
        headers: { 'content-type': 'application/json' },
      })
      spy.postCalls.push({ url, body, response: { ok: res.ok, status, body: respBody } })
      return res
    },
    sessionUrl: (port, path) => `http://localhost:${port}${path}`,
    fetchChannel: async id => channels.get(id) ?? null,
    uuid: cfg.uuid ?? (() => 'test-uuid-1'),
    now: cfg.now ?? (() => new Date('2026-05-12T00:00:00.000Z')),
  }

  return { deps, spy }
}

// ─── Convenience builders ──────────────────────────────────────────────────

export function makeSession(overrides: Partial<SessionConfig> & { name: string }): SessionConfig {
  return {
    name: overrides.name,
    repoPath: overrides.repoPath ?? '/home/test/repo',
    channelId: overrides.channelId ?? 'channel-1',
    port: overrides.port ?? 9001,
    isSummary: overrides.isSummary ?? false,
  }
}

export function jsonReq(url: string, body: unknown): Request {
  return new Request(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}
