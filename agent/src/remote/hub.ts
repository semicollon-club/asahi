import { timingSafeEqual } from "node:crypto";
import { encodeFrame, parseFrame, type Frame } from "./protocol.js";

// 실제 ws 소켓을 감싸는 최소 인터페이스. 이 추상화 덕에 소켓 없이 허브 로직을 테스트한다
// (ws → HubSocket 어댑터는 index.ts 배선에서 만든다).
export type HubSocket = {
  send(data: string): void;
  close(): void;
  onMessage(cb: (raw: string) => void): void;
  onClose(cb: () => void): void;
};

type Pending = { resolve: (r: { ok: boolean; content: string }) => void; timer: ReturnType<typeof setTimeout> };
type Conn = { socket: HubSocket; roots: string[]; pending: Map<string, Pending> };

const DEFAULT_CALL_TIMEOUT_MS = 120_000;

// FIX3(중요): 연결은 됐지만 hello 를 보내지 않는(또는 못 보내는) 소켓을 이 시간 안에 닫는다. 실제
// 워커는 연결 직후 곧바로 hello 를 보내므로(workerClient.ts 의 onOpen) 넉넉한 값이다. 이 타임아웃이
// 없으면 그런 "침묵하는" 연결이 인증 전 상태로 무기한 남는데, conns(인증된 연결만 담음)에는 애초에
// 없으니 closeAll() 의 대상도 아니었다 — 서버 종료 때 그 연결 하나 때문에 httpServer.close() 의
// 콜백이 영원히 안 와 SIGTERM 뒤 db.end() 전에 셧다운이 멈추고 플랫폼이 SIGKILL 로 pg 풀과 대기
// 중이던 디스코드 전송을 통째로 날렸다(리뷰 재현).
const DEFAULT_HELLO_TIMEOUT_MS = 10_000;

// 이보다 긴 원문은 파싱조차 시도하지 않고 끊는다. 프레임 크기·중첩 깊이를 온전히 막는 건
// 전송 계층의 몫이지만, 이 정도는 허브 경계에서 거의 공짜로 막을 수 있다 — 정상 프레임(도구
// 호출 인자·결과 본문)은 executors.ts 의 OUTPUT_MAX(30000자)보다 훨씬 작으므로 넉넉히 잡아도
// 정상 트래픽을 막지 않는다.
// FIX4(중요): index.ts 가 WebSocketServer 생성 시 maxPayload(바이트 상한)를 이 값과 맞추는 데도
// 재사용한다 — export 하지 않으면 두 상수가 서로 다른 파일에서 따로 관리되다 갈릴 위험이 있다.
// ws 의 기본 maxPayload(100MiB)를 그대로 두면, 인증조차 안 된 클라이언트가 보낸 거대한 프레임을
// 전송 계층이 이미 다 버퍼링한 "뒤"에야 아래 검사가 실행돼 방어가 너무 늦다.
export const MAX_FRAME_CHARS = 1_000_000;

// FIX5(중요): 토큰이 틀린 경우와 "토큰은 맞지만 신원(userId)이 다른" 경우를 구분하지 않는다.
// 구분되는 사유를 돌려주면, 인증되지 않은 클라이언트가 그 응답만으로 "이 토큰이 유효한가"를
// 신원과 무관하게 확인할 수 있는 오라클이 된다.
const DENIED_REASON = "인증에 실패했어요.";

// FIX5: 토큰을 상수 시간으로 비교한다. 문자열 '!==' 비교는 앞에서부터 다른 문자가 나오는 순간
// 바로 반환되므로, 그 응답 시간 차이로 "몇 번째 글자까지 맞았는지"가 새어나갈 수 있다(고전적
// 타이밍 공격). Buffer 길이가 다르면 timingSafeEqual 자체가 예외를 던지므로, 그 경우엔 자기
// 자신과 비교하는 더미 연산으로 같은 코드 경로의 비용만 흉내내고 false 를 돌려준다 — 길이 정보
// 자체가 새는 것까지 막지는 못하지만, 적어도 "내용 비교" 단계에서 조기 반환은 없앤다.
function tokensMatch(given: string, expected: string): boolean {
  const givenBuf = Buffer.from(given, "utf8");
  const expectedBuf = Buffer.from(expected, "utf8");
  if (givenBuf.length !== expectedBuf.length) {
    timingSafeEqual(givenBuf, givenBuf);
    return false;
  }
  return timingSafeEqual(givenBuf, expectedBuf);
}

