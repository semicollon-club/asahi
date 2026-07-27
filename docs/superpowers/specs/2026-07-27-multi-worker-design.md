---
title: 다중 워커 — 워커 신원·라우팅·사용자 격리 (1단계)
date: 2026-07-27
status: Approved
audience: 소유자(정본)
supersedes: —
supersededBy: —
---

# 다중 워커 — 워커 신원·라우팅·사용자 격리 (1단계)

## 1. 배경 · 목표

아사히는 세미콜론 동아리의 마스코트 에이전트이고, 동아리 프로젝트에 접근할 수 있어야 한다.
그런데 지금은 **공개 서버에서 PC 도구가 하나도 열리지 않는다.** 동아리 공용 미니PC를 사 두고
워커를 띄워도 달라지는 게 없다 — 다음 두 곳이 소유자 전용으로 막고 있기 때문이다.

- `WorkerHub.handleConnection` (`agent/src/remote/hub.ts`): `frame.userId === ownerId` 가 아니면
  거부한다. 소유자 아닌 워커는 애초에 붙지 못한다.
- `shouldConnectWorker` (`agent/src/core/agent.ts`): `isOwner && isPrivate` 여야 참이다. 공개
  서버 턴은 워커 연결 여부와 무관하게 원격 도구를 받지 못한다.

여기에 토큰이 `WORKER_TOKEN` 하나뿐이라, 워커가 둘 이상이면 서로를 사칭할 수 있다. 미니PC의
토큰이 새면 그 토큰으로 소유자 워커인 척 붙을 수 있다.

**이 문서의 범위(1단계)** — 워커에 고유한 신원과 토큰을 주고, 대화 위치와 신원으로 어느 기계를
쓸지 정하고, 공유 기계 안에서 사용자별로 폴더를 격리한다.

**범위 밖(2단계)** — 프로젝트 폴더와 스레드 바인딩. §8 참고.

## 2. 결정된 라우팅

| 누가 | 어디서 | 어느 기계 | 범위 |
|---|---|---|---|
| 소유자 | DM | 본인 로컬 PC (`personal` 워커) | `allowed_dirs` 그대로 |
| 소유자 | 공개 서버 | 미니PC (`shared` 워커) | 루트 **전체** (관리자) |
| 손님 | DM · 공개 서버 | 미니PC (`shared` 워커) | **본인 폴더만** |

규칙은 한 줄로 요약된다 — **"어디서 말하느냐가 어느 기계냐를 정한다."** 유일한 예외는 손님으로,
개인 워커가 없으므로 어디서든 공유 기계로 간다.

### 2.1 손님 개인 워커를 열지 않는 이유

검토 중 "동아리원도 자기 PC에 워커를 띄운다"를 후보로 놓았다가 접었다. 그렇게 하면 **소유자의
Claude 구독으로 돌아가는 작업이 소유자가 볼 수 없는 기계에서 벌어진다.** 턴 수는 세어지지만
무엇을 했는지 추적할 방법이 없고, "워커가 없으면 PC 작업이 안 된다"는 자연스러운 마찰도 사라진다.
공유 기계 한 대로 모으면 무슨 일이 있었는지가 한 곳에 남는다.

## 3. 워커 신원과 등록

### 3.1 `workers` 테이블

| 컬럼 | 타입 | 설명 |
|---|---|---|
| `id` | TEXT PK | 사람이 정하는 식별자 (`owner-laptop`, `semicolon-shared`) |
| `kind` | TEXT | `personal` \| `shared` |
| `user_id` | TEXT NULL | `personal` 이면 담당 사용자, `shared` 면 NULL |
| `token_hash` | TEXT | `sha256(token)`. 평문은 저장하지 않는다 |
| `label` | TEXT NULL | 사람이 읽는 이름 ("동아리 미니PC") |
| `created_ts` | BIGINT | 등록 시각 |
| `last_seen_ts` | BIGINT NULL | 마지막 인증 성공 시각 |

`id` 를 랜덤이 아니라 사람이 정하는 문자열로 두는 이유는 로그다. `[hub] semicolon-shared 연결됨`
이 `[hub] w_8f3a2b 연결됨` 보다 압도적으로 읽기 쉽다.

1단계에서 실제로 존재하는 행은 둘이다 — 소유자 노트북(`personal`)과 미니PC(`shared`). 그래도
`kind`/`user_id` 를 두는 것은, 나중에 소유자가 데스크톱을 추가하거나 공유 기계가 늘어날 때
스키마를 다시 건드리지 않기 위해서다.

### 3.2 `hello` 프레임 변경

```
이전: { type: "hello", token, userId, roots }
이후: { type: "hello", token, workerId, roots }
```

