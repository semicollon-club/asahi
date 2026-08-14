import { describe, it, expect } from "vitest";
import { scoreCandidates, type Candidate, type History } from "../src/lunch/score.js";

const NOW = 1_700_000_000_000;
const DAY = 24 * 60 * 60 * 1000;
const c = (placeId: string, extra: Partial<Candidate> = {}): Candidate =>
  ({ placeId, name: `가게${placeId}`, ...extra });
const hist = (rows: History[]) => new Map(rows.map((h) => [h.placeId, h]));

describe("scoreCandidates", () => {
  it("기록이 없으면 후보를 그대로 돌려주고 점수가 모두 같다", () => {
    const r = scoreCandidates([c("a"), c("b")], hist([]), { nowMs: NOW });
    expect(r.map((x) => x.placeId).sort()).toEqual(["a", "b"]);
    expect(r[0].score).toBe(r[1].score);
  });

  // 자주 간 곳 = 좋아하는 곳. 기대 승자("a")를 입력 배열 첫 자리가 아니라 둘째 자리에 둔다 —
  // 첫 자리에 두면 방문 채점 블록을 통째로 꺼도(둘 다 0점 동점) 안정 정렬이 입력 순서를
  // 그대로 유지해서 이 테스트가 우연히 통과해 버린다(실제로 블록을 꺼서 확인함). 아래
  // "최근에 간 곳은…", "최근에 먹은 카테고리는…", "점수 내림차순으로…" 세 테스트도 같은
  // 이유로 기대 승자를 입력 배열 첫 자리에 두지 않는다.
  it("방문이 많을수록 점수가 높다", () => {
    const r = scoreCandidates(
      [c("b"), c("a")],
      hist([{ placeId: "b", visits: 1 }, { placeId: "a", visits: 5 }]),
      { nowMs: NOW },
    );
    expect(r[0].placeId).toBe("a");
  });

  // 선형이면 한 곳이 목록을 독점한다 — 로그로 눌러 둔다.
  it("방문 가산은 로그라 횟수 차이만큼 벌어지지 않는다", () => {
    const [big] = scoreCandidates([c("a")], hist([{ placeId: "a", visits: 100 }]), { nowMs: NOW });
    const [small] = scoreCandidates([c("a")], hist([{ placeId: "a", visits: 10 }]), { nowMs: NOW });
    expect(big.score).toBeGreaterThan(small.score);
    expect(big.score).toBeLessThan(small.score * 2);
  });

  // 어제 간 데를 오늘 또 추천하면 이 기능이 쓸모없다.
  it("최근에 간 곳은 방문이 많아도 밀린다", () => {
    const r = scoreCandidates(
      [c("a"), c("b")],
      hist([
        { placeId: "a", visits: 5, lastVisitTs: NOW - DAY },
        { placeId: "b", visits: 2, lastVisitTs: NOW - 30 * DAY },
      ]),
      { nowMs: NOW },
    );
    expect(r[0].placeId).toBe("b");
  });

  it("liked=true 는 올리고 false 는 사실상 제외한다", () => {
    const r = scoreCandidates(
      [c("a"), c("b"), c("d")],
      hist([
        { placeId: "a", visits: 1, liked: true },
        { placeId: "b", visits: 1 },
        { placeId: "d", visits: 1, liked: false },
      ]),
      { nowMs: NOW },
    );
    expect(r.map((x) => x.placeId)).toEqual(["a", "b", "d"]);
    expect(r[2].score).toBeLessThan(0);
  });

  // 방문 보너스를 안 끊으면 방문이 아주 많을 때(200회 → 2*log1p(200)-10 ≈ +0.6067) 리뷰어가
  // 실측으로 확인한 대로 dislikedPenalty(-10) 를 뚫고 총점이 양수로 뒤집힌다 — reasons 는
  // "별로였다고 하신 곳이에요" 인데 순위는 위로 올라가는 모순이었다. 문턱은 148회
  // (e^5-1≈147.4, 즉 2*log1p(visits)>10)라서 200회로 넉넉히 넘겨 고정한다. score 를
  // dislikedPenalty 값 그대로(-10)로 확인해 방문 보너스가 부분적으로도 안 붙는다는 것까지
  // 못박는다 — "음수이기만 하면 된다"면 보너스를 절반만 깎는 식의 회귀도 통과해 버린다.
  it("liked=false 는 방문이 아주 많아도 점수가 음수로 남는다", () => {
    const [r] = scoreCandidates(
      [c("a")],
      hist([{ placeId: "a", visits: 200, liked: false }]),
      { nowMs: NOW },
    );
    expect(r.score).toBeLessThan(0);
    expect(r.score).toBe(-10);
  });

  // 한식만 사흘 연속 나오는 것을 막는다.
  //
  // 최종 리뷰 Critical — 이 값들은 카카오의 category_group_name 이 아니라 category_name 에서
  // 뽑은 세부 분류(cuisine.ts 의 deriveCuisine)를 가리킨다. 옛 테스트는 "한식"/"일식" 을
  // Candidate.categoryGroup 필드에 넣었는데, 프로덕션에서 category_group_name 은 "음식점" 같은
  // 18개 고정 라벨만 될 수 있어 "한식"이라는 값 자체를 절대 가질 수 없었다 — 즉 이 테스트는
  // 통과하면서도 실제로는 절대 일어날 수 없는 입력을 검증하고 있었다. Candidate.cuisine 으로
  // 필드를 바꾼 뒤에는 "한식"이 그 필드에 실제로 들어갈 수 있는 값이 된다.
  it("최근에 먹은 카테고리(요리 종류)는 감점된다", () => {
    const r = scoreCandidates(
      [c("a", { cuisine: "한식" }), c("b", { cuisine: "일식" })],
      hist([]),
      { nowMs: NOW, recentCuisines: ["한식", "한식"] },
    );
    expect(r[0].placeId).toBe("b");
  });

  // 모델이 추천 이유를 지어내지 않고 그대로 옮길 수 있어야 한다(설계 §5).
  it("점수를 움직인 축마다 reasons 에 한 줄이 남는다", () => {
    const [r] = scoreCandidates(
      [c("a", { cuisine: "한식" })],
      hist([{ placeId: "a", visits: 3, lastVisitTs: NOW - DAY, liked: true }]),
      { nowMs: NOW, recentCuisines: ["한식"] },
    );
    expect(r.reasons.length).toBe(4);
    expect(r.reasons.join(" ")).toContain("3번");
  });

  // 최종 리뷰 Critical — "최근에 음식점을(를) 1번 드셨어요"는 값과 무관하게 비문이었다(을/를은
  // 받침 유무로 갈린다). 받침 있는 값과 받침 없는 값을 각각 확인해 조사가 실제로 맞는지
  // 못박는다 — objectParticle 자체의 단위 테스트(lunchKorean.test.ts)와 별개로, score.ts 가
  // 그 함수를 실제로 불러 문장에 끼워 넣는지까지 여기서 확인한다.
  it("카테고리 반복 문장의 조사가 받침 유무에 맞게 갈린다(을/를)", () => {
    const [withBatchim] = scoreCandidates(
      [c("a", { cuisine: "한식" })], // "식" 받침 있음 → 을
      hist([]),
      { nowMs: NOW, recentCuisines: ["한식"] },
    );
    expect(withBatchim.reasons.join(" ")).toContain("한식을");
    expect(withBatchim.reasons.join(" ")).not.toContain("한식를");

    const [noBatchim] = scoreCandidates(
      [c("a", { cuisine: "파스타" })], // "타" 받침 없음 → 를
      hist([]),
      { nowMs: NOW, recentCuisines: ["파스타"] },
    );
    expect(noBatchim.reasons.join(" ")).toContain("파스타를");
    expect(noBatchim.reasons.join(" ")).not.toContain("파스타을");
  });

  // 카테고리 반복은 감점이다 — "최근에 한식을 3번 드셨어요"처럼 사실만 말하면 문장에서 방향
  // (+/-)이 드러나지 않아 오히려 긍정 신호로 읽힐 수 있다(리뷰 지적: reasons 의 목적은 모델이
  // 옮길 "참인 이유"를 주는 것인데, 감점을 중립적 사실처럼 말하면 정확하지 않다). "그래서 이번엔
  // 덜 추천했다"까지 문장에 넣어야 실제로 일어난 일(감점)과 일치한다.
  it("카테고리 반복 문장은 감점이라는 방향을 문장 자체에 명시한다", () => {
    const [r] = scoreCandidates([c("a", { cuisine: "한식" })], hist([]), { nowMs: NOW, recentCuisines: ["한식"] });
    expect(r.reasons.join(" ")).toContain("덜 추천");
  });

  // M4(최종 리뷰) — 다른 세 축이 전부 침묵하면(방문 이력도 카테고리 반복도 없는 완전히 새
  // 후보) reasons 가 빈 채로 남아 "- 가게이름" 처럼 이유 없는 벌거벗은 줄이 나갔다. persona 의
  // LUNCH_LINE 은 "이유가 함께 오니 그대로 전하라"고 모델에게 지시하므로, 이유가 없으면 모델이
  // 지어낼 여지가 생긴다. distanceM 은 이미 Candidate 에 실려 있었지만(설계 §5 의 타입 선언)
  // 아무도 읽지 않는 죽은 필드였다 — 다른 이유가 전혀 없을 때만 거리를 이유로 쓴다(점수에는
  // 반영하지 않는다 — 축 네 개의 가중치를 건드리지 않는다는 요구와 맞물린다).
  it("다른 이유가 전혀 없으면 거리를 이유로 준다(M4) — 점수 자체는 건드리지 않는다", () => {
    const [withReason] = scoreCandidates([c("a", { distanceM: 250 })], hist([]), { nowMs: NOW });
    expect(withReason.reasons).toEqual(["250m 거리예요."]);
    expect(withReason.score).toBe(0); // 거리는 이유일 뿐 점수를 움직이지 않는다.

    const [withoutDistance] = scoreCandidates([c("a")], hist([]), { nowMs: NOW });
    expect(withoutDistance.reasons).toEqual([]); // distanceM 조차 없으면 정직하게 빈 채로 둔다.
  });

  // M4 — 다른 축이 이미 이유를 냈으면 거리는 덧붙이지 않는다(reasons 가 너무 길어지는 것을
  // 막는다 — 이미 참인 이유가 있으므로 거리까지 낼 필요가 없다).
  it("다른 축이 이미 이유를 냈으면 거리를 추가로 붙이지 않는다(M4)", () => {
    const [r] = scoreCandidates(
      [c("a", { distanceM: 250 })],
      hist([{ placeId: "a", visits: 1 }]),
      { nowMs: NOW },
    );
    expect(r.reasons).toEqual(["1번 가보신 곳이에요."]);
  });

  it("점수 내림차순으로 정렬해 돌려준다", () => {
    const r = scoreCandidates(
      [c("a"), c("b"), c("d")],
      hist([{ placeId: "b", visits: 9 }, { placeId: "d", visits: 4 }]),
      { nowMs: NOW },
    );
    expect(r.map((x) => x.placeId)).toEqual(["b", "d", "a"]);
  });

  // M5(최종 리뷰) — 동점일 때의 입력 순서 유지(:84~88 의 `a.i - b.i`)는 카카오가 이미
  // 거리·정확도로 정렬해 준 순서를 그대로 지키기 위한 것이다(주석 참고). 그런데
  // `b.i - a.i`로 뒤집어도(즉 "가장 가까운 순"이 "가장 먼 순"으로 뒤집혀도) 지금까지의
  // 모든 테스트가 통과했다 — 위쪽 "기록이 없으면…" 테스트를 비롯해 이 파일의 여러 테스트가
  // 결과를 정렬(.sort())하거나 승자만 확인한 뒤 비교해서, 순서 자체를 그대로 고정하지
  // 못했기 때문이다. 신규 사용자는 모든 후보의 점수가 0으로 같으므로, 이 비교자 하나가 사실상
  // 전체 추천 순서다 — 뒤집히면 "가장 가까운 세 곳"이 조용히 "가장 먼 세 곳"이 된다. 여기서는
  // 반환값을 정렬하거나 승자만 뽑지 않고 배열 전체를 입력 순서 그대로 비교한다.
  it("점수가 같으면 입력 순서(카카오 응답 순서=거리순)를 그대로 유지한다", () => {
    const r = scoreCandidates([c("a"), c("b"), c("d")], hist([]), { nowMs: NOW });
    expect(r.map((x) => x.placeId)).toEqual(["a", "b", "d"]);
  });
});
