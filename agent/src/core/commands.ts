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

// FIX1(치명, 머지 전 리뷰) — DIGEST_COMMANDS 는 평범한 객체 리터럴이라 `DIGEST_COMMANDS[key] ?? null`
// 는 key 가 "constructor"·"__proto__"·"toString"·"hasOwnProperty"·"valueOf" 처럼 Object.prototype
// 이 물려주는 이름이면 그 상속된(모두 truthy 한) 값을 그대로 돌려준다 — `??`는 null/undefined 에만
// 반응하므로 걸러내지 못한다. isChannelCommand 를 거쳐 decideRoute 까지 이 값이 올라가면, 손님이
// 그냥 "constructor" 라고만 쳐도 채널 명령으로 오인식돼 조사가 시작되려다 실패했다(리뷰 재현).
// Object.hasOwn 으로 그 객체 "자신의" 키인지 먼저 확인해 상속 키는 애초에 조회하지 않는다.
export function parseDigestCommand(text: string): DigestTopic | null {
  const key = text.trim().toLowerCase();
  return Object.hasOwn(DIGEST_COMMANDS, key) ? DIGEST_COMMANDS[key] : null;
}

// 예약어 목록 안내(/help). 세션·조사 예약어와 같은 규칙 — 앞 슬래시를 요구하고 앞뒤 공백·대소문자를
// 무시한 뒤 정확히 일치할 때만 인식한다(일반 대화와 확실히 구분).
const HELP_COMMANDS = new Set(["/help", "/도움말", "/명령어"]);

export function parseHelpCommand(text: string): boolean {
  return HELP_COMMANDS.has(text.trim().toLowerCase());
}

// 대화(스레드·DM) 없이 일반 채널에서 그 자리에서 처리할 수 있는 예약어인가.
//
// 배경: 어댑터는 일반 채널의 멘션 없는 메시지를 전부 무시한다(decideRoute). 무시하지 않으려면
// 그 채널을 대화로 채택해야 하는데, 그러면 conversations 행이 생겨 이후 그 채널의 모든 메시지에
// 봇이 답하기 시작한다. 그래서 "대화를 만들지 않고 그 자리에서 끝나는 명령"만 따로 통과시킨다.
//
// /새세션 은 제외한다 — 초기화할 세션이 있어야 의미가 있고, 대화가 없는 채널에는 리셋할 대상
// 자체가 없다(스레드·DM 안에서는 지금까지처럼 그대로 동작한다).
export function isChannelCommand(text: string): boolean {
  return parseHelpCommand(text) || parseDigestCommand(text) !== null;
}

// 안내문은 위 예약어 테이블에서 파생시킨다. 손으로 적으면 예약어를 추가하는 순간
// 조용히 어긋나고, 그 어긋남은 아무도 눈치채지 못한다(테스트가 이 일치를 검증한다).
export const COMMAND_HELP: ReadonlyArray<{ commands: readonly string[]; description: string }> = [
  { commands: [...RESET_COMMANDS], description: "대화를 새 세션으로 시작한다. 성격이나 설정이 바뀐 뒤에 쓴다" },
  // FIX6(사소, 머지 전 리뷰): 결과가 항상 "대회 소식 채널"에 올라가는 건 아니다 — DM 에서 부르거나
  // 지정 채널(DIGEST_CONTEST_CHANNEL_ID 등)이 설정돼 있지 않으면 명령을 친 곳에 그대로 온다
  // (core.ts 의 startDigestCommand). 조건부 목적지를 그대로 반영해 안내문이 실제 동작과 어긋나지
  // 않게 한다.
  { commands: ["/대회"], description: "코딩·CTF 대회 소식을 지금 조사한다. 지정 채널이 있으면 그리로, DM이거나 없으면 여기로 온다" },
  { commands: ["/개발뉴스"], description: "개발 관련 소식을 지금 조사한다. 지정 채널이 있으면 그리로, DM이거나 없으면 여기로 온다" },
  { commands: [...HELP_COMMANDS], description: "이 목록을 보여준다" },
];

// 손님용 능력 안내. /help 는 손님도 보므로(예약어가 없는 부원도 이 목록으로 먼저 안내받는다),
// 예약어처럼 정확히 쳐야 하는 게 아니라 자연어로 시키면 되는 것들을 짧게 덧붙인다. 도구가
// 있어도 "그렇게 물어봐도 된다"는 걸 모르면 안 쓰인다 — 이 목록이 그 구멍을 메운다.
// 소유자 전용 도구(manage_access·db_query·allow_dir 등)는 여기 넣지 않는다 — 손님에게는
// 못 쓰는 기능을 알려줘봤자 혼란만 준다.
const GUEST_TIPS = [
  "이런 것도 말로 시키면 돼:",
  "- 내 폴더에 뭐 있는지 보여줘 — 작업 폴더 구조를 그대로 훑어서 알려줘",
  "- 파일 만들어줘 / 읽어줘 / 고쳐줘 — 네 작업 폴더 안에서",
  "- 명령 실행해줘 — 예: 테스트 돌려줘, 빌드해줘",
].join("\n");

export function renderCommandHelp(): string {
  const lines = COMMAND_HELP.map((g) => `- ${g.commands.join(" · ")} — ${g.description}`);
  return `쓸 수 있는 명령어야.\n\n${lines.join("\n")}\n\n${GUEST_TIPS}\n\n그 외에는 그냥 말 걸면 돼.`;
}
