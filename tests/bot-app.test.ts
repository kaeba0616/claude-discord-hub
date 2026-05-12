/**
 * Tier 2 integration tests for bot-app handlers.
 *
 * Drives the createApp() factory directly with fake Discord objects and a
 * controllable AppDeps. No real discord.js, no real claude-sessions.sh, no
 * real network.
 */

import { test, expect, describe } from 'bun:test'
import { createApp } from '../bot-app'
import {
  fakeMessage,
  fakeChannel,
  fakeThread,
  fakeInteraction,
  makeFakeDeps,
  makeSession,
  jsonReq,
  type FakeMessage,
  type FakeChannel,
} from './discord-fakes'

const CHANNEL = 'channel-1'

// ─── handleCommand ─────────────────────────────────────────────────────────

describe('handleCommand', () => {
  test('!help replies with help text (no deps used)', async () => {
    const { deps } = makeFakeDeps()
    const app = createApp(deps)
    const msg = fakeMessage({ content: '!help', channelId: CHANNEL })
    await app.handleCommand(msg.asDiscordMessage())
    expect(msg.replies).toHaveLength(1)
    expect(msg.replies[0].content).toContain('Claude Hub Commands')
  })

  test('!reload reloads routes and reports count', async () => {
    const routes = new Map([[CHANNEL, makeSession({ name: 'proj', channelId: CHANNEL })]])
    const { deps, spy } = makeFakeDeps({ routes })
    const app = createApp(deps)
    const msg = fakeMessage({ content: '!reload', channelId: CHANNEL })
    await app.handleCommand(msg.asDiscordMessage())
    expect(spy.reloadCount).toBe(1)
    expect(msg.replies[0].content).toContain('1 sessions configured')
  })

  test('!status calls script status and wraps output in code block', async () => {
    const { deps, spy } = makeFakeDeps({
      runScript: args => (args === 'status' ? 'all good' : ''),
    })
    const app = createApp(deps)
    const msg = fakeMessage({ content: '!status', channelId: CHANNEL })
    await app.handleCommand(msg.asDiscordMessage())
    expect(spy.scriptCalls).toEqual(['status'])
    expect(msg.replies[0].content).toBe('```\nall good\n```')
  })

  test('!start without linked route replies NOT_LINKED', async () => {
    const { deps, spy } = makeFakeDeps()
    const app = createApp(deps)
    const msg = fakeMessage({ content: '!start', channelId: 'unknown' })
    await app.handleCommand(msg.asDiscordMessage())
    expect(spy.scriptCalls).toHaveLength(0)
    expect(msg.replies[0].content).toContain('not linked')
  })

  test('!start on linked channel calls script start <name>', async () => {
    const routes = new Map([[CHANNEL, makeSession({ name: 'proj', channelId: CHANNEL })]])
    const { deps, spy } = makeFakeDeps({ routes })
    const app = createApp(deps)
    const msg = fakeMessage({ content: '!start', channelId: CHANNEL })
    await app.handleCommand(msg.asDiscordMessage())
    expect(spy.scriptCalls).toEqual(['start proj'])
    expect(msg.replies[0].content).toContain('✅')
    expect(msg.replies[0].content).toContain('proj')
  })

  test('!stop reports failure when script throws', async () => {
    const routes = new Map([[CHANNEL, makeSession({ name: 'proj', channelId: CHANNEL })]])
    const { deps } = makeFakeDeps({
      routes,
      runScript: () => {
        throw new Error('boom')
      },
    })
    const app = createApp(deps)
    const msg = fakeMessage({ content: '!stop', channelId: CHANNEL })
    await app.handleCommand(msg.asDiscordMessage())
    expect(msg.replies[0].content).toContain('❌')
    expect(msg.replies[0].content).toContain('proj')
  })

  test('!resume calls script with -c flag', async () => {
    const routes = new Map([[CHANNEL, makeSession({ name: 'proj', channelId: CHANNEL })]])
    const { deps, spy } = makeFakeDeps({ routes })
    const app = createApp(deps)
    const msg = fakeMessage({ content: '!resume', channelId: CHANNEL })
    await app.handleCommand(msg.asDiscordMessage())
    expect(spy.scriptCalls).toEqual(['start proj -c'])
  })

  test('!add happy path runs add + start and reloads', async () => {
    const { deps, spy } = makeFakeDeps()
    const app = createApp(deps)
    const msg = fakeMessage({ content: '!add proj /repo/path', channelId: CHANNEL })
    await app.handleCommand(msg.asDiscordMessage())
    expect(spy.scriptCalls).toEqual([
      `add proj /repo/path ${CHANNEL}`,
      'start proj ',
    ])
    expect(spy.reloadCount).toBe(1)
    expect(msg.replies[0].content).toContain('✅')
    expect(msg.replies[0].content).toContain('/repo/path')
  })

  test('!add with -c flag adds resume marker', async () => {
    const { deps, spy } = makeFakeDeps()
    const app = createApp(deps)
    const msg = fakeMessage({ content: '!add proj /repo/path -c', channelId: CHANNEL })
    await app.handleCommand(msg.asDiscordMessage())
    expect(spy.scriptCalls[1]).toBe('start proj -c')
    expect(msg.replies[0].content).toContain('Continuing last session')
  })

  test('!add on already-linked channel refuses', async () => {
    const routes = new Map([[CHANNEL, makeSession({ name: 'existing', channelId: CHANNEL })]])
    const { deps, spy } = makeFakeDeps({ routes })
    const app = createApp(deps)
    const msg = fakeMessage({ content: '!add new /repo', channelId: CHANNEL })
    await app.handleCommand(msg.asDiscordMessage())
    expect(spy.scriptCalls).toHaveLength(0)
    expect(msg.replies[0].content).toContain('already linked')
    expect(msg.replies[0].content).toContain('existing')
  })

  test('!add missing args prints usage', async () => {
    const { deps, spy } = makeFakeDeps()
    const app = createApp(deps)
    const msg = fakeMessage({ content: '!add', channelId: CHANNEL })
    await app.handleCommand(msg.asDiscordMessage())
    expect(spy.scriptCalls).toHaveLength(0)
    expect(msg.replies[0].content).toContain('Usage')
  })

  test('!add failure strips ANSI from error', async () => {
    const ansiErr = new Error('[31mfatal: bad path[0m')
    const { deps } = makeFakeDeps({
      runScript: () => {
        throw ansiErr
      },
    })
    const app = createApp(deps)
    const msg = fakeMessage({ content: '!add proj /repo', channelId: CHANNEL })
    await app.handleCommand(msg.asDiscordMessage())
    expect(msg.replies[0].content).toContain('fatal: bad path')
    expect(msg.replies[0].content).not.toContain('[')
  })

  test('!remove calls script remove and reloads', async () => {
    const routes = new Map([[CHANNEL, makeSession({ name: 'proj', channelId: CHANNEL })]])
    const { deps, spy } = makeFakeDeps({ routes })
    const app = createApp(deps)
    const msg = fakeMessage({ content: '!remove', channelId: CHANNEL })
    await app.handleCommand(msg.asDiscordMessage())
    expect(spy.scriptCalls).toEqual(['remove proj'])
    expect(spy.reloadCount).toBe(1)
  })

  test('!last on linked channel returns formatted latest', async () => {
    const routes = new Map([
      [CHANNEL, makeSession({ name: 'proj', channelId: CHANNEL, repoPath: '/r' })],
    ])
    const { deps } = makeFakeDeps({
      routes,
      listRecentSessions: () => [{ ts: '2026-05-10 12:00', id: 'sess-1', name: 'feat' }],
    })
    const app = createApp(deps)
    const msg = fakeMessage({ content: '!last', channelId: CHANNEL })
    await app.handleCommand(msg.asDiscordMessage())
    expect(msg.replies[0].content).toContain('feat')
    expect(msg.replies[0].content).toContain('sess-1')
  })

  test('!sessions empty list says none found', async () => {
    const routes = new Map([[CHANNEL, makeSession({ name: 'proj', channelId: CHANNEL })]])
    const { deps } = makeFakeDeps({ routes, listRecentSessions: () => [] })
    const app = createApp(deps)
    const msg = fakeMessage({ content: '!sessions', channelId: CHANNEL })
    await app.handleCommand(msg.asDiscordMessage())
    expect(msg.replies[0].content).toContain('No previous sessions')
  })

  test('unknown command suggests !help', async () => {
    const { deps } = makeFakeDeps()
    const app = createApp(deps)
    const msg = fakeMessage({ content: '!frobnicate', channelId: CHANNEL })
    await app.handleCommand(msg.asDiscordMessage())
    expect(msg.replies[0].content).toContain('Unknown command')
    expect(msg.replies[0].content).toContain('!help')
  })
})

