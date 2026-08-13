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

  // 자주 간 곳 = 좋아하는 곳.
  it("방문이 많을수록 점수가 높다", () => {
    const r = scoreCandidates(
      [c("a"), c("b")],
      hist([{ placeId: "a", visits: 5 }, { placeId: "b", visits: 1 }]),
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

  // 한식만 사흘 연속 나오는 것을 막는다.
  it("최근에 먹은 카테고리는 감점된다", () => {
    const r = scoreCandidates(
      [c("a", { categoryGroup: "한식" }), c("b", { categoryGroup: "일식" })],
      hist([]),
      { nowMs: NOW, recentCategoryGroups: ["한식", "한식"] },
    );
    expect(r[0].placeId).toBe("b");
  });

  // 모델이 추천 이유를 지어내지 않고 그대로 옮길 수 있어야 한다(설계 §5).
  it("점수를 움직인 축마다 reasons 에 한 줄이 남는다", () => {
    const [r] = scoreCandidates(
      [c("a", { categoryGroup: "한식" })],
      hist([{ placeId: "a", visits: 3, lastVisitTs: NOW - DAY, liked: true }]),
      { nowMs: NOW, recentCategoryGroups: ["한식"] },
    );
    expect(r.reasons.length).toBe(4);
    expect(r.reasons.join(" ")).toContain("3번");
  });

  it("점수 내림차순으로 정렬해 돌려준다", () => {
    const r = scoreCandidates(
      [c("a"), c("b"), c("d")],
      hist([{ placeId: "b", visits: 9 }, { placeId: "d", visits: 4 }]),
      { nowMs: NOW },
    );
    expect(r.map((x) => x.placeId)).toEqual(["b", "d", "a"]);
  });
});
