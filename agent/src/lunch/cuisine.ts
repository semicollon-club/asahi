// "최근 카테고리 반복" 축(설계 §5, score.ts)이 실제로 비교하는 값을 뽑는다. 이 파일이 따로
// 있는 이유가 최종 리뷰 Critical 그 자체다 — 후보(오늘 검색된 곳, core/lunch.ts)와 이력(과거
// 방문한 곳, store/lunchRepo.ts) 양쪽이 각자 파싱을 하면, 한쪽만 고치거나 한쪽만 놓쳐도 두
// 값이 영원히 다른 문자열이 되어 축이 조용히 죽는다 — 정확히 지금 고치는 결함의 모양이다.
// 함수 하나만 두고 두 곳 다 그대로 가져다 쓴다.
//
// 카카오 응답에는 관련 필드가 둘 있다(설계 §2.1·§4).
// - category_group_name: 음식점·카페·편의점… 18개 **고정 라벨** 중 하나. 검색으로 돌아온
//   식당은 거의 전부 "음식점" 하나로 같아서, 이 필드로는 "한식이 사흘 연속 나왔다"를 절대
//   구분할 수 없다 — 이번에 고치는 버그가 바로 이 필드를 세부 분류인 것처럼 썼던 것이다.
// - category_name: "음식점 > 한식 > 국밥" 처럼 카카오의 더 오래되고 더 세분화된 분류 트리를
//   ">" 로 이어붙인 경로다. 세부 분류(요리 종류)는 여기, 두 번째 조각에 있다.
export type CategoryFields = { categoryGroup?: string; category?: string };

export function deriveCuisine(place: CategoryFields): string | undefined {
  // category_name 의 계층은 카카오의 자유 형식 표시용 경로라 첫 조각이 항상 "음식점"이라는
  // 보장이 없다(예: 카페가 이 트리에서 "음식점 > 카페 > 커피전문점"처럼 음식점 아래 얹혀
  // 나오는 경우가 실제로 있다) — 그래서 "진짜 식당인가"는 category_name 의 첫 조각이 아니라
  // category_group_name 에 맡긴다. 그 필드는 정확히 이 판정을 위한 18개 고정 라벨이다(§2.1).
  // 이 게이트가 없으면 카페·편의점 방문이 "한식" 후보를 감점시키는 사고가 날 수 있었다(최종
  // 리뷰 지적) — 카페의 세부 조각("커피전문점")이 우연히 "한식"과 안 겹쳐서 지금까지 안전한
  // 것과, 이 조건이 실제로 막아 주는 것은 다르다. 정보가 아예 없어도(undefined) 식당이라고
  // 확신할 근거가 없으므로 같은 값으로 처리한다 — 감점 없음 쪽이 안전한 기본값이다.
  if (place.categoryGroup?.trim() !== "음식점") return undefined;
  if (!place.category) return undefined;

  // "음식점 > 한식 > 국밥" → ["음식점","한식","국밥"], 세부 분류는 인덱스 1. "음식점 > 한식"
  // 처럼 세부까지만 있는 짧은 형태도 그대로 지원된다. "음식점" 하나뿐이면(세부 분류가 없으면)
  // undefined 다 — 빈 문자열로 접어 "세부를 알 수 없는 식당들"을 같은 카테고리로 묶으면, 서로
  // 무관한 그 식당들이 서로를 엉뚱하게 감점시킨다(최종 리뷰가 경고한 "빈 문자열 버킷").
  const segments = place.category.split(">").map((s) => s.trim());
  const cuisine = segments[1];
  return cuisine && cuisine.length > 0 ? cuisine : undefined;
}
