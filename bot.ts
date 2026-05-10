#!/usr/bin/env bun
/**
 * Discord Bot + HTTP API for claude-discord-hub.
 *
 * Single bot process that:
 * 1. Connects to Discord gateway (one bot token)
 * 2. Routes messages from channels to the correct Claude session (via HTTP)
 * 3. Receives replies from Claude sessions and posts them to Discord
 * 4. Handles permission relay (Allow/Deny buttons)
 * 5. Processes management commands (!stop, !start, !status, !resume, !help)
 */

import {
  Client,
  GatewayIntentBits,
  Partials,
  ChannelType,
  ButtonBuilder,
  ButtonStyle,
  ActionRowBuilder,
  type Message,
  type Interaction,
} from 'discord.js'
import {
  buildRouteMap,
  loadSessions,
  findSummarySession,
  loadBotToken,
  type SessionConfig,
} from './config'
import { execSync } from 'child_process'
import { join } from 'path'

const BOT_PORT = Number(process.env.BOT_PORT ?? 3000)
const SCRIPT_PATH = join(import.meta.dir, 'claude-sessions.sh')

// ─── Discord Client ────────────────────────────────────────────────────────

const client = new Client({
  intents: [
    GatewayIntentBits.DirectMessages,
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
  partials: [Partials.Channel],
})

// ─── Route Map (channel_id → session config) ──────────────────────────────

let routes = buildRouteMap()

function reloadRoutes() {
  const prev = routes.size
  routes = buildRouteMap()
  if (routes.size !== prev) {
    console.log(`Routes updated: ${routes.size} sessions`)
  }
}

// Reload routes periodically to pick up new sessions
setInterval(reloadRoutes, 10_000)

// ─── Pending permissions (request_id → { channelId, port }) ──────────────

const pendingPermissions = new Map<string, { channelId: string; port: number }>()

// ─── Pending summaries (request_id → thread context) ─────────────────────

const pendingSummaries = new Map<
  string,
  { threadId: string; requesterId: string; statusMsgId: string; sessionName: string }
>()

// ─── Message Handler ───────────────────────────────────────────────────────

client.on('messageCreate', async (msg: Message) => {
  if (msg.author.bot) return

  // Management commands
  if (msg.content.startsWith('!')) {
    await handleCommand(msg)
    return
  }

  const route = routes.get(msg.channelId)
  if (!route) return // Not a registered channel

  // Forward to the session's MCP channel
  try {
    const res = await fetch(`http://localhost:${route.port}/message`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        content: msg.content,
        chat_id: msg.channelId,
        message_id: msg.id,
        user: msg.author.username,
        user_id: msg.author.id,
        ts: msg.createdAt.toISOString(),
      }),
    })

    if (res.ok) {
      await msg.react('👀').catch(() => {})
    } else {
      await msg.react('❌').catch(() => {})
    }
  } catch {
    // Session's MCP channel is not running
    await msg.reply('⚠️ Session is not running. Use `!start` to start it.').catch(() => {})
  }
})

// ─── Management Commands ───────────────────────────────────────────────────

