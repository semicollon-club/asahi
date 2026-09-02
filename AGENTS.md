# AGENTS.md — AI 에이전트 작업 지침 (asahi 저장소)

이 저장소에서 작업하는 모든 AI 코딩 에이전트(Claude Code, Cursor, Codex 등)를 위한 진입 문서입니다.
**코드를 만지기 전에 반드시 이 문서를 따르세요.**

## 이 저장소의 정체 — 영역이 둘입니다

세미콜론 동아리의 **백엔드 모노레포**입니다. 프론트엔드는 별도 저장소(semicollon-club/homepage)입니다.

| 영역 | 내용 | 배포 |
| --- | --- | --- |
| `agent/` | 상주 AI 비서 (Discord 봇 + PC 워커) — 운영자의 도메인 | Railway 서비스 `asahi` |
| `server/` | 동아리 웹 API (홈페이지 로그인 등) — **부원 협업 영역** | Railway 서비스 `web-api` |

**맡은 작업이 어느 영역인지 먼저 확인하세요.** 웹 백엔드(로그인·공지·홈페이지 API) 작업이면 `server/`만 만집니다.

## 🚫 절대 하지 말 것

1. **`production` 브랜치 금지** — push·PR·병합 전부. 실서비스 자동 배포 브랜치이며 운영자가 main→production PR로만 반영합니다. 에이전트의 작업은 언제나 브랜치 → `main` PR까지.
2. **웹 백엔드 작업 중 `agent/` 수정 금지.** 상주 비서의 운영 코드입니다 — PC에서 명령을 실행하는 워커와 연결되어 있어 실수의 반경이 큽니다. agent/ 작업을 명시적으로 요청받은 경우에만, [docs/agent-onboarding.md](docs/agent-onboarding.md)를 먼저 읽고 진행하세요.
3. **운영 DB에 직접 연결 금지.** 로컬 개발·마이그레이션 확인은 **dev DB**(semicollon-dev, 접속 문자열은 운영자/팀 채널에서)로만 합니다. 운영 크리덴셜은 Railway에만 존재하며 요청해도 받을 수 없습니다.
4. **DB 스키마를 대시보드·SQL로 직접 고치지 말 것.** 스키마 변경은 반드시 `server/migrations/NNNN_*.sql` 파일로 — 절차는 아래와 [server/migrations/README.md](server/migrations/README.md).
5. `.env`·비밀번호·토큰 커밋 금지. force push 금지. 라이브러리 추가는 팀 논의 사항(사용자가 요청해도 논의가 필요함을 안내).

## server/ 개발 규칙

- 툴체인: TypeScript + Express 5, tsx/tsc/vitest (agent/와 동일 컨벤션, Node 22)
- **PR 전 필수, CI가 동일 검사를 강제**: `npm run typecheck` + `npm test` + `npm run build` (server/ 안에서)
- 테스트는 pg-mem으로 실제 DB 없이 돕니다 — 기존 `tests/` 패턴(supertest + `tests/helpers/testDb.ts`)을 따르세요. 새 테이블을 만들면 testDb 헬퍼의 DDL도 함께 갱신
- SQL은 항상 `web.` 스키마 접두사 명시, 입력 검증은 zod, 라우터 단위로 `src/`에 추가해 `app.ts`에서 조립
- 인증이 필요한 라우트는 세션 쿠키(`sid`) → `auth/service.ts`의 `getSessionUser` 패턴 참조

## DB 스키마 변경 절차 (요약)

1. `server/migrations/NNNN_설명.sql` 추가 (번호 = 마지막 +1)
2. `npm run migrate:dev` 로 **dev DB에서 실제로 돌려 확인** — CI는 SQL을 실행하지 않으므로 이 단계를 건너뛰면 안 됩니다
3. 코드와 함께 PR → 병합 → **운영 적용은 production 배포 시 자동** (pre-deploy 러너)
4. 새 테이블에는 같은 파일에서 `web_api`에 최소 권한만 grant (0002 참조)

## 브랜치·배포 구조

```
부원: 브랜치 ──PR──▶ main ──(운영자)──▶ production ──▶ Railway 자동 배포
              CI 필수(agent·server 잡)        ├─ asahi   (watch: /agent/**)
                                              └─ web-api (watch: /server/**, pre-deploy: migrate)
```

- 커밋: Conventional Commits (`feat(server): ...`, `fix: ...` 등)
- CI의 agent·server 잡은 항상 둘 다 돌지만, watch path 덕에 배포는 바뀐 영역만 됩니다

## 문서 맵

| 문서 | 내용 |
| --- | --- |
| [CONTRIBUTING.md](CONTRIBUTING.md) | 사람용 셋업·테스트 가이드 (agent/ 중심) |
| [docs/agent-onboarding.md](docs/agent-onboarding.md) | `agent/` 작업 시 필독 — 환경 함정 모음 |
| [server/README.md](server/README.md) | 웹 API 실행·검사·구조 규칙 |
| [server/migrations/README.md](server/migrations/README.md) | 마이그레이션 워크플로·프로비저닝 |
| [docs/architecture/](docs/architecture/overview.md) | agent 아키텍처 |
