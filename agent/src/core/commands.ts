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
  { commands: ["/대회"], description: "코딩·CTF 대회 소식을 지금 조사한다. 결과는 대회 소식 채널에 올라간다" },
  { commands: ["/개발뉴스"], description: "개발 관련 소식을 지금 조사한다. 결과는 개발 뉴스 채널에 올라간다" },
  { commands: [...HELP_COMMANDS], description: "이 목록을 보여준다" },
];

export function renderCommandHelp(): string {
  const lines = COMMAND_HELP.map((g) => `- ${g.commands.join(" · ")} — ${g.description}`);
  return `쓸 수 있는 명령어야.\n\n${lines.join("\n")}\n\n그 외에는 그냥 말 걸면 돼.`;
}
