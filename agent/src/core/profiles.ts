// 신원 → 세션 프로필(풀 하네스 설계 §6, 2단계 2.4). 봇이 turn.start 에 실어 보내고, 세션 러너(remote/sessionRunner.ts)가
// 그대로 Agent SDK query() 옵션으로 옮긴다. 지금 allowedToolsFor(tools.ts)가 하는 일 — "누가 무엇을 쓸 수 있는가" — 의
// 하네스 판이다. 2단계에서 새 경로를 타는 것은 소유자 턴뿐이지만 네 신원을 모두 정의해 둔다: 5단계(부원 개방)가 이 표를
// 그대로 쓰고, 그때 손님 기본값(§5 — 서브에이전트 끔·effort 낮음·Sonnet 5)이 "한 사람이 5시간 창을 비우지 못하게" 하는
// 첫 지렛대가 된다(§4.3).
//
// 모델 고정의 집행은 3단계(프록시가 본문 model 을 이 프로필과 대조)다. 허브 MCP 는 4단계 — 아래 mcpHub 로
// "어느 봇 허브 MCP 서버를 이 신원에 여는가"를 정한다. 플러그인 목록은 아직(4.4).
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
  // 봇 허브 MCP 서버 이름들(4단계 4.1). 비밀이 필요한 서버를 신원별로 연다 — 소유자는 GitHub+Supabase,
  // 손님은 Supabase(DB 읽기)만이다(ADR 0010). 워커가 이름마다 루프백 주소·작업 토큰을 붙인다.
  mcpHub?: string[];
};

// 소유자 하네스 턴에 여는 허브 MCP 서버(4단계). GitHub(읽기, 4.1)·Supabase(읽기, 4.2). Railway 는 보류 —
// 봇에 Railway API 자격증명이 없고(호스트로만 썼다) 5단계에서 종료 예정이라, 필요해지면 토큰을 받아 더한다.
export const OWNER_MCP_HUB = ["github", "supabase"] as const;

// 손님 하네스 턴에 여는 허브 MCP 서버(ADR 0010, 2026-09-17). DB 읽기만 연다 — 봇 세션 경로에서
// db_schema/db_query 가 신원을 보지 않게 됐으므로, 하네스 경로만 닫아 두면 "같은 사람이 같은 채널에서
// 물어도 어느 경로로 갔느냐에 따라 답이 갈리는" 어긋남이 그대로 남는다. GitHub 허브는 넣지 않는다 —
// 그건 DB 정책과 다른 축(설치 토큰)이고, 부원의 깃허브 작업은 셸 git 자격증명이 이미 받친다.
//
// 5단계(부원 하네스 개방) 전까지 이 값이 실제로 쓰이는 경로는 없다 — decideHarnessDispatch(core/agent.ts)가
// 아직 소유자 턴만 하네스로 보낸다. 그때가 오면 이 한 줄이 이미 맞는 자리에 있다.
export const GUEST_MCP_HUB = ["supabase"] as const;

export const GUEST_MODEL = "claude-sonnet-5";
// 봇 자기 세션의 maxTurns(agent.ts)와 같은 값 — 하네스라고 한 턴이 더 길어질 이유는 없다.
// 2026-09-17: 30 → 60. 그리고 이 상수는 이제 "설정이 없을 때의 폴백"이다 — 정상 경로에서는
// config.sessionMaxTurns(env SESSION_MAX_TURNS)가 agent.ts 를 거쳐 여기 profileFor 의 maxTurns
// 인자로 내려온다. 30 이었을 때 파일 여러 개를 고치는 작업이 반복해서 중간에 끊겼다(실측).
export const DEFAULT_MAX_TURNS = 60;

export function profileFor(
  ctx: { isOwner: boolean; isPrivate: boolean; role: string },
  o: { ownerModel: string; maxTurns?: number },
): HarnessProfile {
  const maxTurns = o.maxTurns ?? DEFAULT_MAX_TURNS;
  // 소유자는 DM·서버 구분 없이 전부다 — 운영자 모델(config.model, 기본 Opus 5)·기본 effort·서브에이전트 열림·허브 MCP.
  if (ctx.isOwner) return { model: o.ownerModel, maxTurns, subagents: true, mcpHub: [...OWNER_MCP_HUB] };
  return { model: GUEST_MODEL, effort: "low", maxTurns, subagents: false, mcpHub: [...GUEST_MCP_HUB] };
}
