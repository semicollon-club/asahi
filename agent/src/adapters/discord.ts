import {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelType, Client, GatewayIntentBits, MessageReferenceType, Partials,
  ThreadAutoArchiveDuration, type Interaction, type Message,
} from "discord.js";
import type { EventBus, ConversationHint, ProgressKind } from "../events/bus.js";
import type { Config } from "../config.js";
import type { UsersRepo, Role } from "../store/usersRepo.js";
import type { ConversationsRepo } from "../store/conversationsRepo.js";
import { filterImageAttachments, type ImageRef } from "../core/images.js";
import { filterFileAttachments, type FileRef } from "../core/attachments.js";
import { isChannelCommand, isReservedCommand, parseCancelCommand } from "../core/commands.js";

// 줄바꿈 단위 분할(펜스를 모른다). 펜스가 없는 본문은 이 결과가 그대로 나간다 — chunkMessage 가 펜스를 다룰 때도
// 자르는 일 자체는 이 함수가 하고, 그 위에서 펜스만 닫고 다시 연다.
export function chunkLines(text: string, max = 2000): string[] {
  const chunks: string[] = [];
  let rest = text;
  while (rest.length > 0) {
    if (rest.length <= max) {
      chunks.push(rest);
      break;
    }
    let cut = rest.lastIndexOf("\n", max);
    if (cut <= 0) {
      cut = max;
      // 강제 절단이 서로게이트 쌍(이모지 등 4바이트 문자) 중간을 가르지 않도록 한 칸 앞으로 당긴다.
      const hi = rest.charCodeAt(cut - 1);
      const lo = rest.charCodeAt(cut);
      if (cut > 1 && hi >= 0xd800 && hi <= 0xdbff && lo >= 0xdc00 && lo <= 0xdfff) cut -= 1;
    }
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n/, "");
  }
  return chunks;
}

// 빠른 개선 1.2(2026-11-25 설계): 긴 답이 코드블록 중간에서 잘리면 앞 메시지는 블록이 닫히지 않고 뒤 메시지는
// 코드가 본문으로 보인다. 펜스가 있는 본문만 여유분을 남기고 자른 뒤, 열린 채 끝나는 조각은 닫고 다음 조각 앞에
// 같은 여는 줄을 붙인다. 여유분 = 다시 여는 줄(``` + 표기 최대 FENCE_INFO_MAX) + 줄바꿈 + 닫는 줄바꿈·```.
export const FENCE_RESERVE = 24;
const FENCE_INFO_MAX = 16;

export function chunkMessage(text: string, max = 2000): string[] {
  if (!text.includes("```")) return chunkLines(text, max);
  const out: string[] = [];
  let reopen: string | null = null;
  for (const piece of chunkLines(text, max - FENCE_RESERVE)) {
    const body: string = reopen === null ? piece : `${reopen}\n${piece}`;
    const open = openFenceAtEnd(body);
    out.push(open === null ? body : `${body}\n\`\`\``);
    reopen = open;
  }
  return out;
}

// 본문 끝에서 코드블록이 열려 있으면 그 블록을 다시 열 줄(언어 표기 포함)을, 닫혀 있으면 null 을 돌려준다.
// 한 줄 안에서 열고 닫는 ```코드``` 는 블록 상태를 바꾸지 않는다. 표기가 길거나 백틱이 섞이면 표기 없이 다시 연다 —
// 여유분(FENCE_RESERVE)을 넘기지 않는 것이 하이라이트보다 중요하다.
function openFenceAtEnd(s: string): string | null {
  let open: string | null = null;
  for (const line of s.split("\n")) {
    const t = line.trimStart();
    if (!t.startsWith("```")) continue;
    if (t.length > 3 && t.slice(3).includes("```")) continue;
    if (open === null) {
      const info = t.slice(3).trim();
      open = info.length > 0 && info.length <= FENCE_INFO_MAX && !info.includes("`") ? `\`\`\`${info}` : "```";
    } else {
      open = null;
    }
  }
  return open;
}

// 빠른 개선 1.3: 봇 자신의 멘션(<@id>·<@!id>)은 프롬프트와 스레드 이름에서 뺀다 — 모델에게는 잡음이고, 스레드
// 이름에는 숫자 ID 가 그대로 보였다. 다른 사람의 멘션은 남긴다: 소유자가 "@이름 부원으로 추가해줘" 라고 하면
// 모델은 그 안의 숫자 ID 로 manage_access 를 부른다. 공백 정리는 앞뒤만 한다 — 본문 안(코드 들여쓰기 등)은 건드리지 않는다.
export function stripBotMention(text: string, botId: string): string {
  const id = botId.replace(/[^0-9A-Za-z]/g, "");
  return text.replace(new RegExp(`<@!?${id}>`, "g"), "").trim();
}

// 봇 메시지에 대한 **핑이 켜진** 답장인가(빠른 개선 1.3). discord.js 는 repliedUser 를 핑 여부와 무관하게 답장 대상의
// 작성자로 채운다(Message.js — referenced_message.author) — 그것만 보면 핑을 끄고 남들과 이야기하려던 답장까지 봇을
// 부른다(2026-11-25 리뷰). 핑이 켜진 답장일 때만 그 사람이 mentions.users 에 들어 있다.
type ReplyMentionLike = { repliedUser?: { id: string } | null; users?: { has(id: string): boolean } };
export function detectReplyToBot(mentions: ReplyMentionLike, botId: string): boolean {
  return mentions.repliedUser?.id === botId && mentions.users?.has(botId) === true;
}

// 답장 대상 한 덩어리. 답장은 같은 채널 안에서만 가능하므로 다른 채널의 내용이 이 경로로 새지 않는다(전달된 메시지는
// 다른 채널 것이라 인용하지 않는다 — onMessage 의 reference.type 확인). 상한은 대상이 봇의 긴 답(최대 수천 자)일 때
// 프롬프트를 그 원문으로 채우지 않기 위한 것이다 — 앞부분이면 무엇에 대한 답장인지 알기에 충분하다.
//
// 인용은 신뢰할 수 없는 자료다(2026-11-25 리뷰): 평소 모델에 닿지 못하는 미등록자의 글도, 소유자가 거기에 답장하면 소유자
// 턴(manage_access·db_query·셸이 열린 턴)에 들어간다. 그래서 (1) 한 줄로 펴고 대괄호를 바꿔 인용 안의 글이 프롬프트의
// 구조(구분선·화자 표기)를 흉내 내지 못하게 하고, (2) 작성자의 신분을 어댑터가 판정한 태그로 붙인다 — 표시 이름은
// 아무나 "아사히(운영자)" 로 바꿀 수 있지만 태그는 그 사람이 고칠 수 없다.
export const REPLY_QUOTE_MAX = 500;
const QUOTE_NAME_MAX = 32;
export type QuoteAuthorTag = "봇" | "운영자" | "부원" | "미등록";

function flattenForQuote(s: string, max: number): string {
  const flat = s.replace(/\s+/g, " ").replace(/\[/g, "(").replace(/\]/g, ")").trim();
  const chars = [...flat];
  return chars.length > max ? `${chars.slice(0, max).join("")}…` : flat;
}

