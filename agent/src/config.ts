import path from "node:path";
import { isUnambiguousRoot } from "./remote/roots.js";
import type { DigestChannels } from "./core/digest.js";
import type { GithubAppConfig } from "./github/appToken.js";

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
  // Task 4: 워커 인증은 이제 봇의 공유 비밀(WORKER_TOKEN)이 아니라 workers 테이블(레지스트리)에서
  // 워커별로 조회한다 — 그래서 Config 에는 더 이상 토큰 필드가 없다(index.ts 가 WorkersRepo 를 hub 에 넘긴다).
  httpPort: number;      // 워커 허브 WS 를 붙일 HTTP 포트. Railway 는 PORT 를 주입한다.
  // 정기 게시 목적지. 주제별로 설정하며, 없는 주제는 스케줄에서 건너뛴다(예약어로는 실행 가능).
  digestChannels: DigestChannels;
  // 깃허브 발행 설정. 없으면 null 이고, 그때는 발행 도구가 아예 노출되지 않는다.
  github: GithubAppConfig | null;
  // PR 추적(2026-09-05): 봇이 만든 새 PR 을 운영자에게 알릴 채널. 없으면 소유자 DM 으로 간다 —
  // 선택값이라 비어 있어도 기동에 지장이 없다(core/prTracker.ts).
  prNotifyChannelId?: string;
};

// 깃허브 발행 설정. 개인키는 base64 한 줄로 받는다 — 줄바꿈이 든 PEM 은 .env 파서·배포
// 플랫폼·셸마다 다르게 다뤄져 조용히 망가지고, 깨진 키는 "인증 실패" 한 줄로만 드러나 원인을
// 엉뚱한 곳에서 찾게 된다(deploy/github-app-셋업.md §5).
//
// 넷 중 하나라도 없으면 null 이다 — 던지지 않는다. 발행은 부가 기능이므로 설정이 없다고 봇이
// 못 뜨면 안 된다(스킬 폴더가 없을 때 plugins 를 안 넘기는 것과 같은 원칙). 호출측은 null 을
// 보고 도구를 아예 노출하지 않는다.
function loadGithubConfig(env: NodeJS.ProcessEnv): GithubAppConfig | null {
  const org = env.GITHUB_ORG?.trim();
  const appId = env.GITHUB_APP_ID?.trim();
  const installationId = env.GITHUB_APP_INSTALLATION_ID?.trim();
  const b64 = env.GITHUB_APP_PRIVATE_KEY_B64?.trim();
  if (!org || !appId || !installationId || !b64) return null;

  // base64 가 깨져도 Buffer.from 은 던지지 않고 쓰레기를 돌려준다 — PEM 헤더로 검증한다.
  // 여기서 걸러내지 않으면 그 쓰레기가 crypto.sign 까지 가서 OpenSSL 오류로 나타나고, 사람은
  // "키가 잘못됐다"가 아니라 "깃허브가 거부했다"로 읽는다.
  const pem = Buffer.from(b64, "base64").toString("utf8");
  if (!pem.includes("PRIVATE KEY")) return null;
  return { org, appId, installationId, privateKeyPem: pem };
}

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
    model: env.ANTHROPIC_MODEL || "claude-opus-5",
    httpPort: positiveNumberEnv(env, "PORT", 3000),
    digestChannels: {
      ...(env.DIGEST_CONTEST_CHANNEL_ID ? { contest: env.DIGEST_CONTEST_CHANNEL_ID } : {}),
      ...(env.DIGEST_DEVNEWS_CHANNEL_ID ? { devnews: env.DIGEST_DEVNEWS_CHANNEL_ID } : {}),
    },
    github: loadGithubConfig(env),
    prNotifyChannelId: env.PR_NOTIFY_CHANNEL_ID || undefined,
  };
}

// 하이브리드 조각3 2단계(원격 워커) 전용 설정. 봇(loadConfig/Config)과 완전히 분리 —
// 워커는 이제 DB 도, 모델도, 세션도 다루지 않는다(Task 7: 판단·기억·세션은 전부 허브(봇) 쪽에 있고,
// 이 프로세스는 허브에 아웃바운드 WebSocket 을 열어 도구 호출을 받아 실행하는 얇은 클라이언트다).
export type WorkerConfig = {
  workerId: string;      // WORKER_ID — register-worker 가 발급한 이 워커 자신의 식별자. hello 로 보낼 신원
  workerToken: string;   // WORKER_TOKEN — 허브 인증
  hubUrl: string;        // HUB_URL — Railway 허브 WebSocket 주소(wss://.../worker)
  roots: string[];       // WORKER_ROOTS — 이 워커가 노출할 폴더(쉼표 구분). 최종 경로 관문의 기준
  // WORKER_SENTINEL — 이 경로에 파일이 생기면 워커가 한가해지는 대로 스스로 종료한다(Task 6).
  // 미설정이면 감시 자체를 하지 않는다(옵트인). 자동 갱신용이라 기본값이 없다 — 부원 PC 모두가
  // 이 기능을 쓰는 게 아니다.
  sentinelPath?: string;
};

// Task 4: 워커는 이제 소유자가 누구인지 알 필요가 없다(신원·권한 판단은 허브 쪽에 있다) —
// 그래서 DISCORD_OWNER_ID 는 워커 필수 목록에서 빠진다. 옛 WORKER_USER_ID(담당 사용자 공유)도
// WORKER_ID(레지스트리에 등록된 이 워커 자신의 id)로 교체된다 — 두 이름을 혼동해 옛 값만 넣고
// 조용히 통과하는 사고를 막기 위해 WORKER_ID 를 정확히 요구한다.
export function loadWorkerConfig(env: NodeJS.ProcessEnv = process.env): WorkerConfig {
  const missing = ["WORKER_ID", "WORKER_TOKEN", "HUB_URL", "WORKER_ROOTS"].filter((k) => !env[k]);
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
    workerId: env.WORKER_ID as string,
    workerToken: env.WORKER_TOKEN as string,
    hubUrl: env.HUB_URL as string,
    roots,
    sentinelPath: env.WORKER_SENTINEL || undefined,
  };
}
