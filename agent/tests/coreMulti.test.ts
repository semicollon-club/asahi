import { describe, it, expect, vi } from "vitest";
import { EventBus, type AgentEvent, type ConversationHint } from "../src/events/bus.js";
import { openTestDb } from "../src/store/db.js";
import { UsersRepo } from "../src/store/usersRepo.js";
import { ConversationsRepo } from "../src/store/conversationsRepo.js";
import { ParticipantsRepo } from "../src/store/participantsRepo.js";
import { MessagesRepo } from "../src/store/messagesRepo.js";
import { SummariesRepo } from "../src/store/summariesRepo.js";
import { MemoriesRepo } from "../src/store/memoriesRepo.js";
import { TurnsRepo } from "../src/store/turnsRepo.js";
import { AllowedDirsRepo } from "../src/store/allowedDirsRepo.js";
import { ActionsRepo } from "../src/store/actionsRepo.js";
import { AgentCore } from "../src/core/core.js";
import { filterFileAttachments, FILE_LIMITS } from "../src/core/attachments.js";
import type { Config } from "../src/config.js";
import type { TurnRequest, TurnResult } from "../src/core/agent.js";
import { resolveMemoryWriteEnabled } from "../src/core/agent.js";
import { allowedToolsFor } from "../src/core/tools.js";
import type { DigestRunner } from "../src/core/digest.js";

const HOUR = 60 * 60 * 1000;
// pg-mem 의 Pool.query() 는 마이크로태스크가 아니라 매크로태스크(setImmediate) 단위로 풀린다
// (스파이크로 확인: 순수 Promise.resolve() 반복으로는 영원히 안 풀림). handleUserMessage 가
// resolveConversation·참가자 upsert·메시지 저장까지 순차 쿼리를 여러 번 거치므로, 그 홉 수만큼
// setImmediate 로 넘겨줘야 "아직 처리 전"인 중간 상태(manual 모드)를 정확히 관찰할 수 있다.
const flush = async () => {
  for (let i = 0; i < 40; i++) await new Promise((r) => setImmediate(r));
};

async function setup(over: {
  config?: Partial<Config>; mode?: "immediate" | "manual" | "throw" | "resume-fails";
  imageFetch?: typeof fetch;
  // Task 3: AgentCore 의 실제 hub 타입은 이제 isConnected 외에 call·rootsOf 도 요구한다(파일
  // 첨부를 워커로 내려받는 데 필요). 이 파일의 기존 테스트 대부분은 워커 "연결 여부"만 보고
  // call/rootsOf 는 전혀 쓰지 않으므로, 그 테스트들이 전부 더미 구현을 채워 넣게 만들지 않도록
  // 여기서는 둘을 옵셔널로 두고 아래에서 기본값으로 채운다(over.hub 를 그대로 넘기면 그 좁은
  // 타입이 AgentCore 생성자 타입과 안 맞아 컴파일이 막힌다).
  hub?: {
    isConnected(workerId: string): boolean;
    call?(workerId: string, tool: string, args: Record<string, unknown>): Promise<{ ok: boolean; content: string }>;
    rootsOf?(workerId: string): string[];
  };
  registry?: { personalWorkerOf(userId: string): Promise<string | null>; sharedWorkerId(): Promise<string | null> };
  digest?: DigestRunner;
  // 코어가 now() 를 부를 때마다 시각이 이만큼 흐르게 한다(기본 0 = 지금까지처럼 고정 시계).
  // "한 번 구한 시각을 두 곳에 쓴다"는 종류의 불변식은 고정 시계로는 검증할 수 없다 — 두 번
  // 구해도 같은 값이 나와 버려서 어긋난 구현이 그대로 통과한다(/기억정리 의 바닥선·created_ts).
  tickMs?: number;
} = {}) {
  const db = await openTestDb();
  const repos = {
    users: new UsersRepo(db), conversations: new ConversationsRepo(db), participants: new ParticipantsRepo(db),
    messages: new MessagesRepo(db), summaries: new SummariesRepo(db), memories: new MemoriesRepo(db), turns: new TurnsRepo(db),
    // 손님 작업 폴더 안내(resolveGuestWorkspaceDirs)가 읽는다. tsconfig 의 include 가 src 뿐이라
    // 테스트는 타입 검사를 받지 않는다 — 여기서 빠뜨리면 tsc 도 vitest 도 잡아 주지 않고,
    // 코어의 try/catch 가 삼켜 "경로 안내 없음"으로 조용히 degrade 한다.
    allowedDirs: new AllowedDirsRepo(db),
    actions: new ActionsRepo(db),
  };
  await repos.users.upsert("owner", { role: "owner" });
  await repos.users.upsert("guest", { role: "allowed" });
  await repos.users.upsert("guest2", { role: "allowed" });
  const config: Config = {
    discordToken: "t", ownerId: "owner", databaseUrl: "postgres://test", dataDir: ":memory:", memoryDir: "x",
    sessionIdleMinutes: 30, maxTurnsPerHour: 30, maxTurnsPerHourPerUser: 20, maxTurnsPerHourGlobal: 40, ownerReserve: 10,
    deployTarget: "local",
    // 타입 검사를 켜면서 드러난 누락 — Config 의 필수 필드인데 가짜에 없었다. 코어는 model 을
    // runTurn 요청에, httpPort 를 워커 허브 리스너에 쓴다.
    model: "claude-opus-4-8", httpPort: 3000,
    // 기본은 미설정(빈 객체) — 조사 결과가 명령을 친 곳으로 폴백하는 경로다.
    // 지정 채널로 보내는 경로는 over.config 로 덮어써 따로 검증한다.
    digestChannels: {},
    ...over.config,
  };
  let clock = 1_000_000;
  const calls: TurnRequest[] = [];
  let nextResult: TurnResult = { text: "답변", sessionId: "s1", ok: true };
  const resolvers: Array<() => void> = [];
  const mode = over.mode ?? "immediate";
  const runTurn = (req: TurnRequest): Promise<TurnResult> => {
    calls.push(req);
    req.onProgress?.({ kind: "answering" }); // 코어가 onProgress 를 progress 이벤트로 발행하는지 확인용
    if (mode === "throw") return Promise.reject(new Error("SDK 프로세스 오류(테스트용)"));
    if (mode === "resume-fails") {
      // resume 을 쓴 턴은 "세션 없음"으로 실패(클라우드 컨테이너 재시작 등), 새 세션 턴은 성공.
      if (req.resume) return Promise.reject(new Error(`Claude Code returned an error result: No conversation found with session ID: ${req.resume}`));
      return Promise.resolve(nextResult);
    }
    if (mode === "immediate") return Promise.resolve(nextResult);
    return new Promise((res) => resolvers.push(() => res(nextResult)));
  };
  const bus = new EventBus();
  // Task 7: AgentCore 는 이제 registry 도 받는다(resolveTurnWorker 가 hub.isConnected 를 부르기
  // 전에 workerId 를 먼저 찾는 데 쓴다). 기본값은 personalWorkerOf 를 항등(userId 를 그대로
  // workerId 로 씀)으로 흉내낸다 — 이 파일의 hub 가짜들이 원래 userId 로 isConnected 를 판정하던
  // 습관과 그대로 맞물려, over.hub 를 바꾸는 기존 테스트를 건드리지 않고도 워커 해석이 통과한다.
  const registry = over.registry ?? {
    personalWorkerOf: async (userId: string) => userId,
    sharedWorkerId: async () => "shared-worker",
  };
  // over.hub 가 call·rootsOf 를 안 줬으면 기본 구현으로 채운다(위 setup 파라미터 주석 참고) —
  // 이 기본값을 실제로 부르는 테스트가 있다면 그건 그 테스트가 fakeHub 를 직접 만들어야 한다는
  // 신호이므로, 눈에 띄게 실패하도록 ok:false 로 답한다(조용히 성공한 척하지 않는다).
  const hub = over.hub === undefined ? undefined : {
    isConnected: over.hub.isConnected,
    call: over.hub.call ?? (async () => ({ ok: false, content: "이 테스트의 가짜 허브는 call 을 구현하지 않았어요." })),
    rootsOf: over.hub.rootsOf ?? (() => []),
  };
  // 코어에 주입하는 시계만 흐른다. 아래 반환하는 t.now() 는 지금 시각을 읽기만 한다(흐르지
  // 않는다) — 테스트가 메시지 ts 를 만들 때 쓰는 값이라, 읽는 것만으로 시각이 밀리면 안 된다.
  const tickMs = over.tickMs ?? 0;
  const core = new AgentCore({
    bus, config, runTurn, now: () => { const v = clock; clock += tickMs; return v; }, repos, agentCwd: "/data/agent",
    fetchImpl: over.imageFetch, hub, registry, digest: over.digest,
  });
  core.start();
  const published: AgentEvent[] = [];
  // 블록 본문으로 둔다 — 화살표 한 줄로 쓰면 push 의 반환값(number)이 구독 콜백의 반환 타입
  // (void | Promise<void>)과 어긋난다.
  bus.subscribe("assistant_message", (e) => { published.push(e); });
  bus.subscribe("system_notice", (e) => { published.push(e); });
  bus.subscribe("progress", (e) => { published.push(e); });
  return {
    db, bus, core, calls, published, repos, resolvers,
    setClock: (t: number) => { clock = t; },
    setResult: (r: TurnResult) => { nextResult = r; },
    now: () => clock,
  };
}

let seq = 0;
function dmHint(userId: string, role: "owner" | "allowed"): ConversationHint {
  return { kind: "dm", discordChannelId: `dm-${userId}`, isPrivate: true, primaryUserId: userId, userId, role, discordMessageId: `msg-${seq++}` };
}
function threadHint(userId: string, channelId: string, role: "owner" | "allowed", origin: string): ConversationHint {
  return { kind: "thread", discordChannelId: channelId, originMessageId: origin, guildId: "g", parentChannelId: "p", isPrivate: false, primaryUserId: userId, userId, role, discordMessageId: `msg-${seq++}` };
}
function pub(bus: EventBus, hint: ConversationHint, text: string, ts: number): void {
  bus.publish({ type: "user_message", channel: "discord", channelRef: hint.discordChannelId, text, ts, hint });
}

// 예약어 조사의 동시 실행 가드를 테스트하려면 digest.run 이 끝나는 시점을 테스트가 직접
// 제어해야 한다(즉시 resolve 되는 가짜로는 "진행 중" 상태를 관찰할 틈이 없다). resolve/reject 를
// pending 배열로 노출해, 테스트가 원하는 시점에 하나씩 정확히 흘려보낸다.
//
// 리뷰 수정(FIX1, 최종 리뷰 3차): 동시 실행 가드는 이제 AgentCore(옛 digestInFlight Set)가
// 아니라 DigestRunner 내부(주제별 running Set)에 있다. AgentCore 는 run() 의 반환값
// ({ started: boolean })만 보고 "이미 조사 중" 안내를 낼지 정한다 — 그 가드 자체가 실제로
// 동작하는지는 digestRunner.test.ts 가 실물 DigestRunner 로 직접 검증한다. 이 가짜는 AgentCore
// 쪽의 안내 로직만 겨냥하므로, 실물과 같은 모양(주제별 Set)으로 최소한만 흉내낸다.
function manualDigest() {
  const calls: Array<{ topic: string; channelRef: string }> = [];
  const pending: Array<{ resolve: () => void; reject: (err: unknown) => void }> = [];
  const running = new Set<string>();
  const run = (topic: string, channelRef: string): Promise<{ started: boolean }> => {
    if (running.has(topic)) return Promise.resolve({ started: false });
    running.add(topic);
    calls.push({ topic, channelRef });
    return new Promise<{ started: boolean }>((resolve, reject) => {
      pending.push({
        resolve: () => { running.delete(topic); resolve({ started: true }); },
        reject: (err) => { running.delete(topic); reject(err); },
      });
    });
  };
  return { calls, pending, digest: { run } };
}

