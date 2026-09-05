import { describe, it, expect } from "vitest";
import { openTestDb } from "../src/store/db.js";
import { PullRequestsRepo } from "../src/store/pullRequestsRepo.js";
import { EventBus, type AgentEvent } from "../src/events/bus.js";
import {
  PrTracker, pollIntervalMs, isDue,
  PR_POLL_YOUNG_INTERVAL_MS, PR_POLL_MID_INTERVAL_MS, PR_POLL_OLD_INTERVAL_MS,
} from "../src/core/prTracker.js";

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

describe("pollIntervalMs / isDue — PR 하나에 깃허브를 얼마나 자주 묻는가", () => {
  it("갓 만든 PR 은 자주, 오래된 PR 은 드물게, 30일이 지나면 그만 본다", () => {
    expect(pollIntervalMs(0)).toBe(PR_POLL_YOUNG_INTERVAL_MS);
    expect(pollIntervalMs(5 * HOUR)).toBe(PR_POLL_YOUNG_INTERVAL_MS);
    expect(pollIntervalMs(7 * HOUR)).toBe(PR_POLL_MID_INTERVAL_MS);
    expect(pollIntervalMs(4 * DAY)).toBe(PR_POLL_OLD_INTERVAL_MS);
    expect(pollIntervalMs(31 * DAY)).toBeNull();
  });

  it("한 번도 확인하지 않은 행은 바로 확인 대상이고, 간격 안에 확인한 행은 아니다", () => {
    const created = 1_000_000;
    expect(isDue({ createdTs: created, lastCheckedTs: null }, created + 1)).toBe(true);
    expect(isDue({ createdTs: created, lastCheckedTs: created + MIN }, created + 2 * MIN)).toBe(false);
    expect(isDue({ createdTs: created, lastCheckedTs: created + MIN }, created + MIN + PR_POLL_YOUNG_INTERVAL_MS)).toBe(true);
    expect(isDue({ createdTs: created, lastCheckedTs: created }, created + 31 * DAY)).toBe(false);
  });
});

// 깃허브를 흉내 낸다 — PR 상태와 그 커밋의 워크플로 실행을 테스트가 시나리오마다 바꿔 넣는다.
type Scenario = {
  state?: "open" | "closed"; merged?: boolean; sha?: string;
  runs?: Array<{ name: string; status: string; conclusion: string | null }>;
  denyActions?: boolean;
};
function fakeGithub(s: Scenario) {
  const scenario = s;
  const calls: string[] = [];
  const mints: Array<{ repoNames: string[]; permissions: Record<string, string> }> = [];
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  const fetchImpl = (async (url: string) => {
    const u = String(url);
    calls.push(u);
    if (/\/pulls\/\d+$/.test(u)) {
      const number = Number(u.split("/").pop());
      return json({
        number, title: `PR ${number}`, state: scenario.state ?? "open", merged: scenario.merged ?? false,
        html_url: `https://github.com/semicollon-club/homepage/pull/${number}`,
        head: { ref: "feat/x", sha: scenario.sha ?? "sha1" }, base: { ref: "main" },
      });
    }
    if (u.includes("/actions/runs")) {
      return json({
        total_count: (scenario.runs ?? []).length,
        workflow_runs: (scenario.runs ?? []).map((r, i) => ({ ...r, html_url: `https://github.com/semicollon-club/homepage/actions/runs/${i + 1}` })),
      });
    }
    return json({ message: `unexpected ${u}` }, 500);
  }) as unknown as typeof fetch;
  const mint = async (o: { repoNames: string[]; permissions: Record<string, string> }) => {
    mints.push({ repoNames: o.repoNames, permissions: o.permissions });
    if (scenario.denyActions && o.permissions.actions) throw new Error("The permissions requested are not granted to this installation.");
    return { token: "ghs_track", expiresAt: "2026-09-05T01:00:00Z" };
  };
  return { calls, mints, fetchImpl, mint, scenario };
}

