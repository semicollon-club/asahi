import { describe, it, expect, vi } from "vitest";
import { openTestDb } from "../src/store/db.js";
import { MemoriesRepo } from "../src/store/memoriesRepo.js";
import { UsersRepo } from "../src/store/usersRepo.js";
import { AllowedDirsRepo } from "../src/store/allowedDirsRepo.js";
import { ProjectsRepo } from "../src/store/projectsRepo.js";
import { PullRequestsRepo } from "../src/store/pullRequestsRepo.js";
import { IntrospectRepo } from "../src/store/introspectRepo.js";
import { makeRunAgentTurn, linkedAbortController, type ToolRepos } from "../src/core/agent.js";
import { makeJobTokenMinter, newJobTokenSecret } from "../src/core/jobToken.js";

// N2 작업 취소(2026-11-25 설계 §3) — 턴 실행기 쪽. 봇 자기 세션의 SDK 중단은 이음매 뒤라(이 저장소의 테스트는 SDK
// query 를 부르지 않는다) 신호를 SDK 의 AbortController 로 잇는 순수 함수만 여기서 보고, 하네스 경로는 가짜 허브로
// 끝까지 태운다.

async function repos(): Promise<ToolRepos> {
  const db = await openTestDb();
  return { memories: new MemoriesRepo(db), users: new UsersRepo(db), allowedDirs: new AllowedDirsRepo(db), introspect: new IntrospectRepo(db), projects: new ProjectsRepo(db), pullRequests: new PullRequestsRepo(db) };
}

describe("linkedAbortController — 바깥 신호가 SDK 의 AbortController 로 이어진다", () => {
  it("신호가 없으면 독립된 컨트롤러다", () => {
    expect(linkedAbortController().signal.aborted).toBe(false);
  });
  it("이미 중단된 신호면 처음부터 중단돼 있다", () => {
    const outer = new AbortController();
    outer.abort();
    expect(linkedAbortController(outer.signal).signal.aborted).toBe(true);
  });
  it("나중에 중단되면 따라서 중단된다", () => {
    const outer = new AbortController();
    const inner = linkedAbortController(outer.signal);
    outer.abort();
    expect(inner.signal.aborted).toBe(true);
  });
});

describe("makeRunAgentTurn — 하네스 턴 취소", () => {
  const ownerCtx = { role: "owner" as const, isPrivate: true, isOwner: true, userId: "owner", conversationId: 3, channelRef: "chan-3" };
  type Outcome = { ok: boolean; text: string; sessionId?: string; error?: string };

  function cancellableHub() {
    let finish!: (o: Outcome) => void;
    const state = { started: false, cancels: 0 };
    const hub = {
      isConnected: () => true,
      isHarness: () => true,
      rootsOf: () => ["C:\\asahi-workspace"],
      workersInfo: () => [],
      call: async () => ({ ok: true, content: "" }),
      startTurn: () => {
        state.started = true;
        return {
          id: "t1",
          result: new Promise<Outcome>((res) => { finish = res; }),
          // 실제 러너처럼: 중단을 받으면 그때까지의 세션 id 를 실은 실패 결과로 끝낸다.
          cancel: () => { state.cancels++; finish({ ok: false, text: "", error: "Claude Code process aborted by user", sessionId: "sess-c" }); },
        };
      },
    };
    return { hub, state, finishNormally: (o: Outcome) => finish(o) };
  }

  it("신호가 중단되면 러너에 cancel 을 보내고, 러너가 준 세션 id 로 cancelled 결과를 돌려준다", async () => {
    const r = await repos();
    const { hub, state } = cancellableHub();
    const run = makeRunAgentTurn(r, "local", "claude-opus-5", { sharedWorkerId: async () => "w" }, hub as never, null, () => 0, { jobTokens: makeJobTokenMinter(newJobTokenSecret()), harness: { enabled: true } });
    const ac = new AbortController();
    const p = run({ prompt: "p", systemPrompt: "s", cwd: "/bot", context: ownerCtx, signal: ac.signal });
    await vi.waitFor(() => expect(state.started).toBe(true));
    ac.abort();
    expect(await p).toEqual({ ok: false, cancelled: true, text: "", sessionId: "sess-c" });
    expect(state.cancels).toBe(1);
  });

  it("중단되지 않은 턴은 예전과 같다 — cancelled 가 붙지 않는다", async () => {
    const r = await repos();
    const { hub, state, finishNormally } = cancellableHub();
    const run = makeRunAgentTurn(r, "local", "claude-opus-5", { sharedWorkerId: async () => "w" }, hub as never, null, () => 0, { jobTokens: makeJobTokenMinter(newJobTokenSecret()), harness: { enabled: true } });
    const p = run({ prompt: "p", systemPrompt: "s", cwd: "/bot", context: ownerCtx, signal: new AbortController().signal });
    await vi.waitFor(() => expect(state.started).toBe(true));
    finishNormally({ ok: true, text: "끝", sessionId: "sess-h" });
    expect(await p).toEqual({ ok: true, text: "끝", sessionId: "sess-h" });
    expect(state.cancels).toBe(0);
  });

  it("턴이 시작되기 전에 이미 중단돼 있으면 시작하자마자 cancel 한다", async () => {
    const r = await repos();
    const { hub, state } = cancellableHub();
    const run = makeRunAgentTurn(r, "local", "claude-opus-5", { sharedWorkerId: async () => "w" }, hub as never, null, () => 0, { jobTokens: makeJobTokenMinter(newJobTokenSecret()), harness: { enabled: true } });
    const ac = new AbortController();
    ac.abort();
    const result = await run({ prompt: "p", systemPrompt: "s", cwd: "/bot", context: ownerCtx, signal: ac.signal });
    expect(state.cancels).toBe(1);
    expect(result.cancelled).toBe(true);
  });
});
