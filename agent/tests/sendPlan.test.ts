import { describe, it, expect } from "vitest";
import { planSend, chunkMessage } from "../src/adapters/discord.js";

// 디스코드 2000자 분할은 표정과 무관한 로직인데 테스트가 expressionSend.test.ts 안에만 있었다.
// 그 파일을 그냥 지우면 분할이 커버리지 없이 남는다 — 지우기 전에 여기로 옮긴다.
describe("chunkMessage — 디스코드 상한 분할", () => {
  it("상한 안이면 한 덩어리다", () => {
    expect(chunkMessage("안녕하세요")).toEqual(["안녕하세요"]);
  });

  it("상한을 넘으면 나뉘고, 각 조각이 상한 이하이며, 이어 붙이면 원문이다", () => {
    const out = chunkMessage("가".repeat(5000));
    expect(out.length).toBeGreaterThan(1);
    for (const c of out) expect(c.length).toBeLessThanOrEqual(2000);
    expect(out.join("")).toBe("가".repeat(5000));
  });

  it("빈 문자열은 조각이 없다", () => {
    expect(chunkMessage("")).toEqual([]);
  });
});

describe("planSend — 전송 계획", () => {
  it("본문이 있으면 청크로 나눈다", () => {
    expect(planSend("안녕하세요").chunks).toEqual(["안녕하세요"]);
  });

  it("본문이 없으면 청크가 없다", () => {
    expect(planSend("").chunks).toEqual([]);
  });

  it("긴 본문은 여러 청크가 된다", () => {
    expect(planSend("가".repeat(5000)).chunks.length).toBeGreaterThan(1);
  });
});
