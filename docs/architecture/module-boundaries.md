---
lastReviewed: 2026-08-06
---

# 모듈 경계 (Module Boundaries)

새로 합류하는 기여자가 `agent/src` 안에서 코드를 어디에 놓아야 하는지, 어떤 디렉토리가
무엇을 알아도 되는지 판단하는 기준을 정리한다. 아래 사실은 모두 코드 원문(`agent/src/**`)을
근거로 한다.

## 디렉토리 책임표

| 디렉토리/파일 | 책임 | 주요 파일 |
| --- | --- | --- |
| `adapters/` | 채널(현재는 discord.js) 실제 I/O. 들어온 이벤트를 라우팅 판단해 `user_message`로 발행하고, 코어가 발행한 `assistant_message`/`system_notice`/`progress`를 구독해 실제 전송·편집을 수행한다. `assistant_file`(파일 반환, 2026-09-05)은 그 채널에 첨부로 보내되 진행 표시(상태 메시지·⏳ 반응)는 건드리지 않는다 — 턴 도중의 부수 전송이다 | `discord.ts` |
| `core/` | 대화 오케스트레이션(직렬화·한도 판단), SDK 턴 실행, 페르소나(시스템 프롬프트), 도구 정의·원격 도구 1차 경로 필터, 이 턴이 쓸 워커 선택(개인/공유), 읽기전용 SQL 가드, 정기 게시(주제 정의·실행 판정·실행), PR 추적(폴링 간격·알림 판정·1분 타이머의 폴러 — 모델 턴을 열지 않는다), 파일 반환(작업 토큰 발급·검증과 `POST /files` 핸들러 — 8MB 상한, 받은 바이트는 디스크에 쓰지 않고 `assistant_file` 이벤트로 넘긴다; 2026-09-05). `discord.js`에 의존하지 않는다(채널 불가지론) | `core.ts`, `agent.ts`, `persona.ts`, `tools.ts`, `remoteTools.ts`, `workerSelect.ts`, `pathPermission.ts`, `paths.ts`, `sqlGuard.ts`, `turnPrep.ts`, `commands.ts`, `images.ts`, `digest.ts`, `prTracker.ts`, `staleWorker.ts`, `jobToken.ts`, `fileReturn.ts`, `sdkEvents.ts`(SDK 스트림 → 진행 이벤트 — 봇·워커 공용), `profiles.ts`(신원 → 세션 프로필), `llmProxy.ts`(인증 프록시 `/llm/v1/*` — 작업 토큰 검증·자격증명 교체·SSE 통과) |
| `events/` | 어댑터↔코어를 분리하는 얇은 pub/sub 이벤트버스. 이벤트 타입 정의의 유일한 출처 | `bus.ts` |
| `store/` | Postgres 영속 계층(레포지토리 패턴). 스키마 정의와 테이블별 CRUD/쿼리만 담당하며, 그 위 어떤 계층에도 의존하지 않는 최하위 레이어다. `allowed_dirs`는 Task 7부터 `user_id`가 아니라 `worker_id` 키다 — 폴더는 사람이 아니라 그 폴더가 실제로 존재하는 기계(워커)에 속한다는 사실에 맞췄다(마이그레이션 없음 — `deploy/worker-셋업.md` 참고) | `schema.ts`, `db.ts`, `usersRepo.ts`, `conversationsRepo.ts`, `participantsRepo.ts`, `messagesRepo.ts`, `summariesRepo.ts`, `memoriesRepo.ts`, `turnsRepo.ts`, `allowedDirsRepo.ts`, `workersRepo.ts`, `introspectRepo.ts`, `settingsRepo.ts`, `projectsRepo.ts`, `pullRequestsRepo.ts` |
| `remote/` | 봇↔워커 WebSocket 전송 계층. `protocol.ts`(양쪽 공유 계약)·`hub.ts`(봇 쪽 서버)·`workerClient.ts`/`executors.ts`/`roots.ts`(워커 쪽). `core/` 의 순수 경로 헬퍼(`pathPermission.ts`의 `resolveRealOrNearestAncestor`, `paths.ts`의 `isPathWithinAny`)만 재사용하고 `discord.js`에는 의존하지 않는다. `store/`는 원칙적으로 의존하지 않지만 한 줄 예외가 있다 — 아래 "허용 의존 방향" 참고 | `protocol.ts`, `hub.ts`, `workerClient.ts`, `executors.ts`, `roots.ts`, `sessionRunner.ts`(2단계 — `turn.start` 하나를 Agent SDK `query()` 한 턴으로; `core/sdkEvents.ts`·`core/fileReturn.ts` 의 주소 헬퍼만 재사용) |
| `github/` | 깃허브 REST 호출 계층(2026-08-07 발행에서 시작, 2026-09-05 확장). `appToken.ts`(App JWT·설치 토큰 발급·리포 생성·PR 생성·타임아웃 있는 GET 한 겹), `shellToken.ts`(`sh_exec` 의 git 이 쓰는 조직 전체 단기 토큰의 캐시 공급원), `repos.ts`(설치 저장소 목록·표시), `pulls.ts`(PR 의 리뷰·코멘트 묶어 읽기·표시). 순수 HTTP + 포맷이라 `store`·`events`·`adapters`·`discord.js` 어디에도 의존하지 않고, `core/`(도구 핸들러)와 `core/agent.ts`(셸 토큰 공급원 생성)만 이 디렉토리를 부른다. 개인키는 `config.ts` 가 읽어 `GithubAppConfig` 로 넘긴다 — 이 계층은 오류 메시지에 자격증명이 섞이지 않게 깃허브 응답의 `message` 만 뽑는다 | `appToken.ts`, `shellToken.ts`, `repos.ts`, `pulls.ts` |
| `memory/` | 에이전트 작업 디렉토리(`agentCwd`)의 파일 기반 기억 스캐폴드(`MEMORY.md` 초기화). DB 기반 기억(`store/memoriesRepo.ts`의 remember/recall)과는 별개 개념이다 | `memory.ts` |
| `config.ts`(디렉토리 아님, `src/` 최상위 파일) | 환경변수 로드·검증. 봇용 `loadConfig`/`Config`와 워커용 `loadWorkerConfig`/`WorkerConfig` 두 세트를 제공한다. 값 검증을 위해 `remote/roots.ts`의 `isUnambiguousRoot`(WORKER_ROOTS 판정)와 `core/digest.ts`의 `DigestChannels`(타입 전용)를 임포트한다 — 판정 규칙을 두 곳에 복제하지 않기 위한 의도적 의존이다. 워커용 설정은 `databaseUrl`도 `model`도 갖지 않는다 — 워커는 이제 DB도 모델도 다루지 않는다(`docs/decisions/0006-thin-worker.md`) | `config.ts` |

