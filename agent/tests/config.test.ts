import { describe, it, expect } from "vitest";
import { loadConfig, loadWorkerConfig } from "../src/config.js";

// FIX2: WORKER_TOKEN 이 이제 필수 + 최소 길이 검증 대상이라, 이 값과 무관한 기존 테스트들도
// loadConfig 를 통과하려면 "충분히 긴" 토큰이 base 에 있어야 한다(다른 필수 env 와 같은 이유로
// base 에 이미 DISCORD_TOKEN 등이 있는 것과 동일한 패턴).
const LONG_WORKER_TOKEN = "a".repeat(32);

const base = { DISCORD_TOKEN: "tok", DISCORD_OWNER_ID: "123", DATABASE_URL: "postgres://localhost/test", WORKER_TOKEN: LONG_WORKER_TOKEN };

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

// FIX2(치명): 빈 WORKER_TOKEN 은 "누구나 소유자의 워커" 로 인증되는 사고로 이어진다(hub.ts 가 그
// 값과 '!==' 로만 비교했다) — 다른 필수 env 변수처럼 시작 시점에 명확히 실패해야 한다. 짧은(추측
// 가능한) 토큰도 사실상 같은 문제라 최소 길이까지 함께 검증한다.
describe("FIX2 — WORKER_TOKEN 은 필수이며 최소 길이를 만족해야 한다", () => {
  it("WORKER_TOKEN 이 없으면(빈 문자열 포함) 시작 시점에 실패한다", () => {
    const { WORKER_TOKEN, ...withoutToken } = base;
    expect(() => loadConfig(withoutToken)).toThrow(/WORKER_TOKEN/);
    expect(() => loadConfig({ ...base, WORKER_TOKEN: "" })).toThrow(/WORKER_TOKEN/);
  });

  it("WORKER_TOKEN 이 너무 짧으면(예: 5자) 시작 시점에 실패한다", () => {
    expect(() => loadConfig({ ...base, WORKER_TOKEN: "short" })).toThrow(/WORKER_TOKEN/);
  });

  it("WORKER_TOKEN 이 충분히 길면 통과한다(경계값)", () => {
    // 실제 최소 길이 상수는 config.ts 내부에만 있으므로, 여기서는 "짧으면 실패·충분히 길면 통과"라는
    // 관찰 가능한 경계 동작만 검증한다(내부 상수 값 자체를 재구현해 두 번째 기준을 만들지 않는다).
    expect(() => loadConfig({ ...base, WORKER_TOKEN: LONG_WORKER_TOKEN })).not.toThrow();
    expect(loadConfig({ ...base, WORKER_TOKEN: LONG_WORKER_TOKEN }).workerToken).toBe(LONG_WORKER_TOKEN);
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
    const c = loadConfig({ ...base, WORKER_TOKEN: LONG_WORKER_TOKEN, PORT: "8080" } as NodeJS.ProcessEnv);
    expect(c.workerToken).toBe(LONG_WORKER_TOKEN);
    expect(c.httpPort).toBe(8080);
  });

  it("PORT 를 생략하면 기본값 3000", () => {
    expect(loadConfig({ ...base, WORKER_TOKEN: LONG_WORKER_TOKEN } as NodeJS.ProcessEnv).httpPort).toBe(3000);
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

  // FIX10: 예전엔 세 필수값(HUB_URL·WORKER_TOKEN·WORKER_ROOTS)을 한꺼번에 빼고 그 중 아무거나
  // 하나라도 메시지에 나오면 통과하는 정규식 하나로 검사했다 — 구현이 그중 두 개를 빠뜨려도 초록불일
  // 수 있었다(나머지 하나만 걸려도 통과). 키마다 나머지 둘은 채운 채로 하나씩만 빼서, 그 키가 실제로
  // 검사되는지를 각각 독립적으로 확인한다.
  it("워커 설정에서 HUB_URL 이 빠지면 시작 시점에 실패한다", () => {
    expect(() => loadWorkerConfig({
      DISCORD_OWNER_ID: "o", WORKER_USER_ID: "o", WORKER_TOKEN: "wt", WORKER_ROOTS: ROOT_A,
    } as NodeJS.ProcessEnv)).toThrow(/HUB_URL/);
  });

  it("워커 설정에서 WORKER_TOKEN 이 빠지면 시작 시점에 실패한다", () => {
    expect(() => loadWorkerConfig({
      DISCORD_OWNER_ID: "o", WORKER_USER_ID: "o", HUB_URL: "wss://h/worker", WORKER_ROOTS: ROOT_A,
    } as NodeJS.ProcessEnv)).toThrow(/WORKER_TOKEN/);
  });

  it("워커 설정에서 WORKER_ROOTS 가 빠지면 시작 시점에 실패한다", () => {
    expect(() => loadWorkerConfig({
      DISCORD_OWNER_ID: "o", WORKER_USER_ID: "o", HUB_URL: "wss://h/worker", WORKER_TOKEN: "wt",
    } as NodeJS.ProcessEnv)).toThrow(/WORKER_ROOTS/);
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
  const base = { DISCORD_TOKEN: "t", DISCORD_OWNER_ID: "1", DATABASE_URL: "postgres://x", WORKER_TOKEN: LONG_WORKER_TOKEN };
  it("loadConfig: 기본 모델은 claude-opus-4-8, ANTHROPIC_MODEL 로 재정의된다", () => {
    expect(loadConfig({ ...base } as NodeJS.ProcessEnv).model).toBe("claude-opus-4-8");
    expect(loadConfig({ ...base, ANTHROPIC_MODEL: "claude-sonnet-5" } as NodeJS.ProcessEnv).model).toBe("claude-sonnet-5");
  });
});

describe("정기 게시 채널 설정", () => {
  const base = { DATABASE_URL: "postgres://x", DISCORD_TOKEN: "d", DISCORD_OWNER_ID: "o", WORKER_TOKEN: "w".repeat(32) };

  it("두 채널 ID 를 읽는다", () => {
    const c = loadConfig({ ...base, DIGEST_CONTEST_CHANNEL_ID: "C1", DIGEST_DEVNEWS_CHANNEL_ID: "C2" } as NodeJS.ProcessEnv);
    expect(c.digestChannels).toEqual({ contest: "C1", devnews: "C2" });
  });

  it("설정되지 않은 주제는 키 자체가 없다", () => {
    const c = loadConfig({ ...base, DIGEST_CONTEST_CHANNEL_ID: "C1" } as NodeJS.ProcessEnv);
    expect(c.digestChannels.contest).toBe("C1");
    expect(c.digestChannels.devnews).toBeUndefined();
  });

  it("둘 다 없어도 기동에는 지장이 없다(빈 객체)", () => {
    expect(loadConfig(base as NodeJS.ProcessEnv).digestChannels).toEqual({});
  });
});
