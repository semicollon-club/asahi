import { beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import type { Agent } from "supertest";
import { createApp } from "../src/app.js";
import type { Db } from "../src/db.js";
import { hashToken } from "../src/auth/service.js";
import { openTestDb } from "./helpers/testDb.js";

let db: Db;
let agent: Agent; // supertest agent — 브라우저처럼 쿠키를 유지한다

beforeEach(async () => {
  db = await openTestDb();
  agent = request.agent(createApp({ db }));
});

const goodUser = { username: "semicolon", password: "password123", displayName: "세미콜론" };

describe("회원가입", () => {
  it("올바른 입력이면 201과 공개 프로필을 반환한다 (비밀번호 해시는 노출하지 않는다)", async () => {
    const res = await agent.post("/auth/register").send(goodUser);
    expect(res.status).toBe(201);
    expect(res.body.user.username).toBe("semicolon");
    expect(res.body.user.displayName).toBe("세미콜론");
    expect(res.body.user.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(JSON.stringify(res.body)).not.toContain("password");
  });

  it("비밀번호는 평문이 아니라 bcrypt 해시로 저장된다", async () => {
    await agent.post("/auth/register").send(goodUser);
    const row = (await db.query("select password_hash from web.users")).rows[0];
    expect(row.password_hash).not.toContain(goodUser.password);
    expect(row.password_hash).toMatch(/^\$2[aby]\$/);
  });

  it("아이디는 소문자로 정규화되어 대소문자만 다른 중복을 막는다", async () => {
    await agent.post("/auth/register").send(goodUser);
    const res = await agent.post("/auth/register").send({ ...goodUser, username: "semicolon" });
    expect(res.status).toBe(409);
  });

  it("짧은 비밀번호(8자 미만)는 400", async () => {
    const res = await agent.post("/auth/register").send({ ...goodUser, password: "1234567" });
    expect(res.status).toBe(400);
  });

  it("아이디 형식 위반(공백·특수문자)은 400", async () => {
    const res = await agent.post("/auth/register").send({ ...goodUser, username: "bad name!" });
    expect(res.status).toBe(400);
  });
});

describe("로그인 · 세션 · 로그아웃", () => {
  beforeEach(async () => {
    await agent.post("/auth/register").send(goodUser);
  });

  it("올바른 자격이면 세션 쿠키가 설정되고 /auth/me 가 사용자를 반환한다", async () => {
    const login = await agent.post("/auth/login").send({ username: "semicolon", password: goodUser.password });
    expect(login.status).toBe(200);
    expect(login.headers["set-cookie"]?.[0]).toContain("sid=");
    expect(login.headers["set-cookie"]?.[0]).toContain("HttpOnly");
    expect(login.headers["set-cookie"]?.[0]).toContain("SameSite=Lax");

    const me = await agent.get("/auth/me");
    expect(me.status).toBe(200);
    expect(me.body.user.username).toBe("semicolon");
  });

  it("틀린 비밀번호는 401이고, 존재하지 않는 아이디와 같은 메시지를 준다 (계정 존재 여부 비노출)", async () => {
    const wrongPw = await agent.post("/auth/login").send({ username: "semicolon", password: "wrong-password" });
    const noUser = await agent.post("/auth/login").send({ username: "ghost", password: "wrong-password" });
    expect(wrongPw.status).toBe(401);
    expect(noUser.status).toBe(401);
    expect(wrongPw.body.error).toBe(noUser.body.error);
  });

  it("DB에는 세션 토큰 원문이 아니라 해시만 저장된다", async () => {
    const login = await agent.post("/auth/login").send({ username: "semicolon", password: goodUser.password });
    const rawToken = /sid=([^;]+)/.exec(login.headers["set-cookie"]?.[0] ?? "")?.[1] ?? "";
    const row = (await db.query("select token_hash from web.sessions")).rows[0];
    expect(rawToken.length).toBeGreaterThan(20);
    expect(row.token_hash).not.toBe(rawToken);
    expect(row.token_hash).toBe(hashToken(rawToken));
  });

  it("로그아웃하면 세션이 DB에서 삭제되고 /auth/me 는 user:null", async () => {
    await agent.post("/auth/login").send({ username: "semicolon", password: goodUser.password });
    await agent.post("/auth/logout");
    const me = await agent.get("/auth/me");
    expect(me.status).toBe(200);
    expect(me.body.user).toBeNull();
    const count = (await db.query("select count(*) as c from web.sessions")).rows[0];
    expect(Number(count.c)).toBe(0);
  });

  it("만료된 세션은 인증되지 않는다 (user:null)", async () => {
    await agent.post("/auth/login").send({ username: "semicolon", password: goodUser.password });
    await db.query("update web.sessions set expires_at = now() - interval '1 minute'");
    const me = await agent.get("/auth/me");
    expect(me.status).toBe(200);
    expect(me.body.user).toBeNull();
  });

  it("쿠키 없이 /auth/me 는 200 + user:null (비로그인은 오류가 아니다)", async () => {
    const res = await request(createApp({ db })).get("/auth/me");
    expect(res.status).toBe(200);
    expect(res.body.user).toBeNull();
  });
});