async function handleCommand(msg: Message) {
  const parts = msg.content.slice(1).trim().split(/\s+/)
  const cmd = parts[0]?.toLowerCase()
  const args = parts.slice(1)

  // Find session for this channel
  const route = routes.get(msg.channelId)

  switch (cmd) {
    case 'status': {
      try {
        const output = execSync(`${SCRIPT_PATH} status`, { encoding: 'utf8', timeout: 5000 })
        // Strip ANSI codes
        const clean = output.replace(/\x1b\[[0-9;]*m/g, '')
        await msg.reply(`\`\`\`\n${clean}\n\`\`\``)
      } catch (err) {
        await msg.reply('Failed to get status.')
      }
      break
    }

    case 'stop': {
      if (!route) {
        await msg.reply('This channel is not linked to a session.')
        return
      }
      try {
        execSync(`${SCRIPT_PATH} stop ${route.name}`, { encoding: 'utf8', timeout: 10000 })
        await msg.reply(`✅ Session **${route.name}** stopped.`)
      } catch {
        await msg.reply(`❌ Failed to stop session **${route.name}**.`)
      }
      break
    }

    case 'start': {
      if (!route) {
        await msg.reply('This channel is not linked to a session.')
        return
      }
      try {
        execSync(`${SCRIPT_PATH} start ${route.name}`, { encoding: 'utf8', timeout: 10000 })
        await msg.reply(`✅ Session **${route.name}** started.`)
      } catch {
        await msg.reply(`❌ Failed to start session **${route.name}**.`)
      }
      break
    }

    case 'resume': {
      if (!route) {
        await msg.reply('This channel is not linked to a session.')
        return
      }
      try {
        execSync(`${SCRIPT_PATH} start ${route.name} -c`, {
          encoding: 'utf8',
          timeout: 10000,
        })
        await msg.reply(`✅ Session **${route.name}** resumed (claude -c).`)
      } catch {
        await msg.reply(`❌ Failed to resume session **${route.name}**.`)
      }
      break
    }

    case 'summary': {
      await handleSummaryCommand(msg)
      break
    }

    case 'add': {
      const existingRoute = routes.get(msg.channelId)
      if (existingRoute) {
        await msg.reply(`This channel is already linked to session **${existingRoute.name}**. Use \`!remove\` first.`)
        return
      }
      const name = args[0]
      const repoPath = args[1]
      const continueFlag = args[2] === '-c' || args[2] === 'resume'
      if (!name || !repoPath) {
        await msg.reply('Usage: `!add <name> <repo-path> [-c]`')
        return
      }
      try {
        execSync(`${SCRIPT_PATH} add ${name} ${repoPath} ${msg.channelId}`, {
          encoding: 'utf8',
          timeout: 5000,
        })
        const startArgs = continueFlag ? '-c' : ''
        execSync(`${SCRIPT_PATH} start ${name} ${startArgs}`, { encoding: 'utf8', timeout: 15000 })
        reloadRoutes()
        const resumeMsg = continueFlag ? `\nContinuing last session (\`claude -c\`)` : ''
        await msg.reply(`✅ Session **${name}** created and started.\nRepo: \`${repoPath}\`${resumeMsg}`)
      } catch (err) {
        const errMsg = err instanceof Error ? (err as any).stderr || err.message : String(err)
        await msg.reply(`❌ Failed: ${errMsg.replace(/\x1b\[[0-9;]*m/g, '').slice(0, 500)}`)
      }
      break
    }

    case 'remove': {
      if (!route) {
        await msg.reply('This channel is not linked to a session.')
        return
      }
      try {
        execSync(`${SCRIPT_PATH} remove ${route.name}`, { encoding: 'utf8', timeout: 10000 })
        reloadRoutes()
        await msg.reply(`✅ Session **${route.name}** removed.`)
      } catch {
        await msg.reply(`❌ Failed to remove session **${route.name}**.`)
      }
      break
    }

    case 'last': {
      if (!route) {
        await msg.reply('This channel is not linked to a session.')
        return
      }
      try {
        const encoded = route.repoPath.replace(/\//g, '-')
        const sessDir = `${process.env.HOME}/.claude/projects/${encoded}`
        const output = execSync(
          `for f in ${sessDir}/*.jsonl; do ` +
          `id=$(basename "$f" .jsonl); ` +
          `ts=$(head -1 "$f" 2>/dev/null | grep -o '"timestamp":"[^"]*"' | head -1 | cut -d'"' -f4); ` +
          `name=$(grep -o '"slug":"[^"]*"' "$f" 2>/dev/null | head -1 | cut -d'"' -f4); ` +
          `echo "$ts | $id | $name"; ` +
          `done 2>/dev/null | sort -r | head -1`,
          { encoding: 'utf8', timeout: 10000, shell: '/bin/bash' },
        )
        if (!output.trim()) {
          await msg.reply('No previous sessions found.')
        } else {
          const [ts, id, name] = output.trim().split(' | ').map(s => s.trim())
          const label = name ? ` (${name})` : ''
          const date = ts ? ts.replace('T', ' ').slice(0, 16) : '?'
          await msg.reply(`**Latest session${label}:**\n\`${date}\` \`${id}\`\n\nResume (continues last): \`!resume\``)
        }
      } catch {
        await msg.reply('Failed to find sessions.')
      }
      break
    }

    case 'sessions': {
      if (!route) {
        await msg.reply('This channel is not linked to a session.')
        return
      }
      try {
        // Encode repo path to find the project session dir
        const encoded = route.repoPath.replace(/\//g, '-')
        const sessDir = `${process.env.HOME}/.claude/projects/${encoded}`
        const output = execSync(
          `for f in ${sessDir}/*.jsonl; do ` +
          `id=$(basename "$f" .jsonl); ` +
          `ts=$(head -1 "$f" 2>/dev/null | grep -o '"timestamp":"[^"]*"' | head -1 | cut -d'"' -f4); ` +
          `name=$(grep -o '"slug":"[^"]*"' "$f" 2>/dev/null | head -1 | cut -d'"' -f4); ` +
          `echo "$ts | $id | $name"; ` +
          `done 2>/dev/null | sort -r | head -5`,
          { encoding: 'utf8', timeout: 10000, shell: '/bin/bash' },
        )
        if (!output.trim()) {
          await msg.reply('No previous sessions found.')
        } else {
          const lines = output.trim().split('\n').map(line => {
            const [ts, id, name] = line.split(' | ').map(s => s.trim())
            const label = name ? `${name} ` : ''
            const date = ts ? ts.replace('T', ' ').slice(0, 16) : '?'
            return `\`${date}\` ${label}\`${id}\``
          })
          await msg.reply(`**Recent sessions for ${route.name}** (\`${route.repoPath}\`):\n${lines.join('\n')}\n\nUse \`!resume\` to continue the latest.`)
        }
      } catch {
        await msg.reply('Failed to list sessions.')
      }
      break
    }

    case 'list': {
      try {
        const output = execSync(`${SCRIPT_PATH} list`, { encoding: 'utf8', timeout: 5000 })
        const clean = output.replace(/\x1b\[[0-9;]*m/g, '')
        await msg.reply(`\`\`\`\n${clean}\n\`\`\``)
      } catch {
        await msg.reply('Failed to list sessions.')
      }
      break
    }

    case 'reload': {
      reloadRoutes()
      await msg.reply(`🔄 Routes reloaded. ${routes.size} sessions configured.`)
      break
    }

    case 'help': {
      await msg.reply(
        [
          '**Claude Hub Commands**',
          '`!add <name> <repo-path> [-c]` — Link channel to repo (`-c` continues last session)',
          '`!remove` — Remove this channel\'s session',
          '`!start` — Start this channel\'s session',
          '`!stop` — Stop this channel\'s session',
          '`!last` — Show the most recent session',
          '`!sessions` — List recent 5 sessions',
          '`!resume` — Continue the most recent session (`claude -c`)',
          '`!summary` — (in a thread) Summarize the meeting and forward to this channel\'s session',
          '`!status` — Show all session statuses',
          '`!list` — List all configured sessions',
          '`!reload` — Reload session configs',
          '`!help` — Show this message',
        ].join('\n'),
      )
      break
    }

    default:
      await msg.reply(`Unknown command: \`${cmd}\`. Try \`!help\`.`)
  }
}

// ─── Summary Flow ──────────────────────────────────────────────────────────

interface SummaryReply {
  request_id: string
  summary: string
}

async function handleSummaryCommand(msg: Message) {
  const channel = msg.channel
  if (!channel.isThread()) {
    await msg.reply('`!summary`는 스레드 안에서만 실행할 수 있어요.')
    return
  }

  const parentId = channel.parentId
  if (!parentId) {
    await msg.reply('❌ 이 스레드의 상위 채널을 찾을 수 없어요.')
    return
  }
  const target = routes.get(parentId)
  if (!target) {
    await msg.reply(`❌ 이 스레드가 속한 채널 <#${parentId}>은(는) 어떤 세션과도 연결되어 있지 않아요. \`!add\`로 먼저 세션을 등록하세요.`)
    return
  }
  if (target.isSummary) {
    await msg.reply('❌ 요약 전용 세션 채널에서는 `!summary`를 사용할 수 없어요.')
    return
  }

  const summarizer = findSummarySession()
  if (!summarizer) {
    await msg.reply('❌ 요약 세션이 설정되지 않았어요.')
    return
  }

  const fetched = await channel.messages.fetch({ limit: 100 })
  const ordered = Array.from(fetched.values()).reverse()
  const transcriptLines = ordered
    .filter(m => !m.author.bot && !m.content.startsWith('!'))
    .map(m => {
      const ts = m.createdAt.toISOString().slice(11, 16)
      return `[${m.author.username} ${ts}] ${m.content}`
    })

  if (transcriptLines.length === 0) {
    await msg.reply('요약할 내용이 없어요 — 스레드에 사용자 메시지가 없습니다.')
    return
  }

  const requestId = crypto.randomUUID()
  const status = await msg.reply(`🔄 요약 중... (\`${target.name}\`로 전송 예정)`)

  pendingSummaries.set(requestId, {
    threadId: channel.id,
    requesterId: msg.author.id,
    statusMsgId: status.id,
    sessionName: target.name,
  })

  const prompt = buildSummaryPrompt(requestId, transcriptLines.join('\n'))

  try {
    const res = await fetch(`http://localhost:${summarizer.port}/message`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        content: prompt,
        chat_id: summarizer.channelId,
        message_id: msg.id,
        user: msg.author.username,
        user_id: msg.author.id,
        ts: new Date().toISOString(),
      }),
    })
    if (!res.ok) {
      pendingSummaries.delete(requestId)
      await status.edit('❌ 요약 세션이 응답하지 않아요. `!start`로 시작하세요.').catch(() => {})
    }
  } catch {
    pendingSummaries.delete(requestId)
    await status.edit('❌ 요약 세션에 연결할 수 없어요.').catch(() => {})
  }
}

function buildSummaryPrompt(requestId: string, transcript: string): string {
  return [
    'You are summarizing a Discord meeting transcript so the linked Claude Code project session can act on it.',
    'Output ONLY a single ```json``` code block, no other text before or after.',
    '',
    'Schema:',
    '{',
    `  "request_id": "${requestId}",`,
    '  "summary": "Korean markdown. Sections: ## 결정사항, ## Action Items, ## 다음 단계. Be concrete and short."',
    '}',
    '',
    `[REQUEST_ID=${requestId}]`,
    '',
    'Transcript:',
    transcript,
  ].join('\n')
}

async function tryHandleSummaryReply(text: string): Promise<boolean> {
  const m = /```json\s*([\s\S]*?)\s*```/.exec(text) ?? /(\{[\s\S]*\})/.exec(text)
  if (!m) return false
  let parsed: SummaryReply
  try {
    parsed = JSON.parse(m[1]) as SummaryReply
  } catch {
    return false
  }
  if (!parsed.request_id || !parsed.summary) return false
  const ctx = pendingSummaries.get(parsed.request_id)
  if (!ctx) return false
  pendingSummaries.delete(parsed.request_id)
  void forwardSummaryToSession(parsed.summary, ctx)
  return true
}

async function forwardSummaryToSession(
  summary: string,
  ctx: { threadId: string; statusMsgId: string; sessionName: string },
) {
  const editStatus = async (content: string) => {
    try {
      const ch = await client.channels.fetch(ctx.threadId)
      if (ch && ch.isTextBased()) {
        const m = await (ch as any).messages.fetch(ctx.statusMsgId)
        await m.edit(content)
      }
    } catch {}
  }

  const target = loadSessions().find(s => s.name === ctx.sessionName)
  if (!target) {
    await editStatus(`❌ 세션 \`${ctx.sessionName}\`이(가) 사라졌어요.`)
    return
  }

  // Post the summary in the meeting thread itself for record
  try {
    const ch = await client.channels.fetch(ctx.threadId)
    if (ch && ch.isTextBased()) {
      for (const chunk of splitMessage(`📝 **요약**\n\n${summary}`, 2000)) {
        await (ch as any).send(chunk)
      }
    }
  } catch {}

  // Forward to linked session as a regular message it should act on
  const wrapped = `다음은 회의 요약입니다. 이 내용을 바탕으로 작업을 진행해주세요.\n\n${summary}`
  try {
    const res = await fetch(`http://localhost:${target.port}/message`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        content: wrapped,
        chat_id: target.channelId,
        message_id: ctx.statusMsgId,
        user: 'meeting-summary',
        user_id: '0',
        ts: new Date().toISOString(),
      }),
    })
    if (!res.ok) {
      await editStatus(`❌ 세션 \`${ctx.sessionName}\`에 전송 실패. 세션이 실행 중인지 확인하세요 (\`!start\`).`)
      return
    }
    await editStatus(`✅ 요약을 \`${ctx.sessionName}\` (<#${target.channelId}>)로 전송했어요.`)
  } catch (err) {
    await editStatus(`❌ 전송 실패: ${err instanceof Error ? err.message : 'unknown'}`)
  }
}

