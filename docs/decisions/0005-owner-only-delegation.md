---
status: Accepted
lastReviewed: 2026-07-26
---

# 0005. 소유자 전용 워커 위임

> **갱신(2026-07-26)**: 이 ADR이 원래 기록한 메커니즘(작업 큐 `worker_jobs` + 공유
> `DATABASE_URL` + 하트비트 `isOnline` 판정으로 대화 턴 전체를 위임)은 얇은 워커 전환
> (ADR 0006)으로 완전히 대체됐다. **"워커는 소유자만 붙을 수 있다"는 결정 자체는 바뀌지
> 않았다** — 오늘의 코드가 그 결정을 어떻게 집행하는지를 아래 내용으로 갱신했다. 원래의
> 위임 큐 메커니즘을 다룬 역사적 맥락은 ADR 0002·0006과 `docs/decisions/review-ledger.md`
> "리뷰 #1–#7"에 남아 있다.

## 맥락

지금 워커가 붙는 방식(얇은 워커, ADR 0006)에서 유일한 인증 수단은 `WORKER_TOKEN`
환경변수 하나다(`agent/src/config.ts`) — 사용자별 토큰이 아니라 봇과 워커 양쪽에 같은
값을 넣는 고정값이다. 이 상태에서 손님도 자신의 워커를 붙일 수 있게 허용하면, `hello`
프레임의 `userId`를 소유자 ID로 채운 워커를 누구든(그 토큰만 알면) 접속시켜 소유자를
사칭할 수 있는 경로가 생긴다 — 사용자별 토큰·행 단위 권한 분리(RLS) 같은 인증 인프라가
아직 없기 때문이다(`docs/security/risk-register.md` §2).

## 결정

원격 도구(`fs_read`/`fs_write`/`fs_edit`/`fs_glob`/`fs_grep`/`sh_exec`)는 신원
(`isOwner`, `userId === config.ownerId`)이 소유자이고 대화가 DM(`isPrivate`)일 때만
열린다. `role`이 아니라 신원으로 판정하므로, `manage_access`로 어떤 사용자에게
`role='owner'`를 부여해도 신원이 소유자와 다르면 대상이 되지 않는다. 이 판정은 두
곳에서 각각 이뤄진다.

1. **도구 노출** — `shouldConnectWorker`(`agent/src/core/agent.ts`):
   ```
   context.isOwner && context.isPrivate && hub.isConnected(context.userId)
   ```
   참이어야 `ctx.remote`가 채워지고 `allowedToolsFor`가 원격 도구 6종을 도구셋에 넣는다.
2. **실행 시 재확인** — `remoteToolHandler`(`agent/src/core/remoteTools.ts`)의
   `isOwnerDm(ctx) = ctx.isOwner && ctx.isPrivate`. 도구셋 계산이 어긋나더라도(예:
   `ctx.remote`가 실수로 채워지는 배선 버그) 이 재확인이 마지막 방어선이 된다 — 다른
   특권 핸들러(`db_query`의 `isOwnerDm`, `allow_dir`의 `canManagePc`)와 같은 이중
   게이팅 원칙이다.

손님 DM·서버/스레드 대화는 워커가 연결돼 있어도 원격 도구 자체가 도구셋에 나타나지
않는다 — `allowedToolsFor`가 그 두 분기에서는 `workerConnected` 값을 아예 참조하지
않는다(`agent/src/core/tools.ts`). 한도 예약(rate limit)은 이 판정과 독립적으로 이미
끝나므로, 손님 한도는 원격 도구 사용 여부와 무관하게 동일하게 적용된다.

## 근거 (완화 서술)

사용자별 토큰 발급·회전, 행 단위 권한 분리(RLS) 같은 인증 인프라가 갖춰지기 전까지는
고정값 하나(`WORKER_TOKEN`)에만 의존하는 신뢰 경계가 완전하지 않다. 그 공백을 코드로
메우는 대신, 정책으로 워커 연결 대상을 소유자 한 명으로 좁혀 사칭 경로 자체를 원천
차단하는 쪽을 택했다 — 손님용 워커를 아예 지원하지 않으면 "누가 그 워커를 소유했는가"를
검증할 필요 자체가 없어진다. 이 근거는 ADR 0002 시절과 본질적으로 같다 — 바뀐 건 신뢰
경계가 지키는 대상(대화 턴 전체 위임 → 개별 도구 호출)과 유출 시 위험 범위
(Postgres+Claude 구독 → 그 워커의 `WORKER_ROOTS` 폴더, `docs/security/risk-register.md`
§1)뿐이다. 정확한 사칭 절차나 재현 방법은 여기 싣지 않는다.

## 결과

- ADR 0006(얇은 워커 전환)이 이 결정의 집행 메커니즘을 통째로 바꿨다 — 자세한 커밋
  범위는 그쪽 참고.
- `docs/security/risk-register.md` §1(`WORKER_TOKEN` 취급)·§2(사용자별 워커 토큰
  미구현)에 같은 위험이 완화 서술로 갱신돼 기록돼 있다.
- `.env.example`과 `deploy/worker-셋업.md`에도 "워커는 소유자 전용"이 명시돼 있다.
- 손님용 워커를 지원하려면 사용자별 토큰 발급·회전과 RLS 구현이 선행돼야 한다 — 별도
  보안 작업이며 2단계 범위 밖이다(`docs/superpowers/specs/2026-07-25-thin-worker-design.md`
  §10 비목표).
- 이미지가 있는 턴을 위임하지 않던 옛 제약(`images.length === 0`)은 성립 자체가
  사라졌다 — 위임(대화 턴 전체를 워커로 넘기는 것) 자체가 없어졌으므로, 이미지가 있는
  턴에서도 같은 턴 안에서 원격 도구를 쓸 수 있다(ADR 0006 참고).
