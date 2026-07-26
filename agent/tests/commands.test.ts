import { describe, it, expect } from "vitest";
import { parseSessionCommand, parseDigestCommand } from "../src/core/commands.js";

describe("parseSessionCommand", () => {
  it("예약어(/새세션·/새대화·/새로시작·/reset)를 reset 으로 인식한다(대소문자·앞뒤 공백 무시)", () => {
    for (const t of ["/새세션", " /새대화 ", "/새로시작", "/reset", "/RESET", "  /Reset"]) {
      expect(parseSessionCommand(t)).toBe("reset");
    }
  });

  it("슬래시가 없거나 정확히 일치하지 않는 텍스트는 null 이다(일반 대화 오작동 방지)", () => {
    for (const t of ["안녕", "새 세션 시작하자", "reset", "새세션", "/새세션 지금", "/새대화해줘", "/other", ""]) {
      expect(parseSessionCommand(t)).toBeNull();
    }
  });
});

describe("parseDigestCommand", () => {
  it("주제 예약어를 인식한다", () => {
    expect(parseDigestCommand("/대회")).toBe("contest");
    expect(parseDigestCommand("/개발뉴스")).toBe("devnews");
  });

  it("앞뒤 공백을 무시한다", () => {
    expect(parseDigestCommand("  /대회  ")).toBe("contest");
  });

  it("정확히 일치할 때만 인식한다(문장 안에 섞이면 아님)", () => {
    expect(parseDigestCommand("/대회 알려줘")).toBeNull();
    expect(parseDigestCommand("대회")).toBeNull();
    expect(parseDigestCommand("오늘 /대회 뭐 있어?")).toBeNull();
  });

  it("모르는 예약어는 null", () => {
    expect(parseDigestCommand("/뉴스")).toBeNull();
    expect(parseDigestCommand("/")).toBeNull();
    expect(parseDigestCommand("")).toBeNull();
  });

  it("기존 세션 예약어와 서로 간섭하지 않는다", () => {
    expect(parseDigestCommand("/새세션")).toBeNull();
    expect(parseSessionCommand("/대회")).toBeNull();
  });
});