describe("AgentCore — 멀티유저/멀티대화", () => {
  it("소유자 DM 새 세션엔 개인+공용 기억, 서버 대화엔 공용만 주입한다(프라이버시 불변식)", async () => {
    const t = await setup();
    await t.repos.memories.insert({ userId: "owner", scope: "user", title: "개인", content: "소유자비밀ABC" });
    await t.repos.memories.insert({ userId: "owner", scope: "shared", title: "공용", content: "공용정보XYZ" });
    pub(t.bus, dmHint("owner", "owner"), "안녕", 1);
    await t.core.drain();
    expect(t.calls[0].prompt).toContain("소유자비밀ABC");
    expect(t.calls[0].prompt).toContain("공용정보XYZ");

    pub(t.bus, threadHint("owner", "ch-1", "owner", "o1"), "서버안녕", 2);
    await t.core.drain();
    expect(t.calls[1].prompt).not.toContain("소유자비밀ABC"); // 서버엔 개인기억 미주입
    expect(t.calls[1].prompt).toContain("공용정보XYZ");
  });

  it("손님 DM 은 그 손님의 개인기억만 주입하고, 소유자 개인기억은 넣지 않는다", async () => {
    const t = await setup();
    await t.repos.memories.insert({ userId: "guest", scope: "user", title: "g", content: "손님비밀G" });
    await t.repos.memories.insert({ userId: "owner", scope: "user", title: "o", content: "소유자비밀O" });
    pub(t.bus, dmHint("guest", "allowed"), "안녕", 1);
    await t.core.drain();
    expect(t.calls[0].prompt).toContain("손님비밀G");
    expect(t.calls[0].prompt).not.toContain("소유자비밀O");
  });

  it("역할이 'owner'로 부여된 손님이라도 소유자 신원이 아니면 특권(isOwner)을 갖지 않는다(프라이버시 게이트 신원화)", async () => {
    const t = await setup();
    await t.repos.users.upsert("guest", { role: "owner" }); // 손님에게 owner 역할이 부여된 상황
    pub(t.bus, dmHint("guest", "owner"), "hi", 1);     // role=owner 로 들어오지만 userId≠ownerId
    await t.core.drain();
    expect(t.calls[0].context.isOwner).toBe(false);    // 신원(userId===ownerId)이 아니므로 전원열람·특권 없음
  });

  it("턴 컨텍스트로 role/isPrivate/isOwner 를 정확히 전달한다(도구 제한 근거)", async () => {
    const t = await setup();
    pub(t.bus, threadHint("guest", "ch-1", "allowed", "g1"), "hi", 1);
    await t.core.drain();
    expect(t.calls[0].context).toMatchObject({ role: "allowed", isPrivate: false, isOwner: false, userId: "guest" });

    pub(t.bus, dmHint("owner", "owner"), "hi", 2);
    await t.core.drain();
    expect(t.calls[1].context).toMatchObject({ role: "owner", isPrivate: true, isOwner: true, userId: "owner" });
    expect(t.calls[1].cwd).toBe("/data/agent");
  });

  it("같은 대화는 직렬(재진입 금지)로 처리한다", async () => {
    const t = await setup({ mode: "manual" });
    pub(t.bus, dmHint("owner", "owner"), "A1", 1);
    pub(t.bus, dmHint("owner", "owner"), "A2", 2);
    await flush();
    expect(t.calls.length).toBe(1); // A2 는 A1 이 끝날 때까지 대기
    t.resolvers.shift()!();
    await flush();
    expect(t.calls.length).toBe(2);
  });

  it("앞 메시지 턴이 진행 중이어도 같은 채널 후속 메시지가 즉시 durable 저장된다(크래시 복구 회귀 방지)", async () => {
    const t = await setup({ mode: "manual" });
    const hint = dmHint("owner", "owner");
    pub(t.bus, hint, "A", 1);
    await flush();
    expect(t.calls.length).toBe(1); // A 의 턴이 시작되어(LLM 호출) 대기 중

    pub(t.bus, hint, "B", 2);
    await flush();
    // B 의 턴은 A 뒤에 직렬(turnChains)이라 아직 시작되지 않았어야 하지만,
    // durable 저장(ingest)은 턴과 분리되어 있으므로 A·B 모두 이미 processed=false 로 저장돼 있어야 한다.
    expect(t.calls.length).toBe(1);
    const unprocessed = await t.repos.messages.unprocessedUserMessages();
    expect(unprocessed.map((m) => m.content)).toEqual(["A", "B"]);

    t.resolvers.shift()!(); // A 턴 완료 → B 턴 시작
    await flush();
    expect(t.calls.length).toBe(2);
    t.resolvers.shift()!(); // B 턴 완료
    await flush();
    expect((await t.repos.messages.unprocessedUserMessages()).length).toBe(0);
  });

  it("다른 대화는 병렬로 동시에 진행한다", async () => {
    const t = await setup({ mode: "manual" });
    pub(t.bus, dmHint("owner", "owner"), "A", 1);
    pub(t.bus, threadHint("owner", "ch-x", "owner", "ox"), "B", 2);
    await flush();
    expect(t.calls.length).toBe(2); // 서로 다른 대화 → 둘 다 시작
  });

  it("유저별 한도를 넘으면 LLM 을 호출하지 않고 안내한다", async () => {
    const t = await setup({ config: { maxTurnsPerHourPerUser: 1 } });
    pub(t.bus, dmHint("guest", "allowed"), "1", 1);
    await t.core.drain();
    pub(t.bus, dmHint("guest", "allowed"), "2", 2);
    await t.core.drain();
    expect(t.calls.length).toBe(1);
    expect(t.published.find((e) => e.type === "system_notice")?.text).toContain("한도");
  });

  it("소유자는 유저별·전역 한도를 전혀 받지 않는다(무제한)", async () => {
    const t = await setup({ config: { maxTurnsPerHourPerUser: 1, maxTurnsPerHourGlobal: 1 } });
    for (let i = 0; i < 4; i++) {
      pub(t.bus, dmHint("owner", "owner"), `m${i}`, i + 1);
      await t.core.drain();
    }
    expect(t.calls.length).toBe(4); // 1/1 한도를 무시하고 4번 모두 처리
  });

  it("손님 전역 상한은 globalLimit 이며, 소유자 사용량은 손님 카운트에 영향을 주지 않는다", async () => {
    const t = await setup({ config: { maxTurnsPerHourGlobal: 2, maxTurnsPerHourPerUser: 99 } });
    // 소유자가 여러 번 사용해도(무제한·카운트 제외) 손님 몫에 영향 없음
    for (let i = 0; i < 3; i++) {
      pub(t.bus, dmHint("owner", "owner"), `o${i}`, i + 1);
      await t.core.drain();
    }
    const guestCalls = () => t.calls.filter((c) => c.context.userId !== "owner").length;
    // 손님 두 명이 전역 2까지
    pub(t.bus, dmHint("guest", "allowed"), "g1", 10);
    await t.core.drain();
    pub(t.bus, dmHint("guest2", "allowed"), "g2", 11);
    await t.core.drain();
    expect(guestCalls()).toBe(2);
    // 손님 전역 상한(2) 도달 → 세 번째 손님 발화는 막힘
    pub(t.bus, dmHint("guest", "allowed"), "g3", 12);
    await t.core.drain();
    expect(guestCalls()).toBe(2);
  });

  it("resume 세션이 없으면(클라우드 재시작 등) 새 세션 + 기억 컨텍스트로 재시도한다", async () => {
    const t = await setup({ mode: "resume-fails" });
    // 첫 메시지: resume 없이 새 세션 → 성공(세션 s1 저장)
    pub(t.bus, dmHint("owner", "owner"), "1", t.now());
    await t.core.drain();
    expect(t.calls.length).toBe(1);
    expect(t.calls[0].resume).toBeUndefined();
    // 두 번째: resume s1 시도 → "세션 없음" 실패 → 새 세션으로 재시도 성공
    pub(t.bus, dmHint("owner", "owner"), "2", t.now());
    await t.core.drain();
    expect(t.calls.length).toBe(3);
    expect(t.calls[1].resume).toBe("s1");        // resume 시도(실패)
    expect(t.calls[2].resume).toBeUndefined();   // 새 세션 재시도
    expect(t.calls[2].prompt).toContain("기억 컨텍스트");
    // 최종 답변이 정상 발행되고, 오류 안내가 나가지 않는다
    expect(t.published.some((e) => e.type === "assistant_message")).toBe(true);
    expect(t.published.find((e) => e.type === "system_notice" && e.text.includes("오류"))).toBeUndefined();
  });

  it("유휴 이내면 resume, 유휴가 지나면 새 세션으로 시작한다", async () => {
    const t = await setup();
    pub(t.bus, dmHint("owner", "owner"), "1", t.now());
    await t.core.drain();
    expect(t.calls[0].resume).toBeUndefined();
    pub(t.bus, dmHint("owner", "owner"), "2", t.now());
    await t.core.drain();
    expect(t.calls[1].resume).toBe("s1");
    t.setClock(1_000_000 + 31 * 60 * 1000);
    pub(t.bus, dmHint("owner", "owner"), "3", t.now());
    await t.core.drain();
    expect(t.calls[2].resume).toBeUndefined();
    expect(t.calls[2].prompt).toContain("기억 컨텍스트");
  });

  it("대화마다 세션이 독립이다(A 의 세션으로 B 를 resume 하지 않는다)", async () => {
    const t = await setup();
    pub(t.bus, dmHint("owner", "owner"), "A1", 1);
    await t.core.drain();
    pub(t.bus, threadHint("owner", "ch-b", "owner", "ob"), "B1", 2);
    await t.core.drain();
    expect(t.calls[1].resume).toBeUndefined(); // 새 대화 B → resume 없음
  });

  it("빈 응답이면 assistant 를 저장하지 않고 폴백 안내를 보낸다", async () => {
    const t = await setup();
    t.setResult({ text: "   ", sessionId: "s1", ok: true });
    pub(t.bus, dmHint("owner", "owner"), "안녕", 1);
    await t.core.drain();
    const conv = (await t.repos.conversations.getByChannelId("dm-owner"))!;
    const roles = (await t.repos.messages.recent(conv.id, 10)).map((m) => m.role);
    expect(roles).not.toContain("assistant");
    expect(t.published.find((e) => e.type === "system_notice")).toBeDefined();
  });

  it("runTurn 이 onProgress 를 호출하면 progress 이벤트가 그 대화 채널로 발행된다", async () => {
    const t = await setup();
    pub(t.bus, dmHint("owner", "owner"), "안녕", 1);
    await t.core.drain();
    const progress = t.published.find((e) => e.type === "progress");
    expect(progress).toBeDefined();
    expect(progress).toMatchObject({ type: "progress", channel: "discord", channelRef: "dm-owner", text: "답변 작성 중" });
  });

  it("턴이 실패하면 오류를 안내한다", async () => {
    const t = await setup();
    t.setResult({ text: "(에이전트 오류: error_during_execution)", sessionId: undefined, ok: false });
    pub(t.bus, dmHint("owner", "owner"), "안녕", 1);
    await t.core.drain();
    expect(t.published.find((e) => e.type === "system_notice")?.text).toContain("오류");
  });

  it("runTurn이 예외를 던지면 system_notice를 발행하고 메시지를 완료 처리한다(유령 상태 메시지·FIFO 오염 방지)", async () => {
    const t = await setup({ mode: "throw" });
    pub(t.bus, dmHint("owner", "owner"), "안녕", 1);
    await t.core.drain();
    const notice = t.published.find((e) => e.type === "system_notice");
    expect(notice).toBeDefined();
    expect(notice?.channelRef).toBe("dm-owner");
    // finally 의 markProcessed 는 예외 시에도 반드시 실행되어야 한다(대화 체인이 영구 정지하지 않도록).
    expect((await t.repos.messages.unprocessedUserMessages()).length).toBe(0);
  });

  it("부팅 시 미처리 메시지를 그 대화 문맥으로 재개한다", async () => {
    const t = await setup();
    const convId = await t.repos.conversations.create({ kind: "dm", discordChannelId: "dm-owner", primaryUserId: "owner", isPrivate: true, lastActiveTs: 1 });
    await t.repos.messages.insert({ conversationId: convId, ts: 1, role: "user", userId: "owner", content: "크래시전메시지", processed: false });
    await t.core.recoverPending();
    await t.core.drain();
    expect(t.calls.length).toBe(1);
    expect(t.calls[0].prompt).toContain("크래시전메시지");
    expect((await t.repos.messages.unprocessedUserMessages()).length).toBe(0);
  });

  it("유휴 대화를 요약하고 세션을 닫는다", async () => {
    const t = await setup();
    pub(t.bus, dmHint("owner", "owner"), "기억해줘", t.now());
    await t.core.drain();
    const conv = (await t.repos.conversations.getByChannelId("dm-owner"))!;
    expect(conv.sessionId).toBe("s1");
    t.setClock(1_000_000 + 31 * 60 * 1000);
    t.setResult({ text: "인사를 나눴다.", sessionId: "s1", ok: true });
    await t.core.closeIdleConversations();
    await t.core.drain();
    expect(await t.repos.summaries.recent(conv.id, 1)).toEqual(["인사를 나눴다."]);
    expect((await t.repos.conversations.getById(conv.id))!.sessionId).toBeNull();
  });

  it("리뷰 #4(MED): 요약 시도 중 resume 세션을 못 찾아 실패해도(위임 대화 등) 요약은 건너뛰고 세션은 반드시 닫는다", async () => {
    // 위임된 대화의 세션은 워커 PC 에 있어 봇 쪽 SDK 로는 resume 이 안 된다 — summarizeAndClose 가
    // 이 실패를 그냥 던지면 compare-and-close 가 실행되지 않아 세션이 active 로 고착되고, 다음 유휴
    // 스윕마다 같은 실패를 반복하며 손님 전역 한도를 계속 갉아먹는다(회귀 확인용 mode).
    const t = await setup({ mode: "resume-fails" });
    // resume-fails 모드는 resume 없는 호출만 성공하므로, 첫 메시지로 세션을 먼저 확보한다.
    pub(t.bus, dmHint("owner", "owner"), "안녕", t.now());
    await t.core.drain();
    const conv = (await t.repos.conversations.getByChannelId("dm-owner"))!;
    expect(conv.sessionId).toBe("s1");

    t.setClock(1_000_000 + 31 * 60 * 1000);
    await t.core.closeIdleConversations();
    await t.core.drain();

    const after = await t.repos.conversations.getById(conv.id);
    expect(after?.sessionId).toBeNull(); // resume 실패에도 불구하고 반드시 닫힘
    expect(after?.status).toBe("idle");
    expect(await t.repos.summaries.recent(conv.id, 1)).toEqual([]); // 요약 자체는 실패했으므로 저장되지 않음
  });

  it("요약의 from_message_id 를 세션 첫 메시지로 기록한다(0 이 아님)", async () => {
    const t = await setup();
    pub(t.bus, dmHint("owner", "owner"), "첫 메시지", t.now());
    await t.core.drain();
    const conv = (await t.repos.conversations.getByChannelId("dm-owner"))!;
    const firstUserMsg = (await t.repos.messages.recent(conv.id, 10)).find((m) => m.role === "user")!;
    t.setClock(1_000_000 + 31 * 60 * 1000);
    t.setResult({ text: "요약", sessionId: "s1", ok: true });
    await t.core.closeIdleConversations();
    await t.core.drain();
    const r = await t.db.query("SELECT from_message_id FROM conversation_summaries WHERE conversation_id = $1", [conv.id]);
    const row = r.rows[0] as { from_message_id: number | string };
    expect(Number(row.from_message_id)).toBe(firstUserMsg.id);
    expect(Number(row.from_message_id)).not.toBe(0);
  });

  it("유휴 정리로 닫힌 대화가 재활성되면 다음 유휴 사이클에 다시 요약된다(status 고착 방지)", async () => {
    const t = await setup();
    pub(t.bus, dmHint("owner", "owner"), "1", t.now());
    await t.core.drain();
    const conv = (await t.repos.conversations.getByChannelId("dm-owner"))!;

    // 1차 유휴 정리 → 세션 닫힘
    t.setClock(1_000_000 + 31 * 60 * 1000);
    t.setResult({ text: "요약1", sessionId: "s1", ok: true });
    await t.core.closeIdleConversations();
    await t.core.drain();
    expect((await t.repos.conversations.getById(conv.id))!.sessionId).toBeNull();

    // 재활성: 새 메시지 → 새 세션 s2
    t.setResult({ text: "답", sessionId: "s2", ok: true });
    pub(t.bus, dmHint("owner", "owner"), "2", t.now());
    await t.core.drain();
    expect((await t.repos.conversations.getById(conv.id))!.sessionId).toBe("s2");

    // 2차 유휴 → 다시 요약·종료되어야 한다(버그면 status='idle' 고착으로 스윕에서 누락)
    t.setClock(t.now() + 31 * 60 * 1000);
    t.setResult({ text: "요약2", sessionId: "s2", ok: true });
    await t.core.closeIdleConversations();
    await t.core.drain();
    expect(await t.repos.summaries.recent(conv.id, 1)).toEqual(["요약2"]);
    expect((await t.repos.conversations.getById(conv.id))!.sessionId).toBeNull();
  });
});

