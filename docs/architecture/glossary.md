---
lastReviewed: 2026-08-06
---

# 용어집 (Glossary)

코드베이스 전반에서 반복되는 용어를 한곳에 정리한다. 정의는 모두 코드 원문
(`agent/src/**`)을 근거로 하며, 새로 합류하는 기여자가 다른 문서·코드를 읽을 때 참조하는
용도다.

## conversation vs SDK session

- **conversation**: `store/conversationsRepo.ts`의 `conversations` 테이블 행. 디스코드
  채널 하나(DM 또는 스레드)에 대응하는 영속 개념으로, `discordChannelId`가 조회 키다.
  대화 상대(`primaryUserId`), 공개 여부(`isPrivate`), 상태(`active`/`idle`/`closed`) 등을
  갖는다.
- **SDK session**: `conversation.sessionId`에 저장되는, Claude Agent SDK의 `query()`가
  관리하는 세션 식별자(`resume` 키). 열린 세션이 유휴 시간(`sessionIdleMinutes`, 기본
  30분) 안이면 그 세션을 `resume`하고, 지났으면 새 세션을 시작하며 기억 컨텍스트
  (`buildContextBlock`)를 주입한다. `resume` 대상 세션을 SDK가 찾지 못하면
  (`isSessionNotFound`) 새 세션으로 폴백한다.
- **관계**: 하나의 conversation은 시간에 따라 여러 SDK session을 거칠 수 있지만(유휴로
  닫혔다 재개되면 새 세션), 한 시점엔 최대 하나의 활성 session만 갖는다.

## ingest 체인 vs turn 체인

`AgentCore`(`core/core.ts`)는 대화 채널(`discordChannelId`)별로 두 개의 독립된 직렬 큐
(`Map<string, Promise<void>>`)를 관리한다.

- **ingest 체인**(`ingestChains`): durable 저장만 담당한다 — 대화 행 확정
  (`resolveConversation`), 참가자 upsert, 사용자 메시지를 `processed=false`로 저장. 짧게
  끝난다.
- **turn 체인**(`turnChains`): 실제 LLM 턴 실행(`runConversationTurn`)을 담당한다 — 한도
  예약, SDK 턴 실행(예외 없이 봇 자신의 세션으로 직접 실행 — 위임은 얇은 워커 전환
  (`docs/decisions/0006-thin-worker.md`)으로 사라졌다), 응답 발행, `processed=true`로
  마감(`markProcessed`). 길게 걸릴 수 있다.
- **분리 이유**: 하나의 체인으로 묶으면 앞선 메시지의 긴 LLM 턴이 끝날 때까지 뒤 메시지가
  insert조차 되지 못해, 그 사이 크래시하면 `recoverPending`이 복구할 행 자체가 없어 영구
  유실될 수 있다. 두 체인을 분리하면 durable 저장은 LLM 턴 길이와 무관하게 항상 빠르게
  끝나 크래시 복구 불변식이 유지된다.

## `deployTarget`

`Config.deployTarget`(`config.ts`): 환경변수 `DEPLOY_TARGET`이 정확히 `"cloud"`일 때만
`"cloud"`, 그 외(미설정·오타 포함)는 전부 `"local"`이다. Railway 클라우드 봇(`index.ts`)이
이 값을 그대로 쓰고, 로컬 워커(`worker.ts`)는 항상 `"local"`로 고정한다(워커는 태생적으로
로컬 실행이므로).

다중 워커 전환(`docs/decisions/0007-multi-worker-routing.md`) 이후로는 파일/Bash 같은 PC
도구가 더 이상 이 값으로 갈리지 않는다 — `allowedToolsFor`(`core/tools.ts`)는 이 값을
인자로 받지만 함수 본문 어디에서도 분기에 쓰지 않는다. PC 작업(원격 도구 `fs_*`/`sh_exec`)이
가능한지는 오직 "이 턴이 쓸 워커가 지금 연결돼 있는가"(`workerConnected`)로만 결정된다 —
`cloud` 배포에서도 워커만 연결되면 PC 작업이 가능하다. 실행 시점에 이 값을 재검증하던
`canUseTool`(SDK 내장 Read/Write/Edit/Glob/Grep/Bash 게이트)은 얇은 워커 전환
(`docs/decisions/0006-thin-worker.md`)으로 이미 삭제됐다 — SDK 내장 파일/Bash 도구 자체를
`agent/src/core/agent.ts`의 `builtinTools`가 애초에 열지 않으므로 재검증할 대상이 없다.
`deployTarget`은 지금은 `runtime_info` 도구가 보고하는 배포 정보로만 의미가 남아 있다.

