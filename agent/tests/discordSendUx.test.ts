import { describe, it, expect, vi, afterEach } from "vitest";
import {
  DiscordAdapter, planSend, decideCompletionPing, DEFAULT_ALLOWED_MENTIONS, LONG_TURN_PING_MS, LONG_ANSWER_FILE_NAME,
} from "../src/adapters/discord.js";
import { EventBus } from "../src/events/bus.js";
import type { Config } from "../src/config.js";
import type { UsersRepo } from "../src/store/usersRepo.js";
import type { ConversationsRepo } from "../src/store/conversationsRepo.js";

// 빠른 개선 2차(2026-11-25 설계 §2·§3.1·§3.2) — 어댑터의 전송: 클라이언트 기본 멘션(사람만), 긴 작업이 끝나면 시킨
// 사람을 부르기, 긴 답은 파일로.

function makeConfig(): Config {
  return {
    discordToken: "t", ownerId: "owner", databaseUrl: "postgres://test", dataDir: ":memory:", memoryDir: "x",
    sessionIdleMinutes: 30, maxTurnsPerHour: 30, maxTurnsPerHourPerUser: 20, maxTurnsPerHourGlobal: 40, ownerReserve: 10,
    deployTarget: "local", model: "m", httpPort: 3000, digestChannels: {}, github: null,
  };
}

type Payload = string | { content?: string; files?: Array<{ attachment: Buffer; name: string }>; allowedMentions?: { users?: string[] } };
type Testable = {
  client: unknown;
  sendChains: Map<string, Promise<void>>;
  statusChains: Map<string, Promise<void>>;
  subscribeBus(): void;
  beginTurn(channelRef: string, message: unknown): void;
};

function makeAdapter(opts: { rejectFiles?: boolean } = {}) {
  const bus = new EventBus();
  const adapter = new DiscordAdapter({ bus, config: makeConfig(), users: {} as unknown as UsersRepo, conversations: {} as unknown as ConversationsRepo });
  const view = adapter as unknown as Testable;
  const clientOptions = (view.client as { options: { allowedMentions?: unknown } }).options;
  const sent: Payload[] = [];
  view.client = {
    channels: {
      fetch: async () => ({
        isSendable: () => true,
        send: async (p: Payload) => {
          if (opts.rejectFiles && typeof p !== "string" && p.files) throw new Error("Missing Permissions");
          sent.push(p);
          return {};
        },
      }),
    },
  };
  view.subscribeBus();
  return { view, bus, sent, clientOptions };
}

function trigger(id: string, userId: string, channelType: number) {
  return { id, author: { id: userId }, channel: { type: channelType }, reactions: { cache: new Map() }, react: async () => {} };
}

// 보낸 것을 글자만 뽑는다(완료 알림 조각은 allowedMentions 를 단 객체로 나간다).
const textOf = (p: Payload) => (typeof p === "string" ? p : p.content ?? "");

const settled = async (view: Testable, ref: string) => {
  await view.statusChains.get(ref);
  await view.sendChains.get(ref);
};

afterEach(() => { vi.useRealTimers(); });

describe("멘션 — 클라이언트 기본값", () => {
  it("본문의 멘션은 아무도 울리지 않는다 — @everyone·@here·역할·사람 전부(2026-11-25 리뷰: 사람 멘션도 주입으로 도배될 수 있다)", () => {
    const { clientOptions } = makeAdapter();
    expect(DEFAULT_ALLOWED_MENTIONS).toEqual({ parse: [], repliedUser: true });
    expect(clientOptions.allowedMentions).toEqual(DEFAULT_ALLOWED_MENTIONS);
  });
});

describe("planSend — 멘션 접두·긴 답 파일", () => {
  it("짧은 답은 예전과 같다(파일 없음)", () => {
    expect(planSend("안녕")).toEqual({ chunks: ["안녕"] });
  });

  it("멘션을 붙이면 첫 조각 앞에만 붙고, 모든 조각이 2000자 안이다", () => {
    const plan = planSend("가".repeat(5000), { mentionUserId: "123456" });
    expect(plan.chunks[0].startsWith("<@123456> ")).toBe(true);
    for (const c of plan.chunks) expect(c.length).toBeLessThanOrEqual(2000);
    expect(plan.chunks.slice(1).some((c) => c.includes("<@123456>"))).toBe(false);
  });

  it("네 조각을 넘으면 미리보기 한 개와 전문 파일로 보낸다", () => {
    const text = "한 줄입니다\n".repeat(1500);
    const plan = planSend(text, { mentionUserId: "123456" });
    expect(plan.chunks).toHaveLength(1);
    expect(plan.chunks[0].startsWith("<@123456> ")).toBe(true);
    expect(plan.chunks[0]).toMatch(/전문은 파일로/);
    expect(plan.chunks[0].length).toBeLessThanOrEqual(2000);
    expect(plan.file).toEqual({ name: LONG_ANSWER_FILE_NAME, content: text });
  });

  it("미리보기도 코드블록을 깨지 않는다", () => {
    const text = "설명\n```ts\n" + "const a = 1;\n".repeat(1200) + "```\n끝";
    const plan = planSend(text);
    expect(plan.file).toBeDefined();
    const fences = plan.chunks[0].split("\n").filter((l) => l.trimStart().startsWith("```")).length;
    expect(fences % 2).toBe(0);
  });
});