// ─── handleMessage (non-command forwarding) ────────────────────────────────

describe('handleMessage forwarding', () => {
  test('ignores bot messages', async () => {
    const routes = new Map([[CHANNEL, makeSession({ name: 'proj', channelId: CHANNEL })]])
    const { deps, spy } = makeFakeDeps({ routes })
    const app = createApp(deps)
    const msg = fakeMessage({
      content: 'hello',
      channelId: CHANNEL,
      author: { bot: true },
    })
    await app.handleMessage(msg.asDiscordMessage())
    expect(spy.postCalls).toHaveLength(0)
    expect(msg.reactions).toHaveLength(0)
  })

  test('does nothing for unlinked channel', async () => {
    const { deps, spy } = makeFakeDeps()
    const app = createApp(deps)
    const msg = fakeMessage({ content: 'hello', channelId: 'unknown' })
    await app.handleMessage(msg.asDiscordMessage())
    expect(spy.postCalls).toHaveLength(0)
  })

  test('forwards user message to bridge and reacts 👀', async () => {
    const routes = new Map([
      [CHANNEL, makeSession({ name: 'proj', channelId: CHANNEL, port: 9100 })],
    ])
    const { deps, spy } = makeFakeDeps({ routes })
    const app = createApp(deps)
    const msg = fakeMessage({
      content: 'do the thing',
      channelId: CHANNEL,
      id: 'm-7',
      author: { id: 'u-1', username: 'alice' },
    })
    await app.handleMessage(msg.asDiscordMessage())
    expect(spy.postCalls).toHaveLength(1)
    expect(spy.postCalls[0].url).toBe('http://localhost:9100/message')
    expect(spy.postCalls[0].body).toMatchObject({
      content: 'do the thing',
      chat_id: CHANNEL,
      message_id: 'm-7',
      user: 'alice',
      user_id: 'u-1',
    })
    expect(msg.reactions).toEqual(['👀'])
  })

  test('reacts ❌ when bridge returns non-ok', async () => {
    const routes = new Map([[CHANNEL, makeSession({ name: 'proj', channelId: CHANNEL })]])
    const { deps } = makeFakeDeps({
      routes,
      postJSON: () => ({ ok: false, status: 500 }),
    })
    const app = createApp(deps)
    const msg = fakeMessage({ content: 'hi', channelId: CHANNEL })
    await app.handleMessage(msg.asDiscordMessage())
    expect(msg.reactions).toEqual(['❌'])
  })

  test('replies with start hint when bridge fetch throws', async () => {
    const routes = new Map([[CHANNEL, makeSession({ name: 'proj', channelId: CHANNEL })]])
    const { deps } = makeFakeDeps({
      routes,
      postJSON: () => {
        throw new Error('ECONNREFUSED')
      },
    })
    const app = createApp(deps)
    const msg = fakeMessage({ content: 'hi', channelId: CHANNEL })
    await app.handleMessage(msg.asDiscordMessage())
    expect(msg.replies[0].content).toContain('!start')
  })
})