describe("AgentCore — 친근도(rapportStage) 주입", () => {
  it("누적 user 메시지가 적으면 소유자 프롬프트에 '서먹', 10개 이상이면 '익숙' 문구가 담긴다", async () => {
    const t = await setup();
    // 첫 대화: 이번 메시지 1개만 카운트 → stage 0(서먹)
    pub(t.bus, dmHint("owner", "owner"), "안녕", 1);
    await t.core.drain();
    expect(t.calls[0].systemPrompt).toMatch(/서먹/);

    // owner user 메시지를 9개 추가로 심어 다음 턴의 카운트를 10으로 만든다(9 + 이번 1 = 10)
    for (let i = 0; i < 9; i++) {
      await t.repos.messages.insert({ conversationId: 1, ts: 10 + i, role: "user", userId: "owner", content: `m${i}` });
    }
    pub(t.bus, dmHint("owner", "owner"), "또 안녕", 100);
    await t.core.drain();
    expect(t.calls[1].systemPrompt).toMatch(/익숙/);
  });
});

// FIX3(중요, 최종 리뷰) — 능력 안내(persona.ts)는 이제 deployTarget 이 아니라 "이번 턴에 워커가
// 실제로 연결돼 있는가"로 갈린다. core.ts 는 이 판정을 agent.ts 의 shouldConnectWorker 로 직접
// 계산해(makeRunAgentTurn 이 도구셋을 계산할 때 쓰는 것과 동일한 함수) systemPrompt 에 싣는다 —
// 그러지 않으면 실제로 fs_*/sh_exec 가 열려 있는데도 페르소나는 "PC 작업을 못 한다"고 안내하는
// (또는 그 반대) 불일치가 생긴다.
describe("AgentCore — 원격 워커 연결 상태를 페르소나에 반영한다(FIX3)", () => {
  it("그 소유자의 워커가 연결돼 있으면 owner-DM 프롬프트가 실제 도구 이름(fs_read/sh_exec)으로 PC 작업이 가능하다고 안내한다", async () => {
    const t = await setup({ hub: { isConnected: (userId) => userId === "owner" } });
    pub(t.bus, dmHint("owner", "owner"), "안녕", 1);
    await t.core.drain();
    expect(t.calls[0].systemPrompt).toMatch(/fs_read/);
    expect(t.calls[0].systemPrompt).toMatch(/sh_exec/);
  });

  it("워커가 연결돼 있지 않으면(hub 미배선) owner-DM 프롬프트가 PC 작업 불가를 안내한다", async () => {
    const t = await setup(); // hub 없음
    pub(t.bus, dmHint("owner", "owner"), "안녕", 1);
    await t.core.drain();
    expect(t.calls[0].systemPrompt).toMatch(/워커/);
    expect(t.calls[0].systemPrompt).toMatch(/연결되면/);
    expect(t.calls[0].systemPrompt).not.toMatch(/fs_read/);
  });

  // 최종 리뷰 FIX4 — 이 테스트는 예전엔 "손님은 원래도 PC 도구 언급이 없다"(워커 연결과 무관하게
  // 항상 fs_read 를 언급하지 않는다)를 확인했다. 그건 persona.ts 의 손님 분기가 workerConnected 를
  // 아예 보지 않던 시절의 동작을 그대로 굳힌 것이었다 — 그런데 Task 7 로 손님도 공유 기계가
  // 연결되면 실제로 fs_*/sh_exec 를 받으므로(scopeDirs 로 자기 폴더에 갇힌 채), 그 상태에서
  // "PC 도구 언급이 없다"는 안내가 오히려 실제 도구 보유와 어긋났다(안내와 실제 도구가 어긋나는
  // 결함 유형 — FIX4 가 고쳤다). 지금은 반대로 "워커가 연결되면 언급한다"를 확인한다(Task 7 반전).
  it("워커가 연결되면 손님 DM 안내도 파일·셸 도구를 언급한다 — 폴더 관리 도구는 언급하지 않는다(FIX4, Task 7 반전)", async () => {
    const t = await setup({ hub: { isConnected: () => true } });
    pub(t.bus, dmHint("guest", "allowed"), "안녕", 1);
    await t.core.drain();
    expect(t.calls[0].systemPrompt).toMatch(/fs_read/);
    expect(t.calls[0].systemPrompt).not.toMatch(/manage_access/);
    expect(t.calls[0].systemPrompt).not.toMatch(/allow_dir/);
  });
});

// 실사용에서 드러난 문제 — 능력 안내가 "네 몫의 폴더"라고만 하고 경로를 주지 않아, 손님이
// "내 워크스페이스에 폴더 만들어줘"라고 하면 봇이 절대경로를 되물었다. 손님에겐 list_dirs
// (관리자 전용)도 없어 자기 디스코드 숫자 id 를 직접 알아내는 것 말고는 방법이 없었다.
// core 가 remoteToolHandler 와 같은 scopeDirs 계산으로 경로를 구해 페르소나에 싣는다 —
// 안내와 집행이 다른 계산에서 나오면 어긋난다.
describe("AgentCore — 손님 작업 폴더 경로를 페르소나에 싣는다", () => {
  const sharedHub = { isConnected: (id: string) => id === "shared-worker" };

  it("공유 워커가 연결돼 있고 allowed_dirs 가 있으면 손님 프롬프트에 그 손님 몫의 경로가 담긴다", async () => {
    const t = await setup({ hub: sharedHub });
    await t.repos.allowedDirs.add("shared-worker", "C:\\ws");
    pub(t.bus, dmHint("guest", "allowed"), "내 폴더에 파일 하나 만들어줘", 1);
    await t.core.drain();
    // scopeDirs 가 붙인 하위 폴더까지 그대로 — 루트만 알려주면 손님이 루트에 쓰려다 거부당한다.
    expect(t.calls[0].systemPrompt).toContain("C:\\ws\\guest");
  });

  it("손님마다 자기 폴더만 담긴다(다른 손님 폴더가 새지 않는다)", async () => {
    const t = await setup({ hub: sharedHub });
    await t.repos.allowedDirs.add("shared-worker", "C:\\ws");
    pub(t.bus, dmHint("guest", "allowed"), "안녕", 1);
    await t.core.drain();
    expect(t.calls[0].systemPrompt).toContain("C:\\ws\\guest");
    expect(t.calls[0].systemPrompt).not.toContain("C:\\ws\\guest2");
  });

  it("소유자에게는 싣지 않는다 — scopeDirs 가 좁히지 않아 한 폴더로 특정되지 않고 list_dirs 로 직접 조회한다", async () => {
    const t = await setup({ hub: { isConnected: () => true } });
    await t.repos.allowedDirs.add("shared-worker", "C:\\ws");
    pub(t.bus, threadHint("owner", "ch-1", "owner", "m-1"), "안녕", 1);
    await t.core.drain();
    expect(t.calls[0].systemPrompt).not.toContain("C:\\ws\\owner");
  });

  it("allowed_dirs 가 비어 있으면 도구 안내는 유지하되 경로 줄은 넣지 않는다(경로를 지어낼 여지를 주지 않는다)", async () => {
    const t = await setup({ hub: sharedHub });
    pub(t.bus, dmHint("guest", "allowed"), "안녕", 1);
    await t.core.drain();
    expect(t.calls[0].systemPrompt).toMatch(/fs_read/);
    expect(t.calls[0].systemPrompt).not.toMatch(/작업 폴더는/);
  });

  it("워커가 연결돼 있지 않으면 경로를 안내하지 않는다(도구가 없는데 위치만 알리지 않는다)", async () => {
    const t = await setup(); // hub 미배선
    await t.repos.allowedDirs.add("shared-worker", "C:\\ws");
    pub(t.bus, dmHint("guest", "allowed"), "안녕", 1);
    await t.core.drain();
    expect(t.calls[0].systemPrompt).not.toContain("C:\\ws\\guest");
  });
});

// FIX4(중요, 최종 리뷰) — 유휴 대화 요약 턴은 사람이 지켜보지 않는 타이머로 돌고, 이전에 모델이
// 읽은 파일 등을 통해 프롬프트 인젝션이 심어졌을 수도 있는 세션을 그대로 이어받는다(resume). 그런
// 턴에도 원격 도구가 열려 있으면 그 인젝션이 아무도 모르는 사이에 실제 PC 작업으로 이어질 수
// 있다 — noRemoteTools 로 워커 연결 여부와 무관하게 강제로 닫는다.
describe("AgentCore — 유휴 요약 턴은 원격 도구를 강제로 닫는다(FIX4)", () => {
  it("워커가 연결돼 있어도 요약 턴의 요청은 noRemoteTools:true 이고, systemPrompt 도 PC 작업 가능을 안내하지 않는다", async () => {
    const t = await setup({ hub: { isConnected: () => true } });
    pub(t.bus, dmHint("owner", "owner"), "기억해줘", t.now());
    await t.core.drain();
    // 평상시 턴(인덱스 0)은 워커 연결을 반영해 fs_read 를 안내한다(FIX3 회귀 가드).
    expect(t.calls[0].systemPrompt).toMatch(/fs_read/);
    expect(t.calls[0].noRemoteTools).toBeUndefined();

    t.setClock(1_000_000 + 31 * 60 * 1000);
    t.setResult({ text: "요약했다.", sessionId: "s1", ok: true });
    await t.core.closeIdleConversations();
    await t.core.drain();

    const summaryCall = t.calls[t.calls.length - 1];
    expect(summaryCall.noRemoteTools).toBe(true);
    // FIX3 이 고친 것과 같은 종류의 거짓 안내를 새로 만들지 않는다 — 이 턴은 실제로 도구가
    // 닫혀 있으므로 페르소나도 "가능하다"고 말하면 안 된다.
    expect(summaryCall.systemPrompt).not.toMatch(/fs_read/);
    expect(summaryCall.systemPrompt).not.toMatch(/클라우드에서 실행 중이라/);
  });
});

