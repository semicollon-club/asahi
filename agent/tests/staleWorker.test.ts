import { describe, it, expect } from "vitest";
import { decideMissingAlerts, type SeenState } from "../src/core/staleWorker.js";

const MIN = 60_000;
const T = 15 * MIN;

// 2026-08-01: 워커가 13시간 반 사라져 있었는데 아무 알림도 안 왔다. 그때 함께 있던 낡음 판정
// (decideStaleAlerts)은 "붙어 있는" 워커만 훑어 봇 커밋과 비교했으므로, 워커가 통째로 없어지면
// 비교할 대상 자체가 없어 조용했다. 사라진 것이야말로 가장 먼저 알아야 할 상태인데 유일하게
// 안 알리던 상태였다.
//
// 2026-09-03: 그 낡음 판정은 제거됐다(대조할 수 없는 두 갈래의 커밋을 대조하고 있었다 —
// staleWorker.ts 머리말). 이제 워커 이상을 소유자에게 알리는 경로는 이것 하나뿐이라, 여기 있는
// 케이스들이 그 유일한 안전망을 지킨다.
describe("decideMissingAlerts", () => {
  it("붙어 있으면 알리지 않는다", () => {
    const seen: SeenState = new Map();
    const args = { connected: ["w"], seen, thresholdMs: T };
    expect(decideMissingAlerts({ ...args, now: 0 })).toEqual([]);
    expect(decideMissingAlerts({ ...args, now: 99 * MIN })).toEqual([]);
  });

  it("한 번도 본 적 없는 워커는 알리지 않는다(등록만 되고 안 쓰는 워커)", () => {
    // 이 봇 프로세스가 사는 동안 붙은 적 없는 워커는 "사라진" 것이 아니다. 이 구분이 없으면
    // owner-laptop 처럼 며칠째 안 붙는 워커 때문에 알림이 계속 울려 아무도 안 보게 된다.
    const seen: SeenState = new Map();
    expect(decideMissingAlerts({ connected: [], now: 99 * MIN, seen, thresholdMs: T })).toEqual([]);
  });

  it("끊긴 뒤 임계 미만이면 알리지 않는다(재시작·갱신 창)", () => {
    const seen: SeenState = new Map();
    decideMissingAlerts({ connected: ["w"], now: 0, seen, thresholdMs: T });
    expect(decideMissingAlerts({ connected: [], now: 14 * MIN, seen, thresholdMs: T })).toEqual([]);
  });

  it("끊긴 채 임계를 넘기면 한 번 알린다", () => {
    const seen: SeenState = new Map();
    decideMissingAlerts({ connected: ["w"], now: 0, seen, thresholdMs: T });
    const out = decideMissingAlerts({ connected: [], now: 16 * MIN, seen, thresholdMs: T });
    expect(out).toHaveLength(1);
    expect(out[0]).toContain("w");
  });

  it("같은 부재로 두 번 알리지 않는다", () => {
    const seen: SeenState = new Map();
    decideMissingAlerts({ connected: ["w"], now: 0, seen, thresholdMs: T });
    decideMissingAlerts({ connected: [], now: 16 * MIN, seen, thresholdMs: T });
    expect(decideMissingAlerts({ connected: [], now: 40 * MIN, seen, thresholdMs: T })).toEqual([]);
  });

  it("돌아오면 다시 알릴 수 있는 상태가 된다", () => {
    // 한 번 알리고 끝이면 두 번째 사고를 놓친다. 복귀가 셈을 되돌린다.
    const seen: SeenState = new Map();
    decideMissingAlerts({ connected: ["w"], now: 0, seen, thresholdMs: T });
    decideMissingAlerts({ connected: [], now: 16 * MIN, seen, thresholdMs: T });
    decideMissingAlerts({ connected: ["w"], now: 20 * MIN, seen, thresholdMs: T });
    const out = decideMissingAlerts({ connected: [], now: 40 * MIN, seen, thresholdMs: T });
    expect(out).toHaveLength(1);
  });
});
