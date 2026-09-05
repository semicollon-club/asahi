---
lastReviewed: 2026-09-05
---

# 미니PC 단일 호스트 셋업 — 봇 이사(풀 하네스 1단계)

봇을 Railway 에서 동아리 미니PC 로 옮긴다. 미니PC 한 대에 **역할별 표준 계정 둘**을 두는 배치다
([설계](../docs/superpowers/specs/2026-09-05-full-harness-worker-design.md) §3·§9,
[계획](../docs/superpowers/plans/2026-09-05-full-harness-worker.md) 1단계).

| 계정 | 역할 | 클론 | 가진 비밀 |
|---|---|---|---|
| **A** `asahi-bot`(새로 만든다) | 봇 — 디스코드·코어·워커 허브(`/worker`)·파일 수신(`/files`). 2단계부터 인증 프록시·MCP 허브도 여기 | `C:\Users\asahi-bot\asahi-bot` | `.env` 전부(디스코드 토큰·DB·깃허브 App·구독 토큰) |
| **B** `asahi`(지금의 워커 계정) | 워커 — 부원의 파일·셸 작업이 실제로 도는 곳. 2단계부터 세션 러너 | `C:\asahi-worker`(그대로) | `WORKER_TOKEN` 하나 |

두 계정으로 나누는 이유는 딱 하나다 — **표준 계정 B 는 A 의 프로필 폴더(NTFS)와 프로세스 환경을 읽지 못한다.**
부원의 `sh_exec` 는 B 에서 돌고 경로로 봉쇄되지 않으므로, 자격증명이 B 가 닿는 곳에 있으면 셸 한 줄로 새어
나간다. 그래서 A 의 클론과 `.env` 는 `C:\` 루트가 아니라 **A 의 프로필 폴더 안**에 둔다 — `C:\asahi-bot` 처럼 루트에
만들면 윈도우 기본 ACL(`Users: 읽기 및 실행`)로 B 가 `.env` 를 읽을 수 있다.

허브는 `HUB_BIND=127.0.0.1` 로 **루프백에만** 묶는다. 같은 기계의 B 만 붙고, 밖에서는 포트 자체가 보이지 않는다.
그 대가로 운영자 개인 PC 의 워커는 더 이상 붙을 수 없다(등록만 되고 쓰인 적이 없다 — `allowed_dirs` 0행).

**코드 변경은 이 문서를 실은 커밋에 들어 있다**: `HUB_BIND`, `BOT_SENTINEL`(봇 자동 갱신), 봇 커밋을 git 에서
읽는 `runtime_info`, 봇·워커 공용 갱신 스크립트 `deploy/update-service.ps1`. 운영자가 할 일은 전부 아래 절차다 —
**컷오버(5절) 전까지 Railway 봇은 그대로 돈다.** 절차 1~4 는 Railway 를 건드리지 않으므로 며칠에 나눠 해도 된다.

## 0. 시작 전 확인

- 미니PC 에서 워커(`asahi` 계정, `C:\asahi-worker`, 작업 `asahi-worker`·`asahi-worker-update`)가 돌고 있다.
- Node.js 22 이상과 Git 2.31 이상이 **기계 전체에**(모든 사용자용으로) 설치돼 있다 — `asahi-bot` 창에서 `node -v`,
  `git --version` 이 나와야 한다. 사용자별 설치였다면 A 에서도 다시 설치한다.
- 관리자 계정으로 로그인할 수 있다(계정 생성·작업 스케줄러 등록에 한 번씩 필요).
- Railway `asahi` 서비스의 **Variables 값을 볼 수 있다**(A 의 `.env` 로 옮긴다).
- 이 커밋이 `production` 에 병합돼 있다 — 워커의 `update-worker.ps1` 이 래퍼로 바뀐 판이 미니PC 에 먼저 깔려야
  하고(다음 회차에 자동), A 의 클론도 `production` 을 받는다.
- **원격 접속이 Tailscale 이면 미니PC 의 Tailscale 에 "Run unattended"(무인 실행)가 켜져 있어야 한다.** 꺼져 있으면
  로그인한 사용자가 로그아웃하는 순간 Tailscale 이 함께 내려가 원격 데스크톱이 끊긴다 — 2026-09-05 밤에 실제로 겪었고,
  미니PC 앞에 갈 수 없는 상태라 아래 절차가 멈췄다. 확인은 트레이의 Tailscale 아이콘 메뉴. **그리고 이 절차 중에는 절대
  로그아웃하지 않는다** — 다른 계정의 창이 필요하면 `runas /user:<계정> powershell` 로 그 계정의 PowerShell 을 관리자
  세션 안에서 띄운다(1·2절). 원격 접속이 끊겼을 때 봇을 통해 되살리는 길은 소유자의 유지보수 지시다(`docs/security/
  capability-model.md` 의 "소유자 유지보수 예외") — 승인 링크가 나올 수 있는 명령은 **운영자만 보는 채널**에서 시킨다.

## 1. 계정 A 만들기(관리자 창, 한 번)

관리자 PowerShell 에서:

```powershell
net user asahi-bot * /add /expires:never
Set-LocalUser -Name asahi-bot -PasswordNeverExpires $true
```

`net user … *` 는 암호를 두 번 묻는다 — **붙여 넣지 말고 직접 친다**(암호는 작업 스케줄러 등록(4절)에 다시 필요하니
적어 둔다). 관리자 그룹에 넣지 않는다 — `Users` 그룹의 표준 계정이어야 한다(`Get-LocalGroupMember Administrators`
에 없어야 한다).

그다음 **같은 관리자 창에서 `asahi-bot` 계정의 PowerShell 을 띄운다** — 로그인 화면에서 계정을 전환하지 않는다(원격
세션이 끊긴다, 0절):

```powershell
runas /user:asahi-bot powershell
```

암호를 넣으면 새 창이 뜬다. 이 창은 `asahi-bot` 으로 돌고(첫 줄에 `whoami` 를 쳐서 `…\asahi-bot` 인지 본다), 처음
열릴 때 프로필 폴더 `C:\Users\asahi-bot` 이 만들어진다. 2~3절은 이 창에서 한다. 작업 스케줄러 작업은 로그온 여부와
무관하게 돈다(4절).

## 2. 클론과 의존성(asahi-bot 창)

```powershell
whoami
cd $env:USERPROFILE
git clone -b production https://github.com/semicollon-club/asahi.git asahi-bot
cd asahi-bot\agent
npm.cmd ci
New-Item -ItemType Directory -Force ..\logs | Out-Null
```

- `whoami` 가 `<컴퓨터 이름>\asahi-bot` 이어야 한다. `asahi-admin` 이 보이면 잘못된 창이다 — 2026-09-05 밤 실제로 관리자
  창에서 클론해 `C:\Users\asahi-admin\asahi-bot` 에 들어간 적이 있다(그 폴더는 지우고 다시 했다).
- `npm.cmd ci` 인 이유: `npm` 만 치면 PowerShell 이 `npm.ps1` 을 열려다 실행 정책에 막힌다("이 시스템에서 스크립트를
  실행할 수 없으므로"). `.cmd` 로 부르면 그 스크립트를 거치지 않는다. 봇 작업은 `cmd.exe` 로 실행되므로 운영에는 영향이
  없다.
- `-b production` — 봇도 워커와 같은 브랜치를 따른다. 클론이 `main` 에 있으면 업데이터가 첫 회차에 스스로 전환하지만
  처음부터 맞추는 편이 낫다.
- `npm ci` 는 `package-lock.json` 그대로 설치한다(`npm install` 이 아니다 — 업데이터도 `ci` 를 쓴다).
- 깃허브 로그인(`gh auth`, Git Credential Manager)은 **A 에도 하지 않는다.** 봇의 깃허브 자격증명은 `.env` 의 App 키다.
- `C:\Users\asahi-bot\asahi-bot` 아래에 `data\`(런타임 데이터)·`logs\`·`update.flag`·`update-bot.log` 가 생긴다 —
  전부 `.gitignore` 대상이다.

## 3. `.env` 이관(asahi-bot 창)

`C:\Users\asahi-bot\asahi-bot\.env` 를 만든다(`copy .env.example .env` 뒤 `notepad .env`). Railway `asahi` 서비스의
Variables 를 아래 표대로 옮긴다 — **값을 복사할 때는 Railway 의 눈 아이콘으로 값을 드러낸 뒤 복사한다.** 가려진
표시(`••••`)를 복사하면 40~48자짜리 쓸 수 없는 문자열이 들어간다(2026-09-05 프로브에서 실제로 두 번 겹친 실수다 —
진짜 구독 토큰은 108자·`sk-ant-oat` 로 시작한다).

| 변수 | Railway → A | 비고 |
|---|---|---|
| `DISCORD_TOKEN` | 그대로 | 봇 토큰은 하나다 — 컷오버 전에는 A 에서 봇을 **띄우지 않는다**(게이트웨이 세션 충돌) |
| `DISCORD_OWNER_ID` | 그대로 | |
| `DATABASE_URL` | 그대로 | Supabase Session pooler 문자열(`deploy/railway-셋업.md` "DATABASE_URL" 절). DB 는 그대로 Supabase |
| `CLAUDE_CODE_OAUTH_TOKEN` | 그대로 | 108자·`sk-ant-oat…`. 2단계 프록시가 쓰는 자격증명도 이것이다 |
| `DEPLOY_TARGET` | `cloud` → **`local`** | 미니PC 는 컨테이너가 아니다. `runtime_info` 가 local 로 보고하고 봇·워커 커밋을 견준다 |
| `PORT` | (Railway 주입) → **`3000`** | 워커의 `HUB_URL` 포트와 같아야 한다 |
| `HUB_BIND` | (없음) → **`127.0.0.1`** | 루프백 전용. 비우면 모든 인터페이스에 열린다 — 미니PC 에서는 반드시 채운다 |
| `BOT_SENTINEL` | (없음) → **`C:\Users\asahi-bot\asahi-bot\update.flag`** | 4절 업데이터의 `-Sentinel` 기본값(`<RepoPath>\update.flag`)과 같아야 한다 |
| `DIGEST_CONTEST_CHANNEL_ID`, `DIGEST_DEVNEWS_CHANNEL_ID` | 그대로 | 있을 때만 |
| `PR_NOTIFY_CHANNEL_ID` | 그대로 | 있을 때만 |
| `GITHUB_ORG`, `GITHUB_APP_ID`, `GITHUB_APP_INSTALLATION_ID`, `GITHUB_APP_PRIVATE_KEY_B64` | 그대로 | 넷 다 있어야 발행·git·PR 도구가 열린다. **B(`C:\asahi-worker\.env`)에는 절대 두지 않는다** |
| `ANTHROPIC_MODEL`, `SESSION_IDLE_MINUTES`, `MAX_TURNS_PER_HOUR*` | 그대로 | 설정돼 있던 것만 |
| `DATA_DIR`, `MEMORY_DIR` | (Dockerfile 고정값) → **비운다** | 기본값이 클론 아래 `data\store`·`data\memory` 다 |
| `WORKER_*`, `HUB_URL` | 넣지 않는다 | 워커 전용 — B 의 `.env` 에만 |

저장한 뒤 **B 가 이 파일을 못 읽는지 확인한다** — `asahi` 계정의 창에서:

```powershell
Get-Content C:\Users\asahi-bot\asahi-bot\.env
```

`액세스가 거부되었습니다` 가 나와야 한다. 내용이 보이면 A 의 클론이 프로필 폴더 밖에 있거나 폴더 권한이 바뀐 것이다 —
이 상태로 컷오버하면 부원이 셸 한 줄로 봇의 모든 자격증명을 읽을 수 있다. 여기서 멈추고 위치부터 고친다.

## 4. 작업 스케줄러 둘 등록(관리자 창, 한 번)

다른 계정(A)으로 도는 작업을 만들려면 그 계정의 암호가 필요하므로 **관리자 PowerShell** 에서 한다. 첫 줄이 암호를
묻는다(1절에서 적어 둔 것 — 붙여 넣지 말고 친다). 등록이 끝나면 `Clear-History` 로 지운다.

```powershell
$pw = Read-Host "asahi-bot 암호"
$repo = "C:\Users\asahi-bot\asahi-bot"
$settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -ExecutionTimeLimit ([TimeSpan]::Zero) -StartWhenAvailable -RunOnlyIfNetworkAvailable