## turns 예약(reserve)

`TurnsRepo.reserve()`(`store/turnsRepo.ts`)가 유저별+전역 시간당 한도
(`maxTurnsPerHourPerUser`/`maxTurnsPerHourGlobal`)를 원자적으로 검사·기록하는 것.
Postgres advisory lock(`pg_advisory_xact_lock`)으로 전역 직렬 지점을 만들어, 두 요청이
동시에 카운트를 읽고 둘 다 한도 통과로 착각하는 경합을 막는다.

소유자는 예약 자체를 생략한다(무제한 정책 — `turns` 테이블에 기록조차 되지 않아 손님
카운트에도 영향을 주지 않는다). 손님만 메시지 턴(`kind: "message"`)과 유휴 요약
(`kind: "summary"`)에 대해 예약하며, 실패하면 한도 안내 메시지 후 그 턴을 종료한다.

## owner/allowed/blocked 역할

`store/usersRepo.ts`의 `Role` 타입. 신규 사용자의 기본값은 `"blocked"`다.

- **owner**: 소유자로 등록된 사용자. 다만 실제 특권(파일/Bash/`manage_access`/DB 조회 등)
  은 역할이 아니라 **신원**(`userId === config.ownerId`)으로 판정한다 — `manage_access`로
  손님에게 `owner` 역할을 부여해도 신원이 소유자가 아니면 특권은 얻지 못한다.
- **allowed**: 대화가 허용된 손님. 대화와 본인 기억(remember/recall)은 쓸 수 있고, 다중 워커
  전환(`docs/decisions/0007-multi-worker-routing.md`) 이후로는 공유 워커가 연결돼 있으면
  원격 파일/셸 도구(`fs_*`/`sh_exec`, 본인 폴더로 좁혀짐)도 받는다 — 다만 DB 조회·접근관리
  (`db_query`/`manage_access` 등)와 폴더 관리(`allow_dir` 등)는 신원(`isOwner`) 전용이라
  여전히 없다.
- **blocked**(또는 미등록): 응답 게이트를 통과하지 못해 이벤트 자체가 처리되지 않는다
  (어댑터의 `decideRoute`와 코어의 `onUserMessage` 양쪽에서 재확인). 미등록 사용자도
  `getRole`이 `"blocked"`를 반환하므로 동일하게 취급된다.

## `allowedDirs`

`store/allowedDirsRepo.ts`의 `allowed_dirs` 테이블. **워커별로**(`worker_id` 가 키 —
다중 워커 전환 이전에는 `user_id` 가 키였다) 원격 파일 도구(`fs_read`/`fs_write`/`fs_edit`/
`fs_glob`/`fs_grep`)가 접근을 허용받은 폴더 목록이며, `allow_dir`/`revoke_dir`/`list_dirs`
도구(소유자 전용)로 관리한다. SDK 내장 Read/Write/Edit/Glob/Grep/Bash 는 이 목록의 소비자가
아니다 — 그 도구들은 `builtinTools`가 애초에 열지 않으므로, 실제 소비자는 워커에 원격 호출을
보내는 `remoteToolHandler`(`core/remoteTools.ts`)뿐이다. `remoteToolHandler`가 호출마다 이
목록(공유 워커의 손님이면 `scopeDirs`로 자기 하위 폴더로 더 좁힌 뒤)으로 요청 경로가 안(또는
그 하위)인지 1차로 거르고, 워커 쪽 `WORKER_ROOTS`(`checkPath`)가 최종 판정한다 — 도구셋에
노출됐다고 해서 무조건 실행이 허용되는 것은 아니다. `sh_exec`는 경로 인자 자체가 없어 이
목록의 대상이 아니다(`docs/security/capability-model.md` "경로 게이팅" 참고).

## 관련 문서

- 디렉토리 책임·이벤트버스 계약: `docs/architecture/module-boundaries.md`
- 봇↔워커 토폴로지·원격 도구 호출 전체 그림: `docs/architecture/overview.md`
- 메시지 하나의 전체 처리 경로: `docs/architecture/data-flow.md`
