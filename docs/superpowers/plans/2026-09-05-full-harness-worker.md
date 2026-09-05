---
lastReviewed: 2026-09-05
---

# 풀 하네스 워커 — 구현 계획

설계: [2026-09-05-full-harness-worker-design.md](../specs/2026-09-05-full-harness-worker-design.md). 이 계획은 그
스펙의 §11 단계를 태스크로 쪼갠다. 각 태스크는 실패하는 테스트를 먼저 쓰고, `npm test`·`npm run typecheck`·
`node scripts/check-docs.mjs` 셋을 통과한 뒤 커밋한다(`docs/agent-onboarding.md`). 단계 하나가 PR 하나다.

**시작 전 결정(운영자)**: 자격증명 종류(스펙 §4.3 — API 키 권장), 공유 기계 격리 수준(§5). 0·1단계는 두 결정을
기다리지 않는다 — 1단계는 운영자 개인 PC 에서 돌고, 프록시는 어느 자격증명이든 끼워 넣을 수 있다.

## 0단계 — 파일 반환

| # | 태스크 | 파일 | 테스트 | 완료 기준 |
|---|---|---|---|---|
| 0.1 | 작업 토큰 모듈: `mintJobToken`/`verifyJobToken`(HMAC-SHA256, 작업 id·부원·만료·모델) | `agent/src/core/jobToken.ts` | `jobToken.test.ts` — 서명·만료·변조 거절 | 순수 함수. 비밀은 `config.jobTokenSecret`(env `JOB_TOKEN_SECRET`, 없으면 프록시·파일 수신 비활성) |
| 0.2 | 봇 HTTP 에 `POST /files`: 작업 토큰 검증 → 바이트 수신(상한) → 그 작업의 대화 채널에 첨부 | `agent/src/index.ts`(라우팅), `agent/src/core/fileReturn.ts`, `adapters/discord.ts`(첨부 전송 seam) | `fileReturn.test.ts` — 토큰 없음 401·상한 초과 413·성공 시 어댑터 호출 | 어댑터는 `send_attachment` 이벤트 하나로 받는다(이벤트버스 5번째 이벤트) |
| 0.3 | 얇은 워커 원격 도구 `send_file(path)`: 경로 게이트(fs_read 와 같은 1차 필터) → 워커가 HTTP 로 올린다 | `remote/protocol.ts`, `remote/executors.ts`, `core/remoteTools.ts`, `core/tools.ts`, `persona.ts` | `remoteExecutors.test.ts`·`remoteTools.test.ts`·`tools.test.ts`·`persona.test.ts` | 부원이 "이 이미지 보내줘" → 디스코드 첨부 |
| 0.4 | 문서: 스모크 항목, 능력 모델(도구 하나), `.env.example`(`JOB_TOKEN_SECRET`) | `deploy/smoke-test.md`, `docs/security/capability-model.md`, `.env.example` | 문서 가드 | |

## 1단계 — 프록시 + 세션 러너(운영자 개인 PC, L0)

| # | 태스크 | 파일 | 테스트 | 완료 기준 |
|---|---|---|---|---|
| 1.1 | 인증 프록시: `/llm/v1/*` 만 허용, 작업 토큰 검증, Authorization 교체, 베타 헤더 보정, SSE 통과 | `agent/src/core/llmProxy.ts`, `index.ts` 라우팅 | `llmProxy.test.ts` — 가짜 업스트림(로컬 http)으로 경로 거절·401·헤더 교체·스트림 통과 | 프로브(`llmProxyProbe.ts`)가 봇 프록시를 향해도 같은 결과 |
| 1.2 | 프레임 넷(`turn.start/event/result/cancel`) 타입·검증 | `remote/protocol.ts` | `remoteProtocol.test.ts` | 옛 프레임과 공존 |
| 1.3 | 워커 세션 러너: `turn.start` → 그 폴더에서 `query()`(env: BASE_URL·AUTH_TOKEN·CONFIG_DIR·git) → 이벤트 스트림 → 결과 | `agent/src/remote/sessionRunner.ts`, `worker.ts`(`WORKER_MODE=harness`) | `sessionRunner.test.ts` — 가짜 `query` 주입, 이벤트 매핑(`progressFromMessage` 재사용), 취소, 세션 id 전달 | 워커에 자격증명이 없어도 턴이 돈다(프록시 덕) |
| 1.4 | 봇 디스패치: 원격 도구가 열리는 턴에서 `runTurn` 대신 `turn.start`(소유자 DM 한정 플래그 `HARNESS_OWNER_DM=true`) | `core/agent.ts`(`makeRunAgentTurn` 분기), `core/core.ts`, `remote/hub.ts`(프레임 중계) | `agent.test.ts`·`coreMulti.test.ts`·`remoteHub.test.ts` | 진행 표시·`actions` 기록·세션 resume 이 지금과 같은 모양으로 남는다 |
| 1.5 | 프로필 계산: `allowedToolsFor` 결과를 프로필(내장 도구 목록·MCP·플러그인)로 바꾸는 순수 함수 | `core/profiles.ts` | `profiles.test.ts` — 네 신원 × 워커 유무 | 소유자 DM 프로필 = 내장 전부 + 스킬 |
| 1.6 | 워커 셋업 문서 갱신, ADR 초안(0006 부분 대체 — 5단계에서 확정) | `deploy/worker-셋업.md`, `docs/decisions/` | 문서 가드 | 운영자 PC 에서 `WORKER_MODE=harness` 로 기동 |

