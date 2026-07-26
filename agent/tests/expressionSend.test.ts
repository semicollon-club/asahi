import { describe, it, expect } from "vitest";
import { pickExpressionUrl, EXPRESSION_MIN_INTERVAL_MS, withinExpressionInterval, planSend } from "../src/adapters/discord.js";

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
