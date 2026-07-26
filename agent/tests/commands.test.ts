import { describe, it, expect } from "vitest";
import { parseSessionCommand, parseDigestCommand, parseHelpCommand, renderCommandHelp, COMMAND_HELP, isChannelCommand } from "../src/core/commands.js";

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

describe("parseHelpCommand", () => {
  it("도움말 예약어를 인식한다", () => {
    expect(parseHelpCommand("/help")).toBe(true);
    expect(parseHelpCommand("/도움말")).toBe(true);
    expect(parseHelpCommand("/명령어")).toBe(true);
  });

  it("앞뒤 공백과 대소문자를 무시한다", () => {
    expect(parseHelpCommand("  /HELP  ")).toBe(true);
  });

  it("정확히 일치할 때만 인식한다", () => {
    expect(parseHelpCommand("/help 알려줘")).toBe(false);
    expect(parseHelpCommand("help")).toBe(false);
    expect(parseHelpCommand("")).toBe(false);
  });

  it("다른 예약어와 서로 간섭하지 않는다", () => {
    expect(parseHelpCommand("/새세션")).toBe(false);
    expect(parseHelpCommand("/대회")).toBe(false);
    expect(parseSessionCommand("/help")).toBeNull();
    expect(parseDigestCommand("/help")).toBeNull();
  });
});

describe("renderCommandHelp — 안내문이 실제 예약어와 어긋나지 않는다", () => {
  it("파싱되는 모든 예약어가 안내문에 나온다", () => {
    const help = renderCommandHelp();
    // 안내문에 적힌 예약어를 전부 모아, 하나도 빠짐없이 실제로 파싱되는지 확인한다.
    const listed = COMMAND_HELP.flatMap((g) => g.commands);
    expect(listed.length).toBeGreaterThan(0);
    for (const cmd of listed) {
      expect(help).toContain(cmd);
      const parsed = parseSessionCommand(cmd) !== null || parseDigestCommand(cmd) !== null || parseHelpCommand(cmd);
      expect(parsed, `${cmd} 는 안내문에 있지만 파싱되지 않는다`).toBe(true);
    }
  });

  it("세션·조사·도움말 예약어가 모두 안내문에 포함된다", () => {
    const help = renderCommandHelp();
    for (const cmd of ["/새세션", "/대회", "/개발뉴스", "/help"]) {
      expect(help).toContain(cmd);
    }
  });

  it("각 그룹에 설명이 붙어 있다", () => {
    for (const g of COMMAND_HELP) {
      expect(g.commands.length).toBeGreaterThan(0);
      expect(g.description.length).toBeGreaterThan(5);
    }
  });
});

describe("isChannelCommand — 대화 없이 일반 채널에서 처리할 수 있는 예약어", () => {
  it("조사 예약어와 /help 는 채널에서 받는다", () => {
    for (const t of ["/대회", "/개발뉴스", "/help", "/도움말", "/명령어"]) {
      expect(isChannelCommand(t)).toBe(true);
    }
  });

  it("/새세션 계열은 제외한다 — 초기화할 세션이 있어야 의미가 있다", () => {
    for (const t of ["/새세션", "/새대화", "/새로시작", "/reset"]) {
      expect(isChannelCommand(t)).toBe(false);
    }
  });

  it("일반 대화는 통과시키지 않는다", () => {
    expect(isChannelCommand("대회 알려줘")).toBe(false);
    expect(isChannelCommand("/대회 나가고 싶다")).toBe(false);
    expect(isChannelCommand("")).toBe(false);
  });
});
