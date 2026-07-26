import { describe, it, expect, vi } from "vitest";
import { EmbedBuilder } from "discord.js";
import {
  pickExpressionUrl, EXPRESSION_MIN_INTERVAL_MS, withinExpressionInterval, planSend,
  DiscordAdapter, EXPRESSION_EMPTY_FALLBACK,
} from "../src/adapters/discord.js";
import { EventBus } from "../src/events/bus.js";
import type { Config } from "../src/config.js";
import type { UsersRepo } from "../src/store/usersRepo.js";
import type { ConversationsRepo } from "../src/store/conversationsRepo.js";
import type { CharacterImagesRepo } from "../src/store/characterImagesRepo.js";

describe("pickExpressionUrl", () => {
  it("URL 이 없으면 undefined", () => {
    expect(pickExpressionUrl([], undefined, () => 0)).toBeUndefined();
  });

  it("한 장뿐이면 직전과 같아도 그걸 쓴다", () => {
    expect(pickExpressionUrl(["a"], "a", () => 0)).toBe("a");
  });

  it("여러 장이면 직전에 쓴 것을 피한다", () => {
    // rand 가 0 이면 후보 목록의 첫 번째를 고른다. "a" 가 제외되므로 "b" 가 나와야 한다.
    expect(pickExpressionUrl(["a", "b", "c"], "a", () => 0)).toBe("b");
  });

  it("직전 URL 이 목록에 없으면 전부가 후보다", () => {
    expect(pickExpressionUrl(["a", "b"], "z", () => 0)).toBe("a");
  });

  it("rand 값에 따라 다른 장을 고른다", () => {
    expect(pickExpressionUrl(["a", "b", "c"], undefined, () => 0)).toBe("a");
    expect(pickExpressionUrl(["a", "b", "c"], undefined, () => 0.99)).toBe("c");
  });
});

describe("간격 상한 상수", () => {
  it("120초다", () => {
    expect(EXPRESSION_MIN_INTERVAL_MS).toBe(120_000);
  });
});

describe("withinExpressionInterval", () => {
  it("이전 발송 기록이 없으면 상한에 걸리지 않는다", () => {
    expect(withinExpressionInterval(undefined, 1_000_000)).toBe(false);
  });

  it("상한 안이면 true(= 보내지 않는다)", () => {
    expect(withinExpressionInterval(1_000_000, 1_000_000 + 1)).toBe(true);
    expect(withinExpressionInterval(1_000_000, 1_000_000 + 119_999)).toBe(true);
  });

  it("정확히 상한만큼 지났으면 보낸다(경계 포함)", () => {
    expect(withinExpressionInterval(1_000_000, 1_000_000 + 120_000)).toBe(false);
  });

  it("상한을 넘었으면 보낸다", () => {
    expect(withinExpressionInterval(1_000_000, 1_000_000 + 500_000)).toBe(false);
  });
});

describe("planSend — 전송 형태", () => {
  it("이미지가 없으면 청크만, embed 없음", () => {
    const p = planSend("안녕", false);
    expect(p).toEqual({ chunks: ["안녕"], embedOnLast: false, embedOnly: false });
  });

  it("이미지가 있으면 마지막 청크에 붙인다", () => {
    const p = planSend("안녕", true);
    expect(p.chunks).toEqual(["안녕"]);
    expect(p.embedOnLast).toBe(true);
    expect(p.embedOnly).toBe(false);
  });

  it("본문이 비고 이미지만 있으면 embed 만 보낸다", () => {
    const p = planSend("", true);
    expect(p.chunks).toEqual([]);
    expect(p.embedOnly).toBe(true);
  });

  it("본문도 이미지도 없으면 아무것도 보내지 않는다", () => {
    const p = planSend("", false);
    expect(p.chunks).toEqual([]);
    expect(p.embedOnly).toBe(false);
    expect(p.embedOnLast).toBe(false);
  });

  it("긴 본문은 여러 청크로 나뉘고 embed 는 마지막에만 붙는다", () => {
    const p = planSend("가".repeat(4500), true);
    expect(p.chunks.length).toBeGreaterThan(1);
    expect(p.embedOnLast).toBe(true);
    expect(p.embedOnly).toBe(false);
  });
});

