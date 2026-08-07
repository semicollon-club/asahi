import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventBus, type AgentEvent, type ConversationHint } from "../src/events/bus.js";
import { openTestDb } from "../src/store/db.js";
import { UsersRepo } from "../src/store/usersRepo.js";
import { ConversationsRepo } from "../src/store/conversationsRepo.js";
import { ParticipantsRepo } from "../src/store/participantsRepo.js";
import { MessagesRepo } from "../src/store/messagesRepo.js";
import { SummariesRepo } from "../src/store/summariesRepo.js";
import { MemoriesRepo } from "../src/store/memoriesRepo.js";
import { TurnsRepo } from "../src/store/turnsRepo.js";
import { AllowedDirsRepo } from "../src/store/allowedDirsRepo.js";
import { ProjectsRepo } from "../src/store/projectsRepo.js";
import { ActionsRepo } from "../src/store/actionsRepo.js";
import { IntrospectRepo } from "../src/store/introspectRepo.js";
import { AgentCore, formatProgress } from "../src/core/core.js";
import { buildToolDefinitions, type ToolCtx } from "../src/core/tools.js";
import { progressFromMessage, type PendingTool, type ProgressUpdate } from "../src/core/agent.js";
import { makeExecutors } from "../src/remote/executors.js";
import type { Config } from "../src/config.js";
import type { TurnRequest, TurnResult } from "../src/core/agent.js";

// ── 실패 신호 이음매(seam) 통합 테스트 ──────────────────────────────────────────
// 이 브랜치의 목적 절반은 "부원에게 실패 사유를 보여주고, 소유자가 나중에 병목을 분석하게" 하는
// 것인데, 그 신호는 다음 다섯 마디를 전부 지나야 도착한다:
//
//   워커/봇 필터(ok:false) → remoteToolHandler → 도구 선언(textResult 의 isError)
//     → progressFromMessage(is_error → ok) → formatProgress(✗) / actions.status='error'
//
// 지금까지 ✗·error 를 다루는 테스트는 전부 ProgressUpdate 를 손으로 지어냈다 — 그래서 위 사슬의
// 세 번째 마디(도구 선언이 isError 를 세우는가)가 한 번도 실행된 적이 없었고, 그 마디가 끊겨
// 있다는 사실(모든 실패가 ✓·status='ok' 로 표시·기록됨)이 다섯 번의 태스크 리뷰를 통과했다.
// 그래서 이 파일의 모든 테스트는 반드시 "실제 생산자"에서 출발한다: 손으로 지어낸 이벤트가 아니라
// buildToolDefinitions(ctx) 가 돌려주는 진짜 도구 선언의 handler 를 그대로 호출한다.

// SDK 가 MCP 결과(CallToolResult)를 Anthropic 메시지의 tool_result 블록으로 옮기는 규칙 그대로의
// 변환. 이 한 줄만은 테스트가 손으로 쓴다 — 실제 SDK 프로세스(query())를 띄우지 않고 이음매를
// 검증하려면 다른 방법이 없기 때문이다. 다만 값 자체는 하나도 지어내지 않는다: content 도
// isError 도 방금 실행한 진짜 handler 가 만든 것을 그대로 옮길 뿐이다(MCP 규약: isError 가
// 없으면 성공 — 그래서 `?? undefined` 가 아니라 있는 값을 그대로 싣는다).
type CallToolResultLike = { content: unknown; isError?: boolean };
const toolResultBlockOf = (toolUseId: string, r: CallToolResultLike) => ({
  type: "tool_result" as const,
  tool_use_id: toolUseId,
  content: r.content,
  is_error: r.isError,
});

// 도구 이름으로 실제 선언을 찾아 그 handler 를 그대로 실행한다(선언 목록은 운영 코드가 쓰는 것과
// 동일한 배열이다 — buildTools 가 이 함수의 결과를 그대로 createSdkMcpServer 에 넘긴다).
async function callTool(ctx: ToolCtx, name: string, args: Record<string, unknown>): Promise<CallToolResultLike> {
  const def = buildToolDefinitions(ctx).find((d) => d.name === name);
  if (!def) throw new Error(`도구 선언을 찾지 못했다: ${name}`);
  return (await def.handler(args as never, undefined)) as CallToolResultLike;
}

// 진짜 도구 선언 → 진짜 progressFromMessage 까지 한 번에 통과시킨다. 반환값이 곧 코어(onProgress)가
// 실제로 받게 되는 ProgressUpdate 다.
async function updateFromRealTool(ctx: ToolCtx, name: string, args: Record<string, unknown>): Promise<ProgressUpdate> {
  const result = await callTool(ctx, name, args);
  const pending = new Map<string, PendingTool>([["tu-1", { name, input: String(args.path ?? ""), startedAt: 0 }]]);
  const updates = progressFromMessage(
    { type: "user", message: { content: [toolResultBlockOf("tu-1", result)] } },
    pending,
    () => 7,
  );
  expect(updates).toHaveLength(1);
  return updates[0]!;
}

