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
  bus.subscribe("assistant_message", (e) => { sent.push(e); });
  const prompts: string[] = [];
  // FIX2(최종 리뷰 3차) 날짜 롤오버 테스트용: now 를 고정값이 아니라 가변 클록으로 둔다 —
  // 기존 호출부(over.now 만 쓰는 테스트)는 setClock 을 부르지 않으므로 동작이 완전히 그대로다.
  let clock = over.now ?? AFTER_SEVEN;
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
    now: () => clock,
  });
  return { runner, settings, sent, prompts, setClock: (t: number) => { clock = t; } };
}

// pg-mem 의 Pool.query() 는 마이크로태스크가 아니라 매크로태스크(setImmediate) 단위로 풀린다
// (coreMulti.test.ts 의 동일 주석 참고). checkAndRun/run 은 settings.get/set 을 여러 번 순차
// await 하므로, "아직 처리 전" 중간 상태(재진입 가드)를 관찰하려면 그 홉 수만큼 setImmediate 로
// 넘겨줘야 한다.
const flush = async () => {
  for (let i = 0; i < 60; i++) await new Promise((r) => setImmediate(r));
};

// FIX1(최종 리뷰 3차) 재진입 가드 테스트용: runTurn 을 즉시 resolve 하지 않고 테스트가 원하는
// 시점에 직접 흘려보낼 수 있게 만든다(coreMulti.test.ts 의 manualDigest 와 같은 목적, 여기서는
// DigestRunner 실물에 주입하는 runTurn 쪽을 흉내낸다).
async function makeManual(over: Partial<{ channels: Record<string, string>; now: number }> = {}) {
  const db = await openTestDb();
  const settings = new SettingsRepo(db);
  const bus = new EventBus();
  const sent: AgentEvent[] = [];
  bus.subscribe("assistant_message", (e) => { sent.push(e); });
  const runTurnCalls: string[] = [];
  const pending: Array<{ resolve: (r: { text: string; ok: boolean }) => void; reject: (e: unknown) => void }> = [];
  let clock = over.now ?? AFTER_SEVEN;
  const runner = new DigestRunner({
    runTurn: async (req) => {
      runTurnCalls.push(req.prompt);
      return new Promise<{ text: string; ok: boolean }>((resolve, reject) => { pending.push({ resolve, reject }); });
    },
    bus,
    settings,
    agentCwd: "/tmp",
    channels: (over.channels ?? { contest: "C1", devnews: "C2" }) as any,
    now: () => clock,
  });
  return { runner, settings, sent, runTurnCalls, pending, setClock: (t: number) => { clock = t; } };
}