// ─── Button Interactions (Permission Relay) ────────────────────────────────

client.on('interactionCreate', async (interaction: Interaction) => {
  if (!interaction.isButton()) return

  const permMatch = /^perm:(allow|deny):(.+)$/.exec(interaction.customId)
  if (!permMatch) return

  const behavior = permMatch[1] as 'allow' | 'deny'
  const requestId = permMatch[2]
  const pending = pendingPermissions.get(requestId)
  if (!pending) {
    await interaction.reply({ content: 'This permission request has expired.', ephemeral: true })
    return
  }
  try {
    await fetch(`http://localhost:${pending.port}/permission-response`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ request_id: requestId, behavior }),
    })
    pendingPermissions.delete(requestId)
    await interaction.message.delete().catch(() => {})
    await interaction.deferUpdate().catch(() => {})
  } catch {
    await interaction.reply({ content: 'Failed to relay permission decision.', ephemeral: true })
  }
})

// ─── HTTP API Server (receives from MCP channels) ─────────────────────────

Bun.serve({
  port: BOT_PORT,
  hostname: '127.0.0.1',
  async fetch(req) {
    const url = new URL(req.url)

    // Reply endpoint — MCP channel sends Claude's response here
    if (url.pathname === '/reply' && req.method === 'POST') {
      const json = (await req.json()) as {
        channel_id: string
        text: string
        reply_to?: string
      }

      // Intercept replies from the summary session
      const summary = findSummarySession()
      if (summary && json.channel_id === summary.channelId) {
        const handled = await tryHandleSummaryReply(json.text)
        if (handled) {
          return new Response(JSON.stringify({ ok: true, intercepted: true }), {
            headers: { 'content-type': 'application/json' },
          })
        }
        // fall through to post the raw reply for debugging if JSON parse fails
      }

      try {
        const channel = await client.channels.fetch(json.channel_id)
        if (!channel || !channel.isTextBased()) {
          return new Response(JSON.stringify({ error: 'channel not found' }), { status: 404 })
        }

        // Split long messages (Discord 2000 char limit)
        const chunks = splitMessage(json.text, 2000)
        const messageIds: string[] = []

        for (let i = 0; i < chunks.length; i++) {
          const opts: Record<string, unknown> = { content: chunks[i] }
          if (i === 0 && json.reply_to) {
            opts.reply = { messageReference: json.reply_to, failIfNotExists: false }
          }
          const sent = await (channel as any).send(opts)
          messageIds.push(sent.id)
        }

        return new Response(JSON.stringify({ ok: true, message_ids: messageIds }), {
          headers: { 'content-type': 'application/json' },
        })
      } catch (err) {
        return new Response(
          JSON.stringify({ error: err instanceof Error ? err.message : 'unknown' }),
          { status: 500, headers: { 'content-type': 'application/json' } },
        )
      }
    }

    // Permission request — MCP channel forwards Claude's tool approval request
    if (url.pathname === '/permission' && req.method === 'POST') {
      const json = (await req.json()) as {
        channel_id: string
        request_id: string
        tool_name: string
        description: string
        input_preview?: string
      }

      try {
        const channel = await client.channels.fetch(json.channel_id)
        if (!channel || !channel.isTextBased()) {
          return new Response(JSON.stringify({ error: 'channel not found' }), { status: 404 })
        }

        // Find port for this channel
        const route = routes.get(json.channel_id)
        if (route) {
          pendingPermissions.set(json.request_id, {
            channelId: json.channel_id,
            port: route.port,
          })
        }

        const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
          new ButtonBuilder()
            .setCustomId(`perm:allow:${json.request_id}`)
            .setLabel('Allow')
            .setStyle(ButtonStyle.Success)
            .setEmoji('✅'),
          new ButtonBuilder()
            .setCustomId(`perm:deny:${json.request_id}`)
            .setLabel('Deny')
            .setStyle(ButtonStyle.Danger)
            .setEmoji('❌'),
        )

        const preview = json.input_preview ? `\n\`\`\`\n${json.input_preview.slice(0, 500)}\n\`\`\`` : ''
        await (channel as any).send({
          content: `🔐 **${json.tool_name}**: ${json.description}${preview}`,
          components: [row],
        })

        return new Response(JSON.stringify({ ok: true }), {
          headers: { 'content-type': 'application/json' },
        })
      } catch (err) {
        return new Response(
          JSON.stringify({ error: err instanceof Error ? err.message : 'unknown' }),
          { status: 500, headers: { 'content-type': 'application/json' } },
        )
      }
    }

    // Health check
    if (url.pathname === '/health') {
      return new Response(
        JSON.stringify({ status: 'ok', routes: routes.size, bot: client.user?.tag }),
        { headers: { 'content-type': 'application/json' } },
      )
    }

    return new Response('not found', { status: 404 })
  },
})

