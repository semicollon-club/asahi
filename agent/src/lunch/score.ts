import { objectParticle } from "./korean.js";

// 추천 가중치. 이 파일에는 외부 의존이 하나도 없다 — API 응답도 DB 도 없이 이 기능의 핵심
// 판단을 테스트로 확정할 수 있는 유일한 부분이라 일부러 떼어 놓았다. objectParticle 을
// 가져오는 것은 이 원칙을 깨지 않는다 — 그 함수도 순수하고 외부 의존이 없다(lunch/korean.ts).
//
// 최종 리뷰 Critical — cuisine 필드는 옛 categoryGroup 을 대체한다. categoryGroup(카카오의
// category_group_name)은 "음식점" 같은 18개 고정 라벨 중 하나라 검색 결과 전부가 같은 값을
// 갖고, 그 값으로는 "한식이 사흘 연속 나왔다"를 절대 구분할 수 없었다(옛 축이 상수 오프셋에
// 불과했던 원인). cuisine 은 category_name 에서 뽑은 세부 분류(예: "한식")이고, 후보 쪽에서
// 어떻게 이 값을 만드는지는 이 파일의 관심사가 아니다 — lunch/cuisine.ts 의 deriveCuisine
// 하나를 core/lunch.ts(후보)와 store/lunchRepo.ts(이력) 양쪽이 그대로 가져다 써서, 두 값이
// 서로 다른 파싱으로 갈라져 다시는 비교 불가능해지지 않게 한다.
export type Candidate = { placeId: string; name: string; cuisine?: string; distanceM?: number };
export type History = { placeId: string; visits: number; lastVisitTs?: number; liked?: boolean };
export type Scored = { placeId: string; name: string; score: number; reasons: string[] };

const DAY_MS = 24 * 60 * 60 * 1000;

// 네 축을 곱셈이 아니라 **가산**으로 쌓는다(설계 §5). 곱셈은 한 축이 0 이면 나머지를 통째로
// 지워서 "왜 이게 추천됐나"를 설명할 수 없게 된다 — reasons 가 의미를 잃는다.
// 이 값들은 위 테스트의 기대값과 맞물려 있다. "100회가 10회의 두 배를 넘지 않는다" 테스트는
// 후보 하나에 visits 만 있는 히스토리 하나뿐이라 점수가 W.visitLog * log1p(visits) 항
// 하나로만 결정되고, 부등식 양변에 W.visitLog 가 똑같이 곱해져 약분된다 — 그러니 그
// 테스트가 실제로 고정하는 건 계수 크기가 아니라 log1p 의 모양뿐이다
// (log1p(100)/log1p(10) ≈ 1.9247 < 2, W 를 0.001~1000 으로 바꿔도 부등식은 안 깨진다).
// visitLog 를 실제로 제한하는 건 "최근에 간 곳은 방문이 많아도 밀린다" 다 — 거기서는
// visitLog 가 recentPenalty(-6)와 가산으로 경쟁한다(방문 5회·1일 전 vs 방문 2회·30일 전).
// 이 값이 4/ln2 ≈ 5.77 을 넘으면 역전된다 — visits=5 와 2 의 log1p 차(ln6-ln3)가 정확히
// ln2 라 경계가 그렇게 딱 떨어진다. 즉 visitLog 를 건드릴 땐 이 테스트를 볼 것.
const W = Object.freeze({
  visitLog: 2,        // 방문 횟수(로그)
  recentPenalty: -6,  // 3일 이내 재방문
  likedBonus: 4,
  // liked===false 인 곳은 아래 scoreCandidates 에서 방문 보너스 자체를 적용하지 않으므로,
  // 이 축과 항상 0 이하인 recentPenalty·categoryRepeat 만 남아 총점이 실제로 늘 음수다.
  dislikedPenalty: -10,
  categoryRepeat: -1.5, // 최근 먹은 카테고리 1회당
} as const);

