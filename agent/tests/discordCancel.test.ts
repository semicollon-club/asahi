import { describe, it, expect } from "vitest";
import { DiscordAdapter, CANCEL_BUTTON_ID } from "../src/adapters/discord.js";
import { EventBus, type AgentEvent } from "../src/events/bus.js";
import type { Config } from "../src/config.js";
import type { UsersRepo } from "../src/store/usersRepo.js";
import type { ConversationsRepo } from "../src/store/conversationsRepo.js";

// N2 작업 취소(2026-11-25 설계 §3) — 어댑터 쪽: 상태 메시지의 중지 버튼, 버튼 클릭 → cancel_request, /취소 메시지는
// 반응 순번(pendingTriggers)에 넣지 않는다.

function makeConfig(): Config {
  return {
    discordToken: "t", ownerId: "owner", databaseUrl: "postgres://test", dataDir: ":memory:", memoryDir: "x",
    sessionIdleMinutes: 30, maxTurnsPerHour: 30, maxTurnsPerHourPerUser: 20, maxTurnsPerHourGlobal: 40, ownerReserve: 10,
    deployTarget: "local", model: "m", httpPort: 3000, digestChannels: {}, github: null,
  };
}

type Testable = {
  client: unknown;
  onInteraction(i: unknown): Promise<void>;
  onMessage(m: unknown): Promise<void>;
  handleProgress(channelRef: string, text: string, kind?: string): Promise<void>;
  progressState: Map<string, { pendingTriggers: unknown[] }>;
};

function makeAdapter(role: "owner" | "allowed" | "blocked") {
  const bus = new EventBus();
  const events: AgentEvent[] = [];
  bus.subscribe("cancel_request", (e) => { events.push(e); });
  bus.subscribe("user_message", (e) => { events.push(e); });
  const users = { getRole: async () => role, upsert: async () => {} } as unknown as UsersRepo;
  // th-1 은 이미 봇 대화인 스레드다.
  const conversations = {
    getByChannelId: async (id: string) => (id === "th-1" ? { primaryUserId: "u1" } : null),
    getByOriginMessageId: async () => null,
  } as unknown as ConversationsRepo;
  const adapter = new DiscordAdapter({ bus, config: makeConfig(), users, conversations });
  const view = adapter as unknown as Testable;
  const sent: unknown[] = [];
  view.client = {
    user: { id: "bot" },
    channels: {
      fetch: async () => ({
        isSendable: () => true,
        send: async (payload: unknown) => { sent.push(payload); return { edit: async () => ({}), delete: async () => {} }; },
      }),
    },
  };
  return { view, events, sent };
}

describe("중지 버튼", () => {
  it("상태 메시지에 중지 버튼이 붙는다", async () => {
    const { view, sent } = makeAdapter("allowed");
    await view.handleProgress("c1", "sh_exec npm test", "tool");
    const payload = sent[0] as { components?: Array<{ toJSON(): { components: Array<{ custom_id?: string; label?: string }> } }> };
    const button = payload.components?.[0]?.toJSON().components[0];
    expect(button?.custom_id).toBe(CANCEL_BUTTON_ID);
    expect(button?.label).toBe("중지");
  });

  it("등록된 사람이 누르면 조용히 받고(deferUpdate) cancel_request 를 낸다", async () => {
    const { view, events } = makeAdapter("allowed");
    let deferred = 0;
    await view.onInteraction({ isButton: () => true, customId: CANCEL_BUTTON_ID, user: { id: "u1" }, channelId: "th-1", deferUpdate: async () => { deferred++; } });
    expect(deferred).toBe(1);
    expect(events).toEqual([expect.objectContaining({ type: "cancel_request", channelRef: "th-1", userId: "u1" })]);
  });

  it("미등록자가 누르면 받기만 하고(디스코드의 '상호작용 실패' 표시를 막는다) 아무것도 하지 않는다", async () => {
    const { view, events } = makeAdapter("blocked");
    let deferred = 0;
    await view.onInteraction({ isButton: () => true, customId: CANCEL_BUTTON_ID, user: { id: "x" }, channelId: "th-1", deferUpdate: async () => { deferred++; } });
    expect(deferred).toBe(1);
    expect(events).toHaveLength(0);
  });

  it("다른 버튼·다른 상호작용은 건드리지 않는다", async () => {
    const { view, events } = makeAdapter("allowed");
    let deferred = 0;
    await view.onInteraction({ isButton: () => true, customId: "something-else", user: { id: "u1" }, channelId: "th-1", deferUpdate: async () => { deferred++; } });
    await view.onInteraction({ isButton: () => false, user: { id: "u1" }, channelId: "th-1" });
    expect(deferred).toBe(0);
    expect(events).toHaveLength(0);
  });
});

describe("/취소 메시지", () => {
  function message(over: Record<string, unknown> = {}) {
    let reacted = 0;
    const replies: string[] = [];
    const m = {
      author: { bot: false, id: "u1", username: "u1" },
      channelId: "th-1", id: "m9", content: "/취소", guildId: "g1",
      channel: { isThread: () => true, type: 11, parentId: "p" },
      attachments: new Map(),
      mentions: { has: () => false },
      react: async () => { reacted++; },
      reply: async (t: string) => { replies.push(t); },
      ...over,
    };
    return { m, reacted: () => reacted, replies };
  }

  it("대화 중인 스레드의 /취소 는 코어로 보내되, 턴을 시작하지 않으니 반응도 순번도 없다", async () => {
    const { view, events } = makeAdapter("allowed");
    const msg = message();
    await view.onMessage(msg.m);
    expect(events.filter((e) => e.type === "user_message").map((e) => ("text" in e ? e.text : ""))).toEqual(["/취소"]);
    expect(msg.reacted()).toBe(0);
    expect(view.progressState.get("th-1")?.pendingTriggers ?? []).toHaveLength(0);
  });

  it("일반 채널에서 멘션과 함께 친 /취소 는 스레드를 만들지 않고 안내만 한다", async () => {
    const { view, events } = makeAdapter("allowed");
    const msg = message({ channelId: "general", content: "<@bot> /취소", channel: { isThread: () => false, type: 0 }, mentions: { has: () => true } });
    await view.onMessage(msg.m);
    expect(events).toHaveLength(0);
    expect(msg.replies).toHaveLength(1);
    expect(msg.replies[0]).toMatch(/스레드 안에서/);
  });
});
