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

  it("displayNames 는 빈 문자열 이름도 제외한다(NULL 이 아니므로 별도 조건 필요)", async () => {
    const db = await openTestDb();
    const users = new UsersRepo(db, () => 1);
    await users.upsert("333", { role: "allowed", displayName: "영희" });
    // upsert 의 `patch.displayName ?? null` 은 ""(빈 문자열)를 그대로 통과시킨다 —
    // null 이 아니라 SQL 상 빈 문자열이 실제로 저장되는 경우를 재현해야
    // "IS NOT NULL" 만으로는 걸러지지 않는다는 것을 검증할 수 있다.
    await users.upsert("444", { role: "allowed", displayName: "" });

    const map = await users.displayNames();

    // 실제 이름이 있는 사용자는 여전히 맵에 존재해야 한다 — 메서드가 통째로
    // 빈 결과를 돌려주는 방식으로 이 테스트를 통과하는 것을 막는다.
    expect(map["333"]).toBe("영희");
    // in 연산자로 "키 부재"와 "키는 있지만 값이 falsy"를 구분한다 — toBeFalsy() 는
    // 빈 문자열이 값으로 들어 있어도 통과해버려 이 회귀를 잡지 못한다.
    expect("444" in map).toBe(false);
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

  it("findDmFor 는 그 사용자의 DM 대화를 찾는다", async () => {
    await repo.create({ kind: "dm", discordChannelId: "dm-1", primaryUserId: "owner", isPrivate: true, lastActiveTs: 10 });
    await repo.create({ kind: "thread", discordChannelId: "th-1", primaryUserId: "owner", isPrivate: false, lastActiveTs: 20 });

    const found = await repo.findDmFor("owner");
    expect(found?.discordChannelId).toBe("dm-1"); // 스레드가 더 최근이어도 DM 을 고른다
    expect(await repo.findDmFor("nobody")).toBeNull();
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
