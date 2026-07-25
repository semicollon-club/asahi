import { describe, it, expect } from "vitest";
import { loadConfig, loadWorkerConfig } from "../src/config.js";

const base = { DISCORD_TOKEN: "tok", DISCORD_OWNER_ID: "123", DATABASE_URL: "postgres://localhost/test" };

describe("loadConfig", () => {
  it("필수값이 있으면 기본값과 함께 로드된다", () => {
    const c = loadConfig(base);
    expect(c.discordToken).toBe("tok");
    expect(c.ownerId).toBe("123");
    expect(c.databaseUrl).toBe("postgres://localhost/test");
    expect(c.channelId).toBeUndefined();
    expect(c.sessionIdleMinutes).toBe(30);
    expect(c.maxTurnsPerHour).toBe(30);
    expect(c.dataDir.endsWith("store")).toBe(true);
    expect(c.memoryDir.endsWith("memory")).toBe(true);
  });

  it("멀티유저 한도 기본값을 로드한다", () => {
    const c = loadConfig(base);
    expect(c.maxTurnsPerHourPerUser).toBe(20);
    expect(c.maxTurnsPerHourGlobal).toBe(40);
    expect(c.ownerReserve).toBe(10);
  });

  it("멀티유저 한도를 env 로 덮어쓸 수 있다", () => {
    const c = loadConfig({ ...base, MAX_TURNS_PER_HOUR_PER_USER: "7", MAX_TURNS_PER_HOUR_GLOBAL: "15", OWNER_RESERVE: "4" });
    expect(c.maxTurnsPerHourPerUser).toBe(7);
    expect(c.maxTurnsPerHourGlobal).toBe(15);
    expect(c.ownerReserve).toBe(4);
  });

  it("멀티유저 한도 env 가 잘못되면(0·음수·오타) 시작 시 명확히 실패한다", () => {
    expect(() => loadConfig({ ...base, MAX_TURNS_PER_HOUR_PER_USER: "0" })).toThrow(/MAX_TURNS_PER_HOUR_PER_USER/);
    expect(() => loadConfig({ ...base, MAX_TURNS_PER_HOUR_GLOBAL: "-3" })).toThrow(/MAX_TURNS_PER_HOUR_GLOBAL/);
    expect(() => loadConfig({ ...base, OWNER_RESERVE: "abc" })).toThrow(/OWNER_RESERVE/);
  });

  it("선택값을 덮어쓸 수 있다", () => {
    const c = loadConfig({ ...base, DISCORD_CHANNEL_ID: "ch1", SESSION_IDLE_MINUTES: "10", MAX_TURNS_PER_HOUR: "5" });
    expect(c.channelId).toBe("ch1");
    expect(c.sessionIdleMinutes).toBe(10);
    expect(c.maxTurnsPerHour).toBe(5);
  });

  it("deployTarget 기본값은 local 이다", () => {
    const c = loadConfig(base);
    expect(c.deployTarget).toBe("local");
  });

  it("DEPLOY_TARGET=cloud 이면 deployTarget 이 cloud 로 로드된다", () => {
    const c = loadConfig({ ...base, DEPLOY_TARGET: "cloud" });
    expect(c.deployTarget).toBe("cloud");
  });

  it("DEPLOY_TARGET 이 cloud 가 아닌 값(오타 등)이면 local 로 취급한다", () => {
    const c = loadConfig({ ...base, DEPLOY_TARGET: "production" });
    expect(c.deployTarget).toBe("local");
  });

  it("필수값이 없으면 무엇이 빠졌는지 알려주며 실패한다", () => {
    expect(() => loadConfig({})).toThrow(/DISCORD_TOKEN/);
  });

  it("DATABASE_URL 이 없으면 명확히 실패한다", () => {
    const { DATABASE_URL, ...withoutDbUrl } = base;
    expect(() => loadConfig(withoutDbUrl)).toThrow(/DATABASE_URL/);
  });

  it("숫자 env 가 잘못되면(오타·0·음수) 시작 시 명확히 실패한다", () => {
    expect(() => loadConfig({ ...base, MAX_TURNS_PER_HOUR: "30/hour" })).toThrow(/MAX_TURNS_PER_HOUR/);
    expect(() => loadConfig({ ...base, MAX_TURNS_PER_HOUR: "0" })).toThrow(/MAX_TURNS_PER_HOUR/);
    expect(() => loadConfig({ ...base, SESSION_IDLE_MINUTES: "abc" })).toThrow(/SESSION_IDLE_MINUTES/);
  });
});