// Important 2(리뷰 후속) — 요약 턴의 신원은 명령을 친 사람이 아니라 대화 주인(conv.primaryUserId)
// 에서 나온다. 어댑터는 이미 있는 스레드에 들어온 손님에게도 그 스레드의 primaryUserId 를 그대로
// 실어 주므로(discord.ts 의 existingPrimaryUserId), 손님이 소유자 스레드에서 /기억정리 를 치면
// 손님이 쓴 텍스트가 담긴 세션을 소유자 도구셋으로 이어받는 턴이 뜬다 — FIX3/FIX4 가 막으려던
// 인젝션 면 그대로다. 그중 forget 은 동아리 공용 기억을 지우고 손님 분기엔 아예 없는 도구다.
// 신원 자체를 바꾸면 요약 대상 세션과 프롬프트 계층이 어긋나므로, 기억 축을 닫는 쪽으로 막는다.
describe("AgentCore — 요약 턴은 기억 쓰기 축을 닫는다(Important 2)", () => {
  it("소유자 스레드에 들어온 손님이 /기억정리 를 쳐도 그 턴은 noMemoryWrite:true 라 remember·forget 을 하나도 받지 못한다", async () => {
    const t = await setup();
    // 소유자가 연 스레드(primaryUserId = owner, 세션 s1).
    pub(t.bus, threadHint("owner", "ch-1", "owner", "o1"), "안녕", 1);
    await t.core.drain();

    // 손님이 같은 스레드에 들어온다 — 어댑터가 실어 주는 모양 그대로(primaryUserId 는 소유자).
    const guestInOwnerThread: ConversationHint = {
      kind: "thread", discordChannelId: "ch-1", originMessageId: "o1", guildId: "g", parentChannelId: "p",
      isPrivate: false, primaryUserId: "owner", userId: "guest", role: "allowed", discordMessageId: `msg-${seq++}`,
    };
    pub(t.bus, guestInOwnerThread, "/기억정리", 2);
    await t.core.drain();

    const summaryCall = t.calls[t.calls.length - 1];
    // 신원은 여전히 대화 주인에서 나온다(그 사실 자체는 이 수정이 바꾸지 않는다 — 아래 도구셋으로 막는다).
    expect(summaryCall.context).toMatchObject({ isOwner: true, role: "owner", userId: "owner" });
    expect(summaryCall.noMemoryWrite).toBe(true);

    // 그 플래그가 실제 도구 목록까지 도달하는지 — agent.ts 가 하는 계산을 그대로 재현한다.
    const memoryWriteEnabled = resolveMemoryWriteEnabled(summaryCall);
    const tools = allowedToolsFor(summaryCall.context.role, summaryCall.context.isPrivate, summaryCall.context.isOwner, "local", { memoryWriteEnabled });
    expect(tools).not.toContain("mcp__asahi__forget");
    expect(tools).not.toContain("mcp__asahi__remember");
    expect(tools).toContain("mcp__asahi__recall");
  });

  it("유휴 스윕의 요약 턴도 같은 축을 닫는다 — 두 호출부가 writeSummary 하나를 공유한다", async () => {
    const t = await setup();
    pub(t.bus, dmHint("owner", "owner"), "안녕", t.now());
    await t.core.drain();
    expect(t.calls[0].noMemoryWrite).toBeUndefined(); // 평상시 턴은 그대로(회귀 가드)

    t.setClock(1_000_000 + 31 * 60 * 1000);
    await t.core.closeIdleConversations();
    await t.core.drain();
    expect(t.calls[t.calls.length - 1].noMemoryWrite).toBe(true);
  });
});

describe("AgentCore — DM 세션 예약어(/새세션·/기억정리)", () => {
  it("예약어를 받으면 세션을 리셋하고 확인만 보내며, LLM 턴·메시지 저장을 하지 않는다", async () => {
    const t = await setup();
    // 먼저 일반 대화로 세션을 하나 만든다(nextResult.sessionId = 's1').
    pub(t.bus, dmHint("owner", "owner"), "안녕", 1);
    await t.core.drain();
    expect(t.calls).toHaveLength(1);
    const before = await t.repos.conversations.getByChannelId("dm-owner");
    expect(before?.sessionId).toBe("s1");
    const msgCountBefore = await t.repos.messages.countUserMessages("owner");

    // 예약어 전송 → 세션 리셋 + 확인, 새 턴/저장 없음.
    pub(t.bus, dmHint("owner", "owner"), "/새세션", 2);
    await t.core.drain();

    expect(t.calls).toHaveLength(1); // 새 LLM 턴이 돌지 않았다
    const after = await t.repos.conversations.getByChannelId("dm-owner");
    expect(after?.sessionId).toBeNull(); // 세션이 리셋됐다
    expect(await t.repos.messages.countUserMessages("owner")).toBe(msgCountBefore); // 명령어는 기록되지 않았다
    const notices = t.published.filter((p) => p.type === "assistant_message");
    // 문구가 바뀌었다 — 세션이 "새로 시작"됐다는 것만으론 대화가 끊기는지 알 수 없다.
    // 이제는 이전 대화를 안 가져간다는 것을 명시한다(Task 3).
    expect(notices.some((n) => /안 가져갈게/.test((n as { text: string }).text))).toBe(true);
  });

  it("/새세션 은 바닥선을 긋고 캐릭터 설정을 지우되 기억은 남긴다", async () => {
    const t = await setup();
    await t.repos.memories.insert({ userId: "owner", scope: "character", title: "학년", content: "2학년" });
    await t.repos.memories.insert({ userId: "owner", scope: "shared", title: "회비", content: "2만원" });
    await t.repos.memories.insert({ userId: "owner", scope: "user", title: "개인", content: "내 메모" });
    pub(t.bus, dmHint("owner", "owner"), "안녕", 1);
    await t.core.drain();

    pub(t.bus, dmHint("owner", "owner"), "/새세션", 2);
    await t.core.drain();

    const after = await t.repos.conversations.getByChannelId("dm-owner");
    expect(after?.sessionId).toBeNull();
    expect(after?.contextFloorTs).not.toBeNull();
    expect(await t.repos.memories.characterFacts(40)).toEqual([]);
    // 여기가 핵심 — 삭제 범위가 새면 동아리 공용 기억이 복구 불가능하게 사라진다.
    expect((await t.repos.memories.sharedOnly()).map((m) => m.title)).toEqual(["회비"]);
    expect((await t.repos.memories.forUser("owner")).map((m) => m.title).sort()).toEqual(["개인", "회비"]);
    expect(t.calls).toHaveLength(1); // 예약어는 LLM 턴 없이 끝난다(회귀 방지)
  });

  it("/기억정리 는 요약을 남기고 세션·바닥선을 설정한다", async () => {
    // tickMs:1 — 고정 시계면 now() 를 두 번 불러도 같은 값이 나와, 바닥선과 created_ts 를
    // 따로 구하는 잘못된 구현도 아래 단정을 그대로 통과한다(실제로 확인함). 시계를 흐르게 해야
    // "한 번 구해 두 곳에 쓴다"가 진짜로 고정된다.
    const t = await setup({ tickMs: 1 });
    pub(t.bus, dmHint("owner", "owner"), "안녕", 1);
    await t.core.drain();

    pub(t.bus, dmHint("owner", "owner"), "/기억정리", 2);
    await t.core.drain();

    const conv = (await t.repos.conversations.getByChannelId("dm-owner"))!;
    expect(await t.repos.summaries.recent(conv.id, 3)).toHaveLength(1);
    expect(conv.sessionId).toBeNull();
    expect(conv.contextFloorTs).not.toBeNull();
    // 바닥선과 요약의 created_ts 가 같아야 요약이 스스로 걸러지지 않는다(필터가 >= 다).
    // 두 값을 직접 맞춰 본다 — recent(…, floor) 만으로는 created_ts 가 바닥선보다 "뒤"로
    // 어긋난 경우를 못 잡는다(>= 라서 통과해 버린다).
    const r = await t.db.query("SELECT created_ts FROM conversation_summaries WHERE conversation_id = $1", [conv.id]);
    expect(Number((r.rows[0] as { created_ts: number | string }).created_ts)).toBe(conv.contextFloorTs);
    expect(await t.repos.summaries.recent(conv.id, 3, conv.contextFloorTs!)).toHaveLength(1);
  });

  it("/기억정리 는 요약이 실패하면 세션도 바닥선도 건드리지 않는다", async () => {
    // 이 태스크의 핵심 안전장치다 — 밀어놓고 요약이 없으면 대화를 잃고 대신 받은 것도 없다.
    const t = await setup();
    pub(t.bus, dmHint("owner", "owner"), "안녕", 1);
    await t.core.drain();
    const before = (await t.repos.conversations.getByChannelId("dm-owner"))!;

    // 다음 runTurn 이 ok:false 를 돌려주게 한다. 이 파일에 이미 있는 수단이 setResult 뿐이고,
    // mode:"throw" 는 예외라 ok:false 와 다른 경로다 — writeSummary 는 둘 다 false 로 접지만,
    // 브리핑이 고정하려는 것은 "실패한 결과"쪽이므로 그것을 그대로 만든다.
    t.setResult({ text: "(에이전트 오류: error_during_execution)", sessionId: undefined, ok: false });
    pub(t.bus, dmHint("owner", "owner"), "/기억정리", 2);
    await t.core.drain();

    const after = (await t.repos.conversations.getByChannelId("dm-owner"))!;
    expect(after.sessionId).toBe(before.sessionId);
    expect(after.contextFloorTs).toBe(before.contextFloorTs);
    expect(await t.repos.summaries.recent(after.id, 3)).toHaveLength(0);
  });

  // Minor(리뷰 후속) — writeSummary 는 예외만 로그를 남기고, ok:false·빈 텍스트 갈래는 아무 말
  // 없이 false 만 돌려줬다. 사용자에게는 "정리하다 실패했어"가 나가는데 로그에는 아무것도 없어,
  // 모델이 실패한 것인지 빈 답을 낸 것인지조차 구분할 수 없었다.
  it("요약 턴이 실패하거나 빈 텍스트를 돌려주면 진단할 수 있는 로그를 남긴다", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const t = await setup();
      pub(t.bus, dmHint("owner", "owner"), "안녕", 1);
      await t.core.drain();

      t.setResult({ text: "(에이전트 오류: error_during_execution)", sessionId: undefined, ok: false });
      pub(t.bus, dmHint("owner", "owner"), "/기억정리", 2);
      await t.core.drain();
      expect(warn.mock.calls.some((c) => String(c[0]).includes("요약 턴이 실패로 끝남"))).toBe(true);

      // 실패했으므로 세션은 그대로다 — 같은 대화에 한 번 더 칠 수 있다.
      warn.mockClear();
      t.setResult({ text: "   ", sessionId: "s1", ok: true });
      pub(t.bus, dmHint("owner", "owner"), "/기억정리", 3);
      await t.core.drain();
      expect(warn.mock.calls.some((c) => String(c[0]).includes("빈 텍스트"))).toBe(true);
    } finally {
      warn.mockRestore();
    }
  });

  it("정리할 세션이 없으면 요약을 시도하지 않고 안내만 한다", async () => {
    const t = await setup();
    pub(t.bus, dmHint("owner", "owner"), "/기억정리", 1);
    await t.core.drain();
    expect(t.calls).toHaveLength(0);
    const notices = t.published.filter((p) => p.type === "assistant_message");
    expect(notices).toHaveLength(1);
  });

  it("/기억정리 는 캐릭터 설정을 지우지 않는다 — 그건 /새세션 의 몫이다", async () => {
    // 두 명령의 차이가 문구에만 있고 동작에 없으면, 정리하려던 사람이 신상까지 잃는다.
    const t = await setup();
    await t.repos.memories.insert({ userId: "owner", scope: "character", title: "학년", content: "2학년" });
    pub(t.bus, dmHint("owner", "owner"), "안녕", 1);
    await t.core.drain();

    pub(t.bus, dmHint("owner", "owner"), "/기억정리", 2);
    await t.core.drain();

    expect((await t.repos.memories.characterFacts(40)).map((m) => m.title)).toEqual(["학년"]);
  });

  // 리뷰 재현(Important 1) — /기억정리 는 ingest 체인에서 곧바로 돌지만 대화 턴은 turn 체인에서
  // 돈다. 진행 중이던 턴이 끝나면서 setSession(result.sessionId) 을 쓰면, 그 직전에 정리가 그어
  // 놓은 바닥선만 남고 세션은 되살아난다 — 다음 턴이 정리되지 않은 세션을 이어받는데 DB 기록은
  // 바닥선에 가려져 안 보이는 최악의 조합이고, 사용자에게는 "정리했어"라고 이미 말한 뒤다.
  it("진행 중이던 대화 턴이 /기억정리 가 끊은 세션을 되살리지 못한다", async () => {
    const t = await setup({ mode: "manual" });
    pub(t.bus, dmHint("owner", "owner"), "안녕", 1);
    await flush();
    t.resolvers[0]!(); // 첫 턴 완료 → 세션 s1 확정
    await flush();
    expect((await t.repos.conversations.getByChannelId("dm-owner"))?.sessionId).toBe("s1");

    pub(t.bus, dmHint("owner", "owner"), "하나만 더", 2); // 이 턴은 아직 진행 중이다
    await flush();
    expect(t.calls).toHaveLength(2);

    pub(t.bus, dmHint("owner", "owner"), "/기억정리", 3);
    await flush();

    // 리뷰가 재현한 순서 그대로 — 요약 턴이 먼저 끝나고, 진행 중이던 대화 턴이 그 뒤에 끝난다.
    // 수정 후에는 요약 턴이 대화 턴 뒤에 직렬화되어 이 시점에 아직 시작조차 안 했으므로
    // resolvers[2] 가 없다(그래서 옵셔널 호출이고, 아래에서 한 번 더 부른다).
    t.resolvers[2]?.();
    await flush();
    t.resolvers[1]!();
    await flush();
    t.resolvers[2]?.();
    await t.core.drain();

    const after = (await t.repos.conversations.getByChannelId("dm-owner"))!;
    expect(after.sessionId).toBeNull();
    expect(after.contextFloorTs).toBe(1_000_000);
    expect(await t.repos.summaries.recent(after.id, 3)).toHaveLength(1);
    const notices = t.published.filter((p) => p.type === "assistant_message").map((p) => (p as { text: string }).text);
    expect(notices.some((n) => /정리했어/.test(n))).toBe(true);
  });

  // Important 1(리뷰 후속) — turn 체인 직렬화 위에 한 겹 더. 요약 턴이 도는 동안 다른 경로가
  // 이 대화에 새 세션을 만들어 놓았다면, 그걸 끊는 것은 사용자가 시킨 일이 아니고 바닥선까지
  // 그으면 그 새 대화가 통째로 가려진다. summarizeAndClose 가 쓰는 compare-and-close 와 같다.
  // 세션을 리포로 직접 바꾸는 이유: 어느 경로가 그 쓰기를 했는지가 아니라 "요약하던 세션이
  // 아니게 됐다"는 사실 하나만이 이 가드의 판정 근거이기 때문이다.
  it("요약하는 사이에 세션이 다른 것으로 바뀌면 세션도 바닥선도 건드리지 않고 그대로 알린다", async () => {
    const t = await setup({ mode: "manual" });
    pub(t.bus, dmHint("owner", "owner"), "안녕", 1);
    await flush();
    t.resolvers[0]!();
    await flush();
    const conv = (await t.repos.conversations.getByChannelId("dm-owner"))!;
    expect(conv.sessionId).toBe("s1");

    pub(t.bus, dmHint("owner", "owner"), "/기억정리", 2);
    await flush();
    expect(t.calls).toHaveLength(2); // 요약 턴이 떠 있다

    await t.repos.conversations.setSession(conv.id, "s2", t.now());
    t.resolvers[1]!();
    await t.core.drain();

    const after = (await t.repos.conversations.getByChannelId("dm-owner"))!;
    expect(after.sessionId).toBe("s2");
    expect(after.contextFloorTs).toBeNull();
    // 이미 쓰인 요약 행은 그대로 둔다 — 바닥선을 안 그었으니 범위 안에 남아 그대로 실린다.
    expect(await t.repos.summaries.recent(after.id, 3)).toHaveLength(1);
    const notices = t.published.filter((p) => p.type === "assistant_message").map((p) => (p as { text: string }).text);
    expect(notices.some((n) => /다시 시도해줘/.test(n))).toBe(true);
    expect(notices.some((n) => /정리했어/.test(n))).toBe(false);
  });

  it("손님의 /기억정리 는 시간당 한도에 포함되고, 소유자는 포함되지 않는다", async () => {
    // 이 명령은 실제 LLM 턴을 하나 돌린다 — 예약어라고 한도를 건너뛰면 손님이 연타로 무제한
    // 요약 턴을 돌릴 수 있다(조사 예약어에서 실제로 났던 결함과 같은 종류).
    const t = await setup({ config: { maxTurnsPerHourPerUser: 1 } });
    pub(t.bus, dmHint("guest", "allowed"), "안녕", 1); // 첫 턴이 손님 몫 1개를 소진한다
    await t.core.drain();
    const before = (await t.repos.conversations.getByChannelId("dm-guest"))!;
    expect(before.sessionId).toBe("s1");

    pub(t.bus, dmHint("guest", "allowed"), "/기억정리", 2);
    await t.core.drain();

    // 한도에 걸려 요약 턴이 아예 돌지 않고, 따라서 세션·바닥선도 그대로다.
    expect(t.calls).toHaveLength(1);
    const after = (await t.repos.conversations.getByChannelId("dm-guest"))!;
    expect(after.sessionId).toBe("s1");
    expect(after.contextFloorTs).toBeNull();

    // 같은 조건에서 소유자는 한도를 받지 않는다(runConversationTurn 과 같은 규칙).
    pub(t.bus, dmHint("owner", "owner"), "안녕", 3);
    await t.core.drain();
    pub(t.bus, dmHint("owner", "owner"), "/기억정리", 4);
    await t.core.drain();
    const ownerConv = (await t.repos.conversations.getByChannelId("dm-owner"))!;
    expect(ownerConv.sessionId).toBeNull();
    expect(await t.repos.summaries.recent(ownerConv.id, 3)).toHaveLength(1);
  });

  // Important 3(리뷰 후속) — 위 테스트는 dmHint 를 써서 대화 주인과 명령을 친 사람이 같은
  // 사람이다. 그래서 한도 판정 기준을 conv.primaryUserId 로 바꿔도 전부 통과했다(리뷰가 실제로
  // 뮤테이션으로 확인). 두 신원이 갈리는 자리는 스레드다: 어댑터는 이미 있는 스레드에 들어온
  // 손님에게도 그 스레드의 primaryUserId 를 그대로 실어 주므로(discord.ts 의
  // existingPrimaryUserId), 대화 주인으로 재면 손님이 소유자 스레드에서 한도 없이 요약 턴을
  // 연타할 수 있다. 아래 두 테스트가 그 축을 양방향으로 고정한다.
  it("소유자 스레드에 들어온 손님의 /기억정리 도 그 손님 한도로 잰다(대화 주인 기준이 아니다)", async () => {
    const t = await setup({ config: { maxTurnsPerHourPerUser: 1 } });
    pub(t.bus, threadHint("owner", "ch-1", "owner", "o1"), "안녕", 1); // 소유자는 예약 자체를 안 한다
    await t.core.drain();

    const guestInOwnerThread: ConversationHint = {
      kind: "thread", discordChannelId: "ch-1", originMessageId: "o1", guildId: "g", parentChannelId: "p",
      isPrivate: false, primaryUserId: "owner", userId: "guest", role: "allowed", discordMessageId: `msg-${seq++}`,
    };
    pub(t.bus, { ...guestInOwnerThread, discordMessageId: `msg-${seq++}` }, "나도 안녕", 2); // 손님 몫 1개 소진
    await t.core.drain();
    expect(t.calls).toHaveLength(2);

    pub(t.bus, guestInOwnerThread, "/기억정리", 3);
    await t.core.drain();

    // 한도에 걸려 요약 턴이 아예 돌지 않고, 세션·바닥선도 그대로다.
    expect(t.calls).toHaveLength(2);
    const after = (await t.repos.conversations.getByChannelId("ch-1"))!;
    expect(after.sessionId).toBe("s1");
    expect(after.contextFloorTs).toBeNull();
    const notices = t.published.filter((p) => p.type === "system_notice").map((p) => (p as { text: string }).text);
    expect(notices.some((n) => /구독 한도/.test(n))).toBe(true);
  });

  it("손님 스레드에서 소유자가 친 /기억정리 는 한도를 받지 않는다(전역 한도가 다 찼어도 돈다)", async () => {
    // 반대 방향 고정 — 기준을 conv.primaryUserId 로 바꾸면 이 대화의 주인이 손님이라 소유자가
    // 예약을 거쳐야 하고, 전역 한도가 이미 찼으므로 거부된다.
    const t = await setup({ config: { maxTurnsPerHourGlobal: 1 } });
    pub(t.bus, threadHint("guest", "ch-2", "allowed", "g1"), "안녕", 1); // 전역 1개를 손님이 소진
    await t.core.drain();
    expect(t.calls).toHaveLength(1);

    const ownerInGuestThread: ConversationHint = {
      kind: "thread", discordChannelId: "ch-2", originMessageId: "g1", guildId: "g", parentChannelId: "p",
      isPrivate: false, primaryUserId: "guest", userId: "owner", role: "owner", discordMessageId: `msg-${seq++}`,
    };
    pub(t.bus, ownerInGuestThread, "/기억정리", 2);
    await t.core.drain();

    expect(t.calls).toHaveLength(2); // 요약 턴이 돌았다
    const after = (await t.repos.conversations.getByChannelId("ch-2"))!;
    expect(after.sessionId).toBeNull();
    expect(await t.repos.summaries.recent(after.id, 3)).toHaveLength(1);
  });
});

