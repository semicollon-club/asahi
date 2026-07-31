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
