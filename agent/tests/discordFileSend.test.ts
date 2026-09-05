import { describe, it, expect, vi } from "vitest";
import { DiscordAdapter } from "../src/adapters/discord.js";
import { EventBus } from "../src/events/bus.js";
import type { Config } from "../src/config.js";
import type { UsersRepo } from "../src/store/usersRepo.js";
import type { ConversationsRepo } from "../src/store/conversationsRepo.js";

// 파일 반환(0단계 0.2)의 어댑터 쪽: assistant_file 이벤트를 받아 그 채널에 첨부로 보낸다. 계획의 완료
// 기준 — "어댑터는 진행 표시를 건드리지 않는다(턴 중 부수 전송)". 첨부는 턴 도중 도구 호출로 나가므로
// finishStatus(⏳→✅ 반응, 상태 메시지 삭제)를 타면 아직 진행 중인 턴이 끝난 것처럼 보인다.
//
// discordSend.test.ts 와 같은 TestableAdapter 캐스팅 관례를 따른다. 구독 배선은 start() 안에 있어 실제
// 로그인 없이는 못 부르므로, 구독만 떼어 낸 private subscribeBus() 를 직접 부른다.

type SentPayload = string | { files: Array<{ attachment: Buffer; name: string }> };

type TestableAdapter = {
  client: unknown;
  bus: EventBus;
  sendChains: Map<string, Promise<void>>;
  statusChains: Map<string, Promise<void>>;
  progressState: Map<string, { statusMessage: unknown; pendingTriggers: unknown[]; lines: string[] }>;
  subscribeBus(): void;
};

function makeConfig(): Config {
  return {
    discordToken: "test-token", ownerId: "owner", databaseUrl: "postgres://test", dataDir: ":memory:", memoryDir: "x",
    sessionIdleMinutes: 30, maxTurnsPerHour: 30, maxTurnsPerHourPerUser: 20, maxTurnsPerHourGlobal: 40, ownerReserve: 10,
    deployTarget: "local", model: "test-model", httpPort: 3000, digestChannels: {}, github: null,
  };
}

function makeAdapter(opts: { failFiles?: boolean } = {}) {
  const bus = new EventBus();
  const adapter = new DiscordAdapter({ bus, config: makeConfig(), users: {} as unknown as UsersRepo, conversations: {} as unknown as ConversationsRepo });
  const sent: SentPayload[] = [];
  const view = adapter as unknown as TestableAdapter;
  view.client = {
    channels: {
      fetch: async () => ({
        isSendable: () => true,
        send: async (payload: SentPayload) => {
          if (opts.failFiles && typeof payload !== "string") throw new Error("Request entity too large");
          sent.push(payload);
          return {};
        },
      }),
    },
  };
  view.subscribeBus();
  return { view, bus, sent };
}

const fileEvent = (channelRef: string, name: string, data: Buffer) =>
  ({ type: "assistant_file" as const, channel: "discord" as const, channelRef, name, data, ts: 1 });

const settled = async (view: TestableAdapter, channelRef: string) => {
  await view.sendChains.get(channelRef);
  await view.statusChains.get(channelRef);
};

describe("assistant_file — 첨부 전송", () => {
  it("이벤트의 바이트와 이름을 그 채널에 첨부로 보낸다", async () => {
    const { view, bus, sent } = makeAdapter();
    const data = Buffer.from([1, 2, 3]);
    bus.publish(fileEvent("c1", "결과.png", data));
    await settled(view, "c1");
    expect(sent).toHaveLength(1);
    const payload = sent[0];
    expect(typeof payload).not.toBe("string");
    if (typeof payload === "string") return;
    expect(payload.files).toHaveLength(1);
    expect(payload.files[0].name).toBe("결과.png");
    expect(Buffer.from(payload.files[0].attachment).equals(data)).toBe(true);
  });

  it("진행 표시를 건드리지 않는다 — 상태 체인·반응 큐·상태 메시지에 아무 일도 없다", async () => {
    const { view, bus } = makeAdapter();
    // 턴이 진행 중인 것처럼 반응 큐에 원본 메시지 하나를 넣어 둔다. finishStatus 가 돌면 이게 꺼진다.
    const trigger = { reactions: { cache: new Map() }, react: vi.fn() };
    view.progressState.set("c1", { statusMessage: null, pendingTriggers: [trigger], lines: ["fs_read 완료"] });
    bus.publish(fileEvent("c1", "a.png", Buffer.from([1])));
    await settled(view, "c1");
    expect(view.statusChains.has("c1")).toBe(false);
    expect(view.progressState.get("c1")?.pendingTriggers).toEqual([trigger]);
    expect(view.progressState.get("c1")?.lines).toEqual(["fs_read 완료"]);
    expect(trigger.react).not.toHaveBeenCalled();
  });

  it("같은 채널에서는 먼저 온 첨부가 뒤에 온 답변 본문보다 앞에 나간다", async () => {
    const { view, bus, sent } = makeAdapter();
    bus.publish(fileEvent("c1", "a.png", Buffer.from([1])));
    bus.publish({ type: "assistant_message", channel: "discord", channelRef: "c1", text: "그림 보냈어요.", ts: 2 });
    await settled(view, "c1");
    expect(sent).toHaveLength(2);
    expect(typeof sent[0]).not.toBe("string");
    expect(sent[1]).toBe("그림 보냈어요.");
  });

  it("디스코드가 첨부를 거부하면 예외를 삼키고 그 자리에 실패 안내를 보낸다", async () => {
    const { view, bus, sent } = makeAdapter({ failFiles: true });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    bus.publish(fileEvent("c1", "big.bin", Buffer.from([1])));
    await settled(view, "c1");
    expect(sent).toHaveLength(1);
    expect(typeof sent[0]).toBe("string");
    expect(sent[0]).toContain("big.bin");
    expect(sent[0]).toContain("보내지 못했");
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it("채널마다 체인이 따로라 다른 채널의 첨부가 서로를 기다리지 않는다", async () => {
    const { view, bus, sent } = makeAdapter();
    bus.publish(fileEvent("c1", "a.png", Buffer.from([1])));
    bus.publish(fileEvent("c2", "b.png", Buffer.from([2])));
    await settled(view, "c1");
    await settled(view, "c2");
    expect(sent).toHaveLength(2);
  });
});
