import { describe, it, expect } from "vitest";
import { decideRoute, DiscordAdapter, type Incoming } from "../src/adapters/discord.js";
import { loadConfig, type Config } from "../src/config.js";
import { EventBus, type AgentEvent } from "../src/events/bus.js";
import type { UsersRepo } from "../src/store/usersRepo.js";
import type { ConversationsRepo } from "../src/store/conversationsRepo.js";

function makeConfig(): Config {
  return {
    discordToken: "t", ownerId: "owner", databaseUrl: "postgres://test", dataDir: ":memory:", memoryDir: "x",
    sessionIdleMinutes: 30, maxTurnsPerHour: 30, maxTurnsPerHourPerUser: 20, maxTurnsPerHourGlobal: 40, ownerReserve: 10,
    deployTarget: "local", model: "m", httpPort: 3000, digestChannels: {}, github: null,
  };
}

// 빠른 개선 2차 §3.4(2026-11-25) — 봇 전용 채널(BOT_CHANNEL_IDS)에서는 멘션 없이 말해도 부른 것으로 본다.

function inc(over: Partial<Incoming> = {}): Incoming {
  return {
    userId: "u1", channelId: "c1", isDM: false, isThread: false, mentionsBot: false,
    guildId: "g1", parentChannelId: undefined, content: "안녕", messageId: "m1", images: [], files: [], rejectedFiles: [], ...over,
  };
}

describe("decideRoute — 봇 전용 채널", () => {
  it("멘션 없는 말도 스레드를 연다", () => {
    expect(decideRoute(inc({ inBotChannel: true }), "allowed", false)).toEqual({ kind: "thread-create" });
  });

  it("예약어는 지금처럼 채널 명령이다(스레드를 만들지 않는다)", () => {
    expect(decideRoute(inc({ inBotChannel: true, content: "/help" }), "allowed", false)).toEqual({ kind: "channel-command" });
  });

  it("미등록자는 전용 채널에서도 무시한다", () => {
    expect(decideRoute(inc({ inBotChannel: true }), "blocked", false)).toEqual({ kind: "ignore" });
  });

  it("전용 채널이 아니면 예전처럼 멘션이 있어야 한다", () => {
    expect(decideRoute(inc(), "allowed", false)).toEqual({ kind: "ignore" });
    expect(decideRoute(inc({ inBotChannel: false }), "allowed", false)).toEqual({ kind: "ignore" });
  });
});

// 어댑터 쪽(2026-11-25 리뷰): 전용 채널에서도 시스템 메시지(고정 알림·스레드 시작 알림·부스트)와 본문 없는 메시지(전달·스티커)는
// 부른 것으로 보지 않는다. 예전엔 고정 알림 하나가 스레드 생성 실패 → 채널 자체를 대화로 채택하는 폴백으로 이어져, 그 채널 전체가
// 영구히 한 대화가 될 수 있었다.
describe("어댑터 — 전용 채널의 시스템 메시지·빈 메시지", () => {
  function makeAdapter() {
    const bus = new EventBus();
    const events: AgentEvent[] = [];
    bus.subscribe("user_message", (e) => { events.push(e); });
    const users = { getRole: async () => "allowed", upsert: async () => {} } as unknown as UsersRepo;
    const conversations = { getByChannelId: async () => null, getByOriginMessageId: async () => null } as unknown as ConversationsRepo;
    const config = { ...makeConfig(), botChannelIds: ["bc"] };
    const adapter = new DiscordAdapter({ bus, config, users, conversations });
    const view = adapter as unknown as { client: unknown; onMessage(m: unknown): Promise<void> };
    let threads = 0;
    view.client = {
      user: { id: "bot" },
      channels: {
        fetch: async () => ({
          isDMBased: () => false,
          messages: { fetch: async () => ({ startThread: async () => { threads++; return { id: `t${threads}` }; } }) },
        }),
      },
    };
    return { view, events, threads: () => threads };
  }
  const msg = (over: Record<string, unknown>) => ({
    author: { bot: false, id: "u1", username: "u1", displayName: "부원" }, channelId: "bc", id: "m1", content: "안녕", guildId: "g1",
    system: false, channel: { isThread: () => false, type: 0, sendTyping: async () => {} }, attachments: new Map(),
    mentions: { has: () => false }, react: async () => {}, reply: async () => {}, ...over,
  });

  it("평범한 말은 스레드를 열고 코어로 보낸다", async () => {
    const { view, events, threads } = makeAdapter();
    await view.onMessage(msg({}));
    expect(threads()).toBe(1);
    expect(events).toHaveLength(1);
  });

  it("시스템 메시지(고정 알림 등)와 본문 없는 메시지(전달·스티커)는 무시한다", async () => {
    const { view, events, threads } = makeAdapter();
    await view.onMessage(msg({ system: true, type: 6, content: "" }));
    await view.onMessage(msg({ system: true, type: 18, content: "새 스레드 이름" }));
    await view.onMessage(msg({ content: "" }));
    expect(threads()).toBe(0);
    expect(events).toHaveLength(0);
  });
});

describe("loadConfig — BOT_CHANNEL_IDS", () => {
  const base = { DISCORD_TOKEN: "t", DISCORD_OWNER_ID: "1", DATABASE_URL: "postgres://x" } as NodeJS.ProcessEnv;
  it("쉼표로 나눈 채널 id 목록이고, 없으면 빈 목록(꺼짐)이다", () => {
    expect(loadConfig({ ...base, BOT_CHANNEL_IDS: " 111, 222 ,," }).botChannelIds).toEqual(["111", "222"]);
    expect(loadConfig(base).botChannelIds).toEqual([]);
  });
});
