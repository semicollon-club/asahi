---
lastReviewed: 2026-09-05
---

# 풀 하네스 · 미니PC 단일 호스트 — 구현 계획

설계: [2026-09-05-full-harness-worker-design.md](../specs/2026-09-05-full-harness-worker-design.md). 이 계획은 그
스펙의 §11 단계를 태스크로 쪼갠다. 각 태스크는 실패하는 테스트를 먼저 쓰고, `npm test`·`npm run typecheck`·
`node scripts/check-docs.mjs` 셋을 통과한 뒤 커밋한다(`docs/agent-onboarding.md`). 단계 하나가 PR 하나다.

**시작 전(운영자)**: 스펙 §4.4 프로브를 구독 토큰으로 한 번 돌린다(2단계의 전제). 0·1단계는 그 결과와 무관하다.

## 0단계 — 파일 반환

**상태(2026-09-05 저녁): 0.1~0.4 구현 완료.** 실환경 스모크(`deploy/smoke-test.md` 의 파일 반환 세 항목)는 아직이다.
계획과 다른 점 하나 — `remote/protocol.ts` 는 고치지 않았다: `call` 프레임이 도구 이름·인자를 그대로 나르므로
`send_file` 에 프레임 변경이 필요 없었다. 토큰은 `upload.token` 인자로 실려 가고 주소는 워커가 `HUB_URL` 에서 유도한다.

| # | 태스크 | 파일 | 테스트 | 완료 기준 |
|---|---|---|---|---|
| 0.1 | 작업 토큰: `mint`/`verify`(HMAC-SHA256, 작업 id·부원·대화·만료). 비밀은 부팅마다 난수 — 발급과 검증이 같은 프로세스라 설정이 필요 없다 | `agent/src/core/jobToken.ts` | `jobToken.test.ts` — 서명·만료·변조 거절 | 순수 함수 |
| 0.2 | 봇 HTTP `POST /files`: 토큰 검증 → 바이트 수신(상한 8MB) → 대화 채널로 첨부 이벤트 | `agent/src/core/fileReturn.ts`, `index.ts` 라우팅, `events/bus.ts`(`assistant_file` 이벤트), `adapters/discord.ts`(첨부 전송) | `fileReturn.test.ts` — 토큰 없음 401·상한 초과 413·성공 시 이벤트 | 이벤트버스 5번째 이벤트. 어댑터는 진행 표시를 건드리지 않는다(턴 중 부수 전송) |
| 0.3 | 얇은 워커 원격 도구 `send_file(path)`: 봇이 토큰을 주입(sh_exec 의 git 인자와 같은 자리) → 워커가 경로 게이트 뒤 HTTP 로 올린다. 업로드 주소는 `HUB_URL` 에서 유도 | `remote/protocol.ts`, `remote/executors.ts`, `core/remoteTools.ts`, `core/tools.ts`, `persona.ts` | `remoteExecutors.test.ts`(가짜 HTTP)·`remoteTools.test.ts`·`tools.test.ts`·`persona.test.ts` | "이 이미지 보내줘" → 디스코드 첨부 |
| 0.4 | 문서: 스모크 항목, 능력 모델(도구 하나), 모듈 경계(이벤트 5개) | `deploy/smoke-test.md`, `docs/security/capability-model.md`, `docs/architecture/module-boundaries.md` | 문서 가드 | |

## 1단계 — 봇 이사(미니PC 계정 A)

코드는 최소, 절차가 본체다.

| # | 태스크 | 파일 | 테스트 | 완료 기준 |
|---|---|---|---|---|
| 1.1 | 허브 바인드 설정 `HUB_BIND`(기본 `0.0.0.0` 유지, 미니PC 는 `127.0.0.1`) | `config.ts`, `index.ts`, `.env.example` | `config.test.ts` | 루프백에만 묶인 허브에 밖에서 붙지 못한다 |
| 1.2 | 봇 커밋을 `RAILWAY_GIT_COMMIT_SHA` 대신 git 에서 읽기(`ASAHI_GIT_COMMIT` env 우선, 없으면 `.git/HEAD` 해석) | `core/agent.ts`(runtime), `core/gitCommit.ts`(순수 함수) | `gitCommit.test.ts` | `runtime_info` 가 미니PC 에서도 봇 커밋을 보고 |
| 1.3 | 자동 갱신 스크립트 일반화: 대상 작업 이름·클론 폴더·시작 명령을 인자로 — A 의 `asahi-bot` 과 B 의 `asahi-worker` 가 같은 스크립트를 각자의 작업으로 돈다 | `deploy/update-worker.ps1` → `deploy/update-service.ps1` | PowerShell 5.1 하네스(운영자 PC, 지금 관례) | 두 작업이 각자 갱신·재시작 |
| 1.4 | 셋업 문서 `deploy/minipc-단일호스트-셋업.md`: 계정 A 생성, 클론, `.env` 이관표(Railway 변수 → A), 작업 스케줄러 둘, 컷오버·롤백 순서, 보안 체크리스트(§9) | 문서 | 문서 가드 | 운영자가 이 문서만으로 컷오버 |
| 1.5 | 컷오버(운영자) 뒤 스모크: 대화·정기 게시·워커 도구·PR 추적이 미니PC 봇에서 돈다 | `deploy/smoke-test.md` 항목 | — | `runtime_info` 봇 커밋 = 워커 커밋 |

## 2단계 — 프록시 + 세션 러너(소유자 턴만)