// 원격 도구 한 번을 실제로 돌릴 수 있는 최소 ToolCtx. remote.call 은 진짜 워커 실행기
// (makeExecutors)에 직접 연결한다 — 네트워크 계층(workerClient/hub)만 생략하고, "워커가 성패를
// 계산한다"는 부분은 실물 그대로다.
async function toolCtxWithRealWorker(o: { roots: string[]; allowed: string[] }): Promise<ToolCtx> {
  const db = await openTestDb();
  const executors = makeExecutors(o.roots);
  return {
    github: null,
    now: () => 1_000_000,
    repos: {
      memories: new MemoriesRepo(db), users: new UsersRepo(db),
      allowedDirs: { list: async () => o.allowed } as unknown as AllowedDirsRepo,
      introspect: new IntrospectRepo(db), projects: new ProjectsRepo(db),
    },
    role: "owner", isPrivate: true, isOwner: true, userId: "owner", conversationId: 1,
    runtime: { model: "claude-opus-4-8", sdkVersion: "0.3.207", deployTarget: "local", maxTurns: 30, workers: [] },
    remote: {
      workerId: "test-worker", workerKind: "personal", roots: o.roots,
      call: (tool, args) => executors[tool]!(args),
    },
  };
}

describe("이음매 — 원격 도구의 실패가 도구 선언에서 isError 로 실린다(실제 생산자에서 출발)", () => {
  let root: string;
  let allowed: string;

  const mkRoot = () => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "asahi-seam-")));
    allowed = path.join(root, "allowed");
    fs.mkdirSync(allowed, { recursive: true });
    fs.writeFileSync(path.join(allowed, "a.txt"), "본문");
  };

  it("봇 쪽 1차 필터의 거부(허용 폴더 밖)는 isError:true 로 나간다", async () => {
    mkRoot();
    const ctx = await toolCtxWithRealWorker({ roots: [root], allowed: [allowed] });
    const r = await callTool(ctx, "fs_write", { path: path.join(root, "밖.txt"), content: "x" });
    expect(r.isError).toBe(true);
    expect(JSON.stringify(r.content)).toContain("허용된 폴더 밖");
  });

  it("워커가 계산한 실패(ok:false)도 isError:true 로 나간다", async () => {
    mkRoot();
    // 허용 폴더 안이라 봇 쪽 필터는 통과한다 — 실패를 판정하는 건 워커(실행기)다.
    const ctx = await toolCtxWithRealWorker({ roots: [root], allowed: [allowed] });
    const r = await callTool(ctx, "fs_read", { path: path.join(allowed, "없는파일.txt") });
    expect(r.isError).toBe(true);
  });

  it("성공은 isError 를 세우지 않는다(MCP 규약: 없으면 성공 — 회귀 방지)", async () => {
    mkRoot();
    const ctx = await toolCtxWithRealWorker({ roots: [root], allowed: [allowed] });
    const r = await callTool(ctx, "fs_read", { path: path.join(allowed, "a.txt") });
    expect(r.isError).toBeFalsy();
    expect(JSON.stringify(r.content)).toContain("본문");
  });

  it("워커 미연결 안내도 실패다 — 성공으로 표시·기록되면 안 된다", async () => {
    mkRoot();
    const ctx = await toolCtxWithRealWorker({ roots: [root], allowed: [allowed] });
    delete (ctx as { remote?: unknown }).remote;
    const r = await callTool(ctx, "sh_exec", { command: "echo hi" });
    expect(r.isError).toBe(true);
  });

  it("비원격 도구(recall)의 동작은 그대로다 — 이 태스크는 원격 도구의 성패 전달만 고친다", async () => {
    mkRoot();
    const ctx = await toolCtxWithRealWorker({ roots: [root], allowed: [allowed] });
    const r = await callTool(ctx, "recall", { query: "없는기억" });
    expect(r.isError).toBeFalsy();
  });
});

describe("이음매 — 그 isError 가 progressFromMessage 의 ok 와 formatProgress 의 ✗ 로 이어진다", () => {
  it("거부된 fs_write → ok:false → '✗' 와 사유가 한 줄에 보인다", async () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "asahi-seam2-")));
    const allowed = path.join(root, "allowed");
    fs.mkdirSync(allowed, { recursive: true });
    const ctx = await toolCtxWithRealWorker({ roots: [root], allowed: [allowed] });

    const update = await updateFromRealTool(ctx, "fs_write", { path: path.join(root, "밖.txt"), content: "x" });

    expect(update.kind).toBe("tool_result");
    expect(update).toMatchObject({ ok: false });
    const line = formatProgress(update);
    expect(line).toContain("✗");
    expect(line).toContain("fs_write");
    expect(line).toContain("허용된 폴더 밖");
    expect(line).not.toContain("✓");
    expect(line).not.toContain("완료");
  });

  it("성공한 fs_read → ok:true → '✓'(대조군)", async () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "asahi-seam3-")));
    const allowed = path.join(root, "allowed");
    fs.mkdirSync(allowed, { recursive: true });
    fs.writeFileSync(path.join(allowed, "a.txt"), "본문");
    const ctx = await toolCtxWithRealWorker({ roots: [root], allowed: [allowed] });

    const update = await updateFromRealTool(ctx, "fs_read", { path: path.join(allowed, "a.txt") });
    expect(update).toMatchObject({ ok: true });
    expect(formatProgress(update)).toContain("✓");
  });
});