export class WorkerHub {
  private conns = new Map<string, Conn>();
  // FIX3: 아직 hello 로 인증되지 않은 소켓 → 그 hello-타임아웃 타이머. conns 는 인증된 연결만
  // 담으므로, 인증 전 소켓은 여기서 따로 추적해야 closeAll() 이 이들도 닫을 수 있다.
  private unauthSockets = new Map<HubSocket, ReturnType<typeof setTimeout>>();
  private seq = 0;
  private callTimeoutMs: number;
  private helloTimeoutMs: number;

  constructor(private opts: { token: string; ownerId: string; callTimeoutMs?: number; helloTimeoutMs?: number }) {
    this.callTimeoutMs = opts.callTimeoutMs ?? DEFAULT_CALL_TIMEOUT_MS;
    this.helloTimeoutMs = opts.helloTimeoutMs ?? DEFAULT_HELLO_TIMEOUT_MS;
  }

  // 새 소켓 하나를 받는다. hello 로 인증되기 전에는 어떤 프레임도 처리하지 않는다.
  handleConnection(socket: HubSocket): void {
    let userId: string | null = null;

    // FIX3: hello 를 제때 안 보내면 닫는다. 인증에 성공하면(아래) 이 타이머를 바로 지운다 —
    // 안 지우면 정상적으로 인증된 지 한참 지난 연결도 이 시간이 지나는 순간 끊겨버린다.
    const helloTimer = setTimeout(() => {
      this.unauthSockets.delete(socket);
      socket.close();
    }, this.helloTimeoutMs);
    this.unauthSockets.set(socket, helloTimer);

    socket.onMessage((raw) => {
      // 크기부터 본다 — 거대한 문자열을 JSON.parse 에 넘기는 비용조차 아낀다.
      if (raw.length > MAX_FRAME_CHARS) { socket.close(); return; }

      const frame = parseFrame(raw);
      if (!frame) { socket.close(); return; }

      if (userId === null) {
        // 인증 전에는 hello 만 받는다. 그 외에는 즉시 끊는다.
        if (frame.type !== "hello") { socket.close(); return; }

        // FIX2 방어: config 검증(loadConfig)을 어떻게든 우회해 빈 토큰으로 허브가 뜨더라도, 빈
        // 토큰이 "누구든 인증"으로 이어지면 안 된다 — 길이 0 은 무조건 거부한다(빈 문자열끼리는
        // tokensMatch 가 true 를 돌려줄 수 있으므로 이 검사를 먼저, 별도로 둔다).
        // FIX5: 아래 denied 사유는 토큰 오류·신원 오류 어느 쪽이든 완전히 같다(인증 오라클 방지).
        const tokenOk = this.opts.token.length > 0 && tokensMatch(frame.token, this.opts.token);
        const identityOk = frame.userId === this.opts.ownerId;
        if (!tokenOk || !identityOk) {
          socket.send(encodeFrame({ type: "denied", reason: DENIED_REASON }));
          socket.close();
          return;
        }

        // 인증 성공 — 더 이상 hello-타임아웃 대상이 아니다.
        this.clearHelloTimer(socket);

        // 1단계는 소유자 워커 하나만 지원한다. 사용자별 토큰이 생기는 2단계에서 이 조건이 바뀐다.
        userId = frame.userId;
        this.dropExisting(userId);
        this.conns.set(userId, { socket, roots: frame.roots, pending: new Map() });
        socket.send(encodeFrame({ type: "ready" }));
        return;
      }

      const conn = this.conns.get(userId);
      if (!conn) return;
      if (frame.type === "result") {
        const p = conn.pending.get(frame.id);
        if (!p) return; // 모르는 id — 타임아웃 뒤 늦게 온 응답일 수 있다. 무시한다.
        conn.pending.delete(frame.id);
        clearTimeout(p.timer);
        p.resolve({ ok: frame.ok, content: frame.content });
      } else if (frame.type === "ping") {
        socket.send(encodeFrame({ type: "pong" }));
      }
    });

    socket.onClose(() => {
      // FIX3: 인증 전에 끊겼다면 hello-타임아웃 추적을 정리한다(인증 후라면 위에서 이미 지워
      // 여기선 no-op).
      this.clearHelloTimer(socket);

      if (userId === null) return;
      const conn = this.conns.get(userId);
      if (!conn || conn.socket !== socket) return;
      this.conns.delete(userId);
      this.failAllPending(conn, "워커 연결이 끊겼어요.");
    });
  }

