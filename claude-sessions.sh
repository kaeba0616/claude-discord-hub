#!/usr/bin/env bash
set -euo pipefail

# Claude Code Discord Hub — Session Manager
# Custom bot architecture: 1 bot, N channels, N Claude sessions
# Bot routes Discord messages to per-session MCP bridge channels via HTTP

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CHANNELS_DIR="$HOME/.claude/channels"
SESSIONS_DIR="$CHANNELS_DIR/sessions"
TMUX_PREFIX="claude-"
BOT_TMUX="claude-bot"
BASE_PORT=9001

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m'

check_deps() {
    for cmd in tmux claude bun; do
        if ! command -v "$cmd" &>/dev/null; then
            echo -e "${RED}Error: '$cmd' is not installed.${NC}" >&2
            exit 1
        fi
    done
}

init_config() {
    mkdir -p "$SESSIONS_DIR"
}

session_conf() {
    echo "$SESSIONS_DIR/${1}.conf"
}

session_exists() {
    [[ -f "$(session_conf "$1")" ]]
}

get_field() {
    local name="$1" field="$2"
    grep "^${field}=" "$(session_conf "$name")" 2>/dev/null | cut -d= -f2-
}

list_sessions() {
    local sessions=()
    shopt -s nullglob
    for f in "$SESSIONS_DIR"/*.conf; do
        sessions+=("$(basename "$f" .conf)")
    done
    shopt -u nullglob
    if [[ ${#sessions[@]} -gt 0 ]]; then
        printf '%s\n' "${sessions[@]}"
    fi
}

# Find next available port
next_port() {
    local max_port=$((BASE_PORT - 1))
    shopt -s nullglob
    for f in "$SESSIONS_DIR"/*.conf; do
        local p
        p=$(grep "^port=" "$f" 2>/dev/null | cut -d= -f2-)
        if [[ -n "$p" ]] && (( p > max_port )); then
            max_port=$p
        fi
    done
    shopt -u nullglob
    echo $((max_port + 1))
}

# ─── ADD ────────────────────────────────────────────────────────────────────
cmd_add() {
    local name="${1:?Usage: $0 add <name> <repo-path> <channel-id>}"
    local repo_path="${2:?Missing repo-path}"
    local channel_id="${3:?Missing discord-channel-id}"

    if session_exists "$name"; then
        echo -e "${RED}Session '$name' already exists. Use 'remove' first.${NC}"
        exit 1
    fi

    # Expand ~ before realpath
    repo_path="${repo_path/#\~/$HOME}"
    if [[ ! -d "$repo_path" ]]; then
        mkdir -p "$repo_path"
        echo -e "${YELLOW}Created directory: $repo_path${NC}"
    fi
    repo_path="$(realpath "$repo_path")"
    if [[ ! -d "$repo_path" ]]; then
        echo -e "${RED}Failed to create: $repo_path${NC}"
        exit 1
    fi

    local port
    port="$(next_port)"

    cat > "$(session_conf "$name")" <<EOF
repo_path=$repo_path
channel_id=$channel_id
port=$port
EOF

    echo -e "${GREEN}Added session '$name'${NC}"
    echo -e "  Repo:      $repo_path"
    echo -e "  Channel:   $channel_id"
    echo -e "  Port:      $port"
    echo ""
    echo -e "${YELLOW}Next: ${CYAN}$0 start $name${NC}"
}

# ─── START ──────────────────────────────────────────────────────────────────
cmd_start() {
    local name="${1:?Usage: $0 start <name> [--resume <session-id>]}"
    shift
    local resume_arg=""

    while [[ $# -gt 0 ]]; do
        case "$1" in
            --resume|-r)
                resume_arg="--resume '${2:?Missing session ID for --resume}'"
                shift 2
                ;;
            *)
                echo -e "${RED}Unknown option: $1${NC}"
                exit 1
                ;;
        esac
    done

    if ! session_exists "$name"; then
        echo -e "${RED}Session '$name' not found.${NC}"
        exit 1
    fi

    local tmux_name="${TMUX_PREFIX}${name}"

    if tmux has-session -t "$tmux_name" 2>/dev/null; then
        echo -e "${YELLOW}Session '$name' is already running (tmux: $tmux_name)${NC}"
        return
    fi

    local repo_path channel_id port
    repo_path="$(get_field "$name" repo_path)"
    channel_id="$(get_field "$name" channel_id)"
    port="$(get_field "$name" port)"

    # Ensure reply tool is auto-allowed in project settings
    local encoded_path
    encoded_path="$(echo "$repo_path" | sed 's|/|-|g')"
    local proj_settings_dir="$HOME/.claude/projects/${encoded_path}"
    local proj_settings="$proj_settings_dir/settings.json"
    mkdir -p "$proj_settings_dir"
    if [[ ! -f "$proj_settings" ]]; then
        cat > "$proj_settings" <<'SETTINGS'
{
  "allowedTools": [
    "mcp__claude_bridge__reply"
  ]
}
SETTINGS
    else
        # Add reply tool if not already present
        if ! grep -q "mcp__claude_bridge__reply" "$proj_settings" 2>/dev/null; then
            # Insert into allowedTools array
            sed -i 's/"allowedTools": \[/"allowedTools": [\n    "mcp__claude_bridge__reply",/' "$proj_settings"
        fi
    fi

    # Pre-create .claude/settings.local.json to skip MCP server selection prompt
    mkdir -p "$repo_path/.claude"
    if [[ ! -f "$repo_path/.claude/settings.local.json" ]]; then
        cat > "$repo_path/.claude/settings.local.json" <<'LOCALSETTINGS'
{
  "enabledMcpjsonServers": [
    "claude_bridge"
  ],
  "disabledMcpjsonServers": [
    "chzzk-ideas"
  ],
  "enableAllProjectMcpServers": true
}
LOCALSETTINGS
    fi

    # Create .mcp.json in repo directory for the bridge channel
    cat > "$repo_path/.mcp.json" <<EOF
{
  "mcpServers": {
    "claude_bridge": {
      "command": "bun",
      "args": ["${SCRIPT_DIR}/channel.ts"],
      "env": {
        "CHANNEL_PORT": "${port}",
        "BOT_URL": "http://localhost:3000",
        "DISCORD_CHANNEL_ID": "${channel_id}"
      }
    }
  }
}
EOF

    tmux new-session -d -s "$tmux_name" -c "$repo_path" \
        "claude --dangerously-load-development-channels server:claude_bridge --permission-mode acceptEdits $resume_arg; echo 'Session ended. Press Enter to close.'; read"

    # Auto-approve confirmation prompts (MCP server + dev channels warning)
    (
        sleep 5 && tmux send-keys -t "$tmux_name" Enter 2>/dev/null
        sleep 5 && tmux send-keys -t "$tmux_name" Enter 2>/dev/null
    ) &

    echo -e "${GREEN}Started session '$name'${NC}"
    echo -e "  tmux: ${CYAN}$tmux_name${NC}  port: ${CYAN}$port${NC}  repo: $repo_path"
    if [[ -n "$resume_arg" ]]; then
        echo -e "  Resuming: ${CYAN}${resume_arg}${NC}"
    fi
}

# ─── STOP ───────────────────────────────────────────────────────────────────
cmd_stop() {
    local name="${1:?Usage: $0 stop <name>}"
    local tmux_name="${TMUX_PREFIX}${name}"

    if ! tmux has-session -t "$tmux_name" 2>/dev/null; then
        echo -e "${YELLOW}Session '$name' is not running.${NC}"
        return
    fi

    tmux send-keys -t "$tmux_name" "/exit" Enter
    sleep 2
    if tmux has-session -t "$tmux_name" 2>/dev/null; then
        tmux kill-session -t "$tmux_name"
    fi

    echo -e "${GREEN}Stopped session '$name'${NC}"
}

# ─── BOT ────────────────────────────────────────────────────────────────────
cmd_bot() {
    local action="${1:?Usage: $0 bot <start|stop|status>}"

    case "$action" in
        start)
            if tmux has-session -t "$BOT_TMUX" 2>/dev/null; then
                echo -e "${YELLOW}Bot is already running.${NC}"
                return
            fi
            tmux new-session -d -s "$BOT_TMUX" -c "$SCRIPT_DIR" \
                "bun bot.ts; echo 'Bot ended. Press Enter to close.'; read"
            echo -e "${GREEN}Bot started (tmux: $BOT_TMUX)${NC}"
            ;;
        stop)
            if ! tmux has-session -t "$BOT_TMUX" 2>/dev/null; then
                echo -e "${YELLOW}Bot is not running.${NC}"
                return
            fi
            tmux kill-session -t "$BOT_TMUX"
            echo -e "${GREEN}Bot stopped.${NC}"
            ;;
        status)
            if tmux has-session -t "$BOT_TMUX" 2>/dev/null; then
                echo -e "${GREEN}Bot is running (tmux: $BOT_TMUX)${NC}"
            else
                echo -e "${RED}Bot is not running.${NC}"
            fi
            ;;
        *)
            echo -e "${RED}Usage: $0 bot <start|stop|status>${NC}"
            exit 1
            ;;
    esac
}

# ─── START-ALL ──────────────────────────────────────────────────────────────
cmd_start_all() {
    cmd_bot start
    local names
    names="$(list_sessions)"
    if [[ -z "$names" ]]; then
        echo -e "${YELLOW}No sessions configured.${NC}"
        return
    fi
    while IFS= read -r name; do
        cmd_start "$name"
    done <<< "$names"
}

# ─── STOP-ALL ───────────────────────────────────────────────────────────────
cmd_stop_all() {
    local names
    names="$(list_sessions)"
    if [[ -n "$names" ]]; then
        while IFS= read -r name; do
            cmd_stop "$name"
        done <<< "$names"
    fi
    cmd_bot stop
}

# ─── STATUS ─────────────────────────────────────────────────────────────────
cmd_status() {
    # Bot status
    if tmux has-session -t "$BOT_TMUX" 2>/dev/null; then
        echo -e "Bot: ${GREEN}running${NC}"
    else
        echo -e "Bot: ${RED}stopped${NC}"
    fi
    echo ""

    local names
    names="$(list_sessions)"
    if [[ -z "$names" ]]; then
        echo -e "${YELLOW}No sessions configured.${NC}"
        return
    fi

    printf "${BLUE}%-15s %-10s %-6s %-35s %s${NC}\n" "NAME" "STATUS" "PORT" "REPO" "CHANNEL"
    printf "%-15s %-10s %-6s %-35s %s\n" "----" "------" "----" "----" "-------"

    while IFS= read -r name; do
        local tmux_name="${TMUX_PREFIX}${name}"
        local repo_path channel_id port status_text

        repo_path="$(get_field "$name" repo_path)"
        channel_id="$(get_field "$name" channel_id)"
        port="$(get_field "$name" port)"

        if tmux has-session -t "$tmux_name" 2>/dev/null; then
            status_text="${GREEN}running${NC}"
        else
            status_text="${RED}stopped${NC}"
        fi

        printf "%-15s %-10b %-6s %-35s %s\n" "$name" "$status_text" "$port" "$repo_path" "$channel_id"
    done <<< "$names"
}

# ─── LIST ───────────────────────────────────────────────────────────────────
cmd_list() {
    local names
    names="$(list_sessions)"
    if [[ -z "$names" ]]; then
        echo -e "${YELLOW}No sessions configured.${NC}"
        return
    fi

    echo -e "${BLUE}Configured sessions:${NC}"
    echo ""
    while IFS= read -r name; do
        echo -e "  ${CYAN}$name${NC}"
        echo -e "    Repo:    $(get_field "$name" repo_path)"
        echo -e "    Channel: $(get_field "$name" channel_id)"
        echo -e "    Port:    $(get_field "$name" port)"
        echo ""
    done <<< "$names"
}

# ─── REMOVE ─────────────────────────────────────────────────────────────────
cmd_remove() {
    local name="${1:?Usage: $0 remove <name>}"

    if ! session_exists "$name"; then
        echo -e "${RED}Session '$name' not found.${NC}"
        exit 1
    fi

    local tmux_name="${TMUX_PREFIX}${name}"
    if tmux has-session -t "$tmux_name" 2>/dev/null; then
        cmd_stop "$name"
    fi

    # Clean up .mcp.json from repo
    local repo_path
    repo_path="$(get_field "$name" repo_path)"
    if [[ -f "$repo_path/.mcp.json" ]]; then
        rm -f "$repo_path/.mcp.json"
    fi

    rm -f "$(session_conf "$name")"
    echo -e "${GREEN}Removed session '$name'${NC}"
}

# ─── HELP ───────────────────────────────────────────────────────────────────
cmd_help() {
    cat <<'HELP'
Claude Code Discord Hub — Session Manager

Usage: claude-sessions.sh <command> [args]

Session Commands:
  add <name> <repo-path> <channel-id>
                      Register a new repo (port auto-assigned)
  start <name> [--resume <id>]
                      Start a Claude Code session
  stop <name>         Stop a running session
  start-all           Start bot + all sessions
  stop-all            Stop all sessions + bot
  status              Show bot and session status
  list                List all configured sessions
  remove <name>       Delete a session config

Bot Commands:
  bot start           Start the Discord bot
  bot stop            Stop the Discord bot
  bot status          Check bot status

Examples:
  # First time setup
  claude-sessions.sh bot start
  claude-sessions.sh add myproject ~/dev/myproject 846209781206941736
  claude-sessions.sh start myproject

  # Resume a previous session
  claude-sessions.sh start myproject --resume "session-id"

  # Start everything
  claude-sessions.sh start-all
HELP
}

# ─── MAIN ───────────────────────────────────────────────────────────────────
main() {
    check_deps
    init_config

    local command="${1:-help}"
    shift || true

    case "$command" in
        add)        cmd_add "$@" ;;
        start)      cmd_start "$@" ;;
        stop)       cmd_stop "$@" ;;
        bot)        cmd_bot "$@" ;;
        start-all)  cmd_start_all ;;
        stop-all)   cmd_stop_all ;;
        status)     cmd_status ;;
        list)       cmd_list ;;
        remove)     cmd_remove "$@" ;;
        help|--help|-h) cmd_help ;;
        *)
            echo -e "${RED}Unknown command: $command${NC}"
            echo "Run '$0 help' for usage."
            exit 1
            ;;
    esac
}

main "$@"
