---
status: Accepted
lastReviewed: 2026-07-28
---

# 0006. 워커를 얇은 실행기로 전환

## 맥락

로컬 워커(ADR 0002)는 이름과 달리 명령 실행기가 아니라 두 번째 에이전트였다. 봇이 사용자
메시지 원문을 `worker_jobs` 큐에 넣으면(`AgentCore.delegateToWorker`, 이제 삭제됨), 워커는
`buildContextBlock`으로 대화 이력·요약·기억을 **자신이 직접** DB에서 읽고,
`buildSystemPrompt`로 시스템 프롬프트를 **자신이 직접** 조립하고, 자신의 Claude Agent SDK
세션(`query()`)을 **자신이 직접** 호출하고, 결과를 `messages` 테이블에 **자신이 직접**
썼다(`agent/src/worker/jobRunner.ts`, 이 태스크로 삭제됨). 봇은 위임을 결정한 뒤 손을 떼고
job 결과만 폴링해 디스코드로 흘려보낼 뿐이었다.

이 구조는 워커에 강한 자격증명 두 개를 요구했다 — Postgres 전체 접근권(`DATABASE_URL`)과
소유자의 Claude 구독 토큰(`CLAUDE_CODE_OAUTH_TOKEN`). ADR 0005·`docs/security/
risk-register.md`(구판)가 이미 지적했듯, `DATABASE_URL` 하나만으로도 그 값을 손에 넣은
사람이 스스로 워커를 띄워 `WORKER_USER_ID`를 소유자 ID로 설정해 소유자를 사칭할 수 있었다 —
인증(`WORKER_SECRET` 검증)도 행 단위 권한 분리(RLS)도 구현돼 있지 않았기 때문이다. 손님용
워커를 지원하려면 이 공백을 먼저 메워야 했는데, 두 자격증명을 나눠주는 모델 자체가 그 작업을
계속 어렵게 만들고 있었다. 또한 위임된 대화의 SDK 세션이 워커 PC 쪽에 생겨 봇이 그 세션을
`resume`할 수 없는 문제도 있었다(`core.ts`의 리뷰 #4(MED) 주석, 이제 해당 코드 자체가
삭제됨).

설계 검토(`docs/superpowers/specs/2026-07-25-thin-worker-design.md`)는 대안 두 가지를
기각했다 — HTTP 롱폴링(턴 하나에 도구 호출이 수십 번 일어나 폴링 주기만큼 지연이 누적된다)과
"DB를 우편함으로 쓰되 권한만 제한"(없애려던 DB 의존을 축소된 형태로 도로 들이고, 호출마다
DB 왕복이 추가된다).

## 결정

워커에서 SDK 호출과 DB 접근을 완전히 제거했다. 이제:

- **모든 대화 턴은 예외 없이 봇 프로세스 안에서 실행된다** — `AgentCore.runConversationTurn`
  (`agent/src/core/core.ts`)은 더 이상 위임 분기를 갖지 않는다(커밋 `6235ecc`).
- 워커는 봇이 아웃바운드 WebSocket(`/worker`)으로 여는 허브(`agent/src/remote/hub.ts`의
  `WorkerHub`)에 접속해, `hello` 프레임으로 `WORKER_TOKEN` **하나만** 제시해 인증한다 —
  DB 자격증명도 모델 접근 권한도 별도로 요구하지 않는다는 뜻이다(`agent/src/config.ts`의
  `loadWorkerConfig`는 `databaseUrl`도 `model`도 요구하지 않는다). 이 문서가 쓰인 시점에는
  그 토큰이 봇·워커 전체가 공유하는 고정값 하나였다 — 워커별로 서로 다른 토큰을 갖는 것은
  이후 [0007](./0007-multi-worker-routing.md)이 도입한 변경이다. "인증 수단이 토큰
  하나뿐"이라는 자격증명의 **개수**(1개)는 지금도 그대로다 — 바뀐 건 그 1개가 봇 전체의
  공유값이었다가 워커 하나만의 고유값이 됐다는 점이다.
