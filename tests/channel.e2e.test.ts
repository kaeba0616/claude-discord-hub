/**
 * Tier 1 e2e: channel.ts as a black box.
 *
 * Boots channel.ts in a child process with CHANNEL_PORT/BOT_URL pointed at a
 * recording fake bot, then exercises every HTTP <-> MCP edge in both
 * directions.
 */

import { test, expect, beforeEach, afterEach } from 'bun:test'
import {
  spawnBridge,
  fakeBotServer,
  type BridgeHandle,
  type FakeBotHandle,
} from './helpers'

const CHANNEL_ID = '111222333444555666'

let bot: FakeBotHandle
let bridge: BridgeHandle

beforeEach(async () => {
  bot = await fakeBotServer()
  bridge = await spawnBridge({ channelId: CHANNEL_ID, botUrl: bot.url })
})

afterEach(async () => {
  await bridge.stop()
  bot.stop()
})

test('GET /health reports channel id and port', async () => {
  const res = await fetch(`http://127.0.0.1:${bridge.port}/health`)
  expect(res.status).toBe(200)
  expect(await res.json()).toEqual({
    status: 'ok',
    channel_id: CHANNEL_ID,
    port: bridge.port,
  })
})

test('POST /message emits notifications/claude/channel with payload', async () => {
  const payload = {
    content: 'hello from discord',
    chat_id: CHANNEL_ID,
    message_id: 'msg-1',
    user: 'alice',
    user_id: 'user-1',
    ts: '2026-05-12T00:00:00.000Z',
  }
  const res = await fetch(`http://127.0.0.1:${bridge.port}/message`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  })
  expect(res.ok).toBe(true)
  expect(await res.json()).toEqual({ ok: true })

  const notif = await bridge.next(m => m.method === 'notifications/claude/channel')
  expect((notif as any).params).toEqual({
    content: 'hello from discord',
    meta: {
      chat_id: CHANNEL_ID,
      message_id: 'msg-1',
      user: 'alice',
      user_id: 'user-1',
      ts: '2026-05-12T00:00:00.000Z',
    },
  })
})

test('POST /message tolerates missing fields by stringifying defaults', async () => {
  await fetch(`http://127.0.0.1:${bridge.port}/message`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ content: 'minimal' }),
  })
  const notif = await bridge.next(m => m.method === 'notifications/claude/channel')
  const params = (notif as any).params
  expect(params.content).toBe('minimal')
  expect(params.meta.chat_id).toBe(CHANNEL_ID) // falls back to env DISCORD_CHANNEL_ID
  expect(params.meta.user).toBe('unknown')
  expect(typeof params.meta.ts).toBe('string')
})

test('tools/call reply forwards to bot /reply and returns success', async () => {
  bridge.send({
    jsonrpc: '2.0',
    id: 100,
    method: 'tools/call',
    params: {
      name: 'reply',
      arguments: {
        chat_id: CHANNEL_ID,
        text: 'hello phone',
        reply_to: 'msg-7',
      },
    },
  })

  const resp = await bridge.next(m => m.id === 100)
  expect((resp as any).result?.isError).not.toBe(true)
  expect((resp as any).result?.content?.[0]?.text).toContain('fake-msg-id')

  const replyCall = await bot.waitFor('/reply')
  expect(replyCall.body).toEqual({
    channel_id: CHANNEL_ID,
    text: 'hello phone',
    reply_to: 'msg-7',
  })
})

test('tools/call reply falls back to env channel id when chat_id omitted', async () => {
  bridge.send({
    jsonrpc: '2.0',
    id: 101,
    method: 'tools/call',
    params: { name: 'reply', arguments: { text: 'no chat id' } },
  })
  await bridge.next(m => m.id === 101)

  const replyCall = await bot.waitFor('/reply')
  expect((replyCall.body as any).channel_id).toBe(CHANNEL_ID)
  expect((replyCall.body as any).text).toBe('no chat id')
})

test('tools/call unknown tool returns isError', async () => {
  bridge.send({
    jsonrpc: '2.0',
    id: 102,
    method: 'tools/call',
    params: { name: 'does-not-exist', arguments: {} },
  })
  const resp = await bridge.next(m => m.id === 102)
  expect((resp as any).result?.isError).toBe(true)
})

test('permission_request for reply tool auto-allows and does not call bot', async () => {
  bridge.send({
    jsonrpc: '2.0',
    method: 'notifications/claude/channel/permission_request',
    params: {
      request_id: 'req-allow-1',
      tool_name: 'mcp__claude_bridge__reply',
      description: 'send a message',
      input_preview: '{"text":"hi"}',
    },
  })

  const permNotif = await bridge.next(
    m =>
      m.method === 'notifications/claude/channel/permission' &&
      (m as any).params?.request_id === 'req-allow-1',
  )
  expect((permNotif as any).params).toEqual({
    request_id: 'req-allow-1',
    behavior: 'allow',
  })

  // Give channel.ts a beat to make sure no permission relay happens
  await new Promise(r => setTimeout(r, 100))
  expect(bot.countOf('/permission')).toBe(0)
})

test('permission_request for non-reply tool relays to bot /permission', async () => {
  bridge.send({
    jsonrpc: '2.0',
    method: 'notifications/claude/channel/permission_request',
    params: {
      request_id: 'req-relay-1',
      tool_name: 'Bash',
      description: 'run npm test',
      input_preview: 'npm test',
    },
  })

  const call = await bot.waitFor('/permission')
  expect(call.body).toEqual({
    channel_id: CHANNEL_ID,
    request_id: 'req-relay-1',
    tool_name: 'Bash',
    description: 'run npm test',
    input_preview: 'npm test',
  })
})

test('POST /permission-response emits MCP permission notification', async () => {
  const res = await fetch(`http://127.0.0.1:${bridge.port}/permission-response`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ request_id: 'req-resp-deny', behavior: 'deny' }),
  })
  expect(res.ok).toBe(true)

  const notif = await bridge.next(
    m =>
      m.method === 'notifications/claude/channel/permission' &&
      (m as any).params?.request_id === 'req-resp-deny',
  )
  expect((notif as any).params).toEqual({
    request_id: 'req-resp-deny',
    behavior: 'deny',
  })
})

test('unknown HTTP path returns 404', async () => {
  const res = await fetch(`http://127.0.0.1:${bridge.port}/nope`)
  expect(res.status).toBe(404)
})