// ─── handleSummaryCommand ──────────────────────────────────────────────────

describe('handleSummaryCommand', () => {
  test('refuses outside a thread', async () => {
    const { deps } = makeFakeDeps()
    const app = createApp(deps)
    const channel = fakeChannel({ id: CHANNEL })
    const msg = fakeMessage({
      content: '!summary',
      channelId: CHANNEL,
      channel,
    })
    await app.handleSummaryCommand(msg.asDiscordMessage())
    expect(msg.replies[0].content).toContain('스레드 안에서만')
  })

  test('refuses when thread parent is not linked', async () => {
    const { deps } = makeFakeDeps()
    const app = createApp(deps)
    const thread = fakeThread({ parentId: 'orphan-parent' })
    const msg = fakeMessage({ content: '!summary', channelId: 'thread-1', channel: thread })
    await app.handleSummaryCommand(msg.asDiscordMessage())
    expect(msg.replies[0].content).toContain('연결되어 있지 않아요')
  })

  test('refuses when parent channel is the summarizer itself', async () => {
    const parent = 'parent-1'
    const routes = new Map([
      [parent, makeSession({ name: 'summarizer', channelId: parent, isSummary: true })],
    ])
    const { deps } = makeFakeDeps({ routes })
    const app = createApp(deps)
    const thread = fakeThread({ parentId: parent })
    const msg = fakeMessage({ content: '!summary', channelId: 'thread-1', channel: thread })
    await app.handleSummaryCommand(msg.asDiscordMessage())
    expect(msg.replies[0].content).toContain('요약 전용 세션')
  })

  test('refuses when no summary session is configured', async () => {
    const parent = 'parent-1'
    const routes = new Map([[parent, makeSession({ name: 'proj', channelId: parent })]])
    const { deps } = makeFakeDeps({ routes })
    const app = createApp(deps)
    const thread = fakeThread({ parentId: parent })
    const msg = fakeMessage({ content: '!summary', channelId: 'thread-1', channel: thread })
    await app.handleSummaryCommand(msg.asDiscordMessage())
    expect(msg.replies[0].content).toContain('요약 세션이 설정되지')
  })

  test('refuses when transcript has no user messages', async () => {
    const parent = 'parent-1'
    const routes = new Map([[parent, makeSession({ name: 'proj', channelId: parent })]])
    const { deps } = makeFakeDeps({
      routes,
      summarySession: makeSession({
        name: 'summarizer',
        channelId: 'sum-ch',
        port: 9999,
        isSummary: true,
      }),
    })
    const app = createApp(deps)
    const thread = fakeThread({
      parentId: parent,
      transcript: [
        {
          id: '1',
          content: '!summary',
          author: { username: 'alice', bot: false },
          createdAt: new Date(),
        },
        {
          id: '2',
          content: 'bot blurb',
          author: { username: 'bot', bot: true },
          createdAt: new Date(),
        },
      ],
    })
    const msg = fakeMessage({ content: '!summary', channelId: 'thread-1', channel: thread })
    await app.handleSummaryCommand(msg.asDiscordMessage())
    expect(msg.replies[0].content).toContain('요약할 내용이 없어요')
  })

  test('happy path posts transcript to summarizer and registers pending', async () => {
    const parent = 'parent-1'
    const routes = new Map([[parent, makeSession({ name: 'proj', channelId: parent })]])
    const summarizer = makeSession({
      name: 'summarizer',
      channelId: 'sum-ch',
      port: 9999,
      isSummary: true,
    })
    const { deps, spy } = makeFakeDeps({
      routes,
      summarySession: summarizer,
      uuid: () => 'uuid-abc',
    })
    const app = createApp(deps)
    const thread = fakeThread({
      id: 'thread-x',
      parentId: parent,
      transcript: [
        {
          id: '1',
          content: 'let us ship the thing',
          author: { username: 'alice', bot: false },
          createdAt: new Date('2026-05-12T09:30:00Z'),
        },
        {
          id: '2',
          content: 'sgtm',
          author: { username: 'bob', bot: false },
          createdAt: new Date('2026-05-12T09:31:00Z'),
        },
      ],
    })
    const msg = fakeMessage({
      content: '!summary',
      channelId: 'thread-x',
      channel: thread,
      author: { id: 'u-1', username: 'alice' },
    })
    await app.handleSummaryCommand(msg.asDiscordMessage())

    // Status message posted
    expect(msg.replies[0].content).toContain('요약 중')
    // POST to summarizer
    expect(spy.postCalls).toHaveLength(1)
    expect(spy.postCalls[0].url).toBe('http://localhost:9999/message')
    const body = spy.postCalls[0].body as any
    expect(body.chat_id).toBe('sum-ch')
    expect(body.content).toContain('[alice 09:30]')
    expect(body.content).toContain('let us ship the thing')
    expect(body.content).toContain('[bob 09:31]')
    expect(body.content).toContain('[REQUEST_ID=uuid-abc]')

    // pendingSummaries populated
    expect(app.pendingSummaries.get('uuid-abc')).toMatchObject({
      threadId: 'thread-x',
      sessionName: 'proj',
    })
  })

  test('edits status message and clears pending when summarizer is unreachable', async () => {
    const parent = 'parent-1'
    const routes = new Map([[parent, makeSession({ name: 'proj', channelId: parent })]])
    const { deps } = makeFakeDeps({
      routes,
      summarySession: makeSession({
        name: 'summarizer',
        channelId: 'sum-ch',
        port: 9999,
        isSummary: true,
      }),
      postJSON: () => ({ ok: false, status: 500 }),
      uuid: () => 'uuid-fail',
    })
    const app = createApp(deps)
    const thread = fakeThread({
      parentId: parent,
      transcript: [
        {
          id: '1',
          content: 'hi',
          author: { username: 'alice', bot: false },
          createdAt: new Date(),
        },
      ],
    })
    const msg = fakeMessage({ content: '!summary', channelId: 'thread-1', channel: thread })
    await app.handleSummaryCommand(msg.asDiscordMessage())
    expect(msg.replies[0].edits.at(-1)).toContain('요약 세션이 응답하지')
    expect(app.pendingSummaries.has('uuid-fail')).toBe(false)
  })
})

