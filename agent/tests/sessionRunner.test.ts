import { describe, it, expect, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  llmProxyUrlOf, mcpHubUrlOf, sessionDirFor, buildSessionEnv, buildQueryOptions, buildMcpServers, makeSessionRunner, type SessionQuery,
} from "../src/remote/sessionRunner.js";
import type { TurnStartFrame, Frame } from "../src/remote/protocol.js";

// 풀 하네스 2단계(2026-09-05 밤): 세션 러너 — 계정 B(워커)에서 Claude Code(Agent SDK query)를 통째로 돌린다. 자격증명은
// 없다: ANTHROPIC_BASE_URL 은 봇의 루프백 프록시(HUB_URL 에서 유도), ANTHROPIC_AUTH_TOKEN 은 봇이 turn.start 에 실어 준
// 작업 토큰이다. 스펙 §3·§4·§7.

const frame: TurnStartFrame = {
  type: "turn.start", id: "t1", userId: "123456789012345678", cwd: "/w", systemPrompt: "sys", prompt: "hi",
  profile: { model: "claude-opus-5", maxTurns: 30, subagents: true }, token: "asahi-job.p.s",
};

describe("llmProxyUrlOf — HUB_URL 에서 프록시 주소를 유도한다(fileReturnUrlOf 와 같은 규칙)", () => {
  it("ws://127.0.0.1:3100/worker → http://127.0.0.1:3100/llm", () => {
    expect(llmProxyUrlOf("ws://127.0.0.1:3100/worker")).toBe("http://127.0.0.1:3100/llm");
    expect(llmProxyUrlOf("wss://h/worker")).toBe("https://h/llm");
  });
  it("URL 이 아니면 null", () => {
    expect(llmProxyUrlOf("nope")).toBeNull();
  });
});

describe("mcpHubUrlOf·buildMcpServers — 허브 MCP(4단계 4.1)", () => {
  it("HUB_URL 에서 /mcp 베이스를 유도한다(프록시와 같은 http 베이스)", () => {
    expect(mcpHubUrlOf("ws://127.0.0.1:3100/worker")).toBe("http://127.0.0.1:3100/mcp");
    expect(mcpHubUrlOf("wss://h/worker")).toBe("https://h/mcp");
    expect(mcpHubUrlOf("nope")).toBeNull();
  });

  it("서버 이름마다 루프백 주소와 작업 토큰 헤더를 붙인다", () => {
    const servers = buildMcpServers(["github"], "http://127.0.0.1:3100/mcp", "asahi-job.x.y");
    expect(servers).toEqual({
      github: { type: "http", url: "http://127.0.0.1:3100/mcp/github", headers: { Authorization: "Bearer asahi-job.x.y" } },
    });
  });

  it("이름이 없거나 베이스가 없으면 undefined(옛 동작)", () => {
    expect(buildMcpServers(undefined, "http://h/mcp", "t")).toBeUndefined();
    expect(buildMcpServers([], "http://h/mcp", "t")).toBeUndefined();
    expect(buildMcpServers(["github"], undefined, "t")).toBeUndefined();
  });
});

describe("sessionDirFor — 부원별 CLAUDE_CONFIG_DIR", () => {
  it("루트 아래 userId 폴더다", () => {
    expect(sessionDirFor("/s", "123456789012345678")).toBe(path.join("/s", "123456789012345678"));
  });
  it("userId 가 식별자 모양이 아니면 던진다 — 경로 조각으로 폴더를 벗어나지 못한다", () => {
    expect(() => sessionDirFor("/s", "../evil")).toThrow();
    expect(() => sessionDirFor("/s", "")).toThrow();
  });
});

