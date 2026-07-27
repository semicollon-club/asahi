import { describe, it, expect, beforeEach } from "vitest";
import { WorkerHub, type HubSocket } from "../src/remote/hub.js";
import { encodeFrame, parseFrame, type Frame } from "../src/remote/protocol.js";
import { hashWorkerToken } from "../src/store/workersRepo.js";

// asyncClose(리뷰 지적 M5·I1b): 기본 가짜는 close() 가 그 자리에서 onClose 를 불러 "닫으면
// 즉시 닫힌다"고 가정한다. 실제 ws 는 그렇지 않다 — close() 는 닫아 달라는 요청일 뿐이고
// (readyState=CLOSING) 'close' 이벤트는 상대가 응답해야 오며 최대 30초까지 걸린다. 그 사이
// 상대는 계속 프레임을 보낼 수 있다. 그래서 "닫았으니 정리됐겠지" 를 단정하는 테스트는
// 기본 가짜로는 가짜의 동작을 검증하게 된다. 닫힘 경쟁을 다루는 테스트만 이 모드를 쓴다.
function fakeSocket(opts: { asyncClose?: boolean } = {}) {
  const sent: Frame[] = [];
  let onMsg: (raw: string) => void = () => {};
  let onCls: () => void = () => {};
  let closed = false;
  const sock: HubSocket = {
    send: (d) => { const f = parseFrame(d); if (f) sent.push(f); },
    close: () => {
      if (closed) return;
      closed = true;
      if (!opts.asyncClose) onCls();
    },
    onMessage: (cb) => { onMsg = cb; },
    onClose: (cb) => { onCls = cb; },
  };
  return {
    sock, sent,
    get closed() { return closed; },
    recv: (f: Frame) => onMsg(encodeFrame(f)),
    recvRaw: (raw: string) => onMsg(raw),
    // asyncClose 모드에서 상대가 실제로 연결을 끊은 시점을 테스트가 직접 정한다.
    fireClose: () => onCls(),
  };
}

// 인증이 레지스트리 조회(await)를 거치면서 비동기가 됐다. hello 를 보낸 뒤 그 결과에 의존하는
// 단정 전에는 마이크로태스크 큐를 비워야 한다 — setTimeout(0) 은 매크로태스크라, 그 전에 쌓인
// 프로미스 체인(authenticate 내부의 await 들)이 먼저 전부 실행됨을 보장한다.
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

// 가짜 레지스트리. 실제 DB 없이 허브의 인증 판정만 검증한다.
function fakeRegistry(rows: Record<string, string>) {
  const seen: Array<{ id: string; ts: number }> = [];
  return {
    seen,
    getById: async (id: string) => (rows[id] ? { tokenHash: rows[id] } : null),
    touchLastSeen: async (id: string, ts: number) => { seen.push({ id, ts }); },
  };
}