두 진입점(`index.ts` = 봇, `worker.ts` = 로컬 워커)은 위 디렉토리를 조립하는 컴포지션
루트다. `index.ts`는 `adapters`+`core`+`store`+`events`+`config`+`remote`(허브)를 모두
조립하지만, 워커는 `remote`(`workerClient.ts`+`executors.ts`)와 `config`만 조립하며
`store`·`events`·`adapters`에는 의존하지 않는다 — 워커는 디스코드에도 DB에도 붙지 않고,
봇이 여는 허브에 아웃바운드 WebSocket으로 접속해 개별 도구 호출만 받아 실행한다.

어시스턴트 응답은 순수 텍스트다 — `core`가 발행하는 `assistant_message`의 `text`에는 표시용
마커가 전혀 없고, `adapters/discord.ts`는 그 텍스트를 `chunkMessage`/`planSend`로 디스코드
메시지 길이 상한에 맞춰 나눠 그대로 전송할 뿐이다. 답변 텍스트에서 표정 마커(`[표정:이름]`)를
떼어내 감정 이름만 코어 밖으로 넘기고, 그 이름을 실제 이미지 URL로 바꿔 embed로 붙이던 계층
(`core/expressions.ts`↔`adapters/discord.ts`)은 표정 이미지 기능과 함께 2026-08-05에 제거됐다.

