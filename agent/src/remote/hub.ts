import { randomBytes, timingSafeEqual } from "node:crypto";
import { encodeFrame, parseFrame, type Frame } from "./protocol.js";
import { hashWorkerToken } from "../store/workersRepo.js";

// 실제 ws 소켓을 감싸는 최소 인터페이스. 이 추상화 덕에 소켓 없이 허브 로직을 테스트한다
// (ws → HubSocket 어댑터는 index.ts 배선에서 만든다).
export type HubSocket = {
  send(data: string): void;
  close(): void;
  onMessage(cb: (raw: string) => void): void;
  onClose(cb: () => void): void;
};

type Pending = { resolve: (r: { ok: boolean; content: string }) => void; timer: ReturnType<typeof setTimeout> };
type Conn = { socket: HubSocket; roots: string[]; pending: Map<string, Pending>; pingTimer: ReturnType<typeof setInterval> };

const DEFAULT_CALL_TIMEOUT_MS = 120_000;

// 유휴 연결을 살려 두기 위한 keepalive 주기.
//
// Ping/Pong 프레임(protocol.ts)과 양쪽의 응답 경로는 원래부터 있었지만 어느 쪽도 먼저 보내지
// 않았다 — 정의만 있고 아무도 시작하지 않는 keepalive 였다. 그래서 도구 호출이 없는 동안 WS 가
// 완전히 유휴 상태가 되고 Railway 엣지 프록시가 그 연결을 끊는다(실측 2026-07-28: 미니PC 워커가
// 약 15분 간격으로 "연결이 끊겨 재시도합니다 → 연결됨 → 준비됨" 을 반복).
//
// 사용자에게 보이는 증상은 재연결 로그가 아니라 간헐적 거부다: 재연결 창(workerClient 의 고정
// 3초) 동안 isConnected 가 false 라 resolveTurnWorker 가 null 을 돌려주고, 모델은 "지금은 워커가
// 연결돼 있지 않아 PC 작업을 할 수 없어요" 로 답한다 — 아무 이유 없이 가끔 안 되는 것처럼 보인다.
//
// 워커가 아니라 허브가 보낸다: 프록시의 유휴 타이머는 어느 방향의 프레임으로도 갱신되고,
// 워커의 pong 응답 경로(workerClient.ts)는 이미 있어 워커 쪽 변경이 필요 없다 — 미니PC 를
// 재배포하지 않아도 이 수정이 그대로 듣는다.
//
// pong 이 안 와도 연결을 끊지는 않는다. 그건 새로운 끊김 사유를 만드는 일이고, 반쪽 연결은
// call() 의 callTimeoutMs 가 이미 실패로 처리한다 — 여기서는 원인(유휴)만 없앤다.
const DEFAULT_PING_INTERVAL_MS = 30_000;

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

// FIX5(중요): "그런 workerId 없음"과 "토큰이 틀림"을 구분하지 않는다. 구분되는 사유를 돌려주면,
// 인증되지 않은 클라이언트가 그 응답만으로 "이 workerId 가 실제로 등록돼 있는가"를 확인할 수
// 있는 오라클이 된다.
const DENIED_REASON = "인증에 실패했어요.";

// FIX5: 토큰을 상수 시간으로 비교한다. 문자열 '!==' 비교는 앞에서부터 다른 문자가 나오는 순간
// 바로 반환되므로, 그 응답 시간 차이로 "몇 번째 글자까지 맞았는지"가 새어나갈 수 있다(고전적
// 타이밍 공격). Buffer 길이가 다르면 timingSafeEqual 자체가 예외를 던지므로, 그 경우엔 자기
// 자신과 비교하는 더미 연산으로 같은 코드 경로의 비용만 흉내내고 false 를 돌려준다 — 길이 정보
// 자체가 새는 것까지 막지는 못하지만, 적어도 "내용 비교" 단계에서 조기 반환은 없앤다.
// Task3: 이제 인자로 평문 토큰이 아니라 해시(양쪽 다 hashWorkerToken 을 거친 값)를 받는다.
function tokensMatch(given: string, expected: string): boolean {
  const givenBuf = Buffer.from(given, "utf8");
  const expectedBuf = Buffer.from(expected, "utf8");
  if (givenBuf.length !== expectedBuf.length) {
    timingSafeEqual(givenBuf, givenBuf);
    return false;
  }
  return timingSafeEqual(givenBuf, expectedBuf);
}

// 허브가 인증에 필요한 최소 인터페이스. WorkersRepo 전체를 받지 않는 이유는 테스트에서
// 가짜를 만들기 쉽게 하기 위해서다 — 허브는 조회와 접속 기록만 필요하다.
export type WorkerRegistry = {
  getById(id: string): Promise<{ tokenHash: string } | null>;
  touchLastSeen(id: string, ts: number): Promise<void>;
};

