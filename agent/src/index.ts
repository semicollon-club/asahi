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
import { TurnsRepo } from "./store/turnsRepo.js";
import { AllowedDirsRepo } from "./store/allowedDirsRepo.js";
import { WorkersRepo } from "./store/workersRepo.js";
import { SettingsRepo } from "./store/settingsRepo.js";
import { IntrospectRepo } from "./store/introspectRepo.js";
import { CharacterImagesRepo } from "./store/characterImagesRepo.js";
import { backfillLegacyAllowedDirs } from "./store/allowedDirsMigration.js";
import { AgentCore } from "./core/core.js";
import { makeRunAgentTurn } from "./core/agent.js";
import { DigestRunner, DIGEST_TOPICS, type DigestTopic } from "./core/digest.js";
import { DiscordAdapter } from "./adapters/discord.js";

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
    allowedDirs,
    introspect: new IntrospectRepo(db),
    workers: new WorkersRepo(db),
  };
  // 소유자를 users(owner)로 보장 — 게이트 통과 기본값.
  await users.upsert(config.ownerId, { role: "owner" });

  // 리뷰 #6(LOW): allowed_dirs 테이블 도입 전 owner.allowedDirs 단일 settings 키에 저장돼 있던
  // 소유자 허용 폴더를 이전한다(멱등이라 부팅마다 호출해도 안전).
  await backfillLegacyAllowedDirs(new SettingsRepo(db), allowedDirs, config.ownerId);

  // 워커 허브: 워커가 아웃바운드로 붙는 유일한 표면. Task 4: 봇 전체가 공유하던 단일 토큰 대신,
  // workers 테이블(레지스트리)에서 워커별 해시 토큰을 조회해 인증한다(hub.ts 의 WorkerRegistry) —
  // 인증을 통과하지 못하면 즉시 끊는다.
  const hub = new WorkerHub({ registry: repos.workers });

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
  httpServer.listen(config.httpPort, () => console.log(`워커 허브 대기 중: 포트 ${config.httpPort}`));

  const bus = new EventBus();
  // 에이전트 cwd 는 소스가 아닌 데이터 영역에 둔다 — 에이전트가 소스 트리를 훑지 않도록(1단계 점검 지적).
  const agentCwd = path.resolve(config.dataDir, "..", "agent-cwd");
  fs.mkdirSync(agentCwd, { recursive: true });
  const runTurn = makeRunAgentTurn({ memories: repos.memories, users: repos.users, allowedDirs: repos.allowedDirs, introspect: repos.introspect }, config.deployTarget, config.model, hub);

  const characterImages = new CharacterImagesRepo(db);
  // 감정 목록은 기동 시 한 번 읽는다. 이미지를 추가하고 동기화 스크립트를 돌려도
  // 새 감정은 봇 재시작 후에 프롬프트에 반영된다(기존 감정의 이미지 교체는 즉시 반영).
  const emotions = await characterImages.emotions().catch((err) => {
    console.error("[index] 표정 카탈로그 조회 실패 — 표정 기능 없이 계속합니다:", err);
    return [] as string[];
  });
  console.log(`[index] 표정 카탈로그: ${emotions.length}종`);

  // 정기 게시(조사) 실행기. runTurn·agentCwd 는 core 와 동일한 것을 공유한다 —
  // 별도 프로세스가 아니라 같은 봇 안에서 같은 방식으로 LLM 턴을 돌리는 또 하나의 진입점이다.
  const digest = new DigestRunner({
    runTurn, bus, settings: new SettingsRepo(db), agentCwd,
    channels: config.digestChannels, emotions,
  });

  // FIX3(최종 리뷰): core.ts 도 hub 를 받아 능력 안내(persona.ts)에 "이번 턴에 워커가 실제로
  // 연결돼 있는가"를 반영한다(agent.ts 의 shouldConnectWorker 와 같은 판정, 같은 hub 인스턴스).
  const core = new AgentCore({ bus, config, runTurn, repos, agentCwd, hub, emotions, digest });
  core.start();

  const discord = new DiscordAdapter({ bus, config, users, conversations, characterImages });
  await discord.start();

  // 정기 게시 채널 설정 로그 + FIX2(중요, 머지 전 리뷰): 로그인 이후로 옮겨, 설정된 채널마다
  // 봇이 실제로 접근할 수 있는지(canReachChannel) 확인한다 — 로그인 전에는 channels.fetch 자체가
  // 실패해 여기서 확인할 수 없다. 채널 ID 오타·권한 누락은 이 확인이 없으면 매 조사 성공 뒤
  // 전송 실패로만 나타나(discord.ts 의 send() catch) 로그 한 줄에 묻힌다 — 사용자는 리다이렉트
  // 안내("...에 올릴게")를 받고 기다리다가 그냥 아무것도 못 받는다. 일시적으로 못 보는 채널
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

  await core.recoverPending(); // 크래시로 남은 미처리 메시지 재개

  // 유휴 세션 정리 + 정기 게시 확인: 1분마다 같은 타이머에서 함께 확인한다(타이머를 새로 만들지 않는다).
  const idleTimer = setInterval(() => {
    void core.closeIdleConversations().catch((err) => console.error("[core] 유휴 정리 오류:", err));
    void digest.checkAndRun().catch((err) => console.error("[digest] 스케줄 확인 오류:", err));
  }, 60 * 1000);

  const shutdown = async () => {
    console.log("종료 중...");
    clearInterval(idleTimer);
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
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());

  console.log("상주 비서가 시작되었습니다.");
}

main().catch((err) => {
  console.error("시작 실패:", err);
  process.exit(1);
});