# (1) 봇 본체 — 부팅 시 한 번 띄운다. 로그는 클론의 logs\bot.log 에 덧붙인다.
$botAction = New-ScheduledTaskAction -Execute "cmd.exe" -Argument "/c npm run dev >> `"$repo\logs\bot.log`" 2>&1" -WorkingDirectory "$repo\agent"
Register-ScheduledTask -TaskName "asahi-bot" -Action $botAction -Trigger (New-ScheduledTaskTrigger -AtStartup) -Settings $settings -User "asahi-bot" -Password $pw -RunLevel Limited -Description "아사히 봇(계정 asahi-bot). 갱신·재기동은 asahi-bot-update 가 한다"

# (2) 업데이터 — 5분마다 origin/production 을 보고 새 커밋이면 봇을 내리고 갱신한 뒤 다시 띄운다. 봇이 죽어 있으면 살린다.
$updArgs = "-NoProfile -ExecutionPolicy Bypass -File `"$repo\deploy\update-service.ps1`" -RepoPath `"$repo`" -ServiceTask asahi-bot -ServiceName 봇 -LogPath `"$repo\update-bot.log`""
$updAction = New-ScheduledTaskAction -Execute "powershell.exe" -Argument $updArgs
$updTrigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(2) -RepetitionInterval (New-TimeSpan -Minutes 5)
Register-ScheduledTask -TaskName "asahi-bot-update" -Action $updAction -Trigger $updTrigger -User "asahi-bot" -Password $pw -RunLevel Limited -Description "5분마다 origin/production 을 확인해 봇을 갱신·감시한다"

# 컷오버 전에는 업데이터를 꺼 둔다 — 켜 두면 첫 회차의 감시자 역할이 "프로세스가 없다"며 봇을 띄워 Railway 봇과 충돌한다.
Disable-ScheduledTask -TaskName "asahi-bot-update"
Clear-History
```

