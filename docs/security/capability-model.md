---
lastReviewed: 2026-07-26
---

# 능력 계층 모델 (Capability Model)

Asahi 비서는 대화·모델 호출·기억·세션을 전담하는 **봇** 프로세스와, 파일·셸 작업을 실제
실행하는 **워커** 프로세스로 나뉜다(`docs/decisions/0006-thin-worker.md`). 모든 턴은
예외 없이 봇에서 실행되고, 워커는 봇이 원격으로 호출하는 도구 하나하나를 자신의 PC 위에서
대신 실행할 뿐이다 — 워커 자신은 판단하지 않는다.

파일·셸·코드작업·PC조작·DB조회 등 PC/데이터에 영향을 주는 도구는 발화자의 **신원과 대화
위치(DM/서버)**, 그리고 **그 사용자의 워커가 지금 연결돼 있는가**에 따라 턴마다 계층적으로
열고 닫는다. 새 도구는 기본적으로 가장 좁은 계층(소유자 DM 전용)에서 시작한다.

집행 지점은 두 곳이다.

1. **도구셋 결정** — `allowedToolsFor`(`agent/src/core/tools.ts`)가 role·isPrivate·isOwner·
   deployTarget·workerConnected 를 받아 이번 턴에 노출할 도구 이름 목록을 만든다.
   `workerConnected` 는 `shouldConnectWorker`(`agent/src/core/agent.ts`)가 매 턴
   `isOwner && isPrivate && hub.isConnected(userId)` 로 판정해 넘기는 값이다 — 허브 쪽
   연결 여부(`hub.isConnected`)만으로는 이 턴이 소유자 DM 인지 알 수 없으므로, 나머지 두
   조건은 반드시 여기서 함께 확인한다.
2. **런타임 재검증** — SDK 내장 파일/Bash 도구(Read/Write/Edit/Glob/Grep/Bash)는 이제 아예
   열리지 않는다(`builtinTools: []`, `agent/src/core/agent.ts`) — 열 대상 자체가 없으니
   재검증할 필요도 없다. 그 자리를 대신하는 원격 도구(`fs_read`/`fs_write`/`fs_edit`/
   `fs_glob`/`fs_grep`/`sh_exec`)는 호출마다 `remoteToolHandler`(`agent/src/core/remoteTools.ts`)가
   신원을 다시 확인하고 봇 쪽 `allowed_dirs` 로 1차 필터링한 뒤, 워커의
   `checkPath`(`agent/src/remote/roots.ts`)가 `WORKER_ROOTS` 기준으로 최종 판정한다
   (`sh_exec` 는 예외 — 아래 "경로 게이팅" 참고). 도구셋에 들어 있다고 해서 무조건
   실행되는 게 아니라는 원칙은 `fs_*` 도구에 한해 여전히 유효하다.

## 능력 계층표

| 계층 | 조건 | 열리는 도구 |
| --- | --- | --- |
| 소유자 DM · local | `isOwner && isPrivate`, `deployTarget="local"` | `remember`/`recall`(전원) + `character_fact` + `manage_access` + `allow_dir`/`revoke_dir`/`list_dirs` + `db_schema`/`db_query`/`runtime_info`. **워커 연결 시** `fs_read`/`fs_write`/`fs_edit`/`fs_glob`/`fs_grep`/`sh_exec` 추가 |
| 소유자 DM · cloud | `isOwner && isPrivate`, `deployTarget="cloud"` | `remember`/`recall`(전원) + `character_fact` + `manage_access` + `db_schema`/`db_query`/`runtime_info` — `allow_dir`/`revoke_dir`/`list_dirs` 는 워커가 연결돼도 열리지 않는다(cloud 배포는 이 세 도구만 계속 제외). **워커 연결 시** `fs_read`/`fs_write`/`fs_edit`/`fs_glob`/`fs_grep`/`sh_exec` 는 local 과 동일하게 추가된다 |
| 손님 DM | `isPrivate && role in {allowed, owner}`, 그 외 | `remember`/`recall`(본인 스코프만) + `character_fact` — 워커 연결 여부와 무관하게 항상 이 셋뿐이다(원격 도구는 1단계 한정 소유자 DM 전용) |
| 서버/스레드(공개) | `!isPrivate` — 소유자여도 동일 | `recall`(공용 스코프만) |

`character_fact`(캐릭터가 지어낸 자기 설정 고정)는 DM 계열 세 계층(소유자 local·소유자
cloud·손님)에만 열린다. 공개 서버 채널에서는 조작으로 설정을 오염시킬 여지가 크고 얻는
값이 작아 읽기(`recall`)만 남긴다.

