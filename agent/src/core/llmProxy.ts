import http from "node:http";
import https from "node:https";
import { bearerTokenOf } from "./fileReturn.js";

// 인증 프록시(풀 하네스 설계 §4, 2단계 2.1) — 봇(계정 A)의 `/llm/v1/*`. 세션(계정 B 의 Claude Code)은
// ANTHROPIC_BASE_URL 을 여기로, ANTHROPIC_AUTH_TOKEN 을 작업 토큰(core/jobToken.ts)으로 받는다. 이 핸들러가 그 토큰을
// 검증하고 Authorization 을 진짜 구독 OAuth 로 바꿔 Anthropic 에 넘긴다. 진짜 자격증명은 이 프로세스(A)를 떠나지 않고,
// B 에는 작업 토큰만 있다 — 그 토큰이 새어도 할 수 있는 일은 "이 루프백 프록시로 모델 호출" 뿐이고 미니PC 밖에서는
// 쓸 수 없다(허브와 같은 서버가 HUB_BIND=127.0.0.1 에 묶여 있다).
//
// 헤더 규칙은 scripts/llmProxyProbe.ts 가 2026-09-05 운영자 PC 에서 실측한 것 그대로다: Claude Code CLI 는 `HEAD /`(연결
// 확인) 뒤 `POST /v1/messages?beta=true` 를 `authorization: Bearer <AUTH_TOKEN>` 과 `anthropic-beta` 로 보낸다. 구독 OAuth
// 토큰은 anthropic-beta 에 oauth-2025-04-20 이 있어야 받아들여진다. 그 실측(200·"OK")이 이 파일의 전제다.
//
// 2단계에서 하는 일: 경로 허용 목록, 토큰 검증(401), 자격증명 교체, 베타 헤더 보정, 스트리밍(SSE) 통과, 상태 코드 그대로.
// 하지 않는 일(3단계): 본문 model 을 프로필에 고정(400), 사용량(usage) 기록, 부원별 창 상한, 429 의 한국어 사유.

export const LLM_PROXY_PREFIX = "/llm";
export const OAUTH_BETA = "oauth-2025-04-20";
export const DEFAULT_UPSTREAM = new URL("https://api.anthropic.com");
// 요청 본문 상한. 컨텍스트가 큰 턴도 수 MB 안이다 — 이보다 크면 프록시를 통한 무언가 다른 용도다.
const DEFAULT_MAX_BODY_BYTES = 64 * 1024 * 1024;

export type LlmRoute = { kind: "root" } | { kind: "forward"; path: string } | { kind: "notFound" };

// 경로 허용 목록(§4.2). /v1/messages(쿼리 포함)와 count_tokens 만 전달한다 — 모델 목록·파일·관리 API 로는 새지 않는다.
// 루트(HEAD/GET /llm)는 CLI 의 연결 확인이라 200 만 돌려준다(업스트림에 가지 않는다).
export function decideLlmRoute(method: string | undefined, url: string | undefined): LlmRoute {
  if (!url) return { kind: "notFound" };
  if ((method === "HEAD" || method === "GET") && (url === LLM_PROXY_PREFIX || url === `${LLM_PROXY_PREFIX}/`)) return { kind: "root" };
  if (method !== "POST" || !url.startsWith(`${LLM_PROXY_PREFIX}/`)) return { kind: "notFound" };
  const rest = url.slice(LLM_PROXY_PREFIX.length);
  const pathOnly = rest.split("?")[0];
  if (pathOnly === "/v1/messages" || pathOnly === "/v1/messages/count_tokens") return { kind: "forward", path: rest };
  return { kind: "notFound" };
}

// 구독 OAuth 는 이 베타 헤더가 있어야 받는다. CLI 가 이미 보냈으면 그대로, 없으면 더한다(프로브와 같은 규칙).
export function fixBetaHeader(value: string | undefined): string {
  const parts = (value ?? "").split(",").map((s) => s.trim()).filter((s) => s.length > 0);
  if (!parts.includes(OAUTH_BETA)) parts.push(OAUTH_BETA);
  return parts.join(",");
}

export type LlmProxyDeps = {
  // 작업 토큰 검증(index.ts 가 makeJobTokenMinter 의 verify 를 넘긴다). null/던짐은 401.
  verify(token: string): unknown;
  // 끼울 진짜 자격증명(봇의 CLAUDE_CODE_OAUTH_TOKEN). 호출 때마다 읽는다 — 없으면 503.
  credential(): string | undefined;
  // 테스트가 가짜 업스트림(로컬 http 서버)을 넣는 자리. 기본은 api.anthropic.com.
  upstream?: URL;
  maxBodyBytes?: number;
};

// Anthropic 오류 응답과 같은 모양으로 낸다 — SDK 가 이 JSON 을 읽어 사람이 볼 문구로 만든다.
function errorBody(type: string, message: string): string {
  return JSON.stringify({ type: "error", error: { type, message } });
}

