import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { makeMcpHubHandler, MCP_HUB_PREFIX } from "../src/core/mcpHub.js";
import { makeMemoryServer, memoryCtxFromClaims, type MemoryServerDeps } from "../src/mcp/memoryServer.js";
import type { JobTokenClaims } from "../src/core/jobToken.js";
import { openTestDb } from "../src/store/db.js";
import { MemoriesRepo } from "../src/store/memoriesRepo.js";
import { UsersRepo } from "../src/store/usersRepo.js";

// 하네스 턴의 기억 도구(2026-11-25, 기억 정비 3-1). 허브의 memory 서버가 봇 세션과 같은 핸들러
// (tools.ts 의 remember/recall/forget)를 부르고, 신원·위치는 작업 토큰 클레임에서 온다. 실제 MCP 클라이언트로
// 허브에 붙어 끝까지 왕복한다 — DB 는 pg-mem(openTestDb).

const OWNER = "100000";
const BOB = "200000";

const closers: Array<() => Promise<void>> = [];
afterEach(async () => { while (closers.length) await closers.pop()!(); });

const base = { jobId: "job-abcdef", channelRef: "c", exp: 9e12 };
// 토큰 문자열 → 클레임. 손님 토큰("guest-server")은 지금 프로필로는 발급되지 않지만(GUEST_MCP_HUB 에 memory 없음),
// X6 에서 열릴 때 핸들러 규칙이 그대로 맞는지 미리 본다.
const TOKENS: Record<string, JobTokenClaims> = {
  "owner-dm": { ...base, userId: OWNER, conversationId: 10, isPrivate: true, mcpHub: ["memory"] },
  "owner-server": { ...base, userId: OWNER, conversationId: 20, isPrivate: false, mcpHub: ["memory"] },
  "guest-server": { ...base, userId: BOB, conversationId: 30, isPrivate: false, mcpHub: ["memory"] },
  // 위치(isPrivate)가 없는 토큰 — 파일 반환 토큰처럼 옛 모양. 개인·공용을 가를 수 없으니 거부해야 한다.
  "no-location": { ...base, userId: OWNER, conversationId: 10, mcpHub: ["memory"] },
  // 허용 목록에 memory 가 없는 토큰 — 허브가 403 으로 막는다.
  "no-memory": { ...base, userId: OWNER, conversationId: 10, isPrivate: true, mcpHub: ["supabase"] },
};

let memories: MemoriesRepo;
let users: UsersRepo;
let logs: string[];
let deps: MemoryServerDeps;

beforeEach(async () => {
  const db = await openTestDb();
  memories = new MemoriesRepo(db, () => 1);
  users = new UsersRepo(db);
  await users.upsert(OWNER, { role: "owner", displayName: "운영자" });
  await users.upsert(BOB, { role: "allowed", displayName: "밥" });
  await memories.insert({ userId: OWNER, scope: "user", title: "고양이", content: "고양이 두 마리" });
  await memories.insert({ userId: BOB, scope: "user", title: "밥 선호", content: "매운 것 좋아함" });
  await memories.insert({ userId: BOB, scope: "shared", title: "회비", content: "한 학기 2만원" });
  logs = [];
  deps = { memories, users, ownerId: OWNER, log: (line) => logs.push(line) };
});

