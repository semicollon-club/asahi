import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import dotenv from "dotenv";
import { WebSocketServer } from "ws";
import { loadConfig } from "./config.js";
import { WorkerHub, type HubSocket } from "./remote/hub.js";
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
import { JobsRepo } from "./store/jobsRepo.js";
import { SettingsRepo } from "./store/settingsRepo.js";
import { IntrospectRepo } from "./store/introspectRepo.js";
import { backfillLegacyAllowedDirs } from "./store/allowedDirsMigration.js";
import { AgentCore } from "./core/core.js";
import { makeRunAgentTurn } from "./core/agent.js";
import { DiscordAdapter } from "./adapters/discord.js";

// 비밀값(.env)은 리포 루트(agent/ 바깥, data/ 와 같은 위치)에서 읽는다.
dotenv.config({ path: path.resolve("..", ".env") });
dotenv.config();

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
    jobs: new JobsRepo(db),
    allowedDirs,
    introspect: new IntrospectRepo(db),
  };
  // 소유자를 users(owner)로 보장 — 게이트 통과 기본값.
  await users.upsert(config.ownerId, { role: "owner" });

  // 리뷰 #6(LOW): allowed_dirs 테이블 도입 전 owner.allowedDirs 단일 settings 키에 저장돼 있던
  // 소유자 허용 폴더를 이전한다(멱등이라 부팅마다 호출해도 안전).
  await backfillLegacyAllowedDirs(new SettingsRepo(db), allowedDirs, config.ownerId);

  // 워커 허브: 워커가 아웃바운드로 붙는 유일한 표면. 토큰 인증을 통과하지 못하면 즉시 끊는다.
  const hub = new WorkerHub({ token: config.workerToken, ownerId: config.ownerId });
  const httpServer = http.createServer((_req, res) => { res.writeHead(200); res.end("ok"); });
  const wss = new WebSocketServer({ server: httpServer, path: "/worker" });
  wss.on("connection", (ws) => {
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
  const core = new AgentCore({ bus, config, runTurn, repos, agentCwd });
  core.start();

  const discord = new DiscordAdapter({ bus, config, users, conversations });
  await discord.start();

  await core.recoverPending(); // 크래시로 남은 미처리 메시지 재개
  // 리뷰 #5a(MED): 부팅 사이(재배포 등)에 위임 타임아웃 뒤 뒤늦게 끝났지만 아직 디스코드로
  // 못 보낸(delivered_ts 없음) job 결과가 있으면 지금 흘려보낸다.
  await core.deliverPendingJobResults().catch((err) => console.error("[core] 위임 결과 배달(부팅) 오류:", err));

  // 유휴 세션 정리 + 위임 결과 배달 스윕: 1분마다 확인
  const idleTimer = setInterval(() => {
    void core.closeIdleConversations().catch((err) => console.error("[core] 유휴 정리 오류:", err));
    void core.deliverPendingJobResults().catch((err) => console.error("[core] 위임 결과 배달 오류:", err));
  }, 60 * 1000);

  const shutdown = async () => {
    console.log("종료 중...");
    clearInterval(idleTimer);
    await core.drain();     // 처리 중인 메시지를 마저 끝내고
    await discord.stop();   // 체인에 남은 전송을 흘려보낸 뒤 클라이언트 종료
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