- 봇의 SDK 세션이 모델 호출 중 파일/셸 도구를 쓰면, 그 개별 호출 하나만 WebSocket으로
  워커에 전달되고 결과를 기다린다(`agent/src/core/remoteTools.ts`의 `remoteToolHandler` →
  `WorkerHub.call`). SDK 내장 Read/Write/Edit/Glob/Grep/Bash는 `agent/src/core/agent.ts`가
  `tools: []`로 전부 닫고, 그 대신 인프로세스 MCP 도구 6종(`fs_read`/`fs_write`/`fs_edit`/
  `fs_glob`/`fs_grep`/`sh_exec`, `agent/src/core/tools.ts`)이 원격 호출을 감싼다. 도구를
  `remote_exec` 하나로 뭉치지 않고 여섯 개로 나눈 이유는, 어떤 호출이 어떤 경로를 건드리는지
  구조적으로 알 수 있어야 봇 쪽 1차 경로 필터가 인자 파싱에만 의존하지 않기 때문이다.
- 경로 검사는 두 계층으로 나뉜다 — 봇 쪽 `allowed_dirs` 1차 필터(`remoteToolHandler`)와
  워커 쪽 `WORKER_ROOTS` 최종 판정(`agent/src/remote/roots.ts`의 `checkPath`). 자세한 내용은
  `docs/security/capability-model.md` "경로 게이팅" 참고.
- 판정 축이 "어디서 실행 중인가"(`deployTarget`)에서 "그 사용자의 워커가 지금 붙어
  있는가"(`shouldConnectWorker`, `agent/src/core/agent.ts`)로 바뀐다 — cloud 배포라도 워커가
  연결되면 원격 도구가 열린다(`docs/security/capability-model.md` 참고).
- `worker_jobs`/`worker_heartbeats` 테이블은 DDL을 그대로 남기되(마이그레이션 위험 회피)
  코드는 더 이상 읽거나 쓰지 않는다(`agent/src/store/schema.ts` 주석).

## 근거 (완화 서술)

얻은 것: 워커의 자격증명이 `WORKER_TOKEN` 문자열 하나로 줄었다 — 그 문자열 하나로는
Postgres도 소유자의 Claude 구독도 건드릴 수 없다(이 문서가 쓰인 시점엔 그 문자열이 봇·워커
전체의 공유값이었고, [0007](./0007-multi-worker-routing.md) 이후로는 워커별 고유값이다 —
어느 쪽이든 "그 문자열 하나로 Postgres·Claude 구독은 못 건드린다"는 이 문단의 핵심은 바뀌지
않는다). 봇과 워커 세션이 물리적으로 나뉘어 있던
문제(resume 불가)도 성립 자체가 사라진다 — 세션은 이제 봇에만 있다. 워커 온라인 판정도
DB 하트비트 대신 살아있는 WebSocket 연결(`hub.isConnected`)로 바뀌어 더 정확해졌고 DB
접근이 필요 없어졌다.

잃은 것(명시적으로 수용): 원격 `fs_*` 도구는 SDK 내장 Read/Write/Edit만큼 정교하지 않다
(부분 읽기·치환 검증 등이 그만큼 다듬어져 있지 않다) — Railway 컨테이너의 파일시스템과
워커의 파일시스템이 다른 기계이므로 내장 도구를 그대로 쓸 수 없는 이상 피할 수 없는
비용이다. `sh_exec`는 경로로 봉쇄할 수 있는 대상이 아니다 — 실행 시 cwd(`WORKER_ROOTS[0]`)와
워커 프로세스의 OS 권한만이 경계다. 이건 옛 SDK `Bash` 도구도 갖고 있던 것과 같은 성격의
한계이며, 셸을 경로 검사로 봉쇄하려는 시도 자체를 하지 않기로 했다(2단계 컨테이너 격리
전까지는 남는 한계 — `docs/security/risk-register.md` §5 참고). 클라우드 배포에서 워커가
연결되면 PC 작업이 가능해지는 것도 이 설계가 의도적으로 만든 효과이지 부작용이 아니다 —
"워커가 붙어 있는가"가 유일한 판단 기준이며, 그 판단 자체는 소유자 신원 확인(§아래)과
별개다.