// "그런 워커 없음" 경로에서 해시 비교를 흉내내는 데 쓸 대조값. 프로세스마다 랜덤이라 어떤
// 입력으로도 여기에 맞출 수 없다.
//
// 리뷰 지적(M1): 예전엔 hashWorkerToken("") 을 썼는데, 그러면 등록되지 않은 workerId 에 빈
// 토큰을 보낸 클라이언트가 해시 비교를 "통과"하고, 최종 판정의 row !== null 하나만이 완전
// 우회를 막고 있었다. 그 한 줄을 지워도 테스트 28개가 전부 통과했다(리뷰어 변이 실험).
// 대조값 자체를 맞출 수 없게 만들어 그 의존을 없앤다. sha256 해시와 같은 64자 hex 라
// 길이 기반 조기 반환도 생기지 않는다.
const NOT_FOUND_HASH = randomBytes(32).toString("hex");

// 인증 상태.
// - authenticating: hello 를 받아 레지스트리를 조회하는 중. 그 사이 도착한 프레임은 무조건
//   연결 종료로 다룬다 — 조회가 비동기가 되면서 생긴 창이라, 얼버무리면 "인증 전 프레임은
//   즉시 끊는다"는 기존 규칙에 구멍이 난다.
// - denied: 이 소켓은 인증 기회를 이미 썼다(거부되었거나 조회 자체가 실패). 종착 상태다.
//   리뷰 지적(I4): 예전엔 거부 후 "unauth" 로 되돌려 같은 소켓이 hello 를 다시 보낼 수 있었다.
//   socket.close() 는 실제 ws 에서 "닫아 달라는 요청"일 뿐이라(readyState=CLOSING, 최대 30초)
//   상대는 그 사이 계속 보낼 수 있고, 이제 시도 한 번마다 Postgres 왕복이 한 번이라
//   봇의 유일한 공개 리스너에 인증 전 DB 부하를 무제한으로 걸 수 있었다(리뷰 재현: 소켓 1개로
//   조회 5회). DB 오류 경로도 같은 이유로 종착이다 — 아니면 DB 장애가 재시도 루프가 된다.
type AuthState = "unauth" | "authenticating" | "authed" | "denied";

export class WorkerHub {
  private conns = new Map<string, Conn>();
  // FIX3: 아직 hello 로 인증되지 않은 소켓 → 그 hello-타임아웃 타이머. conns 는 인증된 연결만
  // 담으므로, 인증 전 소켓은 여기서 따로 추적해야 closeAll() 이 이들도 닫을 수 있다.
  private unauthSockets = new Map<HubSocket, ReturnType<typeof setTimeout>>();
  private seq = 0;
  private registry: WorkerRegistry;
  private now: () => number;
  private callTimeoutMs: number;
  private helloTimeoutMs: number;
  private pingIntervalMs: number;

  constructor(opts: {
    registry: WorkerRegistry; now?: () => number;
    callTimeoutMs?: number; helloTimeoutMs?: number; pingIntervalMs?: number;
  }) {
    this.registry = opts.registry;
    this.now = opts.now ?? Date.now;
    this.callTimeoutMs = opts.callTimeoutMs ?? DEFAULT_CALL_TIMEOUT_MS;
    this.helloTimeoutMs = opts.helloTimeoutMs ?? DEFAULT_HELLO_TIMEOUT_MS;
    this.pingIntervalMs = opts.pingIntervalMs ?? DEFAULT_PING_INTERVAL_MS;
  }

  // 인증된 연결에만 건다(인증 전 소켓은 hello 타임아웃이 따로 관리한다). send 가 동기적으로
  // 던질 수 있어(이미 닫힌 소켓 등) 감싼다 — 타이머 콜백에서 새어 나가면 잡을 곳이 없어
  // 봇 프로세스가 죽는다. 끊긴 연결의 타이머는 onClose·dropExisting·closeAll 이 정리하므로,
  // 이 catch 가 막는 것은 그 사이의 짧은 창뿐이다.
  private startPing(socket: HubSocket): ReturnType<typeof setInterval> {
    return setInterval(() => {
      try {
        socket.send(encodeFrame({ type: "ping" }));
      } catch (e) {
        console.error("[hub] ping 전송 실패:", e);
      }
    }, this.pingIntervalMs);
  }

