import { describe, it, expect } from "vitest";
import { decideRoute, detectBotMention, type Incoming } from "../src/adapters/discord.js";

function inc(over: Partial<Incoming> = {}): Incoming {
  return {
    userId: "u1", channelId: "c1", isDM: false, isThread: false, mentionsBot: false,
    guildId: "g1", parentChannelId: undefined, content: "안녕", messageId: "m1", images: [], ...over,
  };
}

describe("decideRoute", () => {
  it("blocked/미등록 사용자는 무엇을 보내든 무시한다", () => {
    expect(decideRoute(inc({ isDM: true }), "blocked", false)).toEqual({ kind: "ignore" });
    expect(decideRoute(inc({ mentionsBot: true }), "blocked", false)).toEqual({ kind: "ignore" });
    expect(decideRoute(inc({ isThread: true }), "blocked", true)).toEqual({ kind: "ignore" });
  });

  it("허용 사용자의 DM 은 그 사용자 DM 대화로 간다", () => {
    expect(decideRoute(inc({ isDM: true }), "owner", false)).toEqual({ kind: "dm" });
    expect(decideRoute(inc({ isDM: true }), "allowed", false)).toEqual({ kind: "dm" });
  });

  it("이미 대화 행이 있는 스레드 안 메시지는 멘션 없이도 이어간다", () => {
    expect(decideRoute(inc({ isThread: true, mentionsBot: false }), "allowed", true)).toEqual({ kind: "thread-existing" });
  });

  it("아직 대화가 아닌 스레드에서 멘션하면 그 스레드를 채택한다", () => {
    expect(decideRoute(inc({ isThread: true, mentionsBot: true }), "allowed", false)).toEqual({ kind: "adopt-thread" });
  });

  it("대화도 아니고 멘션도 없는 스레드 메시지는 무시한다", () => {
    expect(decideRoute(inc({ isThread: true, mentionsBot: false }), "allowed", false)).toEqual({ kind: "ignore" });
  });

  it("일반 채널에서 멘션하면 새 스레드를 만든다", () => {
    expect(decideRoute(inc({ mentionsBot: true }), "owner", false)).toEqual({ kind: "thread-create" });
  });

  it("일반 채널에서 멘션이 없으면 무시한다", () => {
    expect(decideRoute(inc({ mentionsBot: false }), "owner", false)).toEqual({ kind: "ignore" });
  });

  it("이미 대화로 채택된 채널(스레드 생성 폴백 등)은 멘션 없이도 이어간다", () => {
    expect(decideRoute(inc({ isThread: false, mentionsBot: false }), "allowed", true)).toEqual({ kind: "thread-existing" });
  });
});

describe("detectBotMention", () => {
  // discord.js MessageMentions.has 의 실제 의미를 모조한다:
  // 기본 옵션(ignoreEveryone=false)이면 @everyone/@here 에도 true 로 단락된다.
  const fakeMentions = (opts: { directHasBot: boolean; everyone: boolean }) => ({
    has: (_bot: unknown, o?: { ignoreEveryone?: boolean }) => {
      if (!o?.ignoreEveryone && opts.everyone) return true;
      return opts.directHasBot;
    },
  });

  it("@everyone/@here 만 있고 봇 직접 멘션이 없으면 false (예산 잠식 방지)", () => {
    expect(detectBotMention(fakeMentions({ directHasBot: false, everyone: true }), {})).toBe(false);
  });

  it("봇을 직접 @멘션하면 true", () => {
    expect(detectBotMention(fakeMentions({ directHasBot: true, everyone: false }), {})).toBe(true);
  });
});

