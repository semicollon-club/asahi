import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { loadWorkerConfig } from "./config.js";
import { makeExecutors, type Executors } from "./remote/executors.js";
import { startWorkerClient, type ClientSocket } from "./remote/workerClient.js";
import { readCommit, defaultRunGit } from "./remote/gitCommit.js";
import { planShutdown } from "./remote/workerShutdown.js";
import { fileReturnUrlOf } from "./core/fileReturn.js";
import { makeSessionRunner, llmProxyUrlOf, type SessionQuery, type SessionRunner } from "./remote/sessionRunner.js";
import { skillPluginDirFrom, skillPluginsFor } from "./core/skills.js";

// 로컬 워커(1단계 얇은 워커): 디스코드에도 DB에도 붙지 않고, Railway 허브로 아웃바운드
// WebSocket 을 열어 도구 호출만 받아 실행한다. 판단·기억·세션은 전부 허브(봇) 쪽에 있다.
// 이 프로세스가 가진 자격증명은 WORKER_TOKEN 하나뿐이다.

dotenv.config({ path: path.resolve("..", ".env") });
dotenv.config();

// FIX8(사소): 실행기 호출 하나하나를 감싸 "지금 몇 개가 진행 중인가"를 센다. finish 가
// client.stop() 직후 곧바로 process.exit 해버리면, 마침 디스크에 쓰는 중이던 fs_write 가 중간에
// 잘릴 수 있다 — 예전(DB 폴링) 버전이 pollPromise 를 기다리고서야 끝낸 것과 같은 이유로, 지금은
// "그 시점에 실행 중이던 실행기 호출들"이 끝나길 기다린다. signal 경로(사람이 멈춤)는 지금도
// client.stop() 이 소켓을 먼저 닫으므로 결과 프레임이 허브까지 돌아가는지 보장할 수 없지만
// (workerClient.ts 참고), update 경로(센티넬)는 planShutdown 이 idle() 을 먼저 기다린 뒤에야
// 소켓을 닫도록 순서를 뒤집어(workerShutdown.ts) 그 문제가 없다 — 어느 경로든 적어도 로컬
// 디스크에 쓰던 내용은 끝까지 쓰고 나서 프로세스를 끝낸다.
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

async function main() {
  try {
    const config = loadWorkerConfig();
    // 파일 반환(2026-09-05): send_file 이 올릴 봇의 POST /files 주소는 HUB_URL 에서 유도한다 — 허브와 같은 http
    // 서버의 다른 경로라 설정을 하나 더 두지 않는다(core/fileReturn.ts). 유도가 안 되면 워커는 그대로 뜨고
    // send_file 만 그 사실을 말하며 실패한다.
    const fileReturnUrl = fileReturnUrlOf(config.hubUrl) ?? undefined;
    if (fileReturnUrl === undefined) console.warn(`[worker] HUB_URL 에서 업로드 주소를 유도하지 못했습니다 — send_file 을 쓸 수 없습니다: ${config.hubUrl}`);
    const { wrapped: executors, idle: executorsIdle } = trackInFlight(makeExecutors(config.roots, { fileReturnUrl }));

    // 풀 하네스 2단계: WORKER_MODE=harness 면 세션 러너를 켠다. 이 프로세스에는 자격증명이 없다 — 세션은 봇의 루프백
    // 프록시(HUB_URL 에서 유도한 /llm)와 봇이 turn.start 마다 주는 작업 토큰으로 모델을 부른다(remote/sessionRunner.ts).
    // 세션 폴더(부원별 CLAUDE_CONFIG_DIR)는 워커 계정의 프로필 아래에 둔다 — WORKER_ROOTS 밖이라 fs_* 로는 닿지 않는다
    // (sh_exec 는 같은 계정이라 닿는다 — 설계 §5 가 받아들인 위험). 스킬 플러그인은 봇 자기 세션과 같은 폴더(이 클론의
    // agent/skill-plugin)다 — src/ 에서 두 단계 위가 agent/ 이므로 core/ 기준 함수에 core 폴더를 흉내 낸 경로를 준다.
    let runner: SessionRunner | undefined;
    if (config.mode === "harness") {
      const llmBaseUrl = llmProxyUrlOf(config.hubUrl);
      if (llmBaseUrl === null) throw new Error(`HUB_URL 에서 프록시 주소를 유도하지 못했습니다: ${config.hubUrl}`);
      const sessionRootDir = config.sessionDir ?? path.join(os.homedir(), ".asahi-sessions");
      const pluginDir = skillPluginDirFrom(path.join(path.dirname(fileURLToPath(import.meta.url)), "core"));
      runner = makeSessionRunner({
        query: query as unknown as SessionQuery, llmBaseUrl, sessionRootDir,
        plugins: skillPluginsFor({ pluginDir, exists: fs.existsSync(pluginDir) }),
      });
      console.log(`[worker] 세션 러너 켬 — 프록시 ${llmBaseUrl}, 세션 폴더 ${sessionRootDir}`);
    }
    // 갱신 종료(planShutdown)는 도구 호출과 세션 턴이 모두 끝나길 기다린다.
    const idle = () => Promise.all([executorsIdle(), runner ? runner.idle() : Promise.resolve()]).then(() => undefined);
    // 기동 시 한 번만 읽는다 — 워커는 갱신될 때 재시작되므로 도는 동안 커밋이 바뀌지 않는다.
    const commit = await readCommit(defaultRunGit);

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
      commit,
      executors,
      mode: config.mode,
      runner,
      onStatus: (s) => console.log(`[worker] ${s}`),
    });

    const IDLE_TIMEOUT_MS = 130_000; // sh_exec 기본 상한(120초)보다 조금 길게

    const finish = (reason: "signal" | "update") => {
      console.log(reason === "update" ? "갱신을 위해 워커를 종료합니다..." : "워커 종료 중...");
      void planShutdown({
        reason,
        stopSocket: () => client.stop(),
        idle,
        idleTimeoutMs: IDLE_TIMEOUT_MS,
      }).then((code) => process.exit(code));
    };
    process.on("SIGINT", () => finish("signal"));
    process.on("SIGTERM", () => finish("signal"));

    // 센티넬 파일이 생기면 갱신 요청이다. fs.watch 대신 주기 확인을 쓰는 이유는 윈도우에서
    // watch 가 파일 생성에 대해 플랫폼마다 다르게 동작해 왔기 때문이다 — 15초 지연은 5분
    // 주기의 업데이터에게 아무 문제가 되지 않는다.
    if (config.sentinelPath !== undefined) {
      const sentinel = config.sentinelPath;
      const timer = setInterval(() => {
        if (!fs.existsSync(sentinel)) return;
        clearInterval(timer);
        finish("update");
      }, 15_000);
    }

    console.log(`로컬 워커가 시작되었습니다 (허브=${config.hubUrl}, 모드=${config.mode}, 커밋=${commit ?? "알 수 없음"}, 폴더=${config.roots.join(", ")}).`);
  } catch (err) {
    // FIX8: 이전(DB 폴링) 버전의 main().catch 와 같은 문구로 복원한다 — WORKER_ROOTS 오타 같은
    // 설정 오류가 맨 스택트레이스 대신 사람이 읽을 수 있는 한 줄로 보이게 한다.
    console.error("워커 시작 실패:", err);
    process.exit(1);
  }
}

void main();
