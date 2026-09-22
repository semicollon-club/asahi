import http from "node:http";
import https from "node:https";
import { bearerTokenOf } from "./fileReturn.js";
import type { JobTokenClaims } from "./jobToken.js";

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

// 모델 고정(3단계 3.1). 본문에서 model 만 꺼낸다 — 큰 본문(컨텍스트)이라도 top-level 문자열 하나다.
// 파싱 실패는 undefined 로 두고(고정을 건너뛴다) 업스트림이 판단하게 둔다.
export function modelOfBody(body: Buffer): string | undefined {
  try {
    const v = JSON.parse(body.toString("utf8")) as unknown;
    if (v && typeof v === "object" && typeof (v as { model?: unknown }).model === "string") return (v as { model: string }).model;
  } catch {
    /* 본문이 JSON 이 아니면 고정하지 않는다 */
  }
  return undefined;
}

// 한 번의 모델 호출에서 뽑아낸 사용량(3단계 3.2). 프록시가 SSE 를 지나보내며 곁으로 읽는다.
export type LlmUsageParsed = {
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
  // message_start.message.model — 실제로 응답한 모델(고정된 요청 모델과 같아야 하지만, 라우팅 확인용으로 그대로 싣는다).
  model?: string;
};

export type UsageSniffer = { push(chunk: Buffer | string): void; result(): LlmUsageParsed | null };
// 응답 모양. Claude Code 는 둘 다 보낸다 — 평소에는 스트리밍(text/event-stream)이고, 스트리밍이 실패하면 비스트리밍으로
// 폴백한다(바이너리의 "Error streaming, falling back to non-streaming"). 첫 판(2026-09-06)은 SSE 만 읽어 비스트리밍
// 응답의 usage 를 통째로 놓쳤다(로드맵 N0).
export type UsageSnifferMode = "sse" | "json";
// 비스트리밍 JSON 본문을 모을 때의 상한. 모델 응답 하나는 수십 KB 안이다 — 이보다 크면 모으지 않고 기록을 포기한다(메모리 보호).
const DEFAULT_JSON_SNIFF_MAX_BYTES = 4 * 1024 * 1024;

const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

// 사용량 스니퍼. pipe 를 방해하지 않는 순수 관찰자다 — push 로 먹이고 result 로 최종값을 받는다(읽을 게 없었으면 null).
// - sse: Anthropic 스트림은 message_start 에 입력 토큰(+캐시)을, 이어지는 message_delta 에 누적 출력 토큰을 싣는다.
//   조각(chunk)이 줄 중간에서 끊길 수 있어 buffer 에 남겨 완전한 줄만 파싱한다.
// - json: 비스트리밍 응답은 본문 최상위 usage(같은 필드 이름)와 model 에 있다. 본문을 상한까지 모아 끝에서 한 번 파싱한다.
export function createUsageSniffer(mode: UsageSnifferMode = "sse", opts: { maxBytes?: number } = {}): UsageSniffer {
  if (mode === "json") return createJsonUsageSniffer(opts.maxBytes ?? DEFAULT_JSON_SNIFF_MAX_BYTES);
  let buffer = "";
  let input = 0, output = 0, cacheCreate = 0, cacheRead = 0;
  let model: string | undefined;
  let seen = false;
  return {
    push(chunk) {
      buffer += typeof chunk === "string" ? chunk : chunk.toString("utf8");
      let nl: number;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, nl).trimEnd();
        buffer = buffer.slice(nl + 1);
        if (!line.startsWith("data:")) continue;
        const json = line.slice(5).trim();
        if (json === "" || json === "[DONE]") continue;
        let ev: { type?: unknown; message?: { usage?: Record<string, unknown>; model?: unknown }; usage?: Record<string, unknown> };
        try { ev = JSON.parse(json); } catch { continue; }
        if (ev && ev.type === "message_start" && ev.message) {
          seen = true;
          const u = ev.message.usage ?? {};
          input = num(u.input_tokens) ?? input;
          output = num(u.output_tokens) ?? output;
          cacheCreate = num(u.cache_creation_input_tokens) ?? cacheCreate;
          cacheRead = num(u.cache_read_input_tokens) ?? cacheRead;
          if (typeof ev.message.model === "string") model = ev.message.model;
        } else if (ev && ev.type === "message_delta" && ev.usage) {
          seen = true;
          output = num(ev.usage.output_tokens) ?? output;
          input = num(ev.usage.input_tokens) ?? input;
        }
      }
    },
    result() {
      return seen ? { inputTokens: input, outputTokens: output, cacheCreationInputTokens: cacheCreate, cacheReadInputTokens: cacheRead, ...(model ? { model } : {}) } : null;
    },
  };
}

