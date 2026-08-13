// 추천 가중치. 이 파일에는 외부 의존이 하나도 없다 — API 응답도 DB 도 없이 이 기능의 핵심
// 판단을 테스트로 확정할 수 있는 유일한 부분이라 일부러 떼어 놓았다.
export type Candidate = { placeId: string; name: string; categoryGroup?: string; distanceM?: number };
export type History = { placeId: string; visits: number; lastVisitTs?: number; liked?: boolean };
export type Scored = { placeId: string; name: string; score: number; reasons: string[] };

const DAY_MS = 24 * 60 * 60 * 1000;

// 네 축을 곱셈이 아니라 **가산**으로 쌓는다(설계 §5). 곱셈은 한 축이 0 이면 나머지를 통째로
// 지워서 "왜 이게 추천됐나"를 설명할 수 없게 된다 — reasons 가 의미를 잃는다.
// 이 값들은 위 테스트의 기대값과 맞물려 있다(계획 작성 시 검산했다). 특히 visitLog 는
// "100회가 10회의 두 배를 넘지 않는다" 를 9.23 vs 9.59 로 아슬아슬하게 만족한다 — 이 값을
// 올리면 그 테스트가 깨진다. 깨지면 상수가 아니라 그 테스트의 의도(한 곳이 목록을 독점하지
// 않는다)를 먼저 보고 판단할 것.
const W = Object.freeze({
  visitLog: 2,        // 방문 횟수(로그)
  recentPenalty: -6,  // 3일 이내 재방문
  likedBonus: 4,
  dislikedPenalty: -10, // 사실상 제외 — 다른 축을 다 더해도 음수로 남는다
  categoryRepeat: -1.5, // 최근 먹은 카테고리 1회당
} as const);

export function scoreCandidates(
  candidates: Candidate[],
  history: Map<string, History>,
  o: { nowMs: number; recentCategoryGroups?: string[] },
): Scored[] {
  const recent = o.recentCategoryGroups ?? [];

  const scored = candidates.map((cand) => {
    const h = history.get(cand.placeId);
    const reasons: string[] = [];
    let score = 0;

    if (h && h.visits > 0) {
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

    if (cand.categoryGroup) {
      const n = recent.filter((g) => g === cand.categoryGroup).length;
      if (n > 0) {
        score += W.categoryRepeat * n;
        reasons.push(`최근에 ${cand.categoryGroup}을(를) ${n}번 드셨어요.`);
      }
    }

    return { placeId: cand.placeId, name: cand.name, score, reasons };
  });

  // 동점이면 입력 순서를 유지한다(카카오가 이미 거리·정확도로 정렬해 준다).
  return scored
    .map((s, i) => ({ s, i }))
    .sort((a, b) => b.s.score - a.s.score || a.i - b.i)
    .map(({ s }) => s);
}
