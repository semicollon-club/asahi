import { describe, it, expect } from "vitest";
import { DiscordAdapter, DM_DECLINED_NOTICE } from "../src/adapters/discord.js";
import { EventBus } from "../src/events/bus.js";
import type { Config } from "../src/config.js";
import type { UsersRepo } from "../src/store/usersRepo.js";
import type { ConversationsRepo } from "../src/store/conversationsRepo.js";

// 손님 DM 을 받지 않는다(2026-09-07 운영자 결정, 위험 등록부 §10). 이 파일이 지키는 것은 문구가 아니라
// **아무것도 생기지 않는다**는 사실이다 — 대화 행도, LLM 턴도, 세션 전사도. 안내문만 나가고 끝난다.
// decideRoute 의 순수 판정은 discordRouting.test.ts 가 따로 고정한다.

function makeConfig(): Config {
  return {
    discordToken: "test-token", ownerId: "owner", databaseUrl: "postgres://test",
    dataDir: ":memory:", memoryDir: "x",
    sessionIdleMinutes: 30, maxTurnsPerHour: 30, maxTurnsPerHourPerUser: 20, maxTurnsPerHourGlobal: 40,
    ownerReserve: 10, deployTarget: "local", model: "test-model", httpPort: 3000,
    digestChannels: {}, github: null,
  };
}

type TestableAdapter = { client: unknown; onMessage(message: unknown): Promise<void> };

function makeAdapter(role: "owner" | "allowed") {
  const upserts: string[] = [];
  const published: string[] = [];
  const convLookups: string[] = [];
  const users = {
    getRole: async () => role,
    upsert: async (id: string) => { upserts.push(id); },
  } as unknown as UsersRepo;
  // 대화 행을 만들려는 시도가 있으면 여기서 드러난다 — 조회조차 없어야 하는 것은 아니지만
  // (라우팅 전에 한 번 본다), 그 뒤로 아무 것도 이어지지 않아야 한다.
  const conversations = {
    getByChannelId: async (id: string) => { convLookups.push(id); return null; },
  } as unknown as ConversationsRepo;
  const bus = new EventBus();
  bus.subscribe("user_message", (e) => { published.push(e.channelRef); });
  const adapter = new DiscordAdapter({ bus, config: makeConfig(), users, conversations });
  const view = adapter as unknown as TestableAdapter;
  view.client = { user: { id: "bot" }, channels: { fetch: async () => null } };
  return { view, upserts, published, convLookups };
}

// DM 메시지 하나. sent 에 보낸 문자열이, typing 에 타이핑 표시 호출이 쌓인다.
function makeDm(sent: string[], typing: number[] = []) {
  return {
    author: { bot: false, id: "111", displayName: "부원", username: "member" },
    channelId: "dm1", id: "m1", content: "이 API 키로 테스트해줘", guildId: null,
    channel: {
      isThread: () => false, type: 1, // ChannelType.DM === 1
      send: async (text: string) => { sent.push(text); },
      sendTyping: async () => { typing.push(1); },
    },
    react: async () => ({ users: { remove: async () => {} } }),
    attachments: new Map(),
    mentions: { has: () => false },
  };
}

describe("손님 DM 은 받지 않는다", () => {
  it("안내 한 줄만 보내고 턴을 만들지 않는다", async () => {
    const sent: string[] = [];
    const typing: number[] = [];
    const { view, upserts, published } = makeAdapter("allowed");
    await view.onMessage(makeDm(sent, typing));

    expect(sent).toEqual([DM_DECLINED_NOTICE]);
    // 버스에 안 올라간다 = 코어가 이 메시지를 모른다 = 대화 행도 세션도 전사도 없다.
    expect(published).toEqual([]);
    // 표시 이름 갱신·타이핑 표시보다 앞에서 끊긴다 — 여기 닿았다면 그 뒤 파이프라인도 함께 돈 것이다.
    expect(upserts).toEqual([]);
    expect(typing).toEqual([]);
  });

  it("어디로 가야 하는지 알려 준다 — 조용히 무시하면 봇이 고장 난 것으로 읽힌다", () => {
    expect(DM_DECLINED_NOTICE).toContain("서버");
  });

  it("소유자 DM 은 그대로 처리된다 — 관리와 개인 워커 경로가 거기서 돈다", async () => {
    const sent: string[] = [];
    const { view, published } = makeAdapter("owner");
    await view.onMessage(makeDm(sent)).catch(() => {}); // 이후 디스코드 왕복은 가짜라 던질 수 있다

    expect(sent).toEqual([]);
    expect(published).toEqual(["dm1"]);
  });
});
