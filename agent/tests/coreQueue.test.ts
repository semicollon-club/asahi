import { describe, it, expect, vi } from "vitest";
import { setupCore, flush, threadHint } from "./helpers/coreSetup.js";
import { mergeQueuedMessages, EDIT_TOO_LATE } from "../src/core/core.js";
import type { ConversationHint, AgentEvent } from "../src/events/bus.js";
import type { TurnRequest, TurnResult } from "../src/core/agent.js";

// 빠른 개선 2차 §3.5·§3.6(2026-11-25) — 기다리는 동안 보낸 같은 사람의 메시지는 다음 턴 하나로 묶고, 아직 시작하지 않은 메시지를
// 고치면 고친 내용으로 처리한다.

type Fixture = Awaited<ReturnType<typeof setupCore>>;

// 첫 턴을 release() 전까지 붙잡는 가짜 실행기 — 그 사이에 온 메시지가 대기열에 쌓인다.
async function blockedFirstTurn() {
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  let n = 0;
  const f = await setupCore({
    runTurn: async (_req: TurnRequest): Promise<TurnResult> => {
      n++;
      const mine = n;
      if (mine === 1) await gate;
      return { text: `답${mine}`, sessionId: "s1", ok: true };
    },
  });
  return { f, release };
}

function send(f: Fixture, hint: ConversationHint, discordMessageId: string, text: string): void {
  f.bus.publish({ type: "user_message", channel: "discord", channelRef: hint.discordChannelId, text, ts: 1_000_000, hint: { ...hint, discordMessageId } });
}

function edit(f: Fixture, channelRef: string, discordMessageId: string, userId: string, text: string): void {
  f.bus.publish({ type: "user_message_edit", channel: "discord", channelRef, discordMessageId, userId, text, ts: 1_000_001 });
}

describe("mergeQueuedMessages — 묶기(순수)", () => {
  const img = (name: string) => ({ url: `https://x/${name}`, mediaType: "image/png", name, size: 1 });
  it("하나면 그대로, 여럿이면 이어 보낸 표시로 잇는다", () => {
    expect(mergeQueuedMessages([{ text: "a", images: [], files: [], rejectedFiles: [] }]).text).toBe("a");
    const m = mergeQueuedMessages([
      { text: "첫째", images: [], files: [], rejectedFiles: [] },
      { text: "둘째", images: [], files: [], rejectedFiles: ["x.bin(너무 큼)"] },
    ]);
    expect(m.text).toBe("첫째\n\n(이어서 보낸 메시지)\n둘째");
    expect(m.rejectedFiles).toEqual(["x.bin(너무 큼)"]);
  });

  it("이미지는 합쳐서 한 번에 실을 수 있는 수(4장)까지, 넘친 것은 거절 사유로", () => {
    const m = mergeQueuedMessages([
      { text: "a", images: [img("1"), img("2"), img("3")], files: [], rejectedFiles: [] },
      { text: "b", images: [img("4"), img("5"), img("6")], files: [], rejectedFiles: [] },
    ]);
    expect(m.images.map((i) => i.name)).toEqual(["1", "2", "3", "4"]);
    expect(m.rejectedFiles).toEqual(["5(한 번에 4장까지라 빠짐)", "6(한 번에 4장까지라 빠짐)"]);
  });
});

