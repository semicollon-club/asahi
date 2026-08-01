import {
  ChannelType, Client, GatewayIntentBits, Partials, ThreadAutoArchiveDuration, EmbedBuilder, type Message,
} from "discord.js";
import type { EventBus, ConversationHint } from "../events/bus.js";
import type { Config } from "../config.js";
import type { UsersRepo, Role } from "../store/usersRepo.js";
import type { ConversationsRepo } from "../store/conversationsRepo.js";
import { filterImageAttachments, type ImageRef } from "../core/images.js";
import { filterFileAttachments, type FileRef } from "../core/attachments.js";
import { parseExpression } from "../core/expressions.js";
import { isChannelCommand } from "../core/commands.js";
import type { CharacterImagesRepo } from "../store/characterImagesRepo.js";

export function chunkMessage(text: string, max = 2000): string[] {
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

// 같은 대화에서 표정 이미지를 연달아 보내지 않도록 하는 하한. 프롬프트 지침은 반드시 새므로
// 어댑터가 최종 방어선이 된다 — 모델이 매 답변마다 마커를 붙여도 실제로는 이 간격으로 걸러진다.
// 지침대로 쓰면 애초에 이보다 드물게 나오므로 정상 동작을 막지 않는다.
export const EXPRESSION_MIN_INTERVAL_MS = 120_000;

// FIX1(치명): 마커만 있는 답변(본문 없음)에서 이미지 해석까지 실패하면 정말 아무 것도 안 나간다 —
// 그래도 finishStatus 는 완료 반응(✅)을 달아버려 "성공했지만 무응답"이 된다. core.ts 의 빈 응답
// 폴백("이번엔 드릴 답을 만들지 못했어요. 다시 한 번 말씀해 주세요.")과 같은 톤으로 최소한의 응답을 보장한다.
export const EXPRESSION_EMPTY_FALLBACK = "이번엔 보여드릴 게 없었어요. 다시 한 번 말씀해 주세요.";

// 그 감정의 URL 중 하나를 고른다. 직전에 보낸 것과 겹치지 않게 하되, 후보가 하나뿐이면
// 그대로 쓴다(웃음 폴더처럼 이미지가 한 장인 경우).
export function pickExpressionUrl(
  urls: string[],
  lastUrl: string | undefined,
  rand: () => number = Math.random,
): string | undefined {
  if (urls.length === 0) return undefined;
  const pool = urls.length > 1 ? urls.filter((u) => u !== lastUrl) : urls;
  const candidates = pool.length > 0 ? pool : urls;
  return candidates[Math.min(candidates.length - 1, Math.floor(rand() * candidates.length))];
}

// 아직 상한 안이면 true — 즉 "이번엔 보내지 않는다". 경계(정확히 상한만큼 지남)는 보내는 쪽이다.
export function withinExpressionInterval(
  lastTs: number | undefined,
  now: number,
  minMs: number = EXPRESSION_MIN_INTERVAL_MS,
): boolean {
  if (lastTs === undefined) return false;
  return now - lastTs < minMs;
}

// 텍스트와 이미지 유무로 전송 형태를 정한다. send() 는 이 결과를 그대로 실행만 한다 —
// 판단을 여기로 몰아야 디스코드 채널 없이 테스트할 수 있다.
export function planSend(text: string, hasImage: boolean): {
  chunks: string[];
  embedOnLast: boolean;
  embedOnly: boolean;
} {
  const chunks = text.length > 0 ? chunkMessage(text) : [];
  if (chunks.length === 0) return { chunks: [], embedOnLast: false, embedOnly: hasImage };
  return { chunks, embedOnLast: hasImage, embedOnly: false };
}

// ── 순수 라우팅 결정 (테스트 용이) ──────────────────────────────────────────
// 인입 메시지 + 발화자 role + 이 채널에 대화 행 존재여부 → 무엇을 할지.
export type Incoming = {
  userId: string; channelId: string; isDM: boolean; isThread: boolean; mentionsBot: boolean;
  guildId?: string; parentChannelId?: string; content: string; messageId: string;
  images: ImageRef[];
  files: FileRef[];
  // filterFileAttachments 가 거절한 첨부의 사유 문자열(예: "big.pdf(너무 큼)"). 최종 리뷰
  // Important — 예전엔 이 값을 어디서도 읽지 않아 크기 초과·이름 위험·개수 초과로 거절된
  // 첨부가 마커도 안내도 로그도 없이 사라졌다. images 쪽 skipped(형식 미지원 등)는 이 브랜치
  // 이전부터 같은 자리에서 버려지던 것이라 손대지 않는다 — 범위를 넓히지 않는다.
  rejectedFiles: string[];
};
export type RouteDecision =
  | { kind: "ignore" }            // 게이트 탈락 / 관심 없는 메시지
  | { kind: "dm" }                // 그 사용자 DM 대화
  | { kind: "thread-existing" }   // 이미 conversations 행이 있는 스레드(또는 폴백 채널)
  | { kind: "thread-create" }     // 일반 채널 @멘션 → 새 스레드 생성
  | { kind: "adopt-thread" }      // 아직 대화 아닌 스레드에서 @멘션 → 그 스레드 채택
  | { kind: "channel-command" };  // 일반 채널의 예약어(멘션 없이) → 스레드도 대화도 만들지 않고 처리

export function decideRoute(i: Incoming, role: Role, hasConversation: boolean): RouteDecision {
  // 응답 게이트: owner/allowed 만. 미등록·blocked·컨텍스트 작성자 불문 무시.
  if (role !== "owner" && role !== "allowed") return { kind: "ignore" };
  if (i.isDM) return { kind: "dm" };
  if (i.isThread) {
    if (hasConversation) return { kind: "thread-existing" }; // 봇 대화 지속(멘션 불필요)
    if (i.mentionsBot) return { kind: "adopt-thread" };
    return { kind: "ignore" };
  }
  // 일반(비스레드) 채널
  if (hasConversation) return { kind: "thread-existing" };   // 스레드 생성 폴백으로 채택된 채널 등
  if (i.mentionsBot) return { kind: "thread-create" };
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
// 연속 중복을 접고 최근 N개만 표시한다(순수 함수).
export function formatProgressMessage(lines: readonly string[]): string {
  if (lines.length === 0) return "처리 중";
  const collapsed = collapseConsecutiveDuplicates(lines);
  const display = collapsed.length > PROGRESS_DISPLAY_MAX_LINES
    ? collapsed.slice(-PROGRESS_DISPLAY_MAX_LINES)
    : collapsed;
  return ["처리 중", ...display.map((line) => `· ${line}`)].join("\n");
}

// 채널(channelRef)별 진행 상태 UI 수명주기.
type ProgressState = {
  lines: string[];                               // 누적된 진행 라인
  statusMessage: Message | null;                  // 현재 턴의 상태 메시지(없으면 아직 미전송)
  lastEditTs: number | null;                       // 마지막 편집 시각(throttle 기준)
  editTimer: ReturnType<typeof setTimeout> | null; // 지연된(트레일링) 편집 타이머
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
  // 대화별 표정 전송 상태(메모리). 재배포로 초기화돼도 무해하다 — 최악이 이미지 한 장 더 나가는 것이다.
  private expressionState = new Map<string, { lastTs: number; lastUrl?: string }>();
  private characterImages?: CharacterImagesRepo;

  constructor(deps: { bus: EventBus; config: Config; users: UsersRepo; conversations: ConversationsRepo; characterImages?: CharacterImagesRepo }) {
    this.bus = deps.bus;
    this.config = deps.config;
    this.users = deps.users;
    this.conversations = deps.conversations;
    this.characterImages = deps.characterImages;
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

    this.bus.subscribe("progress", (e) => {
      this.enqueueStatus(e.channelRef, () => this.handleProgress(e.channelRef, e.text));
    });
    this.bus.subscribe("assistant_message", (e) => {
      const statusDone = this.enqueueStatus(e.channelRef, () => this.finishStatus(e.channelRef));
      const { text, emotion } = parseExpression(e.text);
      // FIX3(중요): resolveExpression(DB 조회)을 핸들러에서 미리 await 하지 않는다 — enqueueSendAfter
      // 를 동기로 호출해야 발행(publish) 순서가 곧 전송 체인에 올라타는 순서가 된다. 자세한 이유는
      // enqueueSendAfter 주석 참고. system_notice 핸들러와 구조가 대칭이 된다.
      this.enqueueSendAfter(e.channelRef, statusDone, text, emotion);
    });
    this.bus.subscribe("system_notice", (e) => {
      const statusDone = this.enqueueStatus(e.channelRef, () => this.finishStatus(e.channelRef));
      this.enqueueSendAfter(e.channelRef, statusDone, `⚠️ ${e.text}`);
    });

    this.client.on("clientReady", () => {
      console.log(`[discord] 로그인 완료: ${this.client.user?.tag}`);
    });

    await this.client.login(this.config.discordToken);
  }

  private async onMessage(message: Message): Promise<void> {
    if (message.author.bot) return;
    const bot = this.client.user;
    if (!bot) return;

    const isThread = message.channel.isThread();
    const { images } = filterImageAttachments(
      [...message.attachments.values()].map((a) => ({ url: a.url, contentType: a.contentType, name: a.name, size: a.size })),
    );
    // skipped(최종 리뷰 Important): 거절 사유를 rejectedFiles 로 나른다 — images 쪽 skipped 는
    // 이 브랜치 이전부터 버려지던 별개의 자리라 여기서 함께 고치지 않는다(위 Incoming.rejectedFiles
    // 선언부 참고).
    const { files, skipped: rejectedFiles } = filterFileAttachments(
      [...message.attachments.values()].map((a) => ({ url: a.url, contentType: a.contentType, name: a.name, size: a.size })),
    );
    const incoming: Incoming = {
      userId: message.author.id,
      channelId: message.channelId,
      isDM: message.channel.type === ChannelType.DM,
      isThread,
      mentionsBot: detectBotMention(message.mentions, bot),
      guildId: message.guildId ?? undefined,
      parentChannelId: isThread ? message.channel.parentId ?? undefined : undefined,
      content: message.content,
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
    try {
      const displayName = message.author.displayName || message.author.username;
      if (displayName) await this.users.upsert(incoming.userId, { displayName });
    } catch {
      /* 위 주석 참고 — 이름 갱신 실패는 메시지 처리를 막지 않는다 */
    }

    // 타이핑 표시(있으면). 스레드 생성 전 원 채널에.
    if ("sendTyping" in message.channel) {
      void message.channel.sendTyping().catch(() => {});
    }

    const hint = await this.resolveHint(decision, incoming, role, message, existing?.primaryUserId);
    if (!hint) return; // 폴백조차 불가하면 조용히 종료(로그는 resolveHint 내부에서)

    this.beginTurn(hint.discordChannelId, message);

    this.bus.publish({
      type: "user_message",
      channel: "discord",
      channelRef: hint.discordChannelId,
      text: incoming.content,
      ts: Date.now(),
      hint,
      images: incoming.images.length > 0 ? incoming.images : undefined,
      files: incoming.files.length > 0 ? incoming.files : undefined,
      rejectedFiles: incoming.rejectedFiles.length > 0 ? incoming.rejectedFiles : undefined,
    });
  }

  // 라우팅 결정을 실제 대화 매핑 힌트로 바꾼다. thread-create 만 부수효과(스레드 생성)가 있다.
  private async resolveHint(
    decision: Exclude<RouteDecision, { kind: "ignore" }>,
    i: Incoming,
    role: "owner" | "allowed",
    message: Message,
    existingPrimaryUserId?: string,
  ): Promise<ConversationHint | null> {
    const common = { guildId: i.guildId, parentChannelId: i.parentChannelId, userId: i.userId, role, discordMessageId: i.messageId };
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
    common: { guildId?: string; parentChannelId?: string; userId: string; role: "owner" | "allowed"; discordMessageId: string },
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
  // FIX3(중요): 표정 해석(resolveExpression, DB 조회)을 핸들러가 아니라 이 체인 "안"에서 수행한다.
  // prev/next 를 읽고 쓰는 부분은 완전히 동기라서(그 사이 await 이 없다), 같은 channelRef 에 대해
  // enqueueSendAfter 가 호출되는 순서(= 이벤트가 publish 되는 순서)가 그대로 sendChains 에 이어붙는
  // 순서가 된다. 예전처럼 핸들러가 resolveExpression 을 먼저 await 하면, 그 사이 나중에 publish 됐지만
  // DB 조회가 더 빨리 끝나는 턴(system_notice 의 빠른 실패 경로 등)이 먼저 체인에 올라타 답장 순서가
  // 뒤바뀔 수 있었다. emotion 이 없으면(system_notice) resolveExpression 내부에서 즉시 undefined 로
  // 끝나 DB 조회 자체를 건너뛴다 — system_notice 는 여전히 이미지를 받지 않는다.
  // FIX4 부수효과: 같은 channelRef 에 대한 두 호출이 이제 완전히 직렬화되므로, resolveExpression 의
  // "간격 상태 읽기 → urlsFor await → 간격 상태 쓰기" 구간이 한 채널에서 더는 겹칠 수 없다(아래
  // resolveExpression 주석 참고).
  private enqueueSendAfter(channelRef: string, wait: Promise<void>, text: string, emotion: string | null = null): void {
    const prev = this.sendChains.get(channelRef) ?? Promise.resolve();
    const textIsEmpty = text.length === 0;
    const next = Promise.all([prev, wait])
      .then(() => this.resolveExpression(channelRef, emotion, textIsEmpty))
      .then((imageUrl) => this.send(channelRef, text, imageUrl))
      .catch(() => {});
    this.sendChains.set(channelRef, next);
  }

  // 감정 이름을 실제 이미지 URL 로 바꾼다. 어떤 이유로든 실패하면 undefined 를 돌려주고,
  // 호출측은 이미지 없이 텍스트만 보낸다 — 이미지 때문에 답변이 막히면 안 된다.
  // FIX1(치명): textIsEmpty 는 "본문 없이 마커만 있는 답변인가"를 나타낸다. 이 경우 이미지가 곧
  // 전체 응답이므로, 그걸 간격 제한으로 막아버리면 답장 자체가 통째로 사라진다 — 그래서 본문이
  // 없을 때만 간격 검사를 건너뛴다(본문이 있는 일반적인 경우엔 기존대로 제한을 적용한다).
  // FIX4: state 를 읽는 시점과 urlsFor 를 await 하는 시점 사이에 겹치는 호출이 있으면 같은 채널에
  // 대해 두 호출이 모두 낡은 스냅샷으로 간격 검사를 통과할 수 있었다. 이제 이 메서드는 항상
  // enqueueSendAfter 의 채널별 직렬 체인 "안"에서만 호출되므로(위 enqueueSendAfter 주석 참고),
  // 같은 channelRef 에 대한 두 번째 호출은 첫 번째 호출의 read-await-write 가 전부 끝난 뒤에야
  // 시작된다 — 겹칠 수 없다.
  private async resolveExpression(channelRef: string, emotion: string | null, textIsEmpty: boolean): Promise<string | undefined> {
    if (!emotion || !this.characterImages) return undefined;
    const now = Date.now();
    const state = this.expressionState.get(channelRef);
    if (!textIsEmpty && withinExpressionInterval(state?.lastTs, now)) return undefined;
    try {
      const urls = await this.characterImages.urlsFor(emotion);
      const url = pickExpressionUrl(urls, state?.lastUrl);
      if (!url) return undefined;
      this.expressionState.set(channelRef, { lastTs: now, lastUrl: url });
      return url;
    } catch (err) {
      console.error("[discord] 표정 이미지 조회 실패:", err);
      return undefined;
    }
  }

  private getProgressState(channelRef: string): ProgressState {
    let state = this.progressState.get(channelRef);
    if (!state) {
      state = { lines: [], statusMessage: null, lastEditTs: null, editTimer: null, pendingTriggers: [] };
      this.progressState.set(channelRef, state);
    }
    return state;
  }

  // 게이트를 통과해 턴이 시작될 때: 원본 메시지에 처리중 반응을 달고, 그 채널의 반응 정리 순번
  // 큐(pendingTriggers)에 등록해둔다(완료 시 finishStatus 가 순서대로 꺼내 반응을 완료 표시로 바꾼다).
  private beginTurn(channelRef: string, message: Message): void {
    const state = this.getProgressState(channelRef);
    state.pendingTriggers.push(message);
    void message.react(PROCESSING_REACTION).catch((err) => console.error("[discord] 반응 추가 실패:", err));
  }

  // 그 채널의 첫 진행 이벤트면 상태 메시지를 새로 보내고, 이후엔 throttle 을 거쳐 편집한다.
  private async handleProgress(channelRef: string, text: string): Promise<void> {
    const state = this.getProgressState(channelRef);
    state.lines.push(text);
    if (!state.statusMessage) {
      try {
        const channel = await this.client.channels.fetch(channelRef);
        if (channel && channel.isSendable()) {
          state.statusMessage = await channel.send(formatProgressMessage(state.lines));
          state.lastEditTs = Date.now();
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
    void msg.edit(formatProgressMessage(state.lines)).catch((err) => console.error("[discord] 상태 메시지 편집 실패:", err));
  }

  // 턴 종료(assistant_message/system_notice 공통): 대기 중인 편집을 취소하고 상태 메시지를 지운 뒤,
  // 이 턴을 시작시킨 원본 메시지의 반응을 처리중→완료로 바꾼다. 실패는 로그만 남기고 흐름은 계속한다.
  private async finishStatus(channelRef: string): Promise<void> {
    const state = this.progressState.get(channelRef);
    if (state) {
      if (state.editTimer) {
        clearTimeout(state.editTimer);
        state.editTimer = null;
      }
      if (state.statusMessage) {
        const msg = state.statusMessage;
        state.statusMessage = null;
        try {
          await msg.delete();
        } catch (err) {
          console.error("[discord] 상태 메시지 삭제 실패:", err);
        }
      }
      state.lines = [];
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

  private async send(channelRef: string, text: string, imageUrl?: string): Promise<void> {
    try {
      const channel = await this.client.channels.fetch(channelRef);
      if (!channel || !channel.isSendable()) return;

      // FIX2(치명): URL 문자열이 있어도 EmbedBuilder.setImage 는 형식이 아니면(빈 문자열·프로토콜
      // 없음·공백 등) 동기적으로 던진다(character_images.url 오염 등으로 실제 발생 가능). 여기서
      // 격리하지 않으면 정상적인 긴 텍스트 답장까지 통째로 유실된다 — embed 생성 실패는 로그만
      // 남기고 이미지 없이 계속한다.
      let embeds: EmbedBuilder[] = [];
      if (imageUrl) {
        try {
          embeds = [new EmbedBuilder().setImage(imageUrl)];
        } catch (err) {
          console.error(`[discord] 이미지 embed 생성 실패(채널 ${channelRef}) — 이미지 없이 계속:`, err);
        }
      }
      // hasImage 는 "URL 문자열이 있었는가"가 아니라 "embed 를 실제로 만들었는가"로 판단해야
      // planSend 의 결정(embedOnLast/embedOnly)이 실제로 나갈 내용과 어긋나지 않는다.
      const hasImage = embeds.length > 0;

      const plan = planSend(text, hasImage);
      if (plan.embedOnly) {
        // 마커만 있고 본문이 없는 경우 — 이미지만 보낸다.
        await channel.send({ embeds });
        return;
      }
      if (plan.chunks.length === 0) {
        // FIX1(치명): 본문도 이미지도 없다 — 마커만 있던 답변에서 이미지 해석까지 실패한 경우 등.
        // 조용히 아무 것도 안 나가면 finishStatus 가 그대로 완료 반응(✅)을 달아 "성공했지만
        // 무응답"이 된다. 원인 추적을 위해 채널을 특정해 로그를 남기고, 최소한의 응답은 보장한다.
        console.error(`[discord] 보낼 내용이 없어 폴백으로 대체 — 채널 ${channelRef}`);
        await channel.send(EXPRESSION_EMPTY_FALLBACK);
        return;
      }
      for (let i = 0; i < plan.chunks.length; i++) {
        // 이미지는 마지막 청크와 함께 보낸다. 따로 보내면 메시지가 둘로 갈라져 어색하다.
        const isLast = i === plan.chunks.length - 1;
        await channel.send(isLast && plan.embedOnLast ? { content: plan.chunks[i], embeds } : plan.chunks[i]);
      }
    } catch (err) {
      console.error("[discord] 전송 실패:", err);
    }
  }

  // FIX2(중요, 머지 전 리뷰): 정기 게시 채널(DIGEST_CONTEST_CHANNEL_ID 등)이 잘못된 ID 이거나
  // 봇에게 채널을 볼 권한이 없으면, 지금까지는 그 사실이 "매 조사 성공 뒤 전송이 조용히
  // 실패"로만 드러났다(위 send() 의 catch 는 로그 한 줄만 남긴다) — 사용자는 리다이렉트
  // 안내("...에 올릴게")를 받고 기다리다가 그냥 아무것도 못 받는다. index.ts 가 기동 시(로그인
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
    }
    // 종료 전, 모든 채널 체인(인입 처리 + 상태 정리 + 전송)에 남은 작업을 최대한 흘려보낸다(마지막 응답 유실 최소화).
    await Promise.allSettled([...this.inboundChains.values(), ...this.statusChains.values(), ...this.sendChains.values()]);
    await this.client.destroy();
  }
}
