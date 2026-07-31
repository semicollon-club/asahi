---
status: Accepted
lastReviewed: 2026-07-13
---

# 0004. READ ONLY 트랜잭션 기반 자기조회

## 맥락

자기인지 기능은 소유자에게 비서의 스키마와 데이터를 자유 형식 SQL로 직접 조회하게
해준다(`db_schema`/`db_query` 도구). 모델이 생성한 임의의 SQL 문자열을 실행하는
구조이므로, 실수든 프롬프트 인젝션이든 어떤 경로로도 쓰기(INSERT/UPDATE/DELETE/DDL)가
일어나지 않는다는 보장이 필요하다 — 그것도 SQL 파서 하나에만 의존하지 않는 보장이어야
한다.

## 결정

두 단계 방어를 쌓는다.

1. **1차 방어(애플리케이션 단)** — `agent/src/core/sqlGuard.ts`의 `assertReadOnlySql`.
   주석을 제거한 뒤, 다중 문장(끝의 세미콜론 하나를 뺀 나머지에 세미콜론이 남아 있으면
   거부)과 첫 단어가 `SELECT`/`WITH`가 아닌 문장을 거부하는 순수 함수다. 파일 자체
   주석이 명시하듯 이건 "완전한 SQL 파서가 아니라 명백한 쓰기/다중문을 빠르게 거부하는"
   1차 방어일 뿐이다 — 예컨대 `WITH x AS (DELETE … RETURNING *) SELECT …`처럼 문두가
   `WITH`인 쓰기 CTE는 이 사전검사를 통과한다.
2. **2차 방어(DB 단, 핵심 방어선)** — `agent/src/store/introspectRepo.ts`의
   `IntrospectRepo.readOnlyQuery`. 쿼리를 실행하기 전에 `SET TRANSACTION READ ONLY`로
   Postgres 트랜잭션 자체를 읽기 전용으로 만들고(`introspectRepo.ts:36`), 이 `SET`은
   `.catch(() => {})`로 절대 에러를 삼키지 않는다 — 실패하면 쿼리 자체를 실행하지 않고
   위로 던진다(`introspectRepo.ts:33-35` 주석). 사전검사를 뚫은 쓰기 시도가 있어도
   DB 엔진이 최종적으로 거부하는 게 진짜 보장이다. `SET LOCAL statement_timeout`과
   `maxRows` 절단으로 무거운 조회로부터도 방어한다.

`db_schema`/`db_query`/`runtime_info`는 소유자 DM 게이팅(`isOwnerDm`)을 통과해야만
도달하므로(`agent/src/core/tools.ts`), 이 SQL 가드 자체는 소유자 DM 밖에서는 실행되지
않는다.

> **개정(2026-08-01)** — `runtime_info` 는 이 게이팅에서 빠져 `ctx.isOwner` 하나로 판정한다.
> 소유자가 공유 미니PC 에 닿는 곳이 서버 채널뿐이라 그 기계의 버전을 물어볼 장소가 없었기
> 때문이다. 이 문단의 SQL 가드 서술에는 영향이 없다 — `runtime_info` 는 SQL 을 실행하지
> 않는다. `db_schema`/`db_query` 는 그대로 소유자 DM 전용이다.
> (`docs/security/capability-model.md` 의 능력 계층표가 현행 기준이다.)

## 근거

순수 애플리케이션 가드만으로는 SQL 문법의 미묘한 변형(CTE, 서브쿼리 등)을 전부 막는다고
확신하기 어렵다. 진짜 방어를 애플리케이션 로직이 아니라 DB 엔진의 트랜잭션 격리
수준에 맡기면, 가드 로직에 어떤 우회가 있어도 최종 보장은 무너지지 않는다(다층 방어,
defense in depth) — 1차 가드는 "빠른 거부로 사용자 경험을 낫게" 하는 역할이고, 2차가
"실제 안전"을 책임진다.

## 결과

- 커밋 `5cfa577`(`feat(self-aware): IntrospectRepo — schema + READ ONLY 트랜잭션 readOnlyQuery`),
  `274a0a6`(`feat(self-aware): agent 배선 — model→query·introspect·runtime·init 모델 로깅`).
- `pg-mem`은 `SET TRANSACTION READ ONLY` 구문 자체를 파싱하지 못한다(스파이크로 확인 —
  구문 오류, `introspectRepo.ts:5-6`). 즉 이 핵심 보장(사전검사를 뚫은 쓰기도 DB가
  거부한다)은 유닛테스트로 검증할 수 없고, 실 Supabase를 쓰는 스모크 테스트로만 확인
  가능하다(`deploy/smoke-test.md`).
- 상세 능력 계층·게이팅 순서는 `docs/security/capability-model.md`의 "READ ONLY SQL
  가드" 절을 참고.
