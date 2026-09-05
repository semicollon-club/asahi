// 신원 → 세션 프로필(풀 하네스 설계 §6, 2단계 2.4). 봇이 turn.start 에 실어 보내고, 세션 러너(remote/sessionRunner.ts)가
// 그대로 Agent SDK query() 옵션으로 옮긴다. 지금 allowedToolsFor(tools.ts)가 하는 일 — "누가 무엇을 쓸 수 있는가" — 의
// 하네스 판이다. 2단계에서 새 경로를 타는 것은 소유자 턴뿐이지만 네 신원을 모두 정의해 둔다: 5단계(부원 개방)가 이 표를
// 그대로 쓰고, 그때 손님 기본값(§5 — 서브에이전트 끔·effort 낮음·Sonnet 5)이 "한 사람이 5시간 창을 비우지 못하게" 하는
// 첫 지렛대가 된다(§4.3).
//
// 이 표에 없는 것: MCP 서버·플러그인 목록(4단계 — 허브 MCP 가 생길 때 필드를 더한다), 모델 고정의 집행(3단계 — 프록시가
// 본문의 model 을 이 프로필과 대조한다). 지금 이 값은 세션 러너가 query() 의 model 로 넘기는 것까지다.
export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

export type HarnessProfile = {
  model: string;
  maxTurns: number;
  // Task(서브에이전트) 도구를 열지. 손님은 끈다 — 세션 하나가 여러 모델 호출을 병렬로 벌려 창을 비우는 가장 빠른 길이다.
  subagents: boolean;
  // 없으면 모델 기본값(운영자). 손님은 low.
  effort?: Effort;
  // 내장 도구 허용 목록. 없으면 Claude Code 기본 전부(§6 표의 "전부").
  tools?: string[];
};

export const GUEST_MODEL = "claude-sonnet-5";
// 봇 자기 세션의 maxTurns(agent.ts)와 같은 값 — 하네스라고 한 턴이 더 길어질 이유는 없다.
export const DEFAULT_MAX_TURNS = 30;

export function profileFor(
  ctx: { isOwner: boolean; isPrivate: boolean; role: string },
  o: { ownerModel: string; maxTurns?: number },
): HarnessProfile {
  const maxTurns = o.maxTurns ?? DEFAULT_MAX_TURNS;
  // 소유자는 DM·서버 구분 없이 전부다 — 운영자 모델(config.model, 기본 Opus 5)·기본 effort·서브에이전트 열림.
  if (ctx.isOwner) return { model: o.ownerModel, maxTurns, subagents: true };
  return { model: GUEST_MODEL, effort: "low", maxTurns, subagents: false };
}
