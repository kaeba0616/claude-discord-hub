# Claude Code Discord Hub — Quick Start

핸드폰의 Discord로 컴퓨터의 Claude Code랑 대화할 수 있게 해주는 봇입니다.

## 사전 설치

- [Bun](https://bun.sh)
- `tmux`
- `claude` CLI (v2.1.80+)

## 1️⃣ Discord 봇 만들기 (한 번만, 2분)

- https://discord.com/developers/applications → **New Application**
- **Bot** 탭 → **Reset Token** → 토큰 복사 (지금 잘 보관)
- **Message Content Intent 활성화** ← 필수! 이거 안 켜면 봇이 메시지를 못 봄
- **OAuth2 → URL Generator**
  - Scopes: `bot`
  - Permissions: `View Channels`, `Send Messages`, `Send Messages in Threads`, `Read Message History`, `Attach Files`, `Add Reactions`
- 만들어진 URL로 본인 Discord 서버에 봇 초대

## 2️⃣ 레포 셋업 (3분)

```bash
git clone <this-repo> ~/dev/discordbot
cd ~/dev/discordbot
bun install
echo "DISCORD_BOT_TOKEN=<위에서 복사한 토큰>" > .env
```

## 3️⃣ 연결 확인 (선택, 30초)

```bash
bun run smoke
```

- `✅ Connected as YourBot#1234 (1 guild)` → 성공
- 실패 → 토큰 또는 Message Content Intent 확인

## 4️⃣ 봇 띄우기

```bash
./claude-sessions.sh bot start
```

Discord에서 봇이 초록색 동그라미로 표시되면 ready.

## 5️⃣ 첫 프로젝트 연결

Discord 서버에 채널 하나 만들기 (예: `#myproject`). 그 채널에서 메시지로:

```
!add myproject ~/dev/myproject
```

약 10초 후 봇이 응답:

```
✅ Session myproject created and started.
Repo: /home/you/dev/myproject
```

레포 폴더가 없으면 자동으로 만들어줍니다.

## 6️⃣ Claude와 대화

같은 채널에서 그냥 메시지 보내세요. Claude가 응답합니다.

- 👀 이모지 = 메시지 도착함
- Claude 응답이 메시지로 뒤이어 옴
- 길면 자동으로 여러 메시지로 쪼개짐

## 7️⃣ 권한 버튼 (자동 등장)

Claude가 파일 수정·명령 실행·웹 접근 같은 권한이 필요하면 채널에 버튼이 뜸:

```
🔐 Bash: npm test
[✅ Allow] [❌ Deny]
```

핸드폰에서 버튼 한 번 누르면 승인/거부. `reply` 도구만은 매번 자동 승인됩니다.

## 8️⃣ 회의 요약 (선택 기능)

**사전 설정 한 번:**

```bash
# Discord에 더미 채널 하나 만들고 ID 복사 (이 채널은 실제로 안 씁니다)
./claude-sessions.sh add summarizer ~/work/summarizer-workspace <DUMMY_CH_ID> summary
```

그리고 `~/work/summarizer-workspace/CLAUDE.md`에 요약 지시를 넣어둡니다 (이 레포의 예시 참고).

**사용:**

- 프로젝트 채널에서 메시지 우클릭 → **스레드 만들기**
- 스레드에서 회의 진행
- 스레드에 `!summary` 입력
- 15~30초 후 스레드에 한국어 요약 게시됨 (`📝 **요약**`)

매번 임시 Claude 세션이 떴다 사라지므로 프로젝트끼리 내용이 안 섞입니다.

## 9️⃣ 자주 쓰는 명령어 (Discord 채널에서)

- `!resume` — 마지막 대화에서 이어서 시작 (`claude -c`)
- `!stop` — 현재 채널 세션 중지
- `!start` — 다시 시작
- `!status` — 전체 세션 상태
- `!sessions` — 최근 5개 대화 목록
- `!summary` — (스레드에서) 회의 요약
- `!help` — 전체 명령어 보기

## 🔟 트러블슈팅

- **메시지에 반응 없음** → 10초 정도 기다린 뒤 재시도 (Claude 부팅 + 자동 승인 대기)
- **봇이 오프라인** → `./claude-sessions.sh bot start` 다시 실행
- **봇이 모든 메시지 무시** → Developer Portal에서 **Message Content Intent** 켰는지 확인
- **세션이 안 시작됨** → `tmux attach -t claude-<name>`로 직접 들여다보기
- **`!summary` 안 됨** → 위 8️⃣ 사전 설정 했는지 확인

## 멘탈 모델 (핵심 한 줄씩)

- 봇 1개가 Discord ↔ 내 컴퓨터의 여러 Claude 세션을 연결
- 채널 = 1 프로젝트. `!add`로 한 번만 연결, 이후 메시지는 자동 라우팅
- 모든 세션은 tmux + Claude CLI가 계속 켜져 있는 영구 프로세스
- 회의 요약(`!summary`)만 예외 — 매번 임시 세션 spawn → 요약 → 종료
- 컴퓨터/봇만 켜져 있으면 핸드폰에서 어디서든 Claude와 대화 가능
