/**
 * Bot application core — pure handlers with dependencies injected.
 *
 * bot.ts wires this up against the real discord.js Client, claude-sessions.sh,
 * and fetch. Tests construct it with fakes.
 */

import {
  ButtonBuilder,
  ButtonStyle,
  ActionRowBuilder,
  type Message,
  type ButtonInteraction,
} from 'discord.js'
import type { SessionConfig } from './config'

// ─── Public types ──────────────────────────────────────────────────────────

export interface SessionEntry {
  ts: string
  id: string
  name: string
}

export interface DiscordMessageRef {
  id: string
  edit(content: string): Promise<unknown>
}

export interface DiscordChannel {
  isTextBased(): boolean
  send(opts: unknown): Promise<{ id: string }>
  messages: { fetch(id: string): Promise<DiscordMessageRef> }
}

export interface AppDeps {
  routes(): Map<string, SessionConfig>
  reloadRoutes(): void
  findSummarySession(): SessionConfig | undefined
  loadSessions(): SessionConfig[]
  readSessionConf(name: string): SessionConfig | undefined
  runScript(args: string, timeoutMs?: number): string
  listRecentSessions(repoPath: string, limit: number): SessionEntry[]
  postJSON(url: string, body: unknown): Promise<Response>
  sessionUrl(port: number, path: string): string
  bridgeHealthy(port: number): Promise<boolean>
  fetchChannel(id: string): Promise<DiscordChannel | null>
  uuid(): string
  now(): Date
  sleep(ms: number): Promise<void>
  // Optional overrides (default to the EPHEMERAL_* constants below)
  bootTimeoutMs?: number
  replyTimeoutMs?: number
}

export interface PendingPermission {
  channelId: string
  port: number
}

export interface EphemeralSummary {
  name: string
  port: number
  threadId: string
  statusMsgId: string
  requestId: string
  timeoutHandle?: ReturnType<typeof setTimeout>
}

export const EPHEMERAL_PREFIX = 'ephemeral-'
export const EPHEMERAL_BOOT_TIMEOUT_MS = 30_000
export const EPHEMERAL_REPLY_TIMEOUT_MS = 90_000

export const NOT_LINKED = '❌ This channel is not linked to a session.'

export const HELP_TEXT = [
  '**Claude Hub Commands**',
  '`!add <name> <repo-path> [-c]` — Link channel to repo (`-c` continues last session)',
  '`!remove` — Remove this channel\'s session',
  '`!start` — Start this channel\'s session',
  '`!stop` — Stop this channel\'s session',
  '`!last` — Show the most recent session',
  '`!sessions` — List recent 5 sessions',
  '`!resume` — Continue the most recent session (`claude -c`)',
  '`!summary` — (in a thread) Spin up a one-shot summarizer session and post the summary in this thread',
  '`!status` — Show all session statuses',
  '`!list` — List all configured sessions',
  '`!reload` — Reload session configs',
  '`!help` — Show this message',
].join('\n')

interface SummaryReply {
  request_id: string
  summary: string
}

// ─── Factory ───────────────────────────────────────────────────────────────

