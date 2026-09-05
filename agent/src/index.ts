import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import dotenv from "dotenv";
import { WebSocketServer } from "ws";
import { loadConfig } from "./config.js";
import { WorkerHub, MAX_FRAME_CHARS, type HubSocket } from "./remote/hub.js";
import { EventBus } from "./events/bus.js";
import { openDb } from "./store/db.js";
import { UsersRepo } from "./store/usersRepo.js";
import { ConversationsRepo } from "./store/conversationsRepo.js";
import { ParticipantsRepo } from "./store/participantsRepo.js";
import { MessagesRepo } from "./store/messagesRepo.js";
import { SummariesRepo } from "./store/summariesRepo.js";
import { MemoriesRepo } from "./store/memoriesRepo.js";
import { ProjectsRepo } from "./store/projectsRepo.js";
import { PullRequestsRepo } from "./store/pullRequestsRepo.js";
import { TurnsRepo } from "./store/turnsRepo.js";
import { AllowedDirsRepo } from "./store/allowedDirsRepo.js";
import { ActionsRepo } from "./store/actionsRepo.js";
import { WorkersRepo } from "./store/workersRepo.js";
import { SettingsRepo } from "./store/settingsRepo.js";
import { IntrospectRepo } from "./store/introspectRepo.js";
import { AgentCore } from "./core/core.js";
import { makeRunAgentTurn } from "./core/agent.js";
import { DigestRunner, DIGEST_TOPICS, type DigestTopic } from "./core/digest.js";
import { decideMissingAlerts, type SeenState } from "./core/staleWorker.js";
import { PrTracker } from "./core/prTracker.js";
import { DiscordAdapter } from "./adapters/discord.js";
import { makeJobTokenMinter, newJobTokenSecret } from "./core/jobToken.js";
import { makeFileReturnHandler, FILE_RETURN_PATH } from "./core/fileReturn.js";
import { makeLlmProxyHandler, LLM_PROXY_PREFIX } from "./core/llmProxy.js";
import { defaultRunGit, resolveBotVersion } from "./remote/gitCommit.js";
import { EXIT_CODE_UPDATE } from "./remote/workerShutdown.js";

// 비밀값(.env)은 리포 루트(agent/ 바깥, data/ 와 같은 위치)에서 읽는다.
dotenv.config({ path: path.resolve("..", ".env") });
dotenv.config();

// FIX2(중요, 머지 전 리뷰): 정기 게시 채널 접근 불가를 경고할 때 env 변수 이름을 콕 집어 알리기
// 위한 매핑. config.ts 의 digestChannels 조립(DIGEST_CONTEST_CHANNEL_ID/DIGEST_DEVNEWS_CHANNEL_ID)과
// 짝을 맞춘다 — 이 상수 자체는 고정된 두 키(DigestTopic)로만 인덱싱되므로 사용자 입력과 무관하다.
const DIGEST_CHANNEL_ENV_VAR: Record<DigestTopic, string> = {
  contest: "DIGEST_CONTEST_CHANNEL_ID",
  devnews: "DIGEST_DEVNEWS_CHANNEL_ID",
};

