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
// mode(풀 하네스 2단계, 2026-09-05 밤): 이 워커가 세션 러너(turn.* 프레임)를 돌릴 수 있는지. 없으면 도구 전용(옛 워커)이다 —
// 봇은 이 값이 harness 인 워커에게만 turn.start 를 보낸다(hub.isHarness).
export type WorkerMode = "tools" | "harness";
export type WorkerHello = { type: "hello"; token: string; workerId: string; roots: string[]; commit?: string; mode?: WorkerMode };
export type HubReady = { type: "ready" };
export type HubDenied = { type: "denied"; reason: string };
export type HubCall = { type: "call"; id: string; tool: string; args: Record<string, unknown> };
export type WorkerResult = { type: "result"; id: string; ok: boolean; content: string };
export type Ping = { type: "ping" };
export type Pong = { type: "pong" };

// 세션 러너 프레임 넷(풀 하네스 설계 §7, 2단계 2.2). 도구 호출 프레임(call/result)과 공존한다 — 전환 기간 동안 같은
// 소켓으로 둘이 함께 흐르고, 6단계에서 도구 프레임을 지운다. turn.start 하나가 세션 한 턴이고, 러너는 그 턴의 진행을
// turn.event(봇의 ProgressUpdate 와 같은 모양 — core/sdkEvents.ts)로 흘린 뒤 turn.result 하나로 끝낸다.
// git 은 sh_exec 의 git 인자(gitEnv.ts 의 ShellGit)와 같은 값이다 — 러너가 세션 환경으로 옮긴다.
export type TurnProfile = { model: string; maxTurns: number; subagents: boolean; effort?: string; tools?: string[] };
export type TurnStartFrame = {
  type: "turn.start"; id: string; userId: string; cwd: string; systemPrompt: string; prompt: string;
  resume?: string; profile: TurnProfile; token: string; git?: Record<string, unknown>;
};
export type TurnEventFrame = { type: "turn.event"; id: string; event: Record<string, unknown> };
export type TurnResultFrame = { type: "turn.result"; id: string; ok: boolean; text: string; sessionId?: string; error?: string };
export type TurnCancelFrame = { type: "turn.cancel"; id: string };

export type Frame =
  | WorkerHello | HubReady | HubDenied | HubCall | WorkerResult | Ping | Pong
  | TurnStartFrame | TurnEventFrame | TurnResultFrame | TurnCancelFrame;

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
      if (!(isStr(v.token) && isStr(v.workerId) && isStrArray(v.roots))) return null;
      return {
        type: "hello", token: v.token, workerId: v.workerId, roots: v.roots,
        ...(isStr(v.commit) ? { commit: v.commit } : {}),
        // mode 도 commit 과 같은 이유로 선택이다 — 모르는 값은 "없음"으로 통과시킨다(연결을 막지 않는다).
        ...(v.mode === "tools" || v.mode === "harness" ? { mode: v.mode } : {}),
      };
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
    case "turn.start": {
      if (!(isStr(v.id) && isStr(v.userId) && isStr(v.cwd) && isStr(v.systemPrompt) && isStr(v.prompt) && isStr(v.token))) return null;
      const p = v.profile;
      if (!isObj(p) || !isStr(p.model) || typeof p.maxTurns !== "number" || typeof p.subagents !== "boolean") return null;
      if (p.effort !== undefined && !isStr(p.effort)) return null;
      if (p.tools !== undefined && !isStrArray(p.tools)) return null;
      if (v.resume !== undefined && !isStr(v.resume)) return null;
      if (v.git !== undefined && !isObj(v.git)) return null;
      const profile: TurnProfile = {
        model: p.model, maxTurns: p.maxTurns, subagents: p.subagents,
        ...(isStr(p.effort) ? { effort: p.effort } : {}),
        ...(isStrArray(p.tools) ? { tools: p.tools } : {}),
      };
      return {
        type: "turn.start", id: v.id, userId: v.userId, cwd: v.cwd, systemPrompt: v.systemPrompt, prompt: v.prompt, profile, token: v.token,
        ...(isStr(v.resume) ? { resume: v.resume } : {}),
        ...(isObj(v.git) ? { git: v.git } : {}),
      };
    }
    case "turn.event":
      return isStr(v.id) && isObj(v.event) ? { type: "turn.event", id: v.id, event: v.event } : null;
    case "turn.result": {
      if (!(isStr(v.id) && typeof v.ok === "boolean" && isStr(v.text))) return null;
      if (v.sessionId !== undefined && !isStr(v.sessionId)) return null;
      if (v.error !== undefined && !isStr(v.error)) return null;
      return {
        type: "turn.result", id: v.id, ok: v.ok, text: v.text,
        ...(isStr(v.sessionId) ? { sessionId: v.sessionId } : {}),
        ...(isStr(v.error) ? { error: v.error } : {}),
      };
    }
    case "turn.cancel":
      return isStr(v.id) ? { type: "turn.cancel", id: v.id } : null;
    default:
      return null;
  }
}