// ── 최종 리뷰 FIX2(치명) — 정기 게시 턴은 공유 워커가 연결돼 있어도 원격 도구를 받으면 안 된다 ──
// execute() 가 구성하는 context(isOwner:false, isPrivate:false)는 Task 7 이전엔 원격 도구가
// 구조적으로 없던 계층이었지만, 이제는 그 계층도 공유 워커가 연결되면 fs_*/sh_exec 를 받는다
// (tools.ts 의 allowedToolsFor). 사람이 지켜보지 않는 타이머로 돌며 신뢰할 수 없는 웹 검색
// 결과를 그대로 읽어들이는 이 턴에 셸 접근까지 열려 있으면 안 되므로, runTurn 요청에
// noRemoteTools:true 를 실어야 한다(agent.ts 의 resolveTurnWorker 가 이 값을 보면 워커 연결
// 여부·registry/hub 조회 자체를 건너뛰고 무조건 null 로 처리한다). noSkills:true(M-2 후속
// 리뷰)도 같은 이유로 함께 싣는다 — 뉴스 조사에 도움이 되는 스킬이 없다.
describe("DigestRunner — 정기 게시 턴은 원격 도구를 받지 않는다(최종 리뷰 FIX2)", () => {
  it("run(예약어) 이 runTurn 에 noRemoteTools:true 를 싣는다", async () => {
    const db = await openTestDb();
    const settings = new SettingsRepo(db);
    const bus = new EventBus();
    const requests: Array<{ noRemoteTools?: boolean; noWebTools?: boolean; noSkills?: boolean; noMemoryWrite?: boolean }> = [];
    const runner = new DigestRunner({
      runTurn: async (req) => {
        requests.push(req);
        return { text: "오늘의 소식", ok: true, sessionId: "s" };
      },
      bus, settings, agentCwd: "/tmp",
      channels: { contest: "C1", devnews: "C2" },
      now: () => AFTER_SEVEN,
    });

    await runner.run("contest", "C1");

    expect(requests).toHaveLength(1);
    expect(requests[0].noRemoteTools).toBe(true);
    expect(requests[0].noSkills).toBe(true);
    // Important 4(최종 전체 브랜치 리뷰) — noRemoteTools/noSkills 와 같은 자리의 세 번째 축.
    expect(requests[0].noMemoryWrite).toBe(true);
  });

  it("checkAndRun(스케줄) 이 runTurn 에 noRemoteTools:true·noSkills:true·noMemoryWrite:true 를 싣는다 — 웹 검색(noWebTools)은 그대로 열어 둔다", async () => {
    const db = await openTestDb();
    const settings = new SettingsRepo(db);
    const bus = new EventBus();
    const requests: Array<{ noRemoteTools?: boolean; noWebTools?: boolean; noSkills?: boolean; noMemoryWrite?: boolean }> = [];
    const runner = new DigestRunner({
      runTurn: async (req) => {
        requests.push(req);
        return { text: "오늘의 소식", ok: true, sessionId: "s" };
      },
      bus, settings, agentCwd: "/tmp",
      channels: { contest: "C1", devnews: "C2" },
      now: () => AFTER_SEVEN,
    });

    await runner.checkAndRun();

    expect(requests).toHaveLength(2); // contest·devnews 둘 다
    for (const req of requests) {
      expect(req.noRemoteTools).toBe(true);
      // 뉴스 조사에 도움이 되는 스킬이 없으므로 원격 도구와 같은 이유로 막는다.
      expect(req.noSkills).toBe(true);
      // Important 4 — remember(공용 기억 쓰기)도 같은 이유로 막는다.
      expect(req.noMemoryWrite).toBe(true);
      // 이 턴의 목적 자체가 웹 검색이므로 noWebTools 는 세우지 않는다(유휴 요약 턴과의 차이).
      expect(req.noWebTools).not.toBe(true);
    }
  });
});

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

