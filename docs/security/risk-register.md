---
lastReviewed: 2026-07-28
---

# 위험 등록부 (Risk Register)

알려진 한계를 완화 관점에서 정리한다. 정확한 사칭 절차·재현 페이로드 같은 악용 세부는
싣지 않는다 — 여기서는 위협의 성격과 현재 완화책만 서술한다. 상세 능력 계층은
`docs/security/capability-model.md` 참고.

## 1. 워커 토큰(`workers` 테이블) 취급

각 워커는 `workers` 테이블(레지스트리, `agent/src/store/workersRepo.ts`)에 등록된 자기
고유의 신원(`id`, `kind`: `personal`|`shared`)과 토큰을 갖는다 — 1단계 전체를 통틀어 단일
공유 비밀은 더 이상 없다. 토큰 평문은 저장하지 않는다 — `register-worker`
CLI(`agent/src/scripts/registerWorker.ts`)가 32바이트 랜덤 토큰을 생성해 **stdout 에 한
번만** 출력하고, DB 에는 `sha256` 해시(`hashWorkerToken`)만 남긴다. 허브
(`agent/src/remote/hub.ts`)는 접속마다 `hello` 프레임의 `workerId` 로 이 테이블을 조회해
해시를 대조한다.

이 토큰 하나가 새어나가면, 그 값을 아는 사람이 그 **워커 하나**로 인증에 성공할 수 있다 —
`personal` 워커의 토큰이 새면 그 담당자(대개 소유자)의 개인 기계가, `shared` 워커의 토큰이
새면 동아리 미니PC가 위험에 노출된다(`docs/superpowers/specs/
2026-07-27-multi-worker-design.md` §2 의 라우팅). 등록에 성공한 뒤 할 수 있는 일은 원래
그 워커가 하던 것과 동일하다 — 모델이 그 접속 위로 보내는 `fs_read`/`fs_write`/`fs_edit`/
`fs_glob`/`fs_grep`/`sh_exec` 호출을 전부 받아 실행하고, 결과(`result` 프레임)를 조작해
돌려줄 수 있다(허브는 그 접속이 보낸 결과를 그대로 신뢰한다). 반대로 이 값 하나로는
Postgres(`DATABASE_URL`)에도, 소유자의 Claude 구독(`CLAUDE_CODE_OAUTH_TOKEN`)에도 접근할
수 없다 — 워커는 이제 이 두 자격증명을 아예 갖지 않는다(`docs/decisions/
0006-thin-worker.md`).

**완화**: `.env` 는 저장소에 커밋하지 않는다(`.env.example` 만 형태를 공유). 토큰은 사람이
고르지 않고 `register-worker` 가 32바이트 랜덤으로 생성하며, 빈 토큰은 해시 비교 전에
거부한다(`agent/src/remote/hub.ts` 의 `authenticate`). 허브는 토큰을 상수 시간
비교(`timingSafeEqual`)하고, 등록되지 않은 `workerId` 와 토큰 불일치를 같은 거부 사유로
응답해 인증 오라클을 막는다(`tokensMatch`/`DENIED_REASON`) — 대조값 자체도 프로세스마다
랜덤인 `NOT_FOUND_HASH` 라 "없는 워커" 경로는 어떤 입력으로도 맞출 수 없다. 토큰
재발급(`register-worker` 를 같은 `--id` 로 재실행)은 이전 토큰을 즉시 무효화하지만,
**이미 인증까지 끝나 연결돼 있는 워커는 끊지 않는다** — 허브는 해시를 인증 시점에만 본다.
유출된 토큰으로 이미 붙어 있는 연결을 즉시 끊어야 한다면 봇을 재시작해야 한다
(`deploy/worker-셋업.md` 참고).

## 2. 손님도 공유 워커에 연결된다 — 폴더 격리의 실제 경계

