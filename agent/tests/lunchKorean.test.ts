import { describe, it, expect } from "vitest";
import { objectParticle } from "../src/lunch/korean.js";

// 최종 리뷰 Critical — "최근에 음식점을(를) 1번 드셨어요" 는 값과 무관하게 비문이다. 한국어
// 목적격 조사(을/를)는 앞 음절이 받침으로 끝나는지로 갈린다: 한식을(받침 ㄱ), 파스타를(받침
// 없음). 저장소 안에 이미 있는 조사 판정을 검색했지만 없었다(memoryScope.ts:124-125 는 같은
// 문제를 "조사 없는 형태로 우회"해 정면으로 풀지 않았다) — 그래서 여기서 가장 작은 형태로
// 새로 만든다.
describe("objectParticle", () => {
  it("받침 있는 음절로 끝나면 '을' 이다", () => {
    expect(objectParticle("한식")).toBe("을");
    expect(objectParticle("중식")).toBe("을"); // "식"(시+ㄱ) 받침
    expect(objectParticle("치킨")).toBe("을"); // "킨"(키+ㄴ) 받침
  });

  it("받침 없는 음절로 끝나면 '를' 이다", () => {
    expect(objectParticle("파스타")).toBe("를");
    expect(objectParticle("카페")).toBe("를");
    expect(objectParticle("초밥")).toBe("을"); // "밥"(바+ㅂ) 받침 — 대조군
  });

  it("한글 음절이 아닌 문자로 끝나면(방어적으로) 받침 없는 쪽을 기본값으로 쓴다", () => {
    expect(objectParticle("BBQ")).toBe("를");
    expect(objectParticle("")).toBe("를");
  });

  it("앞뒤 공백은 무시하고 마지막 글자를 본다", () => {
    expect(objectParticle("한식 ")).toBe("을");
  });
});
