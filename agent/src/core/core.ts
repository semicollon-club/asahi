import type { EventBus, UserMessageEvent, ConversationHint } from "../events/bus.js";
import type { Config } from "../config.js";
import type { TurnRunner, TurnContext, TurnResult, ProgressUpdate } from "./agent.js";
import { buildSystemPrompt, deriveRapportStage } from "./persona.js";
import { parseSessionCommand } from "./commands.js";
import type { Role } from "../store/usersRepo.js";
import type { UsersRepo } from "../store/usersRepo.js";
import type { ConversationsRepo, Conversation } from "../store/conversationsRepo.js";
import type { ParticipantsRepo } from "../store/participantsRepo.js";
import type { MessagesRepo } from "../store/messagesRepo.js";
import type { SummariesRepo } from "../store/summariesRepo.js";
import type { MemoriesRepo } from "../store/memoriesRepo.js";
import type { TurnsRepo } from "../store/turnsRepo.js";
import { buildContextBlock, isSessionNotFound } from "./turnPrep.js";
import { buildImageMarker, downloadImages, type ImageRef, type ImageInput } from "./images.js";

const HOUR_MS = 60 * 60 * 1000;

const SUMMARY_PROMPT = `이 대화 세션이 곧 종료됩니다. 나중에 다시 깨어날 너 자신을 위해 이번 대화를 요약하세요.
- 결정된 것, 사용자에 대해 새로 알게 된 것, 진행 중인 일 중심으로 10줄 이내
- 요약 텍스트만 출력 (인사말·설명 없이)`;

// ProgressUpdate → 사용자용 짧은 텍스트(순수 함수, 디스코드 태스크가 그대로 재사용한다).
export function formatProgress(u: ProgressUpdate): string {
  switch (u.kind) {
    case "tool":
      return u.input !== undefined ? `${u.name}("${u.input}")` : `${u.name}()`;
    case "tool_result":
      return u.name ? `${u.name} 완료` : "도구 실행 완료";
    case "answering":
      return "답변 작성 중";
  }
}

export type CoreRepos = {
  users: UsersRepo;
  conversations: ConversationsRepo;
  participants: ParticipantsRepo;
  messages: MessagesRepo;
  summaries: SummariesRepo;
  memories: MemoriesRepo;
  turns: TurnsRepo;
};

// 대화(conversation)별 세션 + 대화 키별 직렬락으로 동작하는 코어.
// - 같은 conversation 은 직렬(재진입 금지), 다른 conversation 은 병렬.
// - 프라이버시(§6): DM 은 상대의 개인+공용 기억, 서버/스레드는 공용만 주입.
// - 한도(§8): 매 LLM 턴을 TurnsRepo.reserve 로 원자 예약(유저별+전역, 소유자 예약분).
export class AgentCore {
  private bus: EventBus;
  private config: Config;
  private runTurn: TurnRunner;
  private now: () => number;
  private repos: CoreRepos;
  private ownerId: string;
  private agentCwd: string;
  // discord_channel_id(대화 채널 키) → 그 대화의 마지막 작업 프라미스(꼬리). 여기에 이어붙여 직렬화한다.
  // 리포가 async 가 된 뒤로는 대화 행을 조회/생성하는 resolveConversation 자체도 비동기이므로,
  // 아직 conv.id 가 없는(첫 메시지) 시점부터 직렬화하려면 즉시 알 수 있는 채널ID 를 키로 써야 한다
  // (숫자 conv.id 로는 대화가 생성되기 전엔 큐잉할 수 없다 — 동시 첫 메시지 두 개가 대화 행을
  // 중복 생성하려 드는 경쟁을 막는다).
  //
  // 체인을 durable 저장(ingest)과 LLM 턴(turn) 두 갈래로 분리한다. 하나의 체인에 묶으면 앞
  // 메시지의 긴 LLM 턴이 끝날 때까지 뒤 메시지가 insert 조차 되지 못해, 그 사이 크래시하면
  // recoverPending 이 복구할 행 자체가 없어 영구 유실된다(회귀). ingest 는 짧으므로 채널별로
  // 직렬화해도 버스트가 빨리 소진되어 모든 메시지가 즉시 durable 저장되고, turn 은 여전히
  // 채널별(=대화별)로 직렬화되어 같은 대화 재진입 금지 불변식을 유지한다.
  private ingestChains = new Map<string, Promise<void>>();
  private turnChains = new Map<string, Promise<void>>();
  private fetchImpl: typeof fetch;

