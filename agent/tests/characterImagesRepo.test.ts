import { describe, it, expect, beforeEach } from "vitest";
import { openTestDb } from "../src/store/db.js";
import { CharacterImagesRepo } from "../src/store/characterImagesRepo.js";

describe("CharacterImagesRepo", () => {
  let repo: CharacterImagesRepo;
  beforeEach(async () => {
    repo = new CharacterImagesRepo(await openTestDb());
  });

  it("비어 있으면 감정 목록도 URL 도 빈 배열이다", async () => {
    expect(await repo.emotions()).toEqual([]);
    expect(await repo.urlsFor("홍조")).toEqual([]);
  });

  it("replaceAll 로 넣으면 감정이 중복 없이 가나다순으로 나온다", async () => {
    await repo.replaceAll([
      { emotion: "홍조", url: "https://x/홍조/1.png" },
      { emotion: "당황", url: "https://x/당황/1.png" },
      { emotion: "홍조", url: "https://x/홍조/2.png" },
    ], 1);
    expect(await repo.emotions()).toEqual(["당황", "홍조"]);
  });

  it("urlsFor 는 그 감정의 URL 만 준다", async () => {
    await repo.replaceAll([
      { emotion: "홍조", url: "https://x/홍조/1.png" },
      { emotion: "홍조", url: "https://x/홍조/2.png" },
      { emotion: "당황", url: "https://x/당황/1.png" },
    ], 1);
    expect((await repo.urlsFor("홍조")).sort()).toEqual(["https://x/홍조/1.png", "https://x/홍조/2.png"]);
    expect(await repo.urlsFor("없는감정")).toEqual([]);
  });

  it("replaceAll 은 이전 내용을 완전히 대체한다(삭제된 이미지가 남지 않는다)", async () => {
    await repo.replaceAll([{ emotion: "홍조", url: "https://x/old.png" }], 1);
    await repo.replaceAll([{ emotion: "웃음", url: "https://x/new.png" }], 2);
    expect(await repo.emotions()).toEqual(["웃음"]);
    expect(await repo.urlsFor("홍조")).toEqual([]);
  });

  it("빈 배열로 replaceAll 하면 카탈로그가 비워진다", async () => {
    await repo.replaceAll([{ emotion: "홍조", url: "https://x/1.png" }], 1);
    await repo.replaceAll([], 2);
    expect(await repo.emotions()).toEqual([]);
  });

  it("공백이 들어간 감정 이름도 그대로 다룬다", async () => {
    await repo.replaceAll([{ emotion: "기본 무표정", url: "https://x/1.png" }], 1);
    expect(await repo.emotions()).toEqual(["기본 무표정"]);
    expect(await repo.urlsFor("기본 무표정")).toHaveLength(1);
  });
});