// ── FIX1(치명, 최종 리뷰 3차) — 스케줄 재진입 가드 ──────────────────────────────
// index.ts 는 checkAndRun 을 60초마다 `void digest.checkAndRun().catch(...)` 로 fire-and-forget
// 호출한다. 이전 틱의 턴(Opus·웹검색·maxTurns:30, 이 앱에서 가장 비싼 턴)이 안 끝난 채 다음
// 틱이 와도 lastRun 은 성공 이후에만 기록되므로, 재조회한 settings 값은 여전히 "오늘 안 함"이라
// 새 턴을 또 시작했다(리뷰 재현: 5틱 중 5턴 시작). private running = new Set<DigestTopic>() 로
// 주제별 실행 중 상태를 표시해 checkAndRun·run 양쪽에서 공유한다.
describe("DigestRunner — 스케줄 재진입 가드(FIX1, 최종 리뷰 3차)", () => {
  it("턴이 안 끝난 상태로 checkAndRun 을 5번 겹쳐 불러도 같은 주제는 한 번만 시작한다", async () => {
    const { runner, runTurnCalls, pending } = await makeManual({ channels: { contest: "C1" } });

    // index.ts 의 실제 호출 패턴(await 없이 fire-and-forget)을 그대로 재현 — 5틱을 동시에 흘린다.
    const ticks = [runner.checkAndRun(), runner.checkAndRun(), runner.checkAndRun(), runner.checkAndRun(), runner.checkAndRun()];
    await flush();

    expect(runTurnCalls).toHaveLength(1); // 5틱이 겹쳤어도 실제 턴은 하나만 시작됐다

    pending[0].resolve({ text: "오늘의 소식", ok: true });
    await Promise.all(ticks);
    await flush();
  });

  it("run(예약어)도 같은 주제가 실행 중이면 새로 시작하지 않고 { started: false } 를 돌려준다", async () => {
    const { runner, runTurnCalls, pending } = await makeManual();

    const first = runner.run("contest", "C1");
    await flush();
    expect(runTurnCalls).toHaveLength(1);

    const secondOutcome = await runner.run("contest", "C2"); // 다른 채널에서 같은 주제를 요청해도 막힌다
    expect(secondOutcome.started).toBe(false);
    expect(runTurnCalls).toHaveLength(1); // 새로 시작되지 않았다

    pending[0].resolve({ text: "오늘의 소식", ok: true });
    const firstOutcome = await first;
    expect(firstOutcome.started).toBe(true);
    await flush();
  });

  it("스케줄(checkAndRun)과 예약어(run)는 같은 가드를 공유한다 — run 이 진행 중이면 checkAndRun 도 그 주제를 건너뛴다", async () => {
    const { runner, settings, runTurnCalls, pending } = await makeManual({ channels: { contest: "C1" } });

    void runner.run("contest", "C-manual"); // 예약어로 먼저 시작(끝나지 않음)
    await flush();
    expect(runTurnCalls).toHaveLength(1);

    await runner.checkAndRun(); // 같은 순간 스케줄 틱이 와도 같은 주제라 건너뛴다
    expect(runTurnCalls).toHaveLength(1); // 추가로 시작되지 않았다
    expect(await settings.get("digest.lastRun.contest")).toBeNull(); // 건너뛴 시도라 기록도 없다

    pending[0].resolve({ text: "오늘의 소식", ok: true });
    await flush();
  });

  it("턴이 끝나면 가드가 풀려 다음 시도가 정상적으로 시작된다", async () => {
    const { runner, runTurnCalls, pending } = await makeManual({ channels: { contest: "C1" } });

    const firstTick = runner.checkAndRun();
    await flush();
    expect(runTurnCalls).toHaveLength(1);

    pending[0].resolve({ text: "오늘의 소식", ok: true });
    await firstTick;
    await flush();

    // 이미 성공해 lastRun 이 오늘로 기록됐으므로, 재현은 run(예약어)으로 확인한다 —
    // run 은 lastRun 과 무관하게 항상 즉시 실행을 시도한다(가드만 걸린다).
    const outcomePromise = runner.run("contest", "C1");
    await flush();
    expect(runTurnCalls).toHaveLength(2); // 가드가 풀려 두 번째 시도가 시작됐다

    pending[1].resolve({ text: "오늘의 소식2", ok: true });
    const outcome = await outcomePromise;
    expect(outcome.started).toBe(true);
    await flush();
  });
});

