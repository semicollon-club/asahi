import { describe, it, expect } from "vitest";
import { DiscordAdapter } from "../src/adapters/discord.js";
import { EventBus } from "../src/events/bus.js";
import type { Config } from "../src/config.js";
import type { UsersRepo } from "../src/store/usersRepo.js";
import type { ConversationsRepo } from "../src/store/conversationsRepo.js";

// FIX2(중요, 머지 전 리뷰) — 정기 게시 채널(DIGEST_CONTEST_CHANNEL_ID 등)이 잘못된 ID 이거나
// 봇에게 채널을 볼 권한이 없으면, 지금까지는 "매 조사 성공 뒤 전송이 조용히 실패"로만 드러났다
// (discord.ts 의 send() 는 실패를 로그 한 줄로만 남긴다). 사용자는 리다이렉트 안내("...에
// 올리겠습니다")를 받고 기다리다가 그냥 아무것도 못 받는다. 부팅 시 한 번 그 채널에 실제로 접근할 수
// 있는지 확인해 이름과 ID 를 콕 집어 경고하도록 DiscordAdapter.canReachChannel 을 추가한다 —
// 실 디스코드 연결 없이 client 만 가짜로 갈아끼워 검증한다(expressionSend.test.ts 의 makeAdapter
// 와 같은 패턴).

type TestableAdapter = { client: unknown; canReachChannel(channelId: string): Promise<boolean> };

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
  };
}

function makeAdapter(fetchImpl: (channelId: string) => Promise<unknown>) {
  const bus = new EventBus();
  const adapter = new DiscordAdapter({
    bus,
    config: makeConfig(),
    users: {} as unknown as UsersRepo,
    conversations: {} as unknown as ConversationsRepo,
  });
  const view = adapter as unknown as TestableAdapter;
  view.client = { channels: { fetch: fetchImpl } };
  return view;
}

describe("DiscordAdapter.canReachChannel — FIX2: 정기 게시 채널 접근 가능 여부 확인", () => {
  it("채널을 정상적으로 가져오고 전송 가능하면 true", async () => {
    const view = makeAdapter(async () => ({ isSendable: () => true }));
    expect(await view.canReachChannel("C1")).toBe(true);
  });

  it("fetch 가 예외를 던지면(권한 없음·잘못된 ID 등) false", async () => {
    const view = makeAdapter(async () => { throw new Error("Missing Access"); });
    expect(await view.canReachChannel("bad-id")).toBe(false);
  });

  it("fetch 가 null 을 돌려주면(존재하지 않는 채널) false", async () => {
    const view = makeAdapter(async () => null);
    expect(await view.canReachChannel("missing")).toBe(false);
  });

  it("채널은 존재하지만 전송 불가(카테고리·음성 채널 등)면 false", async () => {
    const view = makeAdapter(async () => ({ isSendable: () => false }));
    expect(await view.canReachChannel("voice-channel")).toBe(false);
  });
});