1단계부터 손님도 원격 도구를 받는다 — `role='allowed'`(소유자가 `manage_access` 로 명시적으로
등록한 동아리원)이면, 공유 워커(동아리 미니PC, `kind='shared'`)가 연결돼 있는 한 DM 에서든
서버 채널에서든 `fs_*`/`sh_exec` 가 열린다(`agent/src/core/tools.ts` 의 `allowedToolsFor`).
손님이 자기 PC 에 개인 워커를 두는 것은 여전히 지원하지 않는다 — 소유자의 구독으로 도는
작업이 소유자가 보지 못하는 기계에서 벌어지는 것을 피하려는 의도된 설계다
(`docs/superpowers/specs/2026-07-27-multi-worker-design.md` §2.1).

파일 도구(`fs_read`/`fs_write`/`fs_edit`/`fs_glob`/`fs_grep`)는 `scopeDirs`
(`agent/src/core/workerSelect.ts`)가 손님을 `<루트>/<그 손님의 디스코드 userId>/` 하위로
가둔다 — 다른 손님의 폴더나 그 폴더 밖 경로를 지정하면 봇 쪽 1차 필터에서 거부된다. 하지만
**`sh_exec` 는 이 스코프의 대상이 아니다** — 경로 인자 자체가 없어(§5 참고) `scopeDirs` 가
좁힌 폴더 목록을 아예 거치지 않는다. 셸 명령의 실행 시 작업 디렉토리(cwd)는 그 좁혀진
폴더가 되지만(`remote/executors.ts` 의 `sh_exec` 는 `roots[0]` 을 cwd 로 쓰고, 손님 호출
시 `roots` 는 이미 `scopeDirs` 로 좁혀진 값이다), `cd`·절대경로·PATH 탐색으로 그 밖에
얼마든지 접근할 수 있다. **폴더 격리는 실수를 막는 안전장치이지, 의도적으로 남의 파일을
보려는 손님을 막는 경계가 아니다** — 동아리원이 다른 동아리원의 파일을 보려고 마음먹으면
셸 하나로 충분하다. 실질적 경계는 정확히 하나, 공유 워커 프로세스를 돌리는 미니PC 의 OS
계정 권한이다.

억제 요소는 둘이다.

- `decideRoute`(`agent/src/adapters/discord.ts`)가 role 이 `owner`/`allowed` 가 아닌 사용자의
  메시지를 애초에 무시한다 — 노출 대상은 소유자가 명시적으로 등록한 동아리원뿐이다.
- 페르소나의 외부 콘텐츠 불신 규칙(`agent/src/core/persona.ts` 의 `IDENTITY`) — 다만 이는
  시스템 프롬프트 수준의 지시일 뿐 코드로 강제되는 방어가 아니다.

**완화**: 미니PC 를 관리자가 아닌 표준(비관리자) 로컬 계정으로 운영하고, 그 계정 프로필에
SSH 키·`.env`·저장된 브라우저 자격증명을 두지 않는다(`deploy/worker-셋업.md` "미니PC 셋업"
참고) — 이건 권장이 아니라 이 설계가 요구하는 전제조건이다(`docs/superpowers/specs/
2026-07-27-multi-worker-design.md` §6). 사용자별 토큰·`kind` 구분(§1)으로 워커 신원 자체는
분리돼 있으므로, 이 위험은 "워커를 사칭당하는" 문제가 아니라 "정당하게 인증된 손님이 그
스코프 밖으로 나가는" 문제다.

## 3. 하드 크래시 중 응답 전송 유실 가능성

프로세스가 디스코드 응답 전송 도중 하드 크래시하면, 그 응답 1건은 재전송되지 않는다. 생성된
텍스트 자체는 이벤트 로그에 보존되지만, 사용자에게 다시 보내 주지는 않는다. 정상적인 그레이스풀
종료(SIGTERM 등)는 flush 로 처리되어 이 유실이 없다.

**완화**: 배포 환경(PM2/Railway)은 그레이스풀 셧다운을 우선 사용하도록 운영한다. 완전한
재전송 보장이 필요해지면 응답 전송 자체를 멱등 작업 큐로 옮기는 후속 설계가 필요하다.

