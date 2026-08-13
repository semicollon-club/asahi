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

  // 빈 문자열/공백뿐인 이름을 그대로 넘기면 테이블 전체가 걸린다 — lunch_places 는 검색할
  // 때마다 쌓이는 표라 캐시처럼 작지 않고(설계 §4), 그 전부를 디스코드 메시지 하나(2000자
  // 한도)에 욱여넣게 된다(§6.1 "여러 개" 분기).
  it("빈 문자열이나 공백뿐인 이름으로는 찾지 않는다", async () => {
    await repo.upsertPlaces([place("1", "국밥집"), place("2", "김밥나라")], 1000);
    expect(await repo.findPlacesByName("")).toEqual([]);
    expect(await repo.findPlacesByName("   ")).toEqual([]);
  });

  it("검색어 앞뒤 공백을 트림해서 찾는다", async () => {
    await repo.upsertPlaces([place("1", "국밥집")], 1000);
    expect((await repo.findPlacesByName("국밥집 ")).length).toBe(1);
  });

  // forget 의 선례를 그대로 따른다(설계 §6.1) — 대소문자 무시. 카카오 장소명은
  // CU·GS25·Starbucks 처럼 라틴 문자를 흔히 섞어 쓴다.
  it("대소문자를 가리지 않고 찾는다", async () => {
    await repo.upsertPlaces([place("1", "Starbucks 청운대점")], 1000);
    expect((await repo.findPlacesByName("star")).length).toBe(1);
    expect((await repo.findPlacesByName("STAR")).length).toBe(1);
  });

  it("이름 검색 결과가 무한정 늘지 않는다", async () => {
    const many = Array.from({ length: 60 }, (_, i) => place(String(i), `테스트가게${i}`));
    await repo.upsertPlaces(many, 1000);
    expect((await repo.findPlacesByName("테스트가게")).length).toBeLessThanOrEqual(50);
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

  // NULL 은 "평가 안 함"이지 새 판단이 아니다(설계 §4) — 가장 최근 방문에 평가가 없다고
  // 예전의 명시적 판단이 사라지면 안 된다. 사라지면 score.ts 의 liked!==false 게이트가 안
  // 걸려 dislikedPenalty(-10)가 빠지고 방문 보너스(+visitLog)가 되살아난다(score.ts 44~48행).
  it("가장 최근 방문에 평가가 없어도 그 전의 liked:false 가 사라지지 않는다", async () => {
    await repo.upsertPlaces([place("1", "국밥집")], 1000);
    await repo.recordVisit({ userId: "u1", placeId: "1", ts: 1000, liked: false });
    await repo.recordVisit({ userId: "u1", placeId: "1", ts: 9000 }); // 평가 없이 재방문
    const h = await repo.historyOf("u1");
    expect(h.get("1")!.liked).toBe(false);
    expect(h.get("1")!.visits).toBe(2);
    expect(h.get("1")!.lastVisitTs).toBe(9000);
  });

  it("liked:true 도 같은 방식으로 평가 없는 재방문에 사라지지 않는다", async () => {
    await repo.upsertPlaces([place("1", "국밥집")], 1000);
    await repo.recordVisit({ userId: "u1", placeId: "1", ts: 1000, liked: true });
    await repo.recordVisit({ userId: "u1", placeId: "1", ts: 9000 });
    expect((await repo.historyOf("u1")).get("1")!.liked).toBe(true);
  });

  // ts 가 같으면 Postgres 는 순서를 보장하지 않는다. 디스코드 버튼을 두 번 누르면 같은
  // 밀리초에 두 행이 들어갈 수 있고, 그때 어느 liked 를 쓸지가 정렬에 달린다 — id DESC 가
  // 그 전순서를 만든다. 이 테스트가 없으면 나중에 id DESC 를 지워도 아무것도 안 깨진다.
  it("같은 ts 에 기록된 두 방문은 나중에 들어온 쪽의 liked 를 쓴다", async () => {
    await repo.upsertPlaces([place("1", "국밥집")], 1000);
    await repo.recordVisit({ userId: "u1", placeId: "1", ts: 5000, liked: true });
    await repo.recordVisit({ userId: "u1", placeId: "1", ts: 5000, liked: false });
    expect((await repo.historyOf("u1")).get("1")!.liked).toBe(false);
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