// ─── Helpers ───────────────────────────────────────────────────────────────

function splitMessage(text: string, limit: number): string[] {
  if (text.length <= limit) return [text]

  const chunks: string[] = []
  let remaining = text

  while (remaining.length > 0) {
    if (remaining.length <= limit) {
      chunks.push(remaining)
      break
    }
    // Try to split at newline
    let splitAt = remaining.lastIndexOf('\n', limit)
    if (splitAt <= 0) splitAt = limit
    chunks.push(remaining.slice(0, splitAt))
    remaining = remaining.slice(splitAt).replace(/^\n/, '')
  }

  return chunks
}

// ─── Resilience ───────────────────────────────────────────────────────────

client.on('error', (err) => {
  console.error(`[Discord] Client error: ${err.message}`)
})

client.on('warn', (msg) => {
  console.warn(`[Discord] Warning: ${msg}`)
})

client.on('shardError', (err, shardId) => {
  console.error(`[Discord] Shard ${shardId} error: ${err.message}`)
})

client.on('shardDisconnect', (event, shardId) => {
  console.warn(`[Discord] Shard ${shardId} disconnected (code ${event.code}). Auto-reconnecting...`)
})

client.on('shardReconnecting', (shardId) => {
  console.log(`[Discord] Shard ${shardId} reconnecting...`)
})

client.on('shardResume', (shardId, replayedEvents) => {
  console.log(`[Discord] Shard ${shardId} resumed. Replayed ${replayedEvents} events.`)
})

process.on('unhandledRejection', (reason) => {
  console.error('[Process] Unhandled rejection:', reason)
})

process.on('uncaughtException', (err) => {
  console.error('[Process] Uncaught exception:', err)
})

// ─── Start ─────────────────────────────────────────────────────────────────

const token = loadBotToken()
if (!token) {
  console.error('No bot token found. Set DISCORD_BOT_TOKEN in .env')
  process.exit(1)
}

client.once('ready', () => {
  console.log(`Bot online: ${client.user?.tag}`)
  console.log(`HTTP API: http://localhost:${BOT_PORT}`)
  console.log(`Routes: ${routes.size} sessions`)
})

async function startBot() {
  try {
    await client.login(token)
  } catch (err) {
    console.error(`[Bot] Login failed: ${err}. Retrying in 30s...`)
    setTimeout(startBot, 30_000)
  }
}

await startBot()
