---
lastReviewed: 2026-07-28
---

# 기여 가이드 (CONTRIBUTING)

이 문서 하나만 읽으면 셋업 → 테스트 → 실행 → 아키텍처 파악까지 순서대로 갈 수 있도록
정리했다. 처음 이 리포를 여는 기여자든, 오랜만에 돌아온 소유자 본인이든 여기서 시작하면
된다.

> **에이전트가 읽고 있다면** [docs/agent-onboarding.md](docs/agent-onboarding.md)를 먼저 봐라.
> 이 문서는 셋업 절차이고, 그쪽은 작업 방식과 이 환경의 함정(계정 분리, PowerShell 5.1,
> 배포 순서, PM2 의 거짓 신호, cmd.exe 인용 경계)을 모은 것이다.

## 사전 요구사항

- **Node.js 22 이상** (`agent/package.json`의 `engines.node`가 강제한다)
- **git**
- Discord 계정 + 테스트용 봇 애플리케이션(Discord Developer Portal에서 생성) — 실제로
  봇을 띄워보려는 경우에만 필요하고, 테스트만 돌릴 때는 없어도 된다(아래 "테스트" 참고)

## 환경변수 준비

`.env`는 리포 루트(`<repo>/.env`)에 둔다. 항목별 설명은 [.env.example](.env.example)에
전부 있고, 그중 실제로 봇을 실행해보려면 다음 세 가지를 직접 발급받아야 한다.

- **`DISCORD_OWNER_ID`** — 본인의 디스코드 사용자 ID. 디스코드 앱에서 설정 → 고급 →
  **개발자 모드** 켜기 → 내 프로필 우클릭 → **ID 복사하기**.
- **`CLAUDE_CODE_OAUTH_TOKEN`** — 터미널에서 `claude setup-token`을 실행하면 구독
  기반 OAuth 토큰이 발급된다. 로컬(`DEPLOY_TARGET` 미설정 또는 `local`)에서는 선택이지만,
  클라우드 배포(`DEPLOY_TARGET=cloud`)에서는 사실상 필수다 — 없으면 에이전트 SDK가
  인증하지 못해 턴 처리가 실패한다.
- **`DATABASE_URL`** — Supabase Postgres 연결 문자열. 반드시 **Session pooler** 형식
  (`aws-0-<region>.pooler.supabase.com:5432`, `postgres.<project-ref>` 사용자명)을 써야
  한다. Direct connection은 IPv6 전용이라 대부분 환경에서 연결이 안 된다. 발급 절차와
  형식 예시는 [deploy/railway-셋업.md](deploy/railway-셋업.md)의 "DATABASE_URL" 절 참고.

## 셋업

```powershell
cd agent
npm install
```

## 테스트 (DB 불필요)

```powershell
npm test            # vitest, 1회 실행
npm run test:watch  # 감시 모드
npm run typecheck   # tsc, src + tests 전부 타입 검사
```

`npm run typecheck`를 따로 두는 이유가 있다. `npm run build`가 쓰는 `tsconfig.json`은
`include`가 `src`뿐이라 **테스트 파일은 타입 검사를 받지 않는다** — `dist/`에 테스트를 함께
내보내지 않으려면 그래야 한다. 그런데 vitest는 esbuild로 타입을 지우고 실행하므로 타입 오류를
잡지 않는다. 그 결과 "가짜 객체가 실제 타입과 어긋나는" 종류의 문제가 양쪽 어디에도 안 걸린다
— 실제로 `CoreRepos`에 필드를 추가했을 때 테스트의 가짜 repos가 그 필드를 빠뜨린 것을 `tsc`도
`vitest`도 잡아 주지 않았고, 코드의 `try/catch`가 삼켜 조용히 기능이 빠진 채 통과했다.
`tsconfig.check.json`은 `noEmit`으로 `src`와 `tests`를 함께 검사한다. **테스트를 고친 뒤에는
`npm test`와 함께 이것도 돌린다.**

