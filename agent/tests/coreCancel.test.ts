import { describe, it, expect, vi } from "vitest";
import { setupCore, flush, threadHint, say } from "./helpers/coreSetup.js";
import type { AgentEvent } from "../src/events/bus.js";
import type { TurnRequest, TurnResult } from "../src/core/agent.js";
import { describeTurnFailure } from "../src/core/failureText.js";

// N2 작업 취소(2026-11-25 설계 §3): /취소·버튼 → 코어의 requestCancel → 진행 중 턴의 AbortSignal.

const text = (e: AgentEvent) => ("text" in e ? e.text : "");

// 취소 가능한 가짜 턴: 신호가 중단되면 cancelled 로 끝나고, release() 를 부르면 정상으로 끝난다. 시작하자마자 도구
// 진행 이벤트 하나를 낸다 — 코어가 진행 이벤트에 kind 를 싣는지도 본다.
function cancellableTurns() {
  const pending: Array<{ req: TurnRequest; release: (r?: TurnResult) => void }> = [];
  const runTurn = (req: TurnRequest) => new Promise<TurnResult>((resolve) => {
    req.onProgress?.({ kind: "tool", name: "sh_exec", input: "npm test" });
    pending.push({ req, release: (r) => resolve(r ?? { ok: true, text: "다 했어요", sessionId: "s-done" }) });
    req.signal?.addEventListener("abort", () => resolve({ ok: false, text: "", sessionId: "s-cancel", cancelled: true }), { once: true });
  });
  return { runTurn, pending };
}

describe("requestCancel — 누가, 무엇을 멈추는가", () => {
  it("시킨 사람이 /취소 하면 턴이 멈추고, 세션을 저장하고, 멈췄다는 안내를 낸다(오류 안내가 아니다)", async () => {
    const t = cancellableTurns();
    const f = await setupCore({ runTurn: t.runTurn });
    const hint = threadHint("guest", "th-1", "allowed");
    say(f.bus, hint, "테스트 돌려줘");
    await flush();
    expect(t.pending).toHaveLength(1);

    say(f.bus, hint, "/취소");
    await flush();
    await f.core.drain();

    expect(t.pending[0].req.signal?.aborted).toBe(true);
    const answers = f.eventsIn("th-1", "assistant_message").map(text);
    expect(answers).toHaveLength(1);
    expect(answers[0]).toMatch(/작업을 멈췄어요/);
    expect(f.eventsIn("th-1", "system_notice")).toHaveLength(0);
    // 진행 표시에 중지 요청 줄이 남는다(그 턴의 상태 메시지에 붙는다).
    expect(f.eventsIn("th-1", "progress").some((e) => text(e).includes("중지 요청"))).toBe(true);
    // 다음 턴이 그 자리에서 이어받도록 멈춘 턴의 세션을 저장한다.
    expect((await f.repos.conversations.getByChannelId("th-1"))?.sessionId).toBe("s-cancel");
    // 예약어는 LLM 턴을 하나 더 열지 않는다.
    expect(f.calls).toHaveLength(1);
  });

  it("소유자는 부원의 턴도 멈출 수 있다", async () => {
    const t = cancellableTurns();
    const f = await setupCore({ runTurn: t.runTurn });
    say(f.bus, threadHint("guest", "th-2", "allowed"), "빌드해줘");
    await flush();
    say(f.bus, threadHint("owner", "th-2", "owner"), "/중지");
    await flush();
    await f.core.drain();
    expect(t.pending[0].req.signal?.aborted).toBe(true);
    expect(f.eventsIn("th-2", "assistant_message").map(text)[0]).toMatch(/작업을 멈췄어요/);
  });

  it("다른 부원은 남의 턴을 멈출 수 없다 — 안내만 하고 턴은 그대로 끝까지 간다", async () => {
    const t = cancellableTurns();
    const f = await setupCore({ runTurn: t.runTurn });
    say(f.bus, threadHint("guest", "th-3", "allowed"), "빌드해줘");
    await flush();
    say(f.bus, threadHint("guest2", "th-3", "allowed"), "/stop");
    await flush();

    expect(t.pending[0].req.signal?.aborted).toBe(false);
    expect(f.eventsIn("th-3", "side_notice").map(text)).toEqual([expect.stringMatching(/시킨 분이나 운영자만/)]);
    t.pending[0].release();
    await f.core.drain();
    expect(f.eventsIn("th-3", "assistant_message").map(text)).toEqual(["다 했어요"]);
  });

  it("진행 중인 턴이 없으면 '멈출 작업이 없어요'만 하고, 대화도 턴도 만들지 않는다", async () => {
    const f = await setupCore();
    say(f.bus, threadHint("guest", "th-4", "allowed"), "/취소");
    await flush();
    await f.core.drain();
    expect(f.eventsIn("th-4", "side_notice").map(text)).toEqual([expect.stringMatching(/멈출 작업이 없어요/)]);
    expect(await f.repos.conversations.getByChannelId("th-4")).toBeNull();
    expect(f.calls).toHaveLength(0);
    // 턴을 끝내는 이벤트(assistant_message·system_notice)를 내지 않는다 — 어댑터의 반응 순번을 건드리지 않는다.
    expect(f.eventsIn("th-4", "assistant_message")).toHaveLength(0);
    expect(f.eventsIn("th-4", "system_notice")).toHaveLength(0);
  });

  it("버튼(cancel_request 이벤트)도 같은 길로 멈춘다", async () => {
    const t = cancellableTurns();
    const f = await setupCore({ runTurn: t.runTurn });
    say(f.bus, threadHint("guest", "th-5", "allowed"), "작업");
    await flush();
    f.bus.publish({ type: "cancel_request", channel: "discord", channelRef: "th-5", userId: "guest", ts: f.now() });
    await flush();
    await f.core.drain();
    expect(t.pending[0].req.signal?.aborted).toBe(true);
    expect(f.eventsIn("th-5", "assistant_message").map(text)[0]).toMatch(/작업을 멈췄어요/);
  });

  it("이미 멈추는 중이면 두 번 누른 것을 알려 준다", async () => {
    // 중단 신호를 받아도 곧바로 끝나지 않는 턴(러너가 정리하는 데 시간이 걸리는 경우).
    const pending: Array<() => void> = [];
    const runTurn = (req: TurnRequest) => new Promise<TurnResult>((resolve) => {
      req.signal?.addEventListener("abort", () => pending.push(() => resolve({ ok: false, text: "", cancelled: true })), { once: true });
    });
    const f = await setupCore({ runTurn });
    const hint = threadHint("guest", "th-6", "allowed");
    say(f.bus, hint, "작업");
    await flush();
    say(f.bus, hint, "/취소");
    await flush();
    say(f.bus, hint, "/취소");
    await flush();
    expect(f.eventsIn("th-6", "side_notice").map(text)).toEqual([expect.stringMatching(/이미 멈추는 중/)]);
    pending[0]();
    await f.core.drain();
  });
});