"나는 누구의 워커다" 에서 "나는 어느 워커다" 로 바뀌는 것이 이번 변경의 핵심이다. 허브는
`workerId` 로 행을 찾아 `token_hash` 를 대조하고, `conns` 를 `userId` 가 아닌 `workerId` 로 키잉한다.

거부 사유 문구는 지금처럼 **단일 문구를 유지한다**. "그런 워커 없음" 과 "토큰 틀림" 을 구분해
돌려주면, 인증되지 않은 클라이언트가 유효한 `workerId` 를 캐낼 수 있는 오라클이 된다
(기존 FIX5 와 같은 이유).

토큰 비교는 지금처럼 `timingSafeEqual` 상수 시간 비교를 쓴다. 대조 대상이 평문에서 해시로
바뀔 뿐이다.

### 3.3 비동기 인증 — 구현 위험

지금 `socket.onMessage` 는 완전히 동기다. `workerId` 조회가 DB 왕복이 되면 hello 처리가
비동기가 되고, **조회가 진행 중인 사이에 워커가 보낸 후속 프레임**을 어떻게 다룰지 정해야 한다.
얼버무리면 인증 우회가 생긴다.

연결의 인증 상태를 세 가지로 명시한다.

- `unauth` — hello 를 아직 못 받음. hello 외 프레임은 즉시 연결 종료(현행과 동일)
- `authenticating` — hello 를 받아 조회 중. **모든 프레임에 대해 즉시 연결 종료**
- `authed` — 인증 완료. 정상 처리

`hello` 를 두 번 보내는 경우도 `authenticating`/`authed` 상태에서 종료로 처리한다.
hello-타임아웃(10초)은 `unauth`+`authenticating` 두 상태를 함께 덮는다.

### 3.4 등록 스크립트

`agent/scripts/register-worker.mjs` — `sync-images.mjs` 와 같은 자리·같은 방식이다.

```
node scripts/register-worker.mjs --id semicolon-shared --kind shared --label "동아리 미니PC"
node scripts/register-worker.mjs --id owner-laptop --kind personal --user <디스코드 id>
```

토큰을 생성해 **stdout 에 한 번만** 출력하고 DB 에는 해시만 넣는다. 같은 `id` 로 다시 실행하면
토큰이 재발급되고 이전 토큰은 그 즉시 무효가 된다(회전·폐기 경로).

재발급이 **이미 붙어 있는 연결을 끊지는 않는다.** 스크립트는 DB 만 건드리고 허브는 인증 시점에만
해시를 본다. 옛 토큰으로 붙어 있던 워커는 다음 재연결에서 거부된다. 즉시 끊어야 하는 상황
(토큰 유출)이라면 봇을 재시작하는 것이 확실한 방법이고, 그 사실을 스크립트 출력에 적는다.

디스코드 명령으로 만들지 않는다 — 토큰이 채팅 기록에 영구히 남는다.

## 4. 라우팅 구현

### 4.1 컨텍스트 → 워커 해석

`shouldConnectWorker` 를 대체한다. 순수 함수로 떼어 소켓·DB 없이 검증한다.

```
resolveWorkerId(ctx, registry) -> string | null
  ctx.isOwner && ctx.isPrivate  → registry.personalWorkerOf(ctx.userId)
  그 외                          → registry.sharedWorkerId()
```

그 뒤 `workerConnected = workerId !== null && hub.isConnected(workerId)`.

기존 `resolveWorkerConnected` 의 `noRemoteTools` 합성은 그대로 얹힌다 — 유휴 요약 턴은 이 값과
무관하게 무조건 워커를 붙이지 않는다(FIX4 유지).

### 4.2 도구 계층

`allowedToolsFor` 의 "공개 서버" 분기가 `workerConnected` 를 보게 된다. 지금은 그 값과 무관하게
원격 도구를 절대 포함하지 않는데, 이 조건이 사라진다.

손님 DM 분기도 마찬가지로 `workerConnected`(=공유 워커 연결 여부) 를 본다.

`remoteToolHandler` 의 독립 재확인(`isOwnerDm`)도 같이 바뀐다 — "소유자 DM 인가" 가 아니라
"이 컨텍스트에 해석된 워커가 있고 그 워커가 연결돼 있는가" 가 판정 기준이 된다. 도구 목록과
핸들러가 서로 다른 기준을 쓰면 "도구는 보이는데 실행은 거부"(또는 그 반대)가 생기므로, 4.1 의
순수 함수 하나를 양쪽이 함께 쓴다.

### 4.3 폴더 관리 도구