export function createApp(deps: AppDeps) {
  const pendingPermissions = new Map<string, PendingPermission>()
  const ephemeralSummaries = new Map<string, EphemeralSummary>()

  // ── messageCreate entry point ──
  async function handleMessage(msg: Message): Promise<void> {
    if (msg.author.bot) return

    if (msg.content.startsWith('!')) {
      await handleCommand(msg)
      return
    }

    const route = deps.routes().get(msg.channelId)
    if (!route) return

    try {
      const res = await deps.postJSON(deps.sessionUrl(route.port, '/message'), {
        content: msg.content,
        chat_id: msg.channelId,
        message_id: msg.id,
        user: msg.author.username,
        user_id: msg.author.id,
        ts: msg.createdAt.toISOString(),
      })
      await msg.react(res.ok ? '👀' : '❌').catch(() => {})
    } catch {
      await msg.reply('⚠️ Session is not running. Use `!start` to start it.').catch(() => {})
    }
  }

  // ── ! commands ──
  async function handleCommand(msg: Message): Promise<void> {
    const parts = msg.content.slice(1).trim().split(/\s+/)
    const cmd = parts[0]?.toLowerCase()
    const args = parts.slice(1)
    const route = deps.routes().get(msg.channelId)

    switch (cmd) {
      case 'status': {
        try {
          const output = deps.runScript('status', 5000)
          await msg.reply(`\`\`\`\n${stripAnsi(output)}\n\`\`\``)
        } catch {
          await msg.reply('❌ Failed to get status.')
        }
        return
      }
      case 'stop': {
        if (!route) return void (await msg.reply(NOT_LINKED))
        try {
          deps.runScript(`stop ${route.name}`, 10000)
          await msg.reply(`✅ Session **${route.name}** stopped.`)
        } catch {
          await msg.reply(`❌ Failed to stop session **${route.name}**.`)
        }
        return
      }
      case 'start': {
        if (!route) return void (await msg.reply(NOT_LINKED))
        try {
          deps.runScript(`start ${route.name}`, 10000)
          await msg.reply(`✅ Session **${route.name}** started.`)
        } catch {
          await msg.reply(`❌ Failed to start session **${route.name}**.`)
        }
        return
      }
      case 'resume': {
        if (!route) return void (await msg.reply(NOT_LINKED))
        try {
          deps.runScript(`start ${route.name} -c`, 10000)
          await msg.reply(`✅ Session **${route.name}** resumed (claude -c).`)
        } catch {
          await msg.reply(`❌ Failed to resume session **${route.name}**.`)
        }
        return
      }
      case 'summary': {
        await handleSummaryCommand(msg)
        return
      }
      case 'add': {
        if (route) {
          await msg.reply(
            `❌ This channel is already linked to session **${route.name}**. Use \`!remove\` first.`,
          )
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
          deps.runScript(`add ${name} ${repoPath} ${msg.channelId}`, 5000)
          deps.runScript(`start ${name} ${continueFlag ? '-c' : ''}`, 15000)
          deps.reloadRoutes()
          const resumeMsg = continueFlag ? `\nContinuing last session (\`claude -c\`)` : ''
          await msg.reply(
            `✅ Session **${name}** created and started.\nRepo: \`${repoPath}\`${resumeMsg}`,
          )
        } catch (err) {
          await msg.reply(`❌ Failed: ${stripAnsi(execErrorMessage(err)).slice(0, 500)}`)
        }
        return
      }
      case 'remove': {
        if (!route) return void (await msg.reply(NOT_LINKED))
        try {
          deps.runScript(`remove ${route.name}`, 10000)
          deps.reloadRoutes()
          await msg.reply(`✅ Session **${route.name}** removed.`)
        } catch {
          await msg.reply(`❌ Failed to remove session **${route.name}**.`)
        }
        return
      }
      case 'last': {
        if (!route) return void (await msg.reply(NOT_LINKED))
        try {
          const lines = deps.listRecentSessions(route.repoPath, 1)
          if (lines.length === 0) {
            await msg.reply('No previous sessions found.')
            return
          }
          const { ts, id, name } = lines[0]
          const label = name ? ` (${name})` : ''
          await msg.reply(
            `**Latest session${label}:**\n\`${ts}\` \`${id}\`\n\nResume (continues last): \`!resume\``,
          )
        } catch {
          await msg.reply('❌ Failed to find sessions.')
        }
        return
      }
      case 'sessions': {
        if (!route) return void (await msg.reply(NOT_LINKED))
        try {
          const lines = deps.listRecentSessions(route.repoPath, 5)
          if (lines.length === 0) {
            await msg.reply('No previous sessions found.')
            return
          }
          const formatted = lines.map(({ ts, id, name }) => {
            const label = name ? `${name} ` : ''
            return `\`${ts}\` ${label}\`${id}\``
          })
          await msg.reply(
            `**Recent sessions for ${route.name}** (\`${route.repoPath}\`):\n${formatted.join('\n')}\n\nUse \`!resume\` to continue the latest.`,
          )
        } catch {
          await msg.reply('❌ Failed to list sessions.')
        }
        return
      }
      case 'list': {
        try {
          const output = deps.runScript('list', 5000)
          await msg.reply(`\`\`\`\n${stripAnsi(output)}\n\`\`\``)
        } catch {
          await msg.reply('❌ Failed to list sessions.')
        }
        return
      }
      case 'reload': {
        deps.reloadRoutes()
        await msg.reply(`🔄 Routes reloaded. ${deps.routes().size} sessions configured.`)
        return
      }
      case 'help': {
        await msg.reply(HELP_TEXT)
        return
      }
      default:
        await msg.reply(`Unknown command: \`${cmd}\`. Try \`!help\`.`)
    }
  }

  // ── !summary (in a thread, one-shot ephemeral session) ──
  async function handleSummaryCommand(msg: Message): Promise<void> {
    const channel = msg.channel as any
    if (!channel.isThread || !channel.isThread()) {
      await msg.reply('`!summary`는 스레드 안에서만 실행할 수 있어요.')
      return
    }

    const parentId: string | null = channel.parentId ?? null
    if (!parentId) {
      await msg.reply('❌ 이 스레드의 상위 채널을 찾을 수 없어요.')
      return
    }
    const parent = deps.routes().get(parentId)
    if (!parent) {
      await msg.reply(
        `❌ 이 스레드가 속한 채널 <#${parentId}>은(는) 어떤 세션과도 연결되어 있지 않아요. \`!add\`로 먼저 세션을 등록하세요.`,
      )
      return
    }
    if (parent.isSummary) {
      await msg.reply('❌ 요약 전용 세션 채널에서는 `!summary`를 사용할 수 없어요.')
      return
    }

    const template = deps.findSummarySession()
    if (!template) {
      await msg.reply(
        '❌ summarizer 템플릿 세션이 설정되지 않았어요. (`claude-sessions.sh add summarizer <repo> <ch> summary`)',
      )
      return
    }

    const fetched = await channel.messages.fetch({ limit: 100 })
    const transcriptLines = Array.from(fetched.values())
      .reverse()
      .filter((m: any) => !m.author.bot && !m.content.startsWith('!'))
      .map(
        (m: any) =>
          `[${m.author.username} ${m.createdAt.toISOString().slice(11, 16)}] ${m.content}`,
      )

    if (transcriptLines.length === 0) {
      await msg.reply('요약할 내용이 없어요 — 스레드에 사용자 메시지가 없습니다.')
      return
    }

    const ephemeralName = `${EPHEMERAL_PREFIX}${deps.uuid().replace(/-/g, '').slice(0, 8)}`
    const requestId = deps.uuid()
    const status = (await msg.reply(
      `🔄 임시 요약 세션 부팅 중... (\`${ephemeralName}\`)`,
    )) as any
    const editStatus = (content: string) =>
      (status.edit ? status.edit(content) : Promise.resolve()).catch(() => {})

    let registered = false
    try {
      deps.runScript(`add ${ephemeralName} ${template.repoPath} ${ephemeralName}`, 5000)
      const conf = deps.readSessionConf(ephemeralName)
      if (!conf) {
        await editStatus('❌ 임시 세션 conf를 읽지 못했어요.')
        safeRemove(ephemeralName)
        return
      }
      deps.runScript(`start ${ephemeralName}`, 15000)

      const bootMs = deps.bootTimeoutMs ?? EPHEMERAL_BOOT_TIMEOUT_MS
      const ready = await waitForBridge(conf.port, bootMs)
      if (!ready) {
        await editStatus(`❌ 임시 세션이 ${bootMs / 1000}s 안에 부팅되지 않았어요.`)
        safeRemove(ephemeralName)
        return
      }
      await editStatus('📝 transcript 전송 → Claude가 요약 중...')

      const replyMs = deps.replyTimeoutMs ?? EPHEMERAL_REPLY_TIMEOUT_MS
      const timeoutHandle = setTimeout(() => {
        void handleEphemeralTimeout(ephemeralName, replyMs)
      }, replyMs)
      ephemeralSummaries.set(ephemeralName, {
        name: ephemeralName,
        port: conf.port,
        threadId: channel.id,
        statusMsgId: status.id,
        requestId,
        timeoutHandle,
      })
      registered = true

      const res = await deps.postJSON(deps.sessionUrl(conf.port, '/message'), {
        content: buildSummaryPrompt(requestId, transcriptLines.join('\n')),
        chat_id: ephemeralName,
        message_id: msg.id,
        user: msg.author.username,
        user_id: msg.author.id,
        ts: deps.now().toISOString(),
      })
      if (!res.ok) {
        clearTimeout(timeoutHandle)
        ephemeralSummaries.delete(ephemeralName)
        registered = false
        await editStatus('❌ 임시 세션이 transcript를 받지 못했어요.')
        safeRemove(ephemeralName)
      }
    } catch (err) {
      if (registered) {
        const ctx = ephemeralSummaries.get(ephemeralName)
        if (ctx?.timeoutHandle) clearTimeout(ctx.timeoutHandle)
        ephemeralSummaries.delete(ephemeralName)
      }
      await editStatus(
        `❌ 임시 세션 spawn 실패: ${err instanceof Error ? err.message : 'unknown'}`,
      )
      safeRemove(ephemeralName)
    }
  }

  // Inbound /reply for an ephemeral session — parse JSON, post summary to
  // thread, tear down the session. Returns true if intercepted.
  async function tryHandleEphemeralReply(channelId: string, text: string): Promise<boolean> {
    if (!channelId.startsWith(EPHEMERAL_PREFIX)) return false
    const ctx = ephemeralSummaries.get(channelId)
    if (!ctx) return false

    if (ctx.timeoutHandle) clearTimeout(ctx.timeoutHandle)
    ephemeralSummaries.delete(channelId)

    const m = /```json\s*([\s\S]*?)\s*```/.exec(text) ?? /(\{[\s\S]*\})/.exec(text)
    let parsed: SummaryReply | undefined
    if (m) {
      try {
        parsed = JSON.parse(m[1]) as SummaryReply
      } catch {}
    }

    if (parsed?.summary) {
      const header =
        parsed.request_id === ctx.requestId
          ? '📝 **요약**'
          : '⚠️ **요약** (request_id mismatch — 신뢰성 낮음)'
      await sendChannelMessage(ctx.threadId, `${header}\n\n${parsed.summary}`).catch(() => {})
      await editMessage(ctx.threadId, ctx.statusMsgId, '✅ 요약 완료').catch(() => {})
    } else {
      await editMessage(ctx.threadId, ctx.statusMsgId, '❌ Claude 응답 파싱 실패').catch(() => {})
      await sendChannelMessage(
        ctx.threadId,
        `**Raw 응답:**\n\`\`\`\n${text.slice(0, 1500)}\n\`\`\``,
      ).catch(() => {})
    }
    safeRemove(channelId)
    return true
  }

  async function handleEphemeralTimeout(name: string, timeoutMs: number): Promise<void> {
    const ctx = ephemeralSummaries.get(name)
    if (!ctx) return
    ephemeralSummaries.delete(name)
    await editMessage(
      ctx.threadId,
      ctx.statusMsgId,
      `❌ Claude 응답 타임아웃 (${timeoutMs / 1000}s)`,
    ).catch(() => {})
    safeRemove(name)
  }

  async function waitForBridge(port: number, timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if (await deps.bridgeHealthy(port)) return true
      await deps.sleep(500)
    }
    return false
  }

  function safeRemove(name: string): void {
    try {
      deps.runScript(`remove ${name}`, 10000)
    } catch {}
  }

  // ── Button interaction (permission relay click) ──
  async function handlePermissionButton(interaction: ButtonInteraction): Promise<void> {
    const permMatch = /^perm:(allow|deny):(.+)$/.exec(interaction.customId)
    if (!permMatch) return

    const behavior = permMatch[1] as 'allow' | 'deny'
    const requestId = permMatch[2]
    const pending = pendingPermissions.get(requestId)
    if (!pending) {
      await interaction.reply({ content: 'This permission request has expired.', ephemeral: true } as any)
      return
    }
    try {
      await deps.postJSON(deps.sessionUrl(pending.port, '/permission-response'), {
        request_id: requestId,
        behavior,
      })
      pendingPermissions.delete(requestId)
      await (interaction.message as any).delete().catch(() => {})
      await interaction.deferUpdate().catch(() => {})
    } catch {
      await interaction.reply({ content: 'Failed to relay permission decision.', ephemeral: true } as any)
    }
  }

  // ── HTTP /reply (from channel.ts) ──
  async function handleReply(req: Request): Promise<Response> {
    const json = (await req.json()) as {
      channel_id: string
      text: string
      reply_to?: string
    }

    // Ephemeral summarizer reply — intercept and never post to a real channel.
    if (json.channel_id.startsWith(EPHEMERAL_PREFIX)) {
      const handled = await tryHandleEphemeralReply(json.channel_id, json.text)
      if (handled) return jsonResponse({ ok: true, intercepted: true })
      return jsonResponse(
        { ok: false, error: 'no pending ephemeral session' },
        404,
      )
    }

    try {
      const channel = await deps.fetchChannel(json.channel_id)
      if (!channel || !channel.isTextBased()) {
        return jsonResponse({ error: 'channel not found' }, 404)
      }
      const messageIds: string[] = []
      const chunks = splitMessage(json.text, 2000)
      for (let i = 0; i < chunks.length; i++) {
        const opts: Record<string, unknown> = { content: chunks[i] }
        if (i === 0 && json.reply_to) {
          opts.reply = { messageReference: json.reply_to, failIfNotExists: false }
        }
        const sent = await channel.send(opts)
        messageIds.push(sent.id)
      }
      return jsonResponse({ ok: true, message_ids: messageIds })
    } catch (err) {
      return jsonResponse({ error: errorMessage(err) }, 500)
    }
  }

  // ── HTTP /permission (from channel.ts) ──
  async function handlePermission(req: Request): Promise<Response> {
    const json = (await req.json()) as {
      channel_id: string
      request_id: string
      tool_name: string
      description: string
      input_preview?: string
    }

    try {
      const channel = await deps.fetchChannel(json.channel_id)
      if (!channel || !channel.isTextBased()) {
        return jsonResponse({ error: 'channel not found' }, 404)
      }
      const route = deps.routes().get(json.channel_id)
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
      const preview = json.input_preview
        ? `\n\`\`\`\n${json.input_preview.slice(0, 500)}\n\`\`\``
        : ''
      await channel.send({
        content: `🔐 **${json.tool_name}**: ${json.description}${preview}`,
        components: [row],
      })
      return jsonResponse({ ok: true })
    } catch (err) {
      return jsonResponse({ error: errorMessage(err) }, 500)
    }
  }

  // ── Channel helpers (used by summary flow) ──
  async function editMessage(channelId: string, messageId: string, content: string): Promise<void> {
    try {
      const ch = await deps.fetchChannel(channelId)
      if (ch && ch.isTextBased()) {
        const m = await ch.messages.fetch(messageId)
        await m.edit(content)
      }
    } catch {}
  }

  async function sendChannelMessage(channelId: string, text: string): Promise<void> {
    const ch = await deps.fetchChannel(channelId)
    if (!ch || !ch.isTextBased()) return
    for (const chunk of splitMessage(text, 2000)) {
      await ch.send({ content: chunk })
    }
  }

  return {
    pendingPermissions,
    ephemeralSummaries,
    handleMessage,
    handleCommand,
    handleSummaryCommand,
    handleReply,
    handlePermission,
    handlePermissionButton,
    tryHandleEphemeralReply,
  }
}

export type App = ReturnType<typeof createApp>

// ─── Pure helpers (exported for testing) ──────────────────────────────────

export function buildSummaryPrompt(requestId: string, transcript: string): string {
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

export function splitMessage(text: string, limit: number): string[] {
  if (text.length <= limit) return [text]
  const chunks: string[] = []
  let remaining = text
  while (remaining.length > 0) {
    if (remaining.length <= limit) {
      chunks.push(remaining)
      break
    }
    let splitAt = remaining.lastIndexOf('\n', limit)
    if (splitAt <= 0) splitAt = limit
    chunks.push(remaining.slice(0, splitAt))
    remaining = remaining.slice(splitAt).replace(/^\n/, '')
  }
  return chunks
}

export function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;]*m/g, '')
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : 'unknown'
}

export function execErrorMessage(err: unknown): string {
  if (err instanceof Error) return (err as any).stderr || err.message
  return String(err)
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}
