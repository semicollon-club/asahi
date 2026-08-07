---
lastReviewed: 2026-07-30
---

# Asahi 문서 인덱스

이 디렉터리가 문서의 **정본(source of truth)** 이다. 현재 살아있는 아키텍처·보안·상태·결정
기록이 여기 있으며, 코드와 어긋나면 코드가 이기고 문서를 고친다. 진행 중인 SDD(스펙·계획·작업
분해)는 [`docs/superpowers/`](superpowers/)에 있으며, 완료되면 이 인덱스 아래 정본 문서로
반영되고 옛 스펙·계획은 [`docs/design-archive/`](design-archive/)로 옮겨 원문 그대로 보존한다.

## 여기서 시작

- [에이전트 온보딩](agent-onboarding.md) — **새 세션에서 이 프로젝트를 이어받는다면 먼저 읽어라.**
  작업 방식(SDD 루프·커밋·검증)과 이 환경의 함정을 모았다. 두 계정 구분, PowerShell 5.1 의
  함정, 배포 순서, PM2 의 거짓 신호, cmd.exe 인용 경계, 모델이 실패한 도구를 우회하는 문제 —
  전부 실제로 밟아 본 것들이라 추측으로 재발견할 필요가 없다.
- [기여 가이드](../CONTRIBUTING.md) — 사람 기여자용 셋업·테스트·실행 순서

## 아키텍처

- [개요](architecture/overview.md) — 3-프로세스 하이브리드(Railway 봇 / 로컬 워커 / Supabase Postgres) 전체 구조
- [데이터 흐름](architecture/data-flow.md) — 디스코드 메시지 한 통이 도착해서 답장이 나가기까지의 수명주기
- [모듈 경계](architecture/module-boundaries.md) — `agent/src` 안에서 코드가 어디에 속하는지 판단하는 기준
- [용어집](architecture/glossary.md) — 코드베이스 전반에서 반복되는 용어 정리

## 보안

- [능력 계층 모델](security/capability-model.md) — 발화자 신원·대화 위치에 따른 도구 권한 경계
- [위험 등록부](security/risk-register.md) — 알려진 한계와 현재 완화책
- [보안 정책](../SECURITY.md) — 취약점 신고 절차(루트)

## 상태·로드맵

- [현재 상태](status/STATUS.md) — 라이브 인프라·병합된 기능·미완 항목
- [로드맵](status/ROADMAP.md) — 다음 단계 계획

## 결정 기록 (ADR)

- [인덱스](decisions/README.md) — ADR 목록과 리뷰 번호(`리뷰 #N`/`보안리뷰 #N`) 대조표 안내
- [0001. SQLite → Postgres 이전](decisions/0001-sqlite-to-postgres.md)
- [0002. Railway + 로컬 워커 하이브리드](decisions/0002-railway-local-worker-hybrid.md)
- [0003. `claude-opus-4-8` 기본 모델](decisions/0003-opus-4-8-default.md)
- [0004. READ ONLY 트랜잭션 기반 자기조회](decisions/0004-readonly-tx-introspection.md)
- [0005. 소유자 전용 워커 위임](decisions/0005-owner-only-delegation.md)
- [리뷰 원장](decisions/review-ledger.md) — 코드 주석이 인용하는 `리뷰 #N` 번호가 실제 어느 라운드를 가리키는지 매핑

## 설계 아카이브 (역사)

- [인덱스](design-archive/README.md) — 완료(Shipped)·대체(Superseded)된 과거 스펙·계획·노트 보존 디렉터리 안내. 이 아카이브의 문서는 과거 시점 기록이라 현재 코드와 어긋날 수 있으며, 유효성은 각 문서 상단 front-matter(`status`/`shippedIn`/`supersededBy`)를 따른다.

## 운영 (런북)

- [Railway 셋업](../deploy/railway-셋업.md) — 클라우드 봇 24/7 상시 구동
- [다른 PC 셋업](../deploy/다른-PC-셋업.md) — 다른 PC로 운영을 옮기는 절차·주의사항
- [PM2 명령어](../deploy/PM2-명령어.md) — 로컬 PM2 폴백 운영 명령어
- [로컬 워커 셋업](../deploy/worker-셋업.md) — 소유자 PC 전용 워커(파일·Bash 작업 위임 처리)
- [GitHub App 셋업](../deploy/github-app-셋업.md) — 깃허브 발행용 자격증명(봇 전용, 미니PC 금지)
- [장애 대응 런북](../deploy/incident-runbook.md) — 증상 → 원인 → 조치
- [배포 후 스모크 테스트](../deploy/smoke-test.md) — 배포 직후 확인 체크리스트