// ── FIX2(치명, 최종 리뷰 3차) — 일일 재시도 상한 ────────────────────────────────
// shouldRunDigest 는 lastRun 이 기록되지 않는 한(=턴이 계속 실패하는 한) 자정까지 계속 true 를
// 낸다. 1분 틱마다 재시도하면 하루 약 1,020회(주제당) × Opus 호출과, execute() 가 실패를
// 무조건 알리는 탓에 채널 도배(리뷰 재현: 10틱 실패 시 10번 호출·10번 게시)가 난다. settings 키
// digest.attempts.<topic> 에 KST 날짜·횟수·안내 여부를 저장해 하루 3회로 시도를 제한하고,
// 실패 안내는 하루 한 번만 낸다(그 이후는 로그만 남긴다).
describe("DigestRunner — 일일 재시도 상한(FIX2, 최종 리뷰 3차)", () => {
  it("계속 실패하면 하루 3회까지만 시도하고 그 뒤엔 모델 호출 자체를 멈춘다", async () => {
    const { runner, prompts } = await make({ result: { text: "", ok: false } });

    for (let i = 0; i < 10; i++) await runner.checkAndRun();

    // 주제 둘(contest·devnews) × 최대 3회 = 6번까지만 실제로 모델을 불렀다(10틱이 아니라).
    expect(prompts).toHaveLength(6);
  });

  it("실패 안내 메시지는 주제당 하루 한 번만 채널에 올라간다", async () => {
    const { runner, sent } = await make({ result: { text: "", ok: false } });

    for (let i = 0; i < 10; i++) await runner.checkAndRun();

    const contestNotices = sent.filter((e) => e.channelRef === "C1");
    const devnewsNotices = sent.filter((e) => e.channelRef === "C2");
    expect(contestNotices).toHaveLength(1);
    expect(devnewsNotices).toHaveLength(1);
    expect((contestNotices[0] as any).text).not.toContain("오늘의 소식");
  });

  it("실패해도 lastRun 은 기록하지 않는다(회귀 유지 — 다음날 재시도)", async () => {
    const { runner, settings } = await make({ result: { text: "", ok: false } });

    for (let i = 0; i < 10; i++) await runner.checkAndRun();

    expect(await settings.get("digest.lastRun.contest")).toBeNull();
    expect(await settings.get("digest.lastRun.devnews")).toBeNull();
  });

  it("한도에 도달한 뒤 같은 날 다시 확인해도 더 시도하지 않는다(스팸 방지 유지)", async () => {
    const { runner, prompts } = await make({ result: { text: "", ok: false } });
    for (let i = 0; i < 3; i++) await runner.checkAndRun();
    expect(prompts).toHaveLength(6); // 이미 한도(주제당 3) 도달

    for (let i = 0; i < 20; i++) await runner.checkAndRun(); // 같은 날 더 돌려도
    expect(prompts).toHaveLength(6); // 늘지 않는다
  });

  it("성공하면 그날의 실패 횟수 기록을 정리한다(다음에 실패하면 다시 안내할 수 있도록)", async () => {
    const result = { text: "", ok: false };
    const { runner, settings } = await make({ result, channels: { contest: "C1" } });

    await runner.checkAndRun(); // 1차 실패 — digest.attempts.contest 기록 생김
    expect(await settings.get("digest.attempts.contest")).not.toBeNull();

    // lastRun 이 아직 없어 같은 날 다시 shouldRunDigest 가 true 를 낸다 — 그 사이 검색이
    // 성공했다고 가정하고 결과를 성공으로 바꾼다.
    result.ok = true;
    result.text = "오늘의 소식";
    await runner.checkAndRun(); // 2차 성공

    expect(await settings.get("digest.attempts.contest")).toBeNull(); // 실패 기록이 정리됐다
    expect(await settings.get("digest.lastRun.contest")).not.toBeNull();
  });

  it("KST 날짜가 바뀌면 시도 횟수·안내 여부가 자연 초기화된다", async () => {
    const day1 = AFTER_SEVEN; // 2026-07-27 KST
    const day2 = utc("2026-07-28T03:00:00Z"); // 2026-07-28 KST 12:00 — 다음날, 여전히 7시 이후
    const { runner, prompts, sent, setClock } = await make({
      result: { text: "", ok: false }, channels: { contest: "C1" }, now: day1,
    });

    for (let i = 0; i < 5; i++) await runner.checkAndRun(); // 하루 한도(3) 도달, 이후는 무시됨
    expect(prompts).toHaveLength(3);
    expect(sent).toHaveLength(1);

    setClock(day2);
    await runner.checkAndRun(); // 새 날 — 한도·안내 여부 모두 리셋
    expect(prompts).toHaveLength(4); // 새 날의 첫 시도가 다시 실행됐다
    expect(sent).toHaveLength(2); // 새 날의 첫 실패는 다시 안내한다
  });
});