// ─── tryHandleSummaryReply & forwardSummaryToSession ───────────────────────

describe('summary reply parsing + forwarding', () => {
  test('parses JSON inside fenced code block and forwards to target session', async () => {
    const target = makeSession({
      name: 'proj',
      channelId: 'target-ch',
      port: 9200,
    })
    const channels = new Map<string, FakeChannel>([
      ['thread-x', fakeChannel({ id: 'thread-x' })],
      ['target-ch', fakeChannel({ id: 'target-ch' })],
    ])
    const { deps, spy } = makeFakeDeps({
      channels,
      sessions: [target],
    })
    const app = createApp(deps)
    // Pre-seed the pending summary
    app.pendingSummaries.set('req-1', {
      threadId: 'thread-x',
      requesterId: 'user-1',
      statusMsgId: 'status-msg',
      sessionName: 'proj',
    })
    // Also stash a "status" message inside the thread channel so editStatus works
    const threadCh = channels.get('thread-x')!
    threadCh.messages.stored.set('status-msg', {
      id: 'status-msg',
      opts: { content: '🔄 요약 중...' },
      edits: [],
      async edit(content: string) {
        this.edits.push(content)
        return this
      },
    } as any)

    const replyText = '```json\n{"request_id":"req-1","summary":"## 결정사항\\n- ship"}\n```'
    const handled = await app.tryHandleSummaryReply(replyText)
    expect(handled).toBe(true)
    expect(app.pendingSummaries.has('req-1')).toBe(false)

    // Allow the fire-and-forget forwardSummaryToSession to complete
    await new Promise(r => setTimeout(r, 20))

    // Forwarded to target session
    const fwd = spy.postCalls.find(c => c.url === 'http://localhost:9200/message')
    expect(fwd).toBeDefined()
    expect((fwd!.body as any).content).toContain('## 결정사항')
    expect((fwd!.body as any).chat_id).toBe('target-ch')

    // Summary echoed to thread
    expect(threadCh.sent[0].opts.content).toContain('📝 **요약**')
    // Status message edited to success
    const statusMsg = threadCh.messages.stored.get('status-msg')!
    expect(statusMsg.edits.at(-1)).toContain('✅')
  })

  test('returns false for non-JSON, unknown request_id, or missing fields', async () => {
    const { deps } = makeFakeDeps()
    const app = createApp(deps)
    expect(await app.tryHandleSummaryReply('no json here')).toBe(false)
    expect(await app.tryHandleSummaryReply('```json\n{"hello":"world"}\n```')).toBe(false)
    expect(
      await app.tryHandleSummaryReply(
        '```json\n{"request_id":"missing","summary":"x"}\n```',
      ),
    ).toBe(false)
  })

  test('forwardSummaryToSession reports error when target session vanished', async () => {
    const channels = new Map<string, FakeChannel>([['thread-x', fakeChannel({ id: 'thread-x' })]])
    const threadCh = channels.get('thread-x')!
    threadCh.messages.stored.set('status-msg', {
      id: 'status-msg',
      opts: {},
      edits: [],
      async edit(content: string) {
        this.edits.push(content)
        return this
      },
    } as any)
    const { deps } = makeFakeDeps({ channels, sessions: [] })
    const app = createApp(deps)
    await app.forwardSummaryToSession('summary', {
      threadId: 'thread-x',
      statusMsgId: 'status-msg',
      sessionName: 'gone',
    })
    const statusMsg = threadCh.messages.stored.get('status-msg')!
    expect(statusMsg.edits.at(-1)).toContain('사라졌어요')
  })
})