describe("buildSessionEnv — 세션 프로세스의 환경", () => {
  it("프록시 주소·작업 토큰·설정 폴더를 넣고, 진짜 자격증명 변수는 있어도 지운다", () => {
    const env = buildSessionEnv({
      baseEnv: { PATH: "/bin", CLAUDE_CODE_OAUTH_TOKEN: "leak", ANTHROPIC_API_KEY: "leak2", ANTHROPIC_AUTH_TOKEN: "old" },
      llmBaseUrl: "http://127.0.0.1:3100/llm", token: "asahi-job.p.s", configDir: "/s/u1",
    });
    expect(env.PATH).toBe("/bin");
    expect(env.ANTHROPIC_BASE_URL).toBe("http://127.0.0.1:3100/llm");
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe("asahi-job.p.s");
    expect(env.CLAUDE_CONFIG_DIR).toBe("/s/u1");
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
  });

  it("git 인자가 있으면 셸 git 과 같은 규약(GIT_CONFIG_*)으로 자격증명·신원을 얹는다", () => {
    const env = buildSessionEnv({
      baseEnv: {}, llmBaseUrl: "http://127.0.0.1:3100/llm", token: "t", configDir: "/s/u1",
      git: { token: "ghs_1", userName: "홍길동", userEmail: "u1@users.noreply.github.com" },
    });
    expect(env.GIT_CONFIG_COUNT).toBeDefined();
    expect(Object.values(env)).toContain("user.name");
    expect(Object.values(env)).toContain("홍길동");
    expect(env.ASAHI_GH_TOKEN).toBe("ghs_1");
  });
});

describe("buildQueryOptions — 프로필을 SDK 옵션으로", () => {
  it("cwd·env·시스템 프롬프트·resume·모델·maxTurns 를 옮기고, 권한은 묻지 않으며(bypassPermissions), 서브에이전트가 꺼지면 Task 를 막는다", () => {
    const env = { A: "1" };
    const opts = buildQueryOptions({ ...frame, resume: "sess-1", profile: { model: "claude-sonnet-5", maxTurns: 12, subagents: false, effort: "low" } }, env, [{ type: "local", path: "/p" }]);
    expect(opts).toMatchObject({
      cwd: "/w", env, systemPrompt: "sys", resume: "sess-1", model: "claude-sonnet-5", maxTurns: 12, effort: "low",
      permissionMode: "bypassPermissions", plugins: [{ type: "local", path: "/p" }], skills: "all",
    });
    expect((opts.disallowedTools as string[])).toContain("Task");
    expect(opts.abortController).toBeInstanceOf(AbortController);
  });

  it("서브에이전트가 열리면 Task 를 막지 않고, tools 가 없으면 내장 도구를 제한하지 않는다", () => {
    const opts = buildQueryOptions(frame, {}, []);
    expect(opts.disallowedTools).toBeUndefined();
    expect(opts.tools).toBeUndefined();
    expect(opts.resume).toBeUndefined();
    expect(opts.effort).toBeUndefined();
  });

  it("profile.tools 가 있으면 그대로 내장 도구 목록이 된다", () => {
    const opts = buildQueryOptions({ ...frame, profile: { ...frame.profile, tools: ["Read", "Grep"] } }, {}, []);
    expect(opts.tools).toEqual(["Read", "Grep"]);
  });

  it("profile.mcpHub·mcpBaseUrl 가 있으면 mcpServers 를 붙이고(작업 토큰 헤더), 없으면 안 붙인다(4단계 4.1)", () => {
    const withMcp = buildQueryOptions({ ...frame, token: "asahi-job.t", profile: { ...frame.profile, mcpHub: ["github"] } }, {}, [], "http://127.0.0.1:3100/mcp");
    expect(withMcp.mcpServers).toEqual({
      github: { type: "http", url: "http://127.0.0.1:3100/mcp/github", headers: { Authorization: "Bearer asahi-job.t" } },
    });
    // 베이스가 없으면(러너에 mcpBaseUrl 미주입) 안 붙는다.
    expect(buildQueryOptions({ ...frame, profile: { ...frame.profile, mcpHub: ["github"] } }, {}, []).mcpServers).toBeUndefined();
    // 이름이 없으면 안 붙는다.
    expect(buildQueryOptions(frame, {}, [], "http://127.0.0.1:3100/mcp").mcpServers).toBeUndefined();
  });

  it("로컬 인프로세스 MCP(4.5 send_file)를 허브 서버와 한 mcpServers 로 합친다", () => {
    const local = { file: { type: "sdk", name: "file", instance: {} } };
    // 허브 서버 + 로컬 서버 → 둘 다 mcpServers 에.
    const both = buildQueryOptions({ ...frame, token: "t", profile: { ...frame.profile, mcpHub: ["github"] } }, {}, [], "http://h/mcp", local);
    expect(Object.keys(both.mcpServers as Record<string, unknown>).sort()).toEqual(["file", "github"]);
    // 허브가 없어도 로컬만으로 mcpServers 가 붙는다.
    const onlyLocal = buildQueryOptions(frame, {}, [], undefined, local);
    expect(onlyLocal.mcpServers).toEqual(local);
    // 둘 다 없으면 undefined.
    expect(buildQueryOptions(frame, {}, []).mcpServers).toBeUndefined();
  });
});