| # | 태스크 | 파일 | 테스트 | 완료 기준 |
|---|---|---|---|---|
| 2.1 | 인증 프록시 `/llm/v1/*`: `127.0.0.1` 바인드, 작업 토큰 검증, Authorization 교체, 베타 헤더 보정, SSE 통과 | `core/llmProxy.ts`, `index.ts` | `llmProxy.test.ts` — 가짜 업스트림으로 경로 거절·401·헤더 교체·스트림 통과 | 프로브(`llmProxyProbe.ts`)가 봇 프록시를 향해도 같은 결과 |
| 2.2 | 프레임 넷 `turn.start/event/result/cancel` | `remote/protocol.ts` | `remoteProtocol.test.ts` | 옛 프레임과 공존 |
| 2.3 | 세션 러너: `turn.start` → 그 폴더에서 `query()`(env: BASE_URL·AUTH_TOKEN·CONFIG_DIR·git) → 이벤트 → 결과. `WORKER_MODE=harness` | `remote/sessionRunner.ts`, `worker.ts` | `sessionRunner.test.ts` — 가짜 `query`, 이벤트 매핑(`progressFromMessage` 재사용), 취소, 세션 id | B 에 자격증명 없이 턴이 돈다 |
| 2.4 | 프로필 계산(신원 → 모델·effort·내장 도구·MCP·플러그인·서브에이전트) | `core/profiles.ts` | `profiles.test.ts` — 네 신원 | 소유자 = 전부, 손님 = §6 기본값 |
| 2.5 | 소유자 DM 라우팅: 개인 워커가 없으면 공유 워커(관리자 스코프) | `core/workerSelect.ts` | `workerSelect.test.ts` | 소유자 DM 에서 미니PC 도구가 열린다 |
| 2.6 | 봇 디스패치: 원격 도구가 열리는 소유자 턴에서 `runTurn` 대신 `turn.start`(플래그 `HARNESS_OWNER=true`) | `core/agent.ts`, `core/core.ts`, `remote/hub.ts` | `agent.test.ts`·`coreMulti.test.ts`·`remoteHub.test.ts` | 진행 표시·`actions`·resume 이 같은 모양 |
| 2.7 | 워커 셋업 문서에 `WORKER_MODE=harness` | `deploy/worker-셋업.md` | 문서 가드 | |

## 3단계 — 프록시 운영화

| # | 태스크 | 완료 기준 |
|---|---|---|
| 3.1 | 모델 고정(본문 `model` = 프로필 모델) | 다른 모델 요청은 400 + 기록 |
| 3.2 | 사용량 표 `llm_usage`(작업·부원·입력/출력 토큰·모델·시각), `runtime_info`·`db_query` 에서 조회 | 턴마다 행 하나 |
| 3.3 | 부원별 창 상한(토큰·턴) — `turns.reserve` 옆에. 429 → 한국어 사유, 소유자 우선 | 초과·한도가 사용자 문구로 |
| 3.4 | 장애 폴백: 러너 없음·프록시 오류 → 봇 쪽 도구 없는 턴 + 사유 | 워커를 꺼도 대화는 된다 |

## 4단계 — MCP 허브·브라우저·플러그인·파일 반환 로컬화

| # | 태스크 | 완료 기준 |
|---|---|---|
| 4.1 | MCP 허브(계정 A): stdio 서버를 루프백 HTTP MCP 로(`/mcp/<이름>`, 작업 토큰) — 첫 서버 GitHub(읽기) | 소유자 세션에서 `mcp__github__*` |
| 4.2 | Supabase(읽기 전용 역할)·Railway 허브 서버 — 소유자 프로필만 | 디스코드에서 표 조회 |
| 4.3 | B 의 공유 브라우저 MCP(Playwright 서버 하나, 세션별 컨텍스트) + `send_file` 로 캡처 반환 | localhost 화면이 첨부로 |
| 4.4 | 플러그인 설치 절차(B 계정) + 프로필의 플러그인 목록 | 공개 플러그인 하나가 손님 프로필에서 돈다 |
| 4.5 | `send_file` 을 세션 쪽 인프로세스 MCP 도구로(엔드포인트 동일) | 얇은 도구 없이 파일 반환 |

## 5단계 — 부원 개방 + 자원 관리 + Railway 종료

| # | 태스크 | 완료 기준 |
|---|---|---|
| 5.1 | 동시 실행 상한(러너 세마포어, 기본 2) + 대기열 진행 표시 "앞에 M명" | 3번째 턴이 기다린다 |
| 5.2 | 손님 프로필 개방(플래그 제거) | 부원 세션이 새 경로 |
| 5.3 | 격리 실검증 스모크: B 의 셸에서 A 의 `.env`·프로세스 환경 읽기 시도가 거부된다, 작업 토큰은 밖에서 안 통한다 | 스모크 통과 |
| 5.4 | Railway 종료 + 재개 절차 문서 | 문서 |

## 6단계 — 얇은 도구 은퇴

원격 `fs_*`·`sh_exec`·`proc_*`·발행 실행기·`remoteTools.ts` 1차 필터 제거, `remote/protocol.ts` 옛 프레임 삭제,
ADR 0002·0006 대체 ADR, 능력 모델·위험 등록부·온보딩 함정 절 재작성(기계 두 대 함정 삭제).

## 미해결

- 프록시 뒤 **구독 OAuth 수용 여부**(스펙 §4.4 — 운영자 프로브).
- **동시 실행 상한** 값 — 미니PC 사양을 보고(5.1).
- 디스코드 첨부 상한과 큰 산출물(영상 등) — 0단계에서 상한을 두고 초과는 안내로.
- 로컬 Postgres 로의 이전 — 이 계획 밖. Supabase 유지.