// ─── handleReply (HTTP /reply) ─────────────────────────────────────────────

describe('handleReply HTTP', () => {
  test('sends single chunk to channel and returns message_ids', async () => {
    const ch = fakeChannel({ id: 'ch-x' })
    const channels = new Map<string, FakeChannel>([['ch-x', ch]])
    const { deps } = makeFakeDeps({ channels })
    const app = createApp(deps)
    const res = await app.handleReply(
      jsonReq('http://x/reply', { channel_id: 'ch-x', text: 'hi' }),
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as any
    expect(body.ok).toBe(true)
    expect(body.message_ids).toEqual(['sent-1'])
    expect(ch.sent[0].opts).toEqual({ content: 'hi' })
  })

  test('splits long text into multiple 2000-char chunks', async () => {
    const ch = fakeChannel({ id: 'ch-x' })
    const channels = new Map<string, FakeChannel>([['ch-x', ch]])
    const { deps } = makeFakeDeps({ channels })
    const app = createApp(deps)
    const text = 'a'.repeat(2500)
    const res = await app.handleReply(
      jsonReq('http://x/reply', { channel_id: 'ch-x', text }),
    )
    expect(res.status).toBe(200)
    expect(ch.sent).toHaveLength(2)
    expect(ch.sent[0].opts.content.length + ch.sent[1].opts.content.length).toBe(2500)
  })

  test('first chunk carries reply_to when provided', async () => {
    const ch = fakeChannel({ id: 'ch-x' })
    const channels = new Map<string, FakeChannel>([['ch-x', ch]])
    const { deps } = makeFakeDeps({ channels })
    const app = createApp(deps)
    await app.handleReply(
      jsonReq('http://x/reply', { channel_id: 'ch-x', text: 'hi', reply_to: 'src-1' }),
    )
    expect(ch.sent[0].opts.reply).toEqual({
      messageReference: 'src-1',
      failIfNotExists: false,
    })
  })

  test('returns 404 when channel cannot be fetched', async () => {
    const { deps } = makeFakeDeps()
    const app = createApp(deps)
    const res = await app.handleReply(
      jsonReq('http://x/reply', { channel_id: 'missing', text: 'hi' }),
    )
    expect(res.status).toBe(404)
  })

  test('intercepts reply on summary channel and does NOT send to discord', async () => {
    const summaryCh = 'sum-ch'
    const target = makeSession({ name: 'proj', channelId: 'target', port: 9200 })
    const targetChannel = fakeChannel({ id: 'target' })
    const channels = new Map<string, FakeChannel>([
      ['target', targetChannel],
      [summaryCh, fakeChannel({ id: summaryCh })],
    ])
    const { deps } = makeFakeDeps({
      channels,
      summarySession: makeSession({
        name: 'summarizer',
        channelId: summaryCh,
        port: 9999,
        isSummary: true,
      }),
      sessions: [target],
    })
    const app = createApp(deps)
    app.pendingSummaries.set('req-x', {
      threadId: 'thread-1',
      requesterId: 'u',
      statusMsgId: 's',
      sessionName: 'proj',
    })
    const replyText = '```json\n{"request_id":"req-x","summary":"hello"}\n```'
    const res = await app.handleReply(
      jsonReq('http://x/reply', { channel_id: summaryCh, text: replyText }),
    )
    const body = (await res.json()) as any
    expect(body.intercepted).toBe(true)
    // summarizer channel itself should not have been "send"-ed to
    expect(channels.get(summaryCh)!.sent).toHaveLength(0)
  })
})

// ─── handlePermission (HTTP /permission) ───────────────────────────────────

describe('handlePermission HTTP', () => {
  test('posts a button message and records pending permission', async () => {
    const ch = fakeChannel({ id: CHANNEL })
    const channels = new Map<string, FakeChannel>([[CHANNEL, ch]])
    const routes = new Map([
      [CHANNEL, makeSession({ name: 'proj', channelId: CHANNEL, port: 9300 })],
    ])
    const { deps } = makeFakeDeps({ channels, routes })
    const app = createApp(deps)
    const res = await app.handlePermission(
      jsonReq('http://x/permission', {
        channel_id: CHANNEL,
        request_id: 'req-1',
        tool_name: 'Bash',
        description: 'run ls',
        input_preview: 'ls -la',
      }),
    )
    expect(res.status).toBe(200)
    expect(ch.sent).toHaveLength(1)
    const sent = ch.sent[0].opts as any
    expect(sent.content).toContain('🔐 **Bash**')
    expect(sent.content).toContain('run ls')
    expect(sent.content).toContain('ls -la')
    expect(sent.components).toHaveLength(1)

    expect(app.pendingPermissions.get('req-1')).toEqual({
      channelId: CHANNEL,
      port: 9300,
    })
  })

  test('returns 404 when channel cannot be fetched', async () => {
    const { deps } = makeFakeDeps()
    const app = createApp(deps)
    const res = await app.handlePermission(
      jsonReq('http://x/permission', {
        channel_id: 'missing',
        request_id: 'req-x',
        tool_name: 'Bash',
        description: 'x',
      }),
    )
    expect(res.status).toBe(404)
    expect(app.pendingPermissions.has('req-x')).toBe(false)
  })
})

// ─── handlePermissionButton ────────────────────────────────────────────────

describe('handlePermissionButton', () => {
  test('allow click POSTs allow to bridge and deletes the button message', async () => {
    const { deps, spy } = makeFakeDeps()
    const app = createApp(deps)
    app.pendingPermissions.set('req-1', { channelId: CHANNEL, port: 9300 })
    const interaction = fakeInteraction('perm:allow:req-1')

    await app.handlePermissionButton(interaction.asButtonInteraction())

    expect(spy.postCalls).toHaveLength(1)
    expect(spy.postCalls[0].url).toBe('http://localhost:9300/permission-response')
    expect(spy.postCalls[0].body).toEqual({ request_id: 'req-1', behavior: 'allow' })
    expect(app.pendingPermissions.has('req-1')).toBe(false)
    expect(interaction.message.deleted).toBe(true)
    expect(interaction.deferred).toBe(true)
  })

  test('deny click POSTs deny', async () => {
    const { deps, spy } = makeFakeDeps()
    const app = createApp(deps)
    app.pendingPermissions.set('req-2', { channelId: CHANNEL, port: 9300 })
    const interaction = fakeInteraction('perm:deny:req-2')

    await app.handlePermissionButton(interaction.asButtonInteraction())

    expect(spy.postCalls[0].body).toEqual({ request_id: 'req-2', behavior: 'deny' })
  })

  test('expired (unknown request) replies ephemerally and does not POST', async () => {
    const { deps, spy } = makeFakeDeps()
    const app = createApp(deps)
    const interaction = fakeInteraction('perm:allow:missing')

    await app.handlePermissionButton(interaction.asButtonInteraction())

    expect(spy.postCalls).toHaveLength(0)
    expect(interaction.replies[0].content).toContain('expired')
    expect(interaction.replies[0].ephemeral).toBe(true)
  })

  test('ignores non-perm customIds', async () => {
    const { deps, spy } = makeFakeDeps()
    const app = createApp(deps)
    const interaction = fakeInteraction('unrelated:button')
    await app.handlePermissionButton(interaction.asButtonInteraction())
    expect(spy.postCalls).toHaveLength(0)
    expect(interaction.replies).toHaveLength(0)
  })
})
