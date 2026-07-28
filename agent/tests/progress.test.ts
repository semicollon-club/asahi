import { describe, it, expect } from "vitest";
import { progressFromMessage, shortToolName, summarizeToolInput, type ProgressUpdate, type PendingTool } from "../src/core/agent.js";
import { formatProgress } from "../src/core/core.js";

describe("shortToolName — mcp__asahi__ 접두어 제거", () => {
  it("mcp__asahi__recall → recall", () => {
    expect(shortToolName("mcp__asahi__recall")).toBe("recall");
  });
  it("mcp__asahi__remember → remember", () => {
    expect(shortToolName("mcp__asahi__remember")).toBe("remember");
  });
  it("접두어 없는 파일 도구는 그대로", () => {
    expect(shortToolName("Read")).toBe("Read");
  });
});

describe("summarizeToolInput — 도구 입력 요약", () => {
  it("query 필드를 우선 뽑는다", () => {
    expect(summarizeToolInput({ query: "병원" })).toBe("병원");
  });
  it("title 필드도 뽑는다(remember)", () => {
    expect(summarizeToolInput({ title: "선호", content: "긴 내용..." })).toBe("선호");
  });
  it("문자열 입력은 그대로(트림)", () => {
    expect(summarizeToolInput("  hello  ")).toBe("hello");
  });
  it("알려진 필드가 없으면 undefined", () => {
    expect(summarizeToolInput({ foo: 1 })).toBeUndefined();
  });
  it("너무 길면 잘라낸다", () => {
    const long = "a".repeat(100);
    const out = summarizeToolInput({ query: long });
    expect(out!.length).toBeLessThan(long.length);
    expect(out).toContain("…");
  });
});

// Task 1(2026-07-28 관측 기반 M1): progressFromMessage 의 pending 이 이름(string)만 담던 것에서
// PendingTool(이름·입력·시작시각)을 담는 것으로, tool_result 가 ok/summary/durationMs 를 함께
// 싣는 것으로 확장됐다(agent.ts 참고). 아래는 그 확장에 맞춰 pending 의 타입과 tool_result 기대값을
// 갱신한 것이다 — 짝짓기 자체의 상세 동작(같은 도구 연속 호출, 200자 절단 등)은
// agent.test.ts 의 "progressFromMessage — tool_result 에 성패·입력·소요시간을 싣는다" 쪽에서
// 별도로 두텁게 검증한다. 여기서는 이 파일이 원래 확인하던 것(블록 종류별 분기, pending 소비)만
// 새 모양에 맞춰 유지한다.
describe("progressFromMessage — SDK 메시지에서 진행 업데이트 추출(순수)", () => {
  it("assistant 의 tool_use 블록 → kind:'tool'", () => {
    const pending = new Map<string, PendingTool>();
    const msg = {
      type: "assistant",
      message: { content: [{ type: "tool_use", id: "t1", name: "mcp__asahi__recall", input: { query: "병원" } }] },
    };
    const updates = progressFromMessage(msg, pending);
    expect(updates).toEqual<ProgressUpdate[]>([{ kind: "tool", name: "recall", input: "병원" }]);
    expect(pending.get("t1")?.name).toBe("recall");
  });

  it("assistant 의 text 블록 → kind:'answering'", () => {
    const pending = new Map<string, PendingTool>();
    const msg = { type: "assistant", message: { content: [{ type: "text", text: "안녕하세요" }] } };
    expect(progressFromMessage(msg, pending)).toEqual<ProgressUpdate[]>([{ kind: "answering" }]);
  });

  it("user 의 tool_result 블록 → kind:'tool_result', pending 에서 이름을 되찾는다", () => {
    const pending = new Map<string, PendingTool>([["t1", { name: "recall", input: "병원", startedAt: 0 }]]);
    const msg = { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "결과" }] } };
    expect(progressFromMessage(msg, pending, () => 50)).toEqual<ProgressUpdate[]>([
      { kind: "tool_result", name: "recall", input: "병원", ok: true, summary: "결과", durationMs: 50 },
    ]);
    expect(pending.has("t1")).toBe(false); // 소비 후 제거
  });

  it("pending 에 없는 tool_result 는 name 없이", () => {
    const pending = new Map<string, PendingTool>();
    const msg = { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "unknown", content: "결과" }] } };
    expect(progressFromMessage(msg, pending)).toEqual<ProgressUpdate[]>([
      { kind: "tool_result", name: undefined, input: undefined, ok: true, summary: "결과", durationMs: undefined },
    ]);
  });

  it("system/result 타입 등 content 가 없는 메시지는 빈 배열", () => {
    const pending = new Map<string, PendingTool>();
    expect(progressFromMessage({ type: "system" }, pending)).toEqual([]);
    expect(progressFromMessage({ type: "result" }, pending)).toEqual([]);
  });

  it("문자열 content(예: user 메시지 replay)는 빈 배열", () => {
    const pending = new Map<string, PendingTool>();
    const msg = { type: "user", message: { content: "그냥 텍스트" } };
    expect(progressFromMessage(msg, pending)).toEqual([]);
  });
});

describe("formatProgress — 진행 업데이트를 사용자용 텍스트로", () => {
  it("tool + input → name(\"input\")", () => {
    expect(formatProgress({ kind: "tool", name: "recall", input: "병원" })).toBe('recall("병원")');
  });
  it("tool without input → name()", () => {
    expect(formatProgress({ kind: "tool", name: "Read" })).toBe("Read()");
  });
  it("tool_result with name", () => {
    // ok 는 Task 1 로 새로 필수가 된 필드다(타입만 맞추는 값 — 이 테스트의 관심사는 이름 노출이다).
    expect(formatProgress({ kind: "tool_result", name: "recall", ok: true })).toContain("recall");
  });
  it("tool_result without name도 문구를 낸다", () => {
    expect(formatProgress({ kind: "tool_result", ok: true }).length).toBeGreaterThan(0);
  });
  it("answering → 답변 작성 중", () => {
    expect(formatProgress({ kind: "answering" })).toBe("답변 작성 중");
  });
});
