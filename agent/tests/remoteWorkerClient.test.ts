import { describe, it, expect, vi } from "vitest";
import { startWorkerClient, type ClientSocket } from "../src/remote/workerClient.js";
import { encodeFrame, parseFrame, type Frame } from "../src/remote/protocol.js";
import type { Executors } from "../src/remote/executors.js";

function fakeSocket() {
  const sent: Frame[] = [];
  let onMsg: (raw: string) => void = () => {};
  let onCls: () => void = () => {};
  let onOpn: () => void = () => {};
  const sock: ClientSocket = {
    send: (d) => { const f = parseFrame(d); if (f) sent.push(f); },
    close: () => onCls(),
    onMessage: (cb) => { onMsg = cb; },
    onClose: (cb) => { onCls = cb; },
    onOpen: (cb) => { onOpn = cb; },
  };
  return { sock, sent, open: () => onOpn(), recv: (f: Frame) => onMsg(encodeFrame(f)), drop: () => onCls() };
}

const executors: Executors = {
  fs_read: async (args) => ({ ok: true, content: `읽음:${String(args.path)}` }),
  boom: async () => { throw new Error("터짐"); },
};

describe("워커 클라이언트", () => {
  it("연결되면 hello 를 먼저 보낸다", () => {
    const s = fakeSocket();
    const c = startWorkerClient({ connect: () => s.sock, token: "t", userId: "owner", roots: ["/w"], executors });
    s.open();
    expect(s.sent[0]).toEqual({ type: "hello", token: "t", userId: "owner", roots: ["/w"] });
    c.stop();
  });

  it("call 을 받으면 실행기를 돌리고 같은 id 로 result 를 보낸다", async () => {
    const s = fakeSocket();
    const c = startWorkerClient({ connect: () => s.sock, token: "t", userId: "owner", roots: ["/w"], executors });
    s.open();
    s.recv({ type: "ready" });
    s.recv({ type: "call", id: "7", tool: "fs_read", args: { path: "/w/a.txt" } });
    await vi.waitFor(() => expect(s.sent.some((f) => f.type === "result")).toBe(true));
    const r = s.sent.find((f) => f.type === "result");
    expect(r).toEqual({ type: "result", id: "7", ok: true, content: "읽음:/w/a.txt" });
    c.stop();
  });

  it("모르는 도구는 ok=false 로 응답한다", async () => {
    const s = fakeSocket();
    const c = startWorkerClient({ connect: () => s.sock, token: "t", userId: "owner", roots: ["/w"], executors });
    s.open();
    s.recv({ type: "call", id: "8", tool: "없는도구", args: {} });
    await vi.waitFor(() => expect(s.sent.some((f) => f.type === "result")).toBe(true));
    expect(s.sent.find((f) => f.type === "result")).toMatchObject({ id: "8", ok: false });
    c.stop();
  });

  it("실행기가 예외를 던져도 result 로 실패를 돌려준다(프로세스가 죽지 않는다)", async () => {
    const s = fakeSocket();
    const c = startWorkerClient({ connect: () => s.sock, token: "t", userId: "owner", roots: ["/w"], executors });
    s.open();
    s.recv({ type: "call", id: "9", tool: "boom", args: {} });
    await vi.waitFor(() => expect(s.sent.some((f) => f.type === "result")).toBe(true));
    expect(s.sent.find((f) => f.type === "result")).toMatchObject({ id: "9", ok: false });
    c.stop();
  });

  it("denied 를 받으면 재연결하지 않는다", async () => {
    const connect = vi.fn(() => fakeSocket().sock);
    const c = startWorkerClient({ connect, token: "t", userId: "owner", roots: ["/w"], executors, retryDelayMs: 5 });
    const first = connect.mock.results[0].value as ClientSocket;
    let onMsg: ((raw: string) => void) | undefined;
    first.onMessage = (cb) => { onMsg = cb; };
    c.stop();
    expect(connect).toHaveBeenCalledTimes(1);
    expect(onMsg).toBeUndefined();
  });

  it("연결이 끊기면 재연결을 시도한다", async () => {
    const sockets: ReturnType<typeof fakeSocket>[] = [];
    const connect = () => { const s = fakeSocket(); sockets.push(s); return s.sock; };
    const c = startWorkerClient({ connect, token: "t", userId: "owner", roots: ["/w"], executors, retryDelayMs: 5 });
    sockets[0].open();
    sockets[0].drop();
    await vi.waitFor(() => expect(sockets.length).toBeGreaterThan(1));
    c.stop();
  });

  it("stop 후에는 재연결하지 않는다", async () => {
    const sockets: ReturnType<typeof fakeSocket>[] = [];
    const connect = () => { const s = fakeSocket(); sockets.push(s); return s.sock; };
    const c = startWorkerClient({ connect, token: "t", userId: "owner", roots: ["/w"], executors, retryDelayMs: 5 });
    sockets[0].open();
    c.stop();
    sockets[0].drop();
    await new Promise((r) => setTimeout(r, 40));
    expect(sockets.length).toBe(1);
  });

  // 아래 두 테스트는 브리프에 없던 추가 회귀 테스트다(자가 리뷰 중 발견). remoteHub.test.ts 의
  // "socket.send 가 동기적으로 던지면 call() 은 reject 하지 않고 ok:false 로 resolve 한다" 와
  // 대칭되는 상황을 워커 쪽에서도 검증한다 — 실행기가 프로미스가 아니라 즉시 던지는 경우와,
  // 결과를 보내는 순간 소켓이 이미 닫혀 send 가 던지는 경우 둘 다 프로세스를 죽이면 안 된다.
  it("실행기가 프로미스가 아니라 즉시(동기적으로) 예외를 던져도 result 로 실패를 돌려준다(프로세스가 죽지 않는다)", async () => {
    const s = fakeSocket();
    const syncThrowExecutors: Executors = {
      syncBoom: () => { throw new Error("동기 터짐"); },
    };
    const c = startWorkerClient({
      connect: () => s.sock, token: "t", userId: "owner", roots: ["/w"], executors: syncThrowExecutors,
    });
    s.open();
    expect(() => s.recv({ type: "call", id: "10", tool: "syncBoom", args: {} })).not.toThrow();
    await vi.waitFor(() => expect(s.sent.some((f) => f.type === "result")).toBe(true));
    expect(s.sent.find((f) => f.type === "result")).toMatchObject({ id: "10", ok: false });
    c.stop();
  });

  it("result 를 보내는 시점에 소켓이 이미 닫혀 send 가 던져도 죽지 않는다(허브는 callTimeoutMs 로 정리한다)", async () => {
    const s = fakeSocket();
    const statuses: string[] = [];
    const c = startWorkerClient({
      connect: () => s.sock, token: "t", userId: "owner", roots: ["/w"], executors,
      onStatus: (m) => statuses.push(m),
    });
    s.open();
    s.sock.send = () => { throw new Error("이미 닫힌 소켓"); };
    expect(() => s.recv({ type: "call", id: "11", tool: "fs_read", args: { path: "/w/a.txt" } })).not.toThrow();
    await vi.waitFor(() => expect(statuses.some((m) => m.includes("result 전송 실패"))).toBe(true));
    c.stop();
  });
});
