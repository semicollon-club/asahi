// 풀 하네스 워커 설계의 스파이크(2026-09-05, docs/superpowers/specs/2026-09-05-full-harness-worker-design.md §4).
//
// 질문: Claude Code(Agent SDK 가 띄우는 CLI)를 "자격증명이 없는 기계"에서 돌리고, 봇이 인증 프록시로
// 진짜 자격증명을 끼워 넣는 구조가 되는가? 이 스크립트는 그 구조를 이 PC 안에서 흉내 낸다.
//
//   [Agent SDK query()]  --ANTHROPIC_BASE_URL-->  [127.0.0.1 프록시]  --Authorization 교체-->  api.anthropic.com
//   ANTHROPIC_AUTH_TOKEN=worker-dummy                  ↑ ASAHI_PROBE_TOKEN(진짜 자격증명, 메모리에만)
//   CLAUDE_CONFIG_DIR=빈 폴더(로컬 로그인 차단)
//
// 실행(agent/ 에서):
//   npx tsx src/scripts/llmProxyProbe.ts                              # 전송 경로만 확인(진짜 토큰 없음 → 401 이 정상)
//   ASAHI_PROBE_USE_LOCAL_LOGIN=1 npx tsx src/scripts/llmProxyProbe.ts   # 이 PC 의 Claude Code 로그인(~/.claude/.credentials.json)을 끼운다
//   ASAHI_PROBE_TOKEN=<토큰> npx tsx src/scripts/llmProxyProbe.ts        # API 키나 setup-token 출력을 직접 끼운다
//
// 어느 종류의 자격증명이 프록시 뒤에서 받아들여지는지가 곧 자격증명 종류의 결정 근거다(스펙 §4.3). 이
// 스크립트는 헤더 값을 어디에도 기록하지 않는다 — 이름·유무만 찍는다. 토큰은 터미널 세션의 환경변수로만
// 주고 쉘 히스토리에 남기지 않도록 한다. 로컬 로그인 옵션은 운영자가 명시적으로 켰을 때만 그 파일을 읽는다.
//
// 2026-09-05 운영자 PC 실측(진짜 토큰 없이):
// - 로컬 로그인이 있는데 base URL 만 바꾸면 CLI 는 `HEAD /` 만 보내고 "Not logged in" 으로 끝냈다 — base URL 을
//   바꾸면 로컬 OAuth 로그인을 쓰지 않고 ANTHROPIC_AUTH_TOKEN 만 본다. 그래서 자격증명은 프록시가 끼워야 한다.
// - CLAUDE_CONFIG_DIR 을 비우고 더미 토큰을 주면 CLI 는 `HEAD /` 뒤 `POST /v1/messages?beta=true` 를
//   `authorization: Bearer <ANTHROPIC_AUTH_TOKEN>` + `anthropic-beta` 헤더로 프록시에 보냈다 — 전송 계층은 교체
//   가능하다. 프록시가 401 을 그대로 돌려주면 SDK 는 result(subtype success) 안에 "Not logged in" 문구를 싣고
//   끝난다(예외가 아니다).
import http from "node:http";
import https from "node:https";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { query } from "@anthropic-ai/claude-agent-sdk";

const PORT = Number(process.env.ASAHI_PROBE_PORT ?? 8787);
const MODEL = process.env.ASAHI_PROBE_MODEL ?? "claude-sonnet-5";

// 끼울 자격증명. 직접 준 토큰이 우선이고, 운영자가 옵션을 켰을 때만 이 PC 의 Claude Code 로그인 파일을
// 읽는다(값은 메모리에만 두고 절대 출력하지 않는다). 파일 모양이 다르면 이유만 말하고 토큰 없이 진행한다.
function readLocalLogin(): string | undefined {
  const dir = process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), ".claude");
  const file = path.join(dir, ".credentials.json");
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as { claudeAiOauth?: { accessToken?: string } };
    const token = parsed.claudeAiOauth?.accessToken;
    if (typeof token === "string" && token.length > 0) return token;
    console.error(`로컬 로그인 파일에 claudeAiOauth.accessToken 이 없어요: ${file}`);
  } catch (err) {
    console.error(`로컬 로그인 파일을 읽지 못했어요(${file}): ${err instanceof Error ? err.message : String(err)}`);
  }
  return undefined;
}
const REAL = process.env.ASAHI_PROBE_TOKEN ?? (process.env.ASAHI_PROBE_USE_LOCAL_LOGIN === "1" ? readLocalLogin() : undefined);