정기 게시(`core/digest.ts`의 `DigestRunner`)가 실행하는 턴은 대화 행(conversation row)에도
세션 이어붙이기(resume)에도 묶이지 않는 유일한 턴이다 — 스케줄(`checkAndRun`)이든 예약어
(`run`)든 매번 새 세션으로 실행하고, 결과만 기존 `assistant_message` 이벤트 경로를 그대로 타
목적지 채널로 나간다. 예약어 경로는 호출 지점에 따라 갈린다: 스레드·DM 안에서 부르면
`core.ts`의 `ingest`가 평소처럼 `resolveConversation`으로 그 채널의 대화 행을 조회·생성한 뒤
(손님 한도 예약에 `conv.id`를 쓴다) `startDigestCommand`를 부른다. 반면 **일반 채널에서 멘션
없이 부르면**(`commandOnly` 힌트) `ingest`는 `resolveConversation`을 아예 호출하지 않고
`conv: null`로 곧장 `startDigestCommand`를 부른다 — 손님 한도 예약도 `conversationId: null`로
이뤄진다. 이 채널이 대화로 굳어(`decideRoute`의 `hasConversation`) 이후 모든 메시지에 봇이
답하기 시작하는 것을 막는, `commandOnly` 경로의 핵심 불변식이다. `DigestRunner` 자신은 두
경우 모두 대화 행을 전혀 참조하지 않는다.

## 허용 의존 방향

기본 방향은 `adapters → core → store`다.

- `adapters`는 `core`(이미지 타입, `commands.ts`의 `isChannelCommand` 등)·`store`(레포 타입)·
  `events`·`config`를 알아도 된다. `discord.js`를 임포트하는 유일한 디렉토리다.
- `core`는 `store`(레포)·`config`·`events`(이벤트 타입)를 알아도 되지만, **`discord.js`를
  임포트하지 않는다**(채널 불가지론). `core/`·`store/`·`events/`·`remote/`·`memory/`
  전체를 검색해도 `discord.js`/`discord-api` 문자열은 등장하지 않는다 — 오직
  `adapters/discord.ts`만 이를 임포트한다.
- `store`는 그 위 어떤 레이어도 참조하지 않는다(최하위). 유일한 예외는
  `allowedDirsRepo.ts`가 순수 함수 `normalizeDir`(`core/paths.ts`)를 재사용하는
  것뿐이다.
- `events/bus.ts`는 `core/images.ts`의 `ImageRef` 타입 하나만 임포트한다(이벤트
  페이로드 타입용) — events → core 역방향 의존은 이 한 줄이 전부다.
- `remote/`는 `core`의 순수 경로 헬퍼 두 개(`pathPermission.ts`의
  `resolveRealOrNearestAncestor`, `paths.ts`의 `isPathWithinAny`)를 재사용하고, `events`·
  `adapters`에는 의존하지 않는다. `store` 의존은 원칙이 아니지만 한 줄 예외가 있다 —
  `hub.ts`가 토큰 해시 함수 `hashWorkerToken`을 `store/workersRepo.ts`에서 그대로
  가져온다(허브가 인증에 필요한 최소 인터페이스만 받도록 `WorkerRegistry` 타입으로 이미
  끊어 뒀지만, 해시 함수 자체는 공유 모듈로 빼지 않아 이 한 줄만 경계를 넘는다 — 리뷰에서
  지적됐고, 별도 모듈로 빼는 파급 대비 이득이 적어 당장은 그대로 둔 의도적 타협이다). 워커
  쪽 최종 경로 판정에 `core`의 헬퍼를 재사용하는 것(`remote/roots.ts`)은 이 예외와 별개다.
