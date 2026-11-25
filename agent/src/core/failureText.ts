// 실패한 턴의 안내 문장(빠른 개선 2차 §3.3, 2026-11-25). 예전엔 "비서 처리 중 오류가 있었어요: (에이전트 오류: error_max_turns)"
// 처럼 원문이 공개 채널에 그대로 나갔고, 사람이 할 일(다시 시도·기다리기·이어서 시키기)이 없었다. 원문을 분류해 문장으로
// 바꾼다. 원문은 호출측이 봇 로그에 남기고, 소유자 DM 에서만 덧붙인다(showRaw) — 공개 채널에 내부 문자열이 쌓이지 않게.
//
// 구독 인증 실패는 여기서 다루지 않는다 — 소유자 경보까지 가는 별도 경로(authFailure.ts)가 먼저 가로챈다.

export type FailureKind = "max_turns" | "busy" | "timeout" | "worker" | "other";

// 순서가 의미를 갖는다: 허브의 턴 시간 상한 문구("워커가 …ms 안에 응답하지 않았어요")는 "워커" 를 담지만 연결 문제가 아니라
// 시간 상한이므로 timeout 을 worker 보다 먼저 본다.
export function classifyTurnFailure(raw: string): FailureKind {
  if (/error_max_turns|max[_ ]?turns/i.test(raw)) return "max_turns";
  if (/overloaded|\b529\b|rate[_ ]?limit|\b429\b|too many requests/i.test(raw)) return "busy";
  if (/응답하지 않았어요|timed? ?out|timeout/i.test(raw)) return "timeout";
  if (/워커/.test(raw)) return "worker";
  return "other";
}

// max_turns 만 "이어서" 를 말한다 — 그 실패는 세션이 유효한 채 끝난 것이라 코어가 세션을 저장해 두고(core.ts 의 실패 경로),
// 다음 턴이 그 자리에서 이어받는다. 시간 상한·워커 연결 실패는 세션 id 가 돌아오지 않을 수 있어 약속하지 않는다.
const FAILURE_TEXT: Record<FailureKind, string> = {
  max_turns: '작업 단계가 한 번에 할 수 있는 상한에 닿아 멈췄어요. 여기까지 한 일은 이어지니 "이어서 해줘" 라고 하면 계속합니다.',
  busy: "지금 모델 서버가 붐벼서 처리하지 못했어요. 잠시 뒤 다시 시도해 주세요.",
  timeout: "작업이 시간 상한을 넘겨 멈췄어요. 일을 나눠서 다시 시켜 주세요.",
  worker: "작업하던 동아리 PC 와의 연결에 문제가 생겨 멈췄어요. 잠시 뒤 다시 시도해 주세요.",
  other: "처리하다 오류가 나서 끝내지 못했어요. 잠시 뒤 다시 시도해 주세요.",
};

const RAW_MAX = 300;

export function describeTurnFailure(raw: string, o: { showRaw: boolean }): string {
  const text = FAILURE_TEXT[classifyTurnFailure(raw)];
  if (!o.showRaw) return text;
  const flat = raw.replace(/\s+/g, " ").trim();
  const clipped = flat.length > RAW_MAX ? `${flat.slice(0, RAW_MAX)}…` : flat;
  return `${text}\n(원문: ${clipped})`;
}