function replyJson(res: http.ServerResponse, status: number, body: string): void {
  if (res.headersSent || res.writableEnded) return;
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(body);
}

// 업스트림으로 옮기지 않는 헤더. 인증은 우리 것으로 바꾸고, 연결 단위(hop-by-hop) 헤더는 새 연결에 맞지 않으며,
// content-length 는 본문을 다 받은 뒤 다시 계산한다.
const DROP_HEADERS = new Set(["host", "authorization", "x-api-key", "content-length", "transfer-encoding", "connection", "keep-alive", "proxy-authorization", "te", "trailer", "upgrade"]);

export function makeLlmProxyHandler(deps: LlmProxyDeps): (req: http.IncomingMessage, res: http.ServerResponse) => void {
  const upstream = deps.upstream ?? DEFAULT_UPSTREAM;
  const maxBody = deps.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  const lib = upstream.protocol === "https:" ? https : http;

  return (req, res) => {
    const route = decideLlmRoute(req.method, req.url);
    if (route.kind === "root") {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("ok");
      return;
    }
    if (route.kind === "notFound") {
      replyJson(res, 404, errorBody("not_found_error", "이 프록시는 /llm/v1/messages 만 전달해요."));
      return;
    }

    // 토큰은 본문을 읽기 전에 본다 — 토큰 없는 요청이 큰 본문으로 대역폭을 쓰지 못하게.
    const token = bearerTokenOf(req.headers.authorization);
    let claims: unknown = null;
    if (token !== null) {
      try {
        claims = deps.verify(token);
      } catch {
        claims = null;
      }
    }
    if (claims === null || claims === undefined) {
      replyJson(res, 401, errorBody("authentication_error", "작업 토큰이 없거나 만료됐어요. 새 턴을 시작하면 새 토큰을 받아요."));
      return;
    }
    const credential = deps.credential();
    if (!credential) {
      replyJson(res, 503, errorBody("api_error", "프록시에 구독 자격증명이 없어요 — 봇의 CLAUDE_CODE_OAUTH_TOKEN 을 확인하세요."));
      return;
    }

    const chunks: Buffer[] = [];
    let total = 0;
    let failed = false;
    req.on("data", (c: Buffer) => {
      if (failed) return;
      total += c.length;
      if (total > maxBody) {
        failed = true;
        replyJson(res, 413, errorBody("invalid_request_error", "요청 본문이 너무 커요."));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("error", () => {
      failed = true;
      replyJson(res, 400, errorBody("invalid_request_error", "요청 수신이 중단됐어요."));
    });
    req.on("end", () => {
      if (failed) return;
      const body = Buffer.concat(chunks);
      const headers: Record<string, string | string[]> = {};
      for (const [k, v] of Object.entries(req.headers)) {
        if (v === undefined || DROP_HEADERS.has(k)) continue;
        headers[k] = v;
      }
      headers.authorization = `Bearer ${credential}`;
      const beta = req.headers["anthropic-beta"];
      headers["anthropic-beta"] = fixBetaHeader(Array.isArray(beta) ? beta.join(",") : beta);
      headers.host = upstream.host;
      headers["content-length"] = String(body.length);

      let up: http.ClientRequest;
      try {
        up = lib.request(
          { protocol: upstream.protocol, hostname: upstream.hostname, port: upstream.port === "" ? undefined : Number(upstream.port), method: "POST", path: route.path, headers },
          (upRes) => {
            // 상태·헤더·본문을 그대로 흘린다 — SSE(text/event-stream)도 이 pipe 하나로 조각 단위로 지나간다.
            res.writeHead(upRes.statusCode ?? 502, upRes.headers);
            upRes.pipe(res);
            upRes.on("error", () => res.end());
          },
        );
      } catch (err) {
        // 헤더 값이 잘못됐을 때(ERR_INVALID_CHAR 등) 프로세스가 죽지 않게 한다 — 프로브에서 실제로 겪은 경로다.
        console.error("[llm] 업스트림 요청을 만들지 못했어요:", err instanceof Error ? err.message : String(err));
        replyJson(res, 502, errorBody("api_error", "업스트림 요청을 만들지 못했어요."));
        return;
      }
      up.on("error", (err) => {
        console.error("[llm] 업스트림 오류:", err instanceof Error ? err.message : String(err));
        if (!res.headersSent) replyJson(res, 502, errorBody("api_error", "업스트림에 닿지 못했어요."));
        else res.end();
      });
      // 세션이 요청을 끊으면(취소) 업스트림 요청도 끊는다 — 남은 스트림이 자격증명으로 계속 돌지 않게.
      res.on("close", () => { if (!up.destroyed) up.destroy(); });
      up.end(body);
    });
  };
}
