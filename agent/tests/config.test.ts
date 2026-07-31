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

  it("봇 설정에 PORT 가 실린다(워커 인증은 더 이상 봇 설정을 거치지 않는다)", () => {
    const c = loadConfig({ ...base, PORT: "8080" } as NodeJS.ProcessEnv);
    expect(c.httpPort).toBe(8080);
  });

  it("PORT 를 생략하면 기본값 3000", () => {
    expect(loadConfig(base as NodeJS.ProcessEnv).httpPort).toBe(3000);
  });

  it("워커 설정은 DATABASE_URL 이 아니라 HUB_URL·WORKER_TOKEN·WORKER_ROOTS 를 요구한다", () => {
    const w = loadWorkerConfig({
      DISCORD_OWNER_ID: "o", WORKER_ID: "o",
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
      DISCORD_OWNER_ID: "o", WORKER_ID: "o", WORKER_TOKEN: "wt", WORKER_ROOTS: ROOT_A,
    } as NodeJS.ProcessEnv)).toThrow(/HUB_URL/);
  });

  it("워커 설정에서 WORKER_TOKEN 이 빠지면 시작 시점에 실패한다", () => {
    expect(() => loadWorkerConfig({
      DISCORD_OWNER_ID: "o", WORKER_ID: "o", HUB_URL: "wss://h/worker", WORKER_ROOTS: ROOT_A,
    } as NodeJS.ProcessEnv)).toThrow(/WORKER_TOKEN/);
  });

  it("워커 설정에서 WORKER_ROOTS 가 빠지면 시작 시점에 실패한다", () => {
    expect(() => loadWorkerConfig({
      DISCORD_OWNER_ID: "o", WORKER_ID: "o", HUB_URL: "wss://h/worker", WORKER_TOKEN: "wt",
    } as NodeJS.ProcessEnv)).toThrow(/WORKER_ROOTS/);
  });

  // 보정 2: WORKER_ROOTS 는 remote/roots.ts 의 checkPath 가 최종 판정에 쓰는 것과 동일한 기준
  // ("모호하지 않은 절대경로")을 config 로드 시점에도 적용해야 한다 — 그러지 않으면 config 는
  // 통과했는데 모든 도구 호출을 거부하는 워커가 조용히 뜬다.
  it("WORKER_ROOTS 에 절대경로가 아닌 항목이 있으면 시작 시점에 실패한다", () => {
    expect(() => loadWorkerConfig({
      DISCORD_OWNER_ID: "o", WORKER_ID: "o",
      HUB_URL: "wss://h/worker", WORKER_TOKEN: "wt", WORKER_ROOTS: "relative/path",
    } as NodeJS.ProcessEnv)).toThrow(/WORKER_ROOTS/);
  });

  it("WORKER_ROOTS 여러 개 중 하나라도 절대경로가 아니면 전부 거부한다", () => {
    expect(() => loadWorkerConfig({
      DISCORD_OWNER_ID: "o", WORKER_ID: "o",
      HUB_URL: "wss://h/worker", WORKER_TOKEN: "wt", WORKER_ROOTS: `${ROOT_A},relative/path`,
    } as NodeJS.ProcessEnv)).toThrow(/WORKER_ROOTS/);
  });

  it.skipIf(process.platform !== "win32")(
    "윈도우에서 드라이브 문자·UNC 없이 구분자로만 시작하는 WORKER_ROOTS 는 거부한다(모호한 경로, remote/roots.ts 와 동일 기준)",
    () => {
      expect(() => loadWorkerConfig({
        DISCORD_OWNER_ID: "o", WORKER_ID: "o",
        HUB_URL: "wss://h/worker", WORKER_TOKEN: "wt", WORKER_ROOTS: "/workspace",
      } as NodeJS.ProcessEnv)).toThrow(/WORKER_ROOTS/);
    },
  );

  // Task 7(자동 갱신): sentinelPath 는 이 파일의 다른 WorkerConfig 필드와 달리 그동안 전용
  // 테스트가 없었다 — config.ts 의 `sentinelPath: env.WORKER_SENTINEL || undefined,` 한 줄을
  // 통째로 지워도 이 파일을 포함한 전체 스위트가 그대로 통과했다(리뷰가 뮤테이션으로 확인).
  // 자동 갱신 전체가 여기서 조용히 죽는다 — WORKER_SENTINEL 이 없으면 워커는 옵트인이 꺼진
  // 것으로 보고 감시를 아예 안 하고(정상), 있으면 그 값을 그대로 sentinelPath 로 실어야
  // update-worker.ps1 이 만드는 센티넬 경로와 워커가 감시하는 경로가 일치한다(비정상이면
  // 업데이터는 계속 파일을 만드는데 워커는 다른 곳을 보게 된다).
  it("WORKER_SENTINEL 이 없으면 sentinelPath 는 undefined 다(자동 갱신 감시는 옵트인)", () => {
    const w = loadWorkerConfig({
      DISCORD_OWNER_ID: "o", WORKER_ID: "o",
      HUB_URL: "wss://h/worker", WORKER_TOKEN: "wt", WORKER_ROOTS: ROOT_A,
    } as NodeJS.ProcessEnv);
    expect(w.sentinelPath).toBeUndefined();
  });

  it("WORKER_SENTINEL 을 설정하면 sentinelPath 에 그 값이 그대로 실린다", () => {
    const w = loadWorkerConfig({
      DISCORD_OWNER_ID: "o", WORKER_ID: "o",
      HUB_URL: "wss://h/worker", WORKER_TOKEN: "wt", WORKER_ROOTS: ROOT_A,
      WORKER_SENTINEL: "C:\\asahi-worker\\update.flag",
    } as NodeJS.ProcessEnv);
    expect(w.sentinelPath).toBe("C:\\asahi-worker\\update.flag");
  });
});