**판정 축이 "어디서 실행 중인가"에서 "워커가 붙어 있는가"로 바뀐 것이 이 구조의 핵심이다.**
예전에는 `deployTarget="cloud"`(Railway 컨테이너)면 소유자 DM이라도 파일/Bash 를 통째로
뺐다 — 클라우드에는 소유자 PC가 없기 때문이다. 지금은 `workerConnected`(그 소유자의 워커가
허브에 살아있는 연결로 붙어 있는가)가 그 자리를 대신한다 — **cloud 배포라도 소유자의 워커가
연결되면 원격 도구가 열린다.** 유일한 예외는 `allow_dir`/`revoke_dir`/`list_dirs`(허용 폴더
관리 도구)로, 이 셋은 워커 연결과 무관하게 `deployTarget="local"` 일 때만 열린다(위 표
참고) — `allowedToolsFor` 의 `remote` 배열은 `workerConnected` 하나로만 결정되고
`deployTarget` 분기 밖에서 계산되지만, 손님 DM·서버 분기는 이 배열을 아예 스프레드하지
않으므로 원격 도구는 소유자 DM 두 계층에만 나타난다.

## character_fact 전역 스코프와 DM→공개 데이터 흐름

`character_fact`(위 능력 계층표)로 저장되는 캐릭터 설정은 `scope='character'` 하나의 전역
저장소다. `MemoriesRepo.characterFacts`(`agent/src/store/memoriesRepo.ts`)는 `user_id` 로
거르지 않고, `buildContextBlock`(`agent/src/core/turnPrep.ts`)은 `conv.isPrivate` 값과
무관하게 매 세션 시작마다 이 전역 목록을 `## 내 설정` 섹션에 그대로 주입한다. 소유자에게 한
번 확정한 설정이 손님에게도, 공개 서버 채널에서도 똑같아야 캐릭터 일관성이 유지되므로
의도된 설계다.

다만 이 전역성은 이 코드베이스에서 유일하게 존재하는 **DM→공개 데이터 흐름**이다. 나머지
전 영역의 프라이버시 원칙은 "DM 은 상대의 개인+공용, 서버/스레드는 공용만"(`recallHandler`,
위 능력 계층표)인데, `character_fact` 는 이 원칙의 반대쪽 끝에 있다.

- **쓰기**: 소유자 DM 뿐 아니라 손님 DM에서도 쓸 수 있다.
- **읽기**: 소유자 DM·손님 DM·공개 서버 채널 등 모든 컨텍스트에서 예외 없이 주입된다 —
  `recall` 처럼 신원·대화 위치별로 걸러지지 않는다.
- **결과**: 손님이 자신의 DM 에서 캐릭터를 유도해 저장시킨 설정이, 소유자와의 대화와 공개
  서버 채널에도 그대로 나타난다.

이건 사용자에 대한 사실(`scope='user'`/`shared`)이 아니라 **캐릭터가 연기하는 캐논**이므로
같은 위험 등급으로 취급하지는 않는다 — 새어나갈 수 있는 건 캐릭터가 지어낸 자기 신상뿐이고,
제목·본문 길이 상한과 저장 개수 상한(도달 시 저장 자체를 거부)이 오염 폭을 제한한다. 그래도
"손님이 쓴 내용이 소유자의 비공개 대화에도 노출된다"는 사실 자체는 남으므로, 이 전역 스코프에
기대는 새 기능을 설계할 때는 이 절을 먼저 참고한다.

## 신원 vs 역할 게이팅

특권은 **신원**(`isOwner = userId === config.ownerId`)으로만 판정하며, **역할**(`role`)로는
판정하지 않는다. `manage_access` 로 어떤 사용자에게 `role='owner'` 를 부여해도 신원이
소유자와 다르면 특권을 갖지 못한다 — `manage_access` 핸들러 자체가 애초에 `owner` 역할
부여를 거부한다(`agent/src/core/tools.ts` `manageAccessHandler`, 제2 소유자 생성 차단).

같은 원칙이 도구 핸들러 내부의 보조 판정 함수에도 반영돼 있다.

- `isOwnerDm(ctx) = ctx.isOwner && ctx.isPrivate` — 자기인지 DB 도구(`db_schema`/`db_query`/
  `runtime_info`)와 `manage_access`, 그리고 원격 도구(`fs_*`/`sh_exec`, 아래 참고)는 이 조건에서만
  실행된다. 순환 참조를 피하려고 `agent/src/core/remoteTools.ts` 에 완전히 동일한 판정이
  그대로 복제돼 있다(파일 상단 주석에 명시) — 한쪽을 고치면 반드시 다른 쪽도 같이 고쳐야 한다.