## 4. pg-mem 으로 검증 못 하는 보장 — READ ONLY 트랜잭션

자기인지 DB 조회(`db_query`)의 핵심 방어선은 Postgres 의 `SET TRANSACTION READ ONLY` 다
(`agent/src/store/introspectRepo.ts`). 유닛 테스트는 인메모리 Postgres 구현(pg-mem)을 쓰는데,
pg-mem 은 이 구문을 파싱하지 못해(스파이크로 확인) READ ONLY 강제를 흉내조차 내지 못한다.

**완화**: 해당 테스트는 유닛 테스트 스위트에서 명시적으로 skip 처리하고, "실제 쓰기 거부
동작"은 실 Supabase 환경에서의 스모크 테스트로만 검증하기로 문서화해 둔다
(`docs/status/STATUS.md` 참고). 사전검사(`assertReadOnlySql`)는 pg-mem 으로도 정상 검증된다 —
비어 있는 건 DB 단 방어선 하나뿐이다.

## 5. `sh_exec` — 경로로 봉쇄되지 않는 셸 실행

`fs_read`/`fs_write`/`fs_edit`/`fs_glob`/`fs_grep` 는 봇 쪽 `allowed_dirs` 1차 필터와 워커
쪽 `WORKER_ROOTS` 최종 판정, 두 겹을 통과해야 하지만(`docs/security/capability-model.md`
§경로 게이팅), `sh_exec` 는 이 두 겹 어디에도 속하지 않는다 — 셸 명령은 경로 인자 하나로
판정할 수 있는 대상이 아니다(파이프·서브셸·`cd`·PATH 탐색 등으로 인자 검사를 얼마든지
우회한다). `agent/src/remote/executors.ts` 의 `sh_exec` 실행기는 경로 검사를 시도조차 하지
않고 `spawn(command, { cwd: roots[0], shell: true })` 로 그대로 실행한다.

남는 경계는 정확히 두 가지뿐이다 — 실행 시 작업 디렉토리(공유 워커의 손님이면 `scopeDirs`
로 좁혀진 그 사람의 폴더, 그 외엔 `WORKER_ROOTS` 의 첫 번째 폴더)와, 워커 프로세스를 돌리는
OS 계정의 권한. 그 계정이 닿는 곳이라면 셸 명령은 그 cwd 밖도 얼마든지 오갈 수 있다 — 이건
이전 SDK 내장 `Bash` 도구가 가졌던 것과 같은 성격의 한계이며, 얇은 워커 전환으로 새로 생긴
약점이 아니다(`docs/decisions/0006-thin-worker.md`).

**신원 게이팅은 호출 가능한 사람을 좁히지만, 더 이상 "소유자만"이 아니다.** 미등록 사용자는
`decideRoute` 가 애초에 무시하므로 도달조차 못 하지만, 등록된 사용자(`role` 이 `owner`/
`allowed`) 안에서는 워커 연결 여부 하나가 곧 `sh_exec` 접근 여부다 — 소유자·손님 구분 없이
동일하다(Task 7, `docs/superpowers/specs/2026-07-27-multi-worker-design.md`). 손님이
공유 워커에서 이 도구를 받을 때 폴더 격리가 주는 착시와 그 한계는 §2 참고.

**완화**: 잔여 위험은 애플리케이션 코드가 아니라 **운영**으로만 줄어든다 — 워커를 최소
권한(비관리자) OS 계정으로 돌리고, `WORKER_ROOTS` 를 실제로 노출해도 되는 폴더로 좁히는
것이 유일한 실질적 완화다(`deploy/worker-셋업.md` "미니PC 셋업" 참고). 손님에게 `sh_exec`
를 여는 것은 더 이상 미래의 시나리오가 아니라 1단계의 현재 상태다 — OS 수준 격리(별도
계정/컨테이너/VM) 없이 이미 진행됐으므로, 이 문서 §2 가 그 실제 경계를 서술한다.

## 6. 읽기전용 조회 결과 크기 제한