// Task 7(배선): 워커가 얇은 클라이언트(DB·모델·세션 없음, 허브에 붙는 소켓+도구 실행뿐)로
// 바뀌면서 WorkerConfig 자체가 통째로 교체됐다 — 옛 loadWorkerConfig 테스트(databaseUrl·
// workerSecret·dataDir·memoryDir·sessionIdleMinutes·model)는 더 이상 존재하지 않는 필드를
// 검증하므로 전부 이 블록으로 대체한다.
describe("얇은 워커 설정(Task 7 — 워커는 DB·모델·세션을 다루지 않는다)", () => {
  const base = { DATABASE_URL: "postgres://x", DISCORD_TOKEN: "d", DISCORD_OWNER_ID: "o" };
  // 플랫폼마다 "모호하지 않은 절대경로"의 모양이 다르다(윈도우는 드라이브 문자 필요) —
  // remote/roots.ts 의 isUnambiguousRoot 와 같은 기준을 테스트도 따라야 한다(보정 2).
  const ROOT_A = process.platform === "win32" ? "C:\\a" : "/a";
  const ROOT_B = process.platform === "win32" ? "C:\\b" : "/b";

  it("봇 설정에 WORKER_TOKEN 과 PORT 가 실린다", () => {
    const c = loadConfig({ ...base, WORKER_TOKEN: "wt", PORT: "8080" } as NodeJS.ProcessEnv);
    expect(c.workerToken).toBe("wt");
    expect(c.httpPort).toBe(8080);
  });

  it("PORT 를 생략하면 기본값 3000", () => {
    expect(loadConfig({ ...base, WORKER_TOKEN: "wt" } as NodeJS.ProcessEnv).httpPort).toBe(3000);
  });

  it("워커 설정은 DATABASE_URL 이 아니라 HUB_URL·WORKER_TOKEN·WORKER_ROOTS 를 요구한다", () => {
    const w = loadWorkerConfig({
      DISCORD_OWNER_ID: "o", WORKER_USER_ID: "o",
      HUB_URL: "wss://h/worker", WORKER_TOKEN: "wt", WORKER_ROOTS: `${ROOT_A},${ROOT_B}`,
    } as NodeJS.ProcessEnv);
    expect(w.hubUrl).toBe("wss://h/worker");
    expect(w.workerToken).toBe("wt");
    expect(w.roots).toEqual([ROOT_A, ROOT_B]);
    expect(w).not.toHaveProperty("databaseUrl");
  });

  it("워커 설정에서 필수값이 빠지면 시작 시점에 실패한다", () => {
    expect(() => loadWorkerConfig({ DISCORD_OWNER_ID: "o", WORKER_USER_ID: "o" } as NodeJS.ProcessEnv)).toThrow(/HUB_URL|WORKER_TOKEN|WORKER_ROOTS/);
  });

  // 보정 2: WORKER_ROOTS 는 remote/roots.ts 의 checkPath 가 최종 판정에 쓰는 것과 동일한 기준
  // ("모호하지 않은 절대경로")을 config 로드 시점에도 적용해야 한다 — 그러지 않으면 config 는
  // 통과했는데 모든 도구 호출을 거부하는 워커가 조용히 뜬다.
  it("WORKER_ROOTS 에 절대경로가 아닌 항목이 있으면 시작 시점에 실패한다", () => {
    expect(() => loadWorkerConfig({
      DISCORD_OWNER_ID: "o", WORKER_USER_ID: "o",
      HUB_URL: "wss://h/worker", WORKER_TOKEN: "wt", WORKER_ROOTS: "relative/path",
    } as NodeJS.ProcessEnv)).toThrow(/WORKER_ROOTS/);
  });

  it("WORKER_ROOTS 여러 개 중 하나라도 절대경로가 아니면 전부 거부한다", () => {
    expect(() => loadWorkerConfig({
      DISCORD_OWNER_ID: "o", WORKER_USER_ID: "o",
      HUB_URL: "wss://h/worker", WORKER_TOKEN: "wt", WORKER_ROOTS: `${ROOT_A},relative/path`,
    } as NodeJS.ProcessEnv)).toThrow(/WORKER_ROOTS/);
  });

  it.skipIf(process.platform !== "win32")(
    "윈도우에서 드라이브 문자·UNC 없이 구분자로만 시작하는 WORKER_ROOTS 는 거부한다(모호한 경로, remote/roots.ts 와 동일 기준)",
    () => {
      expect(() => loadWorkerConfig({
        DISCORD_OWNER_ID: "o", WORKER_USER_ID: "o",
        HUB_URL: "wss://h/worker", WORKER_TOKEN: "wt", WORKER_ROOTS: "/workspace",
      } as NodeJS.ProcessEnv)).toThrow(/WORKER_ROOTS/);
    },
  );
});

describe("model 구성(Opus 4.8 기본, 봇 설정 전용 — 워커는 더 이상 model 을 다루지 않는다)", () => {
  const base = { DISCORD_TOKEN: "t", DISCORD_OWNER_ID: "1", DATABASE_URL: "postgres://x" };
  it("loadConfig: 기본 모델은 claude-opus-4-8, ANTHROPIC_MODEL 로 재정의된다", () => {
    expect(loadConfig({ ...base } as NodeJS.ProcessEnv).model).toBe("claude-opus-4-8");
    expect(loadConfig({ ...base, ANTHROPIC_MODEL: "claude-sonnet-5" } as NodeJS.ProcessEnv).model).toBe("claude-sonnet-5");
  });
});