export function scoreCandidates(
  candidates: Candidate[],
  history: Map<string, History>,
  o: { nowMs: number; recentCuisines?: string[] },
): Scored[] {
  const recent = o.recentCuisines ?? [];

  const scored = candidates.map((cand) => {
    const h = history.get(cand.placeId);
    const reasons: string[] = [];
    let score = 0;

    // liked===false 인 곳은 방문 보너스를 아예 적용하지 않는다. "몇 번 갔는지"는 좋아함의
    // 대리 지표일 뿐인데, 이미 "별로였다"는 명시적 평가가 있으면 그 대리 지표는 근거를
    // 잃는다(회사 근처라 어쩔 수 없이 자주 갔을 수도 있다) — 숫자가 아니라 의미의 문제다.
    // 이걸 안 끊으면 방문이 아주 많을 때(visits > e^5-1 ≈ 147.4, 즉 2*log1p(visits) > 10)
    // dislikedPenalty(-10) 를 뚫고 총점이 양수로 뒤집힌다 — reasons 는 "별로였다고
    // 하신 곳이에요" 라면서 순위는 위로 올라가는 모순이 실제로 났었다(148회 → +0.0079).
    if (h && h.visits > 0 && h.liked !== false) {
      const add = W.visitLog * Math.log1p(h.visits);
      score += add;
      reasons.push(`${h.visits}번 가보신 곳이에요.`);
    }

    // 어제 간 데를 오늘 또 추천하면 이 기능이 쓸모없다. 3일을 경계로 두고, 그 안이면
    // 가까울수록 크게 깎는다.
    if (h?.lastVisitTs !== undefined) {
      const days = (o.nowMs - h.lastVisitTs) / DAY_MS;
      if (days < 3) {
        score += W.recentPenalty * (1 - days / 3);
        reasons.push(days < 1 ? "오늘·어제 다녀오셨어요." : `${Math.floor(days)}일 전에 다녀오셨어요.`);
      }
    }

    // 명시적 평가는 추측(횟수)보다 세게 반영한다.
    if (h?.liked === true) {
      score += W.likedBonus;
      reasons.push("좋았다고 하신 곳이에요.");
    } else if (h?.liked === false) {
      score += W.dislikedPenalty;
      reasons.push("별로였다고 하신 곳이에요.");
    }

    // 최종 리뷰 Critical — cand.cuisine 은 category_name 에서 뽑은 세부 분류다(예: "한식").
    // recent 도 같은 함수(deriveCuisine)로 뽑은 값들이라 여기서 비교가 실제로 성립한다.
    if (cand.cuisine) {
      const n = recent.filter((g) => g === cand.cuisine).length;
      if (n > 0) {
        score += W.categoryRepeat * n;
        // 이 축은 감점이다. "최근에 한식을 3번 드셨어요"처럼 사실만 말하면 문장에서 방향
        // (+/-)이 드러나지 않아 오히려 긍정 신호("자주 먹을 만큼 좋아하나 보다")로 읽힐 수
        // 있다(리뷰 지적) — reasons 의 목적은 모델이 그대로 옮길 "참인 이유"를 주는 것이므로,
        // 실제로 일어난 일(감점 → 그래서 덜 추천됨)까지 문장에 넣어야 한다. 조사(을/를)는
        // 받침 유무로 갈린다 — "한식을"/"파스타를"처럼 값에 따라 문법이 달라지므로 하드코딩한
        // "을(를)" 대신 objectParticle 로 고른다(예전 문구는 값과 무관하게 비문이었다).
        reasons.push(`최근에 ${cand.cuisine}${objectParticle(cand.cuisine)} ${n}번 드셔서 이번엔 덜 추천했어요.`);
      }
    }

    // M4(최종 리뷰) — 위 네 축이 전부 침묵하면(방문 이력도 카테고리 반복도 없는 완전히 새
    // 후보) reasons 가 빈 채로 남아 "- 가게이름"처럼 이유 없는 벌거벗은 줄이 나갔다. persona
    // 의 LUNCH_LINE 은 "이유가 함께 오니 그대로 전하라"고 모델에게 지시하므로, 참인 이유가
    // 하나도 없으면 모델이 그럴듯한 이유를 지어낼 여지가 생긴다(IDENTITY 의 "## 사실성" 절이
    // 막으려는 바로 그것). distanceM 은 이미 Candidate 에 실려 있었지만(설계 §5 의 타입
    // 선언) 아무도 읽지 않는 죽은 필드였다 — 여기서만, 다른 이유가 전혀 없을 때만 거리를
    // 이유로 쓴다. 점수(score)에는 더하지 않는다 — 네 축의 가중치를 건드리지 않는다는 요구와
    // 맞물린다(거리는 순위를 바꾸지 않고, 그저 침묵을 참인 문장으로 채울 뿐이다). distanceM
    // 조차 없으면(카카오가 좌표 기반 검색에서도 이 필드를 비울 수 있다 — mapKakaoDocument 의
    // "필드 누락에도 안 깨지는가" 계약) reasons 는 정직하게 빈 채로 남는다 — 있지도 않은
    // 정보를 지어내 채우지 않는다.
    if (reasons.length === 0 && cand.distanceM !== undefined) {
      reasons.push(`${cand.distanceM}m 거리예요.`);
    }

    return { placeId: cand.placeId, name: cand.name, score, reasons };
  });

  // 동점이면 입력 순서를 유지한다(카카오가 이미 거리·정확도로 정렬해 준다).
  return scored
    .map((s, i) => ({ s, i }))
    .sort((a, b) => b.s.score - a.s.score || a.i - b.i)
    .map(({ s }) => s);
}
