import path from "node:path";
import dotenv from "dotenv";
import { loadWorkerConfig } from "./config.js";
import { makeExecutors, type Executors } from "./remote/executors.js";
import { startWorkerClient, type ClientSocket } from "./remote/workerClient.js";

// 로컬 워커(1단계 얇은 워커): 디스코드에도 DB에도 붙지 않고, Railway 허브로 아웃바운드
// WebSocket 을 열어 도구 호출만 받아 실행한다. 판단·기억·세션은 전부 허브(봇) 쪽에 있다.
// 이 프로세스가 가진 자격증명은 WORKER_TOKEN 하나뿐이다.

dotenv.config({ path: path.resolve("..", ".env") });
dotenv.config();

// FIX8(사소): 실행기 호출 하나하나를 감싸 "지금 몇 개가 진행 중인가"를 센다. shutdown 이
// client.stop() 직후 곧바로 process.exit 해버리면, 마침 디스크에 쓰는 중이던 fs_write 가 중간에
// 잘릴 수 있다 — 예전(DB 폴링) 버전이 pollPromise 를 기다리고서야 끝낸 것과 같은 이유로, 지금은
// "그 시점에 실행 중이던 실행기 호출들"이 끝나길 기다린다. client.stop() 이 소켓을 곧바로 닫으므로
// 결과 프레임이 허브까지 돌아가는지는 보장할 수 없지만(workerClient.ts 참고), 적어도 로컬 디스크에
// 쓰던 내용은 끝까지 쓰고 나서 프로세스를 끝낸다.
function trackInFlight(executors: Executors): { wrapped: Executors; idle: () => Promise<void> } {
  let count = 0;
  let waiters: Array<() => void> = [];
  const wrapped: Executors = {};
  for (const name of Object.keys(executors)) {
    const fn = executors[name];
    wrapped[name] = async (args) => {
      count++;
      try {
        return await fn(args);
      } finally {
        count--;
        if (count === 0) {
          const toNotify = waiters;
          waiters = [];
          for (const notify of toNotify) notify();
        }
      }
    };
  }
  return {
    wrapped,
    idle: () => (count === 0 ? Promise.resolve() : new Promise<void>((resolve) => waiters.push(resolve))),
  };
}

function main() {
  try {
    const config = loadWorkerConfig();
    const { wrapped: executors, idle } = trackInFlight(makeExecutors(config.roots));

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
      workerId: config.workerId,
      roots: config.roots,
      executors,
      onStatus: (s) => console.log(`[worker] ${s}`),
    });

    const shutdown = () => {
      console.log("워커 종료 중...");
      client.stop();
      // FIX8: 진행 중이던 fs_write 등이 끝나길 기다린 뒤에 종료한다(중간에 잘리지 않게).
      void idle().then(() => process.exit(0));
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);

    console.log(`로컬 워커가 시작되었습니다 (허브=${config.hubUrl}, 폴더=${config.roots.join(", ")}).`);
  } catch (err) {
    // FIX8: 이전(DB 폴링) 버전의 main().catch 와 같은 문구로 복원한다 — WORKER_ROOTS 오타 같은
    // 설정 오류가 맨 스택트레이스 대신 사람이 읽을 수 있는 한 줄로 보이게 한다.
    console.error("워커 시작 실패:", err);
    process.exit(1);
  }
}

main();
