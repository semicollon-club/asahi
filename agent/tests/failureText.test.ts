import { describe, it, expect, vi } from "vitest";
import { classifyTurnFailure, describeTurnFailure } from "../src/core/failureText.js";
import { setupCore, flush, say, threadHint, dmHint } from "./helpers/coreSetup.js";

// 빠른 개선 2차 §3.3(2026-11-25) — 실패 안내는 원문 대신 상황을 말한다. 원문은 봇 로그와 소유자 DM 에만.

describe("classifyTurnFailure — 원문 분류", () => {
  it("단계 상한·모델 혼잡·시간 상한·워커 연결·그 밖으로 나눈다", () => {
    expect(classifyTurnFailure("(에이전트 오류: error_max_turns)")).toBe("max_turns");
    expect(classifyTurnFailure("(에이전트 오류: API Error: 529 Overloaded)")).toBe("busy");
    expect(classifyTurnFailure("rate_limit_error: 429 Too Many Requests")).toBe("busy");
    // 허브의 턴 시간 상한 문구는 "워커" 를 담지만 시간 상한이 먼저다.
    expect(classifyTurnFailure("(에이전트 오류: 워커가 1800000ms 안에 응답하지 않았어요(턴 결과 없음).)")).toBe("timeout");
    expect(classifyTurnFailure("(에이전트 오류: 워커가 연결돼 있지 않아요.)")).toBe("worker");
    expect(classifyTurnFailure("(에이전트 오류: error_during_execution)")).toBe("other");
  });
});

describe("describeTurnFailure — 문장", () => {
  it("원문을 그대로 내보내지 않고, 사람이 할 일을 말한다", () => {
    const t = describeTurnFailure("(에이전트 오류: error_max_turns)", { showRaw: false });
    expect(t).not.toMatch(/error_max_turns|에이전트 오류/);
    expect(t).toMatch(/이어서 해줘/);
    expect(describeTurnFailure("API Error: 529 Overloaded", { showRaw: false })).toMatch(/잠시 뒤 다시/);
  });

  it("showRaw 면 원문을 한 줄로 덧붙이고 길이를 자른다", () => {
    const raw = `(에이전트 오류: 이상한 실패\n둘째 줄 ${"x".repeat(1000)})`;
    const t = describeTurnFailure(raw, { showRaw: true });
    expect(t).toMatch(/\(원문: \(에이전트 오류: 이상한 실패 둘째 줄/);
    expect(t.split("\n").length).toBe(2);
    expect(t.length).toBeLessThan(500);
  });
});

describe("코어 — 실패한 턴의 안내", () => {
  it("공개 채널의 부원에게는 원문 없이 상황만 알리고, 원문은 봇 로그에 남긴다", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const f = await setupCore({ runTurn: async () => ({ ok: false, text: "(에이전트 오류: error_max_turns)" }) });
    say(f.bus, threadHint("guest", "th-f", "allowed"), "긴 작업");
    await flush(); await f.core.drain();
    const notices = f.eventsIn("th-f", "system_notice").map((e) => ("text" in e ? e.text : ""));
    expect(notices).toEqual([describeTurnFailure("(에이전트 오류: error_max_turns)", { showRaw: false })]);
    expect(warn.mock.calls.some((c) => String(c[0]).includes("error_max_turns"))).toBe(true);
    warn.mockRestore();
  });

  it("소유자 DM 에서는 원문을 덧붙인다", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const f = await setupCore({ runTurn: async () => ({ ok: false, text: "(에이전트 오류: error_during_execution)" }) });
    say(f.bus, dmHint("owner", "owner"), "해줘");
    await flush(); await f.core.drain();
    const notices = f.eventsIn("dm-owner", "system_notice").map((e) => ("text" in e ? e.text : ""));
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatch(/원문: \(에이전트 오류: error_during_execution\)/);
  });
});
