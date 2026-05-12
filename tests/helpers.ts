/**
 * E2E test helpers for channel.ts.
 *
 * - spawnBridge: launches channel.ts as a child process, completes the MCP
 *   handshake over stdio, and exposes send/next helpers for JSON-RPC framing.
 * - fakeBotServer: a recording Bun HTTP server that stands in for bot.ts so we
 *   can assert what channel.ts POSTs to /reply and /permission.
 */

import { type Subprocess } from 'bun'
import { join } from 'node:path'

const ROOT = join(import.meta.dir, '..')

export type MCPMessage = Record<string, unknown>

export interface BridgeHandle {
  proc: Subprocess
  port: number
  channelId: string
  messages: MCPMessage[]
  stderr: () => string
  send(msg: MCPMessage): void
  next(predicate: (m: MCPMessage) => boolean, timeoutMs?: number): Promise<MCPMessage>
  stop(): Promise<void>
}

export async function spawnBridge(opts: {
  channelId: string
  botUrl: string
}): Promise<BridgeHandle> {
  const port = await findFreePort()

  const proc = Bun.spawn({
    cmd: ['bun', join(ROOT, 'channel.ts')],
    cwd: ROOT,
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
    env: {
      ...process.env,
      CHANNEL_PORT: String(port),
      BOT_URL: opts.botUrl,
      DISCORD_CHANNEL_ID: opts.channelId,
    },
  })

  const messages: MCPMessage[] = []
  let stderrBuf = ''

  // Drain stdout: one JSON-RPC message per newline-terminated chunk.
  void (async () => {
    const reader = proc.stdout.getReader()
    const decoder = new TextDecoder()
    let buf = ''
    try {
      while (true) {
        const { value, done } = await reader.read()
        if (done) break
        buf += decoder.decode(value, { stream: true })
        let nl
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl).trim()
          buf = buf.slice(nl + 1)
          if (!line) continue
          try {
            messages.push(JSON.parse(line) as MCPMessage)
          } catch {
            // Non-JSON line on stdout shouldn't happen with MCP stdio; ignore.
          }
        }
      }
    } catch {}
  })()

  // Drain stderr so the pipe never fills; expose it for failure diagnostics.
  void (async () => {
    const reader = proc.stderr.getReader()
    const decoder = new TextDecoder()
    try {
      while (true) {
        const { value, done } = await reader.read()
        if (done) break
        stderrBuf += decoder.decode(value, { stream: true })
      }
    } catch {}
  })()

  let cursor = 0
  const next = async (
    predicate: (m: MCPMessage) => boolean,
    timeoutMs = 3000,
  ): Promise<MCPMessage> => {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      while (cursor < messages.length) {
        const m = messages[cursor++]
        if (predicate(m)) return m
      }
      await new Promise(r => setTimeout(r, 10))
    }
    throw new Error(
      `Timed out after ${timeoutMs}ms waiting for MCP message.\n` +
        `Seen (${messages.length}): ${JSON.stringify(messages).slice(0, 800)}\n` +
        `Stderr: ${stderrBuf.slice(0, 800)}`,
    )
  }

  const send = (msg: MCPMessage) => {
    proc.stdin.write(JSON.stringify(msg) + '\n')
    proc.stdin.flush?.()
  }

  await waitForHealth(`http://127.0.0.1:${port}/health`)

  // MCP handshake: initialize → wait for response → initialized notification.
  send({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'channel-e2e-test', version: '0.0.0' },
    },
  })
  await next(m => m.id === 1 && 'result' in m)
  send({ jsonrpc: '2.0', method: 'notifications/initialized' })

  return {
    proc,
    port,
    channelId: opts.channelId,
    messages,
    stderr: () => stderrBuf,
    send,
    next,
    async stop() {
      try {
        proc.kill()
      } catch {}
      await proc.exited.catch(() => {})
    },
  }
}

export interface FakeBotHandle {
  url: string
  requests: Array<{ path: string; body: unknown }>
  stop(): void
  countOf(path: string): number
  waitFor(path: string, timeoutMs?: number): Promise<{ path: string; body: unknown }>
}

export async function fakeBotServer(): Promise<FakeBotHandle> {
  const requests: Array<{ path: string; body: unknown }> = []
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    async fetch(req) {
      const url = new URL(req.url)
      const body = await req.json().catch(() => null)
      requests.push({ path: url.pathname, body })
      const resp =
        url.pathname === '/reply'
          ? { ok: true, message_ids: ['fake-msg-id'] }
          : { ok: true }
      return new Response(JSON.stringify(resp), {
        headers: { 'content-type': 'application/json' },
      })
    },
  })

  const countOf = (path: string) => requests.filter(r => r.path === path).length

  const waitFor = async (path: string, timeoutMs = 2000) => {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const match = requests.find(r => r.path === path)
      if (match) return match
      await new Promise(r => setTimeout(r, 10))
    }
    throw new Error(
      `Timed out after ${timeoutMs}ms waiting for fake bot ${path}.\n` +
        `Seen: ${JSON.stringify(requests).slice(0, 400)}`,
    )
  }

  return {
    url: `http://127.0.0.1:${server.port}`,
    requests,
    countOf,
    waitFor,
    stop: () => server.stop(true),
  }
}

async function findFreePort(): Promise<number> {
  const s = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => new Response('') })
  const p = s.port
  s.stop(true)
  return p
}

async function waitForHealth(url: string, attempts = 100, intervalMs = 50): Promise<void> {
  for (let i = 0; i < attempts; i++) {
    try {
      const r = await fetch(url)
      if (r.ok) return
    } catch {}
    await new Promise(r => setTimeout(r, intervalMs))
  }
  throw new Error(`Bridge health endpoint never became ready: ${url}`)
}
