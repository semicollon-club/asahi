import fs from "node:fs";
import path from "node:path";
import { progressFromMessage, type PendingTool } from "../core/sdkEvents.js";
import { httpBaseOfHub } from "../core/fileReturn.js";
import { shellGitEnv, shellGitOf } from "./gitEnv.js";
import { isValidUserId } from "./proc.js";
import type { TurnStartFrame, TurnEventFrame, TurnResultFrame } from "./protocol.js";

// 세션 러너(풀 하네스 설계 §3·§7, 2단계 2.3) — 워커(계정 B, WORKER_MODE=harness)가 봇의 turn.start 하나를 받아 그
// 작업 폴더에서 Claude Code(Agent SDK query)를 통째로 한 턴 돌린다. 도구 호출 하나를 대신 실행하던 얇은 워커(executors.ts)
// 와 달리 판단·도구·서브에이전트가 전부 이 기계에서 돈다 — 봇은 디스코드 중계·정책·프록시만 한다.
//
// 이 프로세스에는 자격증명이 없다. 세션 환경에 넣는 것은 셋이다: ANTHROPIC_BASE_URL(봇의 루프백 프록시 — HUB_URL 에서
// 유도), ANTHROPIC_AUTH_TOKEN(봇이 발급한 작업 토큰 — 프록시만 알아본다), CLAUDE_CONFIG_DIR(부원별 세션 폴더 — 전사·
// resume 이 여기 남는다). 진짜 자격증명 변수(CLAUDE_CODE_OAUTH_TOKEN·ANTHROPIC_API_KEY)는 이 프로세스 환경에 있어도
// 지운다 — 있으면 안 되지만, 있더라도 세션으로는 안 간다. git 자격증명·신원은 sh_exec 와 같은 규약(GIT_CONFIG_*, gitEnv.ts)
// 으로 얹는다 — Bash 의 git 이 그대로 인증한다.
//
// query 는 주입한다(SessionQuery) — 테스트는 가짜 스트림으로 이벤트 매핑·취소·세션 id·실패 경로를 본다(계획 2.3). 실제
// 배선(worker.ts)은 SDK 의 query 를 넘긴다.

export type SessionQuery = (params: { prompt: string; options: Record<string, unknown> }) => AsyncIterable<Record<string, unknown>>;

// HUB_URL(ws://127.0.0.1:P/worker) → 프록시 기본 주소(http://127.0.0.1:P/llm). 파일 반환의 /files 와 같은 규칙이다.
export function llmProxyUrlOf(hubUrl: string): string | null {
  const base = httpBaseOfHub(hubUrl);
  return base === null ? null : `${base}/llm`;
}

// 부원별 CLAUDE_CONFIG_DIR. userId 를 경로 조각으로 쓰므로 식별자 모양(디스코드 스노플레이크)만 받는다 — proc.ts 가
// 프로세스 이름에 쓰는 것과 같은 규칙. 아니면 던진다(호출측 start 가 실패 결과로 바꾼다).
export function sessionDirFor(rootDir: string, userId: string): string {
  if (!isValidUserId(userId)) throw new Error(`세션 폴더에 쓸 수 없는 사용자 식별자예요: ${JSON.stringify(userId)}`);
  return path.join(rootDir, userId);
}

const REAL_CREDENTIAL_VARS = ["CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"];

export function buildSessionEnv(o: {
  baseEnv: NodeJS.ProcessEnv;
  llmBaseUrl: string;
  token: string;
  configDir: string;
  git?: Record<string, unknown>;
}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(o.baseEnv)) {
    if (v !== undefined && !REAL_CREDENTIAL_VARS.includes(k)) env[k] = v;
  }
  env.ANTHROPIC_BASE_URL = o.llmBaseUrl;
  env.ANTHROPIC_AUTH_TOKEN = o.token;
  env.CLAUDE_CONFIG_DIR = o.configDir;
  if (o.git !== undefined) Object.assign(env, shellGitEnv(shellGitOf(o.git)));
  return env;
}

// 프로필(core/profiles.ts) → SDK query 옵션. 권한은 묻지 않는다(bypassPermissions) — 디스코드 너머에서 사람이 승인
// 프롬프트에 답할 방법이 없고, 봇 세션도 원격 도구를 사전 승인으로 돌렸다. 서브에이전트가 꺼진 프로필은 Task 도구를
// 막는다 — 한 턴이 여러 모델 호출을 병렬로 벌리는 가장 빠른 길을 손님에게서 닫는다(§5).
export function buildQueryOptions(frame: TurnStartFrame, env: Record<string, string>, plugins: unknown[]): Record<string, unknown> {
  const p = frame.profile;
  return {
    cwd: frame.cwd,
    env,
    systemPrompt: frame.systemPrompt,
    ...(frame.resume !== undefined ? { resume: frame.resume } : {}),
    model: p.model,
    maxTurns: p.maxTurns,
    ...(p.effort !== undefined ? { effort: p.effort } : {}),
    ...(p.tools !== undefined ? { tools: p.tools } : {}),
    ...(p.subagents ? {} : { disallowedTools: ["Task"] }),
    permissionMode: "bypassPermissions",
    plugins,
    skills: "all",
    abortController: new AbortController(),
  };
}

