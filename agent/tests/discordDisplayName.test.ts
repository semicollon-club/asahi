import { describe, it, expect } from "vitest";
import { DiscordAdapter } from "../src/adapters/discord.js";
import { EventBus } from "../src/events/bus.js";
import type { Config } from "../src/config.js";
import type { UsersRepo } from "../src/store/usersRepo.js";
import type { ConversationsRepo } from "../src/store/conversationsRepo.js";

// 이 리포는 어댑터 테스트마다 Config 를 각자 만든다(discordChannelAccess.test.ts·
// discordSend.test.ts 모두 자기 makeConfig 를 갖는다). 그 관례를 그대로 따른다.
function makeConfig(): Config {
  return {
    discordToken: "test-token",
    ownerId: "owner",
    databaseUrl: "postgres://test",
    dataDir: ":memory:",
    memoryDir: "x",
    sessionIdleMinutes: 30,
    maxTurnsPerHour: 30,
    maxTurnsPerHourPerUser: 20,
    maxTurnsPerHourGlobal: 40,
    ownerReserve: 10,
    deployTarget: "local",
    model: "test-model",
    httpPort: 3000,
    digestChannels: {},
    // 깃허브 발행 미설정 — 이 테스트들의 관심사가 아니다. 설정이 없으면 발행 도구가 안 열린다.
    github: null,
  };
}

type TestableAdapter = { client: unknown; onMessage(message: unknown): Promise<void> };

function makeAdapter(role: "owner" | "allowed" | "blocked") {
  const upserts: Array<{ id: string; patch: { displayName?: string } }> = [];
  // roleChecks 가 있는 이유: "upsert 가 안 불렸다" 만 단정하면 onMessage 가 그 지점보다
  // 앞에서 어떤 이유로든 던졌을 때도 테스트가 통과한다(공허한 통과). 하네스가 판정
  // 지점까지 실제로 도달했다는 증거를 함께 단정한다.
  const roleChecks: string[] = [];
  const users = {
    getRole: async (id: string) => { roleChecks.push(id); return role; },
    upsert: async (id: string, patch: { displayName?: string }) => { upserts.push({ id, patch }); },
  } as unknown as UsersRepo;
  const conversations = { getByChannelId: async () => null } as unknown as ConversationsRepo;
  const adapter = new DiscordAdapter({ bus: new EventBus(), config: makeConfig(), users, conversations });
  const view = adapter as unknown as TestableAdapter;
  // onMessage 는 맨 앞에서 this.client.user 를 확인하고 없으면 그냥 돌아간다.
  view.client = { user: { id: "bot" }, channels: { fetch: async () => null } };
  return { view, upserts, roleChecks };
}

// onMessage(discord.ts)가 message 에서 실제로 읽는 필드만 채운 최소 가짜다. DM 으로 만드는
// 이유는 decideRoute 가 멘션 여부와 무관하게 곧장 통과시키는 가장 단순한 경로이기 때문이다.
function makeMessage(over: { id?: string; displayName?: string; username?: string } = {}) {
  return {
    author: { bot: false, id: over.id ?? "111", displayName: over.displayName, username: over.username ?? "wwoosshh" },
    channelId: "c1",
    id: "m1",
    content: "안녕",
    guildId: null,
    channel: { isThread: () => false, type: 1 }, // ChannelType.DM === 1
    attachments: new Map(),
    mentions: { has: () => false },
  };
}

// 이름 갱신 이후 onMessage 는 계속 진행해(resolveHint·beginTurn 등) 가짜 client 에서 던질 수
// 있다. 이 테스트가 보는 것은 "그 지점까지 왔는가"뿐이므로 이후 실패는 삼킨다 — 실제 디스코드
// 왕복을 세우는 것은 이 태스크의 범위가 아니다.
const feed = async (view: TestableAdapter, message: unknown) => {
  await Promise.resolve(view.onMessage(message)).catch(() => {});
};

describe("어댑터의 표시 이름 저장", () => {
  it("허용된 사용자의 메시지를 받으면 표시 이름을 저장한다", async () => {
    const { view, upserts } = makeAdapter("allowed");
    await feed(view, makeMessage({ id: "111", displayName: "우성현" }));

    expect(upserts).toHaveLength(1);
    expect(upserts[0].id).toBe("111");
    expect(upserts[0].patch.displayName).toBe("우성현");
  });

  it("전역 표시 이름이 없으면 username 으로 떨어진다", async () => {
    const { view, upserts } = makeAdapter("allowed");
    await feed(view, makeMessage({ id: "111", displayName: undefined, username: "wwoosshh" }));

    expect(upserts[0].patch.displayName).toBe("wwoosshh");
  });

  it("무시되는 사용자의 메시지로는 users 행을 만들지 않는다", async () => {
    // upsert 를 무시 판정보다 앞에 두면, 봇에게 말을 건 아무나 users 에 blocked 행으로 쌓인다.
    // 그 자리가 아니라는 것을 이 테스트가 고정한다.
    const { view, upserts, roleChecks } = makeAdapter("blocked");
    await feed(view, makeMessage({ id: "999", displayName: "낯선사람" }));

    // 하네스가 판정 지점까지 도달했다는 증거 — 이게 없으면 onMessage 가 더 앞에서
    // 던졌을 때도 아래 단정이 통과해 버린다.
    expect(roleChecks).toEqual(["999"]);
    expect(upserts).toHaveLength(0);
  });
});