자기인지 SQL 조회 도구(`db_query`)는 현재 애플리케이션 단(`IntrospectRepo.readOnlyQuery`)에서
`maxRows` 로 결과를 자르는 방식이다. 매우 큰 결과 집합에 대해서는 SQL 단 `LIMIT` 적용 같은
후속 개선이 필요하다 — 지금은 잘라내기 이전에 전체 결과를 한 번 받아오므로 메모리 사용량
관점에서 최적은 아니다.

**완화**: `statement_timeout` 을 함께 걸어 두어(§4) 무거운 쿼리가 오래 붙잡히지는 않는다.

## 7. 손님 폴더 안 심볼릭 링크·정션이 `fs_*` 격리를 우회한다

워커의 최종 경로 관문(`checkPath`, `agent/src/remote/roots.ts`)은 대상 경로를
`resolveRealOrNearestAncestor`(`agent/src/core/pathPermission.ts`)로 realpath 정규화한 뒤,
그 결과가 **워커의 `WORKER_ROOTS` 안**에 있는지만 확인한다 — 그 손님의 `scopeDirs` 로
좁혀진 하위 폴더 안에 있는지는 다시 확인하지 않는다. 손님의 폴더 안에 워커 루트 밖(또는
다른 손님의 폴더)을 가리키는 심볼릭 링크나 정션을 만들면, realpath 정규화 후 그 링크가
가리키는 실제 경로가 `WORKER_ROOTS` 안에만 있으면 `checkPath` 를 통과한다 — 즉 `fs_*` 가
광고하는 "자기 폴더 밖은 못 본다"는 격리를 링크 하나로 빠져나갈 수 있다.

**받아들이는 이유**: 이미 §2·§5 에서 서술했듯 같은 손님은 어차피 경로 무제한 `sh_exec` 를
갖는다 — 이 우회는 새로운 권한 상승이 아니라 그 위험에 종속된다. 폴더 격리가 막으려던 건
"의도치 않은 실수"이지 "마음먹은 우회"가 아니었으므로, 별도 대응 없이 문서화만 하고
받아들인다. 코드로 고치려면 `checkPath` 가 워커의 루트가 아니라 호출자별 스코프를 알아야
하는데, 그러면 오늘은 아예 없는 "호출자 인지 경로 관문"을 워커 쪽에 새로 만들어야 한다 —
`sh_exec` 가 이미 그 경계를 무너뜨리는 상황에서 이 비용을 들일 이유가 약하다.

## 8. 워커를 `kind='shared'`로 잘못 등록하는 것을 막는 장치가 없다

`register-worker` CLI(`agent/src/scripts/registerWorker.ts`)도 `WorkersRepo`
(`agent/src/store/workersRepo.ts`)도 어떤 물리적 기계가 실제로 공용인지 검증하지 않는다 —
운영자(소유자)가 실수로, 혹은 다른 이유로 소유자의 개인 노트북을 `--kind shared` 로
등록하면 그 순간부터 `resolveWorkerSelector`(`agent/src/core/workerSelect.ts`)의 라우팅
규칙에 따라 모든 손님이 그 노트북으로 연결된다 — 소유자의 개인 파일이 있는 기계에 동아리
전원의 `sh_exec` 가 열리는 셈이다.

**받아들이는 이유**: 이는 코드로 강제되는 방어가 아니라 순수한 운영 실수다 — "어느 물리적
기계가 공용인가"는 애플리케이션이 판단할 수 있는 사실이 아니다(등록 시점에 `--kind` 를
신중히 확인하는 것 외에 원천적으로 막을 방법이 없다). 1단계에서 실제로 존재하는 워커 행이
소유자 노트북(`personal`)과 동아리 미니PC(`shared`) 둘뿐이라 오분류의 여지가 작고, 오분류가
일어나도 그 결과(개인 기계에 공유 도구가 열림)는 관찰 가능하다 — 워커 등록 목록·`kind` 를
점검하는 것으로 스스로 확인할 수 있다.
