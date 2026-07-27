---
status: Accepted
supersedes: 0005-owner-only-delegation
lastReviewed: 2026-07-28
---

# 0007. 다중 워커 — 위치 기반 라우팅과 손님 접근 허용

## 맥락

아사히는 코딩 동아리 '세미콜론'의 마스코트 에이전트로 기획됐고, 동아리 프로젝트에 접근할 수
있어야 한다(`docs/superpowers/specs/2026-07-27-multi-worker-design.md` §1). 그런데 ADR
0005("소유자 전용 워커 위임")가 정한 정책 아래에서는 공개 서버 채널에서 PC 도구가 하나도
열리지 않았다 — 동아리 공용 미니PC 를 사서 워커를 띄워도 다음 두 곳이 소유자 전용으로 막고
있어 달라지는 게 없었다.

- `WorkerHub.handleConnection`(당시): `frame.userId === ownerId` 가 아니면 접속 자체를
  거부했다 — 소유자 아닌 워커는 애초에 붙지 못했다.
- `shouldConnectWorker`(당시 `agent/src/core/agent.ts`): `isOwner && isPrivate` 여야
  참이었다 — 공개 서버 턴은 워커 연결 여부와 무관하게 원격 도구를 받지 못했다.

0005 는 이 제약을 완화가 아니라 정책으로 정당화했다: 워커 인증 수단이 `WORKER_TOKEN`
환경변수 하나(봇과 워커 양쪽에 같은 고정값)뿐이던 시절, 손님도 자신의 워커를 붙일 수 있게
허용하면 `hello` 프레임의 신원 필드를 소유자 ID로 채운 워커를 그 토큰만 아는 누구든 접속시켜
소유자를 사칭할 수 있는 경로가 생겼다 — 사용자별 토큰·행 단위 권한 분리(RLS) 같은 인증
인프라가 없어서, 손님을 완전히 막는 것 말고는 그 경로를 코드로 메울 방법이 없었다
(`docs/security/risk-register.md` §2, 0005 갱신 이전 판).

## 결정

워커 신원을 봇·워커가 공유하는 고정값(`WORKER_TOKEN` 하나) 대신, `workers` 레지스트리
테이블(워커별 고유 `id`·`kind`·해시된 토큰, `agent/src/store/workersRepo.ts`)로 옮기고, 그
위에서 손님 접근을 연다.

- 대화 위치가 어느 워커를 쓸지 정한다(`resolveWorkerSelector`,
  `agent/src/core/workerSelect.ts`) — "어디서 말하느냐가 어느 기계냐를 정한다"는 한 줄 규칙.
  소유자 DM 은 그 소유자의 **개인** 워커(`kind='personal'`), 그 외 전부(소유자의 서버 채널,
  손님의 DM·서버)는 동아리 **공유** 워커(`kind='shared'`).
- `allowedToolsFor`(`agent/src/core/tools.ts`)의 손님 DM·서버 두 분기가 `workerConnected` 를
  보게 됐다 — `role='allowed'`(소유자가 `manage_access` 로 명시적으로 등록한 동아리원)이면
  공유 워커가 연결된 한 원격 도구(`fs_read`/`fs_write`/`fs_edit`/`fs_glob`/`fs_grep`/
  `sh_exec`)를 받는다. 폴더 관리 도구(`allow_dir`/`revoke_dir`/`list_dirs`)는 여전히 소유자
  전용이다(`canManagePc`).
- 공유 워커 위에서 손님은 `<루트>/<디스코드 userId>/` 하위로 격리된다(`scopeDirs`,
  `agent/src/core/workerSelect.ts`) — 다만 `sh_exec` 는 경로 인자가 없어 이 격리의 대상이
  아니다(`docs/security/capability-model.md` "경로 게이팅"). 이건 완화이지 봉쇄가 아니다 —
  실질적 경계는 공유 워커를 돌리는 미니PC 계정 하나뿐이다.
- 인증은 더 이상 고정 공유값이 아니다 — 각 워커가 등록 시(`register-worker` CLI,
  `agent/src/scripts/registerWorker.ts`) 발급받는 자기 고유 토큰으로 붙는다. 토큰이 새도 그
  워커 하나만 위험해진다(`docs/security/risk-register.md` §1).

## 근거 (완화 서술)