  isConnected(userId: string): boolean {
    return this.conns.has(userId);
  }

  rootsOf(userId: string): string[] {
    return this.conns.get(userId)?.roots ?? [];
  }

  // 도구 호출 하나를 워커로 보내고 결과를 기다린다. 어떤 경우에도 reject 하지 않는다 —
  // 실패는 ok:false 로 모델에게 돌려주어 턴 전체가 죽지 않게 한다.
  // args 는 호출측이 준 그대로 프레임에 실어 보낼 뿐 절대 merge·spread·Object.assign 하지 않는다 —
  // __proto__ 같은 키가 들어 있어도 그대로 통과시켜야 프로토타입 오염 경로가 생기지 않는다.
  call(userId: string, tool: string, args: Record<string, unknown>): Promise<{ ok: boolean; content: string }> {
    const conn = this.conns.get(userId);
    if (!conn) return Promise.resolve({ ok: false, content: "워커가 연결돼 있지 않아요." });
    const id = String(++this.seq);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        conn.pending.delete(id);
        resolve({ ok: false, content: `워커가 ${this.callTimeoutMs}ms 안에 응답하지 않았어요.` });
      }, this.callTimeoutMs);
      conn.pending.set(id, { resolve, timer });
      try {
        conn.socket.send(encodeFrame({ type: "call", id, tool, args } satisfies Frame));
      } catch (e) {
        // send 가 동기적으로 던지면(예: 소켓이 이미 닫힌 상태) Promise executor 안의 예외이므로
        // 잡지 않으면 이 프로미스가 그대로 reject 된다 — 그러면 call() 은 "절대 reject 하지 않는다"는
        // 불변식이 깨지고, 호출측(에이전트 턴)이 이를 못 잡을 경우 턴 전체가 죽는다. 그래서 여기서
        // 잡아 다른 실패 경로와 똑같이 ok:false 로 정상 해결한다. 이미 등록해 둔 pending 항목과
        // 타이머를 정리하지 않으면 이미 끝난 프로미스에 대해 나중에 또 resolve 를 시도하거나(무해하지만
        // 낭비) 타이머가 누수되므로 함께 정리한다.
        conn.pending.delete(id);
        clearTimeout(timer);
        resolve({ ok: false, content: `워커로 전송하지 못했어요: ${e instanceof Error ? e.message : String(e)}` });
      }
    });
  }

  closeAll(): void {
    // FIX3: 인증 전 소켓도 포함해야 한다 — 안 그러면 서버 종료 때 그런 연결 하나 때문에
    // httpServer.close() 의 콜백이 영원히 안 온다.
    for (const [socket, timer] of this.unauthSockets) {
      clearTimeout(timer);
      socket.close();
    }
    this.unauthSockets.clear();
    for (const [userId, conn] of this.conns) {
      this.failAllPending(conn, "봇이 종료돼 작업을 마치지 못했어요.");
      conn.socket.close();
      this.conns.delete(userId);
    }
  }

  // 같은 사용자의 이전 연결이 남아 있으면 정리한다(워커 재시작 시 유령 연결 방지).
  private dropExisting(userId: string): void {
    const prev = this.conns.get(userId);
    if (!prev) return;
    this.conns.delete(userId);
    this.failAllPending(prev, "워커가 다시 연결돼 이전 작업이 취소됐어요.");
    prev.socket.close();
  }

  private failAllPending(conn: Conn, message: string): void {
    for (const [, p] of conn.pending) {
      clearTimeout(p.timer);
      p.resolve({ ok: false, content: message });
    }
    conn.pending.clear();
  }

  // FIX3: hello-타임아웃 타이머와 추적 Map 항목을 함께 정리한다. 인증 성공 직후·소켓 종료(onClose)·
  // closeAll() 세 곳 모두에서 같은 정리가 필요해 한 곳으로 모았다.
  private clearHelloTimer(socket: HubSocket): void {
    const timer = this.unauthSockets.get(socket);
    if (timer !== undefined) clearTimeout(timer);
    this.unauthSockets.delete(socket);
  }
}