export function buildReplyQuote(o: { authorName: string; authorTag: QuoteAuthorTag; content: string }): string {
  const name = flattenForQuote(o.authorName, QUOTE_NAME_MAX);
  const body = flattenForQuote(o.content, REPLY_QUOTE_MAX) || "(본문 없음)";
  return `[답장 대상(인용) · ${o.authorTag} ${name}: ${body}]`;
}

type RawAttachment = { url: string; contentType: string | null; name: string; size: number };

// 빠른 개선 1.4: 첨부를 모델에 실을 이미지·워커에 내려놓을 파일·거절 사유로 나눈다. 예전엔 이미지 쪽 거절
// (형식 미지원·5MB 초과·장수 초과)이 이 자리에서 버려져, 그 이미지는 안내도 마커도 없이 사라졌다 — 파일 쪽
// 거절은 이미 사유가 [파일 처리 실패: …] 마커로 모델에게 간다(core.ts 의 failedFiles). 같은 목록에 합친다.
export function sortAttachments(atts: RawAttachment[]): { images: ImageRef[]; files: FileRef[]; rejected: string[] } {
  const { images, skipped: skippedImages } = filterImageAttachments(atts);
  const { files, skipped: skippedFiles } = filterFileAttachments(atts);
  return { images, files, rejected: [...skippedImages, ...skippedFiles] };
}

// 본문이 비어 아무것도 못 보내는 경우의 최소 응답. 조용히 아무 것도 안 나가면 finishStatus 가
// 그대로 완료 반응(✅)을 달아 "성공했지만 무응답"이 된다 — 이 저장소가 반복해서 고쳐 온 실패
// 모드라 표정이 사라져도 이 방어선은 남긴다.
export const SEND_EMPTY_FALLBACK = "이번엔 드릴 답을 만들지 못했어요. 다시 한 번 말씀해 주세요.";

// 손님 DM 에 돌려주는 한 줄(decideRoute 의 dm-declined). 조용히 무시하지 않는 이유는 SEND_EMPTY_FALLBACK 과
// 같다 — 아무 반응이 없으면 사람은 봇이 고장 났다고 읽는다. 이유까지 한 문장에 담아 "왜 안 되는지 물어보러
// 또 DM 하는" 왕복을 없앤다. LLM 턴도 대화 행도 만들지 않으므로 비용은 메시지 하나뿐이다.
export const DM_DECLINED_NOTICE =
  "DM 으로는 답하지 않아요. 동아리 서버 채널에서 저를 불러 주세요 — 제가 하는 일은 동아리 작업이라 다들 보이는 곳에 남아야 하거든요.";

// 텍스트를 디스코드 상한에 맞춰 나눈다. send() 는 이 결과를 그대로 실행만 한다 —
// 판단을 여기로 몰아야 디스코드 채널 없이 테스트할 수 있다.
export function planSend(text: string): { chunks: string[] } {
  return { chunks: text.length > 0 ? chunkMessage(text) : [] };
}

// ── 순수 라우팅 결정 (테스트 용이) ──────────────────────────────────────────
// 인입 메시지 + 발화자 role + 이 채널에 대화 행 존재여부 → 무엇을 할지.
export type Incoming = {
  userId: string; channelId: string; isDM: boolean; isThread: boolean; mentionsBot: boolean;
  // 빠른 개선 1.3: 봇의 메시지에 대한 답장(핑이 켜진 답장 — mentions.repliedUser 가 봇). 직접 멘션과 같이 "부르는
  // 것"으로 본다. 선택 필드인 이유는 이 값을 모르는 호출측(기존 테스트 픽스처 등)이 지금처럼 동작하게 하기 위해서다.
  repliesToBot?: boolean;
  guildId?: string; parentChannelId?: string; content: string; messageId: string;
  images: ImageRef[];
  files: FileRef[];
  // 거절된 첨부의 사유 문자열(예: "big.pdf(너무 큼)", "scan.tiff(지원 안 하는 형식)"). 최종 리뷰
  // Important — 예전엔 이 값을 어디서도 읽지 않아 크기 초과·이름 위험·개수 초과로 거절된
  // 첨부가 마커도 안내도 로그도 없이 사라졌다. 2026-11-25(빠른 개선 1.4)부터 이미지 쪽 거절도 여기에
  // 함께 실린다(sortAttachments).
  rejectedFiles: string[];
};
export type RouteDecision =
  | { kind: "ignore" }            // 게이트 탈락 / 관심 없는 메시지
  | { kind: "dm" }                // 그 사용자 DM 대화
  | { kind: "dm-declined" }       // 손님 DM — 한 줄 안내만 하고 끝(대화도 턴도 만들지 않는다)
  | { kind: "thread-existing" }   // 이미 conversations 행이 있는 스레드(또는 폴백 채널)
  | { kind: "thread-create" }     // 일반 채널 @멘션 → 새 스레드 생성
  | { kind: "adopt-thread" }      // 아직 대화 아닌 스레드에서 @멘션 → 그 스레드 채택
  | { kind: "channel-command" };  // 일반 채널의 예약어(멘션 없이) → 스레드도 대화도 만들지 않고 처리

export function decideRoute(i: Incoming, role: Role, hasConversation: boolean): RouteDecision {
  // 응답 게이트: owner/allowed 만. 미등록·blocked·컨텍스트 작성자 불문 무시.
  if (role !== "owner" && role !== "allowed") return { kind: "ignore" };
  // 손님 DM 은 받지 않는다(2026-09-07 운영자 결정, 위험 등록부 §10). 아사히는 부원별 비서가 아니라 동아리
  // 작업을 총괄하는 하나의 에이전트다 — 그렇다면 작업은 다들 보이는 곳에 남아야 하고, 운영자가 "무슨 대화를
  // 얼마나 했는지" 추적할 수 없는 통로를 열어 둘 이유가 없다. 디스코드 DM 창은 그 자체로 "둘만 본다"는 신호를
  // 주는데(그래서 사람들이 거기에 키·비밀번호를 붙여 넣는다) 실제로는 공용 기계에 전사가 남으므로, 안내문으로
  // 그 신호를 정정하는 대신 **통로 자체를 닫는다** — 얕은 벽을 세우고 설명하는 것보다 문을 없애는 쪽이다.
  // 소유자 DM 은 그대로다: 관리(manage_access·db_query)와 개인 워커 경로가 거기서 돈다.
  if (i.isDM) return role === "owner" ? { kind: "dm" } : { kind: "dm-declined" };
  // 부르는 방법은 둘 — 직접 멘션, 또는 봇 메시지에 대한 답장(빠른 개선 1.3). 정기 게시·알림에 답장으로 묻는 것이
  // 자연스러운데 그 길이 막혀 있었다. @everyone·역할 멘션은 여전히 부르는 것이 아니다(detectBotMention).
  const called = i.mentionsBot || i.repliesToBot === true;
  if (i.isThread) {
    if (hasConversation) return { kind: "thread-existing" }; // 봇 대화 지속(멘션 불필요)
    if (called) return { kind: "adopt-thread" };
    return { kind: "ignore" };
  }
  // 일반(비스레드) 채널
  if (hasConversation) return { kind: "thread-existing" };   // 스레드 생성 폴백으로 채택된 채널 등
  if (called) return { kind: "thread-create" };
  // 멘션 없는 예약어(/대회·/개발뉴스·/help): 지금까지는 여기서 무시돼 코어까지 닿지도 못했고,
  // 쓰려면 봇을 멘션해 스레드를 연 뒤 그 안에서 쳐야 했다 — 뉴스가 스레드에 갇혀 밖에서 안 보였다.
  // 대화를 만들지 않는 경로로 통과시킨다(commandOnly 힌트). 문자열 비교라 LLM 턴 비용은 없다.
  if (isChannelCommand(i.content)) return { kind: "channel-command" };
  return { kind: "ignore" };
}