- `canManagePc(ctx) = ctx.isPrivate && (ctx.isOwner || ctx.ownWorkstation === true)` —
  폴더 관리 도구(`allow_dir`/`revoke_dir`/`list_dirs`)의 핸들러 게이트다. `ownWorkstation` 을
  `true` 로 채우던 유일한 생산자(옛 `worker/jobRunner.ts`)가 얇은 워커 전환(`docs/decisions/
  0006-thin-worker.md`)으로 삭제돼, 이 필드는 지금 항상 `undefined` 다 — 즉 이 게이트는
  사실상 `ctx.isPrivate && ctx.isOwner` 로만 동작한다. 필드·분기 자체는 코드에 남아 있지만
  (`ToolCtx.ownWorkstation`, `TurnContext.ownWorkstation`) 두 번째 값을 채우는 경로가 없다 —
  죽은 코드이지 살아있는 예외가 아니다.

두 함수 모두 도구셋 노출(`allowedToolsFor`)과 별개로 핸들러 내부에서 다시 신원을
확인한다 — 도구셋 계산이 틀리더라도 핸들러가 최종 방어선이 되도록 이중으로 게이팅한다.

## 경로 게이팅

파일 도구(`fs_read`/`fs_write`/`fs_edit`/`fs_glob`/`fs_grep`)는 신원 확인만으로 끝나지
않고, 호출마다 실제 경로를 검사한다. 검사는 **두 겹**이며, 각 겹을 집행하는 프로세스가
다르다 — 봇은 사용자가 관리하는 편의 목록을 알 뿐이고, 실제 파일시스템(realpath·심볼릭
링크·존재 여부)을 아는 건 워커뿐이기 때문이다.

**1차 필터(봇 쪽, `agent/src/core/remoteTools.ts` 의 `remoteToolHandler`)**

- `isOwnerDm(ctx)` 를 `allowedToolsFor` 와 독립적으로 다시 확인하고, `ctx.remote` 가
  없으면(그 사용자의 워커가 연결돼 있지 않으면) "지금은 워커가 연결돼 있지 않아 PC 작업을
  할 수 없어요."로 즉시 끝낸다.
- `fs_read`/`fs_write`/`fs_edit` 는 `path` 인자 하나를 그대로 후보로 쓴다. `fs_glob`/`fs_grep`
  은 `path` 가 생략돼도 `pattern` 자체가 경로를 담을 수 있으므로, 옛 SDK `Glob`/`Grep` 게이트가
  쓰던 `extractCandidatePaths`(`agent/src/core/pathPermission.ts`, 아직 쓰이는 함수)를 그대로
  재사용해 `pattern` 의 "리터럴 경로 접두"(첫 glob 메타문자 이전까지)까지 후보에 넣는다 —
  `path` 를 생략하면 그 자리에 사용자의 첫 번째 허용 폴더(`allowedDirs[0]`)를 기본값으로
  넣어, "후보가 없으면 필터 자체가 스킵된다"는 구멍을 막는다.
- 빈 문자열/공백 경로는 "인자 없음"이 아니라 "잘못된 인자"로 별도 거부한다 — 그렇지 않으면
  필터 전체가 조용히 스킵된다.
- 후보 경로 각각을 그 사용자의 `allowed_dirs`(`allow_dir`/`revoke_dir`/`list_dirs` 로 관리)와
  `isPathWithinAny`(`agent/src/core/paths.ts`)로 대조한다. 허용 폴더가 비어 있으면(아직
  `allow_dir` 를 한 번도 안 썼으면) 무조건 거부한다. `allowedDirs` 리포를 조회할 수 없는
  상태(현재 운영 코드에서는 나타나지 않아야 함)도 통과가 아니라 거부로 처리한다(fail-closed).
- `sh_exec` 는 이 필터의 대상이 **아니다** — 경로 인자 자체가 없다(아래 참고).

**최종 판정(워커 쪽, `agent/src/remote/roots.ts` 의 `checkPath`)**

- `WORKER_ROOTS` 각 항목이 "모호하지 않은 절대경로"인지부터 검사한다 — 윈도우는 드라이브
  문자(`C:\...`) 또는 UNC(`\\server\share\...`) 로 시작해야 하며, 드라이브 문자 없이
  구분자 하나로만 시작하는 경로(`/workspace` 등)는 `process.cwd()` 의 드라이브에 따라
  가리키는 폴더가 달라질 수 있어 거부한다(`isUnambiguousRoot`). 하나라도 잘못돼 있으면
  조용히 걸러내지 않고 전체를 거부한다.