// ── 마지막 마디: 그 ProgressUpdate 가 코어를 거쳐 actions.status='error' 로 기록된다 ──────────
// 원장의 "알려진 Minor 3 — status:'error' 분기가 통합 테스트에서 되읽힌 적 없음"을 함께 닫는다.
// 여기서도 이벤트를 지어내지 않는다: 위 updateFromRealTool 이 진짜 도구 선언에서 만들어 낸 값을
// 그대로 코어의 onProgress 에 넣고, 실제 ActionsRepo(pg-mem)에서 되읽는다.
async function coreSetup() {
  const db = await openTestDb();
  const repos = {
    users: new UsersRepo(db), conversations: new ConversationsRepo(db), participants: new ParticipantsRepo(db),
    messages: new MessagesRepo(db), summaries: new SummariesRepo(db), memories: new MemoriesRepo(db),
    turns: new TurnsRepo(db), allowedDirs: new AllowedDirsRepo(db), actions: new ActionsRepo(db),
    projects: new ProjectsRepo(db),
  };
  await repos.users.upsert("owner", { role: "owner" });
  const config: Config = {
    discordToken: "t", ownerId: "owner", databaseUrl: "postgres://test", dataDir: ":memory:", memoryDir: "x",
    sessionIdleMinutes: 30, maxTurnsPerHour: 30, maxTurnsPerHourPerUser: 20, maxTurnsPerHourGlobal: 40,
    ownerReserve: 10, deployTarget: "local", model: "claude-opus-4-8", httpPort: 3000, digestChannels: {},
    // 깃허브 발행 미설정 — 이 테스트의 관심사가 아니다. 설정이 없으면 발행 도구가 안 열린다.
    github: null,
  };
  const calls: TurnRequest[] = [];
  const runTurn = (req: TurnRequest): Promise<TurnResult> => {
    calls.push(req);
    return Promise.resolve({ text: "답변", sessionId: "s1", ok: true });
  };
  const bus = new EventBus();
  const core = new AgentCore({ bus, config, runTurn, now: () => 1_000_000, repos, agentCwd: "/data/agent" });
  core.start();
  const published: AgentEvent[] = [];
  bus.subscribe("progress", (e) => { published.push(e); });
  return { bus, core, calls, repos, published };
}

const dmHint = (userId: string): ConversationHint => ({
  kind: "dm", discordChannelId: `dm-${userId}`, isPrivate: true, primaryUserId: userId,
  userId, role: "owner", discordMessageId: `msg-${userId}-1`,
});

describe("이음매 — 그 ok:false 가 actions.status='error' 로 기록되고 진행 이벤트로도 발행된다", () => {
  it("거부된 fs_write 한 번이 status='error' 한 행이 된다(손으로 지어낸 이벤트가 아니다)", async () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "asahi-seam4-")));
    const allowed = path.join(root, "allowed");
    fs.mkdirSync(allowed, { recursive: true });
    const toolCtx = await toolCtxWithRealWorker({ roots: [root], allowed: [allowed] });
    const update = await updateFromRealTool(toolCtx, "fs_write", { path: path.join(root, "밖.txt"), content: "x" });

    const t = await coreSetup();
    t.bus.publish({ type: "user_message", channel: "discord", channelRef: "dm-owner", text: "파일 써줘", ts: 1, hint: dmHint("owner") });
    await t.core.drain();
    t.calls[0]!.onProgress?.(update);
    await t.core.drain();

    const rows = await t.repos.actions.recent(10);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ tool: "fs_write", status: "error", userId: "owner" });
    expect(rows[0]!.resultSummary).toContain("허용된 폴더 밖");
    // 같은 이벤트 하나에서 표시도 나온다(두 소비자, 한 이벤트).
    expect(t.published.some((e) => e.type === "progress" && e.text.includes("✗"))).toBe(true);
  });

  it("성공한 fs_read 는 status='ok' 로 기록된다(대조군 — 두 분기가 실제로 갈린다)", async () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "asahi-seam5-")));
    const allowed = path.join(root, "allowed");
    fs.mkdirSync(allowed, { recursive: true });
    fs.writeFileSync(path.join(allowed, "a.txt"), "본문");
    const toolCtx = await toolCtxWithRealWorker({ roots: [root], allowed: [allowed] });
    const update = await updateFromRealTool(toolCtx, "fs_read", { path: path.join(allowed, "a.txt") });

    const t = await coreSetup();
    t.bus.publish({ type: "user_message", channel: "discord", channelRef: "dm-owner", text: "파일 읽어줘", ts: 1, hint: dmHint("owner") });
    await t.core.drain();
    t.calls[0]!.onProgress?.(update);
    await t.core.drain();

    const rows = await t.repos.actions.recent(10);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ tool: "fs_read", status: "ok" });
  });
});
