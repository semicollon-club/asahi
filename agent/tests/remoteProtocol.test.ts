import { describe, it, expect } from "vitest";
import { encodeFrame, parseFrame, type Frame } from "../src/remote/protocol.js";

describe("프레임 직렬화", () => {
  it("7종 프레임을 인코딩·파싱해도 값이 보존된다", () => {
    const frames: Frame[] = [
      { type: "hello", token: "t", workerId: "w", roots: ["/a", "/b"] },
      { type: "ready" },
      { type: "denied", reason: "토큰 불일치" },
      { type: "call", id: "1", tool: "fs_read", args: { path: "/a/x.txt" } },
      { type: "result", id: "1", ok: true, content: "본문" },
      { type: "ping" },
      { type: "pong" },
    ];
    for (const f of frames) expect(parseFrame(encodeFrame(f))).toEqual(f);
  });
});

describe("프레임 검증 — 잘못된 입력은 null", () => {
  it("JSON 이 아니면 null", () => {
    expect(parseFrame("{{{")).toBeNull();
    expect(parseFrame("")).toBeNull();
  });

  it("알 수 없는 타입은 null", () => {
    expect(parseFrame(JSON.stringify({ type: "evil" }))).toBeNull();
  });

  it("필수 필드가 없거나 타입이 다르면 null", () => {
    expect(parseFrame(JSON.stringify({ type: "hello", token: "t", workerId: "w" }))).toBeNull();
    expect(parseFrame(JSON.stringify({ type: "hello", token: 1, workerId: "w", roots: [] }))).toBeNull();
    expect(parseFrame(JSON.stringify({ type: "call", id: "1", tool: "fs_read" }))).toBeNull();
    expect(parseFrame(JSON.stringify({ type: "result", id: "1", ok: "yes", content: "" }))).toBeNull();
  });

  it("roots 배열에 문자열이 아닌 값이 섞이면 null", () => {
    expect(parseFrame(JSON.stringify({ type: "hello", token: "t", workerId: "w", roots: ["/a", 3] }))).toBeNull();
  });
});

describe("hello — 신원이 userId 에서 workerId 로 바뀐다", () => {
  it("workerId 가 있는 hello 를 파싱한다", () => {
    const raw = JSON.stringify({ type: "hello", token: "t", workerId: "semicolon-shared", roots: ["C:\\ws"] });
    expect(parseFrame(raw)).toEqual({ type: "hello", token: "t", workerId: "semicolon-shared", roots: ["C:\\ws"] });
  });

  it("옛 형식(userId)은 거부한다 — 구버전 워커가 조용히 붙으면 안 된다", () => {
    const raw = JSON.stringify({ type: "hello", token: "t", userId: "123", roots: ["/ws"] });
    expect(parseFrame(raw)).toBeNull();
  });

  it("workerId 가 문자열이 아니면 거부한다", () => {
    for (const bad of [123, null, {}, []]) {
      const raw = JSON.stringify({ type: "hello", token: "t", workerId: bad, roots: ["/ws"] });
      expect(parseFrame(raw)).toBeNull();
    }
  });

  it("encode → parse 왕복이 보존된다", () => {
    const f = { type: "hello" as const, token: "t", workerId: "w1", roots: ["/a", "/b"] };
    expect(parseFrame(encodeFrame(f))).toEqual(f);
  });
});

describe("hello — commit 은 선택 필드다(옛 워커 호환)", () => {
  it("hello 는 commit 이 없어도 정상 파싱된다(옛 워커 호환)", () => {
    // 이 단정이 옛 워커 호환의 유일한 방어선이다. commit 을 필수로 만들면 옛 워커가 붙지 못하고
    // 거부 사유도 못 받아 3초마다 영원히 재연결한다.
    const f = parseFrame(JSON.stringify({ type: "hello", token: "t", workerId: "w", roots: ["/r"] }));
    expect(f).toEqual({ type: "hello", token: "t", workerId: "w", roots: ["/r"] });
  });

  it("hello 의 commit 이 문자열이면 싣는다", () => {
    const f = parseFrame(JSON.stringify({ type: "hello", token: "t", workerId: "w", roots: ["/r"], commit: "abc123" }));
    expect(f).toEqual({ type: "hello", token: "t", workerId: "w", roots: ["/r"], commit: "abc123" });
  });

  it("hello 의 commit 이 문자열이 아니면 그 필드만 버리고 연결은 살린다", () => {
    // 형태가 어긋난 부가 정보 때문에 인증 자체가 실패하면 안 된다 — 버전은 몰라도 되지만
    // 연결은 되어야 한다.
    const f = parseFrame(JSON.stringify({ type: "hello", token: "t", workerId: "w", roots: ["/r"], commit: 42 }));
    expect(f).toEqual({ type: "hello", token: "t", workerId: "w", roots: ["/r"] });
  });
});

