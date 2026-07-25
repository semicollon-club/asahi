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

  // ── FIX5: denied 사유가 토큰 정오와 신원 정오를 구분하면, 인증되지 않은 클라이언트가 그
  // 응답만으로 "토큰이 유효한지"를 신원과 무관하게 확인할 수 있는 오라클이 된다. ────────────
  it("토큰이 틀린 경우와, 토큰은 맞지만 신원이 다른 경우가 완전히 같은 거부 사유를 돌려준다(FIX5 — 인증 오라클 방지)", () => {
    const wrongToken = fakeSocket();
    hub.handleConnection(wrongToken.sock);
    wrongToken.recv({ type: "hello", token: "bad", userId: "owner", roots: ["/w"] });
    const wrongTokenFrame = wrongToken.sent[0];

    const wrongIdentity = fakeSocket();
    hub.handleConnection(wrongIdentity.sock);
    wrongIdentity.recv({ type: "hello", token: "good", userId: "guest", roots: ["/w"] });
    const wrongIdentityFrame = wrongIdentity.sent[0];

    expect(wrongTokenFrame?.type).toBe("denied");
    expect(wrongIdentityFrame?.type).toBe("denied");
    if (wrongTokenFrame?.type !== "denied" || wrongIdentityFrame?.type !== "denied") throw new Error("denied 프레임 아님");
    expect(wrongTokenFrame.reason).toBe(wrongIdentityFrame.reason);
  });

  it("토큰 길이가 서로 다르게 틀려도 예외 없이 거부한다(상수 시간 비교의 길이 불일치 경로)", () => {
    const s = fakeSocket();
    hub.handleConnection(s.sock);
    // hub 의 token("good", 4자)과 길이가 다른 훨씬 긴 문자열 — timingSafeEqual 은 길이가 다른
    // 버퍼를 그냥 넘기면 예외를 던지므로, 그 경우를 hub 내부에서 미리 처리하지 않으면 여기서
    // 예외가 튀어 소켓 처리 전체가 죽는다.
    expect(() => s.recv({ type: "hello", token: "x".repeat(50), userId: "owner", roots: ["/w"] })).not.toThrow();
    expect(s.sent[0]?.type).toBe("denied");
    expect(hub.isConnected("owner")).toBe(false);
  });

  it("빈 문자열 토큰으로는 절대 인증되지 않는다(설정된 토큰이 비어 있는 방어적인 경우 대비 — FIX2)", () => {
    const emptyTokenHub = new WorkerHub({ token: "", ownerId: "owner" });
    const s = fakeSocket();
    emptyTokenHub.handleConnection(s.sock);
    s.recv({ type: "hello", token: "", userId: "owner", roots: ["/w"] });
    expect(s.sent[0]?.type).toBe("denied");
    expect(s.closed).toBe(true);
    expect(emptyTokenHub.isConnected("owner")).toBe(false);
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

  it("이미 인증된 연결에 두 번째 hello 가 와도 무시한다(재등록·roots 변경·ready 재전송 없음, 다른 userId 로도 탈취되지 않음)", () => {
    const s = fakeSocket();
    hub.handleConnection(s.sock);
    s.recv({ type: "hello", token: "good", userId: "owner", roots: ["/w"] });
    expect(s.sent).toHaveLength(1); // ready 하나만 보낸 상태

    // 같은 연결로 두 번째 hello — 심지어 다른 userId 로 탈취를 시도해도 무시되어야 한다.
    s.recv({ type: "hello", token: "good", userId: "intruder", roots: ["/evil"] });

    expect(s.sent).toHaveLength(1); // ready 를 다시 보내지 않는다
    expect(hub.isConnected("owner")).toBe(true); // 기존 등록 유지
    expect(hub.isConnected("intruder")).toBe(false); // 탈취 실패
    expect(hub.rootsOf("owner")).toEqual(["/w"]); // roots 변경 없음
    expect(s.closed).toBe(false); // 연결은 계속 열려 있다

    // 연결이 여전히 정상 동작하는지 ping/pong 으로 확인한다.
    s.recv({ type: "ping" });
    expect(s.sent[s.sent.length - 1]).toEqual({ type: "pong" });
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

  it("같은 id 의 result 가 두 번 오면 한 번만 resolve 되고 두 번째는 아무 일도 하지 않는다(던지지 않는다)", async () => {
    const p = hub.call("owner", "fs_read", { path: "/w/a.txt" });
    const sentCall = s.sent.find((f) => f.type === "call");
    if (sentCall?.type !== "call") throw new Error("call 프레임 없음");

    s.recv({ type: "result", id: sentCall.id, ok: true, content: "첫번째" });
    expect(() => s.recv({ type: "result", id: sentCall.id, ok: false, content: "두번째" })).not.toThrow();

    // 첫 번째 result 의 내용으로만 resolve 되어야 한다 — 두 번째는 완전히 무시된다.
    await expect(p).resolves.toEqual({ ok: true, content: "첫번째" });
  });

  it("call 의 args 에 __proto__ 키가 있어도 Object.prototype 을 오염시키지 않고 가공 없이 그대로 전달한다", async () => {
    // 객체 리터럴이 아니라 JSON.parse 로 만들어야 진짜 소유(own) 프로퍼티 "__proto__" 가 생긴다
    // (리터럴 { __proto__: ... } 문법은 새 객체의 프로토타입을 지정하는 특수 취급을 받아 재현이 안 된다).
    const args = JSON.parse('{"__proto__":{"polluted":true},"path":"/w/a.txt"}') as Record<string, unknown>;

    const p = hub.call("owner", "fs_read", args);

    // 전역 Object.prototype 은 절대 오염되면 안 된다.
    expect((Object.prototype as Record<string, unknown>).polluted).toBeUndefined();
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();

    // hub 는 args 를 merge·spread·Object.assign 하지 않고 그대로 넘겨야 하므로,
    // socket.send 로 나간 프레임에도 __proto__ 키가 사라지거나 값이 바뀌지 않고 그대로 남아야 한다.
    const sentCall = s.sent.find((f) => f.type === "call");
    if (sentCall?.type !== "call") throw new Error("call 프레임 없음");
    expect(Object.prototype.hasOwnProperty.call(sentCall.args, "__proto__")).toBe(true);
    expect(Object.getOwnPropertyDescriptor(sentCall.args, "__proto__")?.value).toEqual({ polluted: true });

    // 타이머가 남지 않도록 정리한다.
    s.recv({ type: "result", id: sentCall.id, ok: true, content: "ok" });
    await expect(p).resolves.toEqual({ ok: true, content: "ok" });
  });

  it("socket.send 가 동기적으로 던지면 call() 은 reject 하지 않고 ok:false 로 resolve 한다", async () => {
    // fakeSocket 을 재사용하되, 이 테스트에서만 send 가 던지도록 덮어쓴다(두 번째 헬퍼를 새로 만들지 않는다).
    s.sock.send = () => { throw new Error("두번째 send 부터 강제 실패"); };

    await expect(hub.call("owner", "fs_read", { path: "/w/a.txt" })).resolves.toMatchObject({ ok: false });
  });
});

describe("WorkerHub — 재연결(동일 userId 두 연결)", () => {
  let hub: WorkerHub;
  beforeEach(() => { hub = new WorkerHub({ token: "good", ownerId: "owner", callTimeoutMs: 300 }); });

  it("같은 userId 로 두 번째 연결이 오면 첫 번째를 밀어내고, 첫 연결의 대기 중 호출은 ok:false 로 정리되며, 이후 호출은 새 소켓으로만 간다", async () => {
    const s1 = fakeSocket();
    hub.handleConnection(s1.sock);
    s1.recv({ type: "hello", token: "good", userId: "owner", roots: ["/w"] });

    const p1 = hub.call("owner", "fs_read", { path: "/w/a.txt" });

    const s2 = fakeSocket();
    hub.handleConnection(s2.sock);
    s2.recv({ type: "hello", token: "good", userId: "owner", roots: ["/w2"] });

    // 첫 번째 소켓은 닫히고, 그 연결에 대기 중이던 호출은 orphan 되지 않고 실패로 정리된다.
    expect(s1.closed).toBe(true);
    await expect(p1).resolves.toMatchObject({ ok: false });

    // 등록 정보가 새 연결로 교체되어 있어야 한다.
    expect(hub.isConnected("owner")).toBe(true);
    expect(hub.rootsOf("owner")).toEqual(["/w2"]);

    // 이후 호출은 새 소켓(s2)에만 전달되고, 이미 닫힌 s1 에는 더 이상 전달되지 않는다.
    const s1CallCountBefore = s1.sent.filter((f) => f.type === "call").length;
    const p2 = hub.call("owner", "fs_read", { path: "/w2/b.txt" });
    expect(s2.sent.some((f) => f.type === "call")).toBe(true);
    expect(s1.sent.filter((f) => f.type === "call").length).toBe(s1CallCountBefore);

    // 정리: 두 번째 호출에도 응답해 타이머를 남기지 않는다.
    const sentCall2 = s2.sent.find((f) => f.type === "call");
    if (sentCall2?.type !== "call") throw new Error("call 프레임 없음");
    s2.recv({ type: "result", id: sentCall2.id, ok: true, content: "ok" });
    await expect(p2).resolves.toEqual({ ok: true, content: "ok" });
  });
});

// ── FIX3: 인증 전(hello 대기) 소켓은 hub.conns 에 없어 원래 closeAll() 의 대상이 아니었다 —
// 아무 말도 안 하는 연결 하나가 서버 종료 때 httpServer.close() 콜백을 영원히 막았다. ─────────
describe("WorkerHub — 인증 전 소켓의 수명(FIX3)", () => {
  it("연결만 하고 hello 를 안 보내면 hello 타임아웃이 지난 뒤 스스로 닫힌다", async () => {
    const hub = new WorkerHub({ token: "good", ownerId: "owner", helloTimeoutMs: 30 });
    const s = fakeSocket();
    hub.handleConnection(s.sock);
    expect(s.closed).toBe(false);

    await new Promise((resolve) => setTimeout(resolve, 80));

    expect(s.closed).toBe(true);
  });

  it("hello 를 시간 안에 보내 인증에 성공하면, 그 뒤 hello 타임아웃 시각이 지나도 끊기지 않는다(오탐 방지)", async () => {
    const hub = new WorkerHub({ token: "good", ownerId: "owner", helloTimeoutMs: 30 });
    const s = fakeSocket();
    hub.handleConnection(s.sock);
    s.recv({ type: "hello", token: "good", userId: "owner", roots: ["/w"] });
    expect(hub.isConnected("owner")).toBe(true);

    await new Promise((resolve) => setTimeout(resolve, 80));

    expect(s.closed).toBe(false);
    expect(hub.isConnected("owner")).toBe(true);
  });

  it("closeAll() 은 아직 인증되지 않은(hello 를 안 보낸) 소켓도 닫는다", () => {
    const hub = new WorkerHub({ token: "good", ownerId: "owner" });
    const silent = fakeSocket();
    hub.handleConnection(silent.sock);
    expect(silent.closed).toBe(false);

    hub.closeAll();

    expect(silent.closed).toBe(true);
  });

  it("closeAll() 은 인증 전 소켓과 인증된 소켓을 함께 닫는다", async () => {
    const hub = new WorkerHub({ token: "good", ownerId: "owner", callTimeoutMs: 300 });
    const authed = fakeSocket();
    hub.handleConnection(authed.sock);
    authed.recv({ type: "hello", token: "good", userId: "owner", roots: ["/w"] });
    const silent = fakeSocket();
    hub.handleConnection(silent.sock);

    hub.closeAll();

    expect(authed.closed).toBe(true);
    expect(silent.closed).toBe(true);
    expect(hub.isConnected("owner")).toBe(false);
  });
});