// ── FIX3(중요, 머지 전 리뷰) — 지정 채널로 리다이렉트된 예약어만 lastRun 을 남긴다 ──────────
// "예약어는 lastRun 을 절대 건드리지 않는다"는 원래 불변식은 수동 결과가 항상 명령을 친 곳으로만
// 갔을 때는 맞았다. 그런데 core.ts 가 예약어 결과를 이제 그 주제의 지정 채널로 리다이렉트하므로,
// 예약어 실행이 KST 07시 이전에 지정 채널(예: news-대회)에 성공적으로 결과를 올려도 lastRun 을
// 안 남기면 07시 스케줄이 몇 시간 뒤 같은 채널에 같은 주제를 또 올린다(리뷰 재현: 06시 수동 실행
// + 07시 스케줄 = news-대회 게시 2회). 결과가 다른 곳(DM, 또는 지정 채널이 없어 명령 친 곳으로
// 폴백)으로 갔을 때는 그 채널이 오늘 치 소식을 못 봤으므로 기존처럼 lastRun 을 그대로 둬야 한다
// (그래야 그 채널과 무관하게 그날 아침 스케줄이 정상적으로 돈다). 이 두 갈래는 "결과가 실제로
// 그 주제의 지정 채널(this.channels[topic])로 갔는가"로 가른다 — DigestRunner 는 core.ts 가
// 어떤 경위로 그 채널을 골랐는지(같은 곳에서 불러 리다이렉트가 없었는지, DIGEST_CHANNELS 설정으로
// 리다이렉트됐는지)는 몰라도 되고, 그저 channelRef 가 지정 채널과 같은지만 보면 된다.
describe("DigestRunner.run — FIX3: 지정 채널로 간 결과만 lastRun 을 남긴다", () => {
  it("결과가 그 주제의 지정 채널로 가면(성공) lastRun 을 기록한다", async () => {
    const { runner, settings } = await make(); // 기본 channels: { contest: "C1", devnews: "C2" }
    await runner.run("contest", "C1"); // C1 이 곧 contest 의 지정 채널
    expect(await settings.get("digest.lastRun.contest")).toBe("2026-07-27");
  });

  it("결과가 지정 채널이 아닌 곳(DM·폴백)으로 가면 lastRun 을 기록하지 않는다(기존 회귀 유지)", async () => {
    const { runner, settings } = await make();
    await runner.run("contest", "C99"); // C99 는 contest 의 지정 채널(C1)이 아니다
    expect(await settings.get("digest.lastRun.contest")).toBeNull();
  });

  it("지정 채널로 갔어도 실패하면 lastRun 을 기록하지 않는다", async () => {
    const { runner, settings } = await make({ result: { text: "", ok: false }, channels: { contest: "C1" } });
    await runner.run("contest", "C1");
    expect(await settings.get("digest.lastRun.contest")).toBeNull();
  });

  it("지정 채널로의 성공은 그날 쌓인 실패 시도 기록도 정리한다(스케줄 성공과 같은 정리)", async () => {
    const { runner, settings } = await make({ channels: { contest: "C1" } });
    // 스케줄이 이미 두 번 실패해 시도 기록이 쌓인 상태를 흉내낸다.
    await settings.set("digest.attempts.contest", JSON.stringify({ date: "2026-07-27", count: 2, notified: true }));

    await runner.run("contest", "C1");

    expect(await settings.get("digest.attempts.contest")).toBeNull();
  });

  it("수동 실행이 지정 채널에 성공적으로 올리면, 같은 날 07시 스케줄은 건너뛴다(리뷰 재현 시나리오 — 중복 게시 방지)", async () => {
    const { runner, settings, sent, setClock } = await make({ channels: { contest: "C1" }, now: BEFORE_SEVEN });

    await runner.run("contest", "C1"); // KST 06시, 지정 채널로 결과가 감
    expect(sent).toHaveLength(1);
    expect(sent[0].channelRef).toBe("C1");
    expect(await settings.get("digest.lastRun.contest")).not.toBeNull();

    setClock(AFTER_SEVEN); // 같은 날 07시 이후
    await runner.checkAndRun();

    expect(sent).toHaveLength(1); // 스케줄이 건너뛰어 총 1회만 게시됐다(중복 없음)
  });

  it("DM(또는 폴백)으로 간 수동 실행은 lastRun 을 안 남겨 같은 날 07시 스케줄이 정상적으로 돈다", async () => {
    const { runner, settings, sent, setClock } = await make({ channels: { contest: "C1" }, now: BEFORE_SEVEN });

    await runner.run("contest", "dm-owner"); // DM 채널로 감 — 지정 채널(C1)과 다르다
    expect(sent).toHaveLength(1);
    expect(await settings.get("digest.lastRun.contest")).toBeNull();

    setClock(AFTER_SEVEN); // 같은 날 07시 이후
    await runner.checkAndRun();

    expect(sent).toHaveLength(2); // 스케줄이 정상적으로 실행돼 지정 채널에 게시했다(DM 실행과 무관)
    expect(sent[1].channelRef).toBe("C1");
  });
});