const github = { org: "semicollon-club", appId: "1", installationId: "2", privateKeyPem: "PEM" };

async function make(s: Scenario, o: { notifyChannelId?: string; hasOwnerDm?: boolean; now?: number } = {}) {
  const db = await openTestDb();
  const pullRequests = new PullRequestsRepo(db);
  const gh = fakeGithub(s);
  const bus = new EventBus();
  const sent: AgentEvent[] = [];
  bus.subscribe("assistant_message", (e) => { sent.push(e); });
  bus.subscribe("system_notice", (e) => { sent.push(e); });
  let clock = o.now ?? 1_000_000;
  const tracker = new PrTracker({
    pullRequests,
    conversations: {
      getById: async (id: number) => (id === 1 ? { discordChannelId: "C-req" } : null),
      findDmFor: async (userId: string) => (o.hasOwnerDm === false || userId !== "owner" ? null : { discordChannelId: "DM-owner" }),
    },
    users: { displayNames: async () => ({ guest: "민수" }) },
    bus, github, ownerId: "owner", notifyChannelId: o.notifyChannelId,
    fetchImpl: gh.fetchImpl, mint: gh.mint as never, now: () => clock,
  });
  const record = (over: Partial<Parameters<PullRequestsRepo["record"]>[0]> = {}) =>
    pullRequests.record({
      repo: "homepage", number: 7, url: "https://github.com/semicollon-club/homepage/pull/7", head: "feat/x", base: "main",
      title: "PR 7", requesterUserId: "guest", conversationId: 1, ts: clock, ...over,
    });
  return { tracker, pullRequests, gh, sent, record, tick: () => tracker.tick(), advance: (ms: number) => { clock += ms; } };
}

const texts = (sent: AgentEvent[]) => sent.map((e) => ("text" in e ? `${e.type}@${e.channelRef}: ${e.text}` : ""));

