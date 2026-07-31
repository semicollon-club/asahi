import { describe, it, expect, beforeEach } from "vitest";
import { openTestDb, type Db } from "../src/store/db.js";
import { UsersRepo } from "../src/store/usersRepo.js";
import { ConversationsRepo } from "../src/store/conversationsRepo.js";
import { ParticipantsRepo } from "../src/store/participantsRepo.js";

describe("UsersRepo", () => {
  it("upsert 하고 역할을 조회한다(기본 blocked)", async () => {
    const db = await openTestDb();
    const users = new UsersRepo(db, () => 1);
    expect(await users.getRole("u1")).toBe("blocked");
    await users.upsert("u1", { role: "allowed", displayName: "철수" });
    expect(await users.getRole("u1")).toBe("allowed");
    await users.upsert("u1", { displayName: "철수2" }); // role 유지
    expect(await users.getRole("u1")).toBe("allowed");
    expect((await users.list("allowed")).map((u) => u.id)).toEqual(["u1"]);
  });

  it("displayNames 는 이름이 있는 사용자만 맵으로 돌려준다", async () => {
    const db = await openTestDb();
    const users = new UsersRepo(db, () => 1);
    await users.upsert("111", { role: "allowed", displayName: "우성현" });
    await users.upsert("222", { role: "allowed" }); // 이름 없음

    const map = await users.displayNames();

    expect(map["111"]).toBe("우성현");
    // 이름이 없는 사용자는 키 자체가 없어야 한다 — 호출자가 "키가 없으면 폴백"으로 다루므로
    // null 이나 빈 문자열을 실어 보내면 그 판단이 흐려진다.
    expect("222" in map).toBe(false);
  });
});

describe("ConversationsRepo", () => {
  let db: Db, repo: ConversationsRepo;
  beforeEach(async () => { db = await openTestDb(); repo = new ConversationsRepo(db); });

  it("생성 후 채널ID로 조회한다", async () => {
    const id = await repo.create({ kind: "dm", discordChannelId: "c1", primaryUserId: "u1", isPrivate: true, lastActiveTs: 10 });
    const c = (await repo.getByChannelId("c1"))!;
    expect(c.id).toBe(id);
    expect(c.isPrivate).toBe(true);
    expect(c.sessionId).toBeNull();
  });

  it("origin_message_id 로 멱등 조회한다", async () => {
    await repo.create({ kind: "thread", discordChannelId: "t1", originMessageId: "m1", primaryUserId: "u1", isPrivate: false, lastActiveTs: 10 });
    expect((await repo.getByOriginMessageId("m1"))!.discordChannelId).toBe("t1");
    expect(await repo.getByOriginMessageId("nope")).toBeNull();
  });

  it("세션·상태·기억로드 플래그를 갱신한다", async () => {
    const id = await repo.create({ kind: "dm", discordChannelId: "c1", primaryUserId: "u1", isPrivate: true, lastActiveTs: 10 });
    await repo.setSession(id, "s1", 20);
    await repo.setPrivateMemoryLoaded(id, true);
    const c = (await repo.getByChannelId("c1"))!;
    expect(c.sessionId).toBe("s1");
    expect(c.lastActiveTs).toBe(20);
    expect(c.privateMemoryLoaded).toBe(true);
  });

  it("id 로 조회한다(없으면 null)", async () => {
    const id = await repo.create({ kind: "dm", discordChannelId: "c1", primaryUserId: "u1", isPrivate: true, lastActiveTs: 10 });
    expect((await repo.getById(id))!.discordChannelId).toBe("c1");
    expect(await repo.getById(9999)).toBeNull();
  });

  it("유휴 정리 대상은 세션이 있고 활성이며 last_active 가 컷오프 이전인 대화만", async () => {
    const a = await repo.create({ kind: "dm", discordChannelId: "a", primaryUserId: "u1", isPrivate: true, lastActiveTs: 100 });
    const b = await repo.create({ kind: "thread", discordChannelId: "b", primaryUserId: "u2", isPrivate: false, lastActiveTs: 100 });
    await repo.setSession(a, "s-a", 100); // a: 세션 있음
    // b: 세션 없음 → 제외
    expect((await repo.listActiveIdle(150)).map((c) => c.id)).toEqual([a]);
    await repo.setSession(a, "s-a", 200); // a 활동 갱신 → 컷오프(150) 이후라 제외
    expect((await repo.listActiveIdle(150)).map((c) => c.id)).toEqual([]);
    await repo.setSession(b, "s-b", 100); // b 세션 부여 → 이제 유휴 대상
    await repo.setStatus(b, "closed");    // 닫힘 → 제외
    expect((await repo.listActiveIdle(150)).map((c) => c.id)).toEqual([]);
  });
});

describe("ParticipantsRepo", () => {
  it("참여자를 upsert 하고 수를 센다", async () => {
    const db = await openTestDb();
    const repo = new ParticipantsRepo(db);
    await repo.upsert(1, "u1", 1);
    await repo.upsert(1, "u1", 2); // 중복 무시
    await repo.upsert(1, "u2", 3);
    expect(await repo.count(1)).toBe(2);
    expect((await repo.list(1)).sort()).toEqual(["u1", "u2"]);
  });
});
