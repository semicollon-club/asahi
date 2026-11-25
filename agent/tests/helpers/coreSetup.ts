import { EventBus, type AgentEvent, type ConversationHint } from "../../src/events/bus.js";
import { openTestDb } from "../../src/store/db.js";
import { UsersRepo } from "../../src/store/usersRepo.js";
import { ConversationsRepo } from "../../src/store/conversationsRepo.js";
import { ParticipantsRepo } from "../../src/store/participantsRepo.js";
import { MessagesRepo } from "../../src/store/messagesRepo.js";
import { SummariesRepo } from "../../src/store/summariesRepo.js";
import { MemoriesRepo } from "../../src/store/memoriesRepo.js";
import { TurnsRepo } from "../../src/store/turnsRepo.js";
import { AllowedDirsRepo } from "../../src/store/allowedDirsRepo.js";
import { ProjectsRepo } from "../../src/store/projectsRepo.js";
import { ActionsRepo } from "../../src/store/actionsRepo.js";
import { LlmUsageRepo } from "../../src/store/llmUsageRepo.js";
import { AgentCore } from "../../src/core/core.js";
import type { Config } from "../../src/config.js";
import type { TurnRequest, TurnResult } from "../../src/core/agent.js";
import type { RuntimeInfo } from "../../src/core/tools.js";

// 2026-11-25 브랜치(진행 표시·취소·인증 알림)의 코어 테스트가 함께 쓰는 최소 픽스처. coreMulti.test.ts 의 setup 과
// 같은 배선(pg-mem 실DB 리포 + 가짜 runTurn)이되, runTurn 을 테스트가 통째로 주입한다 — 취소 테스트는 req.signal 을
// 보고 끝나는 가짜가, 인증 테스트는 특정 문구로 실패하는 가짜가 필요하다.

// pg-mem 쿼리는 매크로태스크 단위로 풀린다(coreMulti.test.ts 의 flush 주석). ingest·턴 사이 홉 수만큼 넘긴다.
export const flush = async (): Promise<void> => {
  for (let i = 0; i < 40; i++) await new Promise((r) => setImmediate(r));
};

export type CoreFixture = Awaited<ReturnType<typeof setupCore>>;

export async function setupCore(over: { runTurn?: (req: TurnRequest) => Promise<TurnResult>; config?: Partial<Config>; runtimeInfo?: () => RuntimeInfo } = {}) {
  const db = await openTestDb();
  const repos = {
    users: new UsersRepo(db), conversations: new ConversationsRepo(db), participants: new ParticipantsRepo(db),
    messages: new MessagesRepo(db), summaries: new SummariesRepo(db), memories: new MemoriesRepo(db), turns: new TurnsRepo(db),
    allowedDirs: new AllowedDirsRepo(db), actions: new ActionsRepo(db), projects: new ProjectsRepo(db), llmUsage: new LlmUsageRepo(db),
  };
  await repos.users.upsert("owner", { role: "owner" });
  await repos.users.upsert("guest", { role: "allowed" });
  await repos.users.upsert("guest2", { role: "allowed" });
  const config: Config = {
    discordToken: "t", ownerId: "owner", databaseUrl: "postgres://test", dataDir: ":memory:", memoryDir: "x",
    sessionIdleMinutes: 30, maxTurnsPerHour: 30, maxTurnsPerHourPerUser: 20, maxTurnsPerHourGlobal: 40, ownerReserve: 10,
    deployTarget: "local", model: "claude-opus-5", httpPort: 3000, digestChannels: {}, github: null,
    ...over.config,
  };
  let clock = 1_000_000;
  const calls: TurnRequest[] = [];
  const runTurn = async (req: TurnRequest): Promise<TurnResult> => {
    calls.push(req);
    return over.runTurn ? over.runTurn(req) : { text: "답변", sessionId: "s1", ok: true };
  };
  const bus = new EventBus();
  const core = new AgentCore({ bus, config, runTurn, now: () => clock, repos, agentCwd: "/data/agent", ...(over.runtimeInfo ? { runtimeInfo: over.runtimeInfo } : {}) });
  core.start();
  const published: AgentEvent[] = [];
  for (const type of ["assistant_message", "system_notice", "progress", "side_notice"] as const) {
    bus.subscribe(type, (e) => { published.push(e); });
  }
  return {
    db, bus, core, repos, calls, published,
    setClock: (t: number) => { clock = t; },
    now: () => clock,
    // 특정 채널로 나간 이벤트만(종류별) 뽑는다.
    eventsIn: (channelRef: string, type?: AgentEvent["type"]) =>
      published.filter((e) => "channelRef" in e && e.channelRef === channelRef && (type === undefined || e.type === type)),
  };
}

let seq = 0;
export function dmHint(userId: string, role: "owner" | "allowed"): ConversationHint {
  return { kind: "dm", discordChannelId: `dm-${userId}`, isPrivate: true, primaryUserId: userId, userId, role, discordMessageId: `msg-${seq++}` };
}
export function threadHint(userId: string, channelId: string, role: "owner" | "allowed", origin = `origin-${channelId}`): ConversationHint {
  return { kind: "thread", discordChannelId: channelId, originMessageId: origin, guildId: "g", parentChannelId: "p", isPrivate: false, primaryUserId: userId, userId, role, discordMessageId: `msg-${seq++}` };
}
export function say(bus: EventBus, hint: ConversationHint, text: string, ts = 1_000_000): void {
  bus.publish({ type: "user_message", channel: "discord", channelRef: hint.discordChannelId, text, ts, hint: { ...hint, discordMessageId: `msg-${seq++}` } });
}
