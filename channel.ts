#!/usr/bin/env bun
/**
 * Bridge MCP Channel for Claude Code.
 *
 * Lightweight MCP server that bridges between the Discord bot (via HTTP)
 * and a Claude Code session (via MCP stdio). One instance per session.
 *
 * Env vars:
 *   CHANNEL_PORT        — HTTP port to listen on (default: 9001)
 *   BOT_URL             — Discord bot HTTP API (default: http://localhost:3000)
 *   DISCORD_CHANNEL_ID  — Discord channel ID for this session
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'

const PORT = Number(process.env.CHANNEL_PORT ?? 9001)
const BOT_URL = process.env.BOT_URL ?? 'http://localhost:3000'
const CHANNEL_ID = process.env.DISCORD_CHANNEL_ID ?? ''

// ─── MCP Server ────────────────────────────────────────────────────────────

const mcp = new Server(
  { name: 'claude_bridge', version: '1.0.0' },
  {
    capabilities: {
      tools: {},
      experimental: {
        'claude/channel': {},
        'claude/channel/permission': {},
      },
    },
    instructions: [
      'Messages from Discord arrive as <channel source="claude_bridge"> tags.',
      'Use the reply tool to send responses back to the Discord channel.',
      'The user is chatting from their phone via Discord — keep replies concise.',
      `This session is linked to Discord channel ${CHANNEL_ID}.`,
    ].join(' '),
  },
)

// ─── Tools ─────────────────────────────────────────────────────────────────

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'reply',
      description: 'Send a message back to the Discord channel.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          chat_id: { type: 'string', description: 'Discord channel ID' },
          text: { type: 'string', description: 'Message text' },
          reply_to: { type: 'string', description: 'Message ID to reply to (optional)' },
        },
        required: ['chat_id', 'text'],
      },
    },
  ],
}))

mcp.setRequestHandler(CallToolRequestSchema, async (req) => {
  const args = (req.params.arguments ?? {}) as Record<string, unknown>
  try {
    switch (req.params.name) {
      case 'reply': {
        const chatId = (args.chat_id as string) || CHANNEL_ID
        const text = args.text as string
        const replyTo = args.reply_to as string | undefined

        const res = await fetch(`${BOT_URL}/reply`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ channel_id: chatId, text, reply_to: replyTo }),
        })

        if (!res.ok) {
          const body = await res.text()
          return { content: [{ type: 'text' as const, text: `reply failed: ${res.status} ${body}` }], isError: true }
        }

        const data = (await res.json()) as { message_ids?: string[] }
        return { content: [{ type: 'text' as const, text: `sent (ids: ${data.message_ids?.join(', ') ?? 'unknown'})` }] }
      }
      default:
        return { content: [{ type: 'text' as const, text: `unknown tool: ${req.params.name}` }], isError: true }
    }
  } catch (err) {
    return {
      content: [{ type: 'text' as const, text: `${req.params.name}: ${err instanceof Error ? err.message : err}` }],
      isError: true,
    }
  }
})

// ─── Permission Relay ──────────────────────────────────────────────────────

mcp.setNotificationHandler(
  z.object({
    method: z.literal('notifications/claude/channel/permission_request'),
    params: z.object({
      request_id: z.string(),
      tool_name: z.string(),
      description: z.string(),
      input_preview: z.string(),
    }),
  }),
  async ({ params }) => {
    const { request_id, tool_name, description, input_preview } = params

    // Auto-approve our own reply tool — no need for user confirmation
    if (tool_name.includes('reply')) {
      void mcp.notification({
        method: 'notifications/claude/channel/permission',
        params: { request_id, behavior: 'allow' as const },
      })
      return
    }

    try {
      await fetch(`${BOT_URL}/permission`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          channel_id: CHANNEL_ID,
          request_id,
          tool_name,
          description,
          input_preview,
        }),
      })
    } catch (err) {
      process.stderr.write(`permission relay failed: ${err}\n`)
    }
  },
)

// ─── Connect MCP ───────────────────────────────────────────────────────────

await mcp.connect(new StdioServerTransport())

// ─── HTTP Server (receives messages from Discord bot) ──────────────────────

Bun.serve({
  port: PORT,
  hostname: '127.0.0.1',
  async fetch(req) {
    const url = new URL(req.url)

    // Inbound message from Discord bot
    if (url.pathname === '/message' && req.method === 'POST') {
      const json = (await req.json()) as Record<string, unknown>

      void mcp.notification({
        method: 'notifications/claude/channel',
        params: {
          content: String(json.content ?? ''),
          meta: {
            chat_id: String(json.chat_id ?? CHANNEL_ID),
            message_id: String(json.message_id ?? ''),
            user: String(json.user ?? 'unknown'),
            user_id: String(json.user_id ?? ''),
            ts: String(json.ts ?? new Date().toISOString()),
          },
        },
      })

      return new Response(JSON.stringify({ ok: true }), {
        headers: { 'content-type': 'application/json' },
      })
    }

    // Permission response from Discord bot (user clicked Allow/Deny)
    if (url.pathname === '/permission-response' && req.method === 'POST') {
      const json = (await req.json()) as { request_id: string; behavior: 'allow' | 'deny' }

      void mcp.notification({
        method: 'notifications/claude/channel/permission',
        params: {
          request_id: json.request_id,
          behavior: json.behavior,
        },
      })

      return new Response(JSON.stringify({ ok: true }), {
        headers: { 'content-type': 'application/json' },
      })
    }

    // Health check
    if (url.pathname === '/health') {
      return new Response(JSON.stringify({ status: 'ok', channel_id: CHANNEL_ID, port: PORT }), {
        headers: { 'content-type': 'application/json' },
      })
    }

    return new Response('not found', { status: 404 })
  },
})

process.stderr.write(`claude_bridge: listening on http://localhost:${PORT} (channel: ${CHANNEL_ID})\n`)

// ─── Graceful Shutdown ─────────────────────────────────────────────────────

function shutdown() {
  process.exit(0)
}
process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)