- `github/`는 `node:crypto`와 전역 `fetch`만 쓰는 독립 계층이다 — `core`가 부르고(`tools.ts`의
  발행·PR·저장소 목록·리뷰 읽기 핸들러, `agent.ts`의 셸 토큰 공급원), `remote/`는 그 결과(토큰
  문자열)를 인자로 받을 뿐 이 디렉토리를 임포트하지 않는다. 역방향(`github` → `core`/`store`) 의존은
  없다.
- `memory/memory.ts`는 `node:fs`/`node:path`만 쓰는 독립 유틸리티다.
- `config.ts`는 설정 로더다. 예외적으로 `remote/roots.ts`(루트 형식 판정)와 `core/digest.ts`(타입 전용)에 의존한다 — 같은 판정 규칙을 설정 로드 시점과 실행 시점에 각각 복제하면 어긋나기 때문이다. 이 둘 말고는 어떤 모듈도 참조하지 않는다.

## 이벤트버스 계약: 5개 이벤트

`events/bus.ts`가 정의하는 `AgentEvent`는 정확히 5가지로 이뤄진 판별 유니온이다. 공통
필드는 `channel: "discord"`(현재 유일한 `ChannelKind`), `channelRef: string`(응답 대상
채널 참조), `ts: number`.

| 이벤트 | 추가 필드 | 발행자 | 구독자 |
| --- | --- | --- | --- |
| `user_message` | `text: string`, `hint?: ConversationHint`, `images?: ImageRef[]` | `adapters/discord.ts`(메시지 인입 시) | `AgentCore.start()` |
| `assistant_message` | `text: string`(최종 응답 본문) | `core`(턴 성공 시) | 어댑터(실제 디스코드 전송) |
| `system_notice` | `text: string`(오류·안내 문구) | `core`(`notify()` — 한도 초과, 처리 오류, 이미지 다운로드 실패 등) | 어댑터(전송) |
| `progress` | `text: string`(도구 호출/완료/답변 작성 중 등 진행 텍스트) | `core`(턴 처리 중 `onProgress` 콜백을 `formatProgress`로 변환) | 어댑터(메시지 편집으로 진행 표시) |
| `assistant_file` | `name: string`, `data: Buffer`(파일 바이트 — 다섯 이벤트 중 유일하게 텍스트가 아니다) | `core/fileReturn.ts`(`POST /files` 핸들러 — 턴이 아니라 워커의 `send_file` 업로드가 발행 시점이다. 채널은 요청이 아니라 작업 토큰의 `channelRef`가 정한다) | 어댑터(그 채널에 첨부 전송. 진행 표시는 끝내지 않는다 — 턴은 아직 진행 중이다) |

`ConversationHint`(`user_message` 전용 부가 필드): `kind`("dm"|"thread"),
`discordChannelId`, `originMessageId?`, `guildId?`, `parentChannelId?`, `isPrivate`,
`primaryUserId`(대화 상대), `userId`(이번 발화자), `role`("owner"|"allowed" —
`blocked`/미등록은 애초에 이벤트가 발행되지 않는다), `discordMessageId`, `commandOnly?`(정확히
`true`이거나 필드 자체가 없음 — 일반 채널에서 멘션 없이 받은 예약어 힌트임을 표시한다. 코어는
이 필드가 있으면 대화 행을 조회·생성하지 않고 그 자리에서 처리하고 끝낸다).

실제 표시(전송·편집)는 항상 어댑터의 책임이다 — 코어는 이벤트만 발행하고 디스코드 API를
전혀 몰라도 된다. 이 구조 덕분에 향후 다른 채널(웹 UI 등)을 추가할 때도 코어를 건드리지
않고 새 어댑터만 붙이면 된다.

## 관련 문서

- 봇↔워커 토폴로지·원격 도구 전체 그림: `docs/architecture/overview.md`
- 메시지 하나의 전체 처리 경로(ingest/turn 체인 등): `docs/architecture/data-flow.md`
- 용어 정의: `docs/architecture/glossary.md`
- 능력 계층·도구 게이팅: `docs/security/capability-model.md`
