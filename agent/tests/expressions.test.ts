import { describe, it, expect } from "vitest";
import { parseExpression } from "../src/core/expressions.js";

describe("parseExpression — 마커 추출", () => {
  it("문장 끝의 마커를 떼어내고 감정을 돌려준다", () => {
    const r = parseExpression("…딱히 널 위해서 한 건 아니야. [표정:홍조]");
    expect(r.emotion).toBe("홍조");
    expect(r.text).toBe("…딱히 널 위해서 한 건 아니야.");
  });

  it("문장 앞·중간의 마커도 처리한다", () => {
    expect(parseExpression("[표정:당황] 어, 그건…").text).toBe("어, 그건…");
    expect(parseExpression("어 [표정:당황] 그건…").text).toBe("어 그건…");
  });

  it("공백이 들어간 감정 이름을 그대로 인식한다", () => {
    expect(parseExpression("됐어. [표정:기본 무표정]").emotion).toBe("기본 무표정");
    expect(parseExpression("됐어. [표정:빤히 응시]").emotion).toBe("빤히 응시");
  });

  it("감정 이름 앞뒤 공백은 다듬는다", () => {
    expect(parseExpression("응. [표정: 졸림 ]").emotion).toBe("졸림");
  });
});

describe("parseExpression — 여러 개·없음·빈 값", () => {
  it("마커가 여러 개면 첫 번째만 채택하고 나머지도 전부 제거한다", () => {
    const r = parseExpression("[표정:웃음] 그래. [표정:화남] 아니 됐어.");
    expect(r.emotion).toBe("웃음");
    expect(r.text).toBe("그래. 아니 됐어.");
  });

  it("마커가 없으면 emotion 은 null 이고 본문은 그대로다", () => {
    const r = parseExpression("확인했어.");
    expect(r).toEqual({ text: "확인했어.", emotion: null });
  });

  it("빈 감정 이름은 제거만 하고 채택하지 않는다", () => {
    const r = parseExpression("음. [표정:]");
    expect(r.emotion).toBeNull();
    expect(r.text).toBe("음.");
  });

  it("콜론이 없는 유사 문자열은 마커가 아니다", () => {
    const r = parseExpression("[표정] 이건 그냥 텍스트야.");
    expect(r.emotion).toBeNull();
    expect(r.text).toBe("[표정] 이건 그냥 텍스트야.");
  });

  it("마커만 있고 본문이 없으면 text 는 빈 문자열이다", () => {
    const r = parseExpression("[표정:졸림]");
    expect(r.emotion).toBe("졸림");
    expect(r.text).toBe("");
  });
});

describe("parseExpression — 공백 정리", () => {
  it("마커를 뗀 자리에 생긴 연속 공백을 하나로 줄인다", () => {
    expect(parseExpression("그래  [표정:웃음]  알겠어").text).toBe("그래 알겠어");
  });

  it("줄 끝 공백과 앞뒤 공백을 없앤다", () => {
    expect(parseExpression("  됐어. [표정:홍조]  ").text).toBe("됐어.");
  });

  it("줄바꿈은 보존하되 3줄 이상 연속은 2줄로 줄인다", () => {
    expect(parseExpression("첫 줄\n둘째 줄 [표정:웃음]").text).toBe("첫 줄\n둘째 줄");
    expect(parseExpression("가\n\n\n\n나").text).toBe("가\n\n나");
  });
});