`allow_dir` 계열은 **소유자 전용을 유지**하되, 대상 워커는 현재 위치가 정한다. 소유자가 서버에서
부르면 공유 워커의 목록을, DM 에서 부르면 자기 개인 워커의 목록을 건드린다. 손님은 폴더를 바꿀 수
없다.

## 5. 경로 게이팅

두 겹 구조는 그대로다. 봇 쪽 1차 필터의 계산만 바뀌고, 워커 쪽 `checkPath`(`WORKER_ROOTS` 기준
최종 관문)는 손대지 않는다.

```
scopeFor(ctx, worker) -> string[]
  personal              → allowed_dirs(worker.id)
  shared + 소유자        → allowed_dirs(worker.id)                       // 루트 전체
  shared + 손님          → allowed_dirs(worker.id).map(d => join(d, userId))
```

`join` 은 문자열 연결이 아니라 **워커 플랫폼의 경로 결합**이어야 한다. 미니PC 는 윈도우라 루트가
`C:\workspace` 형태이고, `d + "/" + userId` 로 이으면 `C:\workspace/123` 같은 혼합 구분자가 나온다.
워커의 `checkPath` 는 realpath 정규화를 거치므로 대개 통과하겠지만, 봇 쪽 1차 필터의 접두사 비교가
구분자 차이로 어긋나면 **정상 경로가 거부되거나 그 반대가 된다.** 봇은 워커의 플랫폼을 모르므로,
`hello` 프레임이 이미 실어 보내는 `roots` 의 형태(드라이브 문자·역슬래시 유무)로 판정한다.

### 5.1 사용자 폴더 이름은 디스코드 숫자 userId

표시명은 바뀌고, 겹치고, 경로에 쓸 수 없는 문자가 들어온다. 숫자 id 는 불변이고 경로 주입 위험이
원천적으로 없다. 탐색기로 직접 보면 숫자 폴더라 불편한데, 봇이 목록을 보여줄 때 표시명을 붙이는
것으로 갚는다.

미니PC 워크스페이스 배치:

```
<WORKER_ROOTS 의 워크스페이스 루트>/
  <디스코드 userId>/          ← 1인당 하나. 첫 접근 때 자동 생성
    ...
```

### 5.2 `allowed_dirs` 키 변경 — 마이그레이션하지 않는다

`allowed_dirs` 의 키가 `user_id` 에서 `worker_id` 로 바뀐다. 지금 이 테이블에 든 것은 소유자
폴더 몇 개뿐이므로, 백필 코드를 쓰고 그 코드를 검증하는 것보다 워커 등록 후 `allow_dir` 로 다시
넣는 것이 싸고 확실하다. 배포 절차(`deploy/worker-셋업.md`)에 한 줄로 적는다.

## 6. 보안 — 위협 모델이 바뀐다

이것은 의도된 변경이며, 문서가 이를 정확히 서술해야 한다.

`docs/security/capability-model.md` 는 "PC 도구는 소유자 DM 전용" 을 근간으로 서술돼 있다. 이
변경 이후에는 **`allowed` 역할이면 누구나 미니PC 에서 `sh_exec` 를 실행할 수 있다.** 그리고
`sh_exec` 는 경로로 봉쇄되지 않으므로(의도된 설계), 실질적 경계는 워커 프로세스의 윈도우 계정
권한 하나뿐이다.

더 중요한 것은 **프롬프트 인젝션 표면**이다. 공개 채널 내용은 신뢰할 수 없는 입력인데, 지금까지는
그 계층에 PC 도구가 아예 없다는 사실 자체가 완화책이었다. 그 완화책이 사라진다 — 채널에 붙여넣은
텍스트가 셸 명령을 유도하려 시도할 수 있는 턴이 된다.

억제 요소는 둘이다.

- `decideRoute` 가 **미등록 사용자를 아예 무시**한다. 노출 대상은 소유자가 `manage_access` 로
  명시적으로 추가한 동아리원뿐이다.
- 페르소나의 외부 콘텐츠 불신 규칙(`persona.ts` 의 `IDENTITY`). 다만 이건 프롬프트라 완전하지 않다.

그래서 이 설계는 **미니PC 의 워커 계정 분리를 선택이 아니라 요구사항으로 둔다.**

- 관리자가 아닌 **표준 윈도우 계정**으로 워커를 실행한다
- 그 계정 프로필에 SSH 키·`.env`·저장된 브라우저 자격증명을 두지 않는다
- 작업 트리는 동아리원 개인 폴더가 아닌 **별도 클론**을 쓴다
- `WORKER_ROOTS` 는 워크스페이스 루트 하나만 노출한다

## 7. 오류 처리와 테스트

### 7.1 오류