describe("model 구성(Opus 4.8 기본, 봇 설정 전용 — 워커는 더 이상 model 을 다루지 않는다)", () => {
  const base = { DISCORD_TOKEN: "t", DISCORD_OWNER_ID: "1", DATABASE_URL: "postgres://x" };
  it("loadConfig: 기본 모델은 claude-opus-4-8, ANTHROPIC_MODEL 로 재정의된다", () => {
    expect(loadConfig({ ...base } as NodeJS.ProcessEnv).model).toBe("claude-opus-4-8");
    expect(loadConfig({ ...base, ANTHROPIC_MODEL: "claude-sonnet-5" } as NodeJS.ProcessEnv).model).toBe("claude-sonnet-5");
  });
});

describe("정기 게시 채널 설정", () => {
  const base = { DATABASE_URL: "postgres://x", DISCORD_TOKEN: "d", DISCORD_OWNER_ID: "o" };

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

// Task 4(배선): 워커 신원이 WORKER_USER_ID(디스코드 사용자 ID 공유)에서 WORKER_ID(레지스트리에
// 등록된 워커 자신의 id)로 바뀐다 — register-worker 가 발급한 id 를 그대로 쓴다.
describe("워커 설정 — WORKER_ID", () => {
  const base = {
    DISCORD_OWNER_ID: "owner", WORKER_ID: "semicolon-shared",
    WORKER_TOKEN: "x".repeat(40), HUB_URL: "wss://h/worker", WORKER_ROOTS: "C:\\ws",
  };

  it("WORKER_ID 를 읽는다", () => {
    expect(loadWorkerConfig(base).workerId).toBe("semicolon-shared");
  });

  it("WORKER_ID 가 없으면 기동에 실패한다", () => {
    const { WORKER_ID, ...without } = base;
    expect(() => loadWorkerConfig(without)).toThrow(/WORKER_ID/);
  });

  it("옛 WORKER_USER_ID 만 있으면 실패한다 — 조용히 무시하지 않는다", () => {
    const { WORKER_ID, ...without } = base;
    expect(() => loadWorkerConfig({ ...without, WORKER_USER_ID: "123" })).toThrow(/WORKER_ID/);
  });
});

// Task 4: 워커 신원이 DB(workers 테이블)로 옮겨가면서, 봇 프로세스 자체는 더 이상 워커 인증에 쓸
// 공유 비밀을 가질 필요가 없다 — 허브가 접속마다 레지스트리(WorkersRepo)를 조회해 해시를 비교한다.
describe("봇 설정 — WORKER_TOKEN 제거", () => {
  it("WORKER_TOKEN 없이도 봇 설정이 로드된다(워커 신원은 이제 DB 에 있다)", () => {
    const cfg = loadConfig({
      DISCORD_TOKEN: "t", DISCORD_OWNER_ID: "o", DATABASE_URL: "postgres://x",
    });
    expect(cfg.ownerId).toBe("o");
    expect("workerToken" in cfg).toBe(false);
  });
});
