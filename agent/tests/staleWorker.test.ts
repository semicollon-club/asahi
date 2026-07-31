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

  it("워커 커밋을 모르면 판정하지 않는다(옛 워커)", () => {
    const state: StaleState = new Map();
    const out = decideStaleAlerts({ workers: [{ workerId: "w", commit: undefined }], botCommit: "new", now: 99 * MIN, state, thresholdMs: T });
    expect(out).toEqual([]);
  });
});
