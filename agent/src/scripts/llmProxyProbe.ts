// 풀 하네스 워커 설계의 스파이크(2026-09-05, docs/superpowers/specs/2026-09-05-full-harness-worker-design.md §4).
//
// 질문: Claude Code(Agent SDK 가 띄우는 CLI)를 "자격증명이 없는 기계"에서 돌리고, 봇이 인증 프록시로
// 진짜 자격증명을 끼워 넣는 구조가 되는가? 이 스크립트는 그 구조를 이 PC 안에서 흉내 낸다.
//
//   [Agent SDK query()]  --ANTHROPIC_BASE_URL-->  [127.0.0.1 프록시]  --Authorization 교체-->  api.anthropic.com
//   ANTHROPIC_AUTH_TOKEN=worker-dummy                  ↑ ASAHI_PROBE_TOKEN(진짜 자격증명, 메모리에만)
//   CLAUDE_CONFIG_DIR=빈 폴더(로컬 로그인 차단)
//
// 실행(agent/ 에서). 윈도우 PowerShell 5.1 은 `VAR=값 명령` 문법이 없고 실행 정책이 npx.ps1 을 막으므로
// npx.cmd 를 부른다. 토큰은 Read-Host 로 받아 쉘 히스토리에 남기지 않는다:
//   $s = Read-Host "토큰" -AsSecureString
//   $env:ASAHI_PROBE_TOKEN = [Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR($s))
//   npx.cmd tsx src/scripts/llmProxyProbe.ts
//   Remove-Item Env:ASAHI_PROBE_TOKEN
// 토큰 없이 돌리면 전송 경로만 확인한다(업스트림 401 이 정상). Git Bash 면
//   ASAHI_PROBE_TOKEN=<토큰> npx tsx src/scripts/llmProxyProbe.ts
//
// 토큰은 봇이 Railway 에서 실제로 쓰는 CLAUDE_CODE_OAUTH_TOKEN(같은 종류·같은 값이라 가장 정확한 시험)이거나
// `claude setup-token` 의 출력이다. 어느 종류의 자격증명이 프록시 뒤에서 받아들여지는지가 자격증명 결정의
// 근거다(스펙 §4.3). 이 스크립트는 헤더 값을 어디에도 기록하지 않는다 — 이름·유무만 찍는다.
//
// ASAHI_PROBE_USE_LOCAL_LOGIN=1 은 ~/.claude/.credentials.json 의 계정 로그인(claudeAiOauth)을 읽는 옵션인데,
// 2026-09-05 운영자 PC 실측으로 그 파일에는 MCP 서버 OAuth 항목만 있고 계정 로그인이 없었다 — Claude 데스크톱
// 앱의 로그인은 이 파일에 저장되지 않는다. CLI 로 `claude login` 한 기계에서만 뜻이 있다.
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
import readline from "node:readline";
import { query } from "@anthropic-ai/claude-agent-sdk";

const PORT = Number(process.env.ASAHI_PROBE_PORT ?? 8787);
const MODEL = process.env.ASAHI_PROBE_MODEL ?? "claude-sonnet-5";

// 토큰을 환경변수로 못 넘길 때(2026-09-05 운영자 PC: PowerShell 5.1 의 Read-Host 보안 입력에 붙여 넣기가 안 되고,
// 메모장 경로는 저장 전에 다음 명령이 돌았다) 스크립트가 직접 묻는다. 입력은 화면에 표시하지 않는다 — 콘솔은
// 오른쪽 클릭이 붙여 넣기다. 그냥 Enter 면 토큰 없이 경로만 확인한다. 값은 이 프로세스 메모리에만 있다.
function promptHidden(question: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  const internal = rl as unknown as { _writeToOutput?: (s: string) => void; output: NodeJS.WritableStream };
  let muted = false;
  internal._writeToOutput = (s: string) => {
    if (!muted) internal.output.write(s);
    else if (s.includes("\n") || s.includes("\r")) internal.output.write("\n");
  };
  return new Promise((resolve) => {
    rl.question(question, (answer) => { rl.close(); resolve(answer.trim()); });
    muted = true;
  });
}