  constructor(deps: {
    bus: EventBus; config: Config; runTurn: TurnRunner; repos: CoreRepos; agentCwd: string; now?: () => number;
    fetchImpl?: typeof fetch;
  }) {
    this.bus = deps.bus;
    this.config = deps.config;
    this.runTurn = deps.runTurn;
    this.repos = deps.repos;
    this.agentCwd = deps.agentCwd;
    this.ownerId = deps.config.ownerId;
    this.now = deps.now ?? Date.now;
    this.fetchImpl = deps.fetchImpl ?? fetch;
  }

  start(): void {
    // onUserMessage 자체는 동기(게이트 확인 + enqueue 만) — 실제 비동기 작업은 enqueue 된
    // ingest 안에서 일어나고 그 오류는 enqueue 의 .catch 가 처리하므로, 여기서
    // 프라미스를 잃어버릴 일이 없다.
    this.bus.subscribe("user_message", (e) => this.onUserMessage(e));
  }

  private onUserMessage(e: UserMessageEvent): void {
    const hint = e.hint;
    if (!hint) return; // 2B 실시간 경로는 항상 대화 힌트를 싣는다.
    if (hint.role !== "owner" && hint.role !== "allowed") return; // 게이트 재확인(방어)

    // durable ingest(대화 조회/생성 + 참가자 upsert + 메시지 저장)만 이 채널의 ingest 체인에
    // 태운다. LLM 턴은 여기서 기다리지 않는다 — ingest 가 끝나면 그 안에서 turn 체인에 별도로
    // 이어붙인다(아래 ingest 참고). conv.id 는 대화가 생성되어야 나오므로, 그 전 단계인 첫
    // 메시지부터 직렬화하려면 힌트에서 즉시 알 수 있는 discordChannelId 를 큐 키로 써야 한다 —
    // 그러지 않으면 같은 채널의 두 메시지가 동시에 도착했을 때 resolveConversation 이 서로의
    // 결과를 보지 못하고 대화 행을 중복 생성하거나(멱등 깨짐) 메시지 저장 순서가 뒤바뀔 수 있다.
    this.enqueue(this.ingestChains, hint.discordChannelId, () => this.ingest(hint, e.ts, e.text, e.images ?? []));
  }

  // durable 저장만 담당(짧다) — 크래시 복구 불변식: 이 함수가 끝나면 메시지는 반드시
  // processed=false 로 DB 에 있다. 뒤이은 LLM 턴은 turnChains 로 넘겨 별도로 직렬화한다.
  private async ingest(hint: ConversationHint, ts: number, text: string, images: ImageRef[]): Promise<void> {
    const conv = await this.resolveConversation(hint, ts);

    // 예약어 세션 명령(/새세션 등): LLM 턴·메시지 저장 없이 세션만 리셋하고 확인을 보낸다.
    // 활발한 DM 이 같은 SDK 세션을 계속 resume 해 페르소나 변경이 반영되지 않는 걸, 소유자가
    // 직접 끊고 새 세션을 시작하는 용도(새 세션은 buildContextBlock 의 흉내-방지 안내로 캐릭터가 적용된다).
    if (parseSessionCommand(text) === "reset") {
      await this.repos.conversations.setSession(conv.id, null, ts);
      this.bus.publish({ type: "assistant_message", channel: "discord", channelRef: conv.discordChannelId, text: "…알겠어. 새 세션으로 시작할게. 다음 메시지부터 새로 대화하자.", ts: this.now() });
      return;
    }

    await this.repos.participants.upsert(conv.id, hint.userId, ts);
    // 미처리(processed=false)로 먼저 저장 → 크래시로 죽어도 부팅 시 recoverPending 이 재개한다.
    // 저장 content는 마커(§6: 과거 이미지 재주입 없음 — 이미지 자체는 저장하지 않고 몇 장/이름만 남긴다).
    const messageId = await this.repos.messages.insert({
      conversationId: conv.id, ts, role: "user", userId: hint.userId,
      discordMessageId: hint.discordMessageId, content: buildImageMarker(text, images), processed: false,
    });
    this.enqueue(this.turnChains, hint.discordChannelId, () => this.runConversationTurn(conv.id, hint.userId, hint.role as "owner" | "allowed", text, messageId, images));
  }

