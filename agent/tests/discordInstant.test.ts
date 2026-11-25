import { describe, it, expect } from "vitest";
import { DiscordAdapter } from "../src/adapters/discord.js";
import { EventBus, type AgentEvent, type UserMessageEvent } from "../src/events/bus.js";
import type { Config } from "../src/config.js";
import type { UsersRepo } from "../src/store/usersRepo.js";
import type { ConversationsRepo } from "../src/store/conversationsRepo.js";

// 빠른 개선 2차 §1(2026-11-25) — 어댑터 쪽: 운영자 예약어(/상태·/차단·/허용)는 즉시 명령이라 반응도 순번도 없고, 일반 채널에서
// 멘션과 함께 쳐도 스레드를 만들지 않는다.

function makeConfig(): Config {
  return {
    discordToken: "t", ownerId: "owner", databaseUrl: "postgres://test", dataDir: ":memory:", memoryDir: "x",
    sessionIdleMinutes: 30, maxTurnsPerHour: 30, maxTurnsPerHourPerUser: 20, maxTurnsPerHourGlobal: 40, ownerReserve: 10,
    deployTarget: "local", model: "m", httpPort: 3000, digestChannels: {}, github: null,
  };
}

type Testable = { client: unknown; onMessage(m: unknown): Promise<void>; progressState: Map<string, { pendingTriggers: unknown[] }> };

function makeAdapter() {
  const bus = new EventBus();
  const events: AgentEvent[] = [];
  bus.subscribe("user_message", (e) => { events.push(e); });
  const users = { getRole: async () => "owner", upsert: async () => {} } as unknown as UsersRepo;
  const conversations = {
    getByChannelId: async (id: string) => (id === "th-1" ? { primaryUserId: "owner" } : null),
    getByOriginMessageId: async () => null,
  } as unknown as ConversationsRepo;
  const adapter = new DiscordAdapter({ bus, config: makeConfig(), users, conversations });
  const view = adapter as unknown as Testable;
  let threadsStarted = 0;
  view.client = {
    user: { id: "bot" },
    channels: {
      fetch: async () => ({
        isDMBased: () => false,
        messages: { fetch: async () => ({ startThread: async () => { threadsStarted++; return { id: "new-thread" }; } }) },
      }),
    },
  };
  return { view, events, threadsStarted: () => threadsStarted };
}

function message(over: Record<string, unknown>) {
  let reacted = 0;
  let typed = 0;
  const m = {
    author: { bot: false, id: "owner", username: "owner", displayName: "운영자" },
    channelId: "th-1", id: "m1", content: "/상태", guildId: "g1",
    channel: { isThread: () => true, type: 11, parentId: "p", sendTyping: async () => { typed++; } },
    attachments: new Map(),
    mentions: { has: () => false },
    react: async () => { reacted++; },
    reply: async () => {},
    ...over,
  };
  return { m, reacted: () => reacted, typed: () => typed };
}

const userMessages = (events: AgentEvent[]) => events.filter((e): e is UserMessageEvent => e.type === "user_message");

describe("즉시 명령 — 어댑터", () => {
  it("대화 스레드의 /상태 는 코어로 보내되 반응·타이핑·순번이 없다", async () => {
    const { view, events } = makeAdapter();
    const msg = message({});
    await view.onMessage(msg.m);
    expect(userMessages(events).map((e) => e.text)).toEqual(["/상태"]);
    expect(msg.reacted()).toBe(0);
    expect(msg.typed()).toBe(0);
    expect(view.progressState.get("th-1")?.pendingTriggers ?? []).toHaveLength(0);
  });

  it("일반 채널에서 멘션과 함께 친 /차단 은 스레드를 만들지 않고 그 채널의 채널 명령으로 간다", async () => {
    const { view, events, threadsStarted } = makeAdapter();
    const msg = message({
      channelId: "general", content: "<@bot> /차단 <@123456>",
      channel: { isThread: () => false, type: 0, sendTyping: async () => {} }, mentions: { has: () => true },
    });
    await view.onMessage(msg.m);
    expect(threadsStarted()).toBe(0);
    const [e] = userMessages(events);
    expect(e.text).toBe("/차단 <@123456>");
    expect(e.hint).toMatchObject({ discordChannelId: "general", commandOnly: true });
    expect(msg.reacted()).toBe(0);
  });

  it("멘션 없이 일반 채널에서 친 /허용 도 채널 명령이다", async () => {
    const { view, events } = makeAdapter();
    const msg = message({ channelId: "general", content: "/허용 123456", channel: { isThread: () => false, type: 0, sendTyping: async () => {} } });
    await view.onMessage(msg.m);
    expect(userMessages(events)[0].hint).toMatchObject({ discordChannelId: "general", commandOnly: true });
    expect(msg.reacted()).toBe(0);
  });
});
