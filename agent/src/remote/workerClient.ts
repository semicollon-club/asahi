import { encodeFrame, parseFrame } from "./protocol.js";
import type { Executors } from "./executors.js";

// 실제 WebSocket 을 감싸는 최소 인터페이스(허브의 HubSocket 과 대칭). onOpen 이 추가로 필요한 건
// 클라이언트가 연결 직후 hello 를 먼저 보내야 하기 때문이다.
export type ClientSocket = {
  send(data: string): void;
  close(): void;
  onMessage(cb: (raw: string) => void): void;
  onClose(cb: () => void): void;
  onOpen(cb: () => void): void;
};

export type WorkerClientOpts = {
  connect: () => ClientSocket;
  token: string;
  userId: string;
  roots: string[];
  executors: Executors;
  onStatus?: (s: string) => void;
  retryDelayMs?: number;
};

const DEFAULT_RETRY_MS = 3000;

export function startWorkerClient(opts: WorkerClientOpts): { stop(): void } {
  const retryDelayMs = opts.retryDelayMs ?? DEFAULT_RETRY_MS;
  const status = opts.onStatus ?? (() => {});
  let stopped = false;
  let denied = false;
  let current: ClientSocket | null = null;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;

  const open = () => {
    if (stopped || denied) return;
    const socket = opts.connect();
    current = socket;

    socket.onOpen(() => {
      status("연결됨 — 인증 중");
      socket.send(encodeFrame({ type: "hello", token: opts.token, userId: opts.userId, roots: opts.roots }));
    });

    socket.onMessage((raw) => {
      const frame = parseFrame(raw);
      if (!frame) return; // 형식이 깨진 프레임은 무시한다(허브와 달리 끊지 않는다 — 재연결 폭풍 방지)
      if (frame.type === "ready") { status("준비됨"); return; }
      if (frame.type === "denied") {
        // 인증 거부는 재시도해도 결과가 같다. 재연결을 멈추고 사람이 설정을 고치게 한다.
        denied = true;
        status(`거부됨: ${frame.reason}`);
        socket.close();
        return;
      }
      if (frame.type === "ping") { socket.send(encodeFrame({ type: "pong" })); return; }
      if (frame.type !== "call") return;

      const exec = opts.executors[frame.tool];
      let run: Promise<{ ok: boolean; content: string }>;
      if (!exec) {
        run = Promise.resolve({ ok: false, content: `모르는 도구예요: ${frame.tool}` });
      } else {
        try {
          run = exec(frame.args).catch((err) => ({ ok: false, content: `실행 중 오류: ${String(err)}` }));
        } catch (err) {
          // 실행기는 보통 실패해도 rejected Promise 를 돌려주므로 위 .catch 가 잡지만, "치더라도"
          // (async 가 아니라 동기적으로 던지는 구현일 수도 있다)에 대비해 호출 자체도 감싼다 —
          // 감싸지 않으면 예외가 이 onMessage 콜백 밖으로 그대로 튀어나가 result 프레임이 전혀
          // 만들어지지 않는다(call 을 받고도 응답을 안 하게 된다).
          run = Promise.resolve({ ok: false, content: `실행 중 오류: ${String(err)}` });
        }
      }
      void run.then((r) => {
        try {
          socket.send(encodeFrame({ type: "result", id: frame.id, ok: r.ok, content: r.content }));
        } catch (err) {
          // 결과를 보내려는 시점에 소켓이 이미 닫혀 있으면 send 가 동기적으로 던질 수 있다(허브 쪽
          // call() 이 같은 이유로 send 를 try/catch 로 감싸는 것과 대칭 — hub.ts 참고). 여기서
          // 삼키지 않으면 .then 콜백의 예외가 unhandledRejection 으로 번져 워커 프로세스가 죽을 수
          // 있다. 허브는 이 호출을 callTimeoutMs 로 이미 실패 처리하므로 여기서는 상태만 남긴다.
          status(`result 전송 실패: ${String(err)}`);
        }
      });
    });

    socket.onClose(() => {
      if (current !== socket) return;
      current = null;
      if (stopped || denied) return;
      status("연결이 끊겨 재시도합니다");
      retryTimer = setTimeout(open, retryDelayMs);
    });
  };

  open();

  return {
    stop() {
      stopped = true;
      if (retryTimer) clearTimeout(retryTimer);
      current?.close();
      current = null;
    },
  };
}