// Task 5(배선) — 정기 게시 예약어(/대회·/개발뉴스)는 세션 예약어(/새세션)와 같은 자리(ingest)에서
// 갈라져 LLM 턴을 아예 거치지 않는다. setup() 은 DigestRunner 의 실제 구현을 인스턴스화하지 않고
// { run } 만 흉내 낸 가짜를 주입한다 — private 필드를 가진 실제 클래스 타입과 구조가 달라 setup
// 호출부에서 as any 로 넘긴다(대신 setup 내부 배선(over.digest → new AgentCore({ digest }))은
// 타입 그대로 유지한다). 이 파일의 다른 테스트와 같은 패턴(pub + core.drain)을 그대로 따른다 —
// send/notices/channelRef/runTurnCalls 라는 이름은 이 헬퍼엔 없으므로(calls/published/dmHint 로 대체).
describe("AgentCore — 정기 게시 예약어", () => {
  it("예약어를 받으면 LLM 턴을 돌리지 않고 DigestRunner 에 넘긴다", async () => {
    const calls: Array<{ topic: string; channelRef: string }> = [];
    const digest = { run: async (topic: string, channelRef: string) => { calls.push({ topic, channelRef }); return { started: true }; } };
    const t = await setup({ digest } as any);

    pub(t.bus, dmHint("owner", "owner"), "/대회", 1);
    await t.core.drain();

    expect(calls).toHaveLength(1);
    expect(calls[0].topic).toBe("contest");
    expect(t.calls).toHaveLength(0); // 모델을 부르지 않는다
  });

  it("예약어를 친 그 채널로 답한다", async () => {
    const calls: Array<{ topic: string; channelRef: string }> = [];
    const digest = { run: async (topic: string, channelRef: string) => { calls.push({ topic, channelRef }); return { started: true }; } };
    const t = await setup({ digest } as any);
    const hint = dmHint("owner", "owner");

    pub(t.bus, hint, "/개발뉴스", 1);
    await t.core.drain();

    expect(calls).toHaveLength(1);
    expect(calls[0].channelRef).toBe(hint.discordChannelId);
  });

  it("digest 가 주입되지 않았으면 안내만 하고 넘어간다", async () => {
    const t = await setup(); // digest 미배선
    pub(t.bus, dmHint("owner", "owner"), "/대회", 1);
    await t.core.drain();

    const notices = t.published.filter((e) => e.type === "system_notice");
    expect(notices.length).toBeGreaterThan(0);
    expect(t.calls).toHaveLength(0); // 모델도 부르지 않는다
  });
});

