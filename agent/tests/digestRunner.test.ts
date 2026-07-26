import { describe, it, expect, beforeEach } from "vitest";
import { openTestDb } from "../src/store/db.js";
import { SettingsRepo } from "../src/store/settingsRepo.js";
import { EventBus } from "../src/events/bus.js";
import { DigestRunner } from "../src/core/digest.js";
import type { AgentEvent } from "../src/events/bus.js";

const utc = (iso: string) => Date.parse(iso);
const AFTER_SEVEN = utc("2026-07-27T03:00:00Z"); // KST 7/27 12:00
const BEFORE_SEVEN = utc("2026-07-26T21:00:00Z"); // KST 7/27 06:00

async function make(over: Partial<{
  result: { text: string; ok: boolean };
  now: number;
  channels: Record<string, string>;
}> = {}) {
  const db = await openTestDb();
  const settings = new SettingsRepo(db);
  const bus = new EventBus();
  const sent: AgentEvent[] = [];
  bus.subscribe("assistant_message", (e) => sent.push(e));
  const prompts: string[] = [];
  const runner = new DigestRunner({
    runTurn: async (req) => {
      prompts.push(req.prompt);
      const r = over.result ?? { text: "오늘의 소식", ok: true };
      return { text: r.text, ok: r.ok, sessionId: "s" };
    },
    bus,
    settings,
    agentCwd: "/tmp",
    channels: (over.channels ?? { contest: "C1", devnews: "C2" }) as any,
    now: () => over.now ?? AFTER_SEVEN,
  });
  return { runner, settings, sent, prompts };
}

describe("DigestRunner.run — 즉시 실행", () => {
  it("결과를 지정한 채널로 발행한다", async () => {
    const { runner, sent } = await make();
    await runner.run("contest", "C99");
    expect(sent).toHaveLength(1);
    expect(sent[0].channelRef).toBe("C99");
    expect((sent[0] as any).text).toContain("오늘의 소식");
  });

  it("lastRun 기록을 남기지 않는다(스케줄에 영향 없음)", async () => {
    const { runner, settings } = await make();
    await runner.run("contest", "C99");
    expect(await settings.get("digest.lastRun.contest")).toBeNull();
  });

  it("조사 프롬프트에 그 주제의 지시가 들어간다", async () => {
    const { runner, prompts } = await make();
    await runner.run("contest", "C99");
    expect(prompts[0]).toContain("CTF");
  });

  it("턴이 실패하면 지어내지 않고 짧게 알린다", async () => {
    const { runner, sent } = await make({ result: { text: "", ok: false } });
    await runner.run("contest", "C99");
    expect(sent).toHaveLength(1);
    expect((sent[0] as any).text.length).toBeGreaterThan(0);
    expect((sent[0] as any).text).not.toContain("오늘의 소식");
  });

  it("응답이 비어 있어도 무언가는 보낸다", async () => {
    const { runner, sent } = await make({ result: { text: "   ", ok: true } });
    await runner.run("contest", "C99");
    expect(sent).toHaveLength(1);
    expect((sent[0] as any).text.trim().length).toBeGreaterThan(0);
  });
});

describe("DigestRunner.checkAndRun — 스케줄", () => {
  it("7시가 지났고 기록이 없으면 두 주제 모두 실행하고 기록한다", async () => {
    const { runner, settings, sent } = await make();
    await runner.checkAndRun();
    expect(sent.map((e) => e.channelRef).sort()).toEqual(["C1", "C2"]);
    expect(await settings.get("digest.lastRun.contest")).toBe("2026-07-27");
    expect(await settings.get("digest.lastRun.devnews")).toBe("2026-07-27");
  });

  it("7시 이전이면 아무것도 하지 않는다", async () => {
    const { runner, sent } = await make({ now: BEFORE_SEVEN });
    await runner.checkAndRun();
    expect(sent).toHaveLength(0);
  });

  it("이미 오늘 했으면 다시 하지 않는다", async () => {
    const { runner, settings, sent } = await make();
    await settings.set("digest.lastRun.contest", "2026-07-27");
    await settings.set("digest.lastRun.devnews", "2026-07-27");
    await runner.checkAndRun();
    expect(sent).toHaveLength(0);
  });

  it("채널이 설정되지 않은 주제는 건너뛴다", async () => {
    const { runner, settings, sent } = await make({ channels: { contest: "C1" } });
    await runner.checkAndRun();
    expect(sent.map((e) => e.channelRef)).toEqual(["C1"]);
    expect(await settings.get("digest.lastRun.devnews")).toBeNull();
  });

  it("턴이 실패하면 기록하지 않아 다음 확인에서 재시도한다", async () => {
    const { runner, settings } = await make({ result: { text: "", ok: false } });
    await runner.checkAndRun();
    expect(await settings.get("digest.lastRun.contest")).toBeNull();
  });
});
