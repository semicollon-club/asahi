// Agent SDK 의 스트림 메시지 → 진행 업데이트. 원래 core/agent.ts 안에 있던 순수 함수들을 떼어 낸 것이다(풀 하네스
// 2단계, 2026-09-05 밤). 이유는 소비자가 둘이 됐기 때문이다 — 봇의 makeRunAgentTurn(자기 세션의 스트림)과 워커의
// 세션 러너(remote/sessionRunner.ts — 계정 B 에서 도는 Claude Code 의 스트림). 워커가 agent.ts 를 통째로 들여오면
// tools.ts·store 까지 딸려 오므로(모듈 경계: 워커는 store 를 모른다), 두 쪽이 필요로 하는 이 조각만 store·SDK 의존
// 없이 따로 둔다. agent.ts 는 예전 이름으로 그대로 재수출한다 — 호출부·테스트는 바뀌지 않는다.
//
// 이벤트 모양이 봇과 워커에서 같아야 하는 이유: 워커가 turn.event 로 실어 보내는 것을 봇이 그대로 onProgress 에
// 넣어 진행 표시(formatProgress)와 actions 기록을 옛 경로와 똑같이 태운다(계획 2.6 의 완료 기준).

// 턴 처리 중 진행 상황(판별 유니온). 표시용 텍스트로 바꾸는 건 core.ts 의 formatProgress 가 맡는다.
export type ProgressUpdate =
  | { kind: "tool"; name: string; input?: string }
  // 표시와 기록이 같은 값에서 나오도록 확장했다(2026-07-28 관측 기반 스펙 §3).
  // ok/summary 는 SDK 의 tool_result 블록에서, input/durationMs 는 짝지은 tool 이벤트에서 온다.
  | { kind: "tool_result"; name?: string; input?: string; ok: boolean; summary?: string; durationMs?: number }
  | { kind: "answering" };

// tool_use_id → 그 호출의 이름·입력·시작 시각. 예전엔 이름(string)만 담았는데, 기록 한 행을
// 채우려면 input 과 소요시간이 필요하다. 짝짓기는 반드시 id 로 한다 — 이름으로 짝지으면 같은
// 도구를 연달아 부를 때 어긋난다.
export type PendingTool = { name: string; input?: string; startedAt: number };

// 결과 요약의 기록 상한 — actions.result_summary 에 남길 해상도다. 표시 줄의 상한은 이 값이
// 아니라 core.ts 의 PROGRESS_SUMMARY_MAX(80)가 따로 갖는다. 같은 이벤트에서 나온 두 소비자가
// 서로 다른 예산을 갖는 지점이라, 표시를 늘리려고 이 값을 건드리면 표시는 그대로이고 DB
// 해상도만 바뀐다(최종 리뷰 Important 2 로 갈라진 뒤 이 주석이 낡아 바로잡았다).
export const RESULT_SUMMARY_MAX = 200;

// mcp__asahi__recall → recall 처럼 인프로세스 MCP 접두어를 벗겨 짧게 만든다. 접두어가 없으면 그대로.
export function shortToolName(name: string): string {
  const parts = name.split("__");
  return name.startsWith("mcp__") && parts.length >= 3 ? parts.slice(2).join("__") : name;
}