테스트는 [pg-mem](https://github.com/oguimbal/pg-mem)으로 Postgres를 인메모리에 흉내
내므로, `DATABASE_URL` 같은 실제 DB 연결 없이도 전부 돌아간다. 처음 셋업한 뒤 가장 먼저
`npm test`부터 돌려서 통과하는지 확인하는 걸 권장한다.

## 실행 (로컬 개발)

```powershell
npm run dev
```

`.env`(루트, `DATABASE_URL` 등 필수 환경변수)가 있어야 실제로 디스코드에 연결해 동작한다.
`npm run dev`는 `tsx src/index.ts`를 바로 실행하므로 빌드 없이 TypeScript를 그대로 돈다.

## 워커 (PC 작업 실행)

워커(`agent/src/worker.ts`)는 소유자 PC 또는 동아리 공용 미니PC에서 파일/Bash 같은 PC 작업을
대신 실행해주는 별도 프로세스다(하이브리드 구조는 [docs/architecture/overview.md](docs/architecture/overview.md)
참고, `docs/decisions/0007-multi-worker-routing.md`). 먼저 워커를 레지스트리에 등록해 토큰을
발급받는다(`cd agent && npx tsx src/scripts/registerWorker.ts --id <이름> --kind personal --user <소유자
디스코드 ID>` — 공용 워커는 `--kind shared`로, `--user`는 생략). 그 뒤 `.env`에 `WORKER_ID`
(등록한 `--id`와 같은 값)·`WORKER_TOKEN`(등록 시 콘솔에 한 번만 출력된 토큰)·`HUB_URL`·
`WORKER_ROOTS`를 채우고 `npm run worker`로 실행한다. 자세한 건
[deploy/worker-셋업.md](deploy/worker-셋업.md) 참고.

## 빌드 / 프로덕션 실행

```powershell
npm run build   # tsc, dist/ 로 컴파일
npm start       # node dist/index.js
```

24/7 상시 구동은 개발용 `npm run dev`가 아니라 Railway 또는 로컬 PM2를 쓴다 — 절차는
[deploy/railway-셋업.md](deploy/railway-셋업.md), [deploy/PM2-명령어.md](deploy/PM2-명령어.md)
참고.

## 아키텍처 파악하기

코드를 고치기 전에 먼저 구조를 훑어보자. [docs/architecture/](docs/architecture/)에
현재(살아있는) 아키텍처 문서가 있다:

- `overview.md` — 3-프로세스(Railway 봇 / 로컬 워커 / Supabase Postgres) 토폴로지, 위임 규칙
- `data-flow.md` — 메시지 → 저장 → 응답 경로
- `module-boundaries.md` — 디렉토리별 책임과 허용 의존 방향
- `glossary.md` — `deployTarget`, `rapportStage` 같은 코드 안 용어 정의

## 설계 문서 히스토리

과거 스펙·구현 계획·조사 노트는 원문 그대로 [docs/design-archive/](docs/design-archive/)에
보존돼 있다(완료/Shipped 또는 이후 설계가 바뀐/Superseded 표시가 각 문서 상단에 있다). 지금도
진행 중인 SDD(스펙 주도 개발) 작업물은 `docs/superpowers/`에 있고, 완료되면 이후 별도
작업으로 design-archive로 옮겨진다.

## 개발 방식 — TDD를 기대한다

이 리포는 스펙 → 구현 계획 → (테스트 우선) 구현 순서로 작업해왔다(과거 사례는
design-archive의 `specs/`·`plans/` 참고). 새 기능이나 버그 수정을 넣을 때도 먼저 실패하는
테스트를 `agent/tests/`에 작성한 뒤 통과시키는 순서를 기대한다. `npm test`가 항상 통과하는
상태를 유지한다.

## 커밋 규약

커밋 제목은 `feat:` / `fix:` / `docs:` / `refactor:` / `test:` / `chore:` 같은 접두사로
시작하고, 본문은 한국어로 "무엇을" 보다 "왜"에 집중해 짧게 쓴다. Claude(에이전트)가 주도해서
만든 커밋은 말미에 다음 줄을 정확히 그대로 붙인다:

```
Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
```

## 더 읽을거리

- 문서 전체 인덱스: [docs/README.md](docs/README.md)
- 현재 단계·미완 항목: [docs/status/STATUS.md](docs/status/STATUS.md)
- 보안 정책·위협 모델: [SECURITY.md](SECURITY.md)
- 다른 PC에서 이어서 운영하기: [deploy/다른-PC-셋업.md](deploy/다른-PC-셋업.md)