// ── FIX1~FIX4: 표정 마커 답변의 전송 보장 (리뷰 재현분) ──────────────────────
// DiscordAdapter 의 private 메서드(resolveExpression/send/enqueueSendAfter)를 직접 호출해 검증한다.
// TS 의 private 는 컴파일 타임 표시일 뿐이라 런타임엔 그대로 호출 가능하고, 이 프로젝트의
// tsconfig 는 tests/ 를 include 하지 않으므로(tsc --noEmit 대상 아님) 이런 타입 단언이 자유롭다.

type SentPayload = string | { content?: string; embeds: EmbedBuilder[] };

type TestableAdapter = {
  client: unknown;
  expressionState: Map<string, { lastTs: number; lastUrl?: string }>;
  sendChains: Map<string, Promise<void>>;
  resolveExpression(channelRef: string, emotion: string | null, textIsEmpty: boolean): Promise<string | undefined>;
  send(channelRef: string, text: string, imageUrl?: string): Promise<void>;
  enqueueSendAfter(channelRef: string, wait: Promise<void>, text: string, emotion?: string | null): void;
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
    workerToken: "x".repeat(20),
    httpPort: 3000,
  };
}

// 실제 디스코드 연결 없이 DiscordAdapter 를 만든다. client 는 channels.fetch 만 흉내내는 가짜로
// 갈아끼운다 — send()/resolveExpression() 은 isSendable()/send() 만 있으면 동작한다.
function makeAdapter(urlsFor: (emotion: string) => Promise<string[]>) {
  const bus = new EventBus();
  const characterImages = { urlsFor } as unknown as CharacterImagesRepo;
  const adapter = new DiscordAdapter({
    bus,
    config: makeConfig(),
    users: {} as unknown as UsersRepo,
    conversations: {} as unknown as ConversationsRepo,
    characterImages,
  });
  const sent: SentPayload[] = [];
  const view = adapter as unknown as TestableAdapter;
  view.client = { channels: { fetch: async () => makeFakeChannel(sent) } };
  return { view, sent };
}

describe("resolveExpression — 마커만 있는 답변은 간격 제한을 건너뛴다 (FIX1-a)", () => {
  it("본문이 없으면(textIsEmpty=true) 간격 제한이 걸려 있어도 이미지를 해석한다", async () => {
    const { view } = makeAdapter(async (emotion) => (emotion === "졸림" ? ["https://img.example/dozy.png"] : []));
    const channelRef = "chan-limit-empty";
    // 직전 전송을 "방금"으로 만들어 120초 간격 제한이 걸린 상태를 재현한다.
    view.expressionState.set(channelRef, { lastTs: Date.now(), lastUrl: undefined });

    const url = await view.resolveExpression(channelRef, "졸림", true);

    expect(url).toBe("https://img.example/dozy.png");
    // 보낸 뒤에는 간격 상태가 반드시 갱신되어야 한다(다음 마커 억제를 위해 — FIX1 요구사항).
    expect(view.expressionState.get(channelRef)?.lastUrl).toBe("https://img.example/dozy.png");
  });

  it("본문이 있으면(textIsEmpty=false) 간격 제한 중엔 기존대로 이미지를 보내지 않는다", async () => {
    const { view } = makeAdapter(async () => ["https://img.example/dozy.png"]);
    const channelRef = "chan-limit-nonempty";
    view.expressionState.set(channelRef, { lastTs: Date.now(), lastUrl: undefined });

    const url = await view.resolveExpression(channelRef, "졸림", false);

    expect(url).toBeUndefined();
  });

  it("emotion 이 없으면(system_notice 경로) DB 조회 자체를 하지 않는다 — 이미지가 절대 붙지 않는다", async () => {
    let called = false;
    const { view } = makeAdapter(async () => {
      called = true;
      return ["https://img.example/x.png"];
    });

    const url = await view.resolveExpression("chan-notice", null, false);

    expect(url).toBeUndefined();
    expect(called).toBe(false);
  });
});

