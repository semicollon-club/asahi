import { describe, it, expect, afterEach, vi } from "vitest";
import http from "node:http";
import zlib from "node:zlib";
import type { AddressInfo } from "node:net";
import { LLM_PROXY_PREFIX, OAUTH_BETA, decideLlmRoute, fixBetaHeader, makeLlmProxyHandler, createUsageSniffer, type LlmUsageRow } from "../src/core/llmProxy.js";

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
// 모델 고정(3.1) 테스트용 — 토큰에 고정 모델이 실려 있다.
const verifyModel = (t: string) => (t === "good" ? { jobId: "j", userId: "u1", conversationId: 1, channelRef: "c", model: "claude-sonnet-5", exp: 9e12 } : null);

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

  it("모델 고정(3.1): 본문 모델이 토큰의 고정 모델과 다르면 400 이고 업스트림에 가지 않는다", async () => {
    const up = await fakeUpstream((_c, res) => { res.writeHead(200); res.end("{}"); });
    const base = await proxyServer(makeLlmProxyHandler({ verify: verifyModel, credential: () => "real", upstream: up.url }));
    const r = await fetch(`${base}/llm/v1/messages`, { method: "POST", body: JSON.stringify({ model: "claude-opus-5" }), headers: { authorization: "Bearer good" } });
    expect(r.status).toBe(400);
    expect(up.captured).toHaveLength(0);
  });

  it("모델 고정(3.1): 본문 모델이 고정 모델과 같으면 통과한다", async () => {
    const up = await fakeUpstream((_c, res) => { res.writeHead(200, { "content-type": "application/json" }); res.end('{"id":"ok"}'); });
    const base = await proxyServer(makeLlmProxyHandler({ verify: verifyModel, credential: () => "real", upstream: up.url }));
    const r = await fetch(`${base}/llm/v1/messages`, { method: "POST", body: JSON.stringify({ model: "claude-sonnet-5" }), headers: { authorization: "Bearer good" } });
    expect(r.status).toBe(200);
    expect(up.captured).toHaveLength(1);
  });

  it("모델 고정: 토큰에 모델이 없으면(파일 반환류·옛 토큰) 고정하지 않고 그대로 통과한다", async () => {
    const up = await fakeUpstream((_c, res) => { res.writeHead(200); res.end("{}"); });
    const base = await proxyServer(makeLlmProxyHandler({ verify, credential: () => "real", upstream: up.url }));
    const r = await fetch(`${base}/llm/v1/messages`, { method: "POST", body: JSON.stringify({ model: "claude-opus-5" }), headers: { authorization: "Bearer good" } });
    expect(r.status).toBe(200);
    expect(up.captured).toHaveLength(1);
  });

  it("사용량 기록(3.2): SSE 의 message_start/message_delta 에서 usage 를 읽어 recordUsage 를 한 번 부른다", async () => {
    const up = await fakeUpstream((_c, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write('event: message_start\ndata: {"type":"message_start","message":{"model":"claude-sonnet-5","usage":{"input_tokens":100,"output_tokens":1,"cache_read_input_tokens":20}}}\n\n');
      setTimeout(() => { res.write('event: message_delta\ndata: {"type":"message_delta","usage":{"output_tokens":55}}\n\n'); res.end(); }, 10);
    });
    const rows: LlmUsageRow[] = [];
    const base = await proxyServer(makeLlmProxyHandler({ verify: verifyModel, credential: () => "real", upstream: up.url, recordUsage: (row) => rows.push(row), now: () => 12345 }));
    await (await fetch(`${base}/llm/v1/messages`, { method: "POST", body: JSON.stringify({ model: "claude-sonnet-5" }), headers: { authorization: "Bearer good" } })).text();
    await new Promise((r) => setTimeout(r, 20));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ jobId: "j", userId: "u1", requestModel: "claude-sonnet-5", model: "claude-sonnet-5", inputTokens: 100, outputTokens: 55, cacheCreationInputTokens: 0, cacheReadInputTokens: 20, ts: 12345 });
  });

  it("사용량 기록: 오류 응답(429 등)에는 recordUsage 를 부르지 않는다", async () => {
    const up = await fakeUpstream((_c, res) => { res.writeHead(429, { "content-type": "application/json" }); res.end('{"type":"error"}'); });
    const rows: LlmUsageRow[] = [];
    const base = await proxyServer(makeLlmProxyHandler({ verify: verifyModel, credential: () => "real", upstream: up.url, recordUsage: (row) => rows.push(row) }));
    const r = await fetch(`${base}/llm/v1/messages`, { method: "POST", body: JSON.stringify({ model: "claude-sonnet-5" }), headers: { authorization: "Bearer good" } });
    expect(r.status).toBe(429);
    await new Promise((r) => setTimeout(r, 10));
    expect(rows).toHaveLength(0);
  });

  // ── 2026-09-22 로드맵 N0: llm_usage 가 역사상 0행이었다(pg_stat n_tup_ins=0, INSERT 오류 로그 없음 — 즉 시도된 적이 없다).
  // 스니퍼가 평문 SSE 만 읽었는데, 프록시가 클라이언트의 accept-encoding 을 업스트림에 그대로 넘겨 압축 응답이 올 수 있었고
  // (압축 바이트에서는 data: 줄을 못 찾는다 — 무소음), Claude Code 가 보내는 비스트리밍 JSON 응답의 usage 는 아예 읽지 않았다.
  // 근거: docs/superpowers/specs/2026-09-22-usability-roadmap-design.md §2.6, 로드맵 N0.
  it("업스트림 hop 에는 accept-encoding 을 보내지 않는다 — 전송 인코딩은 프록시가 소유한다", async () => {
    const up = await fakeUpstream((_c, res) => { res.writeHead(200, { "content-type": "application/json" }); res.end("{}"); });
    const base = await proxyServer(makeLlmProxyHandler({ verify, credential: () => "real", upstream: up.url }));
    // Node fetch 는 기본으로 accept-encoding: gzip, deflate 를 보낸다(2026-09-22 실측). 명시해도 같은 결과여야 한다.
    await (await fetch(`${base}/llm/v1/messages`, { method: "POST", body: "{}", headers: { authorization: "Bearer good", "accept-encoding": "gzip, deflate, br" } })).text();
    expect(up.captured).toHaveLength(1);
    expect(up.captured[0].headers["accept-encoding"]).toBeUndefined();
  });

  it("옛 결함 재현: 업스트림이 accept-encoding 을 보고 SSE 를 gzip 으로 답하면 클라이언트는 멀쩡히 받지만 사용량은 0건이었다 — 이제는 기록된다", async () => {
    const sse = 'event: message_start\ndata: {"type":"message_start","message":{"model":"claude-sonnet-5","usage":{"input_tokens":100,"output_tokens":1}}}\n\nevent: message_delta\ndata: {"type":"message_delta","usage":{"output_tokens":55}}\n\n';
    const up = await fakeUpstream((c, res) => {
      if (String(c.headers["accept-encoding"] ?? "").includes("gzip")) {
        res.writeHead(200, { "content-type": "text/event-stream", "content-encoding": "gzip" });
        res.end(zlib.gzipSync(sse));
      } else {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.end(sse);
      }
    });
    const rows: LlmUsageRow[] = [];
    const base = await proxyServer(makeLlmProxyHandler({ verify: verifyModel, credential: () => "real", upstream: up.url, recordUsage: (row) => rows.push(row) }));
    const r = await fetch(`${base}/llm/v1/messages`, { method: "POST", body: JSON.stringify({ model: "claude-sonnet-5" }), headers: { authorization: "Bearer good" } });
    expect(await r.text()).toBe(sse); // 클라이언트 쪽은 어느 쪽이든 정상이다 — 결함이 무소음이었던 이유
    await new Promise((r) => setTimeout(r, 20));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ inputTokens: 100, outputTokens: 55 });
  });

  it("사용량 기록: 비스트리밍 JSON 응답의 최상위 usage 도 읽어 recordUsage 를 한 번 부른다", async () => {
    const up = await fakeUpstream((_c, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ id: "msg", model: "claude-sonnet-5", usage: { input_tokens: 200, output_tokens: 30, cache_creation_input_tokens: 5, cache_read_input_tokens: 50 } }));
    });
    const rows: LlmUsageRow[] = [];
    const base = await proxyServer(makeLlmProxyHandler({ verify: verifyModel, credential: () => "real", upstream: up.url, recordUsage: (row) => rows.push(row), now: () => 777 }));
    await (await fetch(`${base}/llm/v1/messages`, { method: "POST", body: JSON.stringify({ model: "claude-sonnet-5" }), headers: { authorization: "Bearer good" } })).text();
    await new Promise((r) => setTimeout(r, 20));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ jobId: "j", userId: "u1", requestModel: "claude-sonnet-5", model: "claude-sonnet-5", inputTokens: 200, outputTokens: 30, cacheCreationInputTokens: 5, cacheReadInputTokens: 50, ts: 777 });
  });

  it("진단: 2xx 인데 사용량을 못 읽으면 상태·content-type·content-encoding·바이트 수를 한 줄 경고로 남긴다", async () => {
    const up = await fakeUpstream((_c, res) => { res.writeHead(200, { "content-type": "application/json" }); res.end('{"id":"no-usage"}'); });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const base = await proxyServer(makeLlmProxyHandler({ verify: verifyModel, credential: () => "real", upstream: up.url, recordUsage: () => {} }));
      await (await fetch(`${base}/llm/v1/messages`, { method: "POST", body: JSON.stringify({ model: "claude-sonnet-5" }), headers: { authorization: "Bearer good" } })).text();
      await new Promise((r) => setTimeout(r, 20));
      const lines = warn.mock.calls.map((c) => c.map(String).join(" "));
      expect(lines.some((l) => l.includes("사용량") && l.includes("application/json") && l.includes("200"))).toBe(true);
    } finally {
      warn.mockRestore();
    }
  });

  it("진단: 세션이 응답 도중 연결을 끊으면(스트리밍 재시도 폭풍의 신호) 한 줄 경고를 남긴다", async () => {
    const holder: { finish?: () => void } = {};
    const up = await fakeUpstream((_c, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write('event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":1}}}\n\n');
      holder.finish = () => res.end();
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const base = await proxyServer(makeLlmProxyHandler({ verify: verifyModel, credential: () => "real", upstream: up.url, recordUsage: () => {} }));
      const ac = new AbortController();
      const r = await fetch(`${base}/llm/v1/messages`, { method: "POST", body: JSON.stringify({ model: "claude-sonnet-5" }), headers: { authorization: "Bearer good" }, signal: ac.signal });
      await r.body!.getReader().read(); // 첫 조각을 받은 뒤 끊는다
      ac.abort();
      await new Promise((r) => setTimeout(r, 100));
      const lines = warn.mock.calls.map((c) => c.map(String).join(" "));
      expect(lines.some((l) => l.includes("연결을 끊"))).toBe(true);
    } finally {
      warn.mockRestore();
      holder.finish?.();
    }
  });
});

