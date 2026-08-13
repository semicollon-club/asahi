import { describe, it, expect, beforeEach } from "vitest";
import { openTestDb } from "../src/store/db.js";
import { LunchRepo } from "../src/store/lunchRepo.js";

const place = (placeId: string, name: string, categoryGroup?: string) =>
  ({ placeId, name, ...(categoryGroup ? { categoryGroup } : {}) });

describe("LunchRepo", () => {
  let repo: LunchRepo;
  beforeEach(async () => { repo = new LunchRepo(await openTestDb()); });

  it("장소를 저장하고 이름으로 찾는다", async () => {
    await repo.upsertPlaces([place("1", "국밥집", "음식점")], 1000);
    const found = await repo.findPlacesByName("국밥");
    expect(found.length).toBe(1);
    expect(found[0].placeId).toBe("1");
    expect(found[0].categoryGroup).toBe("음식점");
  });

  // 같은 가게를 다시 검색해도 행이 늘면 안 된다 — place_id 가 이 표의 뼈대다.
  it("같은 place_id 를 다시 넣으면 갱신될 뿐 늘지 않는다", async () => {
    await repo.upsertPlaces([place("1", "국밥집")], 1000);
    await repo.upsertPlaces([place("1", "국밥집 본점")], 2000);
    const found = await repo.findPlacesByName("국밥");
    expect(found.length).toBe(1);
    expect(found[0].name).toBe("국밥집 본점");
  });

  it("이름 일부로 여러 개가 걸릴 수 있다", async () => {
    await repo.upsertPlaces([place("1", "김밥천국"), place("2", "김밥나라")], 1000);
    expect((await repo.findPlacesByName("김밥")).length).toBe(2);
  });

  it("방문을 기록하고 집계한다", async () => {
    await repo.upsertPlaces([place("1", "국밥집")], 1000);
    await repo.recordVisit({ userId: "u1", placeId: "1", ts: 1000 });
    await repo.recordVisit({ userId: "u1", placeId: "1", ts: 5000, liked: true });

    const h = await repo.historyOf("u1");
    expect(h.get("1")!.visits).toBe(2);
    expect(h.get("1")!.lastVisitTs).toBe(5000);
    expect(h.get("1")!.liked).toBe(true);
  });

  // 다른 사람 기록이 섞이면 추천이 통째로 틀어진다.
  it("다른 사용자의 기록은 섞이지 않는다", async () => {
    await repo.upsertPlaces([place("1", "국밥집")], 1000);
    await repo.recordVisit({ userId: "u1", placeId: "1", ts: 1000 });
    await repo.recordVisit({ userId: "u2", placeId: "1", ts: 1000 });
    expect((await repo.historyOf("u1")).get("1")!.visits).toBe(1);
  });

  // 가장 최근 평가가 이긴다 — 예전에 별로였어도 최근에 좋았으면 그게 지금의 판단이다.
  it("liked 는 가장 최근 방문의 값을 쓴다", async () => {
    await repo.upsertPlaces([place("1", "국밥집")], 1000);
    await repo.recordVisit({ userId: "u1", placeId: "1", ts: 1000, liked: false });
    await repo.recordVisit({ userId: "u1", placeId: "1", ts: 9000, liked: true });
    expect((await repo.historyOf("u1")).get("1")!.liked).toBe(true);
  });

  it("최근 카테고리를 최신순으로 돌려준다", async () => {
    await repo.upsertPlaces([place("1", "국밥집", "한식"), place("2", "스시집", "일식")], 1000);
    await repo.recordVisit({ userId: "u1", placeId: "1", ts: 1000 });
    await repo.recordVisit({ userId: "u1", placeId: "2", ts: 2000 });
    expect(await repo.recentCategoryGroups("u1", 0)).toEqual(["일식", "한식"]);
  });

  it("sinceTs 이전 방문은 최근 카테고리에서 빠진다", async () => {
    await repo.upsertPlaces([place("1", "국밥집", "한식")], 1000);
    await repo.recordVisit({ userId: "u1", placeId: "1", ts: 1000 });
    expect(await repo.recentCategoryGroups("u1", 5000)).toEqual([]);
  });
});
