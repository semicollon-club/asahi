---
lastReviewed: 2026-07-26
---

# 로컬 워커 셋업 (얇은 워커)

봇(Railway cloud 또는 로컬 PM2)은 대화·모델 호출·기억·세션을 전담하지만, 파일 읽기·쓰기·셸
실행 같은 PC 작업은 실행하지 않는다 — SDK 내장 파일/Bash 도구는 아예 닫혀 있다. **로컬
워커**(`agent/src/worker.ts`)는 소유자 자신의 PC에서 따로 띄우는 별도 프로세스로, 봇이
모델의 파일/셸 도구 호출 하나하나를 원격으로 요청하면 그 도구만 실행해 결과를 돌려준다
(`docs/decisions/0006-thin-worker.md`). 디스코드에도 DB에도 붙지 않고, 봇이 여는
WebSocket 허브(`/worker`)에 아웃바운드로 접속해 있는 것으로 끝이다.

**워커는 대화를 판단하지 않는다.** 어떤 대화 이력을 읽을지, 무슨 도구를 부를지는 전부 봇
쪽 모델이 정하고, 워커는 그 결과로 온 호출 하나(`fs_read`/`fs_write`/`fs_edit`/`fs_glob`/
`fs_grep`/`sh_exec`)를 실행할 뿐이다.

## 사전 요구

- **Node.js 22 이상**, 리포가 이미 클론돼 있고 `agent/` 에 `npm install` 이 끝난 상태
  (다른 PC에 새로 셋업하는 경우 [deploy/다른-PC-셋업.md](다른-PC-셋업.md) 먼저 참고).
- 봇이 이미 떠 있고(Railway 또는 로컬 PM2) `/worker` 허브에 접속할 수 있는 주소(`HUB_URL`)가
  있어야 한다. **워커는 봇과 같은 `DATABASE_URL`을 더 이상 필요로 하지 않는다** — DB
  자격증명은 봇만 갖는다.

## .env 설정

리포 루트 `.env` (`asahi\.env`)에 다음 다섯 값이 필요하다 — 하나라도 비어 있으면 워커가 시작
시점에 `환경변수 누락: ...` 에러로 즉시 종료한다(`agent/src/config.ts` `loadWorkerConfig`).

| 변수 | 설명 |
|---|---|
| `WORKER_TOKEN` | 봇과 정확히 같은 값이어야 하는 인증 토큰. 최소 20자(봇 쪽 `loadConfig`가 강제). `openssl rand -hex 32` 같은 무작위 긴 문자열을 쓴다 |
| `HUB_URL` | 봇의 `/worker` WebSocket 주소(예: `wss://<앱>.up.railway.app/worker`). 로컬 PM2 봇이면 그 봇이 여는 포트 기준 주소 |
| `DISCORD_OWNER_ID` | 소유자 본인의 디스코드 사용자 ID. 봇이 `hello` 의 `userId` 가 이 값과 일치하는지 확인한다(봇의 `DISCORD_OWNER_ID`와 같은 값이어야 한다) |
| `WORKER_USER_ID` | 이 워커가 담당하는 디스코드 사용자 ID. 1단계는 소유자 전용이라 `DISCORD_OWNER_ID`와 같은 값이어야 한다 |
| `WORKER_ROOTS` | 이 워커가 노출할 폴더(쉼표 구분, 절대경로 — 윈도우는 드라이브 문자 또는 UNC 필요). `fs_read`/`fs_write`/`fs_edit`/`fs_glob`/`fs_grep` 는 이 목록 밖 경로를 전부 거부한다 |

**`DATABASE_URL`은 이 파일에 없다 — 의도적으로 없다.** 워커는 DB 자격증명도 Claude 구독
자격증명(`CLAUDE_CODE_OAUTH_TOKEN`)도 갖지 않는다. 워커가 가진 유일한 비밀은
`WORKER_TOKEN`이다.

**`sh_exec`(셸 명령 실행)는 `WORKER_ROOTS` 로 봉쇄되지 않는다.** 셸은 경로 인자 하나로 판정할
수 있는 대상이 아니다 — 실행 시 작업 디렉토리(`WORKER_ROOTS`의 첫 번째 폴더)와, 이 워커
프로세스를 돌리는 OS 계정의 권한이 유일한 경계다. 그 계정이 닿는 곳이라면 셸 명령은
`WORKER_ROOTS` 밖도 오갈 수 있다는 뜻이다 — 워커를 최소 권한 계정으로 돌리는 것을 권장한다.

## 실행

```powershell
cd agent
npm run build
npx tsx src/worker.ts
```

