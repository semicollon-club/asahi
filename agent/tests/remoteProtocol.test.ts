import { describe, it, expect } from "vitest";
import { encodeFrame, parseFrame, type Frame } from "../src/remote/protocol.js";

describe("프레임 직렬화", () => {
  it("7종 프레임을 인코딩·파싱해도 값이 보존된다", () => {
    const frames: Frame[] = [
      { type: "hello", token: "t", userId: "u", roots: ["/a", "/b"] },
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
    expect(parseFrame(JSON.stringify({ type: "hello", token: "t", userId: "u" }))).toBeNull();
    expect(parseFrame(JSON.stringify({ type: "hello", token: 1, userId: "u", roots: [] }))).toBeNull();
    expect(parseFrame(JSON.stringify({ type: "call", id: "1", tool: "fs_read" }))).toBeNull();
    expect(parseFrame(JSON.stringify({ type: "result", id: "1", ok: "yes", content: "" }))).toBeNull();
  });

  it("roots 배열에 문자열이 아닌 값이 섞이면 null", () => {
    expect(parseFrame(JSON.stringify({ type: "hello", token: "t", userId: "u", roots: ["/a", 3] }))).toBeNull();
  });
});
