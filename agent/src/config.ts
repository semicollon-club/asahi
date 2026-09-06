import path from "node:path";
import { isUnambiguousRoot } from "./remote/roots.js";
import type { WorkerMode } from "./remote/protocol.js";
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

// 0 을 허용한다(끄기용) — 3단계 토큰 창 상한처럼 "0 이면 비활성" 을 뜻하는 값에 쓴다.
function nonNegativeNumberEnv(env: NodeJS.ProcessEnv, key: string, def: number): number {
  const raw = env[key];
  if (raw === undefined || raw === "") return def;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) {
    throw new Error(`환경변수 ${key} 는 0 이상의 숫자여야 합니다 (현재 값: "${raw}")`);
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
  // 미니PC 단일 호스트 1단계(2026-09-05): 허브(/worker)·/files 를 붙일 주소. 없으면 지금까지처럼
  // listen(port) — Node 기본(모든 인터페이스, IPv6 포함)이다. 기본값을 0.0.0.0 으로 박지 않는 이유: Railway 는
  // IPv6 사설망으로 컨테이너에 닿으므로 IPv4 전용 바인드는 그쪽 배포를 깨뜨린다. 미니PC 는 127.0.0.1 로 묶어
  // 같은 기계의 워커(계정 B)만 루프백으로 붙게 하고 밖에서는 포트 자체가 보이지 않게 한다(설계 §3·§9).
  hubBind?: string;
  // 봇 자동 갱신 센티넬(BOT_SENTINEL). 워커의 WORKER_SENTINEL 과 같은 방식·같은 옵트인 — 파일이 생기면 봇이
  // 진행 중인 턴을 마치고 스스로 내려가고, deploy/update-service.ps1 이 갱신한 뒤 다시 띄운다.
  sentinelPath?: string;
  // 풀 하네스 2단계(2026-09-05 밤): 인증 프록시(/llm)가 끼울 구독 OAuth 토큰. SDK 도 같은 변수를 읽어 봇 자기 세션에 쓴다.
  // 없으면 프록시는 503 을 낸다(봇 자기 세션은 SDK 가 따로 실패한다). 값은 로그·오류 문구 어디에도 싣지 않는다.
  claudeOauthToken?: string;
  // 소유자 턴을 세션 러너(계정 B 의 Claude Code)로 보내는 플래그. 정확히 "true" 일 때만 — 되돌리기는 이 값을 지우는 것이다.
  // 선택 필드인 이유: Config 리터럴을 만드는 테스트 픽스처가 여럿이라, 없으면 false 로 읽는다(index.ts 는 === true 로 본다).
  harnessOwner?: boolean;
  // 부원별 창 상한(3단계 3.3). 한 부원이 창(llmTokenWindowMs) 안에 이 토큰 수(입력+출력)에 닿으면 새 하네스
  // 턴을 거절한다 — 구독 5시간 창을 부원끼리 나누는 공정 분배(turnsRepo.reserve 와 같은 축, llm_usage 합산).
  // 소유자는 이 게이트를 거치지 않는다(소유자 우선). 0 이면 비활성. 부원 미개방(5단계) 전까지는 실질적으로
  // 걸릴 일이 없으나, 열기 전에 값이 자리에 있어야 한다 — 실제 값은 운영자가 미니PC 로 튜닝한다.
  // 선택 필드인 이유는 harnessOwner 와 같다: Config 리터럴을 만드는 테스트 픽스처가 여럿이라, 없으면
  // 코어가 비활성(0)·기본 창으로 읽는다. loadConfig 는 항상 채운다.
  maxLlmTokensPerWindowPerUser?: number;
  llmTokenWindowMs?: number;
  // 하네스 능력 안내에 로컬 브라우저 MCP(4단계 4.3)를 알릴지. 봇은 워커의 설치 상태를 모르므로, 운영자가 워커에
  // BROWSER_MCP_COMMAND 를 넣고 브라우저를 설치했을 때 이 플래그를 함께 켠다 — 안내와 실제 도구가 어긋나지 않게.
  // 정확히 "true" 일 때만. 실제 도구를 붙이는 것은 워커의 browserMcp 다(이 플래그는 페르소나 문구만 켠다).
  harnessBrowser?: boolean;
  // 기억 백업(부원 오픈 게이트 2D). 공용 기억은 부원이 쌓는 유일한 복구 불가 데이터인데 앱 차원의 내보내기
  // 경로가 없었다. 봇이 주기마다 기억 전체를 JSON 으로 이 폴더에 쓰고 `backups` 표에 남긴다.
  // 선택 필드인 이유는 harnessOwner 와 같다(Config 리터럴 픽스처가 여럿) — 없으면 코어가 기본값으로 읽는다.
  backupDir?: string;
  backupKeep?: number;
  backupIntervalMs?: number;
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
    hubBind: env.HUB_BIND?.trim() || undefined,
    sentinelPath: env.BOT_SENTINEL || undefined,
    claudeOauthToken: env.CLAUDE_CODE_OAUTH_TOKEN?.trim() || undefined,
    harnessOwner: env.HARNESS_OWNER === "true",
    maxLlmTokensPerWindowPerUser: nonNegativeNumberEnv(env, "MAX_LLM_TOKENS_PER_WINDOW_PER_USER", 1_500_000),
    llmTokenWindowMs: positiveNumberEnv(env, "LLM_TOKEN_WINDOW_HOURS", 5) * 60 * 60 * 1000,
    harnessBrowser: env.HARNESS_BROWSER === "true",
    backupDir: env.BACKUP_DIR?.trim() || path.join(env.DATA_DIR || path.resolve("..", "data", "store"), "backups"),
    backupKeep: nonNegativeNumberEnv(env, "BACKUP_KEEP", 14),
    backupIntervalMs: positiveNumberEnv(env, "BACKUP_INTERVAL_HOURS", 24) * 60 * 60 * 1000,
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
  // 풀 하네스 2단계(2026-09-05 밤): WORKER_MODE. tools(기본)는 지금까지의 얇은 워커, harness 는 그 위에 세션 러너
  // (remote/sessionRunner.ts)를 켠다 — 도구 실행기는 두 모드 모두 그대로 돈다(전환 기간 공존). hello 의 mode 로 봇에 알린다.
  mode: WorkerMode;
  // WORKER_SESSION_DIR — 부원별 CLAUDE_CONFIG_DIR 의 루트. 없으면 러너가 사용자 프로필 아래 기본 위치를 쓴다(worker.ts).
  sessionDir?: string;
  // 로컬 브라우저 MCP(4단계 4.3). BROWSER_MCP_COMMAND 가 있으면 하네스 세션에 stdio 브라우저 MCP 를 붙인다 — 계정 B 에
  // 설치된 Playwright MCP 등으로, 비밀이 없다(로컬). 없으면 안 붙인다(설치 전엔 우아하게 없음). 패키지에 하드코딩하지
  // 않는다: 운영자가 명령·인자를 그대로 정한다(예: command="npx", args="-y @playwright/mcp@latest --headless --output-dir C:\asahi-workspace").
  browserMcp?: { command: string; args: string[] };
  // 운영자가 계정 B 에 설치한 Claude Code 플러그인 디렉터리들(4단계 4.4). HARNESS_PLUGIN_DIRS(쉼표 구분)로 준다. 번들
  // 스킬 플러그인에 더해 하네스 세션에 로컬 플러그인으로 얹는다 — 없으면 번들만(옛 동작). 존재하지 않는 경로는 건너뛴다.
  harnessPluginDirs: string[];
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
  // 오타를 조용히 tools 로 떨어뜨리지 않는다 — "harnes" 라고 적은 워커가 도구 모드로 떠서 봇이 영원히 옛 경로만 타는
  // 것은 증상이 없어 오래 간다.
  const modeRaw = env.WORKER_MODE?.trim() || "tools";
  if (modeRaw !== "tools" && modeRaw !== "harness") {
    throw new Error(`WORKER_MODE 는 tools 또는 harness 여야 합니다 (현재 값: "${modeRaw}")`);
  }
  return {
    workerId: env.WORKER_ID as string,
    workerToken: env.WORKER_TOKEN as string,
    hubUrl: env.HUB_URL as string,
    roots,
    sentinelPath: env.WORKER_SENTINEL || undefined,
    mode: modeRaw,
    sessionDir: env.WORKER_SESSION_DIR || undefined,
    // 인자는 공백으로 나눈다(개별 인자에 공백이 있으면 래퍼 스크립트로 감싸도록 안내한다 — 흔치 않다).
    browserMcp: env.BROWSER_MCP_COMMAND?.trim()
      ? { command: env.BROWSER_MCP_COMMAND.trim(), args: (env.BROWSER_MCP_ARGS ?? "").split(/\s+/).filter((s) => s.length > 0) }
      : undefined,
    // 경로는 쉼표로 나눈다(윈도우 경로에 쉼표는 없다). 존재 확인은 worker.ts 가 fs 로 한 번 한다.
    harnessPluginDirs: (env.HARNESS_PLUGIN_DIRS ?? "").split(",").map((s) => s.trim()).filter((s) => s.length > 0),
  };
}