type Seen = { method: string; path: string; auth: "bearer" | "x-api-key" | "none"; beta: boolean; status: number };
const seen: Seen[] = [];

// 봇 쪽 프록시의 최소 모양: /v1/ 아래만 넘기고, Authorization 을 버린 뒤 진짜 값을 끼운다.
function startProxy(): Promise<http.Server> {
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks);
      const headers: Record<string, string | string[] | undefined> = { ...req.headers };
      delete headers.host;
      delete headers["content-length"];
      const auth: Seen["auth"] = typeof headers.authorization === "string" ? "bearer" : typeof headers["x-api-key"] === "string" ? "x-api-key" : "none";
      delete headers.authorization;
      delete headers["x-api-key"];
      if (REAL) {
        headers.authorization = `Bearer ${REAL}`;
        // 구독 OAuth 토큰은 이 베타 헤더가 있어야 받는다. CLI 가 이미 보냈으면 그대로, 없으면 더한다.
        const beta = String(headers["anthropic-beta"] ?? "");
        if (!beta.includes("oauth-2025-04-20")) headers["anthropic-beta"] = [beta, "oauth-2025-04-20"].filter(Boolean).join(",");
      }
      const up = https.request(
        { host: "api.anthropic.com", method: req.method, path: req.url, headers: { ...headers, host: "api.anthropic.com", "content-length": String(body.length) } },
        (upRes) => {
          seen.push({ method: req.method ?? "?", path: req.url ?? "?", auth, beta: headers["anthropic-beta"] !== undefined, status: upRes.statusCode ?? 0 });
          res.writeHead(upRes.statusCode ?? 502, upRes.headers);
          upRes.pipe(res);
        },
      );
      up.on("error", () => { seen.push({ method: req.method ?? "?", path: req.url ?? "?", auth, beta: false, status: 0 }); res.writeHead(502); res.end(); });
      up.end(body);
    });
  });
  return new Promise((resolve) => server.listen(PORT, "127.0.0.1", () => resolve(server)));
}

async function main(): Promise<void> {
  const server = await startProxy();
  // 자격증명 없는 워커를 흉내 낸다: 로컬 로그인을 못 보게 빈 설정 폴더, 더미 토큰, 프록시 주소.
  const emptyConfig = fs.mkdtempSync(path.join(os.tmpdir(), "asahi-probe-cfg-"));
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    ANTHROPIC_BASE_URL: `http://127.0.0.1:${PORT}`,
    ANTHROPIC_AUTH_TOKEN: "worker-dummy-token",
    CLAUDE_CONFIG_DIR: emptyConfig,
  };
  delete env.CLAUDE_CODE_OAUTH_TOKEN;
  delete env.ANTHROPIC_API_KEY;

  const t0 = Date.now();
  let text = "";
  let subtype: string | null = null;
  let actualModel: string | null = null;
  try {
    for await (const m of query({
      prompt: "OK 라고만 답해.",
      options: { cwd: os.tmpdir(), env, maxTurns: 1, tools: [], allowedTools: [], permissionMode: "default", model: MODEL, systemPrompt: "한 단어로만 답한다." },
    })) {
      if (m.type === "system" && m.subtype === "init") actualModel = (m as { model?: string }).model ?? null;
      if (m.type === "result") {
        subtype = m.subtype;
        text = m.subtype === "success" ? m.result : JSON.stringify(m).slice(0, 300);
      }
    }
  } catch (err) {
    text = `THROW: ${err instanceof Error ? err.message : String(err)}`.slice(0, 300);
  } finally {
    server.close();
    fs.rmSync(emptyConfig, { recursive: true, force: true });
  }

  // 판정: 프록시가 진짜 토큰을 끼웠고 /v1/messages 가 200 이면 "자격증명 없는 워커 + 인증 프록시" 구조가 실측된 것.
  const messages = seen.filter((s) => s.path.startsWith("/v1/messages"));
  const verdict = !REAL
    ? "토큰 없이 실행 — 전송 경로만 확인(/v1/messages 가 프록시에 도착했으면 성공)"
    : messages.some((s) => s.status === 200) ? "성공 — 프록시가 끼운 자격증명으로 턴이 돌았다" : "실패 — 프록시가 끼운 자격증명을 업스트림이 거절했다(status 참고)";
  console.log(JSON.stringify({ realTokenGiven: REAL !== undefined, model: MODEL, actualModel, subtype, text: text.slice(0, 160), ms: Date.now() - t0, seen, verdict }, null, 2));
}

main().catch((err) => { console.error(err); process.exit(1); });