- `-ExecutionTimeLimit ([TimeSpan]::Zero)` 가 중요하다 — 기본값(3일)이면 작업 스케줄러가 72시간마다 봇을 죽인다.
  워커 작업(`asahi-worker`)도 같은 설정인지 확인한다: `(Get-ScheduledTask asahi-worker).Settings.ExecutionTimeLimit` 이
  `PT0S` 여야 한다(아니면 GUI 에서 "작업이 다음 시간 이상 실행되면 중지" 를 끈다).
- `-RepetitionDuration` 은 주지 않는다 — 윈도우 11 은 "무기한" 값을 범위 초과로 거부한다(`0x80041318`, 2026-08-01
  미니PC 실측). 반복 기간을 생략하면 무기한이다.
- 작업 `asahi-bot` 은 부팅 시 트리거만 있고 재시작 정책은 걸지 않는다 — 그 정책은 "시작에" 실패한 경우만 다루고, 도는
  중 어떤 코드로 끝나든 스케줄러는 완료로 본다(`deploy/worker-셋업.md` "자동 갱신" 절의 2026-08-01 실측). 죽은 봇을
  살리는 것은 업데이터의 감시자 역할이다.
- 등록 뒤 `Start-ScheduledTask asahi-bot` 을 **아직 부르지 않는다**(Railway 봇이 돌고 있다).
- 첫 시작 때 `Get-ScheduledTaskInfo asahi-bot` 의 `LastTaskResult` 가 `0x80070569`(요청한 로그온 유형이 허용되지
  않음)이면 A 에 "배치 작업으로 로그온" 권한이 없는 것이다 — 보통은 암호와 함께 등록하면 자동으로 부여된다. 안 됐으면
  작업 스케줄러 GUI(`taskschd.msc`)에서 `asahi-bot` 속성 → "사용자가 로그온할 때만 실행" 을 고른 뒤 다시 "로그온 여부에
  관계없이 실행" 으로 저장하면 부여된다.

