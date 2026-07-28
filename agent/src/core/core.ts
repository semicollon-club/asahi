import type { EventBus, UserMessageEvent, ConversationHint } from "../events/bus.js";
import type { Config } from "../config.js";
import { resolveTurnWorker, type TurnRunner, type TurnContext, type TurnResult, type ProgressUpdate } from "./agent.js";
import { buildSystemPrompt, deriveRapportStage } from "./persona.js";
import { parseSessionCommand, parseDigestCommand, parseHelpCommand, renderCommandHelp } from "./commands.js";
import { DIGEST_TOPICS } from "./digest.js";
import type { DigestRunner, DigestTopic } from "./digest.js";
import type { Role } from "../store/usersRepo.js";
import type { UsersRepo } from "../store/usersRepo.js";
import type { ConversationsRepo, Conversation } from "../store/conversationsRepo.js";
import type { ParticipantsRepo } from "../store/participantsRepo.js";
import type { MessagesRepo } from "../store/messagesRepo.js";
import type { SummariesRepo } from "../store/summariesRepo.js";
import type { MemoriesRepo } from "../store/memoriesRepo.js";
import type { TurnsRepo } from "../store/turnsRepo.js";
import type { AllowedDirsRepo } from "../store/allowedDirsRepo.js";
import type { ActionsRepo } from "../store/actionsRepo.js";
import type { WorkerKind } from "../store/workersRepo.js";
import { scopeDirs } from "./workerSelect.js";
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
  // 손님에게 "네 작업 폴더가 어디인가"를 알려주기 위해 필요하다(resolveGuestWorkspaceDirs).
  // 실제 경로 게이팅은 remoteToolHandler 가 ToolCtx 의 같은 리포로 따로 수행한다 — 코어는
  // 안내문을 만들 때만 읽는다.
  allowedDirs: AllowedDirsRepo;
  // 도구 호출 기록. 표시(bus)와 같은 이벤트에서 나온다 — 두 벌을 만들면 반드시 어긋난다.
  actions: ActionsRepo;
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
  // 카탈로그에 이미지가 있는 감정 이름들. 기동 시 한 번 읽어 넣는다(index.ts) — 생략되면 빈
  // 배열로 취급되어 persona.ts 가 표정 지침 자체를 프롬프트에서 뺀다.
  private emotions: string[];
  // FIX3(중요, 최종 리뷰): 능력 안내(persona.ts)가 실제 도구 상태를 반영하려면, systemPrompt 를
  // 만드는 시점(runTurn 호출 전)에 이미 "이번 턴에 워커가 연결돼 있는가"를 알아야 한다 — 그
  // 판정은 agent.ts 의 resolveTurnWorker 가 쓰는 것과 동일하다. Task 7: hub.isConnected 는
  // workerId 를 받는다(userId 가 아니다) — 워커가 registry 에 별도 id 로 등록되므로, 아래 registry
  // 로 실제 workerId 를 먼저 찾아야 한다(둘은 항상 짝으로 쓰인다).
  // 선택값(옵셔널)인 이유: 워커 배선이 없는 환경(테스트 등)에서는 늘 워커 미연결로 간주된다.
  private hub?: { isConnected(workerId: string): boolean };
  // Task 7: workers 테이블 조회 — resolveTurnWorker 가 "이 턴이 어느 워커를 쓰는가"를 실제
  // id 로 풀 때 쓴다(index.ts 는 repos.workers 를 그대로 넘긴다). hub 와 마찬가지로 배선이 없는
  // 환경(테스트 등)에서는 늘 워커 미연결로 간주된다(resolveTurnWorker 는 registry·hub 둘 중
  // 하나라도 없으면 null 을 돌려준다).
  private registry?: { personalWorkerOf(userId: string): Promise<string | null>; sharedWorkerId(): Promise<string | null> };
  // 정기 게시(조사) 실행기. 옵셔널인 이유는 hub 와 같다 — 배선이 없는 환경(테스트 등)에서는
  // 예약어를 받아도 실행할 대상이 없으므로 ingest 가 안내만 하고 넘어간다.
  // FIX1(치명, 최종 리뷰 3차): 예전엔 여기(AgentCore)에 예약어 전용 채널별 동시 실행 가드
  // (digestInFlight Set)를 따로 뒀다 — 그런데 스케줄 경로(index.ts 의 checkAndRun 타이머)는
  // 이 가드를 전혀 거치지 않아, 이전 틱의 턴이 안 끝난 채 다음 틱이 오면 같은 주제로 새 턴을
  // 또 시작하는 훨씬 심각한 재진입을 막지 못했다(리뷰 재현: 5틱 중 5턴 시작 — 매일 아침의
  // 정상 경로였다). 가드를 DigestRunner 내부(주제별 running Set)로 옮겨 checkAndRun·run 양쪽이
  // 같은 가드를 공유하게 했으므로, 이 필드는 삭제한다 — run() 의 반환값({ started: boolean })만
  // 보고 아래 ingest 에서 안내 여부를 정한다.
  private digest?: DigestRunner;

  constructor(deps: {
    bus: EventBus; config: Config; runTurn: TurnRunner; repos: CoreRepos; agentCwd: string; now?: () => number;
    fetchImpl?: typeof fetch; hub?: { isConnected(workerId: string): boolean };
    registry?: { personalWorkerOf(userId: string): Promise<string | null>; sharedWorkerId(): Promise<string | null> };
    emotions?: string[]; digest?: DigestRunner;
  }) {
    this.bus = deps.bus;
    this.config = deps.config;
    this.runTurn = deps.runTurn;
    this.repos = deps.repos;
    this.agentCwd = deps.agentCwd;
    this.ownerId = deps.config.ownerId;
    this.now = deps.now ?? Date.now;
    this.fetchImpl = deps.fetchImpl ?? fetch;
    this.hub = deps.hub;
    this.registry = deps.registry;
    this.emotions = deps.emotions ?? [];
    this.digest = deps.digest;
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
    // 일반 채널에서 멘션 없이 들어온 예약어(어댑터의 channel-command 경로). 대화를 조회하지도
    // 만들지도 않고 그 자리에서 끝낸다 — 여기서 conversations 행을 만들면 그 채널이 봇 대화로
    // 굳어(decideRoute 의 hasConversation) 이후 그 채널의 모든 메시지에 답하기 시작한다.
    // 어댑터의 isChannelCommand 를 통과한 것만 오므로 /help 와 조사 예약어 둘뿐이다.
    if (hint.commandOnly) {
      if (parseHelpCommand(text)) {
        this.bus.publish({ type: "assistant_message", channel: "discord", channelRef: hint.discordChannelId, text: renderCommandHelp(), ts: this.now() });
        return;
      }
      const topic = parseDigestCommand(text);
      if (topic) await this.startDigestCommand(topic, { userId: hint.userId, conv: null, replyRef: hint.discordChannelId, isPrivate: false });
      return;
    }

    const conv = await this.resolveConversation(hint, ts);

    // 예약어 세션 명령(/새세션 등): LLM 턴·메시지 저장 없이 세션만 리셋하고 확인을 보낸다.
    // 활발한 DM 이 같은 SDK 세션을 계속 resume 해 페르소나 변경이 반영되지 않는 걸, 소유자가
    // 직접 끊고 새 세션을 시작하는 용도(새 세션은 buildContextBlock 의 흉내-방지 안내로 캐릭터가 적용된다).
    if (parseSessionCommand(text) === "reset") {
      await this.repos.conversations.setSession(conv.id, null, ts);
      this.bus.publish({ type: "assistant_message", channel: "discord", channelRef: conv.discordChannelId, text: "…알겠어. 새 세션으로 시작할게. 다음 메시지부터 새로 대화하자.", ts: this.now() });
      return;
    }

    // 도움말: 예약어 목록만 보여준다. 모델을 부르지 않는다.
    if (parseHelpCommand(text)) {
      this.bus.publish({ type: "assistant_message", channel: "discord", channelRef: conv.discordChannelId, text: renderCommandHelp(), ts: this.now() });
      return;
    }

    const digestTopic = parseDigestCommand(text);
    if (digestTopic) {
      await this.startDigestCommand(digestTopic, { userId: hint.userId, conv, replyRef: conv.discordChannelId, isPrivate: hint.isPrivate });
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

  // 정기 게시 예약어(/대회·/개발뉴스)를 즉시 실행한다. 스케줄의 lastRun 은 건드리지 않는다 —
  // 수동으로 한 번 봤다고 다음 날 아침 게시가 걸러지면 안 된다.
  //
  // 두 경로가 이 메서드 하나를 쓴다: 대화 안(스레드·DM, conv 있음)과 일반 채널의 예약어
  // (commandOnly, conv 없음). conv 는 안내를 대화 기록에도 남길지에만 쓰인다.
  //
  // replyRef 는 "명령을 친 곳"(안내·거부 문구가 가는 곳)이고, 조사 결과 자체는 그 주제의 지정
  // 채널로 간다 — 스레드에서 부르면 결과가 스레드에 갇혀 밖에서 안 보이던 문제 때문이다.
  // 지정 채널이 없으면(DIGEST_*_CHANNEL_ID 미설정) 친 곳으로 폴백한다.
  //
  // LLM 대화 턴 체인(turnChains)·메시지 저장은 거치지 않지만 손님 한도(turns.reserve)는 반드시
  // 통과시킨다 — 이 조사 턴은 claude-opus·웹검색·maxTurns:30 으로 이 앱에서 가장 비싼 턴이라,
  // 예약어로 이 검사를 건너뛰면 구독 한도 보호가 완전히 무력화된다(리뷰 발견: 손님이 예약어를
  // 연타해 무제한·동시 다발로 조사를 돌릴 수 있었음).
  private async startDigestCommand(
    topic: DigestTopic,
    o: { userId: string; conv: Conversation | null; replyRef: string; isPrivate: boolean },
  ): Promise<void> {
    const publishNotice = (text: string) =>
      this.bus.publish({ type: "system_notice", channel: "discord", channelRef: o.replyRef, text, ts: this.now() });
    // FIX6(사소, 머지 전 리뷰): 리다이렉트 안내는 오류·거부가 아니라 정상 진행 상황이다. discord.ts 는
    // system_notice 를 전부 ⚠️ 로 접두해(어댑터가 갖는 유일한 시각적 구분) 진짜 경고를 눈에 띄게
    // 하는데, 이 문구까지 그 경로를 타면 담담한 안내가 경고처럼 보인다. assistant_message 로 보내
    // 그 접두사를 피한다 — 이 텍스트엔 표정 마커가 없어 parseExpression 은 그대로 통과시키고
    // (emotion:null), resolveExpression 도 즉시 undefined 로 끝나 이미지 경로에 영향이 없다. 턴 종료
    // (finishStatus, ✅ 반응) 처리는 system_notice 와 완전히 같은 경로를 그대로 타므로 그 동작도
    // 달라지지 않는다.
    const publishAck = (text: string) =>
      this.bus.publish({ type: "assistant_message", channel: "discord", channelRef: o.replyRef, text, ts: this.now() });

    if (!this.digest) {
      publishNotice("지금은 조사 기능이 꺼져 있어요.");
      return;
    }

    // 손님 한도: runConversationTurn 의 예약과 완전히 같은 모양·한도·거부 문구를 그대로 재사용한다
    // (§8 불변식 유지, 새 한도값·문구를 만들지 않는다). 소유자는 신원(userId===ownerId) 기준으로
    // 기존 정책대로 무제한 — 예약 자체를 생략한다. conversationId 는 대화가 없으면 null 이다
    // (turns.reserve 가 허용한다 — 한도 계산은 user_id 와 전역 카운트만 본다).
    const isOwner = o.userId === this.ownerId;
    if (!isOwner) {
      const reserved = await this.repos.turns.reserve({
        userId: o.userId, conversationId: o.conv?.id ?? null, kind: "proactive", ts: this.now(),
        perUserLimit: this.config.maxTurnsPerHourPerUser, globalLimit: this.config.maxTurnsPerHourGlobal,
        ownerReserve: 0, isOwner: false, windowMs: HOUR_MS,
      });
      if (!reserved) {
        const text = "구독 한도 보호를 위해 잠시 쉬고 있어요. 1시간 안에 다시 시도해 주세요.";
        // 대화가 있으면 기존대로 대화 기록에도 남긴다(notify). 없으면 알림만 보낸다.
        if (o.conv) await this.notify(o.conv, text);
        else publishNotice(text);
        return;
      }
    }

    // DM 에서 부른 건 DM 에 답한다. 공개 채널로 돌리면 혼자 확인해 보려던 것이 매번 동아리
    // 채널에 게시돼 버린다 — 스레드에 갇히는 문제는 서버 쪽 이야기고, DM 은 애초에 보기 힘든
    // 곳이 아니다. 공개 채널에 올리고 싶으면 서버에서 부르면 된다(양쪽 다 가능해진다).
    const target = o.isPrivate ? o.replyRef : (this.config.digestChannels[topic] ?? o.replyRef);
    if (target !== o.replyRef) {
      publishAck(`「${DIGEST_TOPICS[topic].label}」 소식은 <#${target}> 에 올릴게. 잠깐만.`);
    }

    // 같은 주제의 동시 실행 방지는 DigestRunner 내부의 주제별 running Set 이 담당한다 —
    // checkAndRun(스케줄)·run(예약어) 양쪽에 똑같이 적용된다. run() 이 { started:false } 를
    // 돌려주면 이미 도는 중이라는 뜻이다. 손님 몫은 위에서 이미 예약했으므로 겹쳐서 거부돼도
    // 되돌려주지 않는다(가장 비싼 턴이 두 번 도는 것보다 손님의 몫 하나를 쓰는 편이 훨씬 싸다).
    //
    // digest 를 지역 상수로 캡처해야 아래 클로저에서 undefined 가 아닌 타입으로 좁혀진다
    // (this.digest 는 위에서 존재를 확인했지만, TS 는 클로저 안에서 this 필드의 좁힘을 유지하지 않는다).
    const digest = this.digest;
    void (async () => {
      try {
        const { started } = await digest.run(topic, target);
        // 거부 안내는 결과가 가는 곳이 아니라 명령을 친 곳으로 보낸다 — 그쪽을 보고 있으니까.
        if (!started) publishNotice("지금 같은 주제로 이미 조사 중이에요. 끝나면 다시 시도해 주세요.");
      } catch (err) {
        console.error("[core] 조사 실행 오류:", err);
      }
    })();
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
      // Task 7: 능력 안내는 "지금 이 턴에 워커가 실제로 연결돼 있는가"로 갈린다 — agent.ts 의
      // resolveTurnWorker 와 완전히 같은 판정(위치 기반 선택 → registry 로 workerId 조회 → hub
      // 연결 확인)을 여기서도 계산해 페르소나에 싣는다. 예전(shouldConnectWorker)엔 hub.isConnected
      // 를 userId 로 직접 불렀는데, 워커가 registry 에 별도 id 로 등록되는 지금은 그게 항상
      // 어긋난다 — registry 조회를 거치지 않으면 워커가 실제로 연결돼 있어도 이 안내가 늘 "연결
      // 안 됨"으로 나온다. 도구셋 자체는 agent.ts(makeRunAgentTurn)가 같은 함수로 별도로 다시
      // 계산한다 — 두 계산이 어긋나면(예: 이 사이 워커가 끊기면) 프롬프트와 실제 도구가 그 한
      // 턴만 어긋날 수 있지만, "안내 자체가 없거나 늘 거짓"이었던 이전 버그보다는 낫다.
      const worker = await resolveTurnWorker({ context: { isOwner, isPrivate: conv.isPrivate, userId } }, this.registry, this.hub);
      const workerConnected = worker !== null;
      const workspaceDirs = await this.resolveGuestWorkspaceDirs(worker, isOwner, userId);
      const systemPrompt = buildSystemPrompt({ role, isPrivate: conv.isPrivate, isOwner, deployTarget: this.config.deployTarget, rapportStage, workerConnected, emotions: this.emotions, workspaceDirs });
      const onProgress = (u: ProgressUpdate) => {
        this.bus.publish({ type: "progress", channel: "discord", channelRef: conv.discordChannelId, text: formatProgress(u), ts: this.now() });
        // 기록은 도구 호출이 끝난 시점에만 남긴다(tool 이벤트는 짝이 맞춰져 이 한 행에 흡수된다).
        // 부가 기능이므로 실패해도 턴을 죽이지 않는다 — hub.ts 의 touchLastSeen 과 같은 패턴.
        if (u.kind !== "tool_result") return;
        void this.repos.actions
          .record({
            ts: this.now(), conversationId: conv.id, userId,
            tool: u.name ?? "(unknown)", input: u.input,
            resultSummary: u.summary, status: u.ok ? "ok" : "error", durationMs: u.durationMs,
          })
          .catch((err) => console.error("[core] 도구 기록 실패:", err));
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

  // 손님에게 자기 작업 폴더 경로를 알려주기 위한 값(persona.ts 의 workspaceDirs). 게이팅에는
  // 쓰이지 않는다 — 실제 판정은 remoteToolHandler 가 매 호출마다 따로 한다. 다만 같은 함수
  // (scopeDirs)와 같은 입력(그 워커의 allowed_dirs)에서 뽑아, 안내와 집행이 갈리지 않게 한다.
  //
  // 소유자는 대상이 아니다: scopeDirs 가 소유자를 좁히지 않아 allowed_dirs 가 곧 "그 사람의
  // 폴더" 하나로 특정되지 않고, 애초에 list_dirs 로 직접 조회할 수 있다. 개인 워커도 대상이
  // 아니다 — 거기엔 손님이 붙지 않는다(resolveWorkerSelector).
  private async resolveGuestWorkspaceDirs(
    worker: { workerId: string; kind: WorkerKind } | null,
    isOwner: boolean,
    userId: string,
  ): Promise<string[] | undefined> {
    if (worker === null || worker.kind !== "shared" || isOwner) return undefined;
    try {
      const dirs = await this.repos.allowedDirs.list(worker.workerId);
      return scopeDirs(dirs, { workerKind: worker.kind, isOwner, userId });
    } catch (err) {
      // 안내용 부가 정보일 뿐이라 실패해도 턴을 죽이지 않는다(경로 없이 진행 — 예전 동작과 같다).
      // scopeDirs 는 joinUnderRoot 를 통해 이상한 userId 를 거부하며 던질 수 있는데, 그 경우
      // remoteToolHandler 도 같은 예외를 fail closed 로 처리하므로 여기서 생략해도 실제 접근이
      // 더 열리지는 않는다 — 안내만 예전처럼 "경로 없음"으로 돌아간다.
      console.error("[core] 손님 작업 폴더 계산 실패 — 경로 안내 없이 진행:", err);
      return undefined;
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
          // FIX4(중요, 최종 리뷰): 이 턴은 noRemoteTools 로 원격 도구를 강제로 닫으므로(아래),
          // 페르소나에도 항상 workerConnected:false 를 실어 "안내와 실제 도구"가 어긋나지 않게
          // 한다 — 실제 hub 연결 상태를 여기서 다시 물어 true 가 나오더라도, 이 턴 자체는
          // noRemoteTools 때문에 fs_*/sh_exec 를 못 쓰므로 그 상태를 그대로 안내하면 FIX3 가
          // 고친 것과 같은 종류의 거짓 안내(도구는 없는데 있다고 말하는)가 새로 생긴다.
          systemPrompt: buildSystemPrompt({ role, isPrivate: conv.isPrivate, isOwner, deployTarget: this.config.deployTarget, workerConnected: false, emotions: this.emotions }),
          resume: conv.sessionId, cwd: this.agentCwd,
          context: { role, isPrivate: conv.isPrivate, isOwner, userId: conv.primaryUserId, conversationId: conv.id },
          // FIX4: 유휴 요약은 사람이 지켜보지 않는 타이머로 돌고, 이전에 모델이 읽은 파일 등을
          // 통해 프롬프트 인젝션이 심어졌을 수도 있는 세션을 그대로 이어받는다(resume). 워커
          // 연결 여부·소유자 신원과 무관하게 원격 도구(fs_*/sh_exec, FIX2 로 같은 축에 묶인
          // allow_dir 등)를 강제로 닫는다.
          noRemoteTools: true,
          // FIX3(중요, 최종 리뷰 3차): noRemoteTools 는 이름 그대로 원격 도구 축만 잠그고 SDK
          // 내장 WebSearch 는 건드리지 않는다 — 이 브랜치로 모든 턴이 웹 검색을 갖게 되면서, 이
          // 무인 요약 턴도 실제로는 WebSearch 를 그대로 쓸 수 있었다(리뷰 재현: db_schema/
          // db_query 로 소유자 DB 전체를 읽을 수 있는 턴에 외부로 내보낼 통로까지 열려 있었던
          // 셈). 요약은 이미 끝난 대화를 요약할 뿐 검색이 필요 없으므로, 별도 플래그로 함께 닫는다.
          noWebTools: true,
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