// 봇이 "직접 @멘션" 되었는지만 판정한다. discord.js 의 기본 has(bot) 는 @everyone/@here·
// 역할 멘션·답장 자동멘션에도 true 를 돌려주므로, 그것들을 무시하도록 옵션을 명시한다
// (그렇지 않으면 @everyone 공지 하나에도 스레드가 생기고 LLM 턴이 소모된다).
type MentionLike = { has(target: unknown, options?: { ignoreEveryone?: boolean; ignoreRoles?: boolean; ignoreRepliedUser?: boolean }): boolean };
export function detectBotMention(mentions: MentionLike, bot: unknown): boolean {
  return mentions.has(bot, { ignoreEveryone: true, ignoreRoles: true, ignoreRepliedUser: true });
}

const THREAD_NAME_MAX = 90;

// ── 진행 상태 UI: 순수 로직 (테스트 용이) ──────────────────────────────────
// 처리중/완료 반응 이모지. 시스템 UI 용도이므로 답변 텍스트의 "이모티콘 금지" 정책과 무관.
export const PROCESSING_REACTION = "👀";
export const DONE_REACTION = "✅";

export const PROGRESS_EDIT_MIN_INTERVAL_MS = 800;

export type ThrottleDecision = { action: "now" } | { action: "later"; delayMs: number };

// 상태 메시지 편집을 지금 할지 미룰지 순수하게 판단한다.
// lastEditTs 가 없으면(첫 편집) 항상 즉시. 그 외엔 최소 간격을 채웠는지로 판단하고,
// 못 채웠으면 남은 시간만큼 지연시켜 트레일링 에지(마지막 상태는 반드시 반영)를 보장한다.
export function decideProgressEditThrottle(
  lastEditTs: number | null,
  now: number,
  minIntervalMs: number = PROGRESS_EDIT_MIN_INTERVAL_MS,
): ThrottleDecision {
  if (lastEditTs === null) return { action: "now" };
  const elapsed = now - lastEditTs;
  if (elapsed >= minIntervalMs) return { action: "now" };
  return { action: "later", delayMs: minIntervalMs - elapsed };
}

// N2 중지 버튼(2026-11-25 설계 §3). 이 봇의 첫 디스코드 상호작용이다 — 앱 명령과 달리 등록 없이 메시지에 붙여 쓴다.
// 누르면 onInteraction 이 cancel_request 를 내고, 권한 판정(시킨 사람·소유자)은 코어가 한다. 끝난 턴의 기록에서는
// finishStatus 가 버튼을 걷는다.
export const CANCEL_BUTTON_ID = "asahi:cancel";

function cancelRow(): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(CANCEL_BUTTON_ID).setLabel("중지").setStyle(ButtonStyle.Secondary),
  );
}

// 일반 채널에서 멘션과 함께 친 /취소. 멈출 턴은 스레드·DM 안에서만 돌므로 그 자리에는 대상이 없다 — 스레드를 새로
// 만들면 "/취소" 라는 이름의 빈 대화만 생긴다.
export const CANCEL_WHERE_NOTICE = "진행 중인 작업이 있는 스레드 안에서 /취소 를 쳐 주세요. 진행 표시의 중지 버튼을 눌러도 됩니다.";

// 디스코드 2000자 한도 보호용: 상태 메시지엔 최근 이 개수만큼만 표시한다.
export const PROGRESS_DISPLAY_MAX_LINES = 12;

// 연속으로 반복되는 라인(특히 "답변 작성 중")을 하나로 접는다. 떨어져서 반복되는 건 각각 남긴다.
function collapseConsecutiveDuplicates(lines: readonly string[]): string[] {
  const out: string[] = [];
  for (const line of lines) {
    if (out.length === 0 || out[out.length - 1] !== line) out.push(line);
  }
  return out;
}

// 누적된 진행 라인 → 상태 메시지 문자열. 무한 누적으로 2000자 한도를 넘기지 않도록
// 연속 중복을 접고 최근 N개만 표시한다(순수 함수). header 는 N1(c)의 머리줄 — 넘기지 않으면 예전 그대로다.
export function formatProgressMessage(lines: readonly string[], header = "처리 중"): string {
  if (lines.length === 0) return header;
  const collapsed = collapseConsecutiveDuplicates(lines);
  const display = collapsed.length > PROGRESS_DISPLAY_MAX_LINES
    ? collapsed.slice(-PROGRESS_DISPLAY_MAX_LINES)
    : collapsed;
  return [header, ...display.map((line) => `· ${line}`)].join("\n");
}

// N1(c) 머리줄(2026-11-25 설계 §2). 2분 넘는 턴에서 사람이 가장 먼저 묻는 것이 "얼마나 했고 얼마나 걸렸나"다.
// 단계는 도구 호출 수다 — 판단 줄·결과 줄까지 세면 같은 일을 두세 번 센다.
export const STATUS_HEARTBEAT_MS = 15_000;
// 하트비트의 상한(2026-11-25 리뷰). 마지막 진행 이벤트 뒤 이만큼 아무것도 오지 않으면 다시 그리기를 멈춘다 — 어떤 이유로든
// 종료 이벤트를 놓친 상태 메시지가 봇이 사는 내내 15초마다 편집되는 것을 막는다. 하네스 턴의 상한(30분, remote/hub.ts)보다
// 조금 길게 잡아, 진행 이벤트 없이 오래 도는 정상 명령(설치·빌드)의 경과는 끝까지 흐른다.
export const STATUS_HEARTBEAT_IDLE_MAX_MS = 35 * 60_000;

export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  if (m === 0) return `${s}초`;
  return s === 0 ? `${m}분` : `${m}분 ${s}초`;
}

export function formatStatusHeader(o: { steps: number; elapsedMs: number }): string {
  const parts = ["처리 중"];
  if (o.steps > 0) parts.push(`${o.steps}단계`);
  parts.push(`경과 ${formatElapsed(o.elapsedMs)}`);
  return parts.join(" · ");
}