  // 힌트로 대화 행을 확정한다(멱등: discord_channel_id → origin_message_id → 생성).
  private async resolveConversation(hint: ConversationHint, ts: number): Promise<Conversation> {
    const byChannel = await this.repos.conversations.getByChannelId(hint.discordChannelId);
    if (byChannel) return this.reactivate(byChannel);
    if (hint.originMessageId) {
      const byOrigin = await this.repos.conversations.getByOriginMessageId(hint.originMessageId);
      if (byOrigin) return this.reactivate(byOrigin);
    }
    await this.repos.conversations.create({
      kind: hint.kind, discordChannelId: hint.discordChannelId, originMessageId: hint.originMessageId,
      guildId: hint.guildId, parentChannelId: hint.parentChannelId, primaryUserId: hint.primaryUserId,
      isPrivate: hint.isPrivate, lastActiveTs: ts,
    });
    return (await this.repos.conversations.getByChannelId(hint.discordChannelId))!;
  }

  // 유휴 정리로 status='idle' 로 닫혔던 대화가 새 메시지로 재활성되면 'active' 로 되살린다.
  // (listActiveIdle 은 status='active' 만 대상으로 하므로, 복원하지 않으면 이후 유휴 스윕에서 영구 누락된다.)
  private async reactivate(conv: Conversation): Promise<Conversation> {
    if (conv.status !== "active") {
      await this.repos.conversations.setStatus(conv.id, "active");
      return { ...conv, status: "active" };
    }
    return conv;
  }

  // 키별 직렬락(범용): 주어진 체인 맵에서 그 키의 꼬리 프라미스에 작업을 이어붙인다.
  // ingestChains/turnChains 모두 이 헬퍼로 큐잉한다.
  private enqueue(map: Map<string, Promise<void>>, key: string, task: () => Promise<void>): void {
    const prev = map.get(key) ?? Promise.resolve();
    const next = prev.then(task).catch((err) => {
      console.error("[core] 처리 오류:", err);
    });
    map.set(key, next);
  }

  // ingestChains·turnChains 가 모두 안정될 때까지 대기(테스트·그레이스풀 종료용).
  // ingest 가 끝나며 그 안에서 turnChains 에 새 작업을 추가하므로, 두 맵을 함께 스냅샷해
  // 반복 확인해야 "ingest 소진 → 그로 인해 turnChains 에 쌓인 것까지" 모두 잡아낸다.
  async drain(): Promise<void> {
    const maps = [this.ingestChains, this.turnChains];
    for (let i = 0; i < 1000; i++) {
      const chains = maps.flatMap((m) => [...m.values()]);
      await Promise.allSettled(chains);
      const after = maps.flatMap((m) => [...m.values()]);
      if (after.length === chains.length && after.every((p, idx) => p === chains[idx])) return;
    }
  }

