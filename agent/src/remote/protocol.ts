// 봇(허브)과 워커가 WebSocket 으로 주고받는 프레임 정의. 양쪽이 공유하는 유일한 계약이며
// 순수 함수만 둔다(소켓·fs 없음) — 그래야 실제 연결 없이 테스트할 수 있다.

// workerId: "나는 누구의 워커다"가 아니라 "나는 어느 워커다". 허브가 이 값으로 workers 행을
// 찾아 토큰 해시를 대조한다.
//
// 최종 pre-merge 리뷰 FIX6(사소) — 옛 형식(userId)을 보내는 구버전 워커가 실제로 어떻게 되는지는
// "조용히 붙지 못하고 명확히 실패한다"가 아니다. parseFrame 은 workerId 가 없는 hello 를 그냥
// null 로 거부하고, hub.ts 는 그 null 을 다른 깨진 프레임과 똑같이 취급해 denied 프레임 없이
// 소켓만 끊는다(handleConnection 의 `if (!frame) { terminate(); return; }`). denied 를 한 번도
// 받지 못한 워커는 재시도를 멈출 이유가 없으므로, workerClient.ts 는 그 연결 종료를 평범한
// 끊김으로 보고 고정 간격(기본 3초)마다 조용히 재연결한다 — 매번 같은 옛 형식 hello 를 다시
// 보내고 다시 끊기는 무한 루프이지, 한 번에 끝나는 "명확한 실패"가 아니다. 사람이 알아채려면
// "거부됨" 로그가 아니라 "연결이 끊겨 재시도합니다"가 반복되는 로그를 봐야 한다. 이상적이지는
// 않지만 비용은 제한적이다 — 시도당 TCP 연결 하나와 JSON 파싱 한 번뿐이고, 프레임이 아예
// 파싱되지 않으므로 레지스트리 조회(DB 왕복)까지는 가지도 않는다.
export type WorkerHello = { type: "hello"; token: string; workerId: string; roots: string[]; commit?: string };
export type HubReady = { type: "ready" };
export type HubDenied = { type: "denied"; reason: string };
export type HubCall = { type: "call"; id: string; tool: string; args: Record<string, unknown> };
export type WorkerResult = { type: "result"; id: string; ok: boolean; content: string };
export type Ping = { type: "ping" };
export type Pong = { type: "pong" };

export type Frame = WorkerHello | HubReady | HubDenied | HubCall | WorkerResult | Ping | Pong;

export function encodeFrame(f: Frame): string {
  return JSON.stringify(f);
}

const isStr = (v: unknown): v is string => typeof v === "string";
const isStrArray = (v: unknown): v is string[] => Array.isArray(v) && v.every(isStr);
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

// 형식이 조금이라도 어긋나면 null 을 돌려준다. 호출측은 null 을 "무시 또는 연결 종료"로 다룬다 —
// 신뢰할 수 없는 입력이 그대로 실행 경로로 흘러들지 않게 하는 유일한 관문이다.
export function parseFrame(raw: string): Frame | null {
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isObj(v)) return null;
  switch (v.type) {
    case "hello":
      // commit 은 선택 필드다 — 없어도, 형태가 어긋나도 hello 자체는 통과시킨다. 이 프레임이
      // null 이 되면 허브가 소켓만 끊고 워커는 사유를 못 받아 영원히 재연결한다(파일 상단
      // FIX6 주석). 버전을 모르는 것이 연결을 못 하는 것보다 낫다.
      return isStr(v.token) && isStr(v.workerId) && isStrArray(v.roots)
        ? isStr(v.commit)
          ? { type: "hello", token: v.token, workerId: v.workerId, roots: v.roots, commit: v.commit }
          : { type: "hello", token: v.token, workerId: v.workerId, roots: v.roots }
        : null;
    case "ready":
      return { type: "ready" };
    case "denied":
      return isStr(v.reason) ? { type: "denied", reason: v.reason } : null;
    case "call":
      return isStr(v.id) && isStr(v.tool) && isObj(v.args)
        ? { type: "call", id: v.id, tool: v.tool, args: v.args }
        : null;
    case "result":
      return isStr(v.id) && typeof v.ok === "boolean" && isStr(v.content)
        ? { type: "result", id: v.id, ok: v.ok, content: v.content }
        : null;
    case "ping":
      return { type: "ping" };
    case "pong":
      return { type: "pong" };
    default:
      return null;
  }
}
