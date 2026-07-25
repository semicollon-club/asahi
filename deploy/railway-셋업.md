# Railway로 Asahi 상시 구동하기

로컬 PC(PM2) 대신 Railway(클라우드)에서 봇을 24/7 띄우는 절차. 코드는 GitHub(`wwoosshh/asahi`)
리포를 그대로 쓰고, `agent/Dockerfile`(멀티스테이지)로 빌드한다. 실제 데이터(유저·대화·기억)는
Supabase Postgres에 있으므로 컨테이너 자체는 상태를 갖지 않는다(stateless) — 재배포돼도 데이터가
사라지지 않는다.

## 사전 확인 사항

- `agent/Dockerfile`, `agent/.dockerignore` 가 이미 리포에 있다(이 문서와 같은 커밋).
- Supabase 프로젝트가 준비돼 있고 **Session pooler** 연결 문자열을 발급받을 수 있어야 한다
  (아래 "DATABASE_URL" 항목 참고 — Direct connection 은 쓰지 않는다).
- `claude setup-token` 으로 발급한 구독 OAuth 토큰(`CLAUDE_CODE_OAUTH_TOKEN`)이 있어야 한다.

## 1. Railway 프로젝트 생성 + GitHub 연동

1. [railway.com](https://railway.com) 로그인 → **New Project** → **Deploy from GitHub repo** →
   `wwoosshh/asahi` 리포 선택(최초 1회 GitHub App 권한 승인 필요).
2. 리포가 모노레포(루트에 `agent/`, `data/`, `deploy/`, `docs/` 등이 같이 있음)이므로, 서비스가
   `agent/` 아래 코드만 보고 빌드하도록 **Root Directory** 를 지정해야 한다.
3. 생성된 서비스 카드 클릭 → **Settings** 탭 → **Source** 섹션의 **Root Directory** 에 `agent`
   입력 → 저장.
   - 이렇게 하면 빌드 컨텍스트가 `agent/` 가 되고, Railway 는 그 안에서 `Dockerfile` 을
     자동으로 찾아 쓴다(파일명이 정확히 `Dockerfile` 이어야 함 — 이미 그렇게 되어 있음).
     별도로 Dockerfile 경로를 지정할 필요가 없다.
   - **대안(Root Directory 를 안 쓰고 싶은 경우)**: Root Directory 를 비워 리포 루트로 두고,
     서비스 **Variables** 에 `RAILWAY_DOCKERFILE_PATH=agent/Dockerfile` 를 추가하는 방법도
     있다. 다만 이 경우 빌드 컨텍스트가 리포 루트가 되므로 `agent/Dockerfile` 안의 `COPY` 경로를
     전부 `agent/` 접두사를 붙이게 바꿔야 한다(현재 Dockerfile 은 컨텍스트=`agent/` 전제로
     작성됨). 특별한 이유가 없으면 **Root Directory=agent 방식을 권장**한다.
4. Builder 는 Dockerfile 이 있으면 Railway 가 자동으로 Dockerfile 빌더를 쓴다(Nixpacks 로
   바뀌어 있으면 Settings → Build → Builder 를 Dockerfile 로 바꾼다).

## 2. 환경변수(Variables) 설정

서비스 → **Variables** 탭에서 아래를 추가한다(`.env` 파일은 이미지에 넣지 않으므로 전부 여기서
직접 입력).

| 변수 | 필수 | 설명 |
|---|---|---|
| `DISCORD_TOKEN` | 예 | 디스코드 봇 토큰 (Discord Developer Portal → Bot). **로컬 PM2 봇과 같은 토큰을 그대로 쓴다면 반드시 로컬을 먼저 멈춰야 한다** — 아래 "봇은 한 번에 한 곳만" 참고. |
| `DISCORD_OWNER_ID` | 예 | 소유자(본인) 디스코드 사용자 ID |
| `DATABASE_URL` | 예 | Supabase **Session pooler** 연결 문자열. 아래 별도 설명 참고 |
| `CLAUDE_CODE_OAUTH_TOKEN` | 예(사실상) | `claude setup-token` 으로 발급한 구독 OAuth 토큰. 없으면 에이전트 SDK 가 인증 못 해 턴 처리가 실패한다 |
| `DEPLOY_TARGET` | 예 | 반드시 `cloud` 로 설정. local(기본값)로 두면 안 됨 — 아래 "cloud 배포 시 동작 차이" 참고 |
| `WORKER_TOKEN` | 예 | 워커 인증 토큰. 최소 20자, 무작위 문자열(예: `openssl rand -hex 32`) — 없거나 짧으면 봇이 시작 자체를 거부한다. 로컬 워커를 띄울 때(`deploy/worker-셋업.md`) 정확히 같은 값을 써야 한다 |
| `PORT` | 아니오(설정 금지) | 워커가 붙을 HTTP/WebSocket 포트. Railway 가 자동으로 주입하므로 직접 설정하지 않는다 |
| `DISCORD_CHANNEL_ID` | 선택 | DM 외에 반응할 서버 채널 ID |
| `DATA_DIR`, `MEMORY_DIR` | 아니오(설정 금지) | Dockerfile 이 이미 `/data/store`, `/data/memory` 로 고정해 둔다. 굳이 다시 지정할 필요 없음 — 지정하면 그 값으로 덮어써지므로 컨테이너 안 실제 존재하는 절대경로가 아니면 오히려 문제가 될 수 있다 |
| `SESSION_IDLE_MINUTES`, `MAX_TURNS_PER_HOUR_PER_USER`, `MAX_TURNS_PER_HOUR_GLOBAL` 등 | 선택 | 비워두면 기본값(각각 30분/20/40). 필요할 때만 조정 |

### DATABASE_URL — 반드시 Session pooler를 쓴다

Supabase 대시보드 → **Project Settings → Database → Connection string** 에서 두 가지가 보인다:

- **Direct connection**(`db.<project-ref>.supabase.co:5432`) — **쓰지 않는다**. IPv6 전용이라
  Railway 컨테이너(IPv4 egress)에서 연결이 실패한다.
- **Session pooler**(`aws-0-<region>.pooler.supabase.com:5432`, 사용자명이
  `postgres.<project-ref>` 형태) — **이걸 쓴다**. IPv4 로 붙을 수 있고, `pg` 라이브러리의
  `Pool` 과도 호환된다(트랜잭션 풀러가 아니라 세션 풀러라 `pg_advisory_xact_lock` 등 세션 상태가
  필요한 쿼리도 문제없다).

`DATABASE_URL` 값 형태 예시(실제 값은 Supabase 에서 복사):
```
postgresql://postgres.<project-ref>:<password>@aws-0-<region>.pooler.supabase.com:5432/postgres
```

## 3. 봇은 한 번에 한 곳만 — 반드시 지킬 것

디스코드 봇 토큰은 하나뿐이다. **로컬 PM2 봇과 Railway 봇을 동시에 실행하면 게이트웨이 세션이
충돌**한다(다른-PC-셋업.md 와 같은 제약). Railway 로 옮기기 전에 로컬을 반드시 멈춘다:

```powershell
pm2 stop asahi-assistant
```

그다음 Railway 배포를 진행한다. 되돌리고 싶으면 반대로 Railway 서비스를 멈추고(Settings →
Danger/Remove 또는 배포 일시중지) 로컬에서 `pm2 restart asahi-assistant`.

## 4. 배포 및 확인

- Root Directory·Variables 저장 후 Railway 가 자동으로 첫 빌드/배포를 시작한다(또는 **Deploy**
  버튼으로 수동 트리거).
- 서비스 → **Deployments** → 최신 배포 → **View Logs** 에서 다음을 확인:
  - 빌드 로그: `npm ci`, `npm run build`(tsc) 성공, 이미지 생성 완료.
  - 런타임 로그: `"[discord] 로그인 완료"`(또는 동일한 취지의 로그인 성공 메시지)와
    `"상주 비서가 시작되었습니다."` 가 찍히면 정상.
  - 만약 `환경변수 누락: ...` 에러가 보이면 Variables 탭 재확인, `ECONNREFUSED`/`ENETUNREACH`
    류 DB 연결 에러가 보이면 `DATABASE_URL` 이 Session pooler 형식인지, 비밀번호에 특수문자가
    URL 인코딩됐는지 확인한다.
- 재배포는 그냥 `git push`(main 브랜치 기준) — Railway 가 웹훅으로 감지해 자동 재빌드한다.
  수동으로 다시 배포하려면 Deployments 탭에서 **Redeploy**.

## cloud 배포 시 동작 차이(중요)

`DEPLOY_TARGET=cloud` 로 실행해도, 파일/셸 도구 자체가 `deployTarget` 으로 갈리지 않는다 —
SDK 내장 파일/Bash 도구는 로컬이든 cloud 든 이제 항상 닫혀 있고, 대신 그 사용자의 **워커가
연결돼 있는가**가 파일/셸 작업(원격 도구 `fs_*`/`sh_exec`) 가능 여부를 결정한다
(`docs/security/capability-model.md` 참고, `docs/decisions/0006-thin-worker.md`). 즉
**cloud 로 띄웠어도 소유자의 로컬 워커가 연결돼 있으면 PC 작업이 그대로 가능하다** — 이전
버전(2026-07 이전)에서는 `deployTarget=cloud` 자체가 PC 도구를 무조건 막았지만, 지금은 그
축이 아니다.

`allow_dir`/`revoke_dir`/`list_dirs`(허용 폴더 관리 도구)도 `fs_*`/`sh_exec` 와 똑같이 워커
연결 여부로만 결정된다 — `DEPLOY_TARGET` 값은 이제 이 세 도구의 노출 여부에도 영향을 주지
않는다. 즉 cloud 로 띄운 뒤 워커를 연결하면, 아래 안내대로 `allow_dir` 로 폴더를 허용하는
절차가 그대로 동작한다(이전 버전은 cloud 에서 이 세 도구가 영원히 노출되지 않아, 이 안내
자체가 cloud 배포에서는 실행 불가능했다).

워커가 연결돼 있지 않은 상태에서 소유자가 PC 작업을 요청하면, 봇은 "지금은 워커가 연결돼
있지 않아 PC 작업을 할 수 없어요." 계열 안내로 대체한다. 대화, 기억(메모리), 사용량 한도 등
나머지 기능은 워커 연결 여부와 무관하게 동일하게 동작한다.

PC 작업이 필요하면 `agent/src/worker.ts`(로컬 워커)를 자기 PC 에서 띄워 연동한다 —
[deploy/worker-셋업.md](worker-셋업.md) 참고. **워커는 현재 소유자 전용 정책이다.** 워커의
유일한 자격증명은 `WORKER_TOKEN` 이며(더 이상 `DATABASE_URL` 을 공유하지 않는다), 이 토큰이
유출되면 그 값을 아는 사람이 소유자의 워커인 척 접속해 그 워커의 `WORKER_ROOTS` 안 파일
작업(및 `sh_exec` 로는 그 프로세스의 OS 권한이 닿는 범위)을 가로챌 수 있다 — 단, Postgres나
소유자의 Claude 구독에는 접근하지 못한다. 손님 DM은 워커가 연결돼 있어도 원격 도구 자체가
노출되지 않도록 정책으로 고정돼 있다(`shouldConnectWorker`가 `isOwner && isPrivate` 를
요구). 손님용 워커(사용자별 토큰·행 단위 권한)를 지원하려면 별도 인증 인프라가 먼저
필요하며, 아직 구현되지 않았다 — 자세한 위협·완화 서술은
[docs/security/risk-register.md](../docs/security/risk-register.md) 참고.

## 컨테이너 경로 설계 메모 (참고용)

`agent/src/index.ts`, `agent/src/config.ts` 는 원래 로컬 PM2 운영 전제(cwd=`agent/`, 리포
루트가 그 부모)로 `path.resolve("..", "data", ...)` 같은 상대경로를 쓴다. 컨테이너에는 그 리포
루트 형제 디렉터리가 없으므로, `agent/Dockerfile` 이 `DATA_DIR=/data/store`,
`MEMORY_DIR=/data/memory` 를 이미지 레벨 ENV 로 고정해 그 상대참조를 절대경로로 대체한다(소스
수정 없음). `agentCwd`(에이전트 작업용 임시 디렉터리)도 `DATA_DIR` 기준으로 파생되므로 함께
해결된다. `/data` 자체에 영속 볼륨을 붙일 필요는 없다 — 실제 상태는 전부 Supabase 에 있고,
`/data` 는 재배포 시 사라져도 되는 임시 공간이다.
