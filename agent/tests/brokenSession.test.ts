import { describe, it, expect } from "vitest";
import { isBrokenSession, isSessionNotFound } from "../src/core/turnPrep.js";
import { setupCore, flush, threadHint, say } from "./helpers/coreSetup.js";

// 2026-11-25 리뷰 L5: 도구 호출 도중 중단된 세션은 이어받을 때 API 가 거절할 수 있다. 그 세션을 붙잡고 있으면 이후 모든
// 턴이 실패하므로(사람이 /새세션 을 칠 때까지), 세션 없음과 같이 버리고 새 세션으로 다시 한다.

describe("isBrokenSession", () => {
  it("Claude Code 문구와 API 원문을 알아본다", () => {
    expect(isBrokenSession(new Error("API Error: 400 due to tool use concurrency issues. Run /rewind to recover the conversation."))).toBe(true);
    expect(isBrokenSession(new Error("messages.12: `tool_use` ids were found without `tool_result` blocks immediately after: toolu_01"))).toBe(true);
  });
  it("다른 실패는 아니다 — 세션 없음과도 구별된다", () => {
    expect(isBrokenSession(new Error("No conversation found with session ID: abc"))).toBe(false);
    expect(isBrokenSession(new Error("error_max_turns"))).toBe(false);
    expect(isSessionNotFound(new Error("API Error: 400 due to tool use concurrency issues."))).toBe(false);
  });
});

describe("코어 — 이어받을 수 없는 세션은 버리고 새 세션으로 다시 한다", () => {
  it("resume 한 턴이 깨진 세션으로 실패하면 resume 없이 한 번 더 부른다", async () => {
    const f = await setupCore({
      runTurn: async (req) => {
        if (req.resume) throw new Error("Claude Code returned an error result: API Error: 400 due to tool use concurrency issues.");
        return { ok: true, text: "새 세션 답", sessionId: "s-fresh" };
      },
    });
    const hint = threadHint("guest", "th-b", "allowed");
    say(f.bus, hint, "첫 마디");
    await flush();
    await f.core.drain();
    // 두 번째 턴은 첫 턴의 세션(s-fresh)을 resume 한다 → 깨짐 → 새 세션 재시도.
    say(f.bus, hint, "두 번째");
    await flush();
    await f.core.drain();
    const resumes = f.calls.map((c) => c.resume);
    expect(resumes).toEqual([undefined, "s-fresh", undefined]);
    expect(f.eventsIn("th-b", "assistant_message").map((e) => ("text" in e ? e.text : ""))).toEqual(["새 세션 답", "새 세션 답"]);
    expect(f.eventsIn("th-b", "system_notice")).toHaveLength(0);
  });
});