## 결과

- 커밋 범위 `86e67ca..6235ecc` — 프로토콜(`86e67ca`), 워커 루트 경로 검사(`91fe2b8`,
  `147e4a0`, `a35eb81`), 실행기 6종(`4309e62`, `9cfb471`), 봇 쪽 허브(`5600c59`, `f8296ea`),
  워커 WS 클라이언트(`10b9db5`, `cbb4b1a`), 원격 도구 6종 + 능력 계층 배선(`0662a14`,
  `34098b8`), 허브 기동 배선 + 워커 재작성(`db6af91`, `881f894`), 위임 기계장치 삭제
  (`6235ecc`).
- `agent/src/worker/jobRunner.ts`·`agent/src/store/jobsRepo.ts`(대부분)·
  `agent/tests/workerJobRunner.test.ts`가 삭제됐다(`worker/` 디렉토리 자체가 사라졌다).
  `worker_jobs`·`worker_heartbeats` 테이블 DDL은 남지만 미사용이다
  (`agent/src/store/schema.ts`).
- 지금 걱정해야 할 자격증명은 `DATABASE_URL`이 아니라 `WORKER_TOKEN`이다(다중 워커 전환
  [0007](./0007-multi-worker-routing.md) 이후로는 워커별 고유 토큰) —
  `docs/security/risk-register.md` §1·§2와 ADR 0005를 이 경계에 맞춰 갱신했다. ADR
  0005("소유자 전용 워커 위임")가 전제하던 메커니즘(작업 큐, 하트비트 `isOnline` 판정)은
  이 태스크로 이미 사라졌다. **"워커는 소유자만 붙일 수 있다"는 정책 자체는 이 태스크
  시점에는(2026-07-26 갱신까지는) 새 메커니즘(`shouldConnectWorker`의 `isOwner && isPrivate`,
  `remoteToolHandler`의 `isOwnerDm` 재확인)으로 그대로 이어졌지만, 그 정책은 이후
  [0007](./0007-multi-worker-routing.md)이 뒤집었다** — 사용자별 토큰 인프라(바로 위 항목)가
  갖춰지면서, 그 인프라가 없어서 손님을 막아야 했던 0005의 전제 자체가 사라졌기 때문이다. 이
  문단은 이 태스크(얇은 워커 전환) 시점의 정확한 기록으로 남기고, 현재 정책은 0007을 따른다.
- `ownWorkstation`(손님이 자기 PC 워커 위에서 파일/Bash 전권을 갖는 개념, ADR 0002/0005의
  일부)은 `allowedToolsFor`에서 제거됐다(Task 8) — 새 구조에서는 실행이 항상 봇에서
  일어나고 워커는 도구 하나를 대신 실행할 뿐이므로, "누구의 PC에서 실행 중인가"라는 축
  자체가 없어졌다. `ToolCtx.ownWorkstation`/`TurnContext.ownWorkstation` 필드와
  `canManagePc`의 관련 분기는 코드에 남아 있지만 생산자가 없어 항상 `undefined`다(죽은
  코드 — `docs/security/capability-model.md` 참고).
- 이미지가 있는 턴을 위임하지 않던 옛 제약(ADR 0002)도 성립 자체가 사라졌다 — 위임이라는
  개념이 없어졌으므로, 이미지가 있는 턴에서도 같은 턴 안에서 원격 도구를 쓸 수 있다.
- 2단계(비목표, 이번 범위 밖): 워커 토큰 발급/회전/사용자별 토큰, 손님용 워커, 공유
  워크스페이스, 워커 도커화·컨테이너 격리(`docs/superpowers/specs/
  2026-07-25-thin-worker-design.md` §10).
