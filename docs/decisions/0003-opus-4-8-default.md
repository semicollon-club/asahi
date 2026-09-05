---
status: Superseded
supersededBy: 0008-opus-5-default
lastReviewed: 2026-09-05
---

# 0003. `claude-opus-4-8` 기본 모델

> **대체됨(2026-09-05)**: 이 ADR 의 기본값(`claude-opus-4-8`)은 [0008](./0008-opus-5-default.md)로
> 바뀌었다 — 설정 모델과 SDK 실측 모델을 분리해 드리프트를 감지하는 구조는 0008 이 그대로
> 이어받는다. 아래 본문은 2026-07 시점의 기록이다.

## 맥락

자기인지 기능(설계 스펙: `docs/design-archive/specs/2026-07-12-self-awareness-db-introspection-design.md`)은
비서가 스스로 어떤 모델로 실행 중인지 답할 수 있어야 한다(`runtime_info` 도구). 그러려면
"설정한 모델"과 "SDK가 실제로 실행한 모델"을 구분해 관리하고, 둘이 어긋나면(예: 모델
별칭이 SDK 버전에 따라 조용히 다른 모델로 풀리는 경우) 감지할 수 있어야 한다.

## 결정

`agent/src/config.ts`의 `loadConfig`/`loadWorkerConfig`가 `model` 필드 기본값을
`"claude-opus-4-8"`로 고정한다(`config.ts:54`, `ANTHROPIC_MODEL` 환경변수로 재정의
가능). `agent/src/core/agent.ts`의 `DEFAULT_MODEL` 상수도 동일 값으로 동기화해 둔다
(`agent.ts:15`).

`makeRunAgentTurn`은 이 `model`을 SDK `query()` 옵션에 그대로 전달하고
(`agent.ts:176`), 동시에 `ctx.runtime.model`로 도구 핸들러에도 노출한다
(`runtime_info` 도구가 "설정값"으로 보고). SDK의 `init` 메시지가 돌아오면 그 안의
실제 `model` 값을 설정값과 비교해, 다르면 `console.warn`으로 로깅한다
(`agent.ts:189-192`) — 별도 알림 없이 조용히 다른 모델이 실행되는 상황을 막기 위한
실측 로깅이다.

## 근거

`claude-opus-4-8`은 이 프로젝트의 여러 적대적 코드 리뷰 라운드(`docs/decisions/review-ledger.md`
참고)에도 활용된 모델로, 상주 비서의 기본 실행 모델로 채택했다. "설정값"과 "실측값"을
분리해 두면, 모델 별칭 변경이나 SDK 업그레이드로 실제 실행 모델이 조용히 바뀌는 걸
로그로 즉시 알아챌 수 있다 — 자기인지 기능의 신뢰성 전제(비서가 스스로에 대해 보고하는
정보가 실제와 일치해야 한다)를 지킨다.

## 결과

- 커밋 `6d027c3`(`feat(self-aware): config.model 기본 claude-opus-4-8(env ANTHROPIC_MODEL)`),
  `274a0a6`(`feat(self-aware): agent 배선 — model→query·introspect·runtime·init 모델 로깅`).
- `WorkerConfig`(로컬 워커 설정)도 봇과 동일한 기본값을 공유한다(`config.ts:85`) —
  워커가 실행하는 턴도 같은 모델 정책을 따른다.
- 자기인지 DB 조회 도구(`db_schema`/`db_query`)와 `runtime_info`는 모두 소유자 DM
  게이팅(`isOwnerDm`)을 통과해야 도달한다 — 상세는 ADR 0004.
