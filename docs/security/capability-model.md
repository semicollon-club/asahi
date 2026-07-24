---
lastReviewed: 2026-07-25
---

# 능력 계층 모델 (Capability Model)

Asahi 비서는 **소유자 PC에서 소유자 권한으로** 실행된다. 파일·셸·코드작업·PC조작·DB조회 등
PC/데이터에 영향을 주는 도구는 발화자의 **신원과 대화 위치(DM/서버, local/cloud)** 에 따라
턴마다 계층적으로 열고 닫는다. 새 도구는 기본적으로 가장 좁은 계층(소유자 DM 전용)에서
시작한다.

집행 지점은 두 곳이다.

1. **도구셋 결정** — `allowedToolsFor`(`agent/src/core/tools.ts`)가 role·isPrivate·isOwner·
   deployTarget·ownWorkstation 을 받아 이번 턴에 노출할 도구 이름 목록을 만든다.
2. **런타임 재검증** — `canUseTool`(`agent/src/core/agent.ts`)이 파일·Bash 계열 호출마다
   `decidePathPermission`(`agent/src/core/pathPermission.ts`)으로 실제 경로를 다시 검사한다.
   도구셋에 들어 있다고 해서 무조건 실행되는 게 아니라, 이 재검증을 통과해야 한다.

## 능력 계층표

| 계층 | 조건 | 열리는 도구 |
| --- | --- | --- |
| 소유자 DM · local | `isOwner && isPrivate`, `deployTarget="local"` | 파일 도구(Read/Write/Edit/Glob/Grep) + Bash + `remember`/`recall`(전원) + `manage_access` + `allow_dir`/`revoke_dir`/`list_dirs` + `db_schema`/`db_query`/`runtime_info` |
| 소유자 DM · cloud | `isOwner && isPrivate`, `deployTarget="cloud"` | `remember`/`recall`(전원) + `manage_access` + `db_schema`/`db_query`/`runtime_info` — 파일/Bash/폴더관리 등 PC 도구는 전부 제외 |
| 손님 자기 PC(ownWorkstation) · DM · local | `ownWorkstation && isPrivate`, `deployTarget≠"cloud"` | 파일 도구 + Bash + `remember`/`recall`(본인) + `allow_dir`/`revoke_dir`/`list_dirs` — `manage_access`·DB 조회 도구는 **제외**(신원 특권이 아니므로) |
| 손님 DM(자기 PC 아님) | `isPrivate && role in {allowed, owner}`, 그 외 | `remember`/`recall`(본인 스코프만) |
| 서버/스레드(공개) | `!isPrivate` — 소유자여도 동일 | `recall`(공용 스코프만) |

`ownWorkstation` 은 하이브리드 로컬 워커가 "그 사용자 자신의 PC"에서 턴을 실행 중일 때만 선다.
손님이라도 자기 PC 위에서는 파일/Bash 전권을 갖지만, `manage_access`나 `db_query` 같은
신원 기반 특권은 여전히 `isOwner` 인 사람만 갖는다 — 이 둘은 별개 축이다(아래 절 참고).
`deployTarget="cloud"`(Railway 컨테이너)는 로컬 워커가 아니므로 `ownWorkstation` 이 와도 PC
도구를 열지 않는다.

## 신원 vs 역할 게이팅

특권은 **신원**(`isOwner = userId === config.ownerId`)으로만 판정하며, **역할**(`role`)로는
판정하지 않는다. `manage_access` 로 어떤 사용자에게 `role='owner'` 를 부여해도 신원이
소유자와 다르면 특권을 갖지 못한다 — `manage_access` 핸들러 자체가 애초에 `owner` 역할
부여를 거부한다(`agent/src/core/tools.ts` `manageAccessHandler`, 제2 소유자 생성 차단).

같은 원칙이 도구 핸들러 내부의 보조 판정 함수에도 반영돼 있다.

- `isOwnerDm(ctx) = ctx.isOwner && ctx.isPrivate` — 자기인지 DB 도구(`db_schema`/`db_query`/
  `runtime_info`)와 `manage_access` 는 이 조건에서만 실행된다.
- `canManagePc(ctx) = ctx.isPrivate && (ctx.isOwner || ctx.ownWorkstation === true)` —
  폴더 관리 도구(`allow_dir`/`revoke_dir`/`list_dirs`)는 소유자 DM, 또는 손님이라도 자기 PC
  워커 위에서만 실행된다.

두 함수 모두 도구셋 노출(`allowedToolsFor`)과 별개로 핸들러 내부에서 다시 신원을
확인한다 — 도구셋 계산이 틀리더라도 핸들러가 최종 방어선이 되도록 이중으로 게이팅한다.

