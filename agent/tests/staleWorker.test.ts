import { describe, it, expect } from "vitest";
import { decideStaleAlerts, type StaleState } from "../src/core/staleWorker.js";

const MIN = 60_000;
const T = 15 * MIN;

describe("decideStaleAlerts", () => {
  it("불일치가 임계 미만이면 알리지 않는다(정상 배포 창)", () => {
    const state: StaleState = new Map();
    const args = { workers: [{ workerId: "w", commit: "old" }], botCommit: "new", now: 0, state, thresholdMs: T };
    expect(decideStaleAlerts(args)).toEqual([]);
    expect(decideStaleAlerts({ ...args, now: 14 * MIN })).toEqual([]);
  });

  it("임계를 넘기면 한 번 알린다", () => {
    const state: StaleState = new Map();
    const args = { workers: [{ workerId: "w", commit: "old" }], botCommit: "new", state, thresholdMs: T };
    decideStaleAlerts({ ...args, now: 0 });
    const out = decideStaleAlerts({ ...args, now: 16 * MIN });
    expect(out).toHaveLength(1);
    expect(out[0]).toContain("w");
  });

  it("같은 조합으로 두 번 알리지 않는다", () => {
    const state: StaleState = new Map();
    const args = { workers: [{ workerId: "w", commit: "old" }], botCommit: "new", state, thresholdMs: T };
    decideStaleAlerts({ ...args, now: 0 });
    decideStaleAlerts({ ...args, now: 16 * MIN });
    expect(decideStaleAlerts({ ...args, now: 30 * MIN })).toEqual([]);
  });

  it("일치하면 알리지 않고 그 조합의 기록을 지운다", () => {
    const state: StaleState = new Map();
    decideStaleAlerts({ workers: [{ workerId: "w", commit: "old" }], botCommit: "new", now: 0, state, thresholdMs: T });
    expect(state.size).toBe(1);
    decideStaleAlerts({ workers: [{ workerId: "w", commit: "new" }], botCommit: "new", now: MIN, state, thresholdMs: T });
    expect(state.size).toBe(0);
  });

  it("봇 커밋을 모르면 아무 판정도 하지 않는다", () => {
    const state: StaleState = new Map();
    const out = decideStaleAlerts({ workers: [{ workerId: "w", commit: "old" }], botCommit: undefined, now: 99 * MIN, state, thresholdMs: T });
    expect(out).toEqual([]);
    expect(state.size).toBe(0);
  });

  // 첫 호출만 부르면 이 테스트는 가드가 없어도 통과한다 — decideStaleAlerts 는 어떤 조합이든
  // 처음 관측할 때는 기록만 하고 [] 를 돌려주기 때문이다(위 "임계를 넘기면 한 번 알린다" 참고).
  // 가드(`if (w.commit === undefined) continue`)가 실제로 하는 일은 "시간이 아무리 지나도
  // 커밋 모르는 워커는 알리지 않는다"이므로, 임계를 넘긴 두 번째 호출까지 이어서 확인해야
  // 가드를 지켰다고 말할 수 있다. 가드를 지우면 이 두 번째 호출이 "낡았다" 분기를 타 알림
  // 문구를 만들려다 `w.commit.slice(0, 7)` 에서 TypeError 로 죽는다(undefined 에는 slice 가
  // 없다) — 잘못된 알림이 아니라 예외로 죽는다는 것이 이 가드가 막는 실제 실패 모드다.
  it("워커 커밋을 모르면 판정하지 않는다(옛 워커) — 시간이 지나도 알리지 않는다", () => {
    const state: StaleState = new Map();
    const args = { workers: [{ workerId: "w", commit: undefined }], botCommit: "new", state, thresholdMs: T };
    const first = decideStaleAlerts({ ...args, now: 99 * MIN });
    expect(first).toEqual([]);
    const second = decideStaleAlerts({ ...args, now: 99 * MIN + T + MIN });
    expect(second).toEqual([]);
    expect(state.size).toBe(0);
  });
});