  // 새 소켓 하나를 받는다. hello 로 인증되기 전에는 어떤 프레임도 처리하지 않는다.
  handleConnection(socket: HubSocket): void {
    let state: AuthState = "unauth";
    let workerId: string | null = null;

    // 이 연결을 더 이상 쓰면 안 되는가. 두 경로로 참이 된다.
    //   1) 허브가 스스로 끊기로 했다 → terminate()
    //   2) 상대가 실제로 끊었다 → onClose
    //
    // 리뷰 지적(I1b): onClose 하나만 보면 프로덕션에서 이 값이 영원히 false 다. 실제 ws 의
    // close() 는 "닫아 달라는 요청"일 뿐이라 readyState 가 CLOSING 으로 바뀔 뿐이고, 'close'
    // 이벤트는 상대가 응답해야 오며 기본 30초까지 걸린다(리뷰가 ws 8.21.1 로 측정: close() 후
    // 714ms 시점까지도 이벤트 없음, 그 사이 상대가 보낸 ping 을 서버가 계속 수신). 그래서
    // "우리가 끊기로 했다"는 사실 자체를 별도로 기록해야 한다 — 상대의 협조에 의존할 수 없다.
    let dead = false;
    const terminate = () => { dead = true; socket.close(); };

    // FIX3: hello 를 제때 안 보내면 닫는다. 인증에 성공하면(아래) 이 타이머를 바로 지운다 —
    // 안 지우면 정상적으로 인증된 지 한참 지난 연결도 이 시간이 지나는 순간 끊겨버린다.
    const helloTimer = setTimeout(() => {
      this.unauthSockets.delete(socket);
      terminate();
    }, this.helloTimeoutMs);
    this.unauthSockets.set(socket, helloTimer);

    socket.onMessage((raw) => {
      // 크기부터 본다 — 거대한 문자열을 JSON.parse 에 넘기는 비용조차 아낀다.
      if (raw.length > MAX_FRAME_CHARS) { terminate(); return; }

      const frame = parseFrame(raw);
      if (!frame) { terminate(); return; }

      // 조회 중이거나 이미 인증 기회를 쓴 소켓은 어떤 프레임도 받지 않는다(hello 재전송 포함).
      if (state === "authenticating" || state === "denied") { terminate(); return; }

      if (state === "unauth") {
        if (frame.type !== "hello") { terminate(); return; }
        state = "authenticating";
        const id = frame.workerId;
        const roots = frame.roots;
        // 조회는 비동기다. 이 프로미스는 절대 reject 되지 않게 감싼다 — 여기서 던지면
        // onMessage 콜백 밖으로 새어 프로세스 전체가 죽는다.
        void this.authenticate(id, frame.token)
          .then((ok) => {
            if (!ok) {
              state = "denied";
              socket.send(encodeFrame({ type: "denied", reason: DENIED_REASON }));
              terminate();
              return;
            }
            // 리뷰 지적(I1·I3): 커밋(conns 등록·ready 전송)은 반드시 여기서만 한다.
            // 예전엔 authenticate() 안에서 등록까지 하고 그 "다음에" 이 콜백이 되돌렸는데,
            // 되돌리기 전 창에서 이미 닫힌 소켓이 conns 에 살아 있었고 그 소켓으로 call 이
            // 실제로 나갔다(리뷰 재현). 게다가 그 되돌리기는 onClose 가 세우는 플래그에
            // 의존했는데, 실제 ws 에서는 그 이벤트가 제때 오지 않아 프로덕션에서는 아예 돌지
            // 않았다 — 그래서 dead 는 우리가 끊기로 한 시점에 직접 세운다(위 terminate 참고).
            //
            // 조회 도중 죽은 연결은 아무것도 등록하지 않고 조용히 끝낸다. 이렇게 하면 "죽은
            // 연결의 늦은 인증이, 그 사이 같은 workerId 를 차지한 살아 있는 연결을 쫓아내는"
            // 문제(리뷰 I3)도 함께 사라진다 — 손댈 conns 가 애초에 없다.
            if (dead) { state = "denied"; return; }

            this.clearHelloTimer(socket);
            this.dropExisting(id);
            this.conns.set(id, { socket, roots, pending: new Map(), pingTimer: this.startPing(socket) });
            state = "authed";
            workerId = id;
            socket.send(encodeFrame({ type: "ready" }));
            // 접속 기록은 부가 정보다. await 하지 않는다 — 예전에는 여기를 await 하는 동안이
            // "등록은 됐는데 아직 커밋이 안 끝난" 창이었다. 실패해도 인증을 되돌리지 않는다.
            void this.registry.touchLastSeen(id, this.now()).catch(() => {});
          })
          .catch((e) => {
            console.error("[hub] 인증 처리 오류:", e);
            state = "denied";
            terminate();
          });
        return;
      }

      // state === "authed"
      if (frame.type === "hello") { terminate(); return; }
      if (workerId === null) return;
      const conn = this.conns.get(workerId);
      if (!conn || conn.socket !== socket) return;
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
      dead = true;

      // FIX3: 인증 전에 끊겼다면 hello-타임아웃 추적을 정리한다(인증 후라면 위에서 이미 지워
      // 여기선 no-op).
      this.clearHelloTimer(socket);

      if (workerId === null) return;
      const conn = this.conns.get(workerId);
      if (!conn || conn.socket !== socket) return;
      this.conns.delete(workerId);
      clearInterval(conn.pingTimer);
      this.failAllPending(conn, "워커 연결이 끊겼어요.");
    });
  }