describe("send — 텍스트도 이미지도 없으면 폴백 텍스트를 보낸다 (FIX1-b)", () => {
  it("마커만 있는 답변에서 이미지 해석까지 실패하면(알 수 없는 감정) 침묵 대신 폴백을 보낸다", async () => {
    const { view, sent } = makeAdapter(async () => []); // 어떤 감정이든 URL 없음(미등록 감정 흉내)
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const channelRef = "chan-unknown-emotion";

    const url = await view.resolveExpression(channelRef, "존재하지않는감정", true);
    expect(url).toBeUndefined(); // 전제조건: 정말로 이미지 해석이 실패했는가

    await view.send(channelRef, "", url);

    expect(sent).toEqual([EXPRESSION_EMPTY_FALLBACK]);
    const loggedChannel = errorSpy.mock.calls.some((args) =>
      args.some((a) => typeof a === "string" && a.includes(channelRef)),
    );
    expect(loggedChannel).toBe(true); // 채널을 특정할 수 있는 로그가 남아야 한다

    errorSpy.mockRestore();
  });

  it("텍스트도 imageUrl 도 없이 호출되면(호출측 방어 실패 상황 포함) 역시 폴백을 보낸다", async () => {
    const { view, sent } = makeAdapter(async () => []);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await view.send("chan-nothing", "", undefined);

    expect(sent).toEqual([EXPRESSION_EMPTY_FALLBACK]);

    errorSpy.mockRestore();
  });
});

describe("send — 잘못된 이미지 URL 이어도 본문은 그대로 보낸다 (FIX2)", () => {
  it("URL 이 아닌 문자열(EmbedBuilder 가 던짐)이어도 텍스트 전송은 막히지 않는다", async () => {
    const { view, sent } = makeAdapter(async () => []);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await view.send("chan-bad-url", "안녕하세요, 오늘 하루 어땠어요?", "not-a-url");

    expect(sent).toEqual(["안녕하세요, 오늘 하루 어땠어요?"]); // embed 없이 순수 텍스트로 나감
    expect(errorSpy).toHaveBeenCalled();

    errorSpy.mockRestore();
  });

  it("본문이 길고 이미지 URL 이 깨져도 긴 답장 전체가 청크로 나간다(유실 방지)", async () => {
    const { view, sent } = makeAdapter(async () => []);
    const longText = "가".repeat(4500);

    await view.send("chan-bad-url-long", longText, "garbage garbage");

    expect(sent.length).toBeGreaterThan(1); // 여러 청크로 분할되어 전부 전송됨
    expect(sent.every((s) => typeof s === "string")).toBe(true); // embed 없이
    expect((sent as string[]).join("")).toBe(longText);
  });

  it("URL 이 정상이면 여전히 텍스트와 함께 embed 를 붙인다(회귀 방지)", async () => {
    const { view, sent } = makeAdapter(async () => []);

    await view.send("chan-good-url", "안녕", "https://img.example/ok.png");

    expect(sent).toHaveLength(1);
    const payload = sent[0] as { content?: string; embeds: EmbedBuilder[] };
    expect(payload.content).toBe("안녕");
    expect(payload.embeds).toHaveLength(1);
    expect(payload.embeds[0].toJSON().image?.url).toBe("https://img.example/ok.png");
  });
});

describe("enqueueSendAfter — 발행 순서가 곧 전송 순서 (FIX3/FIX4)", () => {
  it("먼저 등록된 턴의 이미지 조회가 늦게 끝나도, 그 턴의 전송이 다음 턴보다 먼저 나간다", async () => {
    let releaseFirst!: (urls: string[]) => void;
    const gate = new Promise<string[]>((res) => { releaseFirst = res; });
    let lookups = 0;
    const { view, sent } = makeAdapter(async () => {
      lookups += 1;
      if (lookups === 1) return gate; // 턴 1의 DB 조회는 나중에 수동으로 풀어준다
      return [];
    });
    const channelRef = "chan-order";

    // 두 턴을 동기적으로 연달아 등록한다 — bus.publish 가 핸들러를 동기 호출하는 실제 상황과 같다.
    view.enqueueSendAfter(channelRef, Promise.resolve(), "", "졸림");        // 턴 1: 마커만, 조회가 느림
    view.enqueueSendAfter(channelRef, Promise.resolve(), "두 번째 턴", null); // 턴 2: emotion 없어 즉시 끝남

    const tail = view.sendChains.get(channelRef)!; // 턴 2 등록 이후의 체인 꼬리 = 두 턴이 다 끝나야 풀린다
    releaseFirst(["https://img.example/first.png"]);
    await tail;

    expect(sent).toHaveLength(2);
    const first = sent[0] as { embeds: EmbedBuilder[] };
    expect(first.embeds).toHaveLength(1);
    expect(first.embeds[0].toJSON().image?.url).toBe("https://img.example/first.png");
    expect(sent[1]).toBe("두 번째 턴"); // 늦게 등록됐지만 먼저 끝나는 턴이 새치기하지 않는다
    expect(lookups).toBe(1); // 턴 2 는 emotion 이 없어 조회 자체가 없었다
  });
});
