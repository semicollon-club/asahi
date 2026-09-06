import { describe, it, expect, afterEach } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { decideMcpRoute, makeMcpHubHandler, MCP_HUB_PREFIX } from "../src/core/mcpHub.js";
import { makeGithubReadServer } from "../src/mcp/githubReadServer.js";

// 허브 MCP(풀 하네스 4단계 4.1) — 봇(계정 A)의 /mcp/<이름>. 세션(계정 B)의 Claude Code 가 작업 토큰으로 붙어
// mcp__<이름>__* 로 쓴다. 여기서는 실제 MCP 클라이언트로 허브에 붙어 핸드셰이크·인증·도구 왕복을 끝까지 본다
// (스파이크와 같은 stateless StreamableHTTP). GitHub 서버는 가짜 토큰·가짜 fetch 로 봇의 읽기 헬퍼를 그대로 노출한다.

const closers: Array<() => Promise<void>> = [];
afterEach(async () => { while (closers.length) await closers.pop()!(); });

// verify: "good" 만 통과(작업 토큰 자리).
const verify = (t: string) => (t === "good" ? { jobId: "j", userId: "u1", conversationId: 1, channelRef: "c", exp: 9e12 } : null);

// 봇의 GitHub 읽기 헬퍼가 치는 엔드포인트에만 답하는 가짜 fetch.
const fakeFetch = (async (url: string | URL) => {
  const u = String(url);
  const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  if (u.includes("/installation/repositories")) {
    return json({ total_count: 1, repositories: [{ name: "asahi", description: "동아리 봇", private: true, default_branch: "main", pushed_at: "2026-09-06T00:00:00Z", archived: false, html_url: "https://github.com/semicollon-club/asahi" }] });
  }
  if (u.endsWith("/pulls/5")) return json({ number: 5, title: "테스트 PR", state: "open", merged: false, html_url: "https://x/5", head: { ref: "feat", sha: "abc" }, base: { ref: "main" } });
  if (u.endsWith("/pulls/5/reviews")) return json([]);
  if (u.endsWith("/pulls/5/comments")) return json([]);
  if (u.endsWith("/issues/5/comments")) return json([]);
  return new Response("not found", { status: 404 });
}) as unknown as typeof fetch;

async function hubServer(servers: Record<string, () => import("@modelcontextprotocol/sdk/server/mcp.js").McpServer>) {
  const handler = makeMcpHubHandler({ verify, servers });
  const server = http.createServer((req, res) => {
    if (req.url?.startsWith(MCP_HUB_PREFIX)) { handler(req, res); return; }
    res.writeHead(404); res.end();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  closers.push(() => new Promise((r) => server.close(() => r())));
  const { port } = server.address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
}

async function connect(base: string, name: string, token: string) {
  const client = new Client({ name: "test", version: "0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base}${MCP_HUB_PREFIX}/${name}`), { requestInit: { headers: { authorization: `Bearer ${token}` } } }));
  closers.push(() => client.close());
  return client;
}

describe("decideMcpRoute — /mcp/<이름> 만", () => {
  it("이름을 뽑고, 빈 이름·하위경로·다른 접두는 notFound", () => {
    expect(decideMcpRoute("/mcp/github")).toEqual({ kind: "server", name: "github" });
    expect(decideMcpRoute("/mcp/github?x=1")).toEqual({ kind: "server", name: "github" });
    expect(decideMcpRoute("/mcp/")).toEqual({ kind: "notFound" });
    expect(decideMcpRoute("/mcp/a/b")).toEqual({ kind: "notFound" });
    expect(decideMcpRoute("/llm/v1/messages")).toEqual({ kind: "notFound" });
    expect(decideMcpRoute(undefined)).toEqual({ kind: "notFound" });
  });
});

describe("makeMcpHubHandler — 허브 MCP 왕복", () => {
  const githubServers = { github: () => makeGithubReadServer({ org: "semicollon-club", token: async () => "gh-token", fetchImpl: fakeFetch }) };

  it("작업 토큰이 없으면 붙지 못한다(401)", async () => {
    const base = await hubServer(githubServers);
    await expect(connect(base, "github", "nope")).rejects.toThrow();
  });

  it("표에 없는 서버 이름은 붙지 못한다(404)", async () => {
    const base = await hubServer(githubServers);
    await expect(connect(base, "nope", "good")).rejects.toThrow();
  });

  it("list_repos 를 노출하고 저장소 목록을 돌려준다", async () => {
    const base = await hubServer(githubServers);
    const client = await connect(base, "github", "good");
    const tools = (await client.listTools()).tools.map((t) => t.name).sort();
    expect(tools).toEqual(["get_pull_request", "list_repos"]);
    const out = await client.callTool({ name: "list_repos", arguments: {} });
    const text = (out.content as Array<{ type: string; text: string }>)[0].text;
    expect(text).toContain("asahi");
  });

  it("get_pull_request 는 PR 상태를 읽어 돌려준다", async () => {
    const base = await hubServer(githubServers);
    const client = await connect(base, "github", "good");
    const out = await client.callTool({ name: "get_pull_request", arguments: { repo: "asahi", number: 5 } });
    const text = (out.content as Array<{ type: string; text: string }>)[0].text;
    expect(text).toContain("테스트 PR");
    expect(out.isError).toBeFalsy();
  });
});
