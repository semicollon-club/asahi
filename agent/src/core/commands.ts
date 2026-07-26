import type { DigestTopic } from "./digest.js";

// 소유자(또는 허용 사용자)가 대화에서 세션을 수동으로 초기화하는 예약어 명령을 판별하는 순수 함수.
// 앞 슬래시를 요구해 일반 대화와 확실히 구분한다(대소문자·앞뒤 공백 무시, 정확히 일치할 때만).
// 배경: 활발히 쓰는 DM 은 같은 SDK 세션을 계속 resume 하는데, resume 은 세션 생성 시점의
// 시스템 프롬프트를 유지한다. 페르소나가 바뀌어도 세션이 새로 시작되기 전엔 반영되지 않으므로,
// 소유자가 직접 새 세션을 시작할 수 있게 한다(core.ts ingest 에서 이 결과를 처리).

const RESET_COMMANDS = new Set(["/새세션", "/새대화", "/새로시작", "/reset"]);

export type SessionCommand = "reset";

export function parseSessionCommand(text: string): SessionCommand | null {
  const t = text.trim().toLowerCase();
  return RESET_COMMANDS.has(t) ? "reset" : null;
}

// 정기 게시를 즉시 실행하는 예약어. 세션 예약어와 같은 규칙 — 앞 슬래시를 요구하고
// 앞뒤 공백을 무시한 뒤 정확히 일치할 때만 인식한다(일반 대화와 확실히 구분).
const DIGEST_COMMANDS: Record<string, DigestTopic> = {
  "/대회": "contest",
  "/개발뉴스": "devnews",
};

export function parseDigestCommand(text: string): DigestTopic | null {
  return DIGEST_COMMANDS[text.trim().toLowerCase()] ?? null;
}