// N1(b) 끝나도 남는 기록. 예전엔 턴이 끝나면 상태 메시지를 지워(finishStatus) 127스텝짜리 턴도 끝난 뒤에는 무엇을
// 했는지 남지 않았다. 머리줄 한 줄 + 스포일러(||…||)로 접어 남긴다 — 평소엔 한 줄이고, 궁금하면 눌러 펼친다.
//
// - 마지막 도구 줄 뒤의 판단·답변 줄은 뺀다: 그건 최종 답의 첫 문장이고 답은 바로 아래 있다.
// - 줄 안의 "||" 는 스포일러를 끊으므로(셸 명령 `a || b` 등) 사이에 폭 없는 공백을 끼운다.
// - 2000자 한도 안에서 최근 줄부터 담는다 — 끝 무렵이 "어디까지 했는가"이고, 오래된 줄은 대개 탐색이다.
const RECORD_MAX = 2000;
const OMIT_RESERVE = 24; // "(앞 N줄 생략)" 한 줄과 줄바꿈의 자리

export function formatProgressRecord(
  lines: readonly string[],
  kinds: ReadonlyArray<ProgressKind | undefined>,
  o: { steps: number; elapsedMs: number },
): string {
  let lastTool = -1;
  for (let i = 0; i < kinds.length; i++) if (kinds[i] === "tool" || kinds[i] === "tool_result") lastTool = i;
  let end = lines.length;
  if (lastTool >= 0) {
    while (end > lastTool + 1 && (kinds[end - 1] === "note" || kinds[end - 1] === "answering")) end--;
  }
  const kept = collapseConsecutiveDuplicates(lines.slice(0, end)).map((l) => `· ${l.replaceAll("||", "|​|")}`);
  const header = `작업 기록 · ${o.steps}단계 · ${formatElapsed(o.elapsedMs)}`;
  const wrap = (body: readonly string[]) => `${header}\n||${body.join("\n")}||`;
  const all = wrap(kept);
  if (all.length <= RECORD_MAX) return all;
  let budget = RECORD_MAX - wrap([]).length - OMIT_RESERVE;
  const body: string[] = [];
  for (let i = kept.length - 1; i >= 0; i--) {
    const cost = kept[i].length + 1;
    if (cost > budget) break;
    body.unshift(kept[i]);
    budget -= cost;
  }
  return wrap([`(앞 ${kept.length - body.length}줄 생략)`, ...body]);
}

// 채널(channelRef)별 진행 상태 UI 수명주기.
type ProgressState = {
  lines: string[];                               // 누적된 진행 라인
  recordLines: string[];                          // 끝난 뒤 기록에 남길 줄(lines 와 같은 순서 — 도구 결과 요약을 뺀 판, bus.ts 의 record)
  lastEventTs: number | null;                     // 마지막 진행 이벤트 시각(하트비트 상한)
  kinds: Array<ProgressKind | undefined>;         // lines 와 같은 순서의 줄 종류(N1 — 단계 수·끝 판단 줄 판정용)
  steps: number;                                  // 이 턴의 도구 호출 수(머리줄·기록)
  startedAt: number | null;                       // 이 턴의 첫 진행 이벤트 시각(경과)
  statusMessage: Message | null;                  // 현재 턴의 상태 메시지(없으면 아직 미전송)
  lastEditTs: number | null;                       // 마지막 편집 시각(throttle 기준)
  editTimer: ReturnType<typeof setTimeout> | null; // 지연된(트레일링) 편집 타이머
  heartbeat: ReturnType<typeof setInterval> | null; // 경과를 다시 그리는 주기 타이머(상태 메시지가 있는 동안만)
  pendingTriggers: Message[];                      // 반응을 달아둔 원본 메시지들(턴 순서대로 FIFO)
};

export class DiscordAdapter {
  private client: Client;
  private bus: EventBus;
  private config: Config;
  private users: UsersRepo;
  private conversations: ConversationsRepo;
  // 전송을 채널별 체인으로 직렬화한다: 한 채널 안에서는 청크 순서를 지키고, 채널 간에는 병렬.
  private sendChains = new Map<string, Promise<void>>();
  // 상태 메시지 생성/편집/삭제를 채널별로 직렬화한다(진행 이벤트는 순서가 보장되므로 그대로 순서를 지켜 처리).
  private statusChains = new Map<string, Promise<void>>();
  // 인입 메시지 처리(onMessage)를 채널별로 직렬화한다. getRole/getByChannelId 가 원격 Postgres
  // 왕복인 async 라, 직렬화 없이 messageCreate 마다 fire-and-forget 하면 같은 채널에 빠르게
  // 도착한 A→B 의 조회가 도착 순서와 다르게 끝날 수 있어(B 가 먼저 끝나는 경우) B 가 A 보다
  // 먼저 bus.publish 되어 응답·저장 순서가 뒤바뀐다. message.channelId 는 await 전에 동기로
  // 구할 수 있으므로 이를 키로 체인을 만들어 그 채널의 onMessage 호출이 도착 순서대로
  // 완료되도록 강제한다(sendChains/statusChains 와 같은 패턴).
  private inboundChains = new Map<string, Promise<void>>();
  private progressState = new Map<string, ProgressState>();

