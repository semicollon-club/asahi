import { describe, it, expect, beforeEach } from "vitest";
import { openTestDb } from "../src/store/db.js";
import { ProjectsRepo } from "../src/store/projectsRepo.js";

describe("ProjectsRepo", () => {
  let repo: ProjectsRepo;
  beforeEach(async () => { repo = new ProjectsRepo(await openTestDb()); });

  it("없는 이름은 null 이다", async () => {
    expect(await repo.byRepoName("todo-app")).toBeNull();
  });

  it("claim 하면 소유자와 함께 저장되고 조회된다", async () => {
    const row = await repo.claim({ repoName: "todo-app", ownerUserId: "u1", ts: 1000 });
    expect(row.repoName).toBe("todo-app");
    expect(row.ownerUserId).toBe("u1");
    expect(row.lastPushTs).toBeNull();
    expect(await repo.byRepoName("todo-app")).toEqual(row);
  });

  // 이 케이스가 이 리포의 존재 이유다 — 같은 이름을 다른 사람이 주장하면 조용히 덮어쓰거나
  // 두 행이 생기면 안 된다. 기존 소유자의 행이 그대로 돌아와야 호출측이 "남의 것"으로 판정한다.
  it("같은 이름을 다른 사람이 claim 하면 기존 소유자 행이 그대로 돌아온다", async () => {
    await repo.claim({ repoName: "todo-app", ownerUserId: "u1", ts: 1000 });
    const again = await repo.claim({ repoName: "todo-app", ownerUserId: "u2", ts: 2000 });
    expect(again.ownerUserId).toBe("u1");
    expect((await repo.listByOwner("u2")).length).toBe(0);
  });

  it("같은 사람이 다시 claim 하면 같은 행이다(재발행)", async () => {
    const first = await repo.claim({ repoName: "todo-app", ownerUserId: "u1", ts: 1000 });
    const second = await repo.claim({ repoName: "todo-app", ownerUserId: "u1", ts: 2000 });
    expect(second.id).toBe(first.id);
  });

  it("touchPush 는 마지막 푸시 시각을 남긴다", async () => {
    await repo.claim({ repoName: "todo-app", ownerUserId: "u1", ts: 1000 });
    await repo.touchPush("todo-app", 5000);
    expect((await repo.byRepoName("todo-app"))!.lastPushTs).toBe(5000);
  });

  it("listByOwner 는 그 사람 것만 돌려준다", async () => {
    await repo.claim({ repoName: "a", ownerUserId: "u1", ts: 1 });
    await repo.claim({ repoName: "b", ownerUserId: "u2", ts: 2 });
    expect((await repo.listByOwner("u1")).map((p) => p.repoName)).toEqual(["a"]);
  });
});
