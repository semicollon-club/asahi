---
status: Accepted
lastReviewed: 2026-07-26
---

# 0002. Railway + 로컬 워커 하이브리드

> **갱신(2026-07-26)**: 이 ADR의 "맥락"·"결정"·"근거"는 원래 시점의 기록으로 그대로
> 남긴다. 아래에서 서술하는 조율 메커니즘(`worker_jobs` 큐 + `worker_heartbeats` 하트비트
> + `delegateToWorker` 위임)은 얇은 워커 전환(ADR 0006)으로 완전히 대체됐다 — 워커는
> 이제 대화 턴을 실행하지 않고 봇이 원격으로 호출하는 개별 도구만 실행한다. 이 ADR이
> 내린 역할 분리 자체("클라우드=상시 대화, 로컬=PC 작업, 봇 토큰 1개 제약 때문에 두
> 프로세스가 필요하다")는 여전히 유효하며 ADR 0006도 그 위에 있지만, 조율 방식은 더 이상
> DB 큐/하트비트가 아니라 WebSocket이다. 최신 토폴로지는 `docs/architecture/overview.md`,
> 최신 위임(이제는 "워커 연결") 정책은 ADR 0005 참고.

## 맥락

두 가지 요구가 동시에 있다.

1. 디스코드 봇은 토큰 1개로 동작하며, 정상적으로는 한 시점에 한 프로세스만 그 토큰으로
   접속해 있어야 한다 — 즉 "봇"이라는 역할은 단일 프로세스여야 한다.
2. 파일 읽기/쓰기·Bash 실행 같은 PC 작업은 소유자의 실제 PC 위에서만 신뢰할 수 있다.
   클라우드 컨테이너는 소유자의 PC가 아니므로 이런 작업을 대신 실행해서는 안 된다
   (`docs/security/capability-model.md`).

동시에 소유자 PC가 꺼져 있는 동안에도 대화(기억 조회, 잡담 등 PC 작업이 필요 없는
턴)는 계속 응답 가능해야 한다는 요구도 있었다 — PC 없이도 "비서가 살아있는" 경험.

## 결정

3-프로세스 하이브리드로 역할을 분리한다.

- **Railway 클라우드 봇**(`agent/src/index.ts`) — 24/7 상시 구동되는 유일한 디스코드
  연결 지점. `agent/src/config.ts`의 `deployTarget`이 정확히 `"cloud"`일 때만(그 외
  미설정·오타는 `local`) 파일/Bash 계열 도구를 도구셋에서 제외한다
  (`allowedToolsFor`/`canUseTool` 이중 방어, `agent/src/core/agent.ts`).
- **로컬 워커**(`agent/src/worker.ts`) — 소유자 PC에서 실행되며 디스코드에 전혀
  연결하지 않고, 대신 `worker_jobs` 테이블을 폴링(`POLL_MS = 2_000`)해 자신에게
  위임된 job을 실행한다. 이 워커가 실행하는 PC 작업은 언제나 워커가 실제로 돌고 있는
  그 PC 위에서 실행되므로, 소유자 PC 전권(allowedDirs 범위 안)을 그대로 쓸 수 있다.
- **조율**: 봇과 워커는 서로를 직접 호출하지 않고, 공유 Postgres(ADR 0001)의
  `worker_jobs`(`schema.ts:152`, 위임 큐)와 `worker_heartbeats`(`schema.ts:183`, 생존
  신호) 테이블만으로 느슨하게 결합된다. 봇은 하트비트가
  `WORKER_ONLINE_CUTOFF_MS`(30초)보다 오래되면 워커를 오프라인으로 간주한다.
- **위임 조건**(`AgentCore.runConversationTurn`, `agent/src/core/core.ts:229`) — 이미지
  없음 + 소유자 신원(`isOwner`) + DM(사적 대화) + 워커 온라인, 네 조건을 모두 만족할
  때만 `delegateToWorker`로 위임하고, 하나라도 어긋나면 봇이 직접 처리한다. 소유자
  신원 제한의 근거는 ADR 0005 참고.

## 근거

봇 토큰 1개 제약 때문에 "클라우드=상시 대화 담당, 로컬=PC 작업 담당"으로 역할을 나누는
것이 "PC가 꺼져도 대화 유지" + "PC 작업은 반드시 실제 PC 위에서"라는 두 요구를 동시에
만족하는 유일한 구조였다. 단일 프로세스로는 두 요구가 서로 배타적이다(PC가 꺼지면
대화도 끊기거나, 클라우드가 PC 작업을 대신 하게 되어 신뢰 경계가 깨진다).

## 결과

- 커밋 `1377fa6`(`feat(worker): worker_jobs/heartbeat 스키마 + JobsRepo + allow_dir 사용자별화`),
  `2713937`(`feat(worker): 로컬 워커 진입점 + 워커 도구셋(자기 PC 전권) + config`),
  `ee9694d`(`feat(worker): Railway 봇 DM 위임 라우팅 + 진행/결과 프록시`),
  `10aa26d`(`fix(worker): 리뷰 반영 — owner전용 위임·ownWorkstation·job멱등·요약폴백·결과배달·stale회수·마이그레이션·DB시계`).
- `worker_jobs.message_id`에 부분 유니크 인덱스를 걸어 위임 job을 트리거 메시지로
  멱등화한다(`schema.ts:173-176`) — 봇 크래시 후 재개(`recoverPending`)가 같은 메시지를
  다시 위임 시도해도 중복 실행되지 않는다.
- `delivered_ts` 컬럼과 배달 스윕(`deliverPendingJobResults`)으로, 타임아웃 뒤 뒤늦게
  끝난 job의 결과도 유실 없이 정확히 한 번 배달된다.
- 위임은 소유자 DM으로만 제한되며(ADR 0005), 서버/스레드 대화는 특정 개인 소유가
  아니므로 위임 대상이 모호해 항상 봇이 처리한다.
- 상세 토폴로지·다이어그램은 `docs/architecture/overview.md`, 실행 절차는
  `deploy/worker-셋업.md`·`deploy/railway-셋업.md` 참고.
