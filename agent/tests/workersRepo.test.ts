import { describe, it, expect, beforeEach } from "vitest";
import { openTestDb } from "../src/store/db.js";
import { WorkersRepo, hashWorkerToken, generateWorkerToken } from "../src/store/workersRepo.js";

describe("hashWorkerToken / generateWorkerToken", () => {
  it("같은 토큰은 같은 해시, 다른 토큰은 다른 해시", () => {
    expect(hashWorkerToken("abc")).toBe(hashWorkerToken("abc"));
    expect(hashWorkerToken("abc")).not.toBe(hashWorkerToken("abd"));
  });

  it("해시는 평문을 담지 않는다", () => {
    expect(hashWorkerToken("secret-token-value")).not.toContain("secret");
  });

  it("생성된 토큰은 매번 다르고 충분히 길다", () => {
    const a = generateWorkerToken();
    const b = generateWorkerToken();
    expect(a).not.toBe(b);
    expect(a.length).toBeGreaterThanOrEqual(64);
  });
});

describe("WorkersRepo", () => {
  let repo: WorkersRepo;

  beforeEach(async () => {
    repo = new WorkersRepo(await openTestDb());
  });

  it("등록한 워커를 id 로 찾는다", async () => {
    await repo.upsert({ id: "semicolon-shared", kind: "shared", userId: null, tokenHash: "h1", label: "동아리 미니PC", ts: 100 });
    const row = await repo.getById("semicolon-shared");
    expect(row).toMatchObject({ id: "semicolon-shared", kind: "shared", userId: null, tokenHash: "h1", label: "동아리 미니PC", createdTs: 100 });
    expect(row?.lastSeenTs).toBeNull();
  });

  it("없는 id 는 null", async () => {
    expect(await repo.getById("없음")).toBeNull();
  });

  it("같은 id 로 다시 등록하면 토큰 해시가 교체된다(회전)", async () => {
    await repo.upsert({ id: "w1", kind: "shared", userId: null, tokenHash: "old", ts: 100 });
    await repo.upsert({ id: "w1", kind: "shared", userId: null, tokenHash: "new", ts: 200 });
    const row = await repo.getById("w1");
    expect(row?.tokenHash).toBe("new");
  });

  it("라벨 없이 재등록(회전)하면 기존 라벨이 보존된다", async () => {
    await repo.upsert({ id: "w1", kind: "shared", userId: null, tokenHash: "old", label: "동아리 미니PC", ts: 100 });
    await repo.upsert({ id: "w1", kind: "shared", userId: null, tokenHash: "new", ts: 200 });
    expect((await repo.getById("w1"))?.label).toBe("동아리 미니PC");
  });

  it("라벨을 명시해서 재등록하면 교체된다", async () => {
    await repo.upsert({ id: "w1", kind: "shared", userId: null, tokenHash: "old", label: "동아리 미니PC", ts: 100 });
    await repo.upsert({ id: "w1", kind: "shared", userId: null, tokenHash: "new", label: "새 이름", ts: 200 });
    expect((await repo.getById("w1"))?.label).toBe("새 이름");
  });

  it("personal 워커를 담당 사용자로 찾는다", async () => {
    await repo.upsert({ id: "owner-laptop", kind: "personal", userId: "owner", tokenHash: "h", ts: 100 });
    expect(await repo.personalWorkerOf("owner")).toBe("owner-laptop");
    expect(await repo.personalWorkerOf("guest")).toBeNull();
  });

  it("personal 워커가 한 사용자에게 여럿이면(예: 노트북+데스크탑) 가장 먼저 등록된 것을 돌려준다(결정적)", async () => {
    // created_ts 가 완전히 같은 동석(tie) 상황 — 정렬 없이 LIMIT 1 이면 DB 가 순서를 정한다.
    await repo.upsert({ id: "z-laptop", kind: "personal", userId: "owner", tokenHash: "h", ts: 100 });
    await repo.upsert({ id: "a-desktop", kind: "personal", userId: "owner", tokenHash: "h", ts: 100 });
    expect(await repo.personalWorkerOf("owner")).toBe("a-desktop");
  });

  it("shared 워커를 찾는다 — 없으면 null", async () => {
    expect(await repo.sharedWorkerId()).toBeNull();
    await repo.upsert({ id: "semicolon-shared", kind: "shared", userId: null, tokenHash: "h", ts: 100 });
    expect(await repo.sharedWorkerId()).toBe("semicolon-shared");
  });

  it("shared 워커가 여럿이면 가장 먼저 등록된 것을 돌려준다(결정적)", async () => {
    await repo.upsert({ id: "b-shared", kind: "shared", userId: null, tokenHash: "h", ts: 200 });
    await repo.upsert({ id: "a-shared", kind: "shared", userId: null, tokenHash: "h", ts: 100 });
    expect(await repo.sharedWorkerId()).toBe("a-shared");
  });

  it("last_seen_ts 를 갱신한다", async () => {
    await repo.upsert({ id: "w1", kind: "shared", userId: null, tokenHash: "h", ts: 100 });
    await repo.touchLastSeen("w1", 500);
    expect((await repo.getById("w1"))?.lastSeenTs).toBe(500);
  });
});
