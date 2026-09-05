import { describe, it, expect, vi } from "vitest";
import { EventBus, type UserMessageEvent } from "../src/events/bus.js";

const msg: UserMessageEvent = { type: "user_message", channel: "discord", channelRef: "c1", text: "hi", ts: 1 };

describe("EventBus", () => {
  it("구독한 타입의 이벤트만 받는다", () => {
    const bus = new EventBus();
    const onUser = vi.fn();
    const onAssistant = vi.fn();
    bus.subscribe("user_message", onUser);
    bus.subscribe("assistant_message", onAssistant);
    bus.publish(msg);
    expect(onUser).toHaveBeenCalledWith(msg);
    expect(onAssistant).not.toHaveBeenCalled();
  });

  it("한 핸들러의 예외가 다른 핸들러를 막지 않는다", () => {
    const bus = new EventBus();
    const second = vi.fn();
    bus.subscribe("user_message", () => { throw new Error("boom"); });
    bus.subscribe("user_message", second);
    expect(() => bus.publish(msg)).not.toThrow();
    expect(second).toHaveBeenCalled();
  });
});

// 파일 반환(2026-09-05): 다섯째 이벤트. 바이트(Buffer)를 나르는 유일한 이벤트라 텍스트 이벤트 구독자에게
// 흘러들지 않는지를 함께 본다 — assistant_message 구독자가 이걸 받으면 text 가 없어 어댑터가 깨진다.
describe("EventBus — assistant_file", () => {
  it("assistant_file 구독자만 받고 텍스트 이벤트 구독자는 받지 않는다", () => {
    const bus = new EventBus();
    const onFile = vi.fn();
    const onText = vi.fn();
    bus.subscribe("assistant_file", onFile);
    bus.subscribe("assistant_message", onText);
    const e = { type: "assistant_file" as const, channel: "discord" as const, channelRef: "c1", name: "a.png", data: Buffer.from([1]), ts: 1 };
    bus.publish(e);
    expect(onFile).toHaveBeenCalledWith(e);
    expect(onText).not.toHaveBeenCalled();
  });
});