describe("WorkerHub — 인증", () => {
  let hub: WorkerHub;
  beforeEach(() => { hub = new WorkerHub({ registry: fakeRegistry({ owner: hashWorkerToken("good") }) }); });

  it("올바른 토큰과 등록된 workerId 면 ready 를 보내고 연결로 등록한다", async () => {
    const s = fakeSocket();
    hub.handleConnection(s.sock);
    s.recv({ type: "hello", token: "good", workerId: "owner", roots: ["/w"] });
    await flush();
    expect(s.sent[0]).toEqual({ type: "ready" });
    expect(hub.isConnected("owner")).toBe(true);
    expect(hub.rootsOf("owner")).toEqual(["/w"]);
  });

  it("토큰이 틀리면 denied 후 연결을 끊고 등록하지 않는다", async () => {
    const s = fakeSocket();
    hub.handleConnection(s.sock);
    s.recv({ type: "hello", token: "bad", workerId: "owner", roots: ["/w"] });
    await flush();
    expect(s.sent[0]?.type).toBe("denied");
    expect(s.closed).toBe(true);
    expect(hub.isConnected("owner")).toBe(false);
  });

  it("등록되지 않은 workerId 는 거부한다", async () => {
    const s = fakeSocket();
    hub.handleConnection(s.sock);
    s.recv({ type: "hello", token: "good", workerId: "guest", roots: ["/w"] });
    await flush();
    expect(s.sent[0]?.type).toBe("denied");
    expect(hub.isConnected("guest")).toBe(false);
  });

  // ── FIX5: denied 사유가 토큰 정오와 신원(workerId 등록 여부) 정오를 구분하면, 인증되지 않은
  // 클라이언트가 그 응답만으로 "토큰이 유효한지"를 신원과 무관하게 확인할 수 있는 오라클이 된다. ──
  it("토큰이 틀린 경우와, workerId 가 등록되지 않은 경우가 완전히 같은 거부 사유를 돌려준다(FIX5 — 인증 오라클 방지)", async () => {
    const wrongToken = fakeSocket();
    hub.handleConnection(wrongToken.sock);
    wrongToken.recv({ type: "hello", token: "bad", workerId: "owner", roots: ["/w"] });
    await flush();
    const wrongTokenFrame = wrongToken.sent[0];

    const wrongIdentity = fakeSocket();
    hub.handleConnection(wrongIdentity.sock);
    wrongIdentity.recv({ type: "hello", token: "good", workerId: "guest", roots: ["/w"] });
    await flush();
    const wrongIdentityFrame = wrongIdentity.sent[0];

    expect(wrongTokenFrame?.type).toBe("denied");
    expect(wrongIdentityFrame?.type).toBe("denied");
    if (wrongTokenFrame?.type !== "denied" || wrongIdentityFrame?.type !== "denied") throw new Error("denied 프레임 아님");
    expect(wrongTokenFrame.reason).toBe(wrongIdentityFrame.reason);
  });

  it("토큰 길이가 서로 다르게 틀려도 예외 없이 거부한다(상수 시간 비교의 길이 불일치 경로)", async () => {
    const s = fakeSocket();
    hub.handleConnection(s.sock);
    // hub 가 등록해 둔 토큰("good")과 길이가 다른 훨씬 긴 문자열 — timingSafeEqual 은 길이가 다른
    // 버퍼를 그냥 넘기면 예외를 던지므로, 그 경우를 hub 내부에서 미리 처리하지 않으면 여기서
    // 예외가 튀어 소켓 처리 전체가 죽는다.
    expect(() => s.recv({ type: "hello", token: "x".repeat(50), workerId: "owner", roots: ["/w"] })).not.toThrow();
    await flush();
    expect(s.sent[0]?.type).toBe("denied");
    expect(hub.isConnected("owner")).toBe(false);
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

  it("이미 인증된 연결에 두 번째 hello 가 오면 재등록·roots 변경·ready 재전송 없이 연결을 끊는다(다른 workerId 로도 탈취되지 않고, 기존 연결도 함께 정리된다)", async () => {
    const s = fakeSocket();
    hub.handleConnection(s.sock);
    s.recv({ type: "hello", token: "good", workerId: "owner", roots: ["/w"] });
    await flush();
    expect(s.sent).toHaveLength(1); // ready 하나만 보낸 상태
    expect(hub.isConnected("owner")).toBe(true);

    // 같은 연결로 두 번째 hello — 심지어 다른 workerId 로 탈취를 시도해도 재등록되지 않는다.
    s.recv({ type: "hello", token: "good", workerId: "intruder", roots: ["/evil"] });

    expect(s.sent).toHaveLength(1); // ready 를 다시 보내지 않는다
    expect(hub.isConnected("intruder")).toBe(false); // 탈취 실패
    expect(s.closed).toBe(true); // 두 번째 hello 로 연결이 끊긴다(Task3: 무시가 아니라 종료)
    // 연결 자체가 끊겼으므로 onClose 정리가 돌아 기존 등록도 함께 사라진다 — "살아있는데 owner 로
    // 등록만 유지" 되는 애매한 상태가 없다.
    expect(hub.isConnected("owner")).toBe(false);
  });
});

describe("WorkerHub — 도구 호출", () => {
  let hub: WorkerHub;
  let s: ReturnType<typeof fakeSocket>;
  beforeEach(async () => {
    hub = new WorkerHub({ registry: fakeRegistry({ owner: hashWorkerToken("good") }), callTimeoutMs: 300 });
    s = fakeSocket();
    hub.handleConnection(s.sock);
    s.recv({ type: "hello", token: "good", workerId: "owner", roots: ["/w"] });
    await flush();
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

describe("WorkerHub — 재연결(동일 workerId 두 연결)", () => {
  let hub: WorkerHub;
  beforeEach(() => { hub = new WorkerHub({ registry: fakeRegistry({ owner: hashWorkerToken("good") }), callTimeoutMs: 300 }); });

  it("같은 workerId 로 두 번째 연결이 오면 첫 번째를 밀어내고, 첫 연결의 대기 중 호출은 ok:false 로 정리되며, 이후 호출은 새 소켓으로만 간다", async () => {
    const s1 = fakeSocket();
    hub.handleConnection(s1.sock);
    s1.recv({ type: "hello", token: "good", workerId: "owner", roots: ["/w"] });
    await flush();

    const p1 = hub.call("owner", "fs_read", { path: "/w/a.txt" });

    const s2 = fakeSocket();
    hub.handleConnection(s2.sock);
    s2.recv({ type: "hello", token: "good", workerId: "owner", roots: ["/w2"] });
    await flush();

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
    const hub = new WorkerHub({ registry: fakeRegistry({ owner: hashWorkerToken("good") }), helloTimeoutMs: 30 });
    const s = fakeSocket();
    hub.handleConnection(s.sock);
    expect(s.closed).toBe(false);

    await new Promise((resolve) => setTimeout(resolve, 80));

    expect(s.closed).toBe(true);
  });

  it("hello 를 시간 안에 보내 인증에 성공하면, 그 뒤 hello 타임아웃 시각이 지나도 끊기지 않는다(오탐 방지)", async () => {
    const hub = new WorkerHub({ registry: fakeRegistry({ owner: hashWorkerToken("good") }), helloTimeoutMs: 30 });
    const s = fakeSocket();
    hub.handleConnection(s.sock);
    s.recv({ type: "hello", token: "good", workerId: "owner", roots: ["/w"] });
    await flush();
    expect(hub.isConnected("owner")).toBe(true);

    await new Promise((resolve) => setTimeout(resolve, 80));

    expect(s.closed).toBe(false);
    expect(hub.isConnected("owner")).toBe(true);
  });

  it("closeAll() 은 아직 인증되지 않은(hello 를 안 보낸) 소켓도 닫는다", () => {
    const hub = new WorkerHub({ registry: fakeRegistry({ owner: hashWorkerToken("good") }) });
    const silent = fakeSocket();
    hub.handleConnection(silent.sock);
    expect(silent.closed).toBe(false);

    hub.closeAll();

    expect(silent.closed).toBe(true);
  });

  it("closeAll() 은 인증 전 소켓과 인증된 소켓을 함께 닫는다", async () => {
    const hub = new WorkerHub({ registry: fakeRegistry({ owner: hashWorkerToken("good") }), callTimeoutMs: 300 });
    const authed = fakeSocket();
    hub.handleConnection(authed.sock);
    authed.recv({ type: "hello", token: "good", workerId: "owner", roots: ["/w"] });
    await flush();
    const silent = fakeSocket();
    hub.handleConnection(silent.sock);

    hub.closeAll();

    expect(authed.closed).toBe(true);
    expect(silent.closed).toBe(true);
    expect(hub.isConnected("owner")).toBe(false);
  });
});

describe("WorkerHub — 워커 레지스트리 인증", () => {
  it("등록된 워커가 올바른 토큰으로 붙으면 ready 를 받는다", async () => {
    const registry = fakeRegistry({ "semicolon-shared": hashWorkerToken("good-token") });
    const hub = new WorkerHub({ registry, now: () => 777 });
    const s = fakeSocket();
    hub.handleConnection(s.sock);
    s.recv({ type: "hello", token: "good-token", workerId: "semicolon-shared", roots: ["/ws"] });
    await flush();

    expect(s.sent).toContainEqual({ type: "ready" });
    expect(hub.isConnected("semicolon-shared")).toBe(true);
    expect(registry.seen).toEqual([{ id: "semicolon-shared", ts: 777 }]);
  });

  it("등록되지 않은 workerId 는 거부된다", async () => {
    const hub = new WorkerHub({ registry: fakeRegistry({}) });
    const s = fakeSocket();
    hub.handleConnection(s.sock);
    s.recv({ type: "hello", token: "any", workerId: "없는워커", roots: ["/ws"] });
    await flush();

    expect(s.closed).toBe(true);
    expect(hub.isConnected("없는워커")).toBe(false);
  });

  it("토큰이 틀리면 거부된다", async () => {
    const registry = fakeRegistry({ w1: hashWorkerToken("real") });
    const hub = new WorkerHub({ registry });
    const s = fakeSocket();
    hub.handleConnection(s.sock);
    s.recv({ type: "hello", token: "fake", workerId: "w1", roots: ["/ws"] });
    await flush();

    expect(s.closed).toBe(true);
    expect(hub.isConnected("w1")).toBe(false);
  });

  it("'없는 워커'와 '틀린 토큰'의 거부 문구가 완전히 같다 — 인증 오라클 방지", async () => {
    const registry = fakeRegistry({ w1: hashWorkerToken("real") });

    const s1 = fakeSocket();
    new WorkerHub({ registry }).handleConnection(s1.sock);
    s1.recv({ type: "hello", token: "real", workerId: "없음", roots: ["/ws"] });
    await flush();

    const s2 = fakeSocket();
    new WorkerHub({ registry }).handleConnection(s2.sock);
    s2.recv({ type: "hello", token: "틀림", workerId: "w1", roots: ["/ws"] });
    await flush();

    expect(s1.sent).toEqual(s2.sent);
  });

  it("인증 조회 중(authenticating) 도착한 프레임은 처리되지 않고 연결이 끊긴다", async () => {
    // getById 를 테스트가 직접 풀어줄 때까지 붙잡아 authenticating 상태를 관찰한다.
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const registry = {
      getById: async (id: string) => { await gate; return { tokenHash: hashWorkerToken("t") }; },
      touchLastSeen: async () => {},
    };
    const hub = new WorkerHub({ registry });
    const s = fakeSocket();
    hub.handleConnection(s.sock);

    s.recv({ type: "hello", token: "t", workerId: "w1", roots: ["/ws"] });
    // 아직 조회가 안 끝난 상태에서 다음 프레임이 도착한다.
    s.recv({ type: "result", id: "1", ok: true, content: "몰래" });
    expect(s.closed).toBe(true);

    release();
    await flush();
    // 연결이 끊겼으므로 인증도 성립하지 않는다.
    expect(hub.isConnected("w1")).toBe(false);
  });

  it("hello 를 두 번 보내면 끊는다", async () => {
    const registry = fakeRegistry({ w1: hashWorkerToken("t") });
    const hub = new WorkerHub({ registry });
    const s = fakeSocket();
    hub.handleConnection(s.sock);
    s.recv({ type: "hello", token: "t", workerId: "w1", roots: ["/ws"] });
    await flush();
    s.recv({ type: "hello", token: "t", workerId: "w1", roots: ["/ws"] });
    expect(s.closed).toBe(true);
  });

  it("같은 workerId 로 재연결하면 이전 연결이 정리된다", async () => {
    const registry = fakeRegistry({ w1: hashWorkerToken("t") });
    const hub = new WorkerHub({ registry });

    const s1 = fakeSocket();
    hub.handleConnection(s1.sock);
    s1.recv({ type: "hello", token: "t", workerId: "w1", roots: ["/a"] });
    await flush();

    const s2 = fakeSocket();
    hub.handleConnection(s2.sock);
    s2.recv({ type: "hello", token: "t", workerId: "w1", roots: ["/b"] });
    await flush();

    expect(s1.closed).toBe(true);
    expect(hub.isConnected("w1")).toBe(true);
    expect(hub.rootsOf("w1")).toEqual(["/b"]);
  });
});

// 리뷰(opus, T3)가 변이 실험으로 찾은 미고정 불변식들. 아래 각 테스트는 hub.ts 에서 해당
// 검사를 지우면 반드시 빨간불이 되어야 한다 — 리뷰 시점에는 두 검사를 지워도 28개가 전부
// 통과했다.
describe("WorkerHub — 리뷰가 찾은 미고정 불변식", () => {
  it("등록되지 않은 workerId 는 빈 토큰으로도 인증되지 않는다", async () => {
    // 대조값 흉내(NOT_FOUND_HASH)가 예전엔 hashWorkerToken("") 이라, 빈 토큰이 해시 비교를
    // 통과하고 최종 판정의 row !== null 하나만이 완전 우회를 막고 있었다.
    const hub = new WorkerHub({ registry: fakeRegistry({}) });
    const s = fakeSocket();
    hub.handleConnection(s.sock);
    s.recv({ type: "hello", token: "", workerId: "공격자가고른아무id", roots: ["C:/"] });
    await flush();

    expect(hub.isConnected("공격자가고른아무id")).toBe(false);
    expect(s.sent).not.toContainEqual({ type: "ready" });
    expect(s.closed).toBe(true);
  });

  it("등록된 워커라도 빈 토큰은 거부한다", async () => {
    const hub = new WorkerHub({ registry: fakeRegistry({ w1: hashWorkerToken("real") }) });
    const s = fakeSocket();
    hub.handleConnection(s.sock);
    s.recv({ type: "hello", token: "", workerId: "w1", roots: ["/ws"] });
    await flush();

    expect(hub.isConnected("w1")).toBe(false);
  });

  it("같은 workerId 의 옛 소켓이 보낸 result 는 무시된다", async () => {
    // hub.ts 의 conn.socket !== socket 검사를 지우면 이 테스트가 빨간불이 된다.
    // 그 검사가 없으면 교체된 옛 연결이 새 연결의 대기 호출을 대신 완료시킬 수 있다.
    const registry = fakeRegistry({ w1: hashWorkerToken("t") });
    const hub = new WorkerHub({ registry });

    const s1 = fakeSocket();
    hub.handleConnection(s1.sock);
    s1.recv({ type: "hello", token: "t", workerId: "w1", roots: ["/a"] });
    await flush();

    const s2 = fakeSocket();
    hub.handleConnection(s2.sock);
    s2.recv({ type: "hello", token: "t", workerId: "w1", roots: ["/b"] });
    await flush();

    // 새 연결(s2)로 호출을 건다.
    const pending = hub.call("w1", "fs_read", { path: "/b/x" });
    // 교체된 옛 연결(s1)이 그 호출 id 로 결과를 흘려보낸다.
    s1.recv({ type: "result", id: "1", ok: true, content: "옛 소켓이 가로챈 응답" });
    await flush();

    // 옛 소켓의 응답으로 완료되면 안 된다 — 타임아웃으로 끝나야 정상이다.
    const settled = await Promise.race([pending, flush().then(() => "미완료" as const)]);
    expect(settled).toBe("미완료");
  });

  it("거부된 소켓은 다시 hello 를 보낼 수 없다(레지스트리 재조회 없음)", async () => {
    // 실제 ws 의 close() 는 즉시 닫히지 않으므로, 거부 후 상대는 계속 보낼 수 있다.
    // 시도마다 DB 왕복이면 공개 리스너에 인증 전 부하를 무제한으로 걸 수 있다.
    let lookups = 0;
    const registry = {
      getById: async (id: string) => { lookups++; return id === "w1" ? { tokenHash: hashWorkerToken("t") } : null; },
      touchLastSeen: async () => {},
    };
    const hub = new WorkerHub({ registry });
    const s = fakeSocket({ asyncClose: true });
    hub.handleConnection(s.sock);

    for (let i = 0; i < 5; i++) {
      s.recv({ type: "hello", token: "틀림", workerId: "w1", roots: ["/ws"] });
      await flush();
    }

    expect(lookups).toBe(1);
    expect(s.sent.filter((f) => f.type === "denied")).toHaveLength(1);
  });
});

describe("WorkerHub — 실제 ws 처럼 close 가 즉시 끝나지 않을 때", () => {
  it("조회 중 close() 된 소켓은 인증이 뒤늦게 성공해도 등록되지 않는다", async () => {
    // 실제 ws 재현: close() 는 CLOSING 으로만 바꾸고 'close' 이벤트는 나중에 온다.
    // 예전 구조는 authenticate() 안에서 이미 conns 에 넣은 뒤 되돌리는 방식이라, 프로덕션에서는
    // socketClosed 가 false 여서 되돌리기 자체가 돌지 않았다(리뷰가 실제 ws 로 측정).
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const registry = {
      getById: async () => { await gate; return { tokenHash: hashWorkerToken("t") }; },
      touchLastSeen: async () => {},
    };
    const hub = new WorkerHub({ registry });
    const s = fakeSocket({ asyncClose: true });
    hub.handleConnection(s.sock);

    s.recv({ type: "hello", token: "t", workerId: "w1", roots: ["/ws"] });
    // 조회 중 다른 프레임이 도착해 소켓이 닫힌다(close 이벤트는 아직 오지 않는다).
    s.recv({ type: "ping" });
    expect(s.closed).toBe(true);

    release();
    await flush();

    expect(hub.isConnected("w1")).toBe(false);
    expect(s.sent).not.toContainEqual({ type: "ready" });
    expect(s.sent).not.toContainEqual({ type: "pong" });
  });

  it("죽은 연결의 늦은 인증이 그 사이 자리를 차지한 산 연결을 쫓아내지 않는다", async () => {
    let releaseA!: () => void;
    const gateA = new Promise<void>((r) => { releaseA = r; });
    let first = true;
    const registry = {
      getById: async () => {
        if (first) { first = false; await gateA; }
        return { tokenHash: hashWorkerToken("t") };
      },
      touchLastSeen: async () => {},
    };
    const hub = new WorkerHub({ registry });

    const a = fakeSocket({ asyncClose: true });
    hub.handleConnection(a.sock);
    a.recv({ type: "hello", token: "t", workerId: "w1", roots: ["/a"] });
    a.recv({ type: "ping" }); // 조회 중 프레임 → A 는 닫힌다
    expect(a.closed).toBe(true);

    // B 가 정상적으로 같은 workerId 를 차지한다.
    const b = fakeSocket();
    hub.handleConnection(b.sock);
    b.recv({ type: "hello", token: "t", workerId: "w1", roots: ["/b"] });
    await flush();
    expect(hub.isConnected("w1")).toBe(true);
    expect(hub.rootsOf("w1")).toEqual(["/b"]);

    // 이제 A 의 조회가 뒤늦게 끝난다.
    releaseA();
    await flush();

    expect(hub.isConnected("w1")).toBe(true);
    expect(hub.rootsOf("w1")).toEqual(["/b"]);
    expect(b.closed).toBe(false);
  });
});