// 가짜 query: 메시지 배열을 순서대로 낸다. 옵션은 기록해 둔다.
function fakeQuery(messages: Array<Record<string, unknown>>, seen: Array<{ prompt: string; options: Record<string, unknown> }>): SessionQuery {
  return (params) => {
    seen.push(params);
    return (async function* () { for (const m of messages) yield m; })();
  };
}

const initMsg = { type: "system", subtype: "init", session_id: "sess-new", model: "claude-opus-5" };
const toolUseMsg = { type: "assistant", message: { content: [{ type: "tool_use", id: "tu1", name: "Read", input: { file_path: "a.ts" } }] } };
const toolResultMsg = { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "tu1", content: [{ type: "text", text: "본문" }] }] } };
const textMsg = { type: "assistant", message: { content: [{ type: "text", text: "답" }] } };
const resultMsg = { type: "result", subtype: "success", result: "다 했어요", session_id: "sess-new" };

function tmpRoot() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "asahi-sess-"));
  return d;
}

describe("makeSessionRunner — turn.start 하나를 query() 한 번으로", () => {
  it("이벤트를 turn.event 로 흘리고 turn.result 로 끝낸다(진행 이벤트는 봇의 progressFromMessage 와 같은 모양)", async () => {
    const seen: Array<{ prompt: string; options: Record<string, unknown> }> = [];
    const root = tmpRoot();
    const runner = makeSessionRunner({ query: fakeQuery([initMsg, toolUseMsg, toolResultMsg, textMsg, resultMsg], seen), llmBaseUrl: "http://127.0.0.1:3100/llm", sessionRootDir: root, baseEnv: { PATH: "x" }, now: () => 1000 });
    const out: Frame[] = [];
    runner.start(frame, (f) => out.push(f));
    await vi.waitFor(() => expect(out.some((f) => f.type === "turn.result")).toBe(true));
    expect(out.map((f) => f.type)).toEqual(["turn.event", "turn.event", "turn.event", "turn.result"]);
    expect(out[0]).toEqual({ type: "turn.event", id: "t1", event: { kind: "tool", name: "Read", input: "a.ts" } });
    expect(out[1]).toMatchObject({ type: "turn.event", id: "t1", event: { kind: "tool_result", name: "Read", ok: true, summary: "본문" } });
    expect(out[2]).toEqual({ type: "turn.event", id: "t1", event: { kind: "answering" } });
    expect(out[3]).toEqual({ type: "turn.result", id: "t1", ok: true, text: "다 했어요", sessionId: "sess-new" });
    // query 에 넘긴 것: 프롬프트 그대로, 환경에는 프록시 주소·토큰·부원별 설정 폴더, 폴더는 실제로 만들어져 있다.
    expect(seen[0].prompt).toBe("hi");
    const env = seen[0].options.env as Record<string, string>;
    expect(env.ANTHROPIC_BASE_URL).toBe("http://127.0.0.1:3100/llm");
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe("asahi-job.p.s");
    expect(env.CLAUDE_CONFIG_DIR).toBe(path.join(root, frame.userId));
    expect(fs.existsSync(path.join(root, frame.userId))).toBe(true);
    expect(seen[0].options.cwd).toBe("/w");
    expect(runner.inFlight()).toBe(0);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("browserMcp·fileReturnUrl 이 있으면 로컬 MCP(browser·file)를 query 옵션의 mcpServers 에 넣는다(4.3·4.5)", async () => {
    const seen: Array<{ prompt: string; options: Record<string, unknown> }> = [];
    const root = tmpRoot();
    const runner = makeSessionRunner({
      query: fakeQuery([initMsg, resultMsg], seen), llmBaseUrl: "http://h/llm", sessionRootDir: root,
      fileReturnUrl: "http://127.0.0.1:3100/files", browserMcp: { command: "npx", args: ["-y", "@playwright/mcp@latest"] },
    });
    const out: Frame[] = [];
    runner.start(frame, (f) => out.push(f));
    await vi.waitFor(() => expect(out.some((f) => f.type === "turn.result")).toBe(true));
    const mcp = seen[0].options.mcpServers as Record<string, unknown>;
    expect(Object.keys(mcp).sort()).toEqual(["browser", "file"]);
    // alwaysLoad: 브라우저 stdio 는 늦게 떠서, 붙을 때까지 기다렸다 도구를 싣게 한다(4.3).
    expect(mcp.browser).toEqual({ command: "npx", args: ["-y", "@playwright/mcp@latest"], alwaysLoad: true });
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("result 가 success 가 아니면 ok:false 와 사유를 돌려준다", async () => {
    const runner = makeSessionRunner({ query: fakeQuery([initMsg, { type: "result", subtype: "error_max_turns", session_id: "s" }], []), llmBaseUrl: "http://h/llm", sessionRootDir: tmpRoot() });
    const out: Frame[] = [];
    runner.start(frame, (f) => out.push(f));
    await vi.waitFor(() => expect(out.some((f) => f.type === "turn.result")).toBe(true));
    expect(out.at(-1)).toMatchObject({ type: "turn.result", ok: false, error: expect.stringContaining("error_max_turns"), sessionId: "s" });
  });

  it("query 가 던지면(세션 없음 등) 메시지를 error 로 실어 실패 결과다 — 봇이 isSessionNotFound 로 판정한다", async () => {
    const throwing: SessionQuery = () => (async function* () { throw new Error("No conversation found with session ID sess-1"); })();
    const runner = makeSessionRunner({ query: throwing, llmBaseUrl: "http://h/llm", sessionRootDir: tmpRoot() });
    const out: Frame[] = [];
    runner.start({ ...frame, resume: "sess-1" }, (f) => out.push(f));
    await vi.waitFor(() => expect(out.some((f) => f.type === "turn.result")).toBe(true));
    expect(out.at(-1)).toEqual({ type: "turn.result", id: "t1", ok: false, text: "", error: "No conversation found with session ID sess-1" });
  });

  it("같은 부원의 턴이 진행 중이면 두 번째는 즉시 실패한다(부원별 세션 하나)", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const slow: SessionQuery = () => (async function* () { await gate; yield resultMsg; })();
    const runner = makeSessionRunner({ query: slow, llmBaseUrl: "http://h/llm", sessionRootDir: tmpRoot() });
    const out: Frame[] = [];
    runner.start(frame, (f) => out.push(f));
    runner.start({ ...frame, id: "t2" }, (f) => out.push(f));
    await vi.waitFor(() => expect(out.some((f) => f.type === "turn.result" && f.id === "t2")).toBe(true));
    expect(out.find((f) => f.type === "turn.result" && f.id === "t2")).toMatchObject({ ok: false, error: expect.stringContaining("진행 중") });
    expect(runner.inFlight()).toBe(1);
    release();
    await vi.waitFor(() => expect(out.some((f) => f.type === "turn.result" && f.id === "t1")).toBe(true));
    expect(runner.inFlight()).toBe(0);
  });

  it("cancel 은 그 턴의 AbortController 를 중단시킨다", async () => {
    let aborted = false;
    const q: SessionQuery = (p) => {
      const ac = p.options.abortController as AbortController;
      return (async function* () {
        await new Promise<void>((resolve) => { ac.signal.addEventListener("abort", () => { aborted = true; resolve(); }); });
        throw new Error("aborted");
      })();
    };
    const runner = makeSessionRunner({ query: q, llmBaseUrl: "http://h/llm", sessionRootDir: tmpRoot() });
    const out: Frame[] = [];
    runner.start(frame, (f) => out.push(f));
    runner.cancel("t1");
    await vi.waitFor(() => expect(out.some((f) => f.type === "turn.result")).toBe(true));
    expect(aborted).toBe(true);
    expect(out.at(-1)).toMatchObject({ type: "turn.result", ok: false });
  });

  it("idle() 은 진행 중인 턴이 모두 끝나면 풀린다(갱신 종료 순서가 기다린다)", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const slow: SessionQuery = () => (async function* () { await gate; yield resultMsg; })();
    const runner = makeSessionRunner({ query: slow, llmBaseUrl: "http://h/llm", sessionRootDir: tmpRoot() });
    runner.start(frame, () => {});
    let idle = false;
    void runner.idle().then(() => { idle = true; });
    await new Promise((r) => setTimeout(r, 10));
    expect(idle).toBe(false);
    release();
    await vi.waitFor(() => expect(idle).toBe(true));
  });

  it("userId 가 식별자 모양이 아니면 query 를 부르지 않고 실패 결과다", async () => {
    const seen: Array<{ prompt: string; options: Record<string, unknown> }> = [];
    const runner = makeSessionRunner({ query: fakeQuery([resultMsg], seen), llmBaseUrl: "http://h/llm", sessionRootDir: tmpRoot() });
    const out: Frame[] = [];
    runner.start({ ...frame, userId: "../x" }, (f) => out.push(f));
    await vi.waitFor(() => expect(out.some((f) => f.type === "turn.result")).toBe(true));
    expect(out.at(-1)).toMatchObject({ ok: false });
    expect(seen).toHaveLength(0);
  });
});

// 세션 cwd 관문(위험 등록부 §11, 2026-09-06). 봇이 신원에 맞게 폴더를 좁혀 보내지만(harnessCwdFor),
// 워커가 그 값을 그대로 믿으면 프레임 하나로 이 기계의 아무 폴더에서나 세션이 열린다 — 얇은 워커의
// `fs_*` 가 checkPath 를 거치는 것과 같은 자리에서 다시 판정한다.
describe("makeSessionRunner — 작업 폴더 관문(workerRoots)", () => {
  it("루트 밖 cwd 는 query 를 부르지도 않고 실패로 끝낸다", async () => {
    const seen: Array<{ prompt: string; options: Record<string, unknown> }> = [];
    const root = tmpRoot();
    const ws = tmpRoot();
    const runner = makeSessionRunner({
      query: fakeQuery([initMsg, resultMsg], seen), llmBaseUrl: "http://h/llm", sessionRootDir: root, workerRoots: [ws],
    });
    const out: Frame[] = [];
    runner.start({ ...frame, cwd: path.join(os.tmpdir(), "asahi-남의-폴더") }, (f) => out.push(f));
    await vi.waitFor(() => expect(out.some((f) => f.type === "turn.result")).toBe(true));
    expect(out.at(-1)).toMatchObject({ ok: false });
    expect(String((out.at(-1) as { error?: string }).error)).toContain("작업 폴더 밖");
    expect(seen).toHaveLength(0);
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(ws, { recursive: true, force: true });
  });

  it("루트 안이면 통과하고, 아직 없는 폴더는 만들어 준다 — 손님의 첫 턴", async () => {
    const seen: Array<{ prompt: string; options: Record<string, unknown> }> = [];
    const root = tmpRoot();
    const ws = tmpRoot();
    const mine = path.join(ws, "123456789012345678");
    expect(fs.existsSync(mine)).toBe(false);
    const runner = makeSessionRunner({
      query: fakeQuery([initMsg, resultMsg], seen), llmBaseUrl: "http://h/llm", sessionRootDir: root, workerRoots: [ws],
    });
    const out: Frame[] = [];
    runner.start({ ...frame, cwd: mine }, (f) => out.push(f));
    await vi.waitFor(() => expect(out.some((f) => f.type === "turn.result")).toBe(true));
    expect(out.at(-1)).toMatchObject({ ok: true });
    expect(fs.existsSync(mine)).toBe(true);
    // 실경로를 쓴다 — checkPath 가 심볼릭 링크·정션을 해소한 결과가 세션의 cwd 가 된다(§7).
    expect(seen[0].options.cwd).toBe(fs.realpathSync(mine));
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(ws, { recursive: true, force: true });
  });

  it("루트를 안 넘긴 구성은 판정도 생성도 하지 않는다(옛 동작·테스트 픽스처)", async () => {
    const seen: Array<{ prompt: string; options: Record<string, unknown> }> = [];
    const root = tmpRoot();
    const runner = makeSessionRunner({ query: fakeQuery([initMsg, resultMsg], seen), llmBaseUrl: "http://h/llm", sessionRootDir: root });
    const out: Frame[] = [];
    runner.start(frame, (f) => out.push(f));
    await vi.waitFor(() => expect(out.some((f) => f.type === "turn.result")).toBe(true));
    expect(seen[0].options.cwd).toBe("/w");
    expect(fs.existsSync("/w")).toBe(false);
    fs.rmSync(root, { recursive: true, force: true });
  });
});