## 5. 컷오버

한 번에 20분쯤 걸린다. 순서를 지킨다 — **봇 토큰은 하나라 두 봇이 동시에 떠 있으면 게이트웨이 세션이 충돌한다.**

1. **Railway 봇을 내린다.** Railway → `asahi` 서비스 → Deployments → 현재 배포의 ⋮ → **Remove**(배포만 지운다 —
   서비스·Variables 는 남아 롤백에 쓴다). 디스코드에서 아사히가 오프라인이 되는 것을 확인한다.
2. **A 의 봇을 띄운다.** 관리자(또는 asahi-bot) 창에서:
   ```powershell
   Start-ScheduledTask -TaskName asahi-bot
   Get-Content C:\Users\asahi-bot\asahi-bot\logs\bot.log -Tail 30 -Wait
   ```
   `워커 허브 대기 중: 포트 3000 (바인드 127.0.0.1)` → `[discord] 로그인 완료: …` → `상주 비서가 시작되었습니다.` 세 줄이
   나와야 한다. `환경변수 누락: …` 이면 3절의 `.env`, `ECONNREFUSED`/`ENETUNREACH` 면 `DATABASE_URL`(Session pooler 인가),
   `(바인드 127.0.0.1)` 이 안 보이면 `HUB_BIND` 를 본다. 디스코드에서 아사히가 온라인이 되고 소유자 DM 에 한 마디가
   답이 오면 봇 이사는 끝이다 — 아직 워커는 옛 주소(Railway)를 보고 있다.
