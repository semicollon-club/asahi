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

// ── FIX1(치명, 머지 전 리뷰) — Object.prototype 상속 키 오인식 방지 ─────────────
// DIGEST_COMMANDS 는 `{ "/대회": "contest", "/개발뉴스": "devnews" }` 같은 평범한 객체 리터럴이었다.
// `DIGEST_COMMANDS[key] ?? null` 은 key 가 "constructor"·"__proto__"·"toString"·"hasOwnProperty"·
// "valueOf" 처럼 Object.prototype 이 물려주는 이름이면, 그 상속된 값(모두 truthy 한 함수/객체)을
// 그대로 돌려준다 — `?? null` 은 null/undefined 에만 반응하므로 걸러내지 못한다. 그 결과
// `parseDigestCommand('constructor')` 가 `Object` 생성자 함수를 돌려주고, 이게 `isChannelCommand`를
// 거쳐 `decideRoute`까지 올라가 "constructor"라고만 친 손님 메시지가 채널 명령으로 오인식됐다
// (실제 재현: 조사 시작 → DIGEST_TOPICS[Object 함수] 가 undefined 라 .prompt 접근에서 TypeError,
// 손님 턴 하나 소모, 엉뚱한 실패 메시지가 채널에 전송). 세션·도움말 예약어는 원래 Set 기반이라
// (Set.has 는 멤버십만 보고 프로토타입 체인을 타지 않는다) 이 종류의 버그가 없다 — 아래에서
// 실제로 안전함을 함께 확인해 회귀를 막는다.
describe("FIX1 — Object.prototype 상속 키는 예약어로 오인식되지 않는다", () => {
  const poisonedKeys = ["constructor", "__proto__", "toString", "hasOwnProperty", "valueOf"];

  it("parseDigestCommand 는 Object.prototype 상속 키에 null 을 돌려준다(핵심 회귀)", () => {
    for (const key of poisonedKeys) {
      expect(parseDigestCommand(key), `${key} 는 예약어가 아니어야 한다`).toBeNull();
      // 대소문자·앞뒤 공백을 무시하는 정규화를 거쳐도 여전히 안전해야 한다.
      expect(parseDigestCommand(`  ${key.toUpperCase()}  `)).toBeNull();
    }
  });

  it("parseSessionCommand 는 Set 기반이라 원래도 안전하다(검증, 회귀 방지)", () => {
    for (const key of poisonedKeys) {
      expect(parseSessionCommand(key)).toBeNull();
    }
  });

  it("parseHelpCommand 는 Set 기반이라 원래도 안전하다(검증, 회귀 방지)", () => {
    for (const key of poisonedKeys) {
      expect(parseHelpCommand(key)).toBe(false);
    }
  });

  it("isChannelCommand 는 어떤 상속 키에도 채널 명령으로 통과시키지 않는다(실제 취약 경로)", () => {
    for (const key of poisonedKeys) {
      expect(isChannelCommand(key), `${key} 는 채널 명령이 아니어야 한다`).toBe(false);
    }
  });
});
