#!/usr/bin/env bun
/**
 * Discord Bot + HTTP API for claude-discord-hub.
 *
 * Single bot process that:
 * 1. Connects to Discord gateway (one bot token)
 * 2. Routes messages from channels to the correct Claude session (via HTTP)
 * 3. Receives replies from Claude sessions and posts them to Discord
 * 4. Handles permission relay (Allow/Deny buttons)
 * 5. Processes management commands (!add, !start, !stop, !resume, !summary, !help, …)
 *
 * Pure handler logic lives in bot-app.ts. This file is the wiring: real
 * discord.js Client, real claude-sessions.sh, real fetch, real Bun.serve.
 */

import {
  Client,
  GatewayIntentBits,
  Partials,
  type Message,
  type Interaction,
} from 'discord.js'
import { buildRouteMap, loadSessions, findSummarySession } from './config'
import { createApp, type AppDeps, type DiscordChannel, type SessionEntry } from './bot-app'
import { loadBotToken } from './config'
import { execSync } from 'child_process'
import { readFileSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'

const BOT_PORT = Number(process.env.BOT_PORT ?? 3000)
const SCRIPT_PATH = join(import.meta.dir, 'claude-sessions.sh')
const QUICKSTART_PATH = join(import.meta.dir, 'QUICKSTART.md')

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

// ─── Routes ────────────────────────────────────────────────────────────────

let routes = buildRouteMap()

function reloadRoutes() {
  const prev = routes.size
  routes = buildRouteMap()
  if (routes.size !== prev) {
    console.log(`Routes updated: ${routes.size} sessions`)
  }
}

setInterval(reloadRoutes, 10_000)

// ─── Real dependencies ────────────────────────────────────────────────────

const deps: AppDeps = {
  routes: () => routes,
  reloadRoutes,
  findSummarySession,
  loadSessions,
  readSessionConf: name => loadSessions().find(s => s.name === name),
  runScript: (args, timeoutMs = 10_000) =>
    execSync(`${SCRIPT_PATH} ${args}`, { encoding: 'utf8', timeout: timeoutMs }),
  listRecentSessions,
  postJSON,
  sessionUrl: (port, path) => `http://localhost:${port}${path}`,
  bridgeHealthy,
  fetchChannel: async id => {
    const ch = await client.channels.fetch(id)
    return (ch as unknown as DiscordChannel | null) ?? null
  },
  uuid: () => crypto.randomUUID(),
  now: () => new Date(),
  sleep: ms => new Promise(r => setTimeout(r, ms)),
  quickstartText: () => {
    try {
      return readFileSync(QUICKSTART_PATH, 'utf8')
    } catch {
      return 'QUICKSTART.md를 찾을 수 없어요. 레포 루트에 있는지 확인해주세요.'
    }
  },
}

// Sweep any orphan ephemeral-* sessions left over from previous crashes
sweepEphemeralOrphans()

const app = createApp(deps)

// ─── Discord event wiring ─────────────────────────────────────────────────

client.on('messageCreate', (msg: Message) => {
  void app.handleMessage(msg).catch(err => console.error('[handleMessage]', err))
})

client.on('interactionCreate', (interaction: Interaction) => {
  if (!interaction.isButton()) return
  void app.handlePermissionButton(interaction).catch(err =>
    console.error('[handlePermissionButton]', err),
  )
})

// ─── HTTP API ─────────────────────────────────────────────────────────────

Bun.serve({
  port: BOT_PORT,
  hostname: '127.0.0.1',
  async fetch(req) {
    const url = new URL(req.url)
    if (url.pathname === '/reply' && req.method === 'POST') return app.handleReply(req)
    if (url.pathname === '/permission' && req.method === 'POST') return app.handlePermission(req)
    if (url.pathname === '/health') {
      return new Response(
        JSON.stringify({ status: 'ok', routes: routes.size, bot: client.user?.tag }),
        { headers: { 'content-type': 'application/json' } },
      )
    }
    return new Response('not found', { status: 404 })
  },
})

// ─── Helpers ──────────────────────────────────────────────────────────────

function postJSON(url: string, body: unknown): Promise<Response> {
  return fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

async function bridgeHealthy(port: number): Promise<boolean> {
  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 1_000)
    const res = await fetch(`http://127.0.0.1:${port}/health`, { signal: controller.signal })
    clearTimeout(timer)
    return res.ok
  } catch {
    return false
  }
}

function sweepEphemeralOrphans(): void {
  const orphans = loadSessions().filter(s => s.name.startsWith('ephemeral-'))
  if (orphans.length === 0) return
  console.log(`Sweeping ${orphans.length} orphan ephemeral session(s) from previous run`)
  for (const o of orphans) {
    try {
      execSync(`${SCRIPT_PATH} remove ${o.name}`, { encoding: 'utf8', timeout: 10_000 })
    } catch (err) {
      console.warn(`  failed to remove ${o.name}:`, err instanceof Error ? err.message : err)
    }
  }
}

function projectSessionsDir(repoPath: string): string {
  return join(homedir(), '.claude', 'projects', repoPath.replace(/\//g, '-'))
}

function listRecentSessions(repoPath: string, limit: number): SessionEntry[] {
  const dir = projectSessionsDir(repoPath)
  const cmd =
    `for f in ${dir}/*.jsonl; do ` +
    `id=$(basename "$f" .jsonl); ` +
    `ts=$(head -1 "$f" 2>/dev/null | grep -o '"timestamp":"[^"]*"' | head -1 | cut -d'"' -f4); ` +
    `name=$(grep -o '"slug":"[^"]*"' "$f" 2>/dev/null | head -1 | cut -d'"' -f4); ` +
    `echo "$ts | $id | $name"; ` +
    `done 2>/dev/null | sort -r | head -${limit}`
  const output = execSync(cmd, { encoding: 'utf8', timeout: 10000, shell: '/bin/bash' }).trim()
  if (!output) return []
  return output.split('\n').map(line => {
    const [ts, id, name] = line.split(' | ').map(s => s.trim())
    return {
      ts: ts ? ts.replace('T', ' ').slice(0, 16) : '?',
      id: id ?? '',
      name: name ?? '',
    }
  })
}

// ─── Resilience ───────────────────────────────────────────────────────────

client.on('error', err => console.error(`[Discord] Client error: ${err.message}`))
client.on('warn', m => console.warn(`[Discord] Warning: ${m}`))
client.on('shardError', (err, shardId) =>
  console.error(`[Discord] Shard ${shardId} error: ${err.message}`),
)
client.on('shardDisconnect', (event, shardId) =>
  console.warn(`[Discord] Shard ${shardId} disconnected (code ${event.code}). Auto-reconnecting...`),
)
client.on('shardReconnecting', shardId => console.log(`[Discord] Shard ${shardId} reconnecting...`))
client.on('shardResume', (shardId, replayed) =>
  console.log(`[Discord] Shard ${shardId} resumed. Replayed ${replayed} events.`),
)

process.on('unhandledRejection', reason => console.error('[Process] Unhandled rejection:', reason))
process.on('uncaughtException', err => console.error('[Process] Uncaught exception:', err))

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
