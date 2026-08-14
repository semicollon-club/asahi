import { describe, it, expect } from "vitest";
import { deriveCuisine } from "../src/lunch/cuisine.js";

// 최종 리뷰 Critical — "최근 카테고리 반복" 축이 실제로 비교하는 값을 만드는 곳. 카카오의
// category_group_name 은 18개 고정 라벨(음식점·카페·편의점…) 중 하나라 검색으로 돌아온
// 식당은 거의 전부 "음식점" 하나로 같다 — 그 필드로는 "한식이 사흘 연속 나왔다"를 절대 구분할
// 수 없다. 세부 분류는 category_name(예: "음식점 > 한식 > 국밥")에 있다. 후보(오늘 검색된
// 곳)와 이력(과거 방문한 곳) 양쪽이 이 함수 하나를 그대로 가져다 써야, 한쪽만 고치거나 한쪽만
// 파싱을 놓쳐 두 값이 영원히 다른 문자열이 되는 재발을 막을 수 있다.
describe("deriveCuisine", () => {
  it("음식점 > 세부 > 하위세부 형태에서 세부(두 번째 조각)를 뽑는다", () => {
    expect(deriveCuisine({ categoryGroup: "음식점", category: "음식점 > 한식 > 국밥" })).toBe("한식");
  });

  it("세부까지만 있는 짧은 형태도 지원한다", () => {
    expect(deriveCuisine({ categoryGroup: "음식점", category: "음식점 > 한식" })).toBe("한식");
  });

  it("세부 분류가 없으면(그룹 하나뿐이면) undefined 다 — 빈 문자열 버킷으로 몰지 않는다", () => {
    expect(deriveCuisine({ categoryGroup: "음식점", category: "음식점" })).toBeUndefined();
  });

  // category_name 의 계층은 카카오의 자유 형식이라 "음식점"으로 시작하는지만으로는 진짜
  // 식당인지 가려낼 수 없다(카페가 이 트리에서 음식점 아래 얹혀 나오는 경우가 실제로 있다).
  // category_group_name 은 정확히 이 판정을 위한 18개 고정 라벨이므로(설계 §2.1), "진짜
  // 식당인가"는 이 필드에 맡긴다 — category_name 의 세부값을 읽는 것과는 다른 필드, 다른
  // 책임이다. 이 게이트가 없으면 카페·편의점 방문이 한식 후보를 감점시키는 사고가 날 수
  // 있었다(리뷰 지적) — 지금은 문자열이 안 겹쳐서 우연히 안전한 게 아니라 이 조건이 막는다.
  it("음식점 그룹이 아니면(카페·편의점 등) category_name 이 있어도 undefined 다", () => {
    expect(deriveCuisine({ categoryGroup: "카페", category: "음식점 > 카페 > 커피전문점" })).toBeUndefined();
    expect(deriveCuisine({ categoryGroup: "편의점", category: "가정,생활 > 편의점 > CU" })).toBeUndefined();
  });

  it("categoryGroup 이 없으면(식당인지 확인할 근거가 없으면) undefined 다", () => {
    expect(deriveCuisine({ category: "음식점 > 한식" })).toBeUndefined();
  });

  it("category 자체가 없으면 undefined 다", () => {
    expect(deriveCuisine({ categoryGroup: "음식점" })).toBeUndefined();
  });

  it("조각 사이 공백은 트림한다", () => {
    expect(deriveCuisine({ categoryGroup: "음식점", category: "음식점  >   한식   > 국밥" })).toBe("한식");
  });

  it("가운데 조각이 빈 문자열이면(구분자가 연속되는 등 기형 데이터) undefined 다", () => {
    expect(deriveCuisine({ categoryGroup: "음식점", category: "음식점 >  > 국밥" })).toBeUndefined();
  });
});