describe("PrTracker.tick", () => {
  it("추적 중인 열린 PR 이 없으면 깃허브를 부르지 않는다", async () => {
    const t = await make({});
    await t.tick();
    expect(t.gh.calls).toHaveLength(0);
    expect(t.gh.mints).toHaveLength(0);
  });

  it("새 PR 은 운영자에게 한 번 알리고, 토큰은 그 리포·pull_requests+actions 읽기로 발급한다", async () => {
    const t = await make({ runs: [{ name: "agent", status: "in_progress", conclusion: null }] });
    await t.record();
    await t.tick();
    expect(t.gh.mints).toEqual([{ repoNames: ["homepage"], permissions: { pull_requests: "read", actions: "read" } }]);
    const owner = texts(t.sent).filter((s) => s.includes("@DM-owner"));
    expect(owner).toHaveLength(1);
    expect(owner[0]).toContain("homepage#7");
    expect(owner[0]).toContain("민수");
    expect(owner[0]).toContain("assistant_message");
    // CI 가 아직 도는 중이면 요청자에게는 아무 말도 하지 않는다.
    expect(texts(t.sent).filter((s) => s.includes("@C-req"))).toHaveLength(0);
    const row = (await t.pullRequests.byRepoNumber("homepage", 7))!;
    expect(row.ciState).toBe("pending");
    expect(row.headSha).toBe("sha1");
    expect(row.ownerNotifiedTs).not.toBeNull();
    expect(row.lastCheckedTs).not.toBeNull();
    // 두 번째 틱은 간격 안이라 깃허브를 다시 묻지 않고, 운영자 알림도 다시 내지 않는다.
    const before = t.gh.calls.length;
    await t.tick();
    expect(t.gh.calls.length).toBe(before);
    expect(texts(t.sent).filter((s) => s.includes("@DM-owner"))).toHaveLength(1);
  });

  it("운영자 알림은 PR_NOTIFY_CHANNEL_ID 가 있으면 그 채널로 간다", async () => {
    const t = await make({ runs: [] }, { notifyChannelId: "C-pr" });
    await t.record();
    await t.tick();
    expect(texts(t.sent).some((s) => s.includes("@C-pr") && s.includes("homepage#7"))).toBe(true);
    expect(texts(t.sent).some((s) => s.includes("@DM-owner"))).toBe(false);
  });

  it("운영자 자신이 낸 PR 은 운영자에게 알리지 않는다", async () => {
    const t = await make({ runs: [] });
    await t.record({ requesterUserId: "owner" });
    await t.tick();
    expect(texts(t.sent).some((s) => s.includes("@DM-owner"))).toBe(false);
    expect((await t.pullRequests.byRepoNumber("homepage", 7))!.ownerNotifiedTs).not.toBeNull();
  });

  it("알릴 채널이 없으면(DM 대화도 설정도 없음) 조용히 표시만 남기고 매 틱 다시 시도하지 않는다", async () => {
    const t = await make({ runs: [] }, { hasOwnerDm: false });
    await t.record();
    await t.tick();
    expect(texts(t.sent).some((s) => s.includes("새 PR"))).toBe(false);
    expect((await t.pullRequests.byRepoNumber("homepage", 7))!.ownerNotifiedTs).not.toBeNull();
  });

  it("CI 가 통과하면 요청자 채널에 한 번만 알린다", async () => {
    const t = await make({ runs: [{ name: "agent", status: "in_progress", conclusion: null }] });
    await t.record();
    await t.tick();
    t.gh.scenario.runs = [{ name: "agent", status: "completed", conclusion: "success" }, { name: "docs", status: "completed", conclusion: "skipped" }];
    t.advance(PR_POLL_YOUNG_INTERVAL_MS);
    await t.tick();
    const req = texts(t.sent).filter((s) => s.includes("@C-req"));
    expect(req).toHaveLength(1);
    expect(req[0]).toContain("assistant_message");
    expect(req[0]).toContain("CI 통과");
    expect(req[0]).toContain("homepage#7");
    expect((await t.pullRequests.byRepoNumber("homepage", 7))!.ciState).toBe("success");
    t.advance(PR_POLL_YOUNG_INTERVAL_MS);
    await t.tick();
    expect(texts(t.sent).filter((s) => s.includes("@C-req"))).toHaveLength(1);
  });

  it("CI 가 실패하면 실패한 잡 이름과 함께 경고로 알린다", async () => {
    const t = await make({ runs: [{ name: "agent", status: "completed", conclusion: "failure" }, { name: "docs", status: "completed", conclusion: "success" }] });
    await t.record();
    await t.tick();
    const req = texts(t.sent).filter((s) => s.includes("@C-req"));
    expect(req).toHaveLength(1);
    expect(req[0]).toContain("system_notice");
    expect(req[0]).toContain("CI 실패");
    expect(req[0]).toContain("agent");
    expect(req[0]).not.toContain("docs");
    expect((await t.pullRequests.byRepoNumber("homepage", 7))!.ciState).toBe("failure");
  });

  // 실패 알림 뒤 부원이 고쳐 push 하면 커밋이 바뀐다 — 그 커밋의 결과는 새 사실이라 다시 알린다.
  it("새 커밋이 올라오면 그 커밋의 CI 결과를 다시 알린다", async () => {
    const t = await make({ sha: "sha1", runs: [{ name: "agent", status: "completed", conclusion: "failure" }] });
    await t.record();
    await t.tick();
    t.gh.scenario.sha = "sha2";
    t.gh.scenario.runs = [{ name: "agent", status: "completed", conclusion: "success" }];
    t.advance(PR_POLL_YOUNG_INTERVAL_MS);
    await t.tick();
    const req = texts(t.sent).filter((s) => s.includes("@C-req"));
    expect(req).toHaveLength(2);
    expect(req[1]).toContain("CI 통과");
    expect((await t.pullRequests.byRepoNumber("homepage", 7))!.headSha).toBe("sha2");
  });

  it("워크플로가 하나도 없는 리포는 10분이 지나면 CI 없음으로 두고 알리지 않는다", async () => {
    const t = await make({ runs: [] });
    await t.record();
    await t.tick();
    expect((await t.pullRequests.byRepoNumber("homepage", 7))!.ciState).toBe("pending");
    t.advance(11 * MIN);
    await t.tick();
    expect((await t.pullRequests.byRepoNumber("homepage", 7))!.ciState).toBe("none");
    expect(texts(t.sent).filter((s) => s.includes("@C-req"))).toHaveLength(0);
  });

  it("병합되면 요청자에게 한 번 알리고 추적을 끝낸다", async () => {
    const t = await make({ state: "closed", merged: true });
    await t.record();
    await t.tick();
    const req = texts(t.sent).filter((s) => s.includes("@C-req"));
    expect(req).toHaveLength(1);
    expect(req[0]).toContain("assistant_message");
    expect(req[0]).toContain("병합");
    expect(req[0]).toContain("git switch main");
    expect((await t.pullRequests.byRepoNumber("homepage", 7))!.state).toBe("merged");
    // 닫힌 PR 은 더 이상 열린 목록에 없어 다음 틱은 깃허브를 부르지 않는다.
    const before = t.gh.calls.length;
    t.advance(PR_POLL_YOUNG_INTERVAL_MS);
    await t.tick();
    expect(t.gh.calls.length).toBe(before);
    expect(texts(t.sent).filter((s) => s.includes("@C-req"))).toHaveLength(1);
  });

  it("병합 없이 닫히면 경고로 알린다", async () => {
    const t = await make({ state: "closed", merged: false });
    await t.record();
    await t.tick();
    const req = texts(t.sent).filter((s) => s.includes("@C-req"));
    expect(req).toHaveLength(1);
    expect(req[0]).toContain("system_notice");
    expect(req[0]).toContain("병합 없이 닫");
    expect((await t.pullRequests.byRepoNumber("homepage", 7))!.state).toBe("closed");
  });

  // App 에 actions 권한이 없으면 깃허브는 발급 자체를 거절한다 — CI 를 포기하고 나머지(병합 감지·
  // 운영자 알림)는 계속 돌아야 한다.
  it("actions 권한이 없으면 pull_requests 만으로 다시 발급하고 CI 는 미확인으로 둔다", async () => {
    const t = await make({ denyActions: true, state: "closed", merged: true });
    await t.record();
    await t.tick();
    expect(t.gh.mints.map((m) => m.permissions)).toEqual([
      { pull_requests: "read", actions: "read" },
      { pull_requests: "read" },
    ]);
    expect((await t.pullRequests.byRepoNumber("homepage", 7))!.state).toBe("merged");
    expect(t.gh.calls.some((u) => u.includes("/actions/runs"))).toBe(false);
  });

  it("PR 을 낸 대화를 찾지 못하면 알림은 건너뛰되 상태는 기록한다", async () => {
    const t = await make({ state: "closed", merged: true });
    await t.record({ conversationId: 999 });
    await t.tick();
    expect(texts(t.sent).filter((s) => s.includes("@C-req"))).toHaveLength(0);
    const row = (await t.pullRequests.byRepoNumber("homepage", 7))!;
    expect(row.state).toBe("merged");
    expect(row.closedNotifiedTs).not.toBeNull();
  });

  it("깃허브 설정이 없으면 아무것도 하지 않는다", async () => {
    const db = await openTestDb();
    const pullRequests = new PullRequestsRepo(db);
    await pullRequests.record({ repo: "homepage", number: 1, url: "u", head: "h", base: "main", title: "t", requesterUserId: "guest", conversationId: 1, ts: 1 });
    const gh = fakeGithub({});
    const tracker = new PrTracker({
      pullRequests, conversations: { getById: async () => null, findDmFor: async () => null }, users: { displayNames: async () => ({}) },
      bus: new EventBus(), github: null, ownerId: "owner", fetchImpl: gh.fetchImpl, mint: gh.mint as never,
    });
    await tracker.tick();
    expect(gh.calls).toHaveLength(0);
  });
});