- `npm run worker`로 빌드 없이(개발 중) 바로 실행하거나, `npm run build` 후 `npm run worker:start`
  (또는 `node dist/worker.js`)로 빌드된 산출물을 실행할 수 있다. `npx tsx src/worker.ts`로 직접
  실행해도 동일하게 동작한다.
- PM2로 상시구동할 때는 `asahi-worker` 앱으로 실행한다(`deploy/ecosystem.config.cjs`,
  `deploy/PM2-명령어.md` 참고).

## 검증

1. 워커 콘솔에 `로컬 워커가 시작되었습니다 (허브=..., 폴더=...)`가 찍히면 프로세스 자체는
   정상 기동이다.
2. 이어서 `[worker] 연결됨 — 인증 중` → `[worker] 준비됨`이 찍히면 봇의 허브가 토큰을
   검증하고 연결을 받아들인 것이다(`agent/src/remote/workerClient.ts`). `준비됨`이 안 뜨고
   `거부됨: ...`이 뜨면 `WORKER_TOKEN`이 봇과 다르거나 `DISCORD_OWNER_ID`/`WORKER_USER_ID`가
   봇의 `DISCORD_OWNER_ID`와 다른 것이다 — 이 경우 워커는 재연결을 멈춘다(재시도해도 결과가
   같기 때문이다). `.env`를 고친 뒤 워커를 다시 띄워야 한다.
3. 소유자 본인 계정으로 봇에 1:1 DM을 보내 PC 작업(파일 읽기·Bash 실행 등)을 요청한다. 워커가
   연결돼 있으면 그 요청에 대응하는 개별 도구 호출(`fs_read` 등)이 워커로 전달되고, 결과가
   워커 PC에서 나와 디스코드로 전달된다 — 대화 자체는 항상 봇에서 실행되고, 워커는 도구
   호출만 대신할 뿐이다.
4. 워커를 내려둔 채로 같은 요청을 보내면(연결 없음), 봇은 원격 도구 자체를 도구셋에 넣지
   않고 "지금은 워커가 연결돼 있지 않아 PC 작업을 할 수 없어요." 안내로 대체한다 — 대화·기억
   등 나머지 기능은 그대로 동작한다.
5. 워커를 다시 띄우면 고정 간격(기본 3초)으로 재연결을 시도해 다시 `준비됨` 상태가 되고,
   그 뒤 요청부터 PC 작업이 다시 가능해진다.
6. `WORKER_ROOTS` 밖의 경로를 요청하면 워커의 최종 경로 관문(`agent/src/remote/roots.ts`의
   `checkPath`)이 거부한다 — 봇 쪽 `allow_dir`로 등록한 목록이 더 넓어도 워커 루트가 최종
   권한을 갖는다(`docs/security/capability-model.md` "경로 게이팅" 참고).
7. 종료는 `Ctrl+C`(SIGINT). 그 시점에 실행 중이던 도구 호출(예: 쓰기 중이던 `fs_write`)이
   끝나길 기다린 뒤 프로세스를 종료한다.

## 보안

지금 걱정해야 할 자격증명은 `DATABASE_URL`이 아니라 **`WORKER_TOKEN`**이다. 이 값이
새어나가면, 그 값을 아는 사람이 스스로 허브에 접속해 소유자의 워커인 척 인증에 성공할 수
있다(1단계는 사용자별 토큰이 아니라 고정값 하나이므로). 인증에 성공하면 그 뒤로 모델이
보내는 `fs_read`/`fs_write`/`fs_edit`/`fs_glob`/`fs_grep`/`sh_exec` 호출을 전부 가로채
실행하고 결과를 조작해 돌려줄 수 있다.

**단, 그 토큰 하나로는 Postgres(`DATABASE_URL`)에도 소유자의 Claude 구독
(`CLAUDE_CODE_OAUTH_TOKEN`)에도 접근하지 못한다** — 워커는 이 두 자격증명을 아예 갖지 않기
때문이다. 유출 시 실제로 열리는 범위는 (그 시점에 연결된) 이 워커의 `WORKER_ROOTS` 폴더
안에서의 파일 작업과, 워커 프로세스의 OS 권한이 닿는 범위의 셸 명령(`sh_exec`는
`WORKER_ROOTS`로 봉쇄되지 않는다, 위 참고)으로 한정된다.

`.env` 파일을 절대 커밋하거나 공유하지 않는다. 자세한 위협 성격과 완화책은
[docs/security/risk-register.md](../docs/security/risk-register.md) "1. `WORKER_TOKEN` 취급"
절 참고.
