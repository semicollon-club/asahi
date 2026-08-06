import { describe, it, expect, beforeEach } from "vitest";
import { openTestDb } from "../src/store/db.js";
import { MemoriesRepo } from "../src/store/memoriesRepo.js";

describe("MemoriesRepo", () => {
  let repo: MemoriesRepo;
  beforeEach(async () => {
    repo = new MemoriesRepo(await openTestDb(), () => 1);
    await repo.insert({ userId: "owner", scope: "user", title: "고양이", content: "고양이 두 마리" });
    await repo.insert({ userId: "bob", scope: "user", title: "밥선호", content: "매운 것 좋아함" });
    await repo.insert({ userId: "owner", scope: "shared", title: "서버규칙", content: "존댓말 사용" });
    await repo.insert({ userId: "owner", scope: "character", title: "학년", content: "2학년" });
    await repo.insert({ userId: "bob", scope: "character", title: "동아리부장", content: "부장은 3학년 선배" });
  });

  it("forUser 는 그 사용자 user 기억 + 전체 shared 만 준다(타인 user 제외)", async () => {
    const titles = (await repo.forUser("owner")).map((m) => m.title).sort();
    expect(titles).toEqual(["고양이", "서버규칙"]);
    const bob = (await repo.forUser("bob")).map((m) => m.title).sort();
    expect(bob).toEqual(["밥선호", "서버규칙"]); // bob 의 user + shared, owner 의 user(고양이) 제외
  });

  it("sharedOnly 는 shared 만(개인기억 없음)", async () => {
    expect((await repo.sharedOnly()).map((m) => m.title)).toEqual(["서버규칙"]);
  });

  // 쓰기 경로는 사라졌지만 기존 행이 DB 에 남아 있다 — 이 필터가 빠지면 옛 픽션이 소유자
  // recall 결과에 다시 섞인다. 그래서 픽스처도 character 행을 계속 심어 둔다.
  it("all 은 character(옛 픽션 설정)를 제외한 전원(소유자 recall 용)", async () => {
    const titles = (await repo.all()).map((m) => m.title).sort();
    expect(titles).toEqual(["고양이", "밥선호", "서버규칙"]);
  });

  it("검색·수정·삭제", async () => {
    const hits = await repo.searchForUser("owner", "고양이");
    expect(hits).toHaveLength(1);
    await repo.update(hits[0].id, { content: "고양이 세 마리" });
    expect((await repo.searchForUser("owner", "고양이"))[0].content).toBe("고양이 세 마리");
    await repo.delete(hits[0].id);
    expect(await repo.searchForUser("owner", "고양이")).toHaveLength(0);
  });

  it("ILIKE 메타문자(%, _)를 이스케이프해 리터럴로만 매칭한다", async () => {
    await repo.insert({ userId: "owner", scope: "shared", title: "할인", content: "50% 쿠폰" });
    await repo.insert({ userId: "owner", scope: "shared", title: "할인아님", content: "50X 쿠폰" });
    await repo.insert({ userId: "owner", scope: "shared", title: "밑줄", content: "a_b 값" });
    await repo.insert({ userId: "owner", scope: "shared", title: "밑줄아님", content: "aXb 값" });

    expect((await repo.searchForUser("owner", "50%")).map((m) => m.content)).toEqual(["50% 쿠폰"]);
    expect((await repo.searchForUser("owner", "a_b")).map((m) => m.content)).toEqual(["a_b 값"]);
  });

  it("forUser·sharedOnly·searchForUser 에는 character 가 섞이지 않는다", async () => {
    expect((await repo.forUser("owner")).some((m) => m.scope === "character")).toBe(false);
    expect((await repo.sharedOnly()).some((m) => m.scope === "character")).toBe(false);
    expect(await repo.searchForUser("owner", "2학년")).toEqual([]);
  });
});
