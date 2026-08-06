---
lastReviewed: 2026-08-06
---

# Changelog

이 프로젝트는 [Keep a Changelog](https://keepachangelog.com/ko/1.1.0/) 형식을 따른다. 다만
버전 태그 없이 지속 배포되는 상주 에이전트 프로젝트라 **semver 대신 개발 단계(Phase)**로 묶는다.
최신 단계가 위, 가장 오래된 단계(Phase 1)가 아래에 오도록 최신순으로 정렬했다. 각 항목은 실제
커밋 이력(`git log --oneline --no-merges`, 총 108개, 병합 커밋 제외)을 근거로 큐레이션했으며,
괄호 안은 근거 커밋의 짧은 해시다.

## [페르소나 제거] 캐릭터 페르소나·표정 이미지 제거 — 2026-08-05 ~ 2026-08-06

캐릭터 연기(고정 인격·표정 이미지·즉흥 신상 기억·친근도)를 걷어내고 이름('아사히')과 동아리
봇 역할만 남긴 평범한 어시스턴트로 교체한 단계. **DB 의 `character_images` 테이블과
`scope='character'`로 저장된 `memories` 행은 지우지 않았다** — 코드 어디서도 더 이상 읽지
않지만 기존 데이터는 그대로 남아 있다(스키마 정의만 부팅 SQL에서 빠졌을 뿐 DROP은 실행되지
않는다). 소유자는 `db_query`로 그 행들을 **볼 수만** 있다 — 읽기 전용 도구라 지우지는 못한다
(SELECT/`WITH` 외의 문장을 거부하고 트랜잭션도 READ ONLY로 연다). 실제로 지우려면 봇 밖에서
데이터베이스에 직접 접속해야 한다.

### Added
- 캐릭터 페르소나·표정 이미지 제거 설계 스펙 + 구현 계획(TDD 5태스크) (`bb8cd81`, `137c834`,
  `d7147ac`)

### Removed
- 표정 이미지 기능 전체 — `[표정:이름]` 마커 파서·이미지 카탈로그 리포·업로드 스크립트·이미지
  53파일·어댑터의 표정 배선 (`52797f2`, `ab1be27`)
- 16세 고등학생 고정 인격·자기 서사·소유자/손님/서버별 반말-존댓말 분기 — 담백한 존댓말
  하나로 통일 (`5cc7e25`)
- `character_fact` 도구와 컨텍스트 블록의 `## 내 설정` 섹션(4섹션 → 3섹션) (`f853a7d`)
- 누적 대화 수 기반 친근도(rapport) 3단계 (`9984437`)

### Changed
- 안전 규칙 셋(프롬프트 인젝션 가드·이모지 금지·작업 사실 조작 금지)을 캐릭터 블록에서
  정체성 블록으로 이전 (`5cc7e25`, `9eba0f3`)
- `/새세션`이 세션 리셋·컨텍스트 바닥선 두 가지만 수행 — 캐릭터 설정 전역 삭제 동작 제거
  (`f853a7d`)

### Fixed
- 캐릭터 제거 리뷰 후속 6건 — 캐릭터 회귀 가드 실효화, 능력 안내 상호참조 복원, 사실성
  목록의 도구 이름 누출 제거 (`9eba0f3`, `17482ca`)

## [문서화] 문서 체계 구축 — 2026-07-13 (진행 중)

`docs/documentation-system` 브랜치. 기존 코드는 바꾸지 않고 문서 taxonomy를 세우는 단계.

### Added
- 문서 체계 구축·최신화 설계 스펙 + 구현 계획(7 Phase·22 태스크, TDD) (`5cb32f9`, `8138777`)
- 문서 taxonomy 폴더 스캐폴드 + 인덱스 스텁 (`6fc8048`)
- 프로젝트 상태·로드맵 문서(`docs/status/`)를 리포로 승격, 새니타이즈 (`a0c59a7`)
- 보안 능력모델·위험등록부·`SECURITY.md` 승격, 완화 서술로 재정리 (`357120a`)
- 아키텍처 개요 + 3-프로세스 토폴로지 다이어그램 (`aba0d83`)
- 메시지 수명주기·데이터 흐름 문서 (`321c4d9`)
- 모듈 경계·이벤트버스 계약 + 용어집 (`2757b39`)
- `CONTRIBUTING.md` — 셋업→테스트→실행→아키텍처 온보딩 (`e5abe3d`)
- 로컬 워커 실행·검증 런북 (`1df8b51`)
- 장애·크래시복구 런북 + Supabase 트러블슈팅 (`22956d1`)
- 배포 후 스모크 테스트 체크리스트 (`84024da`)
- ADR 5건 + 리뷰 원장 — 코드 안 `리뷰 #N` 마커 정본화 (`9d77195`)

### Changed
- 완료된 설계/계획 문서 13건을 `docs/design-archive/`로 이동 + 상태 스탬프 (`6c7a4f2`)
- `README.md`를 Postgres/Railway/워커 현실로 재작성 (`b36e918`)
- README 다른-PC 운영 문단 정확화(기억은 Supabase 중앙) (`aa2bd6e`)
- 다른-PC-셋업 가이드를 Postgres 중앙화 현실로 수정 (`1e4b845`)
- PM2 문서에 Railway 폴백 배너 + 윈도우 자동실행 절차 흡수 (`3e06c08`)
- `.env.example`에 `ANTHROPIC_MODEL` 추가 (`f99d668`)

### Removed
- `.gitignore`에 `*.txt` 추가 + 낡은 SQLite 잔재 정리 (`7e37ac4`)

## [이미지 입력] 디스코드 이미지 입력(멀티모달) — 2026-07-12

### Added
- 이미지 입력(멀티모달) 설계 스펙 + 구현 계획(TDD 4태스크) (`f28f4ee`, `7adf632`)
- `images.ts` — 첨부 필터·마커·다운로드(순수 함수 + 주입 `fetch`) (`a42e7a9`)
- `user_message` 이벤트에 `images` 필드 추가 + 어댑터 첨부 캡처 (`729179b`)
- agent 멀티모달 prompt — `buildMultimodalMessage` + async-iterable 입력 (`0c1c4d3`)
- core 배선 — 마커 저장, 이미지 턴은 위임하지 않고 봇이 직접 처리, 다운로드→`runTurn` 연결 (`e36e10d`)

### Fixed
- 다운로드 실패 시 사용자 안내 추가 + `IMAGE_LIMITS` 상수 동결 (`7215725`)

## [자기인지 DB] Introspection + Opus 4.8 — 2026-07-12

소유자 DM 전용 도구로 스키마 조회·읽기전용 SQL 질의·런타임 정보를 제공하는 조각.

### Added
- 자기인지(DB introspection) 설계 스펙 + 구현 계획(TDD 6태스크) (`d31a779`, `0a8d207`, `de030e1`, `1b6c935`)
- `config.model` 기본값을 `claude-opus-4-8`로(env `ANTHROPIC_MODEL`로 재정의 가능) (`6d027c3`)
- `sqlGuard` — `assertReadOnlySql` + `formatQueryResult`(순수 함수) (`69959b0`)
- `IntrospectRepo` — schema 조회 + `READ ONLY` 트랜잭션 `readOnlyQuery` (`5cfa577`)
- `db_schema`/`db_query`/`runtime_info` 도구 + 소유자 게이팅 (`73b502a`)
- agent 배선 — model→query·introspect·runtime, init 시 실측 모델 로깅 (`274a0a6`)
- persona 안내에 자기인지 도구 반영 + 봇·워커 introspect·모델 배선 (`790b069`)

### Changed
- `db_query` 성공경로 스텁 검증 + `db_schema` 테스트 + 상수 중복 제거 (`63a562c`)
- persona DB 안내 테스트를 새 줄 고유 문자열로 강화(local·cloud) (`039f91a`)

## [페르소나] Asahi 캐릭터 · 친근도 — 2026-07-12

### Added
- Asahi 캐릭터/페르소나 설계 스펙 + 구현 계획(TDD 5태스크) (`8848680`, `eccfa99`)
- `MessagesRepo.countUserMessages` — 친근도 파생 소스 (`702f27d`)
- `deriveRapportStage` 순수 헬퍼(친근도 3단계) (`244a854`)
- Asahi 캐릭터 5블록 재작성 + 관계·말투(친근도) 반영 (`d44879d`)
- core 대화 턴 + 워커 PC작업 턴에 친근도(`rapportStage`) 주입 (`40aa35b`, `9adca08`)

### Changed
- rapport owner stage1·guest stage2 브랜치 테스트 커버리지 보강 (`6078485`)

### Fixed
- DM 세션에 캐릭터가 반영되도록 — 흉내-방지 컨텍스트 + 예약어 세션 리셋 (`7983186`)
- 최종리뷰 반영 — `messages(user_id,role)` 인덱스 + 테스트파일 정리 + 스펙 정정 (`15907fb`)

## [로컬 워커] 소유자 PC 위임 — 2026-07-12

### Added
- `worker_jobs`/`heartbeat` 스키마 + `JobsRepo` + `allow_dir` 사용자별화 (`1377fa6`)
- 로컬 워커 진입점 + 워커 도구셋(자기 PC 전권) + config (`2713937`)
- Railway 봇 DM 위임 라우팅 + 진행/결과 프록시 (`ee9694d`)

### Fixed
- 리뷰 반영 — owner 전용 위임·`ownWorkstation`·job 멱등·요약 폴백·결과 배달·stale 회수·마이그레이션·DB 시계 (`10aa26d`)

## [Railway 배포] 클라우드 상시구동 — 2026-07-12

### Added
- Dockerfile + `.dockerignore` + Railway 배포 문서 (`2c2cf23`)
- `DEPLOY_TARGET=cloud` 시 PC 도구 비활성 + 안내(로컬 워커 대기) (`a2938a2`)

### Fixed
- resume 세션 없음 시 새 세션 폴백(클라우드 컨테이너 재시작 대응) (`56f3b14`)

## [Postgres 이전] SQLite → Supabase Postgres — 2026-07-12

### Added
- db 계층 `pg` Pool + Postgres 스키마 + `pg-mem` 테스트 + `SettingsRepo` 파일럿 (`cb28bea`)
- 다른 PC 운영 셋업 가이드 최초 작성 + README 갱신 (`d184481`, 이후 문서화 단계에서 Postgres
  중앙화 현실로 재정정됨)

### Changed
- Repo 8개 async pg 리팩터(FTS→ILIKE, turns advisory lock) (`d390b45`)
- 호출부 await 전파 + config `DATABASE_URL` + `migrate` 제거 — Postgres 이전 완료 (`ffae8a0`)

### Fixed
- 리뷰 반영 — 크래시복구(ingest/turn 분리)·어댑터 순서직렬화·검색 오매칭·미사용 의존성 제거 (`b939679`)

## [원격 개발] Phase A — 허용 폴더 기반 PC 작업 — 2026-07-12

소유자 DM에서 허용 폴더 안 파일·Bash 전권을 부여하는 조각.

### Added
- 경로 판정 순수함수 + `AllowedDirsRepo` (`9064a6f`)
- 허용폴더 관리 도구(allow/revoke/list_dir) + 소유자 도구셋(Bash+dir) 배선 (`002fd74`)
- `canUseTool`로 파일·Bash를 허용폴더로 집행 + `additionalDirectories` + persona 반영 (`d30acb8`)

### Fixed
- 보안리뷰 반영 — Glob pattern 경로집행·cwd 검사·Bash 봉쇄 정직화·심링크 허용폴더 (`f3a2d14`)

## [Phase 2B] 멀티유저 런타임 — 2026-07-12

### Added
- 2B(멀티유저 런타임) 구현 계획 + Task1 스파이크(SDK 인프로세스 도구·discord 스레드 API) (`b1d8f8b`, `58088c8`)
- config 멀티유저 한도 (`7fed768`)
- 디스코드 멀티채널·스레드·역할게이트·채널별 전송체인 (`2aca072`)
- 코어 재작성 — 대화별 세션·대화락·프라이버시 주입·turns 한도 (`e8ce792`)
- 기억·접근관리 도구 + 턴별 도구셋(role·DM 게이트) (`d677724`)
- 진입점 배선 — 마이그레이션·새 코어·멀티채널 어댑터 (`4b3c392`)
- 소유자는 사용량 한도 완전 면제(무제한) (`dc09846`)
- persona 프롬프트 최적화 — 이모지 금지 + 답변 품질 강화 (`f26c188`)
- 진행 이벤트 파이프라인 — bus `ProgressEvent` + agent `onProgress` + core 발행 (`e350d67`)
- 디스코드 실시간 UI — 감지 반응 + 진행 상태 메시지(편집·throttle) (`ff926b7`)

### Changed
- PM2 운영 명령어·윈도우 자동실행 절차 문서화 (`7352229`)

### Fixed
- 적대적 코드리뷰 확정 4건 반영 (`fcf7e5f`)
- 코드리뷰 반영 — 예외 시 종료이벤트 보장·봇 반응만 제거·상태라인 상한 (`8457e8a`)

## [Phase 2A] 데이터 기반 — 2026-07-11 ~ 2026-07-12

### Added
- 멀티유저·자기인지 데이터 기반 설계 문서(2단계 재정의) + 보안 규칙 명시(PC조작 도구는 소유자
  전용) + 설계 v2(적대적 리뷰 26건 반영) + 2A 구현 계획(TDD 7태스크) (`6396496`, `396aa16`,
  `2fa2f81`, `d22fe7a`)
- v2 정규화 스키마 덧붙임 + `schema_version` 러너 (`3f9123a`)
- `SettingsRepo`(앱 설정 접근) (`acb91a8`)
- Users/Conversations/Participants 리포 (`22cfc71`)
- Messages/Summaries 리포(`conversation_summaries`, FTS 접두) (`4c4519e`)
- `MemoriesRepo`(프라이버시 스코프 forUser/sharedOnly/all) (`c45a5e4`)
- `TurnsRepo`(원자적 한도 예약 + 소유자 예약분) (`404ba28`)
- 1단계→v2 데이터 마이그레이션(멱등, 마크다운=scope user) (`3cf836b`)

## [Phase 1] 코어 · 디스코드 — 2026-07-11

최초 상주 에이전트: SQLite 저장 계층, 디스코드 어댑터(소유자 전용), PM2 상시구동까지.

### Added
- 개인 AI 비서 상주 에이전트 설계 문서 + 1단계 구현 계획 (`472d742`, `8c58b5a`, `c9fdc58`)
- 1단계 프로젝트 스캐폴딩(`agent/` 폴더 구조 + TypeScript ESM + vitest) (`975bf72`)
- 환경변수 기반 설정 로더(`data/` 경로 기본값) (`92dbd99`)
- 타입 안전 이벤트 버스 (`e6eb5ac`)
- SQLite 저장 계층(WAL + FTS5 + 요약/설정) (`8fdd815`)
- 마크다운 메모리 폴더 부트스트랩 (`1be33d9`)
- Agent SDK 래퍼와 비서 페르소나(SDK 0.3.207 API 검증) (`8b31dc2`)
- 에이전트 코어 — 큐, 세션 수명주기, 기억 재주입, 한도 보호 (`a7f8feb`)
- 디스코드 어댑터(소유자 전용, DM+지정 채널, 메시지 분할) (`7bc7e00`)
- 크래시 복구 — 미처리 메시지 부팅 시 재개(processed 컬럼 + `recoverPending`) (`e072cad`)
- 진입점 배선 — 코어/디스코드/유휴정리/크래시복구/종료처리 (`d74aea5`)
- PM2 상시구동 설정(`deploy/`, cwd=agent, 자동재시작) (`849ca27`)

### Changed
- 폴더 구조 갱신 — `agent/`·`data/`·`deploy/` 분리를 설계·계획 문서에 반영 (`73fcbfe`)
- TypeScript 5.x 고정(npm이 가져온 TS7 프리뷰가 `@types/node`를 못 잡는 문제) (`e351d6f`)

### Fixed
- 적대적 리뷰 검증 결함 11건 수정(동시성/FTS/엣지케이스) (`7a91258`)
- `.env`를 리포 루트에서 읽도록 + `.env.example` 루트로 이동 (`f40db90`)