export type SessionRunner = {
  start(frame: TurnStartFrame, send: (f: TurnEventFrame | TurnResultFrame) => void): void;
  cancel(id: string): void;
  inFlight(): number;
  idle(): Promise<void>;
};

export function makeSessionRunner(o: {
  query: SessionQuery;
  llmBaseUrl: string;
  sessionRootDir: string;
  baseEnv?: NodeJS.ProcessEnv;
  plugins?: unknown[];
  now?: () => number;
}): SessionRunner {
  // 턴 id → 진행 중 정보. 부원별로 세션 하나(§7) — 같은 부원의 두 번째 turn.start 는 즉시 실패한다. 봇의 turnChains 가
  // 같은 대화의 재진입을 이미 막으므로 여기 걸리는 것은 "같은 사람이 두 대화에서 동시에" 인 경우다.
  const running = new Map<string, { userId: string; abort: AbortController }>();
  const busyUsers = new Set<string>();
  let waiters: Array<() => void> = [];
  const finish = (id: string) => {
    const r = running.get(id);
    running.delete(id);
    if (r) busyUsers.delete(r.userId);
    if (running.size === 0) {
      const toNotify = waiters;
      waiters = [];
      for (const notify of toNotify) notify();
    }
  };

  return {
    start(frame, send) {
      const fail = (error: string) => send({ type: "turn.result", id: frame.id, ok: false, text: "", error });
      let configDir: string;
      try {
        configDir = sessionDirFor(o.sessionRootDir, frame.userId);
      } catch (err) {
        fail(err instanceof Error ? err.message : String(err));
        return;
      }
      if (busyUsers.has(frame.userId)) {
        fail("이 부원의 세션이 이미 진행 중이에요 — 끝나면 다시 시도해요.");
        return;
      }
      const env = buildSessionEnv({ baseEnv: o.baseEnv ?? process.env, llmBaseUrl: o.llmBaseUrl, token: frame.token, configDir, git: frame.git });
      const options = buildQueryOptions(frame, env, o.plugins ?? []);
      const abort = options.abortController as AbortController;
      running.set(frame.id, { userId: frame.userId, abort });
      busyUsers.add(frame.userId);

      void (async () => {
        try {
          fs.mkdirSync(configDir, { recursive: true });
          const pending = new Map<string, PendingTool>();
          let sessionId: string | undefined;
          let text = "";
          let ok = false;
          let error: string | undefined;
          for await (const m of o.query({ prompt: frame.prompt, options })) {
            // 봇의 makeRunAgentTurn 과 같은 함수로 같은 모양의 이벤트를 만든다 — 진행 표시·actions 기록이 옛 경로와 같다.
            for (const u of progressFromMessage(m as { type: string; message?: unknown }, pending, o.now)) {
              send({ type: "turn.event", id: frame.id, event: u as unknown as Record<string, unknown> });
            }
            if (m.type === "system" && m.subtype === "init" && typeof m.session_id === "string") sessionId = m.session_id;
            if (m.type === "result") {
              if (typeof m.session_id === "string") sessionId = m.session_id;
              if (m.subtype === "success") {
                text = typeof m.result === "string" ? m.result : "";
                ok = true;
              } else {
                ok = false;
                error = `에이전트 오류: ${String(m.subtype)}`;
              }
            }
          }
          send({ type: "turn.result", id: frame.id, ok, text, ...(sessionId !== undefined ? { sessionId } : {}), ...(error !== undefined ? { error } : {}) });
        } catch (err) {
          // SDK 가 던지는 것(세션 없음·프로세스 오류·취소)을 그대로 error 로 싣는다 — 봇이 isSessionNotFound 로 판정해
          // 새 세션으로 재시도하는 경로가 옛 runTurn 과 같은 문구에 걸린다.
          send({ type: "turn.result", id: frame.id, ok: false, text: "", error: err instanceof Error ? err.message : String(err) });
        } finally {
          finish(frame.id);
        }
      })();
    },
    cancel(id) {
      running.get(id)?.abort.abort();
    },
    inFlight() {
      return running.size;
    },
    idle() {
      return running.size === 0 ? Promise.resolve() : new Promise<void>((resolve) => waiters.push(resolve));
    },
  };
}