3. **워커를 새 허브로 돌린다.** `asahi` 창에서 `C:\asahi-worker\.env` 의 한 줄을 바꾼다:
   ```
   HUB_URL=ws://127.0.0.1:3000/worker
   ```
   워커는 `.env` 를 기동 시 한 번만 읽으므로 재시작해야 한다. 표준 계정은 `Stop-ScheduledTask` 권한이 없으니 센티넬로
   내린다 — **만들고, 프로세스가 사라진 것을 확인하고, 지우고, 띄운다**(지우지 않으면 재시작된 워커가 15초 안에 같은
   파일을 보고 또 나간다):
   ```powershell
   New-Item -ItemType File C:\asahi-worker\update.flag -Force | Out-Null
   while (@(Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -like "*C:\asahi-worker*" }).Count -gt 0) { Start-Sleep 5 }
   Remove-Item C:\asahi-worker\update.flag
   Start-ScheduledTask -TaskName asahi-worker
   ```
   워커 로그(`C:\asahi-worker\logs\worker.log`)에 `로컬 워커가 시작되었습니다 (허브=ws://127.0.0.1:3000/worker, …)` →
   `[worker] 준비됨` 이 찍혀야 한다. 봇 로그에는 새 연결이 인증됐다는 허브 줄이 뒤따른다.
4. **디스코드에서 확인한다.** 소유자 계정으로 서버 채널에서 `runtime_info` 를 부르면 `배포 대상: local`, `봇 커밋:
   <7자> (production)`, 워커 커밋, 그리고 `※ 봇과 워커 커밋이 같아요.` 가 나와야 한다(다르면 한쪽 클론이 아직 옛
   커밋이다 — 5분 뒤 다시 본다). 이어서 파일 하나를 읽게 하고(`fs_read`), 작은 파일을 보내 달라고 한다(`send_file` —
   이제 `/files` 도 루프백이다).
5. **업데이터를 켠다.** 관리자 창에서 `Enable-ScheduledTask -TaskName asahi-bot-update`. 2분 뒤 첫 회차가 돌고
   `Get-ScheduledTaskInfo asahi-bot-update` 의 `LastTaskResult` 가 `0` 이면 정상이다(새 커밋이 없으면 로그
   `update-bot.log` 는 비어 있다 — 조용히 정상).
6. **스모크.** `deploy/smoke-test.md` 의 "미니PC 단일 호스트" 절 항목을 훑는다. 특히 **다른 PC 에서 미니PC 의 3000
   포트가 닿지 않는 것**(`Test-NetConnection <미니PC IP> -Port 3000` 이 `TcpTestSucceeded : False`)을 꼭 본다.

Railway 서비스는 **지우지 않고 배포만 없는 상태로 둔다** — 롤백 수단이다. 5단계(부원 개방·자원 관리)가 끝난 뒤
Railway 를 정리한다(설계 §11).

## 6. 롤백(문제가 생겼을 때 — 역순)

1. `Disable-ScheduledTask asahi-bot-update` (관리자 창) — 안 그러면 봇을 내려도 5분 뒤 다시 띄운다.
2. `Stop-ScheduledTask asahi-bot` (관리자 창) — 봇 프로세스가 사라졌는지 `Get-Process node` 로 본다(워커의 node 는
   남아 있어야 한다 — 커맨드라인에 `C:\asahi-worker` 가 든 것).
3. Railway → `asahi` 서비스 → Deployments → 마지막 배포의 ⋮ → **Redeploy**. 디스코드에서 온라인 확인.
4. B 의 `.env` 를 `HUB_URL=wss://<앱>.up.railway.app/worker` 로 되돌리고 5절 3항의 절차로 워커를 재시작한다.

