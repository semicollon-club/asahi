import { describe, it, expect } from "vitest";
import { EventBus, type AgentEvent, type ConversationHint } from "../src/events/bus.js";
import { openTestDb } from "../src/store/db.js";
import { UsersRepo } from "../src/store/usersRepo.js";
import { ConversationsRepo } from "../src/store/conversationsRepo.js";
import { ParticipantsRepo } from "../src/store/participantsRepo.js";
import { MessagesRepo } from "../src/store/messagesRepo.js";
import { SummariesRepo } from "../src/store/summariesRepo.js";
import { MemoriesRepo } from "../src/store/memoriesRepo.js";
import { TurnsRepo } from "../src/store/turnsRepo.js";
import { AgentCore } from "../src/core/core.js";
import type { Config } from "../src/config.js";
import type { TurnRequest, TurnResult } from "../src/core/agent.js";
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
  imageFetch?: typeof fetch; hub?: { isConnected(userId: string): boolean }; digest?: DigestRunner;
} = {}) {
  const db = await openTestDb();
  const repos = {
    users: new UsersRepo(db), conversations: new ConversationsRepo(db), participants: new ParticipantsRepo(db),
    messages: new MessagesRepo(db), summaries: new SummariesRepo(db), memories: new MemoriesRepo(db), turns: new TurnsRepo(db),
  };
  await repos.users.upsert("owner", { role: "owner" });
  await repos.users.upsert("guest", { role: "allowed" });
  await repos.users.upsert("guest2", { role: "allowed" });
  const config: Config = {
    discordToken: "t", ownerId: "owner", databaseUrl: "postgres://test", dataDir: ":memory:", memoryDir: "x",
    sessionIdleMinutes: 30, maxTurnsPerHour: 30, maxTurnsPerHourPerUser: 20, maxTurnsPerHourGlobal: 40, ownerReserve: 10,
    deployTarget: "local",
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
  const core = new AgentCore({
    bus, config, runTurn, now: () => clock, repos, agentCwd: "/data/agent",
    fetchImpl: over.imageFetch, hub: over.hub, digest: over.digest,
  });
  core.start();
  const published: AgentEvent[] = [];
  bus.subscribe("assistant_message", (e) => published.push(e));
  bus.subscribe("system_notice", (e) => published.push(e));
  bus.subscribe("progress", (e) => published.push(e));
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

  it("워커가 연결돼 있어도 손님 DM 안내는 영향받지 않는다(손님은 원래도 PC 도구 언급이 없다)", async () => {
    const t = await setup({ hub: { isConnected: () => true } });
    pub(t.bus, dmHint("guest", "allowed"), "안녕", 1);
    await t.core.drain();
    expect(t.calls[0].systemPrompt).not.toMatch(/fs_read/);
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

describe("AgentCore — DM 세션 예약어(/새세션)", () => {
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
    expect(notices.some((n) => /새 세션|세션.*시작|새로/.test((n as { text: string }).text))).toBe(true);
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
    expect(t.calls[0].images[0].base64).toBe(Buffer.from("img").toString("base64"));
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