// 리뷰 발견 — 예약어(/대회·/개발뉴스) 분기는 runConversationTurn 을 거치지 않아 turns.reserve(손님
// 한도)를 타지 않았다. 손님이 예약어를 연타하면 이 앱에서 가장 비싼 턴(claude-opus·웹검색·
// maxTurns:30)이 구독 한도 없이 무제한·무제한 동시 실행될 수 있었다. 아래는 (a) 손님 한도 적용과
// (b) 동시 실행 방지, 두 수정 각각의 회귀 테스트다.
// (b) 의 실제 가드(주제별 running Set)는 이제 DigestRunner 내부에 있다(FIX1, 최종 리뷰 3차 —
// digestRunner.test.ts 가 실물로 검증). 여기서는 AgentCore 가 digest.run() 의 반환값
// ({ started: boolean })을 보고 "이미 조사 중" 안내를 내는지만, manualDigest 가짜로 확인한다.
describe("AgentCore — 정기 게시 예약어의 손님 한도·동시 실행 방지(리뷰 수정)", () => {
  it("손님이 시간당 한도를 넘으면 조사 예약어도 거부되고 DigestRunner 는 호출되지 않는다", async () => {
    const digestCalls: Array<{ topic: string; channelRef: string }> = [];
    const digest = { run: async (topic: string, channelRef: string) => { digestCalls.push({ topic, channelRef }); return { started: true }; } };
    const t = await setup({ config: { maxTurnsPerHourPerUser: 0 }, digest } as any);

    pub(t.bus, dmHint("guest", "allowed"), "/대회", 1);
    await t.core.drain();

    expect(digestCalls).toHaveLength(0); // 조사 자체가 시작되지 않는다
    // runConversationTurn 의 손님 한도 거부와 완전히 같은 안내 문구를 그대로 재사용한다.
    expect(t.published.find((e) => e.type === "system_notice")?.text).toContain("한도");
  });

  it("손님이 한도 이내면 조사 예약어가 정상 실행되고 DigestRunner 가 호출된다", async () => {
    const digestCalls: Array<{ topic: string; channelRef: string }> = [];
    const digest = { run: async (topic: string, channelRef: string) => { digestCalls.push({ topic, channelRef }); return { started: true }; } };
    const t = await setup({ digest } as any); // 기본 설정: 유저별 한도 20(충분히 여유)

    pub(t.bus, dmHint("guest", "allowed"), "/대회", 1);
    await t.core.drain();

    expect(digestCalls).toHaveLength(1);
    expect(digestCalls[0].topic).toBe("contest");
    expect(t.published.find((e) => e.type === "system_notice" && e.text.includes("한도"))).toBeUndefined();
  });

  it("소유자는 조사 예약어를 몇 번 실행해도 한도의 영향을 받지 않는다", async () => {
    const digestCalls: Array<{ topic: string; channelRef: string }> = [];
    const digest = { run: async (topic: string, channelRef: string) => { digestCalls.push({ topic, channelRef }); return { started: true }; } };
    // 유저별·전역 한도를 0(즉시 거부되는 값)으로 둬도 소유자는 애초에 예약을 타지 않아야 한다.
    const t = await setup({ config: { maxTurnsPerHourPerUser: 0, maxTurnsPerHourGlobal: 0 }, digest } as any);
    const hint = dmHint("owner", "owner");

    for (let i = 0; i < 4; i++) {
      pub(t.bus, hint, "/대회", i + 1);
      await t.core.drain();
      await flush(); // 동시 실행 가드가 다음 반복 전에 풀리도록 대기(가짜 digest 는 즉시 끝남)
    }

    expect(digestCalls).toHaveLength(4); // 한도 0 인데도 4번 모두 실행됨(무제한)
  });

  it("같은 채널에서 조사가 진행 중이면 두 번째 예약어는 새 실행을 시작하지 않고 안내한다", async () => {
    const { calls: digestCalls, pending, digest } = manualDigest();
    const t = await setup({ digest } as any);
    const hint = dmHint("owner", "owner"); // 소유자로 손님 한도 변수를 배제하고 동시성만 검증

    pub(t.bus, hint, "/대회", 1);
    await t.core.drain();
    expect(digestCalls).toHaveLength(1); // 첫 조사가 시작되어 아직 끝나지 않음

    pub(t.bus, hint, "/대회", 2);
    await t.core.drain();
    expect(digestCalls).toHaveLength(1); // 두 번째는 새로 시작되지 않는다
    const notice = t.published.find((e) => e.type === "system_notice");
    expect(notice).toBeDefined();
    expect(notice?.text).toContain("이미");

    pending[0].resolve(); // 정리(끝나지 않은 프라미스를 남기지 않는다)
    await flush();
  });

  it("첫 조사가 끝나면(거부돼도) 그 채널에서 다시 예약어를 실행할 수 있다", async () => {
    const { calls: digestCalls, pending, digest } = manualDigest();
    const t = await setup({ digest } as any);
    const hint = dmHint("owner", "owner");

    pub(t.bus, hint, "/대회", 1);
    await t.core.drain();
    expect(digestCalls).toHaveLength(1);

    pending[0].reject(new Error("조사 실패(테스트용)")); // digest.run 이 거부되는 경우(리뷰 지적: 가드 누수 위험)
    await flush();

    pub(t.bus, hint, "/대회", 2);
    await t.core.drain();
    expect(digestCalls).toHaveLength(2); // 실패로 끝나도 가드가 풀려 다음 실행이 시작된다

    pending[1].resolve(); // 정리
    await flush();
  });
});

// Task 6 — 예약어 안내(/help). 세션 예약어(/새세션)와 같은 자리(ingest)에서 갈라져 LLM 턴을
// 아예 거치지 않는다. 이 파일의 다른 예약어 테스트(478번째 줄 부근)와 같은 패턴(pub + core.drain)을
// 그대로 따른다 — setup() 에는 t.pub 필드가 없으므로 독립 함수 pub(bus, hint, text, ts) 를 쓴다.
describe("AgentCore — /help", () => {
  it("예약어 목록을 보내고 모델을 부르지 않는다", async () => {
    const t = await setup();
    pub(t.bus, dmHint("owner", "owner"), "/help", 1);
    await t.core.drain();

    expect(t.calls).toHaveLength(0); // 모델을 부르지 않는다
    const notice = t.published.find((e) => e.type === "assistant_message");
    expect(notice).toBeDefined();
    const text = (notice as { text: string }).text;
    expect(text).toContain("/새세션");
    expect(text).toContain("/대회");
  });

  // 최종 리뷰 Important 3 — commands.test.ts 는 renderCommandHelp 라는 순수 함수만 본다. 그 함수가
  // 아무리 정확해도 호출부가 실제 워커 상태를 넘기지 않으면 사용자에게는 아무것도 달라지지 않으므로
  // (이 브랜치의 Critical 1 이 정확히 그런 종류의 결함이었다), 배선 자체를 코어에서 확인한다.
  const helpTextOf = (t: { published: AgentEvent[] }): string =>
    (t.published.find((e) => e.type === "assistant_message") as { text: string }).text;

  it("워커가 연결돼 있으면 파일·명령 안내가 붙는다", async () => {
    const t = await setup({ hub: { isConnected: () => true } });
    pub(t.bus, dmHint("owner", "owner"), "/help", 1);
    await t.core.drain();
    expect(helpTextOf(t)).toContain("파일 만들어줘");
  });

  it("워커가 끊겨 있으면 그 안내를 빼고 지금은 안 된다고 알린다(미니PC 가 꺼져 있는 동안)", async () => {
    const t = await setup({ hub: { isConnected: () => false } });
    pub(t.bus, dmHint("owner", "owner"), "/help", 1);
    await t.core.drain();
    const text = helpTextOf(t);
    expect(text).not.toContain("파일 만들어줘");
    expect(text).toContain("지금은");
    expect(text).toContain("/새세션"); // 예약어 목록 자체는 그대로
  });

  it("워커 배선이 아예 없는 환경(hub 없음)도 미연결로 취급한다", async () => {
    const t = await setup(); // hub 를 넘기지 않음
    pub(t.bus, dmHint("owner", "owner"), "/help", 1);
    await t.core.drain();
    expect(helpTextOf(t)).not.toContain("파일 만들어줘");
  });

  it("레지스트리 조회가 터져도 /help 자체는 나간다(능력 안내만 보수적으로 빠진다)", async () => {
    const t = await setup({
      hub: { isConnected: () => true },
      registry: {
        personalWorkerOf: async () => { throw new Error("db down(테스트용)"); },
        sharedWorkerId: async () => { throw new Error("db down(테스트용)"); },
      },
    });
    pub(t.bus, dmHint("owner", "owner"), "/help", 1);
    await t.core.drain();
    const text = helpTextOf(t);
    expect(text).toContain("/새세션");
    expect(text).not.toContain("파일 만들어줘");
  });
});

describe("AgentCore — 이미지 입력", () => {
  const fakeFetch = (async () => ({ ok: true, arrayBuffer: async () => new TextEncoder().encode("img").buffer }) as Response) as unknown as typeof fetch;

  it("이미지 메시지는 마커로 저장되고, 다운로드된 이미지가 runTurn 에 전달된다", async () => {
    const t = await setup({ imageFetch: fakeFetch });
    const hint = dmHint("owner", "owner");
    t.bus.publish({ type: "user_message", channel: "discord", channelRef: hint.discordChannelId, text: "이게 뭐야", ts: 1, hint,
      images: [{ url: "u", mediaType: "image/png", name: "a.png", size: 3 }] });
    await t.core.drain();
    // runTurn 에 이미지 전달
    expect(t.calls[0].images).toHaveLength(1);
    // 바로 위에서 길이 1을 단정했으므로 non-null 로 좁힌다(images 는 선택 필드다).
    expect(t.calls[0].images![0]!.base64).toBe(Buffer.from("img").toString("base64"));
    // 저장은 마커
    const conv = await t.repos.conversations.getByChannelId("dm-owner");
    const recent = await t.repos.messages.recent(conv!.id, 5);
    expect(recent.some((m) => m.role === "user" && m.content.includes("[이미지 1장: a.png]"))).toBe(true);
  });

  it("이미지 다운로드가 전부 실패하면 system_notice 로 안내하되, 턴은 텍스트만으로 계속 진행된다", async () => {
    const failFetch = (async () => ({ ok: false }) as Response) as unknown as typeof fetch;
    const t = await setup({ imageFetch: failFetch });
    const hint = dmHint("owner", "owner");
    t.bus.publish({ type: "user_message", channel: "discord", channelRef: hint.discordChannelId, text: "이게 뭐야", ts: 1, hint,
      images: [{ url: "u", mediaType: "image/png", name: "a.png", size: 3 }] });
    await t.core.drain();
    // 턴은 여전히 실행됨(텍스트만으로라도 답함)
    expect(t.calls).toHaveLength(1);
    expect(t.calls[0].images).toHaveLength(0); // 다운로드 실패로 이미지 없이 전달
    // 사용자에게 실패를 안내
    const notice = t.published.find((e) => e.type === "system_notice" && e.text.includes("불러오지"));
    expect(notice).toBeDefined();
    expect(notice?.channelRef).toBe("dm-owner");
  });
});