async function hub() {
  const handler = makeMcpHubHandler({
    verify: (t) => TOKENS[t] ?? null,
    servers: { memory: (claims) => makeMemoryServer(deps, claims) },
  });
  const server = http.createServer((req, res) => {
    if (req.url?.startsWith(MCP_HUB_PREFIX)) { handler(req, res); return; }
    res.writeHead(404); res.end();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  closers.push(() => new Promise((r) => server.close(() => r())));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

async function connect(baseUrl: string, token: string) {
  const client = new Client({ name: "test", version: "0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${baseUrl}${MCP_HUB_PREFIX}/memory`), { requestInit: { headers: { authorization: `Bearer ${token}` } } }));
  closers.push(() => client.close());
  return client;
}

async function call(client: Client, name: string, args: Record<string, unknown>) {
  const out = await client.callTool({ name, arguments: args });
  return { text: (out.content as Array<{ text: string }>)[0].text, isError: out.isError === true };
}

describe("memoryCtxFromClaims — 클레임 → 기억 도구 컨텍스트", () => {
  it("소유자 여부는 클레임의 userId 를 봇 설정의 소유자 id 와 견줘 정한다", () => {
    expect(memoryCtxFromClaims(deps, TOKENS["owner-dm"])).toMatchObject({ isOwner: true, isPrivate: true, userId: OWNER, conversationId: 10 });
    expect(memoryCtxFromClaims(deps, TOKENS["guest-server"])).toMatchObject({ isOwner: false, isPrivate: false, userId: BOB, conversationId: 30 });
  });

  it("위치(isPrivate)가 없는 토큰이면 null — 개인·공용을 가를 수 없다", () => {
    expect(memoryCtxFromClaims(deps, TOKENS["no-location"])).toBeNull();
  });
});

describe("허브 memory 서버 — 하네스 턴의 기억 도구", () => {
  it("remember·recall·forget 셋을 노출한다", async () => {
    const client = await connect(await hub(), "owner-dm");
    expect((await client.listTools()).tools.map((t) => t.name).sort()).toEqual(["forget", "recall", "remember"]);
  });

  it("DM 토큰으로 저장하면 그 사람의 개인 기억, 서버 토큰으로 저장하면 동아리 공용 기억이 된다(위치가 정한다)", async () => {
    const baseUrl = await hub();
    const dm = await call(await connect(baseUrl, "owner-dm"), "remember", { title: "운영 메모", content: "금요일 점검" });
    expect(dm.text).toBe('기억했어요: "운영 메모"');
    const server = await call(await connect(baseUrl, "owner-server"), "remember", { title: "모임 장소", content: "공학관 301호" });
    expect(server.text).toBe('동아리 공용으로 기억했어요: "모임 장소"');
    const all = await memories.all();
    expect(all.find((m) => m.title === "운영 메모")).toMatchObject({ scope: "user", userId: OWNER });
    expect(all.find((m) => m.title === "모임 장소")).toMatchObject({ scope: "shared", userId: OWNER });
  });

  it("공용 기억 상한은 봇 세션과 같다 — 4000자를 넘으면 저장하지 않는다", async () => {
    const client = await connect(await hub(), "owner-server");
    const r = await call(client, "remember", { title: "긴 문서", content: "가".repeat(4001) });
    expect(r.text).toMatch(/4000자까지/);
    expect((await memories.all()).some((m) => m.title === "긴 문서")).toBe(false);
  });

  it("recall 풀은 봇 세션과 같다 — 소유자 DM 은 전부, 서버 채널은 공용만", async () => {
    const baseUrl = await hub();
    const dm = await call(await connect(baseUrl, "owner-dm"), "recall", { query: "매운" });
    expect(dm.text).toContain("매운 것 좋아함");
    const server = await call(await connect(baseUrl, "owner-server"), "recall", { query: "고양이" });
    expect(server.text).toBe("관련 기억이 없어요.");
    // 공용 기억에는 작성자 표시가 붙는다(memoryScope.ts 의 renderMemories 를 그대로 쓴다).
    const shared = await call(await connect(baseUrl, "owner-server"), "recall", { query: "회비" });
    expect(shared.text).toContain("(밥 등록)");
  });

  it("forget 은 소유자만 — 손님 클레임이면 거절하고 아무것도 지우지 않는다", async () => {
    const client = await connect(await hub(), "guest-server");
    const r = await call(client, "forget", { title: "회비" });
    expect(r.text).toBe("이 작업은 소유자만 할 수 있어요.");
    expect((await memories.sharedOnly()).map((m) => m.title)).toEqual(["회비"]);
  });

  it("소유자는 공용 기억을 지울 수 있다", async () => {
    const client = await connect(await hub(), "owner-dm");
    const r = await call(client, "forget", { title: "회비" });
    expect(r.text).toBe('공용 기억을 지웠어요: "회비"');
    expect(await memories.sharedOnly()).toEqual([]);
  });

  it("위치가 없는 토큰이면 도구가 오류를 돌려주고 아무것도 저장하지 않는다(fail closed)", async () => {
    const client = await connect(await hub(), "no-location");
    const r = await call(client, "remember", { title: "몰래", content: "x" });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/위치/);
    expect((await memories.all()).some((m) => m.title === "몰래")).toBe(false);
  });

  it("토큰 허용 목록에 memory 가 없으면 붙지 못한다(403)", async () => {
    await expect(connect(await hub(), "no-memory")).rejects.toThrow();
  });

  it("실제로 쓰거나 지운 때만 봇 로그에 남긴다 — 기억 번호·범위와 누가·어느 대화·어느 작업, 제목·내용은 없다", async () => {
    const baseUrl = await hub();
    const owner = await connect(baseUrl, "owner-dm");
    await call(owner, "remember", { title: "비밀 제목", content: "비밀 내용" });
    // 조회는 남기지 않는다(DB 읽기가 전원에게 열려 있어 새로 드러나는 것이 없다).
    await call(owner, "recall", { query: "고양이" });
    // 거절된 삭제(소유자 전용)는 DB 에 닿지 않았으니 줄이 없다 — 감사 줄은 시도가 아니라 결과다.
    await call(await connect(baseUrl, "guest-server"), "forget", { title: "회비" });
    const feeId = (await memories.sharedOnly())[0].id;
    await call(owner, "forget", { title: "회비" });
    expect(logs).toHaveLength(2);
    expect(logs[0]).toMatch(/^\[mcp\] memory remember — user 기억 번호 \d+/);
    expect(logs[1]).toMatch(new RegExp(`^\\[mcp\\] memory forget — 기억 번호 ${feeId} `));
    for (const line of logs) {
      expect(line).toContain(`사용자 ${OWNER}`);
      expect(line).toContain("대화 10");
      expect(line).toContain("작업 job-ab");
      expect(line).not.toMatch(/비밀|회비/);
    }
  });

  it("DB 오류의 원문은 세션에 돌려주지 않고 봇 로그에만 남긴다", async () => {
    vi.spyOn(memories, "all").mockRejectedValue(new Error("connect ECONNREFUSED db-host.internal:6543"));
    const r = await call(await connect(await hub(), "owner-dm"), "recall", { query: "고양이" });
    expect(r.isError).toBe(true);
    expect(r.text).toBe("기억 저장소에 닿지 못했어요. 잠시 뒤 다시 시도해 주세요.");
    expect(r.text).not.toMatch(/db-host/);
    expect(logs.some((l) => l.includes("[mcp] memory 오류") && l.includes("db-host.internal"))).toBe(true);
  });
});