function createJsonUsageSniffer(maxBytes: number): UsageSniffer {
  const chunks: Buffer[] = [];
  let total = 0;
  let overflow = false;
  return {
    push(chunk) {
      if (overflow) return;
      const b = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;
      total += b.length;
      if (total > maxBytes) { overflow = true; chunks.length = 0; return; }
      chunks.push(b);
    },
    result() {
      if (overflow || chunks.length === 0) return null;
      let v: unknown;
      try { v = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { return null; }
      if (!v || typeof v !== "object") return null;
      const o = v as { usage?: unknown; model?: unknown };
      if (!o.usage || typeof o.usage !== "object") return null;
      const u = o.usage as Record<string, unknown>;
      return {
        inputTokens: num(u.input_tokens) ?? 0,
        outputTokens: num(u.output_tokens) ?? 0,
        cacheCreationInputTokens: num(u.cache_creation_input_tokens) ?? 0,
        cacheReadInputTokens: num(u.cache_read_input_tokens) ?? 0,
        ...(typeof o.model === "string" ? { model: o.model } : {}),
      };
    },
  };
}

// 프록시가 사용량 한 건을 남길 때 넘기는 행(3단계 3.2). index.ts 가 llmUsageRepo.record 로 잇는다.
// requestModel 은 고정된(또는 본문의) 요청 모델, model 은 SSE 가 보고한 실제 모델(대개 같다).
export type LlmUsageRow = LlmUsageParsed & { jobId: string; userId: string; conversationId: number; requestModel: string; ts: number };

export type LlmProxyDeps = {
  // 작업 토큰 검증(index.ts 가 makeJobTokenMinter 의 verify 를 넘긴다). null/던짐은 401.
  verify(token: string): JobTokenClaims | null;
  // 끼울 진짜 자격증명(봇의 CLAUDE_CODE_OAUTH_TOKEN). 호출 때마다 읽는다 — 없으면 503.
  credential(): string | undefined;
  // 사용량 기록(3단계 3.2). 있으면 성공(2xx) 응답의 SSE 에서 usage 를 읽어 호출한다 — 던져도 스트림을 막지 않는다.
  recordUsage?(row: LlmUsageRow): void;
  // 테스트가 가짜 업스트림(로컬 http 서버)을 넣는 자리. 기본은 api.anthropic.com.
  upstream?: URL;
  maxBodyBytes?: number;
  now?(): number;
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
//
// accept-encoding 은 2026-09-22 에 더했다(로드맵 N0). 클라이언트(Claude Code 의 fetch — Node 22 실측 `gzip, deflate`)가
// 광고한 압축을 업스트림이 받아들이면 프록시는 압축 바이트를 그대로 흘리게 되고, 아래 사용량 스니퍼는 압축된 본문에서
// data: 줄을 찾지 못해 **조용히** 아무것도 기록하지 못한다 — llm_usage 가 역사상 0행이었던 결함의 한 축이다. 전송 인코딩은
// 프록시가 소유한다: 업스트림에는 이 헤더를 보내지 않아 identity 로 받고, 클라이언트에는 그대로 흘린다(루프백이라 전송량은 무의미).
const DROP_HEADERS = new Set(["host", "authorization", "x-api-key", "content-length", "transfer-encoding", "connection", "keep-alive", "proxy-authorization", "te", "trailer", "upgrade", "accept-encoding"]);

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
    let claims: JobTokenClaims | null = null;
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
    // 여기서부터 claims 는 유효하다. async 콜백(req.on/end)이 좁혀진 타입을 그대로 쓰도록 const 로 잡는다.
    const jobClaims = claims;
    const pinnedModel = jobClaims.model;
    const nowFn = deps.now ?? Date.now;

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
      // 모델 고정(3단계 3.1): 토큰이 모델을 못박았으면(하네스 턴) 본문 model 이 그것과 같아야 한다.
      // 다르면 400 — 업스트림에 보내지 않는다. 부원이 프롬프트로 더 비싼 모델을 부르는 경로를 여기서 막는다.
      const requestModel = modelOfBody(body);
      if (pinnedModel !== undefined && requestModel !== undefined && requestModel !== pinnedModel) {
        replyJson(res, 400, errorBody("invalid_request_error", `이 세션의 모델은 ${pinnedModel} 로 고정돼 있어요 — 다른 모델(${requestModel})은 쓸 수 없어요.`));
        return;
      }
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
      // 진단(N0)용 상태 둘 — 응답 콜백이 채우고, 아래 res 'close' 가 읽는다.
      let upstreamEnded = false;
      let forwarded = 0;
      try {
        up = lib.request(
          { protocol: upstream.protocol, hostname: upstream.hostname, port: upstream.port === "" ? undefined : Number(upstream.port), method: "POST", path: route.path, headers },
          (upRes) => {
            // 상태·헤더·본문을 그대로 흘린다 — SSE(text/event-stream)도 이 pipe 하나로 조각 단위로 지나간다.
            res.writeHead(upRes.statusCode ?? 502, upRes.headers);
            const status = upRes.statusCode ?? 0;
            // 업스트림 429 = 구독 한도(§4.3). 스트림은 그대로 지나가고(SDK 가 받는다), 로그만 남긴다 — 소유자
            // 우선은 프록시가 아니라 봇의 사전 게이트(3.3, 부원만 예약)가 집행하므로 여기서 신원으로 가르지 않는다.
            if (status === 429) console.warn("[llm] 업스트림 429 — 구독 한도에 닿았어요.");
            // 사용량 기록(3단계 3.2, 2026-09-22 N0 재작업): 성공 응답의 본문을 곁으로 읽는다. 관찰자(data)를 pipe 보다
            // 먼저 걸어, dest 백프레셔로 소스가 멈추면 관찰자도 함께 멈춘다(둘 다 같은 data 이벤트를 본다).
            // 모양은 content-type 이 정한다 — 스트리밍이면 SSE 이벤트에서, 아니면 JSON 본문 최상위 usage 에서.
            // content-encoding 이 남아 있으면(accept-encoding 을 뗐으니 정상이라면 없다) 읽을 수 없으므로 시도하지 않는다.
            const contentType = String(upRes.headers["content-type"] ?? "");
            const contentEncoding = String(upRes.headers["content-encoding"] ?? "");
            const wantUsage = deps.recordUsage !== undefined && status >= 200 && status < 300;
            const encoded = contentEncoding !== "" && contentEncoding !== "identity";
            const sniff = wantUsage && !encoded ? createUsageSniffer(contentType.includes("text/event-stream") ? "sse" : "json") : null;
            upRes.on("data", (chunk: Buffer) => {
              forwarded += chunk.length;
              if (sniff) { try { sniff.push(chunk); } catch { /* 기록 실패가 스트림을 막지 않는다 */ } }
            });
            upRes.on("end", () => {
              upstreamEnded = true;
              if (!wantUsage) return;
              const u = sniff ? sniff.result() : null;
              if (u === null) {
                // 진단(N0): 여기가 찍히면 프록시가 이해하지 못하는 응답 모양이 있다는 뜻이다 — 다음 조사의 첫 증거.
                // 정상 경로(SSE·JSON 어느 쪽이든 usage 를 읽은 경우)에는 아무것도 찍지 않는다.
                console.warn(`[llm] 사용량을 읽지 못했어요 — status ${status}, content-type "${contentType}", content-encoding "${contentEncoding || "없음"}", ${forwarded} 바이트`);
                return;
              }
              try {
                deps.recordUsage!({ ...u, jobId: jobClaims.jobId, userId: jobClaims.userId, conversationId: jobClaims.conversationId, requestModel: pinnedModel ?? requestModel ?? u.model ?? "", ts: nowFn() });
              } catch (err) {
                console.error("[llm] 사용량 기록 실패:", err instanceof Error ? err.message : String(err));
              }
            });
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
      res.on("close", () => {
        // 진단(N0): 응답이 시작된 뒤 업스트림이 끝나기 전에 클라이언트가 끊었다. Claude Code 가 스트리밍을 재시도하다
        // 비스트리밍으로 폴백하는 증상(claude-code #84442 류)이면 이 줄이 턴마다 여러 번 찍힌다. 정상 완료에서는 'close' 가
        // 'end' 뒤에 오므로 찍히지 않는다.
        if (res.headersSent && !upstreamEnded) console.warn(`[llm] 세션이 응답 도중 연결을 끊었어요 — ${forwarded} 바이트 전달 뒤`);
        if (!up.destroyed) up.destroy();
      });
      up.end(body);
    });
  };
}
