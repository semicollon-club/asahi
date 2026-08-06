import { describe, it, expect } from "vitest";
import { planSend } from "../src/adapters/discord.js";

// chunkMessage 테스트는 여기 두지 않는다: discord.test.ts 가 이미 상한 내/분할/줄바꿈 경계/빈
// 문자열/서로게이트 쌍까지 다루는 전용 테스트를 갖고 있다(리뷰에서 확인됨) — 이 파일에 중복으로
// 두면 커버리지는 늘지 않고 유지 비용만 는다.
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
