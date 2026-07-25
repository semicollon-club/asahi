import path from "node:path";
import { isUnambiguousRoot } from "./remote/roots.js";

// 숫자 환경변수를 파싱·검증한다. 값이 없으면 기본값, 있으면 양의 유한수여야 하며
// 아니면(오타·0 등) 시작 시점에 명확히 실패한다 — NaN 으로 봇이 조용히 먹통 되는 것을 막는다.
function positiveNumberEnv(env: NodeJS.ProcessEnv, key: string, def: number): number {
  const raw = env[key];
  if (raw === undefined || raw === "") return def;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(`환경변수 ${key} 는 양의 숫자여야 합니다 (현재 값: "${raw}")`);
  }
  return n;
}

export type Config = {
  discordToken: string;
  ownerId: string;
  channelId?: string;
  databaseUrl: string;
  dataDir: string;
  memoryDir: string;
  sessionIdleMinutes: number;
  maxTurnsPerHour: number;
  // 멀티유저 한도(2B): 코어는 이 3개를 사용한다. maxTurnsPerHour 는 하위호환용으로 남긴다.
  maxTurnsPerHourPerUser: number; // 유저별 시간당 상한 (기본 20)
  maxTurnsPerHourGlobal: number;  // 전역 시간당 상한 (기본 40)
  ownerReserve: number;           // (현재 미사용) 소유자는 무제한 정책이라 예약 불필요 — 하위호환 위해 로드만 유지
  // 배포 대상(Railway 조각2): cloud 는 소유자 PC 가 없는 컨테이너 실행을 뜻하며, PC 도구(파일/Bash)를 비활성한다.
  // 기본은 local(기존 동작 그대로). DEPLOY_TARGET 값이 정확히 "cloud" 일 때만 cloud, 그 외(미설정·오타)는 local.
  deployTarget: "local" | "cloud";
  model: string;
  // 하이브리드 조각3 2단계(원격 워커): 봇은 워커가 아웃바운드로 붙는 허브(WorkerHub)를 이 포트에 띄운다.
  workerToken: string;   // 워커 인증 토큰(WORKER_TOKEN). 워커 쪽과 같은 값이어야 한다.
  httpPort: number;      // 워커 허브 WS 를 붙일 HTTP 포트. Railway 는 PORT 를 주입한다.
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const missing = ["DISCORD_TOKEN", "DISCORD_OWNER_ID", "DATABASE_URL"].filter((k) => !env[k]);
  if (missing.length > 0) {
    throw new Error(`환경변수 누락: ${missing.join(", ")} — .env 파일을 확인하세요 (.env.example 참고)`);
  }
  // 런타임 데이터의 기본 경로는 앱(agent/) 바깥, 리포 루트의 data/ 아래에 둔다.
  // cwd 는 agent/ (npm 스크립트와 PM2 cwd 기준). DATA_DIR / MEMORY_DIR 로 재정의 가능.
  return {
    discordToken: env.DISCORD_TOKEN as string,
    ownerId: env.DISCORD_OWNER_ID as string,
    channelId: env.DISCORD_CHANNEL_ID || undefined,
    databaseUrl: env.DATABASE_URL as string,
    dataDir: env.DATA_DIR || path.resolve("..", "data", "store"),
    memoryDir: env.MEMORY_DIR || path.resolve("..", "data", "memory"),
    sessionIdleMinutes: positiveNumberEnv(env, "SESSION_IDLE_MINUTES", 30),
    maxTurnsPerHour: positiveNumberEnv(env, "MAX_TURNS_PER_HOUR", 30),
    maxTurnsPerHourPerUser: positiveNumberEnv(env, "MAX_TURNS_PER_HOUR_PER_USER", 20),
    maxTurnsPerHourGlobal: positiveNumberEnv(env, "MAX_TURNS_PER_HOUR_GLOBAL", 40),
    ownerReserve: positiveNumberEnv(env, "OWNER_RESERVE", 10),
    deployTarget: env.DEPLOY_TARGET === "cloud" ? "cloud" : "local",
    model: env.ANTHROPIC_MODEL || "claude-opus-4-8",
    workerToken: env.WORKER_TOKEN || "",
    httpPort: positiveNumberEnv(env, "PORT", 3000),
  };
}

// 하이브리드 조각3 2단계(원격 워커) 전용 설정. 봇(loadConfig/Config)과 완전히 분리 —
// 워커는 이제 DB 도, 모델도, 세션도 다루지 않는다(Task 7: 판단·기억·세션은 전부 허브(봇) 쪽에 있고,
// 이 프로세스는 허브에 아웃바운드 WebSocket 을 열어 도구 호출을 받아 실행하는 얇은 클라이언트다).
export type WorkerConfig = {
  ownerId: string;       // DISCORD_OWNER_ID — hello 로 보낼 신원
  workerUserId: string;  // WORKER_USER_ID — 이 워커가 담당하는 사용자
  workerToken: string;   // WORKER_TOKEN — 허브 인증
  hubUrl: string;        // HUB_URL — Railway 허브 WebSocket 주소(wss://.../worker)
  roots: string[];       // WORKER_ROOTS — 이 워커가 노출할 폴더(쉼표 구분). 최종 경로 관문의 기준
};

export function loadWorkerConfig(env: NodeJS.ProcessEnv = process.env): WorkerConfig {
  const missing = ["DISCORD_OWNER_ID", "WORKER_USER_ID", "WORKER_TOKEN", "HUB_URL", "WORKER_ROOTS"].filter((k) => !env[k]);
  if (missing.length > 0) {
    throw new Error(`환경변수 누락: ${missing.join(", ")} — .env 파일을 확인하세요 (.env.example 참고)`);
  }
  const roots = (env.WORKER_ROOTS as string).split(",").map((s) => s.trim()).filter((s) => s.length > 0);
  if (roots.length === 0) throw new Error("WORKER_ROOTS 에 폴더가 하나도 없습니다.");
  // 보정 2: remote/roots.ts 의 checkPath 가 요구하는 것과 동일한 "모호하지 않은 절대경로" 기준을
  // 여기서도 적용한다(같은 판정 함수를 재사용 — 기준이 갈리면 config 는 통과했는데 실제 호출은
  // 전부 거부하는 워커가 조용히 뜬다). 상대경로는 물론, 윈도우에서 드라이브 문자·UNC 없이
  // 구분자로만 시작하는 경로도 여기서 걸러진다.
  const badRoots = roots.filter((r) => !isUnambiguousRoot(r));
  if (badRoots.length > 0) {
    throw new Error(
      `WORKER_ROOTS 에 절대경로가 아닌 항목이 있습니다(윈도우는 드라이브 문자·UNC 필요): ${badRoots.join(", ")}`,
    );
  }
  return {
    ownerId: env.DISCORD_OWNER_ID as string,
    workerUserId: env.WORKER_USER_ID as string,
    workerToken: env.WORKER_TOKEN as string,
    hubUrl: env.HUB_URL as string,
    roots,
  };
}
