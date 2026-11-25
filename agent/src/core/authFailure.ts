// 구독 인증 실패 판정과 그 안내 문구(2026-11-25 설계 §1.1).
//
// 배경: 2026-11-25 봇의 구독 토큰(CLAUDE_CODE_OAUTH_TOKEN)이 Anthropic 쪽에서 폐기돼 모든 턴이
// "401 OAuth access token has been revoked" 로 실패했다. 말을 건 사람마다 원문 오류만 받았고, 소유자에게 따로
// 알리는 장치가 없어 누군가 직접 알려 주기 전까지 아무도 몰랐다 — 워커 부재 경보(staleWorker.ts)는 있지만
// 이 실패는 워커와 무관하게 봇 자신의 자격증명에서 난다.
//
// 판정은 문자열이다. SDK 는 실패를 "Claude Code returned an error result: <원문>" 으로 던지거나 결과 문구에 싣고,
// 하네스 턴은 러너가 같은 원문을 turn.result 의 error 로 보낸다 — 두 경로 모두 업스트림 원문이 그대로 남는다.

// 업스트림(api.anthropic.com·Claude Code)이 인증을 거절할 때 내는 문구들. 넓게 잡으면 거짓 경보가 되고(한도·
// 과부하는 기다리면 풀린다), 좁게 잡으면 다음 장애를 또 놓친다 — 실제로 본 문구와 같은 계열만 둔다.
//
// 2026-11-25 리뷰: Claude Code 는 비대화(SDK) 모드에서 일부 인증 오류를 자기 문구로 바꿔 내보낸다 — 403 토큰 폐기는
// "Your account does not have access to Claude…", API 키가 아닌 자격증명의 x-api-key 오류는 "Not logged in · Please run
// /login" 이 된다. 봇 프록시가 구독 자격증명 자체를 못 찾을 때(봇 .env 에 토큰이 없음)의 503 문구도 소유자가 고칠 일이다.
const AUTH_FAILURE_PATTERNS = [
  /Failed to authenticate/i,
  /OAuth (?:access )?token (?:has been revoked|has expired|is expired|is invalid|revoked)/i,
  /invalid x-api-key/i,
  /Invalid API key/i,
  /authentication_error/i,
  /does not have access to Claude/i,
  /Please run \/login/i,
  /Login expired/i,
  /구독 자격증명이 없어요/,
];

// 봇의 인증 프록시(llmProxy.ts)가 작업 토큰을 거부할 때도 type 은 authentication_error 다. 그건 구독 토큰이
// 아니라 턴마다 발급하는 작업 토큰의 문제(봇 재시작으로 서명 비밀이 바뀐 직후 등)라 소유자가 할 일이 없다.
const JOB_TOKEN_MARKER = "작업 토큰";

export function isAuthFailure(text: string): boolean {
  if (text.length === 0 || text.includes(JOB_TOKEN_MARKER)) return false;
  return AUTH_FAILURE_PATTERNS.some((re) => re.test(text));
}

// 같은 장애로 매 턴 DM 이 쌓이면 정작 읽히지 않는다. 고칠 때까지 대개 몇 시간이 걸리므로 그 사이 한두 번이면
// 충분하다. 상태는 봇 프로세스 메모리에만 둔다 — 재시작하면 한 번 더 오는 정도는 받아들인다.
export const AUTH_ALERT_COOLDOWN_MS = 6 * 60 * 60 * 1000;

export function shouldAlertOwner(lastAlertAt: number | null, now: number, cooldownMs: number = AUTH_ALERT_COOLDOWN_MS): boolean {
  return lastAlertAt === null || now - lastAlertAt >= cooldownMs;
}

const RAW_MAX = 300;

function clip(raw: string): string {
  const chars = [...raw.trim()];
  return chars.length > RAW_MAX ? `${chars.slice(0, RAW_MAX).join("")}…` : chars.join("");
}

// 소유자가 할 일. 절차의 정본은 deploy/minipc-단일호스트-셋업.md(.env 이관·재시작)다 — 여기서는 그 첫 걸음만 적는다.
const OWNER_ACTION =
  "구독 계정으로 로그인된 PC 에서 `claude setup-token` 으로 새 토큰을 발급해 봇 .env 의 CLAUDE_CODE_OAUTH_TOKEN 을 바꾸고 봇을 재시작하세요.";

// 그 턴을 시킨 사람에게 보내는 안내. 부원에게는 원문을 싣지 않는다 — 부원이 할 수 있는 일이 없고, 영문 오류가
// "내가 뭘 잘못했나"로 읽힌다. 소유자에게는 원문이 곧 진단이다.
export function authFailureUserNotice(isOwner: boolean, raw: string): string {
  if (isOwner) return `Claude 구독 인증이 실패했어요(토큰이 폐기됐거나 만료됐을 수 있어요). ${OWNER_ACTION}\n원문: ${clip(raw)}`;
  return "지금 아사히의 Claude 구독 인증이 실패해서 답할 수 없어요. 운영자에게 알렸어요 — 고쳐지면 다시 말 걸어 주세요.";
}

// 소유자 DM 으로 가는 경보 한 줄. 다른 사람의 턴에서 난 실패라 소유자는 그 대화를 보지 못했을 수 있다.
export function authFailureOwnerAlert(raw: string): string {
  return `Claude 구독 인증 실패로 대화가 처리되지 않고 있어요. ${OWNER_ACTION}\n원문: ${clip(raw)}`;
}