| 상황 | 동작 |
|---|---|
| 미등록 `workerId` · 토큰 불일치 | 단일 `denied` 문구, 워커는 재시도 중단(현행 유지) |
| 공유 워커 오프라인 | 그 계층 도구 목록에서 원격 도구가 아예 빠짐 + 안내 |
| 손님 폴더 미존재 | 첫 접근 때 자동 생성(§7.2) |
| `authenticating` 중 프레임 도착 | 즉시 연결 종료(§3.3) |
| 같은 `workerId` 재연결 | 이전 연결 정리(현 `dropExisting` 동작 유지) |

### 7.2 손님 폴더 자동 생성

"1인당 1폴더" 가 규칙이므로 폴더가 없다고 거부할 이유가 없다. 다만 **봇은 미니PC 의 파일시스템에
직접 손댈 수 없다** — 모든 접근은 워커를 거친다. 따라서 생성도 워커 호출이어야 한다.

`fs_write`/`sh_exec` 로 우회 생성하게 두면 모델이 매번 다른 방식으로 만들게 되고 실패 처리도
제각각이 된다. 워커 실행기에 `fs_mkdir` 하나를 추가하고, 봇이 그 사용자의 첫 원격 도구 호출 직전에
**한 번** 호출한다(이미 있으면 성공으로 취급 — `recursive: true` 와 같은 의미). 이 호출은 모델이
부르는 것이 아니라 봇이 `scopeFor` 를 계산한 직후 자동으로 끼워 넣는다.

`fs_mkdir` 도 다른 `fs_*` 와 똑같이 `checkPath` 를 거친다 — 예외 경로를 만들지 않는다.

### 7.3 반드시 빨간불이 켜져야 하는 테스트

- **손님이 `<루트>/<남의 userId>/...` 를 요청하면 거부** — 이번 설계의 핵심 불변식
- 손님이 `..` 상위 참조나 심볼릭 링크로 자기 폴더를 벗어나려는 시도 → 거부(봇·워커 양쪽)
- 소유자가 서버에서 루트 전체에 접근 → 허용
- 소유자 DM 에서 공유 워커 도구가 **목록에 아예 없음**
- 손님 DM 에서 공유 워커 도구가 열림(개인 워커 없음에도)
- 미등록 `workerId` 와 틀린 토큰이 **완전히 같은 문구**로 거부됨(오라클 방지)
- `authenticating` 상태에서 들어온 프레임이 처리되지 않음

## 8. 다음 단계 (별도 스펙)

프로젝트 폴더와 스레드 바인딩 — 이 문서의 범위 밖이다.

- 스레드를 시작할 때 프로젝트명을 필수로 요구
- 기존 프로젝트 목록을 제시하고 고르게 하는 경로
- 대화 ↔ 프로젝트 폴더 바인딩(`conversations` 에 컬럼 추가)
- 본인 폴더 안의 프로젝트 목록 조회

대화 흐름 설계가 절반을 차지하므로 1단계가 실제로 동작하는 것을 확인한 뒤 따로 다룬다.

## 9. 이 문서에서 바뀌는 파일

| 파일 | 변경 |
|---|---|
| `agent/src/store/schema.ts` | `workers` 테이블 추가, `allowed_dirs` 키 변경 |
| `agent/src/store/workersRepo.ts` | 신규 — 조회·등록·`last_seen_ts` 갱신 |
| `agent/src/store/allowedDirsRepo.ts` | `user_id` → `worker_id` |
| `agent/src/remote/protocol.ts` | `hello` 의 `userId` → `workerId` |
| `agent/src/remote/hub.ts` | 레지스트리 조회 인증, 3-상태 인증, `workerId` 키잉 |
| `agent/src/remote/executors.ts` | `fs_mkdir` 추가(§7.2). `checkPath` 를 똑같이 거친다 |
| `agent/src/remote/workerClient.ts` | `WORKER_USER_ID` → `WORKER_ID` |
| `agent/src/core/agent.ts` | `resolveWorkerId` 신규, `shouldConnectWorker` 대체 |
| `agent/src/core/tools.ts` | 계층 분기에서 `workerConnected` 반영 |
| `agent/src/core/remoteTools.ts` | `isOwnerDm` 재확인 → 워커 해석 기준으로, `scopeFor` 적용 |
| `agent/src/config.ts` | 봇 `WORKER_TOKEN` 제거, 워커 `WORKER_ID` 추가 |
| `agent/scripts/register-worker.mjs` | 신규 |
| `docs/security/capability-model.md` | §6 의 위협 모델 변경 반영 |
| `deploy/worker-셋업.md` | 등록 절차, 윈도우 표준 계정, 폴더 재등록 |