// Task 3(배선) — 어댑터가 분류한 첨부 파일(Task 1 의 filterFileAttachments)이 실제로 워커에
// 저장되고, 그 저장 경로가 이번 턴 prompt 에 실리는지를 확인한다. uploadDirFor·buildFileMarker
// 자체의 순수 로직은 attachments.test.ts 가 이미 고정했으므로, 여기서는 core 가 그 함수들과
// hub.call 을 실제로 올바르게 엮는지만 본다.
describe("AgentCore — 첨부 파일을 워커에 저장한다(Task 3)", () => {
  const fileRef = { url: "https://cdn.discordapp.com/a.pdf", name: "a.pdf", size: 100 };

  it("워커가 연결돼 있지 않으면 hub.call 을 부르지 않고, 실패 안내가 프롬프트에 붙은 채 턴은 정상 진행된다", async () => {
    const hubCalls: Array<{ tool: string; args: Record<string, unknown> }> = [];
    const fakeHub = {
      isConnected: () => false, // 이 턴에는 워커가 연결돼 있지 않다
      rootsOf: () => ["C:\\ws"],
      call: async (_w: string, tool: string, args: Record<string, unknown>) => {
        hubCalls.push({ tool, args });
        return { ok: true, content: "불려선 안 됨" };
      },
    };
    const t = await setup({ hub: fakeHub });
    const hint = dmHint("owner", "owner");
    t.bus.publish({ type: "user_message", channel: "discord", channelRef: hint.discordChannelId, text: "이 파일 봐줘", ts: 1, hint, files: [fileRef] });
    await t.core.drain();

    expect(hubCalls).toHaveLength(0); // 워커가 없다고 판정되면 file_fetch 시도 자체를 안 한다
    expect(t.calls).toHaveLength(1); // 턴 자체는 막히지 않는다
    expect(t.calls[0].prompt).toContain("a.pdf");
    expect(t.calls[0].prompt).toContain("워커가 연결돼 있지 않아 저장 못 함");
    expect(t.published.some((e) => e.type === "assistant_message")).toBe(true);
  });

  // 브리프에 없던 지적(Task 4 문서화 검토) — 위 테스트("워커가 연결돼 있지 않으면...")와 이 두
  // 테스트는 겉으로 같은 "실패 안내"처럼 보이지만 원인이 다르다. worker===null|hub===undefined
  // 는 워커 자체가 없는 것이고, 아래는 워커는 붙어 있는데 uploadDirFor 가 저장할 폴더를 못 찾은
  // 것(허용 폴더 미등록)이다. 예전엔 두 경우가 같은 "워커가 연결돼 있지 않아 저장 못 함" 문구로
  // 뭉뚱그려져, 후자를 겪은 사람이 워커 연결을 확인하러 가서 헛수고했다 — 이 테스트가 그 구분을
  // 고정한다.
  it("워커는 연결돼 있지만 저장 폴더를 못 찾으면(소유자, 워커가 작업 폴더를 하나도 보고하지 않음) 연결 문제와 다른 문구를 낸다", async () => {
    const hubCalls: Array<{ tool: string; args: Record<string, unknown> }> = [];
    const fakeHub = {
      isConnected: () => true,
      rootsOf: () => [], // 워커가 hello 로 알려온 작업 폴더가 하나도 없다 — uploadDirFor 가 null 을 돌려주는 조건
      call: async (_w: string, tool: string, args: Record<string, unknown>) => {
        hubCalls.push({ tool, args });
        return { ok: true, content: "불려선 안 됨" };
      },
    };
    const t = await setup({ hub: fakeHub });
    const hint = dmHint("owner", "owner");
    t.bus.publish({ type: "user_message", channel: "discord", channelRef: hint.discordChannelId, text: "이 파일 봐줘", ts: 1, hint, files: [fileRef] });
    await t.core.drain();

    expect(hubCalls).toHaveLength(0); // 저장할 폴더를 못 찾으면 file_fetch 시도 자체를 안 한다
    expect(t.calls).toHaveLength(1); // 턴 자체는 막히지 않는다
    expect(t.calls[0].prompt).toContain("허용된 저장 폴더가 없어 저장 못 함");
    // 연결 문제로 오인시키지 않는다 — 워커는 실제로 연결돼 있다(isConnected: () => true).
    expect(t.calls[0].prompt).not.toContain("워커가 연결돼 있지 않아");
  });

  it("손님도 워커는 연결돼 있지만 허용 폴더가 하나도 없으면(allowed_dirs 미등록) 같은 문구를 받는다", async () => {
    const sharedHub = {
      isConnected: () => true,
      rootsOf: () => [], // 워커도 작업 폴더를 보고하지 않아, 손님의 빈 workspaceDirs 가 폴백할 곳도 없다
      call: async () => ({ ok: true, content: "불려선 안 됨" }),
    };
    // allowedDirs.add 를 호출하지 않는다 — 그 공유 워커의 allowed_dirs 가 비어 있으면
    // scopeDirs 가 이 손님의 workspaceDirs 도 빈 배열로 돌려준다(브리프가 설명하는 손님 쪽 경로).
    const t = await setup({ hub: sharedHub });
    const hint = dmHint("guest", "allowed");
    t.bus.publish({ type: "user_message", channel: "discord", channelRef: hint.discordChannelId, text: "이 파일 봐줘", ts: 1, hint, files: [fileRef] });
    await t.core.drain();

    expect(t.calls[0].prompt).toContain("허용된 저장 폴더가 없어 저장 못 함");
    expect(t.calls[0].prompt).not.toContain("워커가 연결돼 있지 않아");
  });

  // 최종 리뷰 Critical(폴더 격리 우회 회귀 방지) — 바로 위 테스트는 rootsOf: () => [] 를 써서
  // "워커 루트도 비어 있다"는 조건과 함께만 손님의 빈 workspaceDirs 를 관찰한다. 그런데 연결된
  // 워커는 hello 프레임으로 항상 roots 를 보고하므로(hub.ts 의 rootsOf), 실제 운영에서
  // workerRoots 가 비는 일은 거의 없다 — workerRoots 가 채워진 채로 손님의 workspaceDirs 만
  // 비는(allow_dir 미등록) 이 시나리오에서만 "손님 파일이 워커 루트(다른 부원 폴더들과 나란한
  // 공유 루트)에 떨어지는" 결함이 드러난다(uploadDirFor 가 isOwner 없이 workspaceDirs?.[0] ??
  // workerRoots[0] 로 폴백하던 시절의 결함 — attachments.test.ts 가 순수 로직을, 이 테스트가
  // core 배선을 각각 고정한다). hub.call 이 전혀 불리지 않는 것까지 함께 단정해야 "실패
  // 안내가 나가지만 사실은 워커 루트에 저장됐다"를 놓치지 않는다.
  it("손님은 워커 루트가 채워져 있어도(allowed_dirs 미등록) 그 루트로 저장하지 않고 실패 안내를 받는다(Critical 회귀 방지)", async () => {
    const hubCalls: Array<{ tool: string; args: Record<string, unknown> }> = [];
    const sharedHub = {
      isConnected: () => true,
      rootsOf: () => ["C:\\ws"], // 연결된 워커는 항상 roots 를 보고한다 — 실제 운영과 같은 모양
      call: async (_w: string, tool: string, args: Record<string, unknown>) => {
        hubCalls.push({ tool, args });
        return { ok: true, content: "불려선 안 됨" };
      },
    };
    // allowedDirs.add 를 호출하지 않는다 — 이 손님은 allow_dir 이 미등록이다.
    const t = await setup({ hub: sharedHub });
    const hint = dmHint("guest", "allowed");
    t.bus.publish({ type: "user_message", channel: "discord", channelRef: hint.discordChannelId, text: "이 파일 봐줘", ts: 1, hint, files: [fileRef] });
    await t.core.drain();

    expect(hubCalls).toHaveLength(0); // 워커 루트로 file_fetch 를 시도해선 안 된다
    expect(t.calls[0].prompt).toContain("허용된 저장 폴더가 없어 저장 못 함");
    expect(t.calls[0].prompt).not.toContain("워커가 연결돼 있지 않아");
  });

  it("워커가 연결돼 있으면 hub.call 이 file_fetch 로 {url,dir,name} 호출되고, 성공한 저장 경로가 runTurn 의 prompt 에 담긴다", async () => {
    const hubCalls: Array<{ tool: string; args: Record<string, unknown> }> = [];
    const fakeHub = {
      isConnected: () => true,
      rootsOf: () => ["C:\\ws"],
      call: async (_w: string, tool: string, args: Record<string, unknown>) => {
        hubCalls.push({ tool, args });
        return { ok: true, content: "C:\\ws\\111\\a.pdf" };
      },
    };
    const t = await setup({ hub: fakeHub });
    const hint = dmHint("owner", "owner");
    t.bus.publish({ type: "user_message", channel: "discord", channelRef: hint.discordChannelId, text: "이 파일 봐줘", ts: 1, hint, files: [fileRef] });
    await t.core.drain();

    expect(hubCalls).toHaveLength(1);
    expect(hubCalls[0].tool).toBe("file_fetch");
    expect(hubCalls[0].args).toEqual({ url: fileRef.url, dir: "C:\\ws", name: "a.pdf" });
    // 핵심 단정(브리프 Step 5) — 워커가 돌려준 실제 저장 경로가 모델이 받는 prompt 에 있어야
    // 한다. 없으면 모델은 fs_read 로 그 파일을 열 방법을 모른다.
    expect(t.calls[0].prompt).toContain("C:\\ws\\111\\a.pdf");
  });

  it("이미지와 파일을 함께 올려도 본문이 사라지지 않는다 — 파일 경로는 prompt 에, 이미지 마커만 DB 에 남는다(Step 4b)", async () => {
    const fakeHub = {
      isConnected: () => true,
      rootsOf: () => ["C:\\ws"],
      call: async () => ({ ok: true, content: "C:\\ws\\111\\a.pdf" }),
    };
    const fakeFetch = (async () => ({ ok: true, arrayBuffer: async () => new TextEncoder().encode("img").buffer }) as Response) as unknown as typeof fetch;
    const t = await setup({ hub: fakeHub, imageFetch: fakeFetch });
    const hint = dmHint("owner", "owner");
    t.bus.publish({
      type: "user_message", channel: "discord", channelRef: hint.discordChannelId, text: "이 파일이랑 사진 봐줘", ts: 1, hint,
      images: [{ url: "u", mediaType: "image/png", name: "b.png", size: 3 }],
      files: [fileRef],
    });
    await t.core.drain();

    // 본문이 마커에 덮이지 않고 그대로 남는다.
    expect(t.calls[0].prompt).toContain("이 파일이랑 사진 봐줘");
    expect(t.calls[0].prompt).toContain("C:\\ws\\111\\a.pdf");

    // DB 기록(ingest)에는 이미지 마커만 붙는다 — 파일 저장 경로는 받아오기 전에 기록되므로
    // core.ts:283 자리에는 관여하지 않는다(브리프 Step 4 의 "DB 기록은 건드리지 않는다" 확인).
    const conv = await t.repos.conversations.getByChannelId("dm-owner");
    const recent = await t.repos.messages.recent(conv!.id, 5);
    const userMsg = recent.find((m) => m.role === "user");
    expect(userMsg?.content).toContain("[이미지 1장: b.png]");
    expect(userMsg?.content).not.toContain("C:\\ws\\111\\a.pdf");
  });

  // 브리프에 없던 발견(Task 3 자체 리뷰) — runConversationTurn 의 resume 실패 재시도 경로는
  // prompt 변수를 재사용하지 않고 buildContextBlock 으로 retryPrompt 를 처음부터 새로 조립한다.
  // 브리프의 Step 4 코드는 첫 시도의 prompt 에만 마커를 입혔으므로, 그대로만 옮기면 resume 실패
  // (클라우드 재배포 등, 바로 위 describe 블록들이 이미 다루는 실제 경로)와 파일 첨부가 겹칠 때
  // 재시도 쪽에서만 마커가 조용히 사라진다 — 이 테스트가 그 회귀를 고정한다.
  it("resume 세션을 못 찾아 재시도할 때도 저장된 파일 경로가 재시도 prompt 에 남는다(세션 재시도 경로 회귀 방지)", async () => {
    const hubCalls: Array<{ tool: string; args: Record<string, unknown> }> = [];
    const fakeHub = {
      isConnected: () => true,
      rootsOf: () => ["C:\\ws"],
      call: async (_w: string, tool: string, args: Record<string, unknown>) => {
        hubCalls.push({ tool, args });
        return { ok: true, content: "C:\\ws\\111\\a.pdf" };
      },
    };
    const t = await setup({ mode: "resume-fails", hub: fakeHub });
    const hint = dmHint("owner", "owner");
    // 첫 메시지로 세션(s1)을 먼저 확보한다(resume-fails 모드는 resume 없는 호출만 성공한다).
    t.bus.publish({ type: "user_message", channel: "discord", channelRef: hint.discordChannelId, text: "안녕", ts: t.now(), hint });
    await t.core.drain();
    expect(t.calls).toHaveLength(1);

    // 두 번째 메시지: resume 시도 → "세션 없음" 실패 → 새 세션으로 재시도. 이번엔 파일을 함께 올린다.
    t.bus.publish({ type: "user_message", channel: "discord", channelRef: hint.discordChannelId, text: "이 파일도 봐줘", ts: t.now(), hint, files: [fileRef] });
    await t.core.drain();

    expect(t.calls).toHaveLength(3);
    expect(t.calls[1].resume).toBe("s1"); // 실패한 resume 시도
    expect(t.calls[2].resume).toBeUndefined(); // 새 세션 재시도
    expect(hubCalls).toHaveLength(1); // 파일은 한 번만 받아온다(재시도가 다시 받아오지 않는다)
    expect(t.calls[2].prompt).toContain("C:\\ws\\111\\a.pdf");
  });
});

// 최종 리뷰 Important — 거절된 첨부가 조용히 사라지던 결함의 회귀 방지. discord.ts 가
// filterFileAttachments 의 skipped 를 뽑아 UserMessageEvent.rejectedFiles 로 실어 보내면(discord.ts
// 자체는 실제 discord.js Client 가 필요해 여기서 재현하지 않는다 — attachments.test.ts 가
// filterFileAttachments 자체(거절 사유 문자열 생성)를, 이 테스트가 core 쪽 배선(rejectedFiles →
// failedFiles → buildFileMarker → prompt)을 각각 고정한다), core 가 그 사유를 failedFiles 의
// 초기값으로 얹어 buildFileMarker 를 거쳐 prompt 에 실어야 한다 — 안 그러면 12MB PDF 를 올리고
// "요약해줘"라고 물었을 때 봇이 본문만 보고 답하면서도 부원은 봇이 읽었다고 믿게 된다.
describe("AgentCore — 거절된 첨부(rejectedFiles)를 프롬프트에 실패로 알린다(Important, 최종 리뷰)", () => {
  it("8MB 초과로 거절된 첨부의 파일명과 사유가 실패 마커로 prompt 에 나타난다", async () => {
    // 실제 filterFileAttachments 를 그대로 통과시켜 discord.ts 가 만들 값과 같은 문자열을 쓴다
    // — 여기서 비슷한 문자열을 손으로 지어내면 실제 문구 형식이 바뀌어도 이 테스트가 못 잡는다.
    const { files, skipped } = filterFileAttachments([
      { url: "https://cdn.discordapp.com/attachments/1/2/big.pdf", contentType: "application/pdf", name: "big.pdf", size: FILE_LIMITS.maxBytes + 1 },
    ]);
    expect(files).toHaveLength(0); // 사전조건: 거절됐다(받아들여지지 않았다)
    expect(skipped).toHaveLength(1); // 사전조건: filterFileAttachments 가 사유를 만들었다

    const t = await setup();
    const hint = dmHint("owner", "owner");
    t.bus.publish({
      type: "user_message", channel: "discord", channelRef: hint.discordChannelId, text: "이거 요약해줘", ts: 1, hint,
      rejectedFiles: skipped,
    });
    await t.core.drain();

    expect(t.calls).toHaveLength(1); // 첨부가 없어도(거절됐으므로 files 는 비어 있다) 턴은 정상 진행된다
    expect(t.calls[0].prompt).toContain("big.pdf");
    expect(t.calls[0].prompt).toContain("너무 큼");
    expect(t.calls[0].prompt).toContain("이거 요약해줘"); // 본문도 마커에 덮이지 않고 함께 실린다
  });

  it("거절된 첨부가 없으면(rejectedFiles 미제공) 실패 마커를 붙이지 않는다", async () => {
    const t = await setup();
    pub(t.bus, dmHint("owner", "owner"), "안녕", 1);
    await t.core.drain();
    expect(t.calls[0].prompt).not.toContain("파일 처리 실패");
  });
});

