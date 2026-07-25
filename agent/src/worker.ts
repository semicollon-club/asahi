import path from "node:path";
import dotenv from "dotenv";
import { loadWorkerConfig } from "./config.js";
import { makeExecutors } from "./remote/executors.js";
import { startWorkerClient, type ClientSocket } from "./remote/workerClient.js";

// 로컬 워커(1단계 얇은 워커): 디스코드에도 DB에도 붙지 않고, Railway 허브로 아웃바운드
// WebSocket 을 열어 도구 호출만 받아 실행한다. 판단·기억·세션은 전부 허브(봇) 쪽에 있다.
// 이 프로세스가 가진 자격증명은 WORKER_TOKEN 하나뿐이다.

dotenv.config({ path: path.resolve("..", ".env") });
dotenv.config();

function main() {
  const config = loadWorkerConfig();
  const executors = makeExecutors(config.roots);

  // 전역 WebSocket(Node 22 내장)을 ClientSocket 으로 감싼다 — 클라이언트 로직은 WebSocket 을 모른다.
  const connect = (): ClientSocket => {
    const ws = new WebSocket(config.hubUrl);
    return {
      send: (d) => ws.send(d),
      close: () => ws.close(),
      onMessage: (cb) => ws.addEventListener("message", (e) => cb(String((e as MessageEvent).data))),
      onClose: (cb) => ws.addEventListener("close", () => cb()),
      onOpen: (cb) => ws.addEventListener("open", () => cb()),
    };
  };

  const client = startWorkerClient({
    connect,
    token: config.workerToken,
    userId: config.workerUserId,
    roots: config.roots,
    executors,
    onStatus: (s) => console.log(`[worker] ${s}`),
  });

  const shutdown = () => {
    console.log("워커 종료 중...");
    client.stop();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  console.log(`로컬 워커가 시작되었습니다 (허브=${config.hubUrl}, 폴더=${config.roots.join(", ")}).`);
}

main();
