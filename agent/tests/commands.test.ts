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

  it("/기억정리 를 compact 로 인식한다", () => {
    expect(parseSessionCommand("/기억정리")).toBe("compact");
    expect(parseSessionCommand(" /기억정리 ")).toBe("compact");
  });

  it("/새세션 은 여전히 reset 이다", () => {
    expect(parseSessionCommand("/새세션")).toBe("reset");
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
    const help = renderCommandHelp(true);
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
    const help = renderCommandHelp(true);
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

  // /새세션 은 세션을 끊고 바닥선을 그을 뿐 기억에는 손대지 않는다. 이 명령을 치는 사람이
  // 실제로 걱정하는 것이 그것이므로, 안내문이 그 사실을 말하는지 고정한다.
  it("/새세션 안내가 기억은 남는다는 사실을 밝힌다", () => {
    const reset = COMMAND_HELP.find((g) => g.commands.includes("/새세션"));
    expect(reset?.description).toMatch(/기억은 남는다/);
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

  it("/기억정리 는 대화 없는 채널에서 처리하지 않는다", () => {
    // /새세션 과 같은 이유다 — 정리할 세션이 있어야 의미가 있고, 대화가 없는 채널에는
    // 대상 자체가 없다. 통과시키면 그 채널이 대화로 채택돼 이후 잡담에 봇이 끼어든다.
    expect(isChannelCommand("/기억정리")).toBe(false);
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

describe("renderCommandHelp — 손님이 무엇을 할 수 있는지 알린다", () => {
  it("자기 폴더 조회·파일 작업을 안내한다", () => {
    const help = renderCommandHelp(true);
    expect(help).toMatch(/폴더/);
    expect(help).toMatch(/파일/);
  });

  // Minor 6(최종 리뷰) — 세 번째 안내(명령 실행)에만 대응하는 단정이 없었다. 안내 항목이 조용히
  // 사라져도 아무도 눈치채지 못하는 상태였다. `/명령/` 만으로는 부족하다 — 예약어 목록의 "/명령어"
  // 가 그 패턴에 걸려, 이 안내가 통째로 빠져도 통과해 버린다.
  it("명령 실행(sh_exec)도 안내한다", () => {
    const help = renderCommandHelp(true);
    expect(help).toMatch(/명령 실행해줘/);
  });

  // Minor 7(최종 리뷰) — 손님도 fs_glob/fs_grep 을 쓸 수 있는데 안내에 없었다. 설계 §7 의 목적이
  // "쓸 수 있다는 사실 자체를 알리는 것"이고, 검색은 손님이 가장 자주 필요로 할 기능이다.
  it("검색·찾기(fs_glob/fs_grep)도 안내한다", () => {
    const help = renderCommandHelp(true);
    expect(help).toMatch(/찾|검색/);
  });

  it("소유자 전용 도구 이름은 노출하지 않는다", () => {
    const help = renderCommandHelp(true);
    expect(help).not.toMatch(/manage_access|db_query|allow_dir/);
  });
});

// ── 최종 리뷰 Important 3 — /help 의 능력 안내가 워커 연결 여부와 무관하게 나갔다 ──────────────
// persona.ts 는 같은 문장들을 네 분기 전부 workerConnected 로 갈라 내보내고, 그 주석은 이 어긋남을
// 명시적 결함 유형("안내와 실제 도구가 어긋남", FIX4)으로 부른다. 그런데 /help 는 사람이 직접 읽는
// 유일한 능력 안내인데도 그 규칙에서 빠져 있었다 — 미니PC 가 꺼져 있거나 워커가 끊긴 동안에도
// "파일 만들어줘 / 명령 실행해줘" 라고 말했다.
describe("renderCommandHelp — 능력 안내는 워커 연결 여부로 갈린다(최종 리뷰 Important 3)", () => {
  it("워커가 없으면 파일·셸 능력을 시키라고 말하지 않는다", () => {
    const help = renderCommandHelp(false);
    expect(help).not.toMatch(/파일 만들어줘|명령 실행해줘/);
  });

  it("워커가 없으면 지금은 안 된다는 사실을 알린다(침묵하면 왜 안 되는지 알 길이 없다)", () => {
    const help = renderCommandHelp(false);
    expect(help).toMatch(/지금은/);
    expect(help).toMatch(/PC|컴퓨터/);
  });

  it("워커가 없어도 예약어 목록 자체는 그대로 나온다(예약어는 워커와 무관하다)", () => {
    const help = renderCommandHelp(false);
    for (const cmd of ["/새세션", "/대회", "/개발뉴스", "/help"]) {
      expect(help).toContain(cmd);
    }
  });

  it("워커가 연결돼 있으면 예전 안내 그대로다", () => {
    const help = renderCommandHelp(true);
    expect(help).toMatch(/파일 만들어줘/);
    expect(help).toMatch(/명령 실행해줘/);
  });
});

// renderCommandHelp 는 workerConnected 를 위치 인자(boolean)로 받는다 — 객체가 아니다.
describe("renderCommandHelp — 오래 도는 프로세스를 안내한다", () => {
  it("워커가 연결돼 있으면 개발서버 안내가 있다", () => {
    expect(renderCommandHelp(true)).toMatch(/개발서버|오래 도는/);
  });

  it("워커가 연결돼 있지 않으면 안내하지 않는다", () => {
    expect(renderCommandHelp(false)).not.toMatch(/개발서버/);
  });

  // 2차 리뷰 Important — 이름만 보던 위 테스트(/개발서버|오래 도는/)는 "한 사람당 하나까지"가
  // "여러 개 띄울 수 있어"로 뒤집혀도 통과한다. 이 상한은 executors.ts 의 proc_start 중복 거부와
  // 일치해야 하는 클레임이므로 substring 을 직접 고정한다.
  it("한 사람당 하나까지라는 상한을 안내한다", () => {
    expect(renderCommandHelp(true)).toMatch(/한 사람당 하나/);
  });
});