A 의 클론·`.env`·작업 정의는 그대로 둔다 — 다음 시도에 다시 쓴다.

## 7. 운영 — 이사 뒤 달라지는 것

- **갱신**: `production` 에 병합되면 두 업데이터가 각자 5분 안에 갱신한다. 봇은 센티넬을 보면 **진행 중인 턴을 끝내고**
  내려가므로(`index.ts` 의 `shutdown` — drain), 사람이 답을 기다리는 도중 봇이 죽지 않는다. 로그는
  `C:\Users\asahi-bot\asahi-bot\update-bot.log`(봇)·`C:\asahi-worker\update-worker.log`(워커) — 아무 일 없는 회차는 한
  줄도 남기지 않는다. `runtime_info` 의 `※ 봇과 워커 커밋이 달라요` 가 10분 넘게 계속되면 어느 한쪽 로그에 `실패:` 줄이
  있다.
- **재부팅**: 두 계정의 작업이 부팅 시 각자 뜬다(로그인 불필요). 봇이 네트워크보다 먼저 떠 로그인에 실패하면
  종료 코드 1 로 나가고 업데이터의 다음 회차(≤5분)가 살린다.
- **로그 회전 없음**: `logs\bot.log` 는 계속 자란다(워커의 `worker.log` 와 같다). 가끔 비운다 — 봇을 내린 상태에서.
- **소유자 DM 의 PC 작업**: 소유자 DM 은 여전히 "그 소유자의 개인 워커"로 라우팅되는데, 개인 PC 워커는 루프백 허브에
  붙을 수 없다 — 그래서 소유자 DM 에서는 PC 작업이 안 되고 **서버 채널에서** 공유 워커(관리자 스코프)로 한다. 소유자
  DM 을 공유 워커의 관리자 스코프로 보내는 변경(설계 §6)은 5단계의 몫이다.
- **`/health`·`/files`·`/worker`** 는 전부 `127.0.0.1:3000` 에만 있다. 밖에서 확인할 길이 없는 것이 정상이다.
- **Railway 의 `RAILWAY_GIT_*` 변수는 이제 없다** — `runtime_info` 의 봇 커밋은 A 클론의 `git rev-parse HEAD` 다.

## 8. 보안 체크리스트(설계 §9)

컷오버 뒤 한 번, 그리고 부원을 새로 들일 때마다 훑는다.

- [ ] `asahi-bot`·`asahi` 둘 다 `Users` 그룹의 표준 계정이다(`Get-LocalGroupMember Administrators` 에 없다).
- [ ] 관리자 계정은 별도이고 일상 작업에 쓰지 않는다. 그 암호를 부원이 모른다.
- [ ] `asahi` 창에서 `Get-Content C:\Users\asahi-bot\asahi-bot\.env` 가 액세스 거부다(3절).
- [ ] `C:\asahi-worker\.env` 에 `WORKER_ID`·`WORKER_TOKEN`·`HUB_URL`·`WORKER_ROOTS`·`WORKER_SENTINEL` 외의 비밀이 없다 —
  `DATABASE_URL`·`CLAUDE_CODE_OAUTH_TOKEN`·`GITHUB_*`·`DISCORD_TOKEN` 이 있으면 안 된다.
- [ ] B 에 깃허브 로그인·SSH 키·브라우저 저장 암호가 없다(`gh auth status` 가 로그인 없음).
- [ ] `HUB_BIND=127.0.0.1` 이고 다른 PC 에서 3000 포트가 닿지 않는다.
- [ ] 윈도우 방화벽이 켜져 있고 인바운드 규칙에 node.exe 허용을 **추가하지 않았다**(루프백에는 규칙이 필요 없다 —
  Windows 가 "허용하시겠습니까" 창을 띄우면 취소한다).
- [ ] Windows Update 자동, BitLocker(장치 암호화) 켜짐 — 기계를 들고 나가면 `.env` 가 같이 나간다.
- [ ] 미니PC 가 절전에 들어가지 않는다(전원 옵션 — 워커 때와 같다).
- [ ] 작업 토큰(`/files`)은 A 프로세스 메모리의 부팅마다 난수 비밀로 서명되고 2시간이면 죽는다 — 별도 조치 없음.
  2단계에서 이 토큰이 세션의 `ANTHROPIC_AUTH_TOKEN` 이 될 때 위협 표(§9)를 다시 본다.