describe("턴 도중 온 메시지·진행 이벤트", () => {
  it("진행 중인 턴이 있으면 '끝나면 이어서' 를 진행 표시에 남기고, 지금 턴이 끝난 뒤 처리한다", async () => {
    const t = cancellableTurns();
    const f = await setupCore({ runTurn: t.runTurn });
    say(f.bus, threadHint("guest", "th-7", "allowed"), "첫 번째");
    await flush();
    say(f.bus, threadHint("guest", "th-7", "allowed"), "두 번째");
    await flush();

    const notices = f.eventsIn("th-7", "progress").filter((e) => e.type === "progress" && e.kind === "notice").map(text);
    expect(notices).toEqual([expect.stringMatching(/끝나면 이어서/)]);
    expect(t.pending).toHaveLength(1);
    t.pending[0].release();
    await flush();
    expect(t.pending).toHaveLength(2);
    t.pending[1].release();
    await f.core.drain();
    expect(f.eventsIn("th-7", "assistant_message")).toHaveLength(2);
  });

  it("코어가 진행 이벤트에 줄의 종류(kind)를 싣는다 — 어댑터가 단계를 센다", async () => {
    const t = cancellableTurns();
    const f = await setupCore({ runTurn: t.runTurn });
    say(f.bus, threadHint("guest", "th-8", "allowed"), "작업");
    await flush();
    const kinds = f.eventsIn("th-8", "progress").map((e) => (e.type === "progress" ? e.kind : undefined));
    expect(kinds).toContain("tool");
    t.pending[0].release();
    await f.core.drain();
  });
});