- `resolveRealOrNearestAncestor`(`agent/src/core/pathPermission.ts`, 옛 `canUseTool` 이
  쓰던 것과 동일한 함수)로 **realpath 정규화**한다. 대상 경로가 존재하면 `fs.realpathSync`
  그대로, 존재하지 않으면(새로 만들 파일) 존재하는 가장 가까운 조상까지만 realpath 하고
  나머지를 이어붙인다 — 심볼릭 링크/정션으로 루트 검사를 우회하는 걸 막기 위해서다.
- 정규화된 경로가 `WORKER_ROOTS` 중 하나의 내부(`isPathWithinAny`)가 아니면 거부한다.
- `fs_glob`/`fs_grep` 은 기반 폴더뿐 아니라 **결과로 나온 개별 파일 각각**도 다시
  `checkPath` 로 재검사한다(`agent/src/remote/executors.ts`) — `tinyglobby` 가 `pattern`
  안의 절대경로나 `..` 를 그대로 받아들여 루트 밖 파일을 열거할 수 있기 때문이다.

경로는 **양쪽을 모두 통과해야** 한다 — 봇 쪽 `allowed_dirs` 가 넓어도 워커 루트가 좁으면
막히고, 워커 루트가 넓어도 봇 쪽 목록이 좁으면 막힌다.

**`sh_exec` 는 이 두 겹 어디에도 속하지 않는다 — 이건 사실을 있는 그대로 적은 것이지
누락이 아니다.** 셸 명령은 경로 인자 하나로 판정할 수 있는 대상이 아니다(파이프·서브셸·
`cd`·PATH 탐색 등으로 인자 검사를 우회한다). `agent/src/remote/executors.ts` 의 `sh_exec`
실행기는 경로 검사를 시도조차 하지 않고 `spawn(command, { cwd: roots[0], shell: true })`
로 그대로 실행한다. 남는 경계는 정확히 둘뿐이다 — 실행 시 작업 디렉토리(`WORKER_ROOTS`의
첫 번째 폴더)와, 워커 프로세스를 돌리는 OS 계정의 권한. 그 계정이 닿는 곳이라면 셸 명령은
`WORKER_ROOTS` 밖도 얼마든지 오갈 수 있다 — 신원 게이팅(소유자 DM + 워커 연결)으로 호출
가능한 사람을 좁히는 것 이상의 애플리케이션 단 방어는 없다. 옛 SDK `Bash` 도구가 갖고
있던 `dangerouslyDisableSandbox` 차단은 `sh_exec` 에는 대응 개념 자체가 없다 — 애초에
해제할 샌드박스가 없기 때문이다. 자세한 위협·완화 서술은
`docs/security/risk-register.md` "`sh_exec` — 경로로 봉쇄되지 않는 셸 실행" 참고.

## READ ONLY SQL 가드

자기인지 DB 조회(`db_query`)는 두 단계로 방어한다.

1. **사전검사(1차, 애플리케이션 단)** — `assertReadOnlySql`(`agent/src/core/sqlGuard.ts`)이
   주석을 제거한 뒤 다중 문장(세미콜론으로 구분된 두 번째 문장)을 거부하고, 첫 단어가
   `SELECT` 또는 `WITH` 가 아니면 거부한다. 완전한 SQL 파서가 아니라 "명백한 쓰기/DDL/다중문을
   빠르게 걸러내는" 1차 방어일 뿐이다 — 예를 들어 `WITH x AS (DELETE … RETURNING *) SELECT …`
   처럼 문두가 `WITH` 인 쓰기 CTE 는 이 사전검사를 통과한다.
2. **핵심 방어선(2차, DB 단)** — `IntrospectRepo.readOnlyQuery`(`agent/src/store/introspectRepo.ts`)가
   실행 전에 `SET TRANSACTION READ ONLY` 로 Postgres 트랜잭션 자체를 읽기 전용으로 만든다. 이
   `SET` 은 절대 에러를 삼키지 않고 실패 시 쿼리를 아예 실행하지 않는다 — 사전검사를 뚫은
   쓰기 시도가 있어도 DB 가 최종적으로 거부하는 게 진짜 보장이다. 결과는 `maxRows` 로 자르고
   `statement_timeout` 을 걸어 무거운 조회로부터도 보호한다.

`db_query`/`db_schema`/`runtime_info` 는 위 신원 게이팅(`isOwnerDm`)까지 통과해야 도달하므로,
소유자 DM 바깥에서는 이 SQL 가드 자체에 도달하지 않는다.

