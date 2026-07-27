---
lastReviewed: 2026-07-28
---

# Asahi — 개인 AI 비서 (상주 에이전트)

Claude Pro/Max 구독 + Claude Agent SDK 기반으로, PC에 상주하며 **기억이 이어지는** 개인 AI 비서.
디스코드로 대화하고, 세션이 바뀌거나 PC가 재부팅되어도 기억(Supabase Postgres + 마크다운)이 끊기지 않는다.

## 구성(배포) 개요

봇·워커 두 프로세스 구조다: **Railway 클라우드 봇**(상시 구동, 디스코드 연결·대화 처리·모든
LLM 턴을 예외 없이 직접 실행 — [deploy/railway-셋업.md](deploy/railway-셋업.md))이 봇이 여는
`/worker` 허브에 아웃바운드로 접속하는 **워커**(소유자 PC 또는 동아리 공용 미니PC, 파일·Bash
같은 PC 작업의 개별 도구 호출만 대신 실행 — [deploy/worker-셋업.md](deploy/worker-셋업.md))와
함께 돌아간다. 워커는 하나가 아니다 — 소유자의 개인 워커와 동아리 공유 워커가 동시에 붙을 수
있고, 각자 `workers` 레지스트리 테이블에 등록된 고유 토큰으로 인증한다(`npm run
register-worker`로 등록). **Supabase Postgres**(정본 상태 — 유저·대화·기억·허용 폴더·워커
레지스트리, 봇만 접속)를 공유한다. 전체 아키텍처는
[docs/architecture/overview.md](docs/architecture/overview.md),
결정 배경은 [docs/decisions/0007-multi-worker-routing.md](docs/decisions/0007-multi-worker-routing.md)
참고.

## 폴더 구조

```
Asahi/
├─ agent/     상주 에이전트 앱 (백엔드 데몬) — TypeScript / Node.js
│  ├─ src/       core · adapters · events · store · remote · memory · scripts · config · index · worker
│  └─ tests/     vitest 단위 테스트
├─ data/      런타임 데이터 (git 제외)
│  ├─ store/     (로컬 캐시 — 런타임 DB는 Supabase Postgres, 원격, DATABASE_URL)
│  └─ memory/    비서의 장기 기억 (마크다운)
├─ deploy/    Railway/PM2/워커 상시구동 설정·가이드
└─ docs/      설계 · 구현 계획 문서
```

- **루트**에는 폴더와 리포 메타파일(`.gitignore`, `README.md`)만 둔다.
- **코드(`agent/`)와 런타임 데이터(`data/`)를 물리적으로 분리** — 로컬 캐시나 기억 마크다운을
  백업할 때 코드와 섞이지 않는다. 실제 상태(유저·대화·기억)는 Supabase Postgres에 있다.
- 각 단계(Phase)는 새 폴더로 나란히 확장한다 (예: Phase 4 웹 UI → 루트에 `web/`).

## 개발

```powershell
cd agent
npm install
npm test          # 단위 테스트 (vitest)
npm run dev       # 개발 실행 (루트의 .env 필요 — .env.example 참고)
```

`.env`는 리포 루트(`<repo>/.env`)에 둔다. `DATABASE_URL`(Supabase **Session pooler** 연결
문자열)이 필수다 — 형식·발급 방법은 [deploy/railway-셋업.md](deploy/railway-셋업.md) 참고.

## 상시 구동

24/7 운영은 **Railway**([deploy/railway-셋업.md](deploy/railway-셋업.md))를 쓴다. 로컬 PM2는
폴백/대체 수단([deploy/PM2-명령어.md](deploy/PM2-명령어.md)).

## 다른 PC에서 운영

이 PC가 꺼져 있어도 다른 PC에서 봇을 띄울 수 있다. 런타임 상태·기억(사용자·대화·기억 데이터)은 **Supabase Postgres 중앙**에 있어 그대로 이어지고, 로컬 `data/` 마크다운 캐시(있다면)만 수동 이전이 필요하며, **봇은 한 번에 한 곳만**(Railway와 로컬 PM2 동시 실행 금지) 띄워야 한다. 절차·주의사항은 [deploy/다른-PC-셋업.md](deploy/다른-PC-셋업.md) 참고.

## 문서 안내

- 문서 전체 인덱스: [docs/README.md](docs/README.md)
- 기여 가이드: [CONTRIBUTING.md](CONTRIBUTING.md)
- 보안 정책: [SECURITY.md](SECURITY.md)

자세한 설계·로드맵은 [docs/](docs/) 참고. 현재 단계: [docs/status/STATUS.md](docs/status/STATUS.md) 참고.
