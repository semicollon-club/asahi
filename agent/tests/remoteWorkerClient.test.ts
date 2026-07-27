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
    const c = startWorkerClient({ connect: () => s.sock, token: "t", workerId: "owner", roots: ["/w"], executors });
    s.open();
    expect(s.sent[0]).toEqual({ type: "hello", token: "t", workerId: "owner", roots: ["/w"] });
    c.stop();
  });

  it("call 을 받으면 실행기를 돌리고 같은 id 로 result 를 보낸다", async () => {
    const s = fakeSocket();
    const c = startWorkerClient({ connect: () => s.sock, token: "t", workerId: "owner", roots: ["/w"], executors });
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
    const c = startWorkerClient({ connect: () => s.sock, token: "t", workerId: "owner", roots: ["/w"], executors });
    s.open();
    s.recv({ type: "call", id: "8", tool: "없는도구", args: {} });
    await vi.waitFor(() => expect(s.sent.some((f) => f.type === "result")).toBe(true));
    expect(s.sent.find((f) => f.type === "result")).toMatchObject({ id: "8", ok: false });
    c.stop();
  });

  it("실행기가 예외를 던져도 result 로 실패를 돌려준다(프로세스가 죽지 않는다)", async () => {
    const s = fakeSocket();
    const c = startWorkerClient({ connect: () => s.sock, token: "t", workerId: "owner", roots: ["/w"], executors });
    s.open();
    s.recv({ type: "call", id: "9", tool: "boom", args: {} });
    await vi.waitFor(() => expect(s.sent.some((f) => f.type === "result")).toBe(true));
    expect(s.sent.find((f) => f.type === "result")).toMatchObject({ id: "9", ok: false });
    c.stop();
  });

  it("denied 를 받으면 재연결하지 않는다", async () => {
    const connect = vi.fn(() => fakeSocket().sock);
    const c = startWorkerClient({ connect, token: "t", workerId: "owner", roots: ["/w"], executors, retryDelayMs: 5 });
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
    const c = startWorkerClient({ connect, token: "t", workerId: "owner", roots: ["/w"], executors, retryDelayMs: 5 });
    sockets[0].open();
    sockets[0].drop();
    await vi.waitFor(() => expect(sockets.length).toBeGreaterThan(1));
    c.stop();
  });

  it("stop 후에는 재연결하지 않는다", async () => {
    const sockets: ReturnType<typeof fakeSocket>[] = [];
    const connect = () => { const s = fakeSocket(); sockets.push(s); return s.sock; };
    const c = startWorkerClient({ connect, token: "t", workerId: "owner", roots: ["/w"], executors, retryDelayMs: 5 });
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
      connect: () => s.sock, token: "t", workerId: "owner", roots: ["/w"], executors: syncThrowExecutors,
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
      connect: () => s.sock, token: "t", workerId: "owner", roots: ["/w"], executors,
      onStatus: (m) => statuses.push(m),
    });
    s.open();
    s.sock.send = () => { throw new Error("이미 닫힌 소켓"); };
    expect(() => s.recv({ type: "call", id: "11", tool: "fs_read", args: { path: "/w/a.txt" } })).not.toThrow();
    await vi.waitFor(() => expect(statuses.some((m) => m.includes("result 전송 실패"))).toBe(true));
    c.stop();
  });

  // 아래부터는 리뷰에서 지적된 회귀 테스트다: denied·stop() 이후에도 이미 도착했거나 진행 중이던
  // 프레임/실행이 마치 아무 일도 없었던 것처럼 계속 처리되던 구멍을 잡는다. onClose 가 이미 쓰던
  // "if (current !== socket) return;" 가드를 onOpen·onMessage(그리고 실행기 완료 시점)에도
  // 똑같이 적용해야 막힌다.

  it("denied 이후 같은 소켓으로 도착한 call 은 실행기를 돌리지 않고 result 도 보내지 않는다", async () => {
    const s = fakeSocket();
    const execFn = vi.fn(async () => ({ ok: true, content: "실행됨" }));
    const deniedExecutors: Executors = { fs_read: execFn };
    const c = startWorkerClient({
      connect: () => s.sock, token: "t", workerId: "owner", roots: ["/w"], executors: deniedExecutors,
    });
    s.open();
    s.recv({ type: "denied", reason: "테스트 거부" });
    // 허브가 denied 를 보낸 직후 소켓을 닫기 전에 call 이 같은 소켓으로 더 도착하는 경우를 흉내낸다.
    s.recv({ type: "call", id: "20", tool: "fs_read", args: { path: "/w/a.txt" } });
    await new Promise((r) => setTimeout(r, 40));
    expect(execFn).not.toHaveBeenCalled();
    expect(s.sent.some((f) => f.type === "result")).toBe(false);
    c.stop();
  });

  it("stop 이후 open 이 뒤늦게 발생해도 hello 를 보내지 않는다", () => {
    const s = fakeSocket();
    const c = startWorkerClient({ connect: () => s.sock, token: "t", workerId: "owner", roots: ["/w"], executors });
    // 아직 실제 소켓의 open 이벤트가 오기 전에 stop() 이 먼저 호출된 뒤, 뒤늦게 open 이 발생하는
    // 경우를 흉내낸다 — 인증 토큰이 담긴 hello 가 나가면 안 된다.
    c.stop();
    s.open();
    expect(s.sent.some((f) => f.type === "hello")).toBe(false);
  });

  it("stop 이후 도착한 call 은 실행기를 돌리지 않는다", async () => {
    const s = fakeSocket();
    const execFn = vi.fn(async () => ({ ok: true, content: "실행됨" }));
    const stoppedExecutors: Executors = { fs_read: execFn };
    const c = startWorkerClient({
      connect: () => s.sock, token: "t", workerId: "owner", roots: ["/w"], executors: stoppedExecutors,
    });
    s.open();
    c.stop();
    s.recv({ type: "call", id: "21", tool: "fs_read", args: { path: "/w/a.txt" } });
    await new Promise((r) => setTimeout(r, 40));
    expect(execFn).not.toHaveBeenCalled();
    expect(s.sent.some((f) => f.type === "result")).toBe(false);
  });

  it("실행 중이던 실행기가 stop 이후에 끝나도 result 를 보내지 않는다", async () => {
    const s = fakeSocket();
    let resolveExec: ((r: { ok: boolean; content: string }) => void) | undefined;
    const slowExecutors: Executors = {
      slow: () =>
        new Promise<{ ok: boolean; content: string }>((resolve) => {
          resolveExec = resolve;
        }),
    };
    const c = startWorkerClient({
      connect: () => s.sock, token: "t", workerId: "owner", roots: ["/w"], executors: slowExecutors,
    });
    s.open();
    s.recv({ type: "call", id: "22", tool: "slow", args: {} });
    // 실행기가 아직 끝나지 않은 채로(mid-flight) stop() 이 호출된 뒤에야 실행이 끝나는 경우.
    c.stop();
    resolveExec?.({ ok: true, content: "완료" });
    await new Promise((r) => setTimeout(r, 40));
    expect(s.sent.some((f) => f.type === "result")).toBe(false);
  });

  it("hello·pong 전송이 던져도 죽지 않고 클라이언트는 계속 쓸 수 있다", async () => {
    const s = fakeSocket();
    const statuses: string[] = [];
    s.sock.send = () => { throw new Error("연결 끊김"); };
    const c = startWorkerClient({
      connect: () => s.sock, token: "t", workerId: "owner", roots: ["/w"], executors,
      onStatus: (m) => statuses.push(m),
    });
    expect(() => s.open()).not.toThrow();
    await vi.waitFor(() => expect(statuses.some((m) => m.includes("hello 전송 실패"))).toBe(true));

    expect(() => s.recv({ type: "ping" })).not.toThrow();
    await vi.waitFor(() => expect(statuses.some((m) => m.includes("pong 전송 실패"))).toBe(true));

    // send 를 정상으로 되돌리면 클라이언트가 여전히 정상 동작하는지 확인한다(죽지 않고 재사용 가능).
    s.sock.send = (d) => { const f = parseFrame(d); if (f) s.sent.push(f); };
    s.recv({ type: "call", id: "23", tool: "fs_read", args: { path: "/w/a.txt" } });
    await vi.waitFor(() => expect(s.sent.some((f) => f.type === "result")).toBe(true));
    expect(s.sent.find((f) => f.type === "result")).toMatchObject({ id: "23", ok: true });

    c.stop();
  });
});
