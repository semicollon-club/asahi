# server — 동아리 웹 백엔드 (web-api)

세미콜론 홈페이지(semicollon-club/homepage)가 호출하는 웹 API. 로그인·공지 등
백엔드 기술을 부원이 직접 구현해보는 실험 공간이다. `agent/`(상주 에이전트)와
저장소는 공유하지만 **별도 프로세스·별도 Railway 서비스**로 배포된다.

## 실행

```bash
cd server
npm install
npm run dev        # http://localhost:8788/health
```

## 검사 (PR 전 필수 — CI가 동일 검사를 강제)

```bash
npm run typecheck
npm test
npm run build
```

## 구조 규칙

- 기능은 라우터 단위로 `src/` 아래에 추가하고 `app.ts`에서 조립한다.
- 입력 검증은 zod, DB 접근은 추후 `web` 스키마 전용 role로만 한다 (agent 테이블 접근 금지).
- 비밀값은 `.env`(로컬)와 Railway 환경변수로만 다룬다. 커밋 금지.
