import { describe, it, expect, afterEach } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { LLM_PROXY_PREFIX, OAUTH_BETA, decideLlmRoute, fixBetaHeader, makeLlmProxyHandler } from "../src/core/llmProxy.js";

// 풀 하네스 2단계(2026-09-05 밤): 봇(계정 A)의 인증 프록시 /llm/v1/*. 세션(계정 B)은 ANTHROPIC_BASE_URL 을 여기로,
// ANTHROPIC_AUTH_TOKEN 을 작업 토큰으로 받는다. 프록시는 토큰을 검증하고 Authorization 을 진짜 구독 OAuth 로 바꿔
// Anthropic 에 넘기며, 응답(SSE)은 그대로 흘린다(스펙 §4.2). 프로브(scripts/llmProxyProbe.ts)가 실측한 헤더 규칙 —
// authorization 교체, x-api-key 제거, anthropic-beta 에 oauth-2025-04-20 보정 — 을 그대로 옮겼다.
//
// 가짜 업스트림(실제 http 서버)으로 헤더 교체와 스트림 통과를 끝까지 본다.

const closers: Array<() => Promise<void>> = [];
afterEach(async () => { while (closers.length) await closers.pop()!(); });

type Captured = { method?: string; url?: string; headers: http.IncomingHttpHeaders; body: string };

