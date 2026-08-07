import { describe, it, expect, vi } from "vitest";
import { DiscordAdapter, SEND_EMPTY_FALLBACK, planSend } from "../src/adapters/discord.js";
import { EventBus } from "../src/events/bus.js";
import type { Config } from "../src/config.js";
import type { UsersRepo } from "../src/store/usersRepo.js";
import type { ConversationsRepo } from "../src/store/conversationsRepo.js";

// DiscordAdapter 의 private 메서드(send/enqueueSendAfter)를 직접 호출해 검증한다. TS 의 private 는
// 컴파일 타임 표시일 뿐이라 런타임엔 그대로 호출 가능하다 — discordChannelAccess.test.ts·
// discordDisplayName.test.ts 와 같은 TestableAdapter 캐스팅 패턴을 그대로 따른다.
//
// 아래 두 describe 는 원래 expressionSend.test.ts(표정 이미지 기능 제거로 삭제됨)에 있던 테스트를
// 현재 시그니처(emotion/imageUrl 없는 send/enqueueSendAfter)에 맞춰 옮겨온 것이다. 표정 관련
// 인자는 다 빠졌지만 검증 대상 자체 — 빈 응답 폴백, 채널별 전송 순서 보장 — 는 표정과 무관하게
// 지금도 살아있는 동작이라 리뷰에서 복원을 요구했다.

type SentPayload = string;

type TestableAdapter = {
  client: unknown;
  sendChains: Map<string, Promise<void>>;
  send(channelRef: string, text: string): Promise<void>;
  enqueueSendAfter(channelRef: string, wait: Promise<void>, text: string): void;
};

function makeFakeChannel(sent: SentPayload[]) {
  return {
    isSendable: () => true,
    send: async (payload: SentPayload) => {
      sent.push(payload);
      return {};
    },
  };
}

// 이 리포는 어댑터 테스트마다 Config 를 각자 만든다(discordChannelAccess.test.ts·
// discordDisplayName.test.ts 관례). 그대로 따른다.
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

// 실제 디스코드 연결 없이 DiscordAdapter 를 만든다. client 는 channels.fetch 만 흉내내는 가짜로
// 갈아끼운다 — send() 는 isSendable()/send() 만 있으면 동작한다.
function makeAdapter() {
  const bus = new EventBus();
  const adapter = new DiscordAdapter({
    bus,
    config: makeConfig(),
    users: {} as unknown as UsersRepo,
    conversations: {} as unknown as ConversationsRepo,
  });
  const sent: SentPayload[] = [];
  const view = adapter as unknown as TestableAdapter;
  view.client = { channels: { fetch: async () => makeFakeChannel(sent) } };
  return { view, sent };
}

describe("send — 텍스트가 없으면 폴백 텍스트를 보낸다", () => {
  it("빈 문자열로 호출되면 SEND_EMPTY_FALLBACK 을 채널에 보내고, 채널을 특정하는 에러 로그를 남긴다", async () => {
    const { view, sent } = makeAdapter();
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const channelRef = "chan-empty";

    await view.send(channelRef, "");

    expect(sent).toEqual([SEND_EMPTY_FALLBACK]);
    const loggedChannel = errorSpy.mock.calls.some((args) =>
      args.some((a) => typeof a === "string" && a.includes(channelRef)),
    );
    expect(loggedChannel).toBe(true); // 채널을 특정할 수 있는 로그가 남아야 한다

    errorSpy.mockRestore();
  });
});

// Minor 7(최종 전체 브랜치 리뷰) — send() 의 다중 청크 루프를 실제로 도는 테스트가 하나도
// 없었다. 삭제된 expressionSend.test.ts 가 유일한 커버리지였고, sendPlan.test.ts 는 planSend
// 순수 함수만, 이 파일의 나머지는 빈 텍스트만 본다. 즉 "계획은 여러 조각인데 채널에는 한 번만
// 보낸다"거나 "역순으로 나간다" 같은 회귀가 아무 테스트도 건드리지 않고 지나갈 수 있었다.
describe("send — 긴 본문은 계획된 모든 청크가 순서대로 나간다", () => {
  it("2000자 상한을 넘는 본문이 여러 번에 나뉘어 순서대로 전송되고, 이어 붙이면 원문이 된다", async () => {
    const { view, sent } = makeAdapter();
    // 줄바꿈이 없는 본문을 쓴다 — chunkMessage 는 줄바꿈에서 자를 때 그 줄바꿈 한 글자를
    // 먹으므로(경계 문자 소비), 강제 절단 경로여야 "이어 붙이면 원문"이 정확히 성립한다.
    const text = Array.from({ length: 5000 }, (_, i) => String.fromCharCode(0xac00 + (i % 100))).join("");

    await view.send("chan-long", text);

    expect(sent.length).toBeGreaterThan(1);            // 한 번에 다 보내지 않았다
    expect(sent).toEqual(planSend(text).chunks);       // 계획 그대로, 순서까지 같다
    expect(sent.join("")).toBe(text);                  // 빠지거나 뒤바뀐 조각이 없다
    for (const chunk of sent) expect(chunk.length).toBeLessThanOrEqual(2000);
  });

  it("줄바꿈이 있는 긴 본문도 계획된 청크가 하나도 빠지지 않고 순서대로 나간다", async () => {
    const { view, sent } = makeAdapter();
    const text = Array.from({ length: 400 }, (_, i) => `${i}번째 줄입니다. ${"가".repeat(20)}`).join("\n");

    await view.send("chan-lines", text);

    const chunks = planSend(text).chunks;
    expect(chunks.length).toBeGreaterThan(1);
    expect(sent).toEqual(chunks);
    // 줄바꿈에서 자른 경우 그 한 글자는 청크에 남지 않는다 — 개행으로 이으면 원문이 된다.
    expect(sent.join("\n")).toBe(text);
  });
});

describe("enqueueSendAfter — 발행 순서가 곧 전송 순서", () => {
  it("먼저 등록된 호출의 wait 이 나중에 풀려도, 전송은 등록 순서대로 나간다", async () => {
    const { view, sent } = makeAdapter();
    const channelRef = "chan-order";

    let releaseFirst!: () => void;
    const firstWait = new Promise<void>((res) => { releaseFirst = res; });
    const secondWait = Promise.resolve(); // 두 번째 호출의 wait 은 즉시 풀린다

    // 두 호출을 동기적으로 연달아 등록한다 — bus.publish 가 핸들러를 동기 호출하는 실제 상황과 같다.
    view.enqueueSendAfter(channelRef, firstWait, "첫 번째 턴");
    view.enqueueSendAfter(channelRef, secondWait, "두 번째 턴");

    const tail = view.sendChains.get(channelRef)!; // 두 번째 등록 이후의 체인 꼬리 = 둘 다 끝나야 풀린다
    releaseFirst();
    await tail;

    // 두 번째 호출의 wait 이 먼저 풀렸어도 새치기하지 않는다 — enqueueSendAfter 가 이전 체인(prev)을
    // Promise.all 에서 빼먹으면 이 순서가 깨진다(체인 연결이 곧 순서 보장의 전부다).
    expect(sent).toEqual(["첫 번째 턴", "두 번째 턴"]);
  });
});
