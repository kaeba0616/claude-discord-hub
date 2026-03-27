# Claude Code Discord Hub

핸드폰의 Discord에서 각 레포지토리별 Claude Code 세션과 대화할 수 있는 커스텀 봇.

**하나의 Discord 봇**으로 여러 채널을 관리하고, 각 채널이 별도의 Claude Code 세션에 연결됩니다.

## Architecture

```
Discord Server (봇 1개)
├── #project-a  ──→  봇  ──→  localhost:9001  ──→  Claude 세션 A (~/dev/project-a)
├── #project-b  ──→  봇  ──→  localhost:9002  ──→  Claude 세션 B (~/dev/project-b)
└── #project-c  ──→  봇  ──→  localhost:9003  ──→  Claude 세션 C (~/dev/project-c)
```

구성 요소:
- **`bot.ts`** — Discord gateway 연결 + 채널→세션 라우팅 + 관리 명령어
- **`channel.ts`** — Bridge MCP 채널 (세션마다 1개, HTTP로 메시지 수신 → Claude에 전달)
- **`claude-sessions.sh`** — 세션 등록/시작/중지 매니저

## Prerequisites

- Claude Code v2.1.80+
- [Bun](https://bun.sh) runtime
- tmux
- Discord 서버 (관리자 권한)

## 초기 설정 (최초 1회)

### 1. 의존성 설치

```bash
git clone <this-repo>
cd discordbot
bun install
```

### 2. Discord Bot 생성

1. https://discord.com/developers/applications → **New Application** (길드 설치)
2. **Bot** 탭 → **Reset Token** → 토큰 복사
3. **Message Content Intent** 활성화 (필수!)
4. **OAuth2 > URL Generator**
   - Scopes: `bot`
   - Permissions: View Channels, Send Messages, Send Messages in Threads, Read Message History, Attach Files, Add Reactions
5. 생성된 URL로 서버에 봇 초대

### 3. 봇 토큰 설정

```bash
echo "DISCORD_BOT_TOKEN=<your-token>" > .env
```

### 4. 봇 시작

```bash
./claude-sessions.sh bot start
```

Discord에서 봇이 온라인으로 표시되면 성공.

## 사용법

### 새 프로젝트 연결 (Discord에서)

1. Discord 서버에 채널 생성 (예: `#myproject`)
2. 해당 채널에서:
   ```
   !add myproject ~/dev/myproject
   ```
3. 약 10초 후 세션 자동 시작 → 채널에 메시지를 보내면 Claude가 응답

레포 폴더가 없으면 자동 생성됩니다.

### 기존 세션 이어서 연결 (Discord에서)

세션 ID를 알고 있다면 `!add` 시 바로 resume 가능:
```
!add myproject ~/dev/myproject <session-id>
```

세션 ID를 모르면 먼저 연결 후 찾기:
```
!add myproject ~/dev/myproject       # 일단 새 세션으로 연결
!sessions                            # 기존 세션 목록에서 ID 확인
!stop                                # 새 세션 중지
!resume <id>                         # 원하는 기존 세션으로 전환
```

### 새 프로젝트 연결 (터미널에서)

```bash
# 채널 ID 확인: Discord 설정 > 고급 > 개발자 모드 → 채널 우클릭 > 채널 ID 복사
./claude-sessions.sh add myproject ~/dev/myproject <channel-id>
./claude-sessions.sh start myproject

# 기존 세션 이어서
./claude-sessions.sh start myproject --resume "<session-id>"
```

### 세션 중지/삭제 (Discord에서)

- `!stop` — 세션 중지 (설정 유지, `!start`로 재시작 가능)
- `!remove` — 세션 종료 + 채널 연결 설정 삭제 (다시 쓰려면 `!add`부터)

둘 다 레포 폴더와 코드는 건드리지 않습니다.

### 이전 세션 이어서 하기

```
!last              # 가장 최근 세션 ID 확인
!sessions          # 최근 5개 세션 목록 (현재 채널 레포만)
!resume <id>       # 이전 대화 이어서 시작
```

### 전체 시작/중지

```bash
./claude-sessions.sh start-all   # 봇 + 모든 세션 시작
./claude-sessions.sh stop-all    # 모든 세션 + 봇 중지
```

## Discord 채널 명령어

| 명령어 | 설명 |
|--------|------|
| `!add <name> <repo-path> [session-id]` | 채널을 레포에 연결 (세션 ID로 resume 가능) |
| `!remove` | 현재 채널의 세션 삭제 |
| `!start` | 세션 시작 |
| `!stop` | 세션 중지 |
| `!last` | 가장 최근 세션 ID |
| `!sessions` | 최근 5개 세션 목록 |
| `!resume <id>` | 이전 세션 이어서 |
| `!status` | 모든 세션 상태 |
| `!list` | 등록된 세션 목록 |
| `!reload` | 설정 새로고침 |
| `!help` | 명령어 목록 |

## CLI Commands

### Session 관리

| 명령 | 설명 |
|------|------|
| `add <name> <repo> <channel-id>` | 세션 등록 (포트 자동 할당) |
| `start <name> [--resume <id>]` | 세션 시작 |
| `stop <name>` | 세션 중지 |
| `start-all` | 봇 + 모든 세션 시작 |
| `stop-all` | 모든 세션 + 봇 중지 |
| `status` | 전체 상태 확인 |
| `list` | 등록된 세션 목록 |
| `remove <name>` | 세션 삭제 |

### Bot 관리

| 명령 | 설명 |
|------|------|
| `bot start` | Discord 봇 시작 |
| `bot stop` | Discord 봇 중지 |
| `bot status` | 봇 상태 확인 |

## Permission Relay

Claude가 파일 수정, 명령 실행 등 권한이 필요한 작업을 할 때 Discord 채널에 버튼이 표시됩니다:

```
🔐 Bash: npm test
[✅ Allow] [❌ Deny]
```

핸드폰에서 버튼을 눌러 승인/거부합니다. `reply` 도구는 자동 승인되어 별도 확인 없이 응답합니다.

## File Structure

```
bot.ts               # Discord 봇 (1개만 실행)
channel.ts           # Bridge MCP 채널 (세션마다 1개)
config.ts            # 공유 설정 유틸
claude-sessions.sh   # 매니저 스크립트
.env                 # 봇 토큰 (git에 포함 안 됨)
.mcp.json            # 자동 생성 (git에 포함 안 됨)

~/.claude/channels/sessions/
├── myproject.conf   # repo_path, channel_id, port
└── backend.conf
```

## Troubleshooting

| 증상 | 해결 |
|------|------|
| `!start` 후 메시지에 반응 없음 | 약 10초 기다린 후 다시 시도 (자동 승인 대기 시간) |
| 봇이 오프라인 | `./claude-sessions.sh bot start` 실행 |
| 봇이 메시지를 무시 | Developer Portal > Bot > **Message Content Intent** 활성화 확인 |
| 세션 시작 안 됨 | `tmux attach -t claude-<name>`으로 직접 확인 |
| `!add` 실패 | 레포 경로가 서버의 절대경로 또는 `~/` 경로인지 확인 |
