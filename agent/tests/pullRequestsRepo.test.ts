import { describe, it, expect, beforeEach } from "vitest";
import { openTestDb } from "../src/store/db.js";
import { PullRequestsRepo } from "../src/store/pullRequestsRepo.js";

const base = {
  repo: "homepage", number: 7, url: "https://github.com/semicollon-club/homepage/pull/7",
  head: "feat/login", base: "main", title: "로그인 페이지", requesterUserId: "guest", conversationId: 1, ts: 1_000,
};

describe("PullRequestsRepo", () => {
  let repo: PullRequestsRepo;
  beforeEach(async () => { repo = new PullRequestsRepo(await openTestDb()); });

  it("기록하면 열린 상태·CI 미확인으로 저장되고 리포·번호로 조회된다", async () => {
    const row = await repo.record(base);
    expect(row).toMatchObject({
      repo: "homepage", number: 7, head: "feat/login", base: "main", title: "로그인 페이지",
      requesterUserId: "guest", conversationId: 1, createdTs: 1_000,
      state: "open", ciState: "unknown", headSha: null,
      ownerNotifiedTs: null, ciNotifiedTs: null, closedNotifiedTs: null, lastCheckedTs: null,
    });
    expect(await repo.byRepoNumber("homepage", 7)).toEqual(row);
    expect(await repo.byRepoNumber("homepage", 8)).toBeNull();
  });

  // 같은 PR 을 두 번 기록해도 행은 하나다 — 봇이 재시도하거나 같은 브랜치로 PR 을 다시 내는 경우
  // 알림이 두 벌 나가면 안 된다. 기존 행을 그대로 돌려준다(projectsRepo.claim 과 같은 모양).
  it("같은 리포·번호를 다시 기록하면 기존 행이 그대로 돌아온다", async () => {
    const first = await repo.record(base);
    const again = await repo.record({ ...base, requesterUserId: "someone-else", ts: 2_000 });
    expect(again.id).toBe(first.id);
    expect(again.requesterUserId).toBe("guest");
    expect(await repo.listRecent()).toHaveLength(1);
  });

  it("listOpen 은 열린 것만, 만든 순서로 돌려준다", async () => {
    const a = await repo.record({ ...base, number: 1, ts: 100 });
    const b = await repo.record({ ...base, number: 2, ts: 200 });
    await repo.record({ ...base, number: 3, ts: 300 });
    await repo.update(b.id, { state: "merged" });
    expect((await repo.listOpen()).map((r) => r.number)).toEqual([1, 3]);
    expect(a.state).toBe("open");
  });

  it("listByRequester 는 그 사람 것만 최근 순으로, listRecent 는 전부 최근 순으로", async () => {
    await repo.record({ ...base, number: 1, requesterUserId: "u1", ts: 100 });
    await repo.record({ ...base, number: 2, requesterUserId: "u2", ts: 200 });
    await repo.record({ ...base, number: 3, requesterUserId: "u1", ts: 300 });
    expect((await repo.listByRequester("u1")).map((r) => r.number)).toEqual([3, 1]);
    expect((await repo.listRecent()).map((r) => r.number)).toEqual([3, 2, 1]);
    expect((await repo.listRecent(2)).map((r) => r.number)).toEqual([3, 2]);
  });

  it("update 는 준 필드만 바꾼다", async () => {
    const row = await repo.record(base);
    await repo.update(row.id, { ciState: "pending", headSha: "abc", lastCheckedTs: 5_000 });
    const after = (await repo.byRepoNumber("homepage", 7))!;
    expect(after).toMatchObject({ ciState: "pending", headSha: "abc", lastCheckedTs: 5_000, state: "open", ownerNotifiedTs: null });
    await repo.update(row.id, { ciNotifiedTs: 6_000, ownerNotifiedTs: 6_500 });
    const again = (await repo.byRepoNumber("homepage", 7))!;
    expect(again).toMatchObject({ ciNotifiedTs: 6_000, ownerNotifiedTs: 6_500, ciState: "pending" });
  });

  it("빈 patch 는 아무것도 바꾸지 않고 던지지도 않는다", async () => {
    const row = await repo.record(base);
    await repo.update(row.id, {});
    expect(await repo.byRepoNumber("homepage", 7)).toEqual(row);
  });
});