describe("decideCompletionPing — 긴 작업이 끝나면 시킨 사람을 부른다", () => {
  it("2분 이상이고 DM 이 아니면 부른다", () => {
    expect(decideCompletionPing({ startedAt: 0, now: LONG_TURN_PING_MS, isDM: false })).toBe(true);
    expect(decideCompletionPing({ startedAt: 0, now: LONG_TURN_PING_MS - 1, isDM: false })).toBe(false);
    expect(decideCompletionPing({ startedAt: 0, now: LONG_TURN_PING_MS * 5, isDM: true })).toBe(false);
    expect(decideCompletionPing({ startedAt: undefined, now: LONG_TURN_PING_MS * 5, isDM: false })).toBe(false);
  });

  it("오래 걸린 턴의 답은 시킨 사람 멘션으로 시작하고(그 사람만 울린다), 짧은 턴은 그대로다", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(1_000_000);
    const { view, bus, sent } = makeAdapter();
    view.beginTurn("th-1", trigger("m1", "u1", 11));
    view.beginTurn("th-2", trigger("m2", "u2", 11));
    vi.setSystemTime(1_000_000 + 10_000);
    bus.publish({ type: "assistant_message", channel: "discord", channelRef: "th-2", text: "금방 끝", ts: 1, triggerId: "m2" });
    await settled(view, "th-2");
    vi.setSystemTime(1_000_000 + LONG_TURN_PING_MS + 1);
    bus.publish({ type: "assistant_message", channel: "discord", channelRef: "th-1", text: "다 했어요", ts: 2, triggerId: "m1" });
    await settled(view, "th-1");
    expect(sent.map(textOf)).toEqual(["금방 끝", "<@u1> 다 했어요"]);
    expect(sent[1]).toMatchObject({ allowedMentions: { users: ["u1"] } });
  });

  it("실패 안내(system_notice)로 끝난 긴 턴도 부르고, DM 에서는 부르지 않는다", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(1_000_000);
    const { view, bus, sent } = makeAdapter();
    view.beginTurn("th-1", trigger("m1", "u1", 11));
    view.beginTurn("dm-1", trigger("m9", "owner", 1));
    vi.setSystemTime(1_000_000 + LONG_TURN_PING_MS * 2);
    bus.publish({ type: "system_notice", channel: "discord", channelRef: "th-1", text: "멈췄어요", ts: 1, triggerId: "m1" });
    bus.publish({ type: "assistant_message", channel: "discord", channelRef: "dm-1", text: "끝났어요", ts: 2, triggerId: "m9" });
    await settled(view, "th-1");
    await settled(view, "dm-1");
    expect(sent.map(textOf)).toContain("<@u1> ⚠️ 멈췄어요");
    expect(sent.map(textOf)).toContain("끝났어요");
  });

  it("종료 이벤트가 꺼낸 순번이 그 턴의 메시지라는 확신이 없으면 부르지 않는다(2026-11-25 리뷰 — /help 등이 순번을 먼저 꺼내는 경우)", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(1_000_000);
    const { view, bus, sent } = makeAdapter();
    view.beginTurn("th-1", trigger("mA", "uA", 11));
    view.beginTurn("th-1", trigger("mB", "uB", 11));
    vi.setSystemTime(1_000_000 + LONG_TURN_PING_MS * 3);
    // 대화 안 /help 의 답처럼 어느 메시지의 것인지 모르는 종료 이벤트, 그리고 다른 메시지를 가리키는 종료 이벤트.
    bus.publish({ type: "assistant_message", channel: "discord", channelRef: "th-1", text: "도움말", ts: 1 });
    bus.publish({ type: "assistant_message", channel: "discord", channelRef: "th-1", text: "A 의 답", ts: 2, triggerId: "mA" });
    await settled(view, "th-1");
    expect(sent.map(textOf)).toEqual(["도움말", "A 의 답"]);
  });

  it("긴 답은 파일을 붙여 한 번에 보낸다", async () => {
    const { view, bus, sent } = makeAdapter();
    const text = "줄\n".repeat(6000);
    bus.publish({ type: "assistant_message", channel: "discord", channelRef: "c1", text, ts: 1 });
    await settled(view, "c1");
    expect(sent).toHaveLength(1);
    const p = sent[0];
    expect(typeof p).toBe("object");
    if (typeof p === "string") return;
    expect(p.files?.[0].name).toBe(LONG_ANSWER_FILE_NAME);
    expect(Buffer.from(p.files![0].attachment).toString("utf8")).toBe(text);
  });

  it("첨부가 거부되면(파일 첨부 권한 없음 등) 답을 잃지 않고 일반 메시지로 나눠 보낸다(2026-11-25 리뷰)", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { view, bus, sent } = makeAdapter({ rejectFiles: true });
    const text = Array.from({ length: 1500 }, (_, i) => `${i}번째 줄`).join("\n");
    bus.publish({ type: "assistant_message", channel: "discord", channelRef: "c1", text, ts: 1 });
    await settled(view, "c1");
    expect(sent.length).toBeGreaterThan(4);
    expect(sent.every((p) => typeof p === "string")).toBe(true);
    expect(sent.map(textOf).join("\n")).toBe(text);
    errorSpy.mockRestore();
  });
});
