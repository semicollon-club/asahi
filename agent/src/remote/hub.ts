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

// 이보다 긴 원문은 파싱조차 시도하지 않고 끊는다. 프레임 크기·중첩 깊이를 온전히 막는 건
// 전송 계층의 몫이지만, 이 정도는 허브 경계에서 거의 공짜로 막을 수 있다 — 정상 프레임(도구
// 호출 인자·결과 본문)은 executors.ts 의 OUTPUT_MAX(30000자)보다 훨씬 작으므로 넉넉히 잡아도
// 정상 트래픽을 막지 않는다.
const MAX_FRAME_CHARS = 1_000_000;

export class WorkerHub {
  private conns = new Map<string, Conn>();
  private seq = 0;
  private callTimeoutMs: number;

  constructor(private opts: { token: string; ownerId: string; callTimeoutMs?: number }) {
    this.callTimeoutMs = opts.callTimeoutMs ?? DEFAULT_CALL_TIMEOUT_MS;
  }

  // 새 소켓 하나를 받는다. hello 로 인증되기 전에는 어떤 프레임도 처리하지 않는다.
  handleConnection(socket: HubSocket): void {
    let userId: string | null = null;

    socket.onMessage((raw) => {
      // 크기부터 본다 — 거대한 문자열을 JSON.parse 에 넘기는 비용조차 아낀다.
      if (raw.length > MAX_FRAME_CHARS) { socket.close(); return; }

      const frame = parseFrame(raw);
      if (!frame) { socket.close(); return; }

      if (userId === null) {
        // 인증 전에는 hello 만 받는다. 그 외에는 즉시 끊는다.
        if (frame.type !== "hello") { socket.close(); return; }
        if (frame.token !== this.opts.token) {
          socket.send(encodeFrame({ type: "denied", reason: "토큰이 올바르지 않습니다." }));
          socket.close();
          return;
        }
        // 1단계는 소유자 워커 하나만 지원한다. 사용자별 토큰이 생기는 2단계에서 이 조건이 바뀐다.
        if (frame.userId !== this.opts.ownerId) {
          socket.send(encodeFrame({ type: "denied", reason: "이 워커 신원은 아직 지원하지 않습니다." }));
          socket.close();
          return;
        }
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
      conn.socket.send(encodeFrame({ type: "call", id, tool, args } satisfies Frame));
    });
  }

  closeAll(): void {
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
}