// 일반 채널의 예약어: 지금까지는 멘션이 없으면 무시돼 코어까지 닿지도 못했다. 쓰려면 봇을 멘션해
// 스레드를 연 뒤 그 안에서 쳐야 했고, 그러면 뉴스가 스레드에 갇혀 채널 밖에서 보이지 않았다.
describe("decideRoute — 일반 채널의 예약어(channel-command)", () => {
  it("멘션이 없어도 조사 예약어는 채널에서 그대로 받는다", () => {
    expect(decideRoute(inc({ content: "/대회" }), "allowed", false)).toEqual({ kind: "channel-command" });
    expect(decideRoute(inc({ content: "/개발뉴스" }), "owner", false)).toEqual({ kind: "channel-command" });
  });

  it("/help 도 채널에서 그대로 받는다", () => {
    expect(decideRoute(inc({ content: "/help" }), "allowed", false)).toEqual({ kind: "channel-command" });
  });

  it("앞뒤 공백·대소문자는 무시한다(파싱 규칙 일치)", () => {
    expect(decideRoute(inc({ content: "  /HELP  " }), "allowed", false)).toEqual({ kind: "channel-command" });
  });

  it("/새세션 은 채널 예약어가 아니다 — 초기화할 세션이 없으므로 무시한다", () => {
    expect(decideRoute(inc({ content: "/새세션" }), "owner", false)).toEqual({ kind: "ignore" });
  });

  it("예약어를 닮았을 뿐인 일반 대화는 여전히 무시한다", () => {
    expect(decideRoute(inc({ content: "/대회 나가고 싶다" }), "owner", false)).toEqual({ kind: "ignore" });
    expect(decideRoute(inc({ content: "오늘 대회 뭐 있어?" }), "owner", false)).toEqual({ kind: "ignore" });
  });

  it("게이트가 먼저다 — blocked 사용자의 예약어는 무시한다", () => {
    expect(decideRoute(inc({ content: "/대회" }), "blocked", false)).toEqual({ kind: "ignore" });
  });

  it("이미 대화인 채널에서는 기존 경로를 유지한다(대화로 처리)", () => {
    expect(decideRoute(inc({ content: "/대회" }), "owner", true)).toEqual({ kind: "thread-existing" });
  });

  it("멘션이 함께 있으면 기존대로 스레드를 연다(멘션이 우선)", () => {
    expect(decideRoute(inc({ content: "/대회", mentionsBot: true }), "owner", false)).toEqual({ kind: "thread-create" });
  });

  it("스레드 안에서는 규칙이 바뀌지 않는다 — 대화도 멘션도 없으면 무시", () => {
    expect(decideRoute(inc({ content: "/대회", isThread: true }), "owner", false)).toEqual({ kind: "ignore" });
  });
});

// FIX1(치명, 머지 전 리뷰) — isChannelCommand 가 내부적으로 쓰는 DIGEST_COMMANDS 조회가 평범한
// 객체 리터럴이라 Object.prototype 상속 키("constructor" 등)를 예약어로 오인식했다. 이 브랜치는
// isChannelCommand 를 decideRoute 에 새로 연결해, 이전엔 스레드/DM 안에서만 닿던 이 버그가 봇이
// 읽는 모든 일반 채널의 모든 메시지에서 평가되게 만들었다 — 손님이 그냥 "constructor" 라고만
// 쳐도 채널 명령으로 오인식되어 조사가 시작되려다 실패하는 게 실제 재현이었다(commands.ts 의
// parseDigestCommand 는 Object.hasOwn 으로 고쳤다). 여기서는 그 수정이 decideRoute 까지 올바르게
// 전파되는지 — 일반 채널에서 멘션 없이 이런 문자열만 보내면 반드시 ignore 로 떨어지는지 —
// 실제 취약 경로 그대로 확인한다.
describe("decideRoute — FIX1: Object.prototype 상속 키는 채널 명령으로 오인식되지 않는다", () => {
  it.each(["constructor", "__proto__", "toString", "hasOwnProperty", "valueOf"])(
    "일반 채널에서 멘션 없이 '%s' 만 보내면 무시한다(채널 명령 아님)",
    (text) => {
      expect(decideRoute(inc({ content: text }), "allowed", false)).toEqual({ kind: "ignore" });
      expect(decideRoute(inc({ content: text }), "owner", false)).toEqual({ kind: "ignore" });
    },
  );
});