## 2단계 — 프록시 운영화

| # | 태스크 | 완료 기준 |
|---|---|---|
| 2.1 | 모델 고정(본문 `model` 검사) | 다른 모델 요청은 400 + 기록 |
| 2.2 | 사용량 기록 표 `llm_usage`(작업·부원·입력/출력 토큰·모델·시각) + `runtime_info`/`db_query` 에서 조회 | 턴마다 행 하나 |
| 2.3 | 부원별 토큰 예산(시간당·일당) — `turns.reserve` 옆에 | 초과 시 프롬프트 전에 거절 문구 |
| 2.4 | 장애 폴백: 프록시·워커 장애 시 봇 쪽 도구 없는 턴으로, 사용자에게 사유 | 워커를 꺼도 대화는 된다 |

## 3단계 — MCP 허브·브라우저·플러그인

| # | 태스크 | 완료 기준 |
|---|---|---|
| 3.1 | 봇의 MCP 허브: stdio 서버를 HTTP MCP 로 노출(`/mcp/<이름>`, 작업 토큰) — 첫 서버 GitHub(읽기) | 소유자 세션에서 `mcp__github__*` 가 보인다 |
| 3.2 | Supabase(읽기 전용 역할)·Railway 허브 서버 — 소유자 프로필만 | 디스코드에서 표를 조회한다 |
| 3.3 | 워커 로컬 브라우저 MCP + `send_file` 로 캡처 반환 | localhost 개발서버 화면이 첨부로 온다 |
| 3.4 | 플러그인 설치 절차(워커 기계) + 프로필의 플러그인 목록 | 공개 플러그인 하나가 손님 프로필에서 돈다 |

## 4단계 — 공유 미니PC 격리(§5 결정 뒤)

| # | 태스크 | 완료 기준 |
|---|---|---|
| 4.1 | 샌드박스 러너 추상화(`none`/`account`/`container`) | 1단계의 L0 이 `none` 구현 |
| 4.2 | 선택한 수준의 구현 + 워커 셋업 문서 | 두 부원이 동시에 각자 격리 안에서 세션 |
| 4.3 | 손님 프로필 개방 + 스모크(격리 실검증: 한쪽 셸이 다른 쪽 폴더·토큰에 닿지 않는다) | 스모크 통과 |

## 5단계 — 얇은 도구 은퇴

원격 `fs_*`·`sh_exec`·`proc_*`·발행 실행기 제거, `remoteTools.ts` 의 1차 필터 제거(격리가 실행 단위로 옮겨간
뒤라 역할이 없다), ADR 0006 대체 ADR 확정, 능력 모델·위험 등록부 재작성.

## 미해결

- 프록시 뒤 **구독 OAuth 수용 여부**(스펙 §4.4 — 운영자가 프로브로 확정).
- 공유 미니PC 의 **격리 수준**(스펙 §5).
- 디스코드 첨부 상한과 큰 산출물(영상 등) — 0단계에서 상한을 두고 초과는 안내로 끝낸다.