describe("코어 — 대기 메시지 묶기", () => {
  it("진행 중인 턴 뒤에 같은 사람이 보낸 메시지 둘은 다음 턴 하나로 묶이고, 묶인 몫의 순번은 turn_merged 로 닫는다", async () => {
    const { f, release } = await blockedFirstTurn();
    const mergedEvents: AgentEvent[] = [];
    f.bus.subscribe("turn_merged", (e) => { mergedEvents.push(e); });
    const h = threadHint("guest", "th-q", "allowed");
    send(f, h, "d1", "첫 작업");
    await flush();
    send(f, h, "d2", "아 그리고");
    send(f, h, "d3", "이것도");
    await flush();
    release();
    await flush(); await f.core.drain();

    expect(f.calls).toHaveLength(2);
    expect(f.calls[1].prompt).toContain("아 그리고\n\n(이어서 보낸 메시지)\n이것도");
    expect(f.eventsIn("th-q", "assistant_message").map((e) => ("text" in e ? e.text : ""))).toEqual(["답1", "답2"]);
    // 종료 이벤트는 그 턴을 시작시킨 메시지를 가리킨다 — 어댑터가 완료 알림을 엉뚱한 사람에게 보내지 않게(2026-11-25 리뷰).
    expect(f.eventsIn("th-q", "assistant_message").map((e) => ("triggerId" in e ? e.triggerId : undefined))).toEqual(["d1", "d2"]);
    expect(mergedEvents).toEqual([expect.objectContaining({ type: "turn_merged", channelRef: "th-q" })]);
    expect(await f.repos.messages.unprocessedUserMessages()).toEqual([]);
  });

  it("앞 메시지의 처리 완료 표시가 실패해도 묶인 메시지들은 처리 완료로 남는다(2026-11-25 리뷰)", async () => {
    const { f, release } = await blockedFirstTurn();
    const h = threadHint("guest", "th-p", "allowed");
    send(f, h, "p1", "첫 작업");
    await flush();
    send(f, h, "p2", "둘째");
    send(f, h, "p3", "셋째");
    await flush();
    const real = f.repos.messages.markProcessed.bind(f.repos.messages);
    const rows = await f.repos.messages.unprocessedUserMessages();
    const p2 = rows.find((r) => r.content === "둘째")!.id;
    f.repos.messages.markProcessed = (async (id: number) => {
      if (id === p2) throw new Error("DB 연결 끊김(테스트)");
      return real(id);
    }) as typeof real;
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    release();
    await flush(); await f.core.drain();
    const left = (await f.repos.messages.unprocessedUserMessages()).map((r) => r.content);
    expect(left).toEqual(["둘째"]);
    errorSpy.mockRestore();
  });

  it("다른 사람의 메시지나 /새세션 이 끼면 그 앞에서 끊는다", async () => {
    const { f, release } = await blockedFirstTurn();
    const mergedEvents: AgentEvent[] = [];
    f.bus.subscribe("turn_merged", (e) => { mergedEvents.push(e); });
    const g1 = threadHint("guest", "th-r", "allowed");
    const g2 = threadHint("guest2", "th-r", "allowed");
    send(f, g1, "e1", "첫 작업");
    await flush();
    send(f, g1, "e2", "부원1 둘째");
    send(f, g2, "e3", "부원2 끼어듦");
    send(f, g1, "e4", "부원1 셋째");
    send(f, g1, "e5", "/새세션");
    send(f, g1, "e6", "부원1 넷째");
    await flush();
    release();
    await flush(); await f.core.drain();

    expect(f.calls.map((c) => c.prompt.split("메시지: ").pop())).toEqual(["첫 작업", "부원1 둘째", "부원2 끼어듦", "부원1 셋째", "부원1 넷째"]);
    expect(mergedEvents).toEqual([]);
  });
});

describe("코어 — 메시지 수정", () => {
  it("아직 시작하지 않은 메시지를 고치면 고친 내용으로 처리하고 기록도 바꾼다", async () => {
    const { f, release } = await blockedFirstTurn();
    const h = threadHint("guest", "th-e", "allowed");
    send(f, h, "m1", "첫 작업");
    await flush();
    send(f, h, "m2", "오타 있는 요청");
    await flush();
    edit(f, "th-e", "m2", "guest", "고친 요청");
    await flush();
    release();
    await flush(); await f.core.drain();

    expect(f.calls).toHaveLength(2);
    expect(f.calls[1].prompt).toContain("고친 요청");
    expect(f.calls[1].prompt).not.toContain("오타 있는 요청");
    const rows = await f.repos.messages.recent((await f.repos.conversations.getByChannelId("th-e"))!.id, 10);
    expect(rows.map((r) => r.content)).toContain("고친 요청");
  });

  it("이미 시작한 작업의 메시지를 고치면 반영되지 않았다고 한 번만 알린다", async () => {
    const { f, release } = await blockedFirstTurn();
    const h = threadHint("guest", "th-e2", "allowed");
    send(f, h, "k1", "첫 작업");
    await flush();
    edit(f, "th-e2", "k1", "guest", "고침 1");
    edit(f, "th-e2", "k1", "guest", "고침 2");
    await flush();
    release();
    await flush(); await f.core.drain();

    expect(f.eventsIn("th-e2", "side_notice").map((e) => ("text" in e ? e.text : ""))).toEqual([EDIT_TOO_LATE]);
    expect(f.calls[0].prompt).toContain("첫 작업");
  });

  it("끝난 메시지를 고친 것과 다른 사람이 보낸 수정은 무시한다", async () => {
    const { f, release } = await blockedFirstTurn();
    const h = threadHint("guest", "th-e3", "allowed");
    send(f, h, "z1", "첫 작업");
    await flush();
    send(f, h, "z2", "둘째");
    await flush();
    edit(f, "th-e3", "z2", "guest2", "남이 고침");
    release();
    await flush(); await f.core.drain();
    edit(f, "th-e3", "z1", "guest", "다 끝난 뒤 고침");
    await flush(); await f.core.drain();

    expect(f.calls[1].prompt).toContain("둘째");
    expect(f.calls[1].prompt).not.toContain("남이 고침");
    expect(f.eventsIn("th-e3", "side_notice")).toEqual([]);
  });
});