0005 가 손님을 막았던 진짜 이유는 "손님은 위험하다"가 아니라 "신원을 분리할 인프라가 없어서
사칭을 코드로 막을 방법이 없었다"였다. 이 결정은 그 인프라(워커별 고유 토큰 레지스트리)를
실제로 만들어 전제 자체를 없앴다 — 0005 를 근거 없이 뒤집는 게 아니라, 0005 가 요구했던 선행
조건("사용자별 토큰 발급·회전 같은 인증 인프라")을 갖춘 뒤에야 그 정책을 다시 여는 것이다.

**"손님도 자기 PC 에 개인 워커를 띄우게 하자"는 대안은 검토 후 기각했다**
(`docs/superpowers/specs/2026-07-27-multi-worker-design.md` §2.1). 각 동아리원이 개인 워커를
쓰면 신원 사칭 문제는 똑같이 풀리지만, **소유자의 Claude 구독으로 도는 작업이 소유자가 전혀
볼 수 없는 기계에서 벌어진다.** 턴 수(사용량)는 세어지지만 그 워커가 실제로 무엇을 했는지
추적할 방법이 없다 — 소유자 한 사람의 구독 한도를 동아리원 여럿이 나눠 쓰는 구조에서, 그
사용량이 어느 기계·어느 작업에서 나왔는지 추적할 수 없다는 건 받아들이기 어려운 손실이었다.
공유 기계 한 대로 모으면 무슨 일이 있었는지가 한 곳(그 미니PC)에 남는다. "워커가 없으면 PC
작업이 안 된다"는 손님 쪽 마찰이 사라지는 것도 개인 워커 안의 부수 효과였지만, 추적 가능성
손실을 상쇄할 만큼 크지 않았다. 손님용 개인 워커는 그래서 이번에도 지원하지 않는다
(`docs/security/risk-register.md` §2) — 이 결정이 여는 것은 "손님이 공유 기계에 연결되는
것"이지 "손님이 자기 기계를 갖는 것"이 아니다.

잃은 것(명시적으로 수용): 위협 모델이 근본적으로 바뀐다 — 공개 채널 메시지 하나가 이제 공유
기계에서 셸 명령을 이끌어낼 수 있는 턴이 된다(`docs/security/capability-model.md` "손님·공유
기계" 절). 그 대가로 미니PC 워커 계정 분리(관리자가 아닌 표준 계정, SSH 키·`.env`·저장된
브라우저 자격증명 미보관)를 권장이 아니라 요구사항으로 둔다(`deploy/worker-셋업.md`
"미니PC(윈도우) 셋업").

## 결과

- ADR 0005("소유자 전용 워커 위임")를 이 ADR이 대체한다 — 0005의 결정("워커는 소유자만
  붙을 수 있다")과 그 유일한 근거이던 전제(`WORKER_TOKEN` 환경변수 하나)가 이 범위에서 함께
  사라졌다. 0005는 폐기가 아니라 대체다 — 그 문서가 기록한 맥락(인증 인프라 부재 시절의
  정당한 판단)은 역사적 사실로 남는다.
- `agent/src/store/schema.ts`에 `workers` 테이블 추가, `allowed_dirs` 키를 `user_id`에서
  `worker_id`로 전환(`agent/src/store/allowedDirsRepo.ts`) — 옛 행의 값은 옮기지 않는다(재등록이
  이관 코드보다 싸다는 설계 판단, `deploy/worker-셋업.md` §3).
- `agent/src/remote/protocol.ts`의 `hello` 프레임이 `userId` 대신 `workerId`를 싣는다
  (`agent/src/remote/hub.ts`가 레지스트리 조회로 인증한다).
- `agent/src/config.ts`의 `Config`(봇)에서 `workerToken` 필드가 완전히 사라진다 — 봇 자신은
  더 이상 공유 비밀을 갖지 않는다. `WorkerConfig`(워커)는 여전히 `workerToken`을 갖지만, 이제
  그 값은 그 워커 하나만의 것이고 `WORKER_ID`로 함께 식별된다.
- `docs/security/capability-model.md`·`docs/security/risk-register.md`·
  `docs/architecture/overview.md`가 새 위협 모델과 능력 계층표를 반영해 갱신됐다.
- 2단계(비목표, 이 결정의 범위 밖): 손님용 개인 워커, 프로젝트 폴더·스레드 바인딩
  (`docs/superpowers/specs/2026-07-27-multi-worker-design.md` §8).
