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

  // lunch_visit 이 placeId 로 곧장 지정할 때 쓴다(설계 §6.1, forget 의 id 인자와 같은 자리) —
  // 이름이 완전히 같은 두 후보처럼 이름 검색으로는 절대 하나로 못 좁히는 경우의 유일한 출구다.
  it("place_id 로 정확히 하나를 찾는다", async () => {
    await repo.upsertPlaces([place("1", "국밥집", "음식점")], 1000);
    const found = await repo.findPlaceById("1");
    expect(found).not.toBeNull();
    expect(found!.name).toBe("국밥집");
    expect(found!.categoryGroup).toBe("음식점");
  });

  // 모르는 id 로 새 행을 만들지 않는다(설계 §2) — 호출측이 null 을 보고 "찾지 못했다" 고만
  // 답하게 한다.
  it("없는 place_id 는 null 이다", async () => {
    expect(await repo.findPlaceById("없음")).toBeNull();
  });

  // Item 2(리뷰) — findPlaceById 는 lunch_visit 의 placeId 인자가 기대는 유일한 탈출구다
  // (이름이 완전히 같은 두 후보를 가르는 것도 이 메서드뿐이다). 위의 두 테스트는 둘 다
  // id "1" 을 픽스처 한 행에만 대는 방식이라, WHERE place_id = $1 을
  // strpos(place_id, $1) > 0 같은 부분 문자열 일치로 바꿔도 구분이 안 된다 — "1" 과 "1001"
  // 을 함께 심어야 정확 일치와 부분 일치가 갈라진다. 이게 깨지면 placeId: "1" 로 부른
  // lunch_visit 이 실제로 "1001" 행에 방문을 기록하는, 지난 라운드에 닫았던 바로 그 사고가
  // 재발한다.
  it("findPlaceById 는 부분 문자열이 아니라 정확히 일치하는 place_id 만 찾는다", async () => {
    await repo.upsertPlaces([place("1", "국밥집"), place("1001", "다른가게")], 1000);
    const exact = await repo.findPlaceById("1");
    expect(exact).not.toBeNull();
    expect(exact!.placeId).toBe("1");
    expect(exact!.name).toBe("국밥집");
    // "100" 은 어느 place_id 와도 완전히 같지 않다 — "1001" 의 접두사일 뿐이다. 부분 문자열
    // 일치라면 여기서 "1001" 행이 걸린다.
    expect(await repo.findPlaceById("100")).toBeNull();
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

  // 최종 리뷰 Critical — category_group 은 카카오의 18개 고정 라벨(예: "음식점") 중 하나라
  // 모든 식당이 똑같은 값을 갖는다. "한식"/"일식"처럼 실제로 갈리는 세부 분류는
  // category(category_name, 예: "음식점 > 한식")에서 나온다(lunch/cuisine.ts 의
  // deriveCuisine). 옛 테스트는 place() 헬퍼의 세 번째 인자(categoryGroup)에 "한식"을 넣고
  // 있었는데, 그 필드는 프로덕션에서 "한식"이라는 값을 절대 가질 수 없다 — 이 파일의 다른
  // 테스트들(위 12·17·65·69행)이 같은 필드에 이미 "음식점"이라는 올바른 값을 쓰고 있는 것과
  // 스스로 모순됐다. category 와 categoryGroup 을 둘 다 실제 카카오 모양대로 채운다.
  it("최근에 먹은 카테고리(요리 종류)를 최신순으로 돌려준다", async () => {
    await repo.upsertPlaces([
      { placeId: "1", name: "국밥집", category: "음식점 > 한식", categoryGroup: "음식점" },
      { placeId: "2", name: "스시집", category: "음식점 > 일식", categoryGroup: "음식점" },
    ], 1000);
    await repo.recordVisit({ userId: "u1", placeId: "1", ts: 1000 });
    await repo.recordVisit({ userId: "u1", placeId: "2", ts: 2000 });
    expect(await repo.recentCuisines("u1", 0)).toEqual(["일식", "한식"]);
  });

  it("sinceTs 이전 방문은 최근 카테고리에서 빠진다", async () => {
    await repo.upsertPlaces([{ placeId: "1", name: "국밥집", category: "음식점 > 한식", categoryGroup: "음식점" }], 1000);
    await repo.recordVisit({ userId: "u1", placeId: "1", ts: 1000 });
    expect(await repo.recentCuisines("u1", 5000)).toEqual([]);
  });

  // 최종 리뷰 Critical(M2 "비식당 카테고리") — 카페·편의점 방문은 이 축이 막으려는 "같은
  // 요리 반복"의 대상이 아니다. category_group 이 "음식점"이 아니면(카페 방문 등)
  // deriveCuisine 이 undefined 를 돌려주므로, 그 방문은 목록에 아예 안 들어가야 한다 —
  // 들어가면 카페 방문이 엉뚱하게 한식 후보를 감점시킬 길이 열린다.
  it("음식점이 아닌 곳(카페 등)의 방문은 최근 카테고리에 들어가지 않는다", async () => {
    await repo.upsertPlaces([
      { placeId: "1", name: "동네카페", category: "음식점 > 카페 > 커피전문점", categoryGroup: "카페" },
    ], 1000);
    await repo.recordVisit({ userId: "u1", placeId: "1", ts: 1000 });
    expect(await repo.recentCuisines("u1", 0)).toEqual([]);
  });

  // 세부 분류가 없는 행(category 가 "음식점" 하나뿐이거나 아예 없음)도 목록에서 조용히
  // 빠져야 한다 — undefined 를 빈 문자열 같은 값으로 몰아넣어 서로 무관한 가게들을 같은
  // 카테고리로 묶으면 안 된다(cuisine.ts 의 "빈 문자열 버킷" 경고와 같은 이유).
  it("세부 분류를 알 수 없는 방문은 최근 카테고리에서 빠진다", async () => {
    await repo.upsertPlaces([
      { placeId: "1", name: "이름만아는집", category: "음식점", categoryGroup: "음식점" },
      { placeId: "2", name: "분류없는집", categoryGroup: "음식점" },
    ], 1000);
    await repo.recordVisit({ userId: "u1", placeId: "1", ts: 1000 });
    await repo.recordVisit({ userId: "u1", placeId: "2", ts: 1000 });
    expect(await repo.recentCuisines("u1", 0)).toEqual([]);
  });
});