## 경로 게이팅

원격 개발 워크플로우(파일 도구 + Bash)는 신원 확인만으로 끝나지 않고, 호출마다 실제 경로를
허용 폴더와 대조한다.

- 집행 지점은 `canUseTool`(`agent/src/core/agent.ts`)이다. SDK 의 `allowedTools` 에 파일/Bash
  이름을 "괄호 없이 그대로" 넣으면 SDK 가 `canUseTool` 호출 자체를 생략하고 통과시켜 버리므로,
  파일·Bash 계열 도구는 항상 사전승인 목록에서 빼고 `canUseTool` 재검증을 강제로 거치게 한다.
- `canUseTool` 은 `extractCandidatePaths`로 도구 입력에서 후보 경로를 뽑고,
  `resolveRealOrNearestAncestor`(`pathPermission.ts`)로 **realpath 정규화**한다. 대상 경로가
  존재하면 `fs.realpathSync` 그대로, 존재하지 않으면(새로 만들 파일) 존재하는 가장 가까운
  조상까지만 realpath 하고 나머지를 이어붙인다 — 심볼릭 링크/정션으로 허용 폴더 검사를
  우회하는 걸 막기 위해서다.
- `decidePathPermission`(순수 함수, `pathPermission.ts`)이 최종 판정을 내린다: 소유자 DM(또는
  ownWorkstation) 이 아니면 거부, 허용 폴더가 비어 있으면 거부, 정규화된 경로가 허용 폴더 중
  하나의 내부(`isPathWithinAny`, `paths.ts`)가 아니면 거부.
- **Glob 은 pattern 까지 검사한다.** `path` 인자뿐 아니라 `pattern` 문자열의 "리터럴 경로
  접두"(첫 glob 메타문자 이전까지)도 후보 경로로 뽑는다 — glob 구현체가 pattern 에 절대경로나
  `..` 를 그대로 받아들여 허용 폴더 밖을 열거할 수 있기 때문이다.
- **cloud 이중방어**: `deployTarget="cloud"` 면 `allowedToolsFor` 단계에서 이미 파일/Bash 를
  도구셋에서 뺐지만, `canUseTool` 이 경로 검사보다 먼저 한 번 더 무조건 거부한다 — 모델이
  어떤 경로로 도구를 호출 시도하든 클라우드 컨테이너에서는 PC 작업이 새지 않게 한다.
- **`dangerouslyDisableSandbox` 차단**: Bash 호출 입력에 `dangerouslyDisableSandbox=true` 가
  실려 오면, 소유자 DM·허용 폴더 내부 여부와 무관하게 무조건 거부한다 — 이 옵션은 남은 봉쇄
  자체를 무력화하므로 예외를 두지 않는다.

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
| `agent/src/core/tools.ts` | `allowedToolsFor` 는 신원·위치 조합별로 정확히 문서화된 도구 목록만 반환한다. `isOwnerDm`/`canManagePc` 는 도구셋과 독립적으로 핸들러 내부에서 다시 신원을 확인한다. `manage_access` 는 `owner` 역할 부여를 항상 거부한다. |
| `agent/src/core/pathPermission.ts` | `decidePathPermission` 은 순수 함수로, 소유자 DM(또는 ownWorkstation) 이 아니거나 경로가 허용 폴더 밖이면 항상 거부한다. `dangerouslyDisableSandbox=true` 는 다른 모든 조건보다 우선해 거부한다. `extractCandidatePaths` 는 Glob 의 `pattern` 리터럴 접두를 후보에서 빠뜨리지 않는다. |
| `agent/src/core/agent.ts` | 파일/Bash 도구는 `preApprovedTools`(bare 사전승인)에서 항상 제외해 `canUseTool` 재검증을 강제로 거친다. `deployTarget="cloud"` 는 경로 검사 이전에 파일/Bash 를 무조건 거부한다(이중방어). |
| `agent/src/core/sqlGuard.ts` | `assertReadOnlySql` 은 다중 문장과 `SELECT`/`WITH` 이외 시작 키워드를 거부한다(1차 방어). |
| `agent/src/store/introspectRepo.ts` | `readOnlyQuery` 의 `SET TRANSACTION READ ONLY` 는 에러를 삼키지 않는다(2차·핵심 방어선). |

가드 테스트: `agent/tests/pathPermission.test.ts`, `agent/tests/sqlGuard.test.ts`,
`agent/tests/tools.test.ts` — 능력 계층표의 각 행(소유자 DM/cloud/ownWorkstation/손님 DM/서버)과
경로 게이팅 시나리오(허용/거부/dangerouslyDisableSandbox/glob pattern 탈출)를 케이스별로
검증한다.
