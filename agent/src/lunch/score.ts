// 추천 가중치. 이 파일에는 외부 의존이 하나도 없다 — API 응답도 DB 도 없이 이 기능의 핵심
// 판단을 테스트로 확정할 수 있는 유일한 부분이라 일부러 떼어 놓았다.
export type Candidate = { placeId: string; name: string; categoryGroup?: string; distanceM?: number };
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
  o: { nowMs: number; recentCategoryGroups?: string[] },
): Scored[] {
  const recent = o.recentCategoryGroups ?? [];

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