  private async runConversationTurn(convId: number, userId: string, role: "owner" | "allowed", text: string, messageId: number, images: ImageRef[] = []): Promise<void> {
    try {
      const conv = await this.repos.conversations.getById(convId);
      if (!conv) return;
      // 특권/전원열람 게이트는 role 이 아니라 소유자 신원(§6 불변식: primary_user_id=owner)으로 판정한다.
      // manage_access 로 손님에게 'owner' 역할이 부여되어도 신원이 아니면 특권을 갖지 못하게 한다.
      const isOwner = userId === this.ownerId;

      // 한도: 소유자는 어떤 한도도 받지 않는다(예약 생략 → turns 미기록 → 손님 카운트에도 영향 없음).
      // 손님만 유저별+전역 한도로 원자 예약한다(구독 보호는 손님에게만 적용). 실패면 안내 후 종료.
      if (!isOwner) {
        const reserved = await this.repos.turns.reserve({
          userId, conversationId: conv.id, kind: "message", ts: this.now(),
          perUserLimit: this.config.maxTurnsPerHourPerUser, globalLimit: this.config.maxTurnsPerHourGlobal,
          ownerReserve: 0, isOwner: false, windowMs: HOUR_MS,
        });
        if (!reserved) {
          await this.notify(conv, "구독 한도 보호를 위해 잠시 쉬고 있어요. 1시간 안에 다시 시도해 주세요.");
          return;
        }
      }

      // 세션: 열린 세션이 유휴 이내면 resume(새 메시지만), 아니면 새 세션(기억 컨텍스트 주입).
      let resume: string | undefined;
      let prompt = text;
      if (conv.sessionId && this.now() - conv.lastActiveTs < this.idleMs()) {
        resume = conv.sessionId;
      } else {
        prompt = `${await buildContextBlock(this.repos, conv, messageId)}\n\n---\n\n사용자 메시지: ${text}`;
        // 이 메시지가 새 세션 윈도우의 시작 → 요약 범위(from_message_id) 기준점으로 기록한다.
        await this.repos.conversations.setFirstMessageId(conv.id, messageId);
        if (conv.isPrivate && conv.primaryUserId === this.ownerId) {
          await this.repos.conversations.setPrivateMemoryLoaded(conv.id, true);
        }
      }

      const context: TurnContext = { role, isPrivate: conv.isPrivate, isOwner, userId, conversationId: conv.id };
      const rapportStage = deriveRapportStage(await this.repos.messages.countUserMessages(userId));
      const systemPrompt = buildSystemPrompt({ role, isPrivate: conv.isPrivate, isOwner, deployTarget: this.config.deployTarget, rapportStage });
      const onProgress = (u: ProgressUpdate) => {
        this.bus.publish({ type: "progress", channel: "discord", channelRef: conv.discordChannelId, text: formatProgress(u), ts: this.now() });
      };

      // 이 턴에만 쓰는 이미지 다운로드(§6: DB엔 마커만 저장했으므로, 과거 이미지 재주입은 없다 —
      // 여기서 받는 images 는 이번 턴의 것뿐이다. 크래시복구 재개 시엔 images=[] 로 들어온다).
      // §8: 다운로드가 전부/일부 실패하면 모델이 이미지를 못 보고 텍스트만 받아 오답/환각할 수
      // 있으므로, 사용자에게 안내한다(턴 자체는 계속 진행 — 텍스트만으로라도 답한다).
      let imageInputs: ImageInput[] = [];
      if (images.length > 0) {
        const dl = await downloadImages(images, { fetchImpl: this.fetchImpl });
        imageInputs = dl.inputs;
        if (dl.failed.length > 0) {
          this.bus.publish({ type: "system_notice", channel: "discord", channelRef: conv.discordChannelId, text: `이미지 ${dl.failed.length}장을 불러오지 못했어요.`, ts: this.now() });
        }
      }

      let result: TurnResult;
      try {
        result = await this.runTurn({ prompt, systemPrompt, resume, cwd: this.agentCwd, context, onProgress, images: imageInputs });
      } catch (err) {
        if (resume && isSessionNotFound(err)) {
          // resume 세션이 SDK 쪽에 없음(클라우드 컨테이너 재배포/재시작으로 세션 저장소가 초기화됨 등)
          // → 그 세션을 버리고 새 세션 + 기억 컨텍스트로 재시도한다(대화 연속성 유지).
          console.warn("[core] resume 세션 없음 — 새 세션으로 재시도:", conv.id);
          await this.repos.conversations.setSession(conv.id, null, this.now());
          const fresh = (await this.repos.conversations.getById(convId)) ?? conv;
          const retryPrompt = `${await buildContextBlock(this.repos, fresh, messageId)}\n\n---\n\n사용자 메시지: ${text}`;
          await this.repos.conversations.setFirstMessageId(conv.id, messageId);
          if (conv.isPrivate && conv.primaryUserId === this.ownerId) {
            await this.repos.conversations.setPrivateMemoryLoaded(conv.id, true);
          }
          result = await this.runTurn({ prompt: retryPrompt, systemPrompt, resume: undefined, cwd: this.agentCwd, context, onProgress, images: imageInputs });
        } else {
          throw err;
        }
      }

      if (!result.ok) {
        await this.notify(conv, `비서 처리 중 오류가 있었어요: ${result.text}`);
        return;
      }
      if (result.text.trim().length === 0) {
        // 성공했지만 최종 텍스트가 비어 있음(도구만 호출하고 끝낸 경우 등). 빈 메시지는 저장/발행하지 않는다.
        await this.notify(conv, "이번엔 드릴 답을 만들지 못했어요. 다시 한 번 말씀해 주세요.");
        return;
      }

      await this.repos.messages.insert({ conversationId: conv.id, ts: this.now(), role: "assistant", content: result.text });
      await this.repos.conversations.setSession(conv.id, result.sessionId ?? conv.sessionId, this.now());
      this.bus.publish({ type: "assistant_message", channel: "discord", channelRef: conv.discordChannelId, text: result.text, ts: this.now() });
    } catch (err) {
      // 예외(SDK 프로세스 오류·인증 throw 등)도 종료 이벤트를 반드시 발행해야 한다. 그러지 않으면
      // 어댑터의 finishStatus 가 불려지지 않아 그 채널의 상태 메시지·반응이 유령으로 남고,
      // pendingTriggers(FIFO)가 영구적으로 어긋난다.
      console.error("[core] runConversationTurn 예외:", err);
      const conv = await this.repos.conversations.getById(convId);
      if (conv) {
        await this.notify(conv, "비서 처리 중 예기치 못한 오류가 발생했어요. 잠시 후 다시 시도해 주세요.");
      }
    } finally {
      await this.repos.messages.markProcessed(messageId);
    }
  }

