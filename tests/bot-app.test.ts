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
  fakeModalSubmit,
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

  test('!quickstart sends the quickstart text to the channel', async () => {
    const ch = fakeChannel({ id: CHANNEL })
    const channels = new Map([[CHANNEL, ch]])
    const { deps } = makeFakeDeps({
      channels,
      quickstartText: () => '# Quickstart\n\nstep 1',
    })
    const app = createApp(deps)
    const msg = fakeMessage({ content: '!quickstart', channelId: CHANNEL })
    await app.handleCommand(msg.asDiscordMessage())
    expect(ch.sent).toHaveLength(1)
    expect(ch.sent[0].opts.content).toBe('# Quickstart\n\nstep 1')
  })

  test('!quickstart chunks long content into multiple 2000-char messages', async () => {
    const ch = fakeChannel({ id: CHANNEL })
    const channels = new Map([[CHANNEL, ch]])
    const big = 'a'.repeat(5000)
    const { deps } = makeFakeDeps({
      channels,
      quickstartText: () => big,
    })
    const app = createApp(deps)
    const msg = fakeMessage({ content: '!quickstart', channelId: CHANNEL })
    await app.handleCommand(msg.asDiscordMessage())
    expect(ch.sent.length).toBeGreaterThanOrEqual(2)
    const reassembled = ch.sent.map(s => s.opts.content).join('')
    expect(reassembled).toBe(big)
  })

  test('!quickstart works in an unlinked channel too', async () => {
    const ch = fakeChannel({ id: 'unlinked' })
    const channels = new Map([['unlinked', ch]])
    const { deps } = makeFakeDeps({ channels })
    const app = createApp(deps)
    const msg = fakeMessage({ content: '!quickstart', channelId: 'unlinked' })
    await app.handleCommand(msg.asDiscordMessage())
    expect(ch.sent).toHaveLength(1)
    expect(ch.sent[0].opts.content).toContain('QUICKSTART')
  })

  test('!help includes !quickstart in the listing', async () => {
    const { deps } = makeFakeDeps()
    const app = createApp(deps)
    const msg = fakeMessage({ content: '!help', channelId: CHANNEL })
    await app.handleCommand(msg.asDiscordMessage())
    expect(msg.replies[0].content).toContain('!quickstart')
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

// ─── handleSummaryCommand (ephemeral) ──────────────────────────────────────

// Common helpers for ephemeral tests
const PARENT = 'parent-1'
const TEMPLATE = makeSession({
  name: 'summarizer',
  channelId: 'template-ch',
  port: 9999,
  isSummary: true,
  repoPath: '/home/hidi/work/summarizer-workspace',
})

function makeRoutesWithParent() {
  return new Map([[PARENT, makeSession({ name: 'proj', channelId: PARENT })]])
}

function makeThreadWithTranscript(opts?: {
  parentId?: string | null
  transcript?: Array<{ id: string; content: string; author: { username: string; bot: boolean }; createdAt: Date }>
}) {
  return fakeThread({
    id: 'thread-x',
    parentId: opts?.parentId === undefined ? PARENT : opts.parentId,
    transcript:
      opts?.transcript ?? [
        {
          id: '1',
          content: 'ship the migration',
          author: { username: 'alice', bot: false },
          createdAt: new Date('2026-05-12T09:30:00Z'),
        },
      ],
  })
}

describe('handleSummaryCommand (refusal paths)', () => {
  test('refuses outside a thread', async () => {
    const { deps } = makeFakeDeps()
    const app = createApp(deps)
    const channel = fakeChannel({ id: CHANNEL })
    const msg = fakeMessage({ content: '!summary', channelId: CHANNEL, channel })
    await app.handleSummaryCommand(msg.asDiscordMessage())
    expect(msg.replies[0].content).toContain('스레드 안에서만')
  })

  test('refuses when thread parent is not linked', async () => {
    const { deps } = makeFakeDeps()
    const app = createApp(deps)
    const thread = makeThreadWithTranscript({ parentId: 'orphan-parent' })
    const msg = fakeMessage({ content: '!summary', channelId: 'thread-x', channel: thread })
    await app.handleSummaryCommand(msg.asDiscordMessage())
    expect(msg.replies[0].content).toContain('연결되어 있지 않아요')
  })

  test('refuses when parent channel is the summarizer itself', async () => {
    const routes = new Map([
      [PARENT, makeSession({ name: 'summarizer', channelId: PARENT, isSummary: true })],
    ])
    const { deps } = makeFakeDeps({ routes })
    const app = createApp(deps)
    const thread = makeThreadWithTranscript()
    const msg = fakeMessage({ content: '!summary', channelId: 'thread-x', channel: thread })
    await app.handleSummaryCommand(msg.asDiscordMessage())
    expect(msg.replies[0].content).toContain('요약 전용 세션')
  })

  test('refuses when summarizer template is not configured', async () => {
    const { deps } = makeFakeDeps({ routes: makeRoutesWithParent() })
    const app = createApp(deps)
    const thread = makeThreadWithTranscript()
    const msg = fakeMessage({ content: '!summary', channelId: 'thread-x', channel: thread })
    await app.handleSummaryCommand(msg.asDiscordMessage())
    expect(msg.replies[0].content).toContain('summarizer 템플릿')
  })

  test('refuses when transcript has no user messages', async () => {
    const { deps, spy } = makeFakeDeps({
      routes: makeRoutesWithParent(),
      summarySession: TEMPLATE,
    })
    const app = createApp(deps)
    const thread = makeThreadWithTranscript({
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
    const msg = fakeMessage({ content: '!summary', channelId: 'thread-x', channel: thread })
    await app.handleSummaryCommand(msg.asDiscordMessage())
    expect(msg.replies[0].content).toContain('요약할 내용이 없어요')
    expect(spy.scriptCalls).toHaveLength(0) // no spawn attempted
  })
})

describe('handleSummaryCommand (ephemeral spawn happy path)', () => {
  test('spawns ephemeral, posts transcript, registers pending', async () => {
    let uuidCounter = 0
    const uuids = ['e1f2a3b4c5d6e7f8', 'req-uuid']
    const { deps, spy } = makeFakeDeps({
      routes: makeRoutesWithParent(),
      summarySession: TEMPLATE,
      readSessionConf: name =>
        name.startsWith('ephemeral-')
          ? makeSession({ name, channelId: name, port: 9500, repoPath: TEMPLATE.repoPath })
          : undefined,
      uuid: () => uuids[uuidCounter++ % uuids.length]!,
    })
    const app = createApp(deps)
    const thread = makeThreadWithTranscript({
      transcript: [
        {
          id: '1',
          content: 'ship the migration',
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

    const name = 'ephemeral-e1f2a3b4'
    // 1. Script: add + start
    expect(spy.scriptCalls).toEqual([
      `add ${name} ${TEMPLATE.repoPath} ${name}`,
      `start ${name}`,
    ])
    // 2. transcript POSTed to the bridge port returned by readSessionConf
    expect(spy.postCalls).toHaveLength(1)
    expect(spy.postCalls[0].url).toBe('http://localhost:9500/message')
    const body = spy.postCalls[0].body as any
    expect(body.chat_id).toBe(name)
    expect(body.content).toContain('[alice 09:30]')
    expect(body.content).toContain('ship the migration')
    expect(body.content).toContain('[bob 09:31]')
    expect(body.content).toContain('[REQUEST_ID=req-uuid]')
    // 3. Pending entry registered keyed by ephemeral name, parent captured
    expect(app.ephemeralSummaries.get(name)).toMatchObject({
      name,
      port: 9500,
      threadId: 'thread-x',
      requestId: 'req-uuid',
      parentChannelId: PARENT,
      parentSessionName: 'proj',
    })
    // 4. Status message edited to "Claude가 요약 중"
    const status = msg.replies[0]
    expect(status.edits.at(-1)).toContain('요약 중')

    // Cleanup the running timeout to avoid leaking into other tests
    const ctx = app.ephemeralSummaries.get(name)!
    if (ctx.timeoutHandle) clearTimeout(ctx.timeoutHandle)
  })
})

describe('handleSummaryCommand (failure paths cleanup)', () => {
  test('removes ephemeral when bridge never becomes healthy', async () => {
    const { deps, spy } = makeFakeDeps({
      routes: makeRoutesWithParent(),
      summarySession: TEMPLATE,
      readSessionConf: name =>
        makeSession({ name, channelId: name, port: 9500, repoPath: TEMPLATE.repoPath }),
      bridgeHealthy: () => false,
      sleep: () => Promise.resolve(),
      bootTimeoutMs: 50,
      uuid: () => 'aaaaaaaa',
    })
    const app = createApp(deps)
    const msg = fakeMessage({
      content: '!summary',
      channelId: 'thread-x',
      channel: makeThreadWithTranscript(),
    })
    await app.handleSummaryCommand(msg.asDiscordMessage())
    const name = 'ephemeral-aaaaaaaa'
    expect(spy.scriptCalls).toEqual([
      `add ${name} ${TEMPLATE.repoPath} ${name}`,
      `start ${name}`,
      `remove ${name}`,
    ])
    expect(spy.postCalls).toHaveLength(0)
    expect(app.ephemeralSummaries.has(name)).toBe(false)
    expect(msg.replies[0].edits.at(-1)).toContain('부팅되지 않았')
  })

  test('removes ephemeral when readSessionConf returns nothing', async () => {
    const { deps, spy } = makeFakeDeps({
      routes: makeRoutesWithParent(),
      summarySession: TEMPLATE,
      readSessionConf: () => undefined,
      uuid: () => 'bbbbbbbb',
    })
    const app = createApp(deps)
    const msg = fakeMessage({
      content: '!summary',
      channelId: 'thread-x',
      channel: makeThreadWithTranscript(),
    })
    await app.handleSummaryCommand(msg.asDiscordMessage())
    expect(spy.scriptCalls).toContain(`remove ephemeral-bbbbbbbb`)
    expect(msg.replies[0].edits.at(-1)).toContain('conf를 읽지')
  })

  test('removes ephemeral when bridge POST fails', async () => {
    const { deps, spy } = makeFakeDeps({
      routes: makeRoutesWithParent(),
      summarySession: TEMPLATE,
      readSessionConf: name =>
        makeSession({ name, channelId: name, port: 9500, repoPath: TEMPLATE.repoPath }),
      bridgeHealthy: () => true,
      sleep: () => Promise.resolve(),
      postJSON: () => ({ ok: false, status: 500 }),
      uuid: () => 'cccccccc',
    })
    const app = createApp(deps)
    const msg = fakeMessage({
      content: '!summary',
      channelId: 'thread-x',
      channel: makeThreadWithTranscript(),
    })
    await app.handleSummaryCommand(msg.asDiscordMessage())
    const name = 'ephemeral-cccccccc'
    expect(spy.scriptCalls.at(-1)).toBe(`remove ${name}`)
    expect(app.ephemeralSummaries.has(name)).toBe(false)
    expect(msg.replies[0].edits.at(-1)).toContain('transcript를 받지')
  })

  test('removes ephemeral when add script throws', async () => {
    const { deps, spy } = makeFakeDeps({
      routes: makeRoutesWithParent(),
      summarySession: TEMPLATE,
      runScript: args => {
        if (args.startsWith('add ')) throw new Error('disk full')
        return ''
      },
      uuid: () => 'dddddddd',
    })
    const app = createApp(deps)
    const msg = fakeMessage({
      content: '!summary',
      channelId: 'thread-x',
      channel: makeThreadWithTranscript(),
    })
    await app.handleSummaryCommand(msg.asDiscordMessage())
    expect(spy.scriptCalls).toContain('remove ephemeral-dddddddd')
    expect(msg.replies[0].edits.at(-1)).toContain('spawn 실패')
  })
})

describe('tryHandleEphemeralReply', () => {
  test('returns false when channel_id is not ephemeral', async () => {
    const { deps } = makeFakeDeps()
    const app = createApp(deps)
    const handled = await app.tryHandleEphemeralReply('normal-channel', 'hello')
    expect(handled).toBe(false)
  })

  test('returns false when no pending entry for that ephemeral', async () => {
    const { deps } = makeFakeDeps()
    const app = createApp(deps)
    const handled = await app.tryHandleEphemeralReply('ephemeral-unknown', 'whatever')
    expect(handled).toBe(false)
  })

  test('parses JSON, posts summary to thread, edits status, removes session', async () => {
    const channels = new Map<string, FakeChannel>([
      ['thread-x', fakeChannel({ id: 'thread-x' })],
    ])
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
    const { deps, spy } = makeFakeDeps({ channels })
    const app = createApp(deps)
    const name = 'ephemeral-zzzzzzzz'
    app.ephemeralSummaries.set(name, {
      name,
      port: 9500,
      threadId: 'thread-x',
      statusMsgId: 'status-msg',
      requestId: 'req-ok',
      parentChannelId: 'parent-ch',
      parentSessionName: 'proj',
      parentSessionPort: 9200,
    })
    const text = '```json\n{"request_id":"req-ok","summary":"## 결정사항\\n- ship it"}\n```'
    const handled = await app.tryHandleEphemeralReply(name, text)
    expect(handled).toBe(true)
    expect(app.ephemeralSummaries.has(name)).toBe(false)
    expect(spy.scriptCalls).toEqual([`remove ${name}`])
    expect(threadCh.sent[0].opts.content).toContain('📝 **요약**')
    expect(threadCh.sent[0].opts.content).toContain('## 결정사항')
    expect(threadCh.messages.stored.get('status-msg')!.edits.at(-1)).toContain('✅')
  })

  test('flags request_id mismatch but still posts summary and cleans up', async () => {
    const channels = new Map<string, FakeChannel>([
      ['thread-x', fakeChannel({ id: 'thread-x' })],
    ])
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
    const { deps, spy } = makeFakeDeps({ channels })
    const app = createApp(deps)
    const name = 'ephemeral-mismatch'
    app.ephemeralSummaries.set(name, {
      name,
      port: 9500,
      threadId: 'thread-x',
      statusMsgId: 'status-msg',
      requestId: 'expected-id',
      parentChannelId: 'parent-ch',
      parentSessionName: 'proj',
      parentSessionPort: 9200,
    })
    const text =
      '```json\n{"request_id":"wrong-id","summary":"contents"}\n```'
    const handled = await app.tryHandleEphemeralReply(name, text)
    expect(handled).toBe(true)
    expect(threadCh.sent[0].opts.content).toContain('mismatch')
    expect(threadCh.sent[0].opts.content).toContain('contents')
    expect(spy.scriptCalls).toEqual([`remove ${name}`])
  })

  test('falls back to raw paste + cleans up when JSON parse fails', async () => {
    const channels = new Map<string, FakeChannel>([
      ['thread-x', fakeChannel({ id: 'thread-x' })],
    ])
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
    const { deps, spy } = makeFakeDeps({ channels })
    const app = createApp(deps)
    const name = 'ephemeral-badjson'
    app.ephemeralSummaries.set(name, {
      name,
      port: 9500,
      threadId: 'thread-x',
      statusMsgId: 'status-msg',
      requestId: 'r',
      parentChannelId: 'parent-ch',
      parentSessionName: 'proj',
      parentSessionPort: 9200,
    })
    const handled = await app.tryHandleEphemeralReply(name, 'I refuse to follow the schema, here is prose.')
    expect(handled).toBe(true)
    expect(threadCh.messages.stored.get('status-msg')!.edits.at(-1)).toContain('파싱 실패')
    expect(threadCh.sent[0].opts.content).toContain('Raw 응답')
    expect(spy.scriptCalls).toEqual([`remove ${name}`])
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

  test('intercepts reply on ephemeral channel_id and never hits a real channel', async () => {
    const threadCh = fakeChannel({ id: 'thread-x' })
    threadCh.messages.stored.set('status-msg', {
      id: 'status-msg',
      opts: {},
      edits: [],
      async edit(content: string) {
        this.edits.push(content)
        return this
      },
    } as any)
    const channels = new Map<string, FakeChannel>([['thread-x', threadCh]])
    const { deps } = makeFakeDeps({ channels })
    const app = createApp(deps)
    const name = 'ephemeral-12345678'
    app.ephemeralSummaries.set(name, {
      name,
      port: 9500,
      threadId: 'thread-x',
      statusMsgId: 'status-msg',
      requestId: 'r',
      parentChannelId: 'parent-ch',
      parentSessionName: 'proj',
      parentSessionPort: 9200,
    })
    const replyText = '```json\n{"request_id":"r","summary":"hello"}\n```'
    const res = await app.handleReply(
      jsonReq('http://x/reply', { channel_id: name, text: replyText }),
    )
    const body = (await res.json()) as any
    expect(body.intercepted).toBe(true)
    // The summary should land in the THREAD, not anywhere else
    expect(threadCh.sent[0].opts.content).toContain('hello')
  })

  test('returns 404 on ephemeral channel_id with no pending entry', async () => {
    const { deps } = makeFakeDeps()
    const app = createApp(deps)
    const res = await app.handleReply(
      jsonReq('http://x/reply', { channel_id: 'ephemeral-noone', text: 'x' }),
    )
    expect(res.status).toBe(404)
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

// ─── tryHandleEphemeralReply (button posting) ──────────────────────────────

describe('tryHandleEphemeralReply posts buttons + registers action', () => {
  test('successful summary creates pendingSummaryAction with buttons', async () => {
    const threadCh = fakeChannel({ id: 'thread-x' })
    threadCh.messages.stored.set('status-msg', {
      id: 'status-msg',
      opts: {},
      edits: [],
      async edit(c: string) {
        this.edits.push(c)
        return this
      },
    } as any)
    const channels = new Map<string, FakeChannel>([['thread-x', threadCh]])
    let calls = 0
    const { deps, spy } = makeFakeDeps({
      channels,
      uuid: () => (calls++ === 0 ? 'action-id-1' : 'other'),
    })
    const app = createApp(deps)
    const name = 'ephemeral-aabb'
    app.ephemeralSummaries.set(name, {
      name,
      port: 9500,
      threadId: 'thread-x',
      statusMsgId: 'status-msg',
      requestId: 'req-1',
      parentChannelId: 'parent-ch',
      parentSessionName: 'proj',
      parentSessionPort: 9200,
    })

    const text = '```json\n{"request_id":"req-1","summary":"## 결정사항\\n- ship"}\n```'
    const handled = await app.tryHandleEphemeralReply(name, text)
    expect(handled).toBe(true)

    // Button message posted in thread
    expect(threadCh.sent).toHaveLength(1)
    const sent = threadCh.sent[0]!.opts as any
    expect(sent.content).toContain('📝 **요약**')
    expect(sent.content).toContain('## 결정사항')
    expect(sent.content).toContain('<#parent-ch>')
    expect(sent.components).toHaveLength(1)

    // Action registered
    const action = app.pendingSummaryActions.get('action-id-1')
    expect(action).toMatchObject({
      id: 'action-id-1',
      threadId: 'thread-x',
      summary: '## 결정사항\n- ship',
      parentChannelId: 'parent-ch',
      parentSessionName: 'proj',
      parentSessionPort: 9200,
    })
    expect(action!.buttonMsgId).toBe(threadCh.sent[0]!.id)

    // Status edited + ephemeral session removed
    expect(spy.scriptCalls).toEqual([`remove ${name}`])
  })
})

// ─── handleSummaryButton ───────────────────────────────────────────────────

describe('handleSummaryButton', () => {
  function seed(app: ReturnType<typeof createApp>, id = 'a1', summary = 'the summary') {
    app.pendingSummaryActions.set(id, {
      id,
      threadId: 'thread-x',
      buttonMsgId: 'btn-msg',
      summary,
      parentChannelId: 'parent-ch',
      parentSessionName: 'proj',
      parentSessionPort: 9200,
      requesterId: '',
    })
  }

  test('expired action replies ephemerally and does not edit', async () => {
    const { deps } = makeFakeDeps()
    const app = createApp(deps)
    const i = fakeInteraction('summary:accept:gone')
    await app.handleSummaryButton(i.asButtonInteraction())
    expect(i.replies[0]!.content).toContain('만료')
    expect(i.replies[0]!.ephemeral).toBe(true)
    expect(i.message.edits).toHaveLength(0)
  })

  test('non-summary customId is ignored', async () => {
    const { deps, spy } = makeFakeDeps()
    const app = createApp(deps)
    const i = fakeInteraction('unrelated:click')
    await app.handleSummaryButton(i.asButtonInteraction())
    expect(spy.postCalls).toHaveLength(0)
    expect(i.message.edits).toHaveLength(0)
  })

  test('accept forwards summary to parent session and edits message', async () => {
    const { deps, spy } = makeFakeDeps()
    const app = createApp(deps)
    seed(app)
    const i = fakeInteraction('summary:accept:a1')
    await app.handleSummaryButton(i.asButtonInteraction())

    // POST to parent session
    expect(spy.postCalls).toHaveLength(1)
    expect(spy.postCalls[0]!.url).toBe('http://localhost:9200/message')
    const body = spy.postCalls[0]!.body as any
    expect(body.chat_id).toBe('parent-ch')
    expect(body.content).toContain('다음은 회의 요약입니다')
    expect(body.content).toContain('the summary')

    // Action removed, message edited to "accepted" + buttons stripped
    expect(app.pendingSummaryActions.has('a1')).toBe(false)
    expect(i.message.edits).toHaveLength(1)
    expect(i.message.edits[0]!.content).toContain('✅')
    expect(i.message.edits[0]!.content).toContain('전달됨')
    expect(i.message.edits[0]!.components).toEqual([])
    expect(i.deferred).toBe(true)
  })

  test('accept handles parent session POST failure', async () => {
    const { deps } = makeFakeDeps({
      postJSON: () => ({ ok: false, status: 500 }),
    })
    const app = createApp(deps)
    seed(app)
    const i = fakeInteraction('summary:accept:a1')
    await app.handleSummaryButton(i.asButtonInteraction())

    expect(app.pendingSummaryActions.has('a1')).toBe(false)
    expect(i.message.edits[0]!.content).toContain('전송 실패')
    expect(i.message.edits[0]!.content).toContain('proj')
    expect(i.message.edits[0]!.components).toEqual([])
  })

  test('reject edits message to rejected status with buttons stripped, no POST', async () => {
    const { deps, spy } = makeFakeDeps()
    const app = createApp(deps)
    seed(app)
    const i = fakeInteraction('summary:reject:a1')
    await app.handleSummaryButton(i.asButtonInteraction())

    expect(spy.postCalls).toHaveLength(0)
    expect(app.pendingSummaryActions.has('a1')).toBe(false)
    expect(i.message.edits[0]!.content).toContain('❌')
    expect(i.message.edits[0]!.content).toContain('거절')
    expect(i.message.edits[0]!.components).toEqual([])
    expect(i.deferred).toBe(true)
  })

  test('edit shows modal with current summary pre-filled, action stays alive', async () => {
    const { deps, spy } = makeFakeDeps()
    const app = createApp(deps)
    seed(app, 'a1', 'orig summary')
    const i = fakeInteraction('summary:edit:a1')
    await app.handleSummaryButton(i.asButtonInteraction())

    // Modal shown, no POST, no message edit, action still pending
    expect(i.modal).toBeDefined()
    expect(spy.postCalls).toHaveLength(0)
    expect(i.message.edits).toHaveLength(0)
    expect(app.pendingSummaryActions.has('a1')).toBe(true)
    // The modal carries the action id in customId
    expect((i.modal as any).data.custom_id).toBe('summary:editmodal:a1')
  })
})

// ─── handleSummaryModalSubmit ──────────────────────────────────────────────

describe('handleSummaryModalSubmit', () => {
  test('updates summary and re-renders message with buttons intact', async () => {
    const { deps, spy } = makeFakeDeps()
    const app = createApp(deps)
    app.pendingSummaryActions.set('a1', {
      id: 'a1',
      threadId: 'thread-x',
      buttonMsgId: 'btn-msg',
      summary: 'old summary',
      parentChannelId: 'parent-ch',
      parentSessionName: 'proj',
      parentSessionPort: 9200,
      requesterId: '',
    })
    const submit = fakeModalSubmit({
      customId: 'summary:editmodal:a1',
      values: { summary_text: 'new edited summary' },
    })
    await app.handleSummaryModalSubmit(submit.asModalSubmit())

    expect(app.pendingSummaryActions.get('a1')!.summary).toBe('new edited summary')
    expect(submit.message.edits[0]!.content).toContain('new edited summary')
    expect(submit.message.edits[0]!.content).toContain('📝 **요약**')
    expect((submit.message.edits[0]!.components as any[])).toHaveLength(1)
    expect(submit.deferred).toBe(true)
    expect(spy.postCalls).toHaveLength(0)
  })

  test('expired modal replies ephemerally', async () => {
    const { deps } = makeFakeDeps()
    const app = createApp(deps)
    const submit = fakeModalSubmit({
      customId: 'summary:editmodal:gone',
      values: { summary_text: 'x' },
    })
    await app.handleSummaryModalSubmit(submit.asModalSubmit())
    expect(submit.replies[0]!.content).toContain('만료')
  })

  test('non-summary modal customId is ignored', async () => {
    const { deps } = makeFakeDeps()
    const app = createApp(deps)
    const submit = fakeModalSubmit({
      customId: 'unrelated:modal',
      values: { summary_text: 'x' },
    })
    await app.handleSummaryModalSubmit(submit.asModalSubmit())
    expect(submit.message.edits).toHaveLength(0)
    expect(submit.replies).toHaveLength(0)
  })

  test('after edit, accept forwards the EDITED summary', async () => {
    const { deps, spy } = makeFakeDeps()
    const app = createApp(deps)
    app.pendingSummaryActions.set('a1', {
      id: 'a1',
      threadId: 'thread-x',
      buttonMsgId: 'btn-msg',
      summary: 'before edit',
      parentChannelId: 'parent-ch',
      parentSessionName: 'proj',
      parentSessionPort: 9200,
      requesterId: '',
    })
    // Edit
    const submit = fakeModalSubmit({
      customId: 'summary:editmodal:a1',
      values: { summary_text: 'after edit' },
    })
    await app.handleSummaryModalSubmit(submit.asModalSubmit())
    // Accept
    const i = fakeInteraction('summary:accept:a1')
    await app.handleSummaryButton(i.asButtonInteraction())

    expect(spy.postCalls[0]!.body).toMatchObject({
      content: expect.stringContaining('after edit'),
    })
    expect(spy.postCalls[0]!.body).not.toMatchObject({
      content: expect.stringContaining('before edit'),
    })
  })
})