  isConnected(workerId: string): boolean {
    return this.conns.has(workerId);
  }

  rootsOf(workerId: string): string[] {
    return this.conns.get(workerId)?.roots ?? [];
  }

  // 도구 호출 하나를 워커로 보내고 결과를 기다린다. 어떤 경우에도 reject 하지 않는다 —
  // 실패는 ok:false 로 모델에게 돌려주어 턴 전체가 죽지 않게 한다.
  // args 는 호출측이 준 그대로 프레임에 실어 보낼 뿐 절대 merge·spread·Object.assign 하지 않는다 —
  // __proto__ 같은 키가 들어 있어도 그대로 통과시켜야 프로토타입 오염 경로가 생기지 않는다.
  call(workerId: string, tool: string, args: Record<string, unknown>): Promise<{ ok: boolean; content: string }> {
    const conn = this.conns.get(workerId);
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
    for (const [workerId, conn] of this.conns) {
      // 타이머를 먼저 끊는다 — 남겨 두면 이벤트 루프가 계속 살아 있어 종료가 막힌다.
      clearInterval(conn.pingTimer);
      this.failAllPending(conn, "봇이 종료돼 작업을 마치지 못했어요.");
      conn.socket.close();
      this.conns.delete(workerId);
    }
  }

  // 같은 workerId 의 이전 연결이 남아 있으면 정리한다(워커 재시작 시 유령 연결 방지).
  private dropExisting(workerId: string): void {
    const prev = this.conns.get(workerId);
    if (!prev) return;
    this.conns.delete(workerId);
    // onClose 에만 맡기면 안 된다 — 실제 ws 의 close() 는 요청일 뿐이라 'close' 이벤트가 최대
    // 30초까지 늦게 오고(이 파일 위쪽 I1b 주석), 그 사이 밀려난 소켓으로 ping 이 계속 나간다.
    clearInterval(prev.pingTimer);
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

  // 판정만 한다 — 소켓도 conns 도 건드리지 않는다. 커밋(등록·ready·거부 전송)은 호출측
  // handleConnection 의 .then() 이 한다(리뷰 지적 I1·I3: 판정과 커밋이 한 함수에 섞여 있으면
  // "판정은 끝났는데 커밋 조건은 아직 안 본" 창이 생기고, 그 창에서 이미 닫힌 소켓이 등록된다).
  private async authenticate(workerId: string, token: string): Promise<boolean> {
    // 빈 토큰은 조회 전에 거부한다. 정상 발급 토큰은 32바이트 랜덤의 hex(64자)라 빈 값이 될 수
    // 없으므로 정상 동작을 막지 않고, 공격자가 보낸 임의 길이 문자열을 해시하는 비용도 아낀다.
    if (token.length === 0) return false;

    const row = await this.registry.getById(workerId);
    // FIX5 유지: "그런 워커 없음"과 "토큰 틀림"을 구분하지 않는다. 구분하면 인증되지 않은
    // 클라이언트가 유효한 workerId 를 캐낼 수 있는 오라클이 된다. 행이 없어도 해시 비교를
    // 흉내내 응답 시간 차이를 줄인다 — row !== null && tokensMatch(...) 처럼 단락 평가로 쓰면
    // row 가 없을 때 tokensMatch 호출 자체가 스킵되어 이 흉내가 무너지므로, 비교는 항상 먼저
    // 실행하고 최종 판정에서만 row 유무를 반영한다.
    //
    // 대조값은 NOT_FOUND_HASH(프로세스마다 랜덤) 다 — 어떤 입력으로도 맞출 수 없으므로,
    // row !== null 검사가 없어도 "없는 워커"가 통과하지 않는다(방어 두 겹).
    const expected = row?.tokenHash ?? NOT_FOUND_HASH;
    const hashesMatch = tokensMatch(hashWorkerToken(token), expected);
    return row !== null && hashesMatch;
  }

  // FIX3: hello-타임아웃 타이머와 추적 Map 항목을 함께 정리한다. 인증 성공 직후·소켓 종료(onClose)·
  // closeAll() 세 곳 모두에서 같은 정리가 필요해 한 곳으로 모았다.
  private clearHelloTimer(socket: HubSocket): void {
    const timer = this.unauthSockets.get(socket);
    if (timer !== undefined) clearTimeout(timer);
    this.unauthSockets.delete(socket);
  }
}