async function fakeUpstream(respond: (c: Captured, res: http.ServerResponse) => void) {
  const captured: Captured[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const c = { method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(chunks).toString("utf8") };
      captured.push(c);
      respond(c, res);
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  closers.push(() => new Promise((r) => server.close(() => r())));
  const { port } = server.address() as AddressInfo;
  return { captured, url: new URL(`http://127.0.0.1:${port}`) };
}

async function proxyServer(handler: (req: http.IncomingMessage, res: http.ServerResponse) => void) {
  const server = http.createServer((req, res) => {
    if (req.url?.startsWith(LLM_PROXY_PREFIX)) { handler(req, res); return; }
    res.writeHead(404); res.end();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  closers.push(() => new Promise((r) => server.close(() => r())));
  const { port } = server.address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
}

const verify = (t: string) => (t === "good" ? { jobId: "j", userId: "u1", conversationId: 1, channelRef: "c", exp: 9e12 } : null);

describe("decideLlmRoute — 경로 허용 목록", () => {
  it("루트(HEAD/GET /llm, /llm/)는 연결 확인용 200", () => {
    expect(decideLlmRoute("HEAD", "/llm")).toEqual({ kind: "root" });
    expect(decideLlmRoute("GET", "/llm/")).toEqual({ kind: "root" });
  });
  it("POST /llm/v1/messages(쿼리 포함)와 count_tokens 만 전달하고, 접두를 뗀 경로를 돌려준다", () => {
    expect(decideLlmRoute("POST", "/llm/v1/messages?beta=true")).toEqual({ kind: "forward", path: "/v1/messages?beta=true" });
    expect(decideLlmRoute("POST", "/llm/v1/messages/count_tokens")).toEqual({ kind: "forward", path: "/v1/messages/count_tokens" });
  });
  it("그 밖은 전부 notFound — 모델 목록·파일·관리 API 로는 새지 않는다", () => {
    expect(decideLlmRoute("GET", "/llm/v1/models")).toEqual({ kind: "notFound" });
    expect(decideLlmRoute("POST", "/llm/v1/complete")).toEqual({ kind: "notFound" });
    expect(decideLlmRoute("GET", "/llm/v1/messages")).toEqual({ kind: "notFound" });
    expect(decideLlmRoute("POST", "/llm/../v1/messages")).toEqual({ kind: "notFound" });
    expect(decideLlmRoute("POST", "/other")).toEqual({ kind: "notFound" });
  });
});

describe("fixBetaHeader — 구독 OAuth 는 oauth-2025-04-20 베타가 있어야 받는다", () => {
  it("없으면 더하고, 있으면 그대로, 비어 있으면 그것 하나", () => {
    expect(fixBetaHeader(undefined)).toBe(OAUTH_BETA);
    expect(fixBetaHeader("")).toBe(OAUTH_BETA);
    expect(fixBetaHeader("claude-code-20250219")).toBe(`claude-code-20250219,${OAUTH_BETA}`);
    expect(fixBetaHeader(`claude-code-20250219,${OAUTH_BETA}`)).toBe(`claude-code-20250219,${OAUTH_BETA}`);
  });
});

describe("makeLlmProxyHandler", () => {
  it("작업 토큰이 없거나 틀리면 401 이고 업스트림에 닿지 않는다", async () => {
    const up = await fakeUpstream((_c, res) => { res.writeHead(200); res.end("{}"); });
    const base = await proxyServer(makeLlmProxyHandler({ verify, credential: () => "sk-ant-oat-real", upstream: up.url }));
    const r1 = await fetch(`${base}/llm/v1/messages?beta=true`, { method: "POST", body: "{}", headers: { "content-type": "application/json" } });
    const r2 = await fetch(`${base}/llm/v1/messages?beta=true`, { method: "POST", body: "{}", headers: { authorization: "Bearer bad" } });
    expect(r1.status).toBe(401);
    expect(r2.status).toBe(401);
    expect((await r2.json()) as Record<string, unknown>).toMatchObject({ type: "error", error: { type: "authentication_error" } });
    expect(up.captured).toHaveLength(0);
  });

  it("허용 목록 밖 경로는 404, 루트 HEAD 는 200", async () => {
    const up = await fakeUpstream((_c, res) => { res.writeHead(200); res.end(); });
    const base = await proxyServer(makeLlmProxyHandler({ verify, credential: () => "real", upstream: up.url }));
    expect((await fetch(`${base}/llm/v1/models`, { headers: { authorization: "Bearer good" } })).status).toBe(404);
    expect((await fetch(`${base}/llm`, { method: "HEAD" })).status).toBe(200);
    expect(up.captured).toHaveLength(0);
  });

  it("자격증명이 봇에 없으면 503 — 토큰이 맞아도 업스트림에 가지 않는다", async () => {
    const up = await fakeUpstream((_c, res) => { res.writeHead(200); res.end(); });
    const base = await proxyServer(makeLlmProxyHandler({ verify, credential: () => undefined, upstream: up.url }));
    const r = await fetch(`${base}/llm/v1/messages`, { method: "POST", body: "{}", headers: { authorization: "Bearer good" } });
    expect(r.status).toBe(503);
    expect(up.captured).toHaveLength(0);
  });

  it("토큰이 맞으면 Authorization 을 진짜 자격증명으로 바꾸고 x-api-key 는 버리며 베타 헤더를 보정해 본문 그대로 넘긴다", async () => {
    const up = await fakeUpstream((_c, res) => { res.writeHead(200, { "content-type": "application/json" }); res.end('{"id":"msg"}'); });
    const base = await proxyServer(makeLlmProxyHandler({ verify, credential: () => "sk-ant-oat-real", upstream: up.url }));
    const body = JSON.stringify({ model: "claude-opus-5", messages: [{ role: "user", content: "hi" }] });
    const r = await fetch(`${base}/llm/v1/messages?beta=true`, {
      method: "POST", body,
      headers: { authorization: "Bearer good", "x-api-key": "should-drop", "anthropic-beta": "claude-code-20250219", "anthropic-version": "2023-06-01", "content-type": "application/json" },
    });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ id: "msg" });
    expect(up.captured).toHaveLength(1);
    const c = up.captured[0];
    expect(c.method).toBe("POST");
    expect(c.url).toBe("/v1/messages?beta=true");
    expect(c.headers.authorization).toBe("Bearer sk-ant-oat-real");
    expect(c.headers["x-api-key"]).toBeUndefined();
    expect(c.headers["anthropic-beta"]).toBe(`claude-code-20250219,${OAUTH_BETA}`);
    expect(c.headers["anthropic-version"]).toBe("2023-06-01");
    expect(c.headers.host).toBe(up.url.host);
    expect(c.body).toBe(body);
  });

  it("SSE 응답을 상태·헤더·조각 그대로 흘린다", async () => {
    const up = await fakeUpstream((_c, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write("event: message_start\ndata: {\"type\":\"message_start\"}\n\n");
      setTimeout(() => { res.write("event: message_stop\ndata: {}\n\n"); res.end(); }, 20);
    });
    const base = await proxyServer(makeLlmProxyHandler({ verify, credential: () => "real", upstream: up.url }));
    const r = await fetch(`${base}/llm/v1/messages`, { method: "POST", body: "{}", headers: { authorization: "Bearer good" } });
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toBe("text/event-stream");
    expect(await r.text()).toBe("event: message_start\ndata: {\"type\":\"message_start\"}\n\nevent: message_stop\ndata: {}\n\n");
  });

  it("업스트림의 오류 상태(429 등)도 그대로 전달한다 — 봇이 나중에 한국어 사유로 바꾸는 것은 3단계", async () => {
    const up = await fakeUpstream((_c, res) => { res.writeHead(429, { "content-type": "application/json" }); res.end('{"type":"error"}'); });
    const base = await proxyServer(makeLlmProxyHandler({ verify, credential: () => "real", upstream: up.url }));
    const r = await fetch(`${base}/llm/v1/messages`, { method: "POST", body: "{}", headers: { authorization: "Bearer good" } });
    expect(r.status).toBe(429);
  });

  it("업스트림에 닿지 못하면 502", async () => {
    const dead = new URL("http://127.0.0.1:9"); // 닫힌 포트
    const base = await proxyServer(makeLlmProxyHandler({ verify, credential: () => "real", upstream: dead }));
    const r = await fetch(`${base}/llm/v1/messages`, { method: "POST", body: "{}", headers: { authorization: "Bearer good" } });
    expect(r.status).toBe(502);
  });

  it("verify 가 던져도 401 로 취급한다", async () => {
    const up = await fakeUpstream((_c, res) => { res.writeHead(200); res.end(); });
    const base = await proxyServer(makeLlmProxyHandler({ verify: () => { throw new Error("boom"); }, credential: () => "real", upstream: up.url }));
    const r = await fetch(`${base}/llm/v1/messages`, { method: "POST", body: "{}", headers: { authorization: "Bearer good" } });
    expect(r.status).toBe(401);
  });
});