## 보안-핵심 파일 목록

이 파일들의 불변식이 깨지면 능력 계층이 통째로 무너질 수 있다. 수정 시 반드시 대응 테스트를
같이 갱신한다.

| 파일 | 지켜야 할 불변식 |
| --- | --- |
| `agent/src/core/tools.ts` | `allowedToolsFor` 는 신원·위치·`workerConnected` 조합별로 정확히 문서화된 도구 목록만 반환한다. 손님 DM·서버 분기는 `workerConnected` 값과 무관하게 원격 도구를 절대 포함하지 않는다. `isOwnerDm`/`canManagePc` 는 도구셋과 독립적으로 핸들러 내부에서 다시 신원을 확인한다. `manage_access` 는 `owner` 역할 부여를 항상 거부한다. |
| `agent/src/core/agent.ts` | `shouldConnectWorker` 는 `isOwner && isPrivate && hub.isConnected(userId)` 세 조건을 모두 만족할 때만 참이다 — 이 값이 `ctx.remote` 를 채울지와 `allowedToolsFor` 에 넘길 `workerConnected` 를 동시에 결정하므로, "도구는 보이는데 실행은 거부"(또는 그 반대) 불일치가 생기지 않는다. `builtinTools` 는 항상 빈 배열이라 SDK 내장 파일/Bash 도구는 이름을 사전승인해도 실행될 대상 자체가 없다. |
| `agent/src/core/remoteTools.ts` | `remoteToolHandler` 는 `allowedToolsFor` 와 독립적으로 `isOwnerDm` 을 다시 확인하고, `ctx.remote` 가 없으면 항상 거부한다. `fs_read`/`fs_write`/`fs_edit`/`fs_glob`/`fs_grep` 의 경로 후보는 그 사용자의 `allowed_dirs` 안에 있어야 하며, 빈 경로 문자열·빈 허용 목록·리포 조회 실패는 모두 거부(fail-closed)로 처리한다. `sh_exec` 는 이 경로 필터의 대상이 아니다(의도된 설계). |
| `agent/src/remote/roots.ts` | `checkPath` 는 워커의 최종 경로 관문이다 — `WORKER_ROOTS` 항목이 모호한 절대경로(윈도우에서 드라이브 문자·UNC 없음)면 무조건 거부하고, `resolveRealOrNearestAncestor` 로 realpath 정규화한 뒤 루트 밖이면 거부한다. |
| `agent/src/remote/hub.ts` | `WorkerHub.handleConnection` 은 `hello` 의 토큰을 상수 시간(`timingSafeEqual`)으로 비교하고, 빈 토큰은 길이 검사로 먼저 거부하며, 토큰 오류와 신원(`userId`) 불일치를 같은 거부 사유(`DENIED_REASON`)로 응답해 인증 오라클을 막는다. 인증 전에는 `hello` 이외 프레임을 전부 무시한다. |
| `agent/src/core/pathPermission.ts` | `extractCandidatePaths`(`remoteTools.ts` 가 재사용)는 Glob 의 `pattern` 리터럴 접두를 후보에서 빠뜨리지 않는다. `resolveRealOrNearestAncestor`(`roots.ts` 가 재사용)는 존재하지 않는 경로도 가장 가까운 실재 조상까지 realpath 한다. `decidePathPermission`/`isPathGatedTool` 은 옛 `canUseTool` 전용이었고 지금은 프로덕션 코드에서 호출되지 않는다(2단계 재사용 여지로 남겨둠 — 새 경로 검사 로직의 근거로 오인하지 말 것). |
| `agent/src/core/sqlGuard.ts` | `assertReadOnlySql` 은 다중 문장과 `SELECT`/`WITH` 이외 시작 키워드를 거부한다(1차 방어). |
| `agent/src/store/introspectRepo.ts` | `readOnlyQuery` 의 `SET TRANSACTION READ ONLY` 는 에러를 삼키지 않는다(2차·핵심 방어선). |

가드 테스트: `agent/tests/tools.test.ts`(능력 계층표의 각 행 × `workerConnected`),
`agent/tests/agent.test.ts`(`shouldConnectWorker`·`buildToolCtx`), `agent/tests/remoteTools.test.ts`
(1차 필터 허용/거부/빈 경로/`sh_exec` 예외), `agent/tests/remoteRoots.test.ts`(워커 최종 판정),
`agent/tests/remoteHub.test.ts`(토큰 인증·인증 오라클 방지), `agent/tests/pathPermission.test.ts`
(재사용되는 순수 함수), `agent/tests/sqlGuard.test.ts` — 케이스별로 검증한다.