// 일반 채널의 예약어(어댑터의 channel-command → commandOnly 힌트).
//
// 가장 중요한 불변식: 이 경로는 conversations 행을 만들지 않는다. 만들면 decideRoute 의
// hasConversation 이 참이 되어 그 채널의 모든 메시지가 thread-existing 으로 라우팅되고,
// 봇이 그 채널에서 오가는 잡담 전부에 답하기 시작한다.
function channelCommandHint(userId: string, channelId: string, role: "owner" | "allowed"): ConversationHint {
  return {
    kind: "thread", discordChannelId: channelId, guildId: "g", isPrivate: false,
    primaryUserId: userId, userId, role, discordMessageId: `msg-${seq++}`, commandOnly: true,
  };
}

describe("AgentCore — 일반 채널의 예약어(commandOnly)", () => {
  it("조사 예약어를 처리하면서도 그 채널을 대화로 만들지 않는다", async () => {
    const digestCalls: Array<{ topic: string; channelRef: string }> = [];
    const digest = { run: async (topic: string, channelRef: string) => { digestCalls.push({ topic, channelRef }); return { started: true }; } };
    const t = await setup({ digest } as any);

    pub(t.bus, channelCommandHint("owner", "chan-일반", "owner"), "/대회", 1);
    await t.core.drain();

    expect(digestCalls).toHaveLength(1);
    // 대화 행이 생기지 않아야 한다 — 생기면 이후 그 채널의 모든 메시지에 봇이 답하게 된다.
    expect(await t.repos.conversations.getByChannelId("chan-일반")).toBeNull();
    expect(t.calls).toHaveLength(0); // LLM 대화 턴도 돌지 않는다
  });

  it("/help 도 대화를 만들지 않고 그 자리에서 답한다", async () => {
    const t = await setup();

    pub(t.bus, channelCommandHint("guest", "chan-일반", "allowed"), "/help", 1);
    await t.core.drain();

    expect(t.published.find((e) => e.type === "assistant_message")?.text).toContain("/대회");
    expect(await t.repos.conversations.getByChannelId("chan-일반")).toBeNull();
    expect(t.calls).toHaveLength(0);
  });

  // 최종 리뷰 Important 3 — 이 경로(commandOnly)는 위의 대화 안 /help 와 다른 호출부다. 한쪽만
  // 고치면 일반 채널에서 친 /help 는 예전 그대로 어긋난 안내를 낸다.
  it("/help 의 능력 안내는 이 경로에서도 워커 연결 여부로 갈린다", async () => {
    const on = await setup({ hub: { isConnected: () => true } });
    pub(on.bus, channelCommandHint("guest", "chan-일반", "allowed"), "/help", 1);
    await on.core.drain();
    expect(on.published.find((e) => e.type === "assistant_message")?.text).toContain("파일 만들어줘");

    const off = await setup({ hub: { isConnected: () => false } });
    pub(off.bus, channelCommandHint("guest", "chan-일반", "allowed"), "/help", 1);
    await off.core.drain();
    const text = off.published.find((e) => e.type === "assistant_message")?.text;
    expect(text).not.toContain("파일 만들어줘");
    expect(text).toContain("지금은");
  });

  it("손님 한도는 이 경로에도 그대로 적용된다", async () => {
    const digestCalls: Array<{ topic: string; channelRef: string }> = [];
    const digest = { run: async (topic: string, channelRef: string) => { digestCalls.push({ topic, channelRef }); return { started: true }; } };
    const t = await setup({ config: { maxTurnsPerHourPerUser: 0 }, digest } as any);

    pub(t.bus, channelCommandHint("guest", "chan-일반", "allowed"), "/대회", 1);
    await t.core.drain();

    expect(digestCalls).toHaveLength(0);
    expect(t.published.find((e) => e.type === "system_notice")?.text).toContain("한도");
    // 거부 안내도 대화를 만들지 않는다(notify 대신 알림만).
    expect(await t.repos.conversations.getByChannelId("chan-일반")).toBeNull();
  });

  // FIX1(치명, 머지 전 리뷰) — 방어적 회귀 테스트. 정상 경로에서는 decideRoute(어댑터)가
  // "constructor" 같은 Object.prototype 상속 키를 애초에 channel-command 로 판정하지 않아
  // commandOnly 힌트 자체가 만들어지지 않는다(discordRouting.test.ts 의 FIX1 테스트가 그
  // 관문을 확인한다). 이 테스트는 그 관문을 우회해 hint.commandOnly 가 어떻게든 true 로 들어온
  // 가상의 상황을 가정해, ingest 내부의 parseDigestCommand 호출 자체도 안전한지(2차 방어선)
  // 확인한다 — 고쳐지기 전에는 여기서 DIGEST_TOPICS[Object 생성자].prompt 접근으로 예외가 나
  // 손님 턴을 하나 태우고("조사 실패" 안내가 나감) 있었다.
  it("commandOnly 힌트로 'constructor' 가 들어와도(관문 우회 가정) 조사를 시작하지 않고 조용히 끝낸다", async () => {
    const digestCalls: Array<{ topic: string; channelRef: string }> = [];
    const digest = { run: async (topic: string, channelRef: string) => { digestCalls.push({ topic, channelRef }); return { started: true }; } };
    const t = await setup({ digest } as any);

    pub(t.bus, channelCommandHint("guest", "chan-일반", "allowed"), "constructor", 1);
    await t.core.drain();

    expect(digestCalls).toHaveLength(0); // 조사가 시작되지 않았다
    expect(t.published).toHaveLength(0); // 잘못된 실패 안내도 나가지 않았다
    expect(await t.repos.conversations.getByChannelId("chan-일반")).toBeNull();
  });
});

// 조사 결과의 목적지. 스레드에서 예약어를 부르면 결과가 그 스레드에 갇혀 채널 밖에서는
// 보이지 않았다 — 결과는 항상 그 주제의 지정 채널로 보내고, 명령을 친 곳에는 어디에 올릴지만 알린다.
describe("AgentCore — 조사 결과는 주제의 지정 채널로 간다", () => {
  it("스레드에서 불러도 결과는 지정 채널로 가고, 친 곳에는 안내만 남는다", async () => {
    const digestCalls: Array<{ topic: string; channelRef: string }> = [];
    const digest = { run: async (topic: string, channelRef: string) => { digestCalls.push({ topic, channelRef }); return { started: true }; } };
    const t = await setup({ config: { digestChannels: { contest: "news-대회" } }, digest } as any);

    pub(t.bus, threadHint("owner", "thread-1", "owner", "o1"), "/대회", 1);
    await t.core.drain();

    expect(digestCalls[0].channelRef).toBe("news-대회"); // 스레드가 아니라 지정 채널
    // FIX6(사소, 머지 전 리뷰): 이 안내는 오류·거부가 아니라 정상 진행 상황이라 assistant_message 로
    // 나간다(system_notice 였다면 어댑터가 전부 ⚠️ 를 붙여 경고처럼 보였다).
    const notice = t.published.find((e) => e.type === "assistant_message");
    expect(notice?.channelRef).toBe("thread-1");        // 안내는 명령을 친 곳에
    expect(notice?.text).toContain("news-대회");         // 어디에 올리는지 링크로 알린다
  });

  it("일반 채널에서 불러도 마찬가지다", async () => {
    const digestCalls: Array<{ topic: string; channelRef: string }> = [];
    const digest = { run: async (topic: string, channelRef: string) => { digestCalls.push({ topic, channelRef }); return { started: true }; } };
    const t = await setup({ config: { digestChannels: { devnews: "news-개발" } }, digest } as any);

    pub(t.bus, channelCommandHint("owner", "chan-일반", "owner"), "/개발뉴스", 1);
    await t.core.drain();

    expect(digestCalls[0].channelRef).toBe("news-개발");
    // FIX6: 정상 안내이므로 assistant_message(⚠️ 없음) — 위 테스트의 주석 참고.
    expect(t.published.find((e) => e.type === "assistant_message")?.channelRef).toBe("chan-일반");
  });

  it("지정 채널 안에서 부르면 안내 없이 그 자리에 바로 올린다", async () => {
    const digestCalls: Array<{ topic: string; channelRef: string }> = [];
    const digest = { run: async (topic: string, channelRef: string) => { digestCalls.push({ topic, channelRef }); return { started: true }; } };
    const t = await setup({ config: { digestChannels: { contest: "news-대회" } }, digest } as any);

    pub(t.bus, channelCommandHint("owner", "news-대회", "owner"), "/대회", 1);
    await t.core.drain();

    expect(digestCalls[0].channelRef).toBe("news-대회");
    expect(t.published.filter((e) => e.type === "system_notice")).toHaveLength(0); // 같은 곳이라 안내 불필요
  });

  it("지정 채널이 없으면 명령을 친 곳으로 폴백한다(설정 전 동작 유지)", async () => {
    const digestCalls: Array<{ topic: string; channelRef: string }> = [];
    const digest = { run: async (topic: string, channelRef: string) => { digestCalls.push({ topic, channelRef }); return { started: true }; } };
    const t = await setup({ digest } as any); // digestChannels: {}

    pub(t.bus, dmHint("owner", "owner"), "/대회", 1);
    await t.core.drain();

    expect(digestCalls[0].channelRef).toBe("dm-owner");
    expect(t.published.filter((e) => e.type === "system_notice")).toHaveLength(0);
  });

  it("이미 조사 중이라는 안내는 결과 채널이 아니라 명령을 친 곳으로 간다", async () => {
    const digest = { run: async () => ({ started: false }) };
    const t = await setup({ config: { digestChannels: { contest: "news-대회" } }, digest } as any);

    pub(t.bus, channelCommandHint("owner", "chan-일반", "owner"), "/대회", 1);
    await t.core.drain();
    await flush();

    const busy = t.published.find((e) => e.type === "system_notice" && e.text.includes("이미 조사 중"));
    expect(busy?.channelRef).toBe("chan-일반");
  });
});

describe("AgentCore — DM 의 조사 예약어는 DM 에 답한다", () => {
  it("지정 채널이 있어도 DM 에서 부른 결과는 DM 으로 온다", async () => {
    const digestCalls: Array<{ topic: string; channelRef: string }> = [];
    const digest = { run: async (topic: string, channelRef: string) => { digestCalls.push({ topic, channelRef }); return { started: true }; } };
    const t = await setup({ config: { digestChannels: { contest: "news-대회" } }, digest } as any);

    pub(t.bus, dmHint("owner", "owner"), "/대회", 1);
    await t.core.drain();

    // 혼자 확인해 보려던 것이 매번 동아리 채널에 게시되면 안 된다.
    expect(digestCalls[0].channelRef).toBe("dm-owner");
    expect(t.published.filter((e) => e.type === "system_notice")).toHaveLength(0);
  });
});

describe("AgentCore — 도구 호출을 actions 에 기록한다", () => {
  it("도구 호출 1건이 1행이 되고 대화·사용자가 함께 남는다", async () => {
    const t = await setup({ hub: { isConnected: () => true } });
    pub(t.bus, dmHint("owner", "owner"), "파일 읽어줘", 1);
    await t.core.drain();
    // setup 의 runTurn 가짜는 onProgress 로 answering 만 보낸다 — 도구 이벤트를 직접 흘려보낸다.
    t.calls[0].onProgress?.({ kind: "tool", name: "fs_read", input: "a.txt" });
    t.calls[0].onProgress?.({ kind: "tool_result", name: "fs_read", input: "a.txt", ok: true, summary: "본문", durationMs: 12 });
    await t.core.drain();

    const rows = await t.repos.actions.recent(10);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ tool: "fs_read", status: "ok", durationMs: 12, userId: "owner" });
  });

  it("answering·tool 이벤트는 기록하지 않는다(도구 호출 1건 = 1행)", async () => {
    const t = await setup({ hub: { isConnected: () => true } });
    pub(t.bus, dmHint("owner", "owner"), "안녕", 1);
    await t.core.drain();
    t.calls[0].onProgress?.({ kind: "tool", name: "fs_read", input: "a.txt" });
    t.calls[0].onProgress?.({ kind: "answering" });
    await t.core.drain();
    expect(await t.repos.actions.recent(10)).toHaveLength(0);
  });

  it("기록이 실패해도 턴을 죽이지 않는다", async () => {
    const t = await setup({ hub: { isConnected: () => true } });
    t.repos.actions.record = async () => { throw new Error("DB 오류(테스트용)"); };
    pub(t.bus, dmHint("owner", "owner"), "파일 읽어줘", 1);
    await t.core.drain();
    t.calls[0].onProgress?.({ kind: "tool_result", name: "fs_read", ok: false, durationMs: 1 });
    await t.core.drain();
    expect(t.published.some((e) => e.type === "assistant_message")).toBe(true);
  });
});