describe("종료 이벤트의 안전(2026-11-25 리뷰)", () => {
  it("턴이 끝난 뒤(경보를 보내는 사이) 온 /취소 는 '멈출 작업이 없어요' 이고 진행 줄을 남기지 않는다", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const f = await setupCore({ runTurn: async () => ({ ok: false, text: "Failed to authenticate. API Error: 401 OAuth access token has been revoked." }) });
    // 소유자 경보가 소유자 DM 을 찾는 동안 멈춰 있게 한다 — 그 틈에 /취소 를 보낸다.
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    f.repos.conversations.findDmFor = async () => { await gate; return null; };
    const hint = threadHint("guest", "th-l2", "allowed");
    say(f.bus, hint, "작업");
    await flush();
    say(f.bus, hint, "/취소");
    await flush();
    release();
    await f.core.drain();
    expect(f.eventsIn("th-l2", "side_notice").map(text)).toEqual([expect.stringMatching(/멈출 작업이 없어요/)]);
    expect(f.eventsIn("th-l2", "progress").some((e) => text(e).includes("중지 요청"))).toBe(false);
  });

  it("기록(DB)이 실패해도 멈춤 안내는 나간다 — 안 나가면 진행 표시가 중지 버튼을 단 채 남는다", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const t = cancellableTurns();
    const f = await setupCore({ runTurn: t.runTurn });
    const hint = threadHint("guest", "th-db", "allowed");
    say(f.bus, hint, "작업");
    await flush();
    const insert = f.repos.messages.insert.bind(f.repos.messages);
    f.repos.messages.insert = (async (row: Parameters<typeof insert>[0]) => {
      if (row.role === "system") throw new Error("DB 연결 끊김(테스트)");
      return insert(row);
    }) as typeof insert;
    say(f.bus, hint, "/취소");
    await flush();
    await f.core.drain();
    expect(f.eventsIn("th-db", "assistant_message").map(text)[0]).toMatch(/작업을 멈췄어요/);
  });

  it("기록(DB)이 실패해도 오류 안내(notify)는 나간다", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const f = await setupCore({ runTurn: async () => ({ ok: false, text: "(에이전트 오류: error_max_turns)" }) });
    const insert = f.repos.messages.insert.bind(f.repos.messages);
    f.repos.messages.insert = (async (row: Parameters<typeof insert>[0]) => {
      if (row.role === "system") throw new Error("DB 연결 끊김(테스트)");
      return insert(row);
    }) as typeof insert;
    say(f.bus, threadHint("guest", "th-n2", "allowed"), "긴 작업");
    await flush();
    await f.core.drain();
    expect(f.eventsIn("th-n2", "system_notice").map(text)).toEqual([describeTurnFailure("(에이전트 오류: error_max_turns)", { showRaw: false })]);
  });

  it("도구 결과 진행 이벤트는 기록용 줄(record)을 따로 싣는다 — 진행 중 표시에는 요약이, 기록에는 요약 없이", async () => {
    const f = await setupCore({
      runTurn: async (req) => {
        req.onProgress?.({ kind: "tool_result", name: "fs_read", ok: true, summary: "TOKEN=sk-ant-oat01-x", durationMs: 100 });
        return { ok: true, text: "답", sessionId: "s" };
      },
    });
    say(f.bus, threadHint("guest", "th-r", "allowed"), "읽어줘");
    await flush();
    await f.core.drain();
    const ev = f.eventsIn("th-r", "progress").find((e) => e.type === "progress" && e.kind === "tool_result");
    expect(ev && "text" in ev ? ev.text : "").toContain("sk-ant");
    expect(ev?.type === "progress" ? ev.record : undefined).toBe("✓ fs_read (0.1초)");
  });
});

describe("중단이 결과 대신 예외로 오는 경우", () => {
  it("SDK 가 중단 뒤 던져도 취소로 처리한다 — '예기치 못한 오류' 가 아니다", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const runTurn = (req: TurnRequest) => new Promise<TurnResult>((_resolve, reject) => {
      req.signal?.addEventListener("abort", () => reject(new Error("Claude Code process aborted by user")), { once: true });
    });
    const f = await setupCore({ runTurn });
    const hint = threadHint("guest", "th-9", "allowed");
    say(f.bus, hint, "작업");
    await flush();
    say(f.bus, hint, "/취소");
    await flush();
    await f.core.drain();
    expect(f.eventsIn("th-9", "assistant_message").map(text)[0]).toMatch(/작업을 멈췄어요/);
    expect(f.eventsIn("th-9", "system_notice")).toHaveLength(0);
  });
});