  constructor(deps: { bus: EventBus; config: Config; users: UsersRepo; conversations: ConversationsRepo }) {
    this.bus = deps.bus;
    this.config = deps.config;
    this.users = deps.users;
    this.conversations = deps.conversations;
    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,          // 채널·스레드 메타
        GatewayIntentBits.GuildMessages,   // 채널·스레드 메시지
        GatewayIntentBits.DirectMessages,  // DM
        GatewayIntentBits.MessageContent,  // 내용 읽기
      ],
      partials: [Partials.Channel], // DM 수신에 필요
    });
  }

  async start(): Promise<void> {
    this.client.on("messageCreate", (message: Message) => {
      this.enqueueInbound(message.channelId, () => this.onMessage(message));
    });
    // 중지 버튼(N2). 인입 체인에 싣지 않는다 — 멈춤은 그 채널의 다른 처리를 기다리지 않고 바로 닿아야 한다.
    this.client.on("interactionCreate", (interaction: Interaction) => {
      void this.onInteraction(interaction).catch((err) => console.error("[discord] 상호작용 처리 오류:", err));
    });

    this.subscribeBus();

    this.client.on("clientReady", () => {
      console.log(`[discord] 로그인 완료: ${this.client.user?.tag}`);
    });

    await this.client.login(this.config.discordToken);
  }

  // 이벤트버스 구독 배선. start() 에서 떼어 낸 이유는 테스트다 — 로그인 없이 구독만 걸어 이벤트 → 전송
  // 경로를 실제 버스로 검증한다(discordFileSend.test.ts). 배선 자체는 start() 가 부르는 것 하나뿐이다.
  private subscribeBus(): void {
    this.bus.subscribe("progress", (e) => {
      this.enqueueStatus(e.channelRef, () => this.handleProgress(e.channelRef, e.text, e.kind, e.record));
    });
    this.bus.subscribe("assistant_message", (e) => {
      const statusDone = this.enqueueStatus(e.channelRef, () => this.finishStatus(e.channelRef));
      this.enqueueSendAfter(e.channelRef, statusDone, e.text);
    });
    this.bus.subscribe("system_notice", (e) => {
      const statusDone = this.enqueueStatus(e.channelRef, () => this.finishStatus(e.channelRef));
      this.enqueueSendAfter(e.channelRef, statusDone, `⚠️ ${e.text}`);
    });
    // 파일 반환(2026-09-05): 첨부는 턴 도중 도구 호출(send_file)로 나가는 부수 전송이다 — finishStatus 를
    // 타면(상태 메시지 삭제·⏳→✅) 아직 진행 중인 턴이 끝난 것처럼 보이고, 뒤에 올 답변 본문이 그 ⏳ 를
    // 잃는다. 그래서 상태 체인은 건드리지 않고 전송 체인에만 합류한다 — 같은 채널에서 먼저 발행된 첨부가
    // 나중 발행된 본문보다 앞에 나가는 순서 보장은 enqueueSendAfter 와 같은 sendChains 가 준다.
    this.bus.subscribe("assistant_file", (e) => {
      this.enqueueFileSend(e.channelRef, e.name, e.data);
    });
    // 턴을 끝내지 않는 알림(bus.ts 의 SideNoticeEvent). 상태 체인은 건드리지 않고 전송 체인 순서만 지킨다.
    this.bus.subscribe("side_notice", (e) => {
      this.enqueueSendAfter(e.channelRef, Promise.resolve(), e.warn ? `⚠️ ${e.text}` : e.text);
    });
  }

  private async onMessage(message: Message): Promise<void> {
    if (message.author.bot) return;
    const bot = this.client.user;
    if (!bot) return;

    const isThread = message.channel.isThread();
    // 이미지·파일·거절 사유(빠른 개선 1.4 — sortAttachments 주석 참고). 거절 사유는 rejectedFiles 로 코어까지 간다.
    const { images, files, rejected: rejectedFiles } = sortAttachments(
      [...message.attachments.values()].map((a) => ({ url: a.url, contentType: a.contentType, name: a.name, size: a.size })),
    );
    const incoming: Incoming = {
      userId: message.author.id,
      channelId: message.channelId,
      isDM: message.channel.type === ChannelType.DM,
      isThread,
      mentionsBot: detectBotMention(message.mentions, bot),
      // 핑을 끈 답장은 부르는 것으로 보지 않는다(detectReplyToBot 주석) — 그런 답장은 지금처럼 멘션해야 부른다.
      repliesToBot: detectReplyToBot(message.mentions, bot.id),
      guildId: message.guildId ?? undefined,
      parentChannelId: isThread ? message.channel.parentId ?? undefined : undefined,
      // 봇 자신의 멘션을 뺀 본문(빠른 개선 1.3). 라우팅·스레드 이름·프롬프트가 모두 이 값을 본다 — 그래서
      // "@아사히 /새세션" 처럼 멘션과 함께 친 예약어도 이제 예약어로 인식된다.
      content: stripBotMention(message.content, bot.id),
      messageId: message.id,
      images,
      files,
      rejectedFiles,
    };

    const role = await this.users.getRole(incoming.userId);
    const existing = await this.conversations.getByChannelId(incoming.channelId);
    const decision = decideRoute(incoming, role, existing !== null);
    if (decision.kind === "ignore") return;
    if (role === "blocked") return; // 타입 좁히기용 방어(decideRoute 가 이미 걸러냄)
    // 손님 DM: 한 줄만 돌려주고 끝낸다. 여기서 끊어야 대화 행도, 세션 전사도, LLM 턴도 생기지 않는다 —
    // 아래 표시 이름 갱신·타이핑 표시·버스 발행 어느 것도 타지 않는다. 전송 실패는 삼킨다(DM 차단 등).
    if (decision.kind === "dm-declined") {
      // "send" in channel — 위 타이핑 표시와 같은 관용구다(그룹 DM 등 보낼 수 없는 채널 타입이 섞여 있다).
      if ("send" in message.channel) await message.channel.send(DM_DECLINED_NOTICE).catch(() => {});
      return;
    }

    // 표시 이름을 여기서 함께 갱신한다 — proc_list 가 사람 이름을 보여주려면 봇이 먼저 이름을
    // 알아야 하는데, users.display_name 은 컬럼과 upsert 파라미터가 있는데도 값을 넘기는 코드가
    // 없어 계속 null 이었다.
    //
    // 이 자리(무시 판정 뒤)인 것이 중요하다. 위로 올리면 봇에게 말을 건 아무나 users 에 행으로
    // 쌓인다 — decideRoute 가 걸러낸 사람은 애초에 우리가 아는 사람이 아니다.
    //
    // 서버 별명이 아니라 계정의 전역 표시 이름을 쓴다: 별명은 서버마다 다르고 DM 에는 아예
    // 없어서, 같은 사람이 어디서 말했느냐에 따라 프로세스 목록의 이름이 달라진다. 프로세스
    // 목록은 길드에 속한 화면이 아니므로 한 사람에게 이름 하나가 대응하는 편이 옳다.
    //
    // 실패를 삼키는 이유: 이름은 표시용 부가 정보다. 이름 갱신이 안 됐다고 메시지 처리를
    // 멈추면 부가 기능이 본 기능을 인질로 잡는다. upsert 는 COALESCE 라 빈 값으로 기존 이름을
    // 지우지도 않는다.
    //
    // 값을 try 밖에서 한 번만 구한다 — 아래 resolveHint 가 같은 이름을 힌트에 실어 코어의 프롬프트
    // 화자 표기에 쓴다(bus.ts 의 displayName). 두 번 계산하면 두 자리가 따로 흘러갈 수 있고,
    // upsert 가 실패한 턴에도 프롬프트에는 이름이 실려야 한다(저장 실패와 표기는 별개다).
    const displayName = message.author.displayName || message.author.username;
    try {
      if (displayName) await this.users.upsert(incoming.userId, { displayName });
    } catch {
      /* 위 주석 참고 — 이름 갱신 실패는 메시지 처리를 막지 않는다 */
    }

    // N2: /취소 는 턴을 시작하지 않는다. 반응 순번(pendingTriggers)에 넣으면 그 메시지에 대한 종료 이벤트가 오지 않아,
    // 이후 턴들의 ✅ 가 하나씩 밀린다 — 그래서 아래 beginTurn·타이핑 표시를 건너뛰고 코어로만 보낸다(코어의 ingest 가
    // 대화도 만들지 않고 requestCancel 로 처리한다). 일반 채널에서 멘션과 함께 친 것은 스레드를 만들지 않고 안내만 한다.
    const isCancel = parseCancelCommand(incoming.content);
    if (isCancel && decision.kind === "thread-create") {
      await message.reply(CANCEL_WHERE_NOTICE).catch(() => {});
      return;
    }

    // 타이핑 표시(있으면). 스레드 생성 전 원 채널에.
    if (!isCancel && "sendTyping" in message.channel) {
      void message.channel.sendTyping().catch(() => {});
    }

    const hint = await this.resolveHint(decision, incoming, role, message, displayName, existing?.primaryUserId);
    if (!hint) return; // 폴백조차 불가하면 조용히 종료(로그는 resolveHint 내부에서)

    // 답장이면 대상 메시지를 문맥으로 앞에 붙인다(빠른 개선 1.3). 예약어에는 붙이지 않는다 — 코어는 예약어를
    // 정확히 일치할 때만 알아보므로, 앞에 무엇이 붙으면 그 메시지가 평범한 대화 턴이 된다.
    // 전달(forward)된 메시지도 reference 를 갖지만 다른 채널의 글이다 — 같은 채널의 답장(Default)만 인용한다.
    const isReply = message.reference?.messageId !== undefined
      && (message.reference.type ?? MessageReferenceType.Default) === MessageReferenceType.Default;
    const text = isReply && !isReservedCommand(incoming.content)
      ? await this.withReplyQuote(message, incoming.content, bot.id)
      : incoming.content;

    if (!isCancel) this.beginTurn(hint.discordChannelId, message);

    this.bus.publish({
      type: "user_message",
      channel: "discord",
      channelRef: hint.discordChannelId,
      text,
      ts: Date.now(),
      hint,
      images: incoming.images.length > 0 ? incoming.images : undefined,
      files: incoming.files.length > 0 ? incoming.files : undefined,
      rejectedFiles: incoming.rejectedFiles.length > 0 ? incoming.rejectedFiles : undefined,
    });
  }

  // 중지 버튼 클릭(N2). 디스코드는 3초 안에 응답이 없으면 누른 사람에게 "상호작용 실패"를 띄우므로, 우리 버튼이면
  // 누가 눌렀든 먼저 조용히 받는다(deferUpdate — 메시지는 바꾸지 않는다). 그다음 등록된 사람의 것만 코어로 보낸다 —
  // 미등록자가 버튼을 눌러도 아무 일도 일어나지 않는 것이 메시지 경로(decideRoute 의 ignore)와 같은 규칙이다.
  private async onInteraction(interaction: Interaction): Promise<void> {
    if (!interaction.isButton() || interaction.customId !== CANCEL_BUTTON_ID) return;
    await interaction.deferUpdate().catch((err) => console.error("[discord] 버튼 응답 실패:", err));
    const role = await this.users.getRole(interaction.user.id);
    if (role !== "owner" && role !== "allowed") return;
    if (!interaction.channelId) return;
    this.bus.publish({ type: "cancel_request", channel: "discord", channelRef: interaction.channelId, userId: interaction.user.id, ts: Date.now() });
  }

  // 답장 대상을 한 번 읽어 본문 앞에 붙인다. 대상이 지워졌거나 읽을 권한이 없으면 문맥 없이 그대로 간다 — 부가
  // 정보가 본 처리를 막지 않는다(표시 이름 갱신과 같은 원칙).
  private async withReplyQuote(message: Message, text: string, botId: string): Promise<string> {
    try {
      const ref = await message.fetchReference();
      const authorName = ref.member?.displayName ?? ref.author.displayName ?? ref.author.username;
      const authorTag = ref.author.id === botId ? "봇" : await this.quoteTagOf(ref.author.id);
      const quote = buildReplyQuote({ authorName, authorTag, content: ref.content });
      return text.length > 0 ? `${quote}\n${text}` : quote;
    } catch (err) {
      console.error("[discord] 답장 대상 조회 실패 — 문맥 없이 진행:", err);
      return text;
    }
  }

  // 인용 작성자의 신분 태그(buildReplyQuote 주석). 운영자는 역할이 아니라 신원(ownerId)으로 본다 — 코어의 특권 판정과 같은
  // 규칙이다. 조회가 실패하면 가장 낮은 신뢰(미등록)로 본다.
  private async quoteTagOf(userId: string): Promise<QuoteAuthorTag> {
    if (userId === this.config.ownerId) return "운영자";
    try {
      const role = await this.users.getRole(userId);
      return role === "owner" || role === "allowed" ? "부원" : "미등록";
    } catch {
      return "미등록";
    }
  }

  // 라우팅 결정을 실제 대화 매핑 힌트로 바꾼다. thread-create 만 부수효과(스레드 생성)가 있다.
  private async resolveHint(
    decision: Exclude<RouteDecision, { kind: "ignore" } | { kind: "dm-declined" }>,
    i: Incoming,
    role: "owner" | "allowed",
    message: Message,
    displayName: string,
    existingPrimaryUserId?: string,
  ): Promise<ConversationHint | null> {
    const common = { guildId: i.guildId, parentChannelId: i.parentChannelId, userId: i.userId, role, discordMessageId: i.messageId, displayName };
    switch (decision.kind) {
      case "dm":
        return { ...common, kind: "dm", discordChannelId: i.channelId, isPrivate: true, primaryUserId: i.userId };
      case "thread-existing":
        // 기존 대화의 주 사용자를 유지(스레드 개설자 등). 없으면 발화자로.
        return { ...common, kind: "thread", discordChannelId: i.channelId, isPrivate: false, primaryUserId: existingPrimaryUserId ?? i.userId };
      case "adopt-thread":
        return { ...common, kind: "thread", discordChannelId: i.channelId, originMessageId: i.messageId, isPrivate: false, primaryUserId: i.userId };
      case "thread-create":
        return this.createThreadHint(i, common);
      case "channel-command":
        // 부수효과 없음: 스레드를 만들지 않고 채널을 그대로 가리킨다. kind:"thread" 는 서버
        // 컨텍스트(isPrivate:false)라는 뜻일 뿐이고, commandOnly 때문에 코어가 이 힌트로
        // conversations 행을 만들지 않으므로 이 채널이 봇 대화로 굳지 않는다.
        return { ...common, kind: "thread", discordChannelId: i.channelId, isPrivate: false, primaryUserId: i.userId, commandOnly: true };
    }
  }

  private async createThreadHint(
    i: Incoming,
    common: { guildId?: string; parentChannelId?: string; userId: string; role: "owner" | "allowed"; discordMessageId: string; displayName: string },
  ): Promise<ConversationHint | null> {
    // 멱등: 이 트리거 메시지로 이미 만든 대화가 있으면 그 스레드 재사용(스레드 재생성 금지).
    const already = await this.conversations.getByOriginMessageId(i.messageId);
    if (already) {
      return { ...common, kind: "thread", discordChannelId: already.discordChannelId, originMessageId: i.messageId, isPrivate: false, primaryUserId: i.userId };
    }
    const name = i.content.trim().slice(0, THREAD_NAME_MAX) || "비서 대화";
    try {
      const thread = await this.startThread(i.channelId, i.messageId, name);
      return { ...common, kind: "thread", discordChannelId: thread.id, parentChannelId: i.channelId, originMessageId: i.messageId, isPrivate: false, primaryUserId: i.userId };
    } catch (err) {
      // 폴백: 스레드 생성 불가/권한부족 → 채널 자체를 대화로 채택하고 인플레이스로 답장. 실패는 로그.
      console.error("[discord] 스레드 생성 실패 — 인플레이스 폴백:", err);
      return { ...common, kind: "thread", discordChannelId: i.channelId, originMessageId: i.messageId, isPrivate: false, primaryUserId: i.userId };
    }
  }

  private async startThread(channelId: string, messageId: string, name: string): Promise<{ id: string }> {
    const channel = await this.client.channels.fetch(channelId);
    if (!channel || channel.isDMBased() || !("messages" in channel)) throw new Error("스레드를 만들 수 없는 채널");
    const message = await channel.messages.fetch(messageId);
    return message.startThread({ name, autoArchiveDuration: ThreadAutoArchiveDuration.OneDay });
  }

  // 인입 메시지 처리를 채널별로 직렬화한다(위 inboundChains 주석 참고).
  private enqueueInbound(channelId: string, task: () => Promise<void>): void {
    const prev = this.inboundChains.get(channelId) ?? Promise.resolve();
    const next = prev.then(task).catch((err) => console.error("[discord] 메시지 처리 오류:", err));
    this.inboundChains.set(channelId, next);
  }

  // 상태 메시지 작업(생성/편집/삭제)을 채널별로 직렬화한다. 반환된 프라미스는 "이 작업까지 끝남"을
  // 나타내며, 최종 답변 전송이 상태 메시지 정리 이후에 나가도록 enqueueSendAfter 에서 대기시킨다.
  private enqueueStatus(channelRef: string, task: () => Promise<void>): Promise<void> {
    const prev = this.statusChains.get(channelRef) ?? Promise.resolve();
    const next = prev.then(task).catch((err) => console.error("[discord] 상태 처리 오류:", err));
    this.statusChains.set(channelRef, next);
    return next;
  }

  // 기존 sendChains 직렬화에 더해, 그 채널의 상태 정리(wait)가 끝난 뒤에만 전송하도록 합류시킨다.
  // prev/next 를 읽고 쓰는 부분이 완전히 동기라서(그 사이 await 이 없다), 같은 channelRef 에 대해
  // 이 메서드가 호출되는 순서(= 이벤트가 publish 되는 순서)가 그대로 sendChains 에 이어붙는
  // 순서가 된다 — 답장이 뒤바뀌지 않는 근거가 이것이다.
  private enqueueSendAfter(channelRef: string, wait: Promise<void>, text: string): void {
    const prev = this.sendChains.get(channelRef) ?? Promise.resolve();
    const next = Promise.all([prev, wait])
      .then(() => this.send(channelRef, text))
      .catch(() => {});
    this.sendChains.set(channelRef, next);
  }

  private getProgressState(channelRef: string): ProgressState {
    let state = this.progressState.get(channelRef);
    if (!state) {
      state = {
        lines: [], recordLines: [], lastEventTs: null, kinds: [], steps: 0, startedAt: null,
        statusMessage: null, lastEditTs: null, editTimer: null, heartbeat: null, pendingTriggers: [],
      };
      this.progressState.set(channelRef, state);
    }
    return state;
  }

  // 지금 상태를 그린다(머리줄 + 최근 줄). 첫 전송·스로틀 편집·하트비트가 모두 이 한 곳을 쓴다 — 세 자리가 각자
  // 그리면 머리줄이 갈린다.
  private renderStatus(state: ProgressState): string {
    const startedAt = state.startedAt ?? Date.now();
    return formatProgressMessage(state.lines, formatStatusHeader({ steps: state.steps, elapsedMs: Date.now() - startedAt }));
  }

  // 오래 도는 도구(설치·빌드) 동안에는 진행 이벤트가 없어 경과가 멈춰 보인다. 상태 메시지가 있는 동안만 주기적으로
  // 다시 그린다. 상태 체인에 실어 finishStatus 와 직렬로 돈다 — 정리가 먼저 끝났으면 statusMessage 가 비어 건너뛴다.
  private startHeartbeat(channelRef: string, state: ProgressState): void {
    if (state.heartbeat) return;
    state.heartbeat = setInterval(() => {
      void this.enqueueStatus(channelRef, async () => {
        if (!state.statusMessage) return;
        if (state.lastEventTs !== null && Date.now() - state.lastEventTs > STATUS_HEARTBEAT_IDLE_MAX_MS) {
          this.stopHeartbeat(state);
          return;
        }
        this.scheduleStatusEdit(state);
      });
    }, STATUS_HEARTBEAT_MS);
  }

  private stopHeartbeat(state: ProgressState): void {
    if (state.heartbeat) {
      clearInterval(state.heartbeat);
      state.heartbeat = null;
    }
  }

  // 게이트를 통과해 턴이 시작될 때: 원본 메시지에 처리중 반응을 달고, 그 채널의 반응 정리 순번
  // 큐(pendingTriggers)에 등록해둔다(완료 시 finishStatus 가 순서대로 꺼내 반응을 완료 표시로 바꾼다).
  private beginTurn(channelRef: string, message: Message): void {
    const state = this.getProgressState(channelRef);
    state.pendingTriggers.push(message);
    void message.react(PROCESSING_REACTION).catch((err) => console.error("[discord] 반응 추가 실패:", err));
  }

  // 그 채널의 첫 진행 이벤트면 상태 메시지를 새로 보내고, 이후엔 throttle 을 거쳐 편집한다.
  private async handleProgress(channelRef: string, text: string, kind?: ProgressKind, record?: string): Promise<void> {
    const state = this.getProgressState(channelRef);
    state.lines.push(text);
    state.recordLines.push(record ?? text);
    state.kinds.push(kind);
    if (kind === "tool") state.steps += 1;
    const now = Date.now();
    if (state.startedAt === null) state.startedAt = now;
    state.lastEventTs = now;
    if (!state.statusMessage) {
      try {
        const channel = await this.client.channels.fetch(channelRef);
        if (channel && channel.isSendable()) {
          // allowedMentions(2026-11-25 리뷰): 판단 줄은 모델이 쓴 글이고 도구 줄에는 파일 내용이 실린다 — 거기 든 @everyone·
          // <@id> 가 진행 표시에서 사람을 부르지 않게 한다. 편집은 원래 알림을 보내지 않으므로 첫 전송에만 걸면 된다.
          state.statusMessage = await channel.send({ content: this.renderStatus(state), components: [cancelRow()], allowedMentions: { parse: [] } });
          state.lastEditTs = Date.now();
          this.startHeartbeat(channelRef, state);
        }
      } catch (err) {
        console.error("[discord] 상태 메시지 전송 실패:", err);
      }
      return;
    }
    this.scheduleStatusEdit(state);
  }

  private scheduleStatusEdit(state: ProgressState): void {
    const decision = decideProgressEditThrottle(state.lastEditTs, Date.now());
    if (decision.action === "now") {
      this.applyStatusEdit(state);
      return;
    }
    if (state.editTimer) return; // 이미 트레일링 편집이 예약됨 — 발화 시점에 최신 lines 를 읽는다.
    state.editTimer = setTimeout(() => {
      state.editTimer = null;
      this.applyStatusEdit(state);
    }, decision.delayMs);
  }

  private applyStatusEdit(state: ProgressState): void {
    const msg = state.statusMessage;
    if (!msg) return;
    state.lastEditTs = Date.now();
    void msg.edit(this.renderStatus(state)).catch((err) => console.error("[discord] 상태 메시지 편집 실패:", err));
  }

  // 턴 종료(assistant_message/system_notice 공통): 대기 중인 편집·하트비트를 멈추고 상태 메시지를 정리한 뒤,
  // 이 턴을 시작시킨 원본 메시지의 반응을 처리중→완료로 바꾼다. 실패는 로그만 남기고 흐름은 계속한다.
  //
  // 정리(N1-b): 도구를 한 번이라도 쓴 턴은 지우지 않고 접힌 기록으로 바꾼다(formatProgressRecord). 버튼 같은
  // 구성요소는 함께 걷는다 — 끝난 턴의 버튼이 남으면 누를 수 있는 것처럼 보인다. 도구 없이 끝난 턴(짧은 대화가
  // 대부분이다)은 남길 것이 없으므로 예전처럼 지운다.
  private async finishStatus(channelRef: string): Promise<void> {
    const state = this.progressState.get(channelRef);
    if (state) {
      if (state.editTimer) {
        clearTimeout(state.editTimer);
        state.editTimer = null;
      }
      this.stopHeartbeat(state);
      if (state.statusMessage) {
        const msg = state.statusMessage;
        state.statusMessage = null;
        try {
          if (state.steps > 0) {
            const elapsedMs = Date.now() - (state.startedAt ?? Date.now());
            await msg.edit({ content: formatProgressRecord(state.recordLines, state.kinds, { steps: state.steps, elapsedMs }), components: [] });
          } else {
            await msg.delete();
          }
        } catch (err) {
          console.error("[discord] 상태 메시지 정리 실패:", err);
        }
      }
      state.lines = [];
      state.recordLines = [];
      state.kinds = [];
      state.steps = 0;
      state.startedAt = null;
      state.lastEventTs = null;
    }
    const trigger = state?.pendingTriggers.shift() ?? null;
    if (!trigger) return;
    try {
      // reaction.remove() 는 그 반응의 모든 사용자를 지우며 MANAGE_MESSAGES 를 요구하고 DM 에서 불가능하다.
      // users.remove()(인자 없으면 봇 자신 → .../@me) 는 자기 반응만 지우므로 권한 없이도, DM 에서도 동작한다.
      await trigger.reactions.cache.get(PROCESSING_REACTION)?.users.remove();
    } catch (err) {
      console.error("[discord] 반응 정리 실패:", err);
    }
    try {
      await trigger.react(DONE_REACTION);
    } catch (err) {
      console.error("[discord] 완료 반응 실패:", err);
    }
  }

  // 첨부 전송을 그 채널의 전송 체인에 잇는다(enqueueSendAfter 와 같은 체인, 상태 정리 대기는 없다 —
  // subscribeBus 의 assistant_file 주석 참고).
  private enqueueFileSend(channelRef: string, name: string, data: Buffer): void {
    const prev = this.sendChains.get(channelRef) ?? Promise.resolve();
    const next = prev.then(() => this.sendFile(channelRef, name, data)).catch(() => {});
    this.sendChains.set(channelRef, next);
  }

  // 디스코드가 첨부를 거부하면(등급별 상한·형식 등) 조용히 넘어가지 않는다 — 워커의 send_file 은 봇이 200
  // 을 준 시점에 이미 "보냈어요"라고 모델에게 답했으므로, 여기서 침묵하면 사용자는 있다고 들은 파일을
  // 받지 못한 채 끝난다. 그 자리에 실패 안내를 텍스트로 보낸다(send() 의 빈 본문 폴백과 같은 방어선).
  private async sendFile(channelRef: string, name: string, data: Buffer): Promise<void> {
    let channel: Awaited<ReturnType<Client["channels"]["fetch"]>>;
    try {
      channel = await this.client.channels.fetch(channelRef);
    } catch (err) {
      console.error("[discord] 첨부 채널 조회 실패:", err);
      return;
    }
    if (!channel || !channel.isSendable()) return;
    try {
      await channel.send({ files: [{ attachment: data, name }] });
    } catch (err) {
      console.error(`[discord] 첨부 전송 실패 — ${name}(${data.length} 바이트), 채널 ${channelRef}:`, err);
      const reason = err instanceof Error ? err.message : String(err);
      try {
        await channel.send(`⚠️ 파일 ${name} 을(를) 디스코드에 보내지 못했어요(${reason.slice(0, 200)}).`);
      } catch (err2) {
        console.error("[discord] 첨부 실패 안내 전송도 실패:", err2);
      }
    }
  }

  private async send(channelRef: string, text: string): Promise<void> {
    try {
      const channel = await this.client.channels.fetch(channelRef);
      if (!channel || !channel.isSendable()) return;
      const plan = planSend(text);
      if (plan.chunks.length === 0) {
        // 본문이 없다. 조용히 넘어가면 완료 반응만 달리고 답이 없는 상태가 된다.
        console.error(`[discord] 보낼 내용이 없어 폴백으로 대체 — 채널 ${channelRef}`);
        await channel.send(SEND_EMPTY_FALLBACK);
        return;
      }
      for (const chunk of plan.chunks) {
        await channel.send(chunk);
      }
    } catch (err) {
      console.error("[discord] 전송 실패:", err);
    }
  }

  // FIX2(중요, 머지 전 리뷰): 정기 게시 채널(DIGEST_CONTEST_CHANNEL_ID 등)이 잘못된 ID 이거나
  // 봇에게 채널을 볼 권한이 없으면, 지금까지는 그 사실이 "매 조사 성공 뒤 전송이 조용히
  // 실패"로만 드러났다(위 send() 의 catch 는 로그 한 줄만 남긴다) — 사용자는 리다이렉트
  // 안내("...에 올리겠습니다")를 받고 기다리다가 그냥 아무것도 못 받는다. index.ts 가 기동 시(로그인
  // 직후) 설정된 각 정기 게시 채널에 대해 이 메서드로 한 번 확인해, 접근 불가면 이름 있는
  // 경고를 남긴다. 일시적으로 못 보는 채널 때문에 봇 전체가 멈추면 안 되므로 예외를 던지지
  // 않고 boolean 으로만 알린다 — send() 와 동일하게 fetch 실패(권한 없음·잘못된 ID 등)를 여기서
  // 격리한다.
  async canReachChannel(channelId: string): Promise<boolean> {
    try {
      const channel = await this.client.channels.fetch(channelId);
      return !!channel && channel.isSendable();
    } catch {
      return false;
    }
  }

  async stop(): Promise<void> {
    // 남아있는 트레일링 편집 타이머를 정리해 유령 상태 메시지 편집이 발생하지 않게 한다.
    for (const state of this.progressState.values()) {
      if (state.editTimer) {
        clearTimeout(state.editTimer);
        state.editTimer = null;
      }
      this.stopHeartbeat(state);
    }
    // 종료 전, 모든 채널 체인(인입 처리 + 상태 정리 + 전송)에 남은 작업을 최대한 흘려보낸다(마지막 응답 유실 최소화).
    await Promise.allSettled([...this.inboundChains.values(), ...this.statusChains.values(), ...this.sendChains.values()]);
    await this.client.destroy();
  }
}
