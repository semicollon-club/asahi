import { describe, it, expect, beforeEach } from "vitest";
import { WorkerHub, type HubSocket } from "../src/remote/hub.js";
import { encodeFrame, parseFrame, type Frame } from "../src/remote/protocol.js";

function fakeSocket() {
  const sent: Frame[] = [];
  let onMsg: (raw: string) => void = () => {};
  let onCls: () => void = () => {};
  let closed = false;
  const sock: HubSocket = {
    send: (d) => { const f = parseFrame(d); if (f) sent.push(f); },
    close: () => { closed = true; onCls(); },
    onMessage: (cb) => { onMsg = cb; },
    onClose: (cb) => { onCls = cb; },
  };
  return {
    sock, sent,
    get closed() { return closed; },
    recv: (f: Frame) => onMsg(encodeFrame(f)),
    recvRaw: (raw: string) => onMsg(raw),
  };
}

describe("WorkerHub — 인증", () => {
  let hub: WorkerHub;
  beforeEach(() => { hub = new WorkerHub({ token: "good", ownerId: "owner" }); });

  it("올바른 토큰과 소유자 ID 면 ready 를 보내고 연결로 등록한다", () => {
    const s = fakeSocket();
    hub.handleConnection(s.sock);
    s.recv({ type: "hello", token: "good", userId: "owner", roots: ["/w"] });
    expect(s.sent[0]).toEqual({ type: "ready" });
    expect(hub.isConnected("owner")).toBe(true);
    expect(hub.rootsOf("owner")).toEqual(["/w"]);
  });

  it("토큰이 틀리면 denied 후 연결을 끊고 등록하지 않는다", () => {
    const s = fakeSocket();
    hub.handleConnection(s.sock);
    s.recv({ type: "hello", token: "bad", userId: "owner", roots: ["/w"] });
    expect(s.sent[0]?.type).toBe("denied");
    expect(s.closed).toBe(true);
    expect(hub.isConnected("owner")).toBe(false);
  });

  it("소유자가 아닌 userId 는 거부한다(1단계는 소유자 워커 하나)", () => {
    const s = fakeSocket();
    hub.handleConnection(s.sock);
    s.recv({ type: "hello", token: "good", userId: "guest", roots: ["/w"] });
    expect(s.sent[0]?.type).toBe("denied");
    expect(hub.isConnected("guest")).toBe(false);
  });

  it("hello 없이 다른 프레임을 먼저 보내면 끊는다", () => {
    const s = fakeSocket();
    hub.handleConnection(s.sock);
    s.recv({ type: "result", id: "1", ok: true, content: "x" });
    expect(s.closed).toBe(true);
  });

  it("형식이 깨진 프레임은 끊는다", () => {
    const s = fakeSocket();
    hub.handleConnection(s.sock);
    s.recvRaw("{{{");
    expect(s.closed).toBe(true);
  });
});

describe("WorkerHub — 도구 호출", () => {
  let hub: WorkerHub;
  let s: ReturnType<typeof fakeSocket>;
  beforeEach(() => {
    hub = new WorkerHub({ token: "good", ownerId: "owner", callTimeoutMs: 300 });
    s = fakeSocket();
    hub.handleConnection(s.sock);
    s.recv({ type: "hello", token: "good", userId: "owner", roots: ["/w"] });
  });

  it("call 프레임을 보내고 같은 id 의 result 로 응답한다", async () => {
    const p = hub.call("owner", "fs_read", { path: "/w/a.txt" });
    const sentCall = s.sent.find((f) => f.type === "call");
    expect(sentCall).toBeTruthy();
    if (sentCall?.type !== "call") throw new Error("call 프레임 없음");
    expect(sentCall.tool).toBe("fs_read");
    s.recv({ type: "result", id: sentCall.id, ok: true, content: "본문" });
    await expect(p).resolves.toEqual({ ok: true, content: "본문" });
  });

  it("연결이 없으면 즉시 실패를 돌려준다(예외를 던지지 않는다)", async () => {
    await expect(hub.call("nobody", "fs_read", {})).resolves.toMatchObject({ ok: false });
  });

  it("타임아웃되면 실패를 돌려준다", async () => {
    await expect(hub.call("owner", "sh_exec", { command: "x" })).resolves.toMatchObject({ ok: false });
  });

  it("연결이 끊기면 대기 중이던 호출이 전부 실패로 정리된다", async () => {
    const p = hub.call("owner", "fs_read", { path: "/w/a.txt" });
    s.sock.close();
    await expect(p).resolves.toMatchObject({ ok: false });
    expect(hub.isConnected("owner")).toBe(false);
  });

  it("모르는 id 의 result 가 와도 죽지 않는다", () => {
    expect(() => s.recv({ type: "result", id: "없는id", ok: true, content: "x" })).not.toThrow();
  });
});
