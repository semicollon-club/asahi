import { describe, it, expect } from "vitest";
import { planShutdown, EXIT_CODE_UPDATE } from "../src/remote/workerShutdown.js";

describe("planShutdown — 종료 경로", () => {
  it("사람이 멈추면 소켓을 먼저 닫고 0 으로 끝낸다", async () => {
    const order: string[] = [];
    const code = await planShutdown({
      reason: "signal",
      stopSocket: () => { order.push("stop"); },
      idle: async () => { order.push("idle"); },
      idleTimeoutMs: 1000,
    });
    expect(order).toEqual(["stop", "idle"]);
    expect(code).toBe(0);
  });

  it("갱신이면 한가해질 때까지 기다린 뒤 소켓을 닫고 0 이 아닌 코드로 끝낸다", async () => {
    // 순서가 뒤집히면 진행 중이던 호출의 결과가 허브에 못 돌아간다 — 부원이 시킨 작업이
    // 조용히 실패한다. "한가할 때 갱신한다"가 참이 되려면 idle 이 먼저다.
    const order: string[] = [];
    const code = await planShutdown({
      reason: "update",
      stopSocket: () => { order.push("stop"); },
      idle: async () => { order.push("idle"); },
      idleTimeoutMs: 1000,
    });
    expect(order).toEqual(["idle", "stop"]);
    expect(code).toBe(EXIT_CODE_UPDATE);
    expect(EXIT_CODE_UPDATE).not.toBe(0);
  });

  it("갱신인데 오래 안 한가해지면 기다림을 포기하고 그래도 끝낸다", async () => {
    // 상한이 없으면 120초짜리 sh_exec 하나가 갱신을 영원히 막는다.
    const order: string[] = [];
    const code = await planShutdown({
      reason: "update",
      stopSocket: () => { order.push("stop"); },
      idle: () => new Promise<void>(() => {}), // 영원히 안 끝난다
      idleTimeoutMs: 10,
    });
    expect(order).toEqual(["stop"]);
    expect(code).toBe(EXIT_CODE_UPDATE);
  });
});
