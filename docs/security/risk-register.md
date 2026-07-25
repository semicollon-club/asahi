---
lastReviewed: 2026-07-26
---

# 위험 등록부 (Risk Register)

알려진 한계를 완화 관점에서 정리한다. 정확한 사칭 절차·재현 페이로드 같은 악용 세부는
싣지 않는다 — 여기서는 위협의 성격과 현재 완화책만 서술한다. 상세 능력 계층은
`docs/security/capability-model.md` 참고.

## 1. `WORKER_TOKEN` 취급

`WORKER_TOKEN` 은 지금 이 프로젝트에서 "누가 소유자의 워커로 인증되는가"를 가르는 유일한
비밀이다(`agent/src/config.ts` — 봇 쪽 `loadConfig`, 워커 쪽 `loadWorkerConfig` 모두 필수로
요구하며, 봇 쪽은 최소 20자 미만이면 시작 자체를 거부한다). 이 값이 유출되면, 그 값을 아는
사람이 스스로 봇의 `/worker` WebSocket 허브에 접속해 `hello` 프레임으로 인증에 성공할 수
있다 — 1단계는 사용자별 토큰이 아니라 소유자 한 명을 위한 고정값이므로, 인증 성공은 그 접속을
"소유자의 워커"로 등록하는 것과 사실상 같다(`agent/src/remote/hub.ts` 의
`WorkerHub.handleConnection`).

등록에 성공한 뒤 할 수 있는 일은 원래 워커가 하던 것과 동일하다 — 모델이 그 접속 위로 보내는
`fs_read`/`fs_write`/`fs_edit`/`fs_glob`/`fs_grep`/`sh_exec` 호출을 전부 받아 실행하고,
결과(`result` 프레임)를 조작해 돌려줄 수 있다 — 허브는 그 접속이 보낸 결과를 그대로 신뢰한다.
반대로 이 값 하나로는 Postgres(`DATABASE_URL`)에도, 소유자의 Claude 구독
(`CLAUDE_CODE_OAUTH_TOKEN`)에도 접근할 수 없다 — 워커는 이제 이 두 자격증명을 아예 갖지
않는다(`docs/decisions/0006-thin-worker.md`).

**완화**: `.env` 는 저장소에 커밋하지 않는다(`.env.example` 만 형태를 공유). 봇은 빈 값이거나
20자 미만인 `WORKER_TOKEN` 으로는 시작 자체를 거부한다(`agent/src/config.ts`). 허브는 토큰을
상수 시간 비교(`timingSafeEqual`)하고, 토큰 오류와 신원(`userId`) 불일치를 같은 거부 사유로
응답해 인증 오라클을 막는다(`agent/src/remote/hub.ts` 의 `tokensMatch`/`DENIED_REASON`). 원격
도구(`fs_*`/`sh_exec`)는 소유자 DM(`isOwner && isPrivate`)일 때만 열리며, 이 신원 확인은
`shouldConnectWorker`(`agent/src/core/agent.ts`)와 `remoteToolHandler`(`agent/src/core/
remoteTools.ts`)의 `isOwnerDm` 재확인, 두 곳에서 각각 이뤄진다 — 그래서 손님 DM 은 워커가
연결돼 있어도 원격 도구 자체가 노출되지 않는다(아래 §2 참고).

## 2. 사용자별 워커 토큰 미구현 — 손님용 워커 미지원

손님용 워커(자기 PC 로 작업을 위임)를 지원하려면 워커 접속이 실제로 그 접속을 요청한
사용자의 것임을 구분하는 사용자별 토큰 발급·회전이 필요하다. 1단계는 이게 없다 —
`WORKER_TOKEN` 은 소유자 한 명을 위한 고정값이고, `hello` 의 `userId` 는
`DISCORD_OWNER_ID` 와 정확히 일치해야만 인증된다(`agent/src/remote/hub.ts`). 허브도 동시에
소유자 연결 하나만 유지한다(`dropExisting` — 같은 신원으로 재연결하면 이전 연결을 밀어낸다).

**완화**: 정책으로 막는다 — `shouldConnectWorker`(`agent/src/core/agent.ts`)와
`remoteToolHandler` 의 `isOwnerDm` 재확인(`agent/src/core/remoteTools.ts`) 모두
`isOwner && isPrivate` 를 요구하므로, 손님 DM 은 워커가 연결돼 있어도 원격 도구 자체가
노출·실행 어느 쪽도 되지 않는다. 사용자별 토큰 발급·회전·손님용 워커 라우팅은 2단계 몫이다
(`docs/superpowers/specs/2026-07-25-thin-worker-design.md` §10 비목표).

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

남는 경계는 정확히 두 가지뿐이다 — 실행 시 작업 디렉토리(`WORKER_ROOTS` 의 첫 번째 폴더)와,
워커 프로세스를 돌리는 OS 계정의 권한. 그 계정이 닿는 곳이라면 셸 명령은 `WORKER_ROOTS` 밖도
얼마든지 오갈 수 있다 — 이건 이전 SDK 내장 `Bash` 도구가 가졌던 것과 같은 성격의 한계이며,
얇은 워커 전환으로 새로 생긴 약점이 아니다(`docs/decisions/0006-thin-worker.md`).

**완화**: 신원 게이팅(소유자 DM + 워커 연결)으로 호출 가능한 사람 자체를 좁힌다
(`docs/security/capability-model.md` §능력 계층표) — 손님·서버 대화는 원격 도구 자체가
노출되지 않는다. 그 안에서의 잔여 위험은 애플리케이션 코드가 아니라 **운영**으로만 줄어든다
— 워커를 최소 권한 OS 계정으로 돌리고, `WORKER_ROOTS` 를 실제로 노출해도 되는 폴더로 좁히는
것이 유일한 실질적 완화다. 손님에게 `sh_exec` 를 여는 시나리오(향후 손님 샌드박스)는 OS
수준 격리(별도 계정/컨테이너/VM) 없이는 진행하지 않는다 — 2단계 범위 밖이다.

## 6. 읽기전용 조회 결과 크기 제한

자기인지 SQL 조회 도구(`db_query`)는 현재 애플리케이션 단(`IntrospectRepo.readOnlyQuery`)에서
`maxRows` 로 결과를 자르는 방식이다. 매우 큰 결과 집합에 대해서는 SQL 단 `LIMIT` 적용 같은
후속 개선이 필요하다 — 지금은 잘라내기 이전에 전체 결과를 한 번 받아오므로 메모리 사용량
관점에서 최적은 아니다.

**완화**: `statement_timeout` 을 함께 걸어 두어(§4) 무거운 쿼리가 오래 붙잡히지는 않는다.
