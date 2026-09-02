import { Router } from "express";
import { z } from "zod";
import type { Db } from "../db.js";
import { AuthError, getSessionUser, login, logout, register } from "./service.js";

const SESSION_COOKIE = "sid";

// 아이디: 영소문자·숫자·언더스코어 3~20자. 비밀번호: 8자 이상.
const registerSchema = z.object({
  username: z.string().regex(/^[a-z0-9_]{3,20}$/, "아이디는 영소문자·숫자·_ 3~20자입니다"),
  password: z.string().min(8, "비밀번호는 8자 이상이어야 합니다").max(200),
  displayName: z.string().trim().min(1, "이름을 입력해 주세요").max(50),
});

const loginSchema = z.object({
  username: z.string().min(1).max(50),
  password: z.string().min(1).max(200),
});

function cookieOptions(expiresAt?: Date) {
  const production = process.env.NODE_ENV === "production";
  return {
    httpOnly: true, // JS에서 접근 불가 → XSS로 토큰 탈취 방지
    secure: production, // 운영에서는 HTTPS로만 전송
    // 프론트(Vercel)와 API(Railway)가 다른 도메인이라 운영에서는 none 이 필요하다.
    // 로컬(localhost 포트만 다름)은 same-site 라 lax 로 충분하다.
    sameSite: production ? ("none" as const) : ("lax" as const),
    path: "/",
    ...(expiresAt ? { expires: expiresAt } : {}),
  };
}

export function createAuthRouter(db: Db): Router {
  const router = Router();

  router.post("/register", async (req, res, next) => {
    try {
      const parsed = registerSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: parsed.error.issues[0]?.message ?? "잘못된 입력입니다" });
        return;
      }
      const user = await register(db, parsed.data);
      res.status(201).json({ user });
    } catch (e) {
      if (e instanceof AuthError && e.code === "USERNAME_TAKEN") {
        res.status(409).json({ error: e.message });
        return;
      }
      next(e);
    }
  });

  router.post("/login", async (req, res, next) => {
    try {
      const parsed = loginSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: "아이디와 비밀번호를 입력해 주세요" });
        return;
      }
      const { user, sessionToken, expiresAt } = await login(db, parsed.data);
      res.cookie(SESSION_COOKIE, sessionToken, cookieOptions(expiresAt));
      res.json({ user });
    } catch (e) {
      if (e instanceof AuthError && e.code === "INVALID_CREDENTIALS") {
        res.status(401).json({ error: e.message });
        return;
      }
      next(e);
    }
  });

  router.post("/logout", async (req, res, next) => {
    try {
      const token = (req.cookies as Record<string, string | undefined>)[SESSION_COOKIE];
      if (token) await logout(db, token);
      res.clearCookie(SESSION_COOKIE, cookieOptions());
      res.json({ ok: true });
    } catch (e) {
      next(e);
    }
  });

  router.get("/me", async (req, res, next) => {
    try {
      const token = (req.cookies as Record<string, string | undefined>)[SESSION_COOKIE];
      const user = token ? await getSessionUser(db, token) : null;
      if (!user) {
        res.status(401).json({ error: "로그인이 필요합니다" });
        return;
      }
      res.json({ user });
    } catch (e) {
      next(e);
    }
  });

  return router;
}