async function main() {
  const config = loadConfig();
  // 봇 자기 커밋·브랜치(runtime_info 용). 미니PC 단일 호스트(1단계)에서는 git 에서, Railway 에서는 주입 변수에서
  // 온다 — remote/gitCommit.ts 의 resolveBotVersion. 기동 시 한 번만 읽는다(갱신은 재시작을 동반한다).
  const botVersion = await resolveBotVersion(process.env, defaultRunGit);

  const db = await openDb(config.databaseUrl);

  const users = new UsersRepo(db);
  const conversations = new ConversationsRepo(db);
  const allowedDirs = new AllowedDirsRepo(db);
  const repos = {
    users,
    conversations,
    participants: new ParticipantsRepo(db),
    messages: new MessagesRepo(db),
    summaries: new SummariesRepo(db),
    memories: new MemoriesRepo(db),
    turns: new TurnsRepo(db),
    projects: new ProjectsRepo(db),
    pullRequests: new PullRequestsRepo(db),
    allowedDirs,
    introspect: new IntrospectRepo(db),
    workers: new WorkersRepo(db),
    actions: new ActionsRepo(db),
  };
  // 소유자를 users(owner)로 보장 — 게이트 통과 기본값.
  await users.upsert(config.ownerId, { role: "owner" });

  // 워커 허브: 워커가 아웃바운드로 붙는 유일한 표면. Task 4: 봇 전체가 공유하던 단일 토큰 대신,
  // workers 테이블(레지스트리)에서 워커별 해시 토큰을 조회해 인증한다(hub.ts 의 WorkerRegistry) —
  // 인증을 통과하지 못하면 즉시 끊는다.
  const hub = new WorkerHub({ registry: repos.workers });

  const bus = new EventBus();

  // 파일 반환(2026-09-05, 풀 하네스 0단계): 워커의 send_file 이 파일 바이트를 올리는 POST /files. 인증은 작업
  // 토큰 — 부팅마다 난수 비밀로 이 프로세스가 발급(아래 makeRunAgentTurn 으로 내려간다)하고 같은 인스턴스가
  // 검증한다(core/jobToken.ts). 받은 바이트는 디스크에 쓰지 않고 assistant_file 이벤트로 어댑터에 넘긴다.
  const jobTokens = makeJobTokenMinter(newJobTokenSecret());
  const fileReturn = makeFileReturnHandler({ verify: (t) => jobTokens.verify(t), publish: (e) => bus.publish(e), now: Date.now });
  // 인증 프록시(풀 하네스 2단계): 세션 러너의 Claude Code 가 ANTHROPIC_BASE_URL 로 삼는 /llm. 같은 작업 토큰으로 인증하고
  // 진짜 구독 OAuth 를 끼운다(core/llmProxy.ts). 자격증명은 이 프로세스(계정 A)의 .env 에만 있다.
  const llmProxy = makeLlmProxyHandler({ verify: (t) => jobTokens.verify(t), credential: () => config.claudeOauthToken });
  const harnessOwner = config.harnessOwner === true;
  if (harnessOwner) console.log("[index] HARNESS_OWNER=true — 소유자 턴은 harness 모드 워커의 세션 러너로 보냅니다.");

  // FIX9(사소): 예전엔 모든 경로·메서드에 무조건 200 "ok" 를 돌려줘, 이 서버가 뭘 하는 프로세스인지
  // 외부에서 스캔하기 쉬웠다. 헬스체크 전용 경로만 응답하고 나머지는 404 한다 — /worker 는 ws 가
  // 'upgrade' 이벤트로 별도 처리하므로(아래 wss) 이 제한과 무관하게 그대로 동작한다.
  const HEALTH_PATH = "/health";
  const httpServer = http.createServer((req, res) => {
    if (req.method === "GET" && req.url === HEALTH_PATH) {
      res.writeHead(200);
      res.end("ok");
      return;
    }
    // 파일 반환 엔드포인트 — 토큰 없는 요청은 본문을 읽기 전에 401 로 끊는다(core/fileReturn.ts).
    if (req.method === "POST" && req.url === FILE_RETURN_PATH) {
      void fileReturn(req, res);
      return;
    }
    // 인증 프록시 — 경로 허용 목록·토큰 검증은 핸들러 안에서(core/llmProxy.ts).
    if (req.url !== undefined && (req.url === LLM_PROXY_PREFIX || req.url.startsWith(`${LLM_PROXY_PREFIX}/`))) {
      llmProxy(req, res);
      return;
    }
    res.writeHead(404);
    res.end();
  });
  // FIX9: listen 실패(예: EADDRINUSE)는 'error' 이벤트로만 알려진다 — 리스너가 없으면 main() 의
  // 프로미스 체인 밖에서 uncaught exception 으로 튀어 올라, 운영자가 원인 없는 스택트레이스만
  // 보게 된다. 다른 시작 실패와 같은 문구로 남겨 로그를 일관되게 한다.
  httpServer.on("error", (err) => {
    console.error("시작 실패:", err);
    process.exit(1);
  });

  // FIX4(중요): ws 의 기본 maxPayload(100MiB)를 그대로 두면, 인증조차 안 된 클라이언트가 보낸
  // 거대한 프레임을 전송 계층이 이미 다 "버퍼링한 뒤"에야 hub.ts 의 MAX_FRAME_CHARS 검사가
  // 실행돼 방어가 너무 늦다. maxPayload(바이트 상한)를 여기서 지정해 그 크기를 넘는 프레임을
  // 버퍼링 전에 전송 계층이 끊게 한다. hub.ts 와 값을 공유해(export 된 상수) 두 상수가 갈리지
  // 않게 한다.
  const wss = new WebSocketServer({ server: httpServer, path: "/worker", maxPayload: MAX_FRAME_CHARS });
  wss.on("error", (err) => {
    console.error("[허브] 서버 오류:", err instanceof Error ? err.message : err);
  });
  wss.on("connection", (ws) => {
    // FIX1(치명): ws 는 프로토콜 오류(예: 마스킹 안 된 클라이언트 프레임)에서 'error' 를 emit
    // 하는데, 리스너가 하나도 없으면 EventEmitter 가 그 오류를 그냥 던진다 — 인증조차 안 한
    // 클라이언트가 프레임 3바이트만 잘못 보내도(Invalid WebSocket frame: MASK must be set)
    // 프로세스 전체가 죽는다(리뷰 재현). 로그만 남기고 닫는다(다시 던지지 않는다).
    ws.on("error", (err) => {
      console.error("[허브] 소켓 오류(닫음):", err instanceof Error ? err.message : err);
      try { ws.close(); } catch { /* 이미 닫혔으면 무시 */ }
    });
    // ws → HubSocket 어댑터. 허브는 ws 를 직접 알지 못한다(테스트 가능성 유지).
    const socket: HubSocket = {
      send: (d) => ws.send(d),
      close: () => ws.close(),
      onMessage: (cb) => ws.on("message", (data) => cb(data.toString())),
      onClose: (cb) => ws.on("close", cb),
    };
    hub.handleConnection(socket);
  });
  // HUB_BIND(1단계, 미니PC 단일 호스트): 주면 그 주소에만 묶는다(미니PC 는 127.0.0.1 — 같은 기계의 워커만 루프백으로
  // 붙고 밖에서는 포트가 보이지 않는다). 없으면 지금까지처럼 listen(port) 그대로다 — Railway 가 IPv6 사설망으로
  // 닿으므로 여기서 0.0.0.0 을 기본값으로 쓰면 그쪽이 깨진다(config.ts 의 hubBind 주석).
  const onListening = () => console.log(`워커 허브 대기 중: 포트 ${config.httpPort}${config.hubBind ? ` (바인드 ${config.hubBind})` : ""}`);
  if (config.hubBind) httpServer.listen(config.httpPort, config.hubBind, onListening);
  else httpServer.listen(config.httpPort, onListening);

  // 에이전트 cwd 는 소스가 아닌 데이터 영역에 둔다 — 에이전트가 소스 트리를 훑지 않도록(1단계 점검 지적).
  const agentCwd = path.resolve(config.dataDir, "..", "agent-cwd");
  fs.mkdirSync(agentCwd, { recursive: true });
  const runTurn = makeRunAgentTurn({ memories: repos.memories, users: repos.users, allowedDirs: repos.allowedDirs, introspect: repos.introspect, projects: repos.projects, pullRequests: repos.pullRequests }, config.deployTarget, config.model, repos.workers, hub, config.github, Date.now, { jobTokens, botVersion, harness: { enabled: harnessOwner } });

  // 정기 게시(조사) 실행기. runTurn·agentCwd 는 core 와 동일한 것을 공유한다 —
  // 별도 프로세스가 아니라 같은 봇 안에서 같은 방식으로 LLM 턴을 돌리는 또 하나의 진입점이다.
  const digest = new DigestRunner({
    runTurn, bus, settings: new SettingsRepo(db), agentCwd,
    channels: config.digestChannels,
  });

  // PR 추적(2026-09-05): 봇이 만든 PR 의 CI 결과·병합을 그 PR 을 낸 대화 채널에, 새 PR 을 운영자에게
  // 알린다(core/prTracker.ts). 아래 1분 타이머에 얹는다 — 타이머를 새로 만들지 않는다.
  const prTracker = new PrTracker({
    pullRequests: repos.pullRequests, conversations, users, bus,
    github: config.github, ownerId: config.ownerId, notifyChannelId: config.prNotifyChannelId,
  });

  // FIX3(최종 리뷰): core.ts 도 hub 를 받아 능력 안내(persona.ts)에 "이번 턴에 워커가 실제로
  // 연결돼 있는가"를 반영한다(agent.ts 의 resolveTurnWorker 와 같은 판정, 같은 hub 인스턴스).
  // registry(Task 7): resolveTurnWorker 가 hub.isConnected 를 부르기 전에 실제 workerId 를
  // 찾는 데 쓴다 — repos.workers 를 makeRunAgentTurn 과 동일하게 그대로 넘긴다.
  const core = new AgentCore({ bus, config, runTurn, repos, agentCwd, hub, registry: repos.workers, digest });
  core.start();

  const discord = new DiscordAdapter({ bus, config, users, conversations });
  await discord.start();

  // 정기 게시 채널 설정 로그 + FIX2(중요, 머지 전 리뷰): 로그인 이후로 옮겨, 설정된 채널마다
  // 봇이 실제로 접근할 수 있는지(canReachChannel) 확인한다 — 로그인 전에는 channels.fetch 자체가
  // 실패해 여기서 확인할 수 없다. 채널 ID 오타·권한 누락은 이 확인이 없으면 매 조사 성공 뒤
  // 전송 실패로만 나타나(discord.ts 의 send() catch) 로그 한 줄에 묻힌다 — 사용자는 리다이렉트
  // 안내("...에 올리겠습니다")를 받고 기다리다가 그냥 아무것도 못 받는다. 일시적으로 못 보는 채널
  // 때문에 봇 전체가 멈추면 안 되므로 치명적으로 취급하지 않는다(경고만 남기고 계속 진행).
  for (const topic of Object.keys(DIGEST_TOPICS) as DigestTopic[]) {
    const channelId = config.digestChannels[topic];
    if (!channelId) {
      console.log(`[index] 정기 게시 ${topic}: 채널 미설정 — 스케줄 건너뜀`);
      continue;
    }
    console.log(`[index] 정기 게시 ${topic}: 채널 ${channelId}`);
    if (!(await discord.canReachChannel(channelId))) {
      console.warn(
        `[index] 정기 게시 채널에 접근할 수 없습니다 — ${DIGEST_CHANNEL_ENV_VAR[topic]}=${channelId}. ` +
          `채널 ID 가 올바른지, 봇이 그 채널을 볼 권한이 있는지 확인하세요.`,
      );
    }
  }

  // PR 알림 채널도 정기 게시 채널과 같은 이유로 기동 시 한 번 확인한다 — 잘못된 ID 는 그러지 않으면
  // 새 PR 마다 전송 실패 로그 한 줄로만 드러난다.
  if (config.prNotifyChannelId) {
    console.log(`[index] PR 알림 채널: ${config.prNotifyChannelId}`);
    if (!(await discord.canReachChannel(config.prNotifyChannelId))) {
      console.warn(
        `[index] PR 알림 채널에 접근할 수 없습니다 — PR_NOTIFY_CHANNEL_ID=${config.prNotifyChannelId}. ` +
          `채널 ID 가 올바른지, 봇이 그 채널을 볼 권한이 있는지 확인하세요.`,
      );
    }
  }

  await core.recoverPending(); // 크래시로 남은 미처리 메시지 재개

  // 유휴 세션 정리 + 정기 게시 확인 + PR 추적: 1분마다 같은 타이머에서 함께 확인한다(타이머를 새로 만들지 않는다).
  const idleTimer = setInterval(() => {
    void core.closeIdleConversations().catch((err) => console.error("[core] 유휴 정리 오류:", err));
    void digest.checkAndRun().catch((err) => console.error("[digest] 스케줄 확인 오류:", err));
    void prTracker.tick().catch((err) => console.error("[prTracker] 확인 오류:", err));
  }, 60 * 1000);

  // 붙어 있던 워커가 사라지면 소유자에게 알린다(2026-08-01: 그 상태로 13시간 반이 지나갔다).
  // 주기는 조각 B 의 자동 갱신 폴링(5분)과 맞춘다 — 그보다 자주 봐야 할 이유가 없다.
  //
  // 2026-09-03: 같은 타이머에서 돌던 낡음 판정(decideStaleAlerts)은 제거됐다 — 봇 커밋과 워커
  // 커밋이 서로 다른 갈래라 대조 자체가 성립하지 않았고, 그래서 배포마다 거짓 경보가 나갔다
  // (사정은 core/staleWorker.ts 머리말). 이제 이 타이머가 보는 것은 부재 하나뿐이다.
  const seenState: SeenState = new Map();
  const staleTimer = setInterval(() => {
    // FIX(최종 리뷰): decideMissingAlerts 자체가 던지면(예: workersInfo() 가 이 함수의 전제와
    // 어긋나는 값을 주는 경우) 그 예외는 setInterval 콜백 안이라 동기적으로 튀어 오르고, 아래
    // .catch() 는 findDmFor 이후의 프로미스 체인만 덮으므로 이 예외를 잡지 못한다 — 잡는 사람이
    // 없으면 uncaught exception 으로 24/7 봇 프로세스 전체가 죽는다. 그래서 이 콜백 전체를
    // try/catch 로 감싼다: 어떤 예외든 로그만 남기고 다음 5분 주기를 그대로 이어간다.
    try {
      const now = Date.now();
      const info = hub.workersInfo();
      const alerts = [
        ...decideMissingAlerts({
          connected: info.map((w) => w.workerId),
          now,
          seen: seenState,
          thresholdMs: 15 * 60_000,
        }),
      ];
      if (alerts.length === 0) return;
      // findDmFor 자체의 실패(DB 오류 등)가 setInterval 콜백 밖에서 unhandled rejection 으로
      // 튀어 봇 전체를 죽이지 않도록 catch 한다 — 이 파일의 다른 타이머 콜백과 같은 방어.
      void conversations
        .findDmFor(config.ownerId)
        .then((conv) => {
          for (const text of alerts) {
            if (conv === null) { console.error("[stale]", text); continue; }
            bus.publish({ type: "system_notice", channel: "discord", channelRef: conv.discordChannelId, text, ts: Date.now() });
          }
        })
        .catch((err) => console.error("[stale] 알림 발송 오류:", err));
    } catch (err) {
      console.error("[stale] 판정 오류:", err);
    }
  }, 5 * 60_000);

  // 두 번 들어오지 않게 막는다 — 센티넬(아래)과 시그널이 겹치거나 시그널이 연타되면 drain·stop 이 중복 실행된다.
  let shuttingDown = false;
  const shutdown = async (exitCode = 0) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log("종료 중...");
    clearInterval(idleTimer);
    clearInterval(staleTimer);
    await core.drain();     // 처리 중인 메시지를 마저 끝내고
    await discord.stop();   // 체인에 남은 전송을 흘려보낸 뒤 클라이언트 종료
    // FIX3(중요): 인증 전(hello 대기 중) 소켓은 hub.conns 에 없어 hub.closeAll() 이 원래 놓쳤다 —
    // 그 상태로 아무 말도 안 하는 연결 하나가 httpServer.close() 의 콜백을 영원히 막아, SIGTERM
    // 뒤 db.end() 전에 셧다운이 멈추고 플랫폼이 SIGKILL 로 pg 풀·디스코드 큐를 강제로 날렸다
    // (리뷰 재현: 4초 안에 콜백이 안 옴). wss.close() 로 새 연결 수신을 먼저 멈추고(지금 붙어
    // 있는 연결은 안 끊는다 — ws 문서: options.server 로 만든 서버는 close() 가 리스너만 뗀다),
    // hub.closeAll() 이 인증 전 소켓까지 포함해 전부 닫아야 아래 httpServer.close() 콜백이 온다.
    wss.close();
    hub.closeAll();
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    await db.end();         // pg Pool 연결 정리
    process.exit(exitCode);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());

  // 자동 갱신 센티넬(1단계, 미니PC 단일 호스트). 워커(worker.ts)와 같은 방식이다 — 파일이 생기면 진행 중인 턴을
  // 마치고(shutdown 의 core.drain) 스스로 내려간다. deploy/update-service.ps1 이 그 파일을 만들고, 프로세스가
  // 사라진 뒤 갱신하고, Start-ScheduledTask 로 다시 띄운다. 종료 코드는 워커와 같은 EXIT_CODE_UPDATE(10) —
  // 작업 스케줄러의 LastTaskResult 에서 "사람이 내린 것(0)"과 구별된다. 옵트인: BOT_SENTINEL 이 없으면(Railway·
  // 개인 PM2) 감시 자체를 하지 않는다. fs.watch 대신 주기 확인을 쓰는 이유도 worker.ts 와 같다(윈도우의 watch 는
  // 파일 생성에 대해 플랫폼마다 다르게 동작해 왔다 — 15초 지연은 5분 주기 업데이터에게 아무 문제가 아니다).
  if (config.sentinelPath !== undefined) {
    const sentinel = config.sentinelPath;
    const sentinelTimer = setInterval(() => {
      if (!fs.existsSync(sentinel)) return;
      clearInterval(sentinelTimer);
      console.log("갱신을 위해 봇을 종료합니다...");
      void shutdown(EXIT_CODE_UPDATE);
    }, 15_000);
  }

  console.log("상주 비서가 시작되었습니다.");
}

main().catch((err) => {
  console.error("시작 실패:", err);
  process.exit(1);
});
