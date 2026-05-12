#!/usr/bin/env bun
/**
 * Smoke Connect — verifies the bot can log in to Discord and reach `ready`.
 *
 * No messages are sent. No channels are touched. This catches the 80% of
 * post-deploy / post-upgrade failures: bad token, missing Message Content
 * Intent, discord.js incompatibility, network/firewall, broken boot.
 *
 * Run after:
 *   - rotating DISCORD_BOT_TOKEN
 *   - upgrading discord.js or bun
 *   - changing intents/scopes in the Developer Portal
 *
 * Exit codes:
 *   0 — connected, ready event received
 *   1 — failed (no token, login error, or ready timeout)
 *
 * Usage:  bun scripts/smoke.ts
 */

import { Client, GatewayIntentBits, Partials } from 'discord.js'
import { loadBotToken } from '../config'

const TIMEOUT_MS = 30_000

const token = loadBotToken()
if (!token) {
  console.error('❌ No bot token. Set DISCORD_BOT_TOKEN in .env')
  process.exit(1)
}

const client = new Client({
  intents: [
    GatewayIntentBits.DirectMessages,
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
  partials: [Partials.Channel],
})

const started = Date.now()
const timeout = setTimeout(() => {
  console.error(`❌ Timed out after ${TIMEOUT_MS / 1000}s waiting for ready event.`)
  console.error('   Check: token validity, Message Content Intent, network to gateway.discord.gg')
  void client.destroy().finally(() => process.exit(1))
}, TIMEOUT_MS)

client.once('ready', () => {
  clearTimeout(timeout)
  const ms = Date.now() - started
  const tag = client.user?.tag ?? 'unknown'
  const guilds = client.guilds.cache.size
  console.log(`✅ Connected as ${tag} in ${ms}ms (${guilds} guild${guilds === 1 ? '' : 's'})`)
  void client.destroy().finally(() => process.exit(0))
})

client.on('error', err => {
  console.error(`❌ Client error: ${err.message}`)
})

try {
  await client.login(token)
} catch (err) {
  clearTimeout(timeout)
  console.error(`❌ Login failed: ${err instanceof Error ? err.message : err}`)
  console.error('   Likely cause: invalid or revoked token.')
  process.exit(1)
}