function truncate(s: string, max = 40): string {
  const t = s.trim();
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

// 도구 입력 객체에서 사람이 읽을 만한 짧은 요약 하나를 뽑는다(대표 키 우선순위). 없으면 undefined.
export function summarizeToolInput(input: unknown): string | undefined {
  if (typeof input === "string") return input.trim().length > 0 ? truncate(input) : undefined;
  if (input && typeof input === "object") {
    const obj = input as Record<string, unknown>;
    for (const key of ["query", "title", "content", "path", "file_path", "pattern", "command", "description"]) {
      const v = obj[key];
      if (typeof v === "string" && v.length > 0) return truncate(v);
    }
  }
  return undefined;
}

// tool_result 블록의 content 에서 표시·요약용 텍스트를 뽑는다. Anthropic 메시지 스펙(SDK 의
// ToolResultBlockParam)상 content 는 string 이거나 블록 배열(TextBlockParam 등)이다 — 그런데 이
// 저장소의 모든 도구는 tools.ts 의 textResult(`{ content: [{ type: "text", text }] }`)를 거치므로
// 실제로 오는 건 항상 배열 쪽이다. content 를 string 으로만 가정했던 예전 구현은 이 배열을 그냥
// 지나쳐 body 가 항상 undefined 가 됐고, summary 는 실사용에서 한 번도 채워진 적이 없었다(리뷰 지적).
// 아래는 is_error 방어(없으면 성공으로 간주)와 같은 정신으로 SDK 가 어느 모양으로 주든 동작하게 둘 다
// 받는다: 배열이면 type==="text" 인 블록들의 text 만 골라 구분자 없이 이어붙이고(이미지 등 다른 타입
// 블록은 무시), text 블록이 하나도 없으면 undefined.
function extractResultText(content: unknown): string | undefined {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return undefined;
  const texts = content
    .filter((b): b is { type: "text"; text: string } =>
      !!b && typeof b === "object" && (b as { type?: unknown }).type === "text" && typeof (b as { text?: unknown }).text === "string")
    .map((b) => b.text);
  return texts.length > 0 ? texts.join("") : undefined;
}

// query() 스트림 메시지 하나에서 진행 업데이트들을 뽑는 순수 함수. assistant 의 tool_use → 'tool',
// 그 뒤 user 의 tool_result → 'tool_result'(이름·입력은 pending 으로 되찾고 성패·요약은 이 블록
// 자체에서, 소요시간은 짝지은 tool 의 시작 시각과의 차로 계산), text 블록 → 'answering'.
// pending 은 호출자가 턴 하나 동안 유지하는 tool_use_id → PendingTool 맵(이 함수가 채우고 소비한다).
// now(기본 Date.now)는 테스트가 시계를 주입해 durationMs 를 결정적으로 검증할 수 있게 한다.
type ProgressSourceMessage = { type: string; message?: unknown };
export function progressFromMessage(
  message: ProgressSourceMessage,
  pending: Map<string, PendingTool>,
  now: () => number = Date.now,
): ProgressUpdate[] {
  const inner = message.message;
  const content = inner && typeof inner === "object" ? (inner as { content?: unknown }).content : undefined;
  if (!Array.isArray(content)) return [];
  const updates: ProgressUpdate[] = [];
  for (const raw of content) {
    if (!raw || typeof raw !== "object") continue;
    const block = raw as {
      type?: unknown; name?: unknown; id?: unknown; input?: unknown;
      tool_use_id?: unknown; is_error?: unknown; content?: unknown;
    };
    if (block.type === "tool_use" && typeof block.name === "string") {
      const name = shortToolName(block.name);
      const input = summarizeToolInput(block.input);
      if (typeof block.id === "string") pending.set(block.id, { name, input, startedAt: now() });
      updates.push({ kind: "tool", name, input });
    } else if (block.type === "tool_result" && typeof block.tool_use_id === "string") {
      const p = pending.get(block.tool_use_id);
      pending.delete(block.tool_use_id);
      // is_error 가 실려 오지 않는 SDK 버전에서도 안전하게 동작한다 — 없으면 성공으로 본다.
      const ok = block.is_error !== true;
      const body = extractResultText(block.content);
      updates.push({
        kind: "tool_result",
        name: p?.name,
        input: p?.input,
        ok,
        summary: body === undefined ? undefined : body.slice(0, RESULT_SUMMARY_MAX),
        durationMs: p === undefined ? undefined : now() - p.startedAt,
      });
    } else if (block.type === "text") {
      updates.push({ kind: "answering" });
    }
  }
  return updates;
}

// 워커가 turn.event 로 실어 보낸 값이 ProgressUpdate 모양인지. 프레임 파서(protocol.ts)는 "객체다"까지만 보고,
// 봇은 이 함수로 한 번 더 걸러 onProgress 에 넣는다 — 워커가 보낸 낯선 모양이 진행 표시·actions 기록으로
// 흘러들지 않게. 신뢰 경계는 여기다: 워커는 인증된 우리 코드지만, 프레임 하나가 봇 프로세스를 죽이면 안 된다.
export function isProgressUpdate(v: unknown): v is ProgressUpdate {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  if (o.kind === "answering") return true;
  if (o.kind === "tool") return typeof o.name === "string" && (o.input === undefined || typeof o.input === "string");
  if (o.kind === "tool_result") {
    return typeof o.ok === "boolean"
      && (o.name === undefined || typeof o.name === "string")
      && (o.input === undefined || typeof o.input === "string")
      && (o.summary === undefined || typeof o.summary === "string")
      && (o.durationMs === undefined || typeof o.durationMs === "number");
  }
  return false;
}
