// 봇(허브)과 워커가 WebSocket 으로 주고받는 프레임 정의. 양쪽이 공유하는 유일한 계약이며
// 순수 함수만 둔다(소켓·fs 없음) — 그래야 실제 연결 없이 테스트할 수 있다.

export type WorkerHello = { type: "hello"; token: string; userId: string; roots: string[] };
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
      return isStr(v.token) && isStr(v.userId) && isStrArray(v.roots)
        ? { type: "hello", token: v.token, userId: v.userId, roots: v.roots }
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
