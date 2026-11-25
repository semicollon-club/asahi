import { describe, it, expect } from "vitest";
import { DiscordAdapter, DONE_REACTION } from "../src/adapters/discord.js";
import { EventBus, type AgentEvent } from "../src/events/bus.js";
import type { Config } from "../src/config.js";
import type { UsersRepo } from "../src/store/usersRepo.js";
import type { ConversationsRepo } from "../src/store/conversationsRepo.js";

// 빠른 개선 2차 §3.5·§3.6(2026-11-25) — 어댑터 쪽: 아직 끝나지 않은 턴의 메시지를 고치면 user_message_edit 를 내고, 묶인 메시지의
// 순번은 turn_merged 로 닫는다(상태 메시지는 건드리지 않는다).

function makeConfig(): Config {
  return {
    discordToken: "t", ownerId: "owner", databaseUrl: "postgres://test", dataDir: ":memory:", memoryDir: "x",
    sessionIdleMinutes: 30, maxTurnsPerHour: 30, maxTurnsPerHourPerUser: 20, maxTurnsPerHourGlobal: 40, ownerReserve: 10,
    deployTarget: "local", model: "m", httpPort: 3000, digestChannels: {}, github: null,
  };
}

type Trigger = { id: string; reactions: { cache: Map<string, unknown> }; react: (e: string) => Promise<void> };
type Testable = {
  client: unknown;
  statusChains: Map<string, Promise<void>>;
  progressState: Map<string, { statusMessage: unknown; pendingTriggers: Trigger[] }>;
  subscribeBus(): void;
  onMessageEdit(oldMessage: unknown, newMessage: unknown): Promise<void>;
};

function makeAdapter() {
  const bus = new EventBus();
  const events: AgentEvent[] = [];
  bus.subscribe("user_message_edit", (e) => { events.push(e); });
  const adapter = new DiscordAdapter({ bus, config: makeConfig(), users: {} as unknown as UsersRepo, conversations: {} as unknown as ConversationsRepo });
  const view = adapter as unknown as Testable;
  view.client = { user: { id: "bot" } };
  view.subscribeBus();
  return { view, bus, events };
}

function trigger(id: string) {
  const reacted: string[] = [];
  const t: Trigger = { id, reactions: { cache: new Map() }, react: async (e: string) => { reacted.push(e); } };
  return { t, reacted };
}

const edited = (over: Record<string, unknown> = {}) => ({ id: "m1", content: "<@bot> 고친 내용", author: { id: "u1", bot: false }, ...over });

describe("메시지 수정 — 어댑터", () => {
  it("아직 끝나지 않은 턴의 메시지를 고치면 그 대화 채널로 user_message_edit 를 낸다(봇 멘션을 뺀 본문)", async () => {
    const { view, events } = makeAdapter();
    view.progressState.set("th-1", { statusMessage: null, pendingTriggers: [trigger("m1").t] });
    await view.onMessageEdit({ content: "<@bot> 옛 내용" }, edited());
    expect(events).toEqual([expect.objectContaining({ type: "user_message_edit", channelRef: "th-1", discordMessageId: "m1", userId: "u1", text: "고친 내용" })]);
  });

  it("내용이 그대로인 갱신(링크 미리보기)·순번에 없는 메시지·봇의 메시지·예약어로 바꾼 것은 무시한다", async () => {
    const { view, events } = makeAdapter();
    view.progressState.set("th-1", { statusMessage: null, pendingTriggers: [trigger("m1").t] });
    await view.onMessageEdit({ content: "<@bot> 고친 내용" }, edited());
    await view.onMessageEdit({ content: "옛" }, edited({ id: "other" }));
    await view.onMessageEdit({ content: "옛" }, edited({ author: { id: "bot", bot: true } }));
    await view.onMessageEdit({ content: "옛" }, edited({ content: "/상태" }));
    await view.onMessageEdit({ partial: true, content: null }, edited());
    // 봇 멘션만 넣거나 뺀 수정 — 코어가 받는 본문은 같다(2026-11-25 리뷰: 도는 턴에 엉뚱한 "반영 안 됨" 안내가 나갔다).
    await view.onMessageEdit({ content: "고친 내용" }, edited({ content: "<@bot> 고친 내용" }));
    expect(events).toEqual([]);
  });
});

describe("turn_merged — 묶인 메시지의 순번", () => {
  it("상태 메시지를 건드리지 않고 순번 하나만 ✅ 로 바꾼다", async () => {
    const { view, bus } = makeAdapter();
    const a = trigger("a");
    const b = trigger("b");
    const status = { edited: 0 };
    view.progressState.set("c1", { statusMessage: status, pendingTriggers: [a.t, b.t] });
    bus.publish({ type: "turn_merged", channel: "discord", channelRef: "c1", ts: 1 });
    await view.statusChains.get("c1");
    expect(a.reacted).toEqual([DONE_REACTION]);
    expect(b.reacted).toEqual([]);
    expect(view.progressState.get("c1")?.pendingTriggers).toEqual([b.t]);
    expect(view.progressState.get("c1")?.statusMessage).toBe(status);
  });
});
