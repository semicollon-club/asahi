import crypto from "node:crypto";

// 작업 토큰(풀 하네스 설계 §4.2, 0단계 0.1). 봇이 한 턴(작업)에 대해 발급하고 봇만 검증한다 — 지금은
// 워커의 send_file 이 봇의 POST /files 를 인증하는 데 쓰고, 2단계부터는 세션 계정의 Claude Code 가
// ANTHROPIC_AUTH_TOKEN 자리에 들고 프록시를 인증하는 데 그대로 쓴다. 토큰이 말하는 것은 딱 넷이다 —
// 어느 작업(jobId)·어느 부원(userId)·어느 대화(conversationId)와 그 대화의 채널(channelRef)·언제까지(exp).
// 진짜 자격증명(디스코드 토큰·구독 OAuth·깃허브 App 키)은 어디에도 들어 있지 않다: 이 토큰을 손에 넣어도
// 할 수 있는 일은 "그 대화 채널에 첨부를 올리는 것"이 전부이고, 그것도 봇의 루프백/공개 엔드포인트를
// 거쳐야 하며 2시간이면 죽는다(설계 §9 의 탈취 표가 이 전제 위에 있다).
//
// 비밀은 부팅마다 난수다 — 발급과 검증이 같은 프로세스라 설정(환경변수)이 필요 없고, 재시작하면 이전
// 토큰이 전부 무효가 되는 것이 오히려 바람직하다(재시작 전에 나간 작업은 어차피 끝났다). 형식은
// `asahi-job.<base64url(JSON 클레임)>.<base64url(HMAC-SHA256)>` — JWT 를 쓰지 않는 이유는 alg 협상·
// 라이브러리 의존 같은 표면을 만들 이유가 없기 때문이다. 클레임은 평문(base64)이라 누구나 읽을 수
// 있지만 바꿀 수는 없다 — 서명이 payload 문자열 전체에 걸려 있고, 검증은 서명이 맞은 뒤에야 JSON 을 연다.
export type JobTokenClaims = {
  jobId: string;
  userId: string;
  conversationId: number;
  channelRef: string;
  // 만료 시각(ms since epoch). `now >= exp` 면 만료다 — 경계에서 유효하지 않다(jobToken.test.ts).
  exp: number;
};

export type JobTokenInput = Omit<JobTokenClaims, "jobId" | "exp">;

// 2시간(설계 §4.2). 한 턴이 이보다 오래 가는 일은 없고(SDK maxTurns·허브 120초 호출 타임아웃), 길어질수록
// 새어 나간 토큰의 수명이 늘 뿐이다.
export const JOB_TOKEN_TTL_MS = 2 * 60 * 60 * 1000;

const PREFIX = "asahi-job";

export function newJobTokenSecret(): Buffer {
  return crypto.randomBytes(32);
}

export function newJobId(): string {
  return crypto.randomBytes(12).toString("base64url");
}

function sign(secret: Buffer, payload: string): string {
  return crypto.createHmac("sha256", secret).update(payload).digest("base64url");
}

export function mintJobToken(secret: Buffer, claims: JobTokenClaims): string {
  const payload = Buffer.from(JSON.stringify(claims), "utf8").toString("base64url");
  return `${PREFIX}.${payload}.${sign(secret, payload)}`;
}

// 서명이 맞아도 모양이 틀린 payload 는 거절한다 — 같은 비밀로 서명된 다른 용도의 값이 여기로 흘러들
// 가능성을 남기지 않는다.
function isClaims(v: unknown): v is JobTokenClaims {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.jobId === "string" &&
    typeof o.userId === "string" &&
    typeof o.conversationId === "number" && Number.isInteger(o.conversationId) &&
    typeof o.channelRef === "string" &&
    typeof o.exp === "number" && Number.isFinite(o.exp)
  );
}

// 형식·서명·모양·만료 중 하나라도 어긋나면 null. 예외를 던지지 않는다 — 호출측(POST /files)은 이 값
// 하나로 401 을 정한다.
export function verifyJobToken(secret: Buffer, token: string, now: number): JobTokenClaims | null {
  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== PREFIX) return null;
  const [, payload, sig] = parts;
  if (payload.length === 0 || sig.length === 0) return null;
  // 길이가 다르면 timingSafeEqual 이 던지므로 먼저 거른다 — 길이 비교 자체는 비밀을 새지 않는다(서명
  // 길이는 알고리즘으로 정해진 공개 상수다).
  const given = Buffer.from(sig, "utf8");
  const expected = Buffer.from(sign(secret, payload), "utf8");
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (!isClaims(parsed)) return null;
  if (now >= parsed.exp) return null;
  // 알려진 필드만 돌려준다 — payload 에 덧붙은 키가 호출측으로 새지 않게.
  return { jobId: parsed.jobId, userId: parsed.userId, conversationId: parsed.conversationId, channelRef: parsed.channelRef, exp: parsed.exp };
}

// 발급기. tools.ts 의 ToolCtx 가 드는 것은 이 mint 하나뿐이다 — 검증은 index.ts 가 POST /files 에 배선한다.
export type JobTokenMinter = { mint(input: JobTokenInput): string };

export function makeJobTokenMinter(
  secret: Buffer,
  opts: { ttlMs?: number; now?: () => number } = {},
): JobTokenMinter & { verify(token: string): JobTokenClaims | null } {
  const ttlMs = opts.ttlMs ?? JOB_TOKEN_TTL_MS;
  const now = opts.now ?? Date.now;
  return {
    mint: (input) => mintJobToken(secret, { ...input, jobId: newJobId(), exp: now() + ttlMs }),
    verify: (token) => verifyJobToken(secret, token, now()),
  };
}
