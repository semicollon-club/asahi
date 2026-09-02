import cookieParser from "cookie-parser";
import express from "express";
import { createAuthRouter } from "./auth/router.js";
import type { Db } from "./db.js";

// 프론트(다른 도메인)가 쿠키를 포함해 호출할 수 있게 하는 최소 CORS.
// 라이브러리 대신 직접 구현해 동작을 이해한다. 허용 origin은 WEB_ORIGINS(콤마 구분).
function cors(allowedOrigins: string[]) {
  return (req: express.Request, res: express.Response, next: express.NextFunction) => {
    const origin = req.headers.origin;
    if (origin && allowedOrigins.includes(origin)) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Access-Control-Allow-Credentials", "true");
      res.setHeader("Vary", "Origin");
    }
    if (req.method === "OPTIONS") {
      res.setHeader("Access-Control-Allow-Methods", "GET,POST,PUT,PATCH,DELETE");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type");
      res.status(204).end();
      return;
    }
    next();
  };
}

/**
 * Express 앱 조립. index.ts(실서버)와 tests(supertest)가 같은 앱을 공유하도록
 * listen 없이 앱만 만들어 반환한다. db 는 운영에서는 실제 Postgres,
 * 테스트에서는 pg-mem 이 주입된다.
 */
export function createApp(deps: { db: Db }) {
  const app = express();
  const allowedOrigins = (process.env.WEB_ORIGINS ?? "http://localhost:5173")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  app.use(cors(allowedOrigins));
  app.use(express.json());
  app.use(cookieParser());

  // 배포·모니터링용 헬스체크. Railway 헬스체크도 이 경로를 본다.
  app.get("/health", (_req, res) => {
    res.json({ ok: true, service: "web-api" });
  });

  app.use("/auth", createAuthRouter(deps.db));

  // 예상 못 한 오류는 상세를 숨기고 로그로만 남긴다.
  app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    console.error("[web-api] unhandled error:", err);
    res.status(500).json({ error: "서버 오류가 발생했습니다" });
  });

  return app;
}
