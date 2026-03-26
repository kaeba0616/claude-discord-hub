/**
 * Shared configuration utilities for claude-discord-hub.
 * Reads session configs from ~/.claude/channels/sessions/*.conf
 */

import { readFileSync, readdirSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'

export const SESSIONS_DIR = join(homedir(), '.claude', 'channels', 'sessions')
export const BASE_PORT = 9001

export interface SessionConfig {
  name: string
  repoPath: string
  channelId: string
  port: number
}

/** Parse a single .conf file into a SessionConfig */
function parseConf(name: string, content: string): SessionConfig {
  const fields: Record<string, string> = {}
  for (const line of content.split('\n')) {
    const m = line.match(/^(\w+)=(.*)$/)
    if (m) fields[m[1]] = m[2]
  }
  return {
    name,
    repoPath: fields.repo_path ?? '',
    channelId: fields.channel_id ?? '',
    port: Number(fields.port) || BASE_PORT,
  }
}

/** Load all session configs */
export function loadSessions(): SessionConfig[] {
  try {
    const files = readdirSync(SESSIONS_DIR).filter(f => f.endsWith('.conf'))
    return files.map(f => {
      const content = readFileSync(join(SESSIONS_DIR, f), 'utf8')
      return parseConf(f.replace('.conf', ''), content)
    })
  } catch {
    return []
  }
}

/** Build a Map<channelId, SessionConfig> for routing */
export function buildRouteMap(): Map<string, SessionConfig> {
  const map = new Map<string, SessionConfig>()
  for (const session of loadSessions()) {
    if (session.channelId) {
      map.set(session.channelId, session)
    }
  }
  return map
}

/** Load bot token from .env file in project root */
export function loadBotToken(): string {
  const envPath = join(import.meta.dir, '.env')
  try {
    const content = readFileSync(envPath, 'utf8')
    for (const line of content.split('\n')) {
      const m = line.match(/^DISCORD_BOT_TOKEN=(.+)$/)
      if (m) return m[1].trim()
    }
  } catch {}
  return process.env.DISCORD_BOT_TOKEN ?? ''
}
