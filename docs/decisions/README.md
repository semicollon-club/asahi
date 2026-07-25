---
lastReviewed: 2026-07-26
---

# 결정 기록 (ADR) 인덱스

이 디렉터리는 Asahi 비서의 주요 아키텍처 결정을 기록한다. 코드 주석이 인용하는
`리뷰 #N`/`보안리뷰 #N` 마커(예: `agent/src/core/core.ts:222`의 "리뷰 #3")는 지금까지
숫자만 가리키고 실제 문서가 없었다 — 이 디렉터리가 그 정본이다.

## 형식 (경량 MADR)

전체 [MADR](https://adr.github.io/madr/) 대신 4개 섹션만 쓰는 경량 형식을 쓴다.

- **맥락(Context)** — 어떤 문제·제약이 이 결정을 요구했는가.
- **결정(Decision)** — 무엇을 선택했는가(코드 근거 포함).
- **근거(Rationale)** — 왜 그 선택인가, 다른 선택지는 왜 배제했는가.
- **결과(Consequences)** — 이 결정이 남긴 트레이드오프·후속 제약·관련 커밋.

각 ADR 파일 상단에는 YAML front-matter를 둔다.

```yaml
---
status: Accepted
lastReviewed: 2026-07-13
---
```

`status`는 현재 `Accepted`만 쓴다(아직 `Superseded`된 결정 없음). 결정이 뒤집히면 새
ADR을 추가하고 옛 ADR의 `status`를 `Superseded`로 바꾸며 `supersededBy`로 새 ADR을
가리킨다.

## ADR 목록

| # | 제목 | 요약 |
| --- | --- | --- |
| [0001](./0001-sqlite-to-postgres.md) | SQLite → Postgres 이전 | 클라우드 상시 구동 + 다PC 공유를 위해 better-sqlite3(FTS5)에서 Supabase Postgres(advisory lock)로 이전 |
| [0002](./0002-railway-local-worker-hybrid.md) | Railway + 로컬 워커 하이브리드 | 봇 토큰 1개 제약 아래 클라우드=메인 상시봇·로컬=PC작업 워커로 역할을 분리 |
| [0003](./0003-opus-4-8-default.md) | `claude-opus-4-8` 기본 모델 | 설정 모델과 SDK 실측 모델을 분리해 별칭 드리프트를 감지 가능하게 함 |
| [0004](./0004-readonly-tx-introspection.md) | READ ONLY 트랜잭션 기반 자기조회 | 애플리케이션 가드(1차) + Postgres `READ ONLY` 트랜잭션(2차, 핵심 방어선)의 다층 방어 |
| [0005](./0005-owner-only-delegation.md) | 소유자 전용 워커 위임 | 인증 인프라(사용자별 토큰/RLS) 부재 상태에서 손님 워커 연결을 정책으로 차단(2026-07-26 갱신: 메커니즘을 얇은 워커 기준으로 교체) |
| [0006](./0006-thin-worker.md) | 워커를 얇은 실행기로 전환 | 워커에서 SDK·DB 접근을 제거하고 봇이 개별 도구 호출만 원격으로 위임하도록 재설계 — `DATABASE_URL`/`CLAUDE_CODE_OAUTH_TOKEN` 대신 `WORKER_TOKEN` 하나로 축소 |

관련 리뷰 이력은 [`review-ledger.md`](./review-ledger.md)를 참고한다.

## 관련 문서

- 현재 아키텍처: `docs/architecture/overview.md`
- 능력 계층·경로 게이팅: `docs/security/capability-model.md`
- 알려진 한계(완화 서술): `docs/security/risk-register.md`
- 폐기된 과거 설계: `docs/design-archive/README.md`
