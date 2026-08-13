import { describe, it, expect, beforeEach } from "vitest";
import { openTestDb } from "../src/store/db.js";
import { LunchRepo } from "../src/store/lunchRepo.js";
import { lunchSearchHandler, lunchRecommendHandler, lunchVisitHandler } from "../src/core/lunch.js";

const config = { kakaoKey: "kk", lat: 37.4, lon: 126.6, radiusM: 800 };
const NOW = 1_700_000_000_000;

const kakaoDoc = (id: string, name: string, group = "음식점") => ({
  id, place_name: name, category_group_name: group, place_url: `http://p/${id}`, distance: "100",
});
const fakeFetch = (docs: unknown[]) =>
  (async () => new Response(JSON.stringify({ documents: docs }), { status: 200 })) as unknown as typeof fetch;

describe("점심 도구 핸들러", () => {
  let repo: LunchRepo;
  const ctx = () => ({ config, repo, userId: "u1", now: () => NOW, fetchImpl: fakeFetch([kakaoDoc("1", "국밥집"), kakaoDoc("2", "스시집")]) });
  beforeEach(async () => { repo = new LunchRepo(await openTestDb()); });

  it("검색은 결과를 돌려주고 장소를 저장한다", async () => {
    const r = await lunchSearchHandler(ctx(), {});
    expect(r.ok).toBe(true);
    expect(r.content).toContain("국밥집");
    expect((await repo.findPlacesByName("국밥")).length).toBe(1);
  });

  it("결과가 없으면 그 사실을 말한다", async () => {
    const r = await lunchSearchHandler({ ...ctx(), fetchImpl: fakeFetch([]) }, {});
    expect(r.ok).toBe(true);
    expect(r.content).toContain("찾지 못했");
  });

  it("추천은 기록을 반영하고 이유를 함께 준다", async () => {
    await repo.upsertPlaces([{ placeId: "1", name: "국밥집" }], NOW);
    await repo.recordVisit({ userId: "u1", placeId: "1", ts: NOW - 90 * 24 * 3600_000, liked: true });

    const r = await lunchRecommendHandler(ctx(), { count: 2 });
    expect(r.ok).toBe(true);
    expect(r.content).toContain("국밥집");
    expect(r.content).toContain("좋았다고");
  });

  it("방문 기록은 이름으로 찾아 저장한다", async () => {
    await repo.upsertPlaces([{ placeId: "1", name: "국밥집" }], NOW);
    const r = await lunchVisitHandler(ctx(), { place: "국밥집", liked: true });
    expect(r.ok).toBe(true);
    expect((await repo.historyOf("u1")).get("1")!.liked).toBe(true);
  });

  // forget 이 같은 제목 여러 건에 대해 하는 것과 같은 방식이다(설계 §6.1) — 후보를 번호와
  // 함께 보여준다. lunch_visit 은 place_id 로 되짚을 인자가 없어(브리프의 Produces 그대로)
  // forget처럼 그 번호를 그대로 재입력받지는 못하지만, "추측해서 하나를 고르지 않고 목록을
  // 번호로 또렷하게 보여준다"는 제시 방식만은 그대로 따른다.
  it("이름이 여러 개 걸리면 저장하지 않고 후보를 번호와 함께 보여준다", async () => {
    await repo.upsertPlaces([{ placeId: "1", name: "김밥천국" }, { placeId: "2", name: "김밥나라" }], NOW);
    const r = await lunchVisitHandler(ctx(), { place: "김밥" });
    expect(r.ok).toBe(false);
    expect(r.content).toContain("김밥천국");
    expect(r.content).toContain("김밥나라");
    expect(r.content).toContain("번호 1");
    expect(r.content).toContain("번호 2");
    expect((await repo.historyOf("u1")).size).toBe(0);
  });

  // place_id 없는 행이 생기면 누적의 뼈대가 그 순간 깨진다(설계 §6.1) — 검색 없이 방문만
  // 부른 이름은 절대 새 lunch_places 행을 만들지 않는다.
  it("없는 가게는 새로 만들지 않고 먼저 검색하라고 한다", async () => {
    const r = await lunchVisitHandler(ctx(), { place: "없는집" });
    expect(r.ok).toBe(false);
    expect(r.content).toContain("검색");
    expect((await repo.historyOf("u1")).size).toBe(0);
    expect((await repo.findPlacesByName("없는집")).length).toBe(0);
  });

  it("지도 API 가 실패하면 실패로 돌려주고 키를 노출하지 않는다", async () => {
    const failing = (async () => new Response("{}", { status: 401 })) as unknown as typeof fetch;
    const r = await lunchSearchHandler({ ...ctx(), fetchImpl: failing }, {});
    expect(r.ok).toBe(false);
    expect(r.content).not.toContain("kk");
  });
});
