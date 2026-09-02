import express from "express";

/**
 * Express 앱 조립. index.ts(실서버)와 tests(supertest)가 같은 앱을 공유하도록
 * listen 없이 앱만 만들어 반환한다.
 */
export function createApp() {
  const app = express();
  app.use(express.json());

  // 배포·모니터링용 헬스체크. Railway 헬스체크도 이 경로를 본다.
  app.get("/health", (_req, res) => {
    res.json({ ok: true, service: "web-api" });
  });

  // 이후 기능은 라우터 단위로 추가한다. 예: app.use("/auth", authRouter)

  return app;
}