  // 부팅 시 미처리 사용자 메시지를 그 대화 문맥으로 재개한다(크래시 복구).
  async recoverPending(): Promise<void> {
    for (const m of await this.repos.messages.unprocessedUserMessages()) {
      const conv = await this.repos.conversations.getById(m.conversationId);
      const userId = m.userId ?? conv?.primaryUserId ?? "";
      const role = await this.repos.users.getRole(userId);
      if (!conv || (role !== "owner" && role !== "allowed")) {
        await this.repos.messages.markProcessed(m.id);
        continue;
      }
      this.enqueue(this.turnChains, conv.discordChannelId, () => this.runConversationTurn(conv.id, userId, role, m.content, m.id));
    }
  }

  // 유휴 대화마다 요약 후 세션을 닫는다(turnChains 로 그 대화의 턴과 직렬).
  async closeIdleConversations(): Promise<void> {
    const cutoff = this.now() - this.idleMs();
    for (const conv of await this.repos.conversations.listActiveIdle(cutoff)) {
      this.enqueue(this.turnChains, conv.discordChannelId, () => this.summarizeAndClose(conv.id));
    }
  }

  private async summarizeAndClose(convId: number): Promise<void> {
    const conv = await this.repos.conversations.getById(convId);
    if (!conv || !conv.sessionId) return;
    if (this.now() - conv.lastActiveTs < this.idleMs()) return; // 그 사이 활동 → 정리 보류

    const isOwner = conv.primaryUserId === this.ownerId;
    const role: Role = isOwner ? "owner" : "allowed";
    // 소유자 대화의 요약도 무제한. 손님 대화 요약만 한도에 포함(초과면 요약은 건너뛰되 세션은 반드시 정리).
    const reserved = isOwner || await this.repos.turns.reserve({
      userId: null, conversationId: conv.id, kind: "summary", ts: this.now(),
      perUserLimit: this.config.maxTurnsPerHourPerUser, globalLimit: this.config.maxTurnsPerHourGlobal,
      ownerReserve: 0, isOwner: false, windowMs: HOUR_MS,
    });
    if (reserved) {
      // 리뷰 #4(MED): 클라우드 재배포/재시작 등으로 세션 저장소가 초기화되면 resume 이 실패할 수
      // 있다(isSessionNotFound 류). 이 요약 시도가 그대로 던지면 예외가 enqueue 의 catch 까지 올라가
      // 아래 compare-and-close 가 전혀 실행되지 않고, 세션이 active 로 고착되어 매 유휴 스윕마다
      // 같은 실패를 반복하며(손님 몫이면 전역 한도까지 소진) 대화가 영원히 안 닫힌다. 요약은
      // "있으면 좋은" 부가 기능이므로, 실패해도 요약만 건너뛰고 아래 세션 정리는 반드시 실행한다.
      try {
        const recentMsgs = await this.repos.messages.recent(conv.id, 1);
        const toMessageId = recentMsgs[0]?.id ?? conv.firstMessageId ?? 0;
        const result = await this.runTurn({
          prompt: SUMMARY_PROMPT,
          systemPrompt: buildSystemPrompt({ role, isPrivate: conv.isPrivate, isOwner, deployTarget: this.config.deployTarget }),
          resume: conv.sessionId, cwd: this.agentCwd,
          context: { role, isPrivate: conv.isPrivate, isOwner, userId: conv.primaryUserId, conversationId: conv.id },
        });
        if (result.ok && result.text.trim().length > 0) {
          await this.repos.summaries.insert({
            conversationId: conv.id, fromMessageId: conv.firstMessageId ?? 0, toMessageId,
            content: result.text.trim(), createdTs: this.now(),
          });
        }
      } catch (err) {
        console.warn("[core] 유휴 요약 실패 — 요약 없이 세션만 정리:", conv.id, err);
      }
    }
    // compare-and-close: 요약 대상이던 세션이 그대로일 때만 닫는다(동시 생성된 새 세션 보호).
    const fresh = await this.repos.conversations.getById(conv.id);
    if (fresh && fresh.sessionId === conv.sessionId) {
      await this.repos.conversations.setSession(conv.id, null, this.now());
      await this.repos.conversations.setStatus(conv.id, "idle");
    }
  }

  private async notify(conv: Conversation, text: string): Promise<void> {
    await this.repos.messages.insert({ conversationId: conv.id, ts: this.now(), role: "system", content: text });
    this.bus.publish({ type: "system_notice", channel: "discord", channelRef: conv.discordChannelId, text, ts: this.now() });
  }

  private idleMs(): number {
    return this.config.sessionIdleMinutes * 60 * 1000;
  }
}