// 끼울 자격증명. 직접 준 토큰이 우선이고, 운영자가 옵션을 켰을 때만 이 PC 의 Claude Code 로그인 파일을
// 읽는다(값은 메모리에만 두고 절대 출력하지 않는다). 파일 모양이 다르면 이유만 말하고 토큰 없이 진행한다.
function readLocalLogin(): string | undefined {
  const dir = process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), ".claude");
  const file = path.join(dir, ".credentials.json");
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as { claudeAiOauth?: { accessToken?: string } };
    const token = parsed.claudeAiOauth?.accessToken;
    if (typeof token === "string" && token.length > 0) return token;
    console.error(
      `로컬 로그인 파일에 계정 로그인(claudeAiOauth.accessToken)이 없어요: ${file}\n` +
        "Claude 데스크톱 앱의 로그인은 이 파일에 저장되지 않아요. Railway 의 CLAUDE_CODE_OAUTH_TOKEN 값이나 " +
        "`claude setup-token` 출력을 ASAHI_PROBE_TOKEN 으로 주세요(위 머리말의 Read-Host 절차).",
    );
  } catch (err) {
    console.error(`로컬 로그인 파일을 읽지 못했어요(${file}): ${err instanceof Error ? err.message : String(err)}`);
  }
  return undefined;
}
// 끼울 진짜 자격증명. main 에서 정한다 — 환경변수 → (옵션) 로컬 로그인 파일 → 대화식 입력 순.
let REAL: string | undefined;

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
      let up: http.ClientRequest;
      try {
        up = https.request(
          { host: "api.anthropic.com", method: req.method, path: req.url, headers: { ...headers, host: "api.anthropic.com", "content-length": String(body.length) } },
          (upRes) => {
            seen.push({ method: req.method ?? "?", path: req.url ?? "?", auth, beta: headers["anthropic-beta"] !== undefined, status: upRes.statusCode ?? 0 });
            res.writeHead(upRes.statusCode ?? 502, upRes.headers);
            upRes.pipe(res);
          },
        );
      } catch (err) {
        // 헤더 값이 잘못됐을 때(ERR_INVALID_CHAR 등) 프록시 프로세스가 죽지 않게 한다 — 사유는 결과 JSON 에 남는다.
        console.error("프록시가 업스트림 요청을 만들지 못했어요:", err instanceof Error ? err.message : String(err));
        seen.push({ method: req.method ?? "?", path: req.url ?? "?", auth, beta: false, status: 0 });
        res.writeHead(502);
        res.end();
        return;
      }
      up.on("error", () => { seen.push({ method: req.method ?? "?", path: req.url ?? "?", auth, beta: false, status: 0 }); res.writeHead(502); res.end(); });
      up.end(body);
    });
  });
  return new Promise((resolve) => server.listen(PORT, "127.0.0.1", () => resolve(server)));
}

async function main(): Promise<void> {
  REAL = process.env.ASAHI_PROBE_TOKEN ?? (process.env.ASAHI_PROBE_USE_LOCAL_LOGIN === "1" ? readLocalLogin() : undefined);
  if (!REAL && process.stdin.isTTY && process.env.ASAHI_PROBE_NO_PROMPT !== "1") {
    console.log(
      "Railway → asahi 서비스 → Variables → CLAUDE_CODE_OAUTH_TOKEN 의 값을 복사해 아래에 붙여 넣고 Enter 를 누르세요\n" +
        "(입력은 화면에 표시되지 않아요. 이 콘솔에서 붙여 넣기는 마우스 오른쪽 클릭입니다. 그냥 Enter 면 토큰 없이 경로만 확인합니다.)",
    );
    const typed = await promptHidden("토큰: ");
    if (typed.length > 0) REAL = typed;
    console.log(REAL ? `토큰을 받았어요(길이 ${REAL.length}). 프록시를 띄웁니다.` : "토큰 없이 진행합니다.");
  }
  // 값을 쓰기 전에 모양을 본다 — 2026-09-05 실측: 가려진 값(●●●)을 복사해 붙이면 헤더에 못 쓰는 문자라
  // 프록시가 ERR_INVALID_CHAR 로 죽었다. 값은 출력하지 않고 무엇이 문제인지만 말한다.
  if (REAL !== undefined) {
    const nonAscii = [...REAL].filter((c) => c.charCodeAt(0) < 0x21 || c.charCodeAt(0) > 0x7e);
    const allSame = new Set([...REAL]).size === 1;
    if (nonAscii.length > 0) {
      console.error(
        `붙여 넣은 값(길이 ${REAL.length})에 HTTP 헤더에 쓸 수 없는 문자가 ${nonAscii.length}개 있어요` +
          (allSame ? " — 전부 같은 문자라 가려진 값(●●●)을 복사한 것으로 보여요." : ".") +
          " Railway Variables 에서 눈 아이콘으로 값을 표시한 뒤 복사하거나, 값 옆의 복사 버튼을 쓰세요.",
      );
      process.exit(2);
    }
    const kind = REAL.startsWith("sk-ant-oat") ? "구독 OAuth 토큰" : REAL.startsWith("sk-ant-api") ? "API 키" : "알 수 없는 형식";
    console.log(`토큰 종류: ${kind}`);
  }
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