describe("createUsageSniffer — SSE usage 파싱", () => {
  it("조각이 줄 중간에서 끊겨도 message_start 입력 + message_delta 누적 출력을 합친다", () => {
    const s = createUsageSniffer();
    s.push('event: message_start\ndata: {"type":"message_start","mess');
    s.push('age":{"model":"m","usage":{"input_tokens":30,"output_tokens":1,"cache_creation_input_tokens":8}}}\n\n');
    s.push('event: message_delta\ndata: {"type":"message_delta","usage":{"output_tokens":42}}\n\n');
    expect(s.result()).toEqual({ inputTokens: 30, outputTokens: 42, cacheCreationInputTokens: 8, cacheReadInputTokens: 0, model: "m" });
  });

  it("sse 모드에서 SSE 이벤트가 하나도 없으면 null — JSON 본문은 json 모드가 읽는다", () => {
    const s = createUsageSniffer();
    s.push('{"id":"msg","usage":{"input_tokens":5}}');
    expect(s.result()).toBeNull();
  });

  it("json 모드: 비스트리밍 응답 본문의 최상위 usage·model 을 읽고, 조각으로 나뉘어 와도 합친다", () => {
    const s = createUsageSniffer("json");
    s.push('{"id":"msg","model":"m","usage":{"input_tokens":5,"output');
    s.push('_tokens":7,"cache_read_input_tokens":2}}');
    expect(s.result()).toEqual({ inputTokens: 5, outputTokens: 7, cacheCreationInputTokens: 0, cacheReadInputTokens: 2, model: "m" });
  });

  it("json 모드: JSON 이 아니거나 usage 가 없으면 null", () => {
    const a = createUsageSniffer("json");
    a.push("not json");
    expect(a.result()).toBeNull();
    const b = createUsageSniffer("json");
    b.push('{"id":"x"}');
    expect(b.result()).toBeNull();
  });

  it("json 모드: 상한을 넘는 본문은 모으지 않는다 — 끝에 usage 가 있어도 null (메모리 보호)", () => {
    const s = createUsageSniffer("json", { maxBytes: 16 });
    s.push(" ".repeat(17) + '{"usage":{"input_tokens":1}}');
    expect(s.result()).toBeNull();
  });
});