// 풀 하네스 2단계(2026-09-05 밤): 세션 러너 프레임 넷. 옛 도구 호출 프레임과 공존한다 — 전환 기간 동안 같은
// 소켓으로 call/result 와 turn.* 가 함께 흐른다. hello 의 mode 는 "이 워커가 턴을 돌릴 수 있는가"를 봇에 알린다.
describe("프레임 — 세션 러너(turn.*)", () => {
  const start: Frame = {
    type: "turn.start", id: "t1", userId: "u1", cwd: "C:\\asahi-workspace", systemPrompt: "sys", prompt: "hi",
    resume: "sess-1", profile: { model: "claude-opus-5", maxTurns: 30, subagents: true, effort: "high", tools: ["Read"] },
    token: "asahi-job.x.y", git: { userName: "홍길동", userEmail: "u1@users.noreply.github.com", token: "ghs_1" },
  };

  it("turn.start/turn.event/turn.result/turn.cancel 을 인코딩·파싱해도 값이 보존된다", () => {
    const frames: Frame[] = [
      start,
      { type: "turn.event", id: "t1", event: { kind: "tool", name: "Read", input: "a.ts" } },
      { type: "turn.result", id: "t1", ok: true, text: "다 했어요", sessionId: "sess-2" },
      { type: "turn.result", id: "t1", ok: false, text: "", error: "No conversation found with session ID sess-1" },
      { type: "turn.cancel", id: "t1" },
    ];
    for (const f of frames) expect(parseFrame(encodeFrame(f))).toEqual(f);
  });

  it("turn.start 는 선택 필드(resume·git·effort·tools)가 없어도 통과한다", () => {
    const minimal: Frame = {
      type: "turn.start", id: "t2", userId: "u1", cwd: "/w", systemPrompt: "s", prompt: "p",
      profile: { model: "m", maxTurns: 10, subagents: false }, token: "tok",
    };
    expect(parseFrame(encodeFrame(minimal))).toEqual(minimal);
  });

  it("turn.start 의 필수 필드가 빠지거나 프로필 모양이 틀리면 null", () => {
    const base = { type: "turn.start", id: "t", userId: "u", cwd: "/w", systemPrompt: "s", prompt: "p", token: "k", profile: { model: "m", maxTurns: 1, subagents: true } };
    expect(parseFrame(JSON.stringify({ ...base, token: undefined }))).toBeNull();
    expect(parseFrame(JSON.stringify({ ...base, cwd: 3 }))).toBeNull();
    expect(parseFrame(JSON.stringify({ ...base, profile: { model: "m", subagents: true } }))).toBeNull();
    expect(parseFrame(JSON.stringify({ ...base, profile: { model: "m", maxTurns: "30", subagents: true } }))).toBeNull();
    expect(parseFrame(JSON.stringify({ ...base, profile: "opus" }))).toBeNull();
  });

  it("turn.event 는 event 가 객체여야 하고, turn.result 는 ok 가 boolean·text 가 문자열이어야 한다", () => {
    expect(parseFrame(JSON.stringify({ type: "turn.event", id: "t", event: "tool" }))).toBeNull();
    expect(parseFrame(JSON.stringify({ type: "turn.result", id: "t", ok: "yes", text: "" }))).toBeNull();
    expect(parseFrame(JSON.stringify({ type: "turn.result", id: "t", ok: true }))).toBeNull();
    expect(parseFrame(JSON.stringify({ type: "turn.cancel" }))).toBeNull();
  });

  it("hello 의 mode 는 선택이고 tools/harness 만 받는다 — 다른 값은 mode 없는 hello 로 통과시킨다(연결을 막지 않는다)", () => {
    const h: Frame = { type: "hello", token: "t", workerId: "w", roots: ["/a"], mode: "harness" };
    expect(parseFrame(encodeFrame(h))).toEqual(h);
    expect(parseFrame(JSON.stringify({ type: "hello", token: "t", workerId: "w", roots: ["/a"], mode: "weird" })))
      .toEqual({ type: "hello", token: "t", workerId: "w", roots: ["/a"] });
  });
});
