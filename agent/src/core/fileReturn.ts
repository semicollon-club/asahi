import type { IncomingMessage, ServerResponse } from "node:http";
import { FILE_LIMITS, safeFileName } from "./attachments.js";
import type { AssistantFileEvent } from "../events/bus.js";
import type { JobTokenClaims } from "./jobToken.js";

// 파일 반환(풀 하네스 설계 §8, 0단계 0.2) — 봇의 `POST /files`. 워커(나중엔 세션 계정)가 만든 산출물의
// 바이트를 봇으로 올리는 유일한 통로다. 허브의 WebSocket 프레임은 1MB 상한(hub.ts 의 MAX_FRAME_CHARS)이라
// 이미지·PDF 를 그 안에 실을 수 없어 HTTP 엔드포인트를 따로 둔다. 봇은 받은 바이트를 디스크에 쓰지
// 않는다 — 곧장 assistant_file 이벤트로 어댑터에 넘기고, 어댑터가 그 대화 채널에 첨부로 보낸다.
//
// 인증은 작업 토큰(jobToken.ts) 하나다. 요청이 "어느 채널로 보내 달라"고 말할 자리는 없다 — 채널은 토큰
// 안의 claims.channelRef 가 정한다. 그래서 토큰을 든 쪽(그 턴의 워커)이 할 수 있는 일은 자기 대화 채널에
// 첨부를 올리는 것뿐이고, 다른 채널로 보내는 표면 자체가 없다.
//
// 이 파일은 봇 쪽 모듈이지만 워커(executors.ts)도 상수 셋(경로·헤더 이름·상한)과 fileReturnUrlOf 를
// 가져다 쓴다 — 두 끝이 같은 값을 봐야 하고, 이 모듈은 discord.js·store 어디에도 의존하지 않는다.

export const FILE_RETURN_PATH = "/files";

// 첨부 내려받기(attachments.ts 의 FILE_LIMITS)와 같은 값이어야 한다 — 그쪽 주석대로 두 방향의 상한이
// 갈리면 "디스코드에는 올라갔는데 워커가 못 받는" 또는 그 반대의 파일이 생긴다. 디스코드의 기본 첨부
// 한도는 등급·시기에 따라 8~25MB 사이를 오갔고 8MB 는 어느 등급에서도 확실히 통과한다.
export const FILE_RETURN_MAX_BYTES = FILE_LIMITS.maxBytes;

// 파일 이름은 본문이 아니라 헤더로 받는다(본문은 바이트 그대로). 한글 이름이 흔하므로 값은
// percent-encoding(encodeURIComponent)이다 — HTTP 헤더는 ASCII 만 안전하다.
export const FILE_NAME_HEADER = "x-asahi-file-name";

// 워커가 업로드 주소를 HUB_URL 에서 유도한다(계획 0.3). 설정을 하나 더 두지 않는 이유: 허브와 /files 는
// 같은 http 서버(index.ts)의 두 경로라 호스트가 갈릴 수 없고, 봇이 URL 을 실어 보내면 모델이 그 값을
// 정할 여지를 두는 셈이다 — 워커가 자기 설정에서만 만든다.
export function fileReturnUrlOf(hubUrl: string): string | null {
  const base = httpBaseOfHub(hubUrl);
  return base === null ? null : `${base}${FILE_RETURN_PATH}`;
}

// HUB_URL(ws[s]://host[:port]/worker) → 같은 서버의 HTTP 기본 주소(http[s]://host[:port]). 파일 반환(/files)과 인증 프록시
// (/llm, remote/sessionRunner.ts)가 같은 규칙을 쓴다 — 허브·/files·/llm 은 index.ts 의 한 http 서버라 호스트가 갈릴 수 없다.
export function httpBaseOfHub(hubUrl: string): string | null {
  let u: URL;
  try {
    u = new URL(hubUrl);
  } catch {
    return null;
  }
  const proto: Record<string, string> = { "wss:": "https:", "ws:": "http:", "https:": "https:", "http:": "http:" };
  const scheme = proto[u.protocol];
  if (!scheme) return null;
  const base = u.pathname.replace(/\/worker\/?$/, "").replace(/\/+$/, "");
  return `${scheme}//${u.host}${base}`;
}

export function bearerTokenOf(header: string | string[] | undefined): string | null {
  if (typeof header !== "string") return null;
  const m = /^Bearer\s+(\S+)$/i.exec(header.trim());
  return m ? m[1] : null;
}

// 깨진 percent-encoding 은 예외가 아니라 null — 요청 하나가 봇을 죽이면 안 된다. 이름 규칙(safeFileName)은
// 첨부 내려받기와 같은 것을 쓴다: 경로 구분자·상위 이동·널 문자가 있으면 고치지 않고 거절한다.
export function decodeFileNameHeader(v: string | string[] | undefined): string | null {
  if (typeof v !== "string" || v.length === 0) return null;
  let decoded: string;
  try {
    decoded = decodeURIComponent(v);
  } catch {
    return null;
  }
  return safeFileName(decoded);
}

export type BodyRead = { ok: true; data: Buffer } | { ok: false; reason: "too_large" | "aborted" };

// 상한을 넘는 순간 멈춘다 — content-length 가 없는(chunked) 요청도 여기서 잡힌다. 넘긴 뒤 들어오는
// 조각은 버린다(호출측이 응답 뒤 연결을 끊는다).
export function readBodyCapped(req: IncomingMessage, maxBytes: number): Promise<BodyRead> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let done = false;
    const finish = (r: BodyRead) => {
      if (done) return;
      done = true;
      resolve(r);
    };
    req.on("data", (chunk: Buffer) => {
      if (done) return;
      total += chunk.length;
      if (total > maxBytes) {
        finish({ ok: false, reason: "too_large" });
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => finish({ ok: true, data: Buffer.concat(chunks) }));
    req.on("error", () => finish({ ok: false, reason: "aborted" }));
    req.on("aborted", () => finish({ ok: false, reason: "aborted" }));
  });
}

export type FileReturnDeps = {
  // 작업 토큰 검증(index.ts 가 makeJobTokenMinter 의 verify 를 넘긴다). 던져도 401 로 취급한다.
  verify(token: string): JobTokenClaims | null;
  // 이벤트버스로 넘기는 이음매 — 테스트가 버스 없이 발행된 이벤트를 그대로 본다.
  publish(e: AssistantFileEvent): void;
  now(): number;
  maxBytes?: number;
};

type Reply = { status: number; body: Record<string, unknown>; close: boolean };

// 요청 헤더만 보고 정하는 부분은 순수하게 뽑아 둔다 — 본문을 읽기 전에 거를 수 있는 것(토큰·이름·선언된
// 크기)은 전부 여기서 거른다. 본문을 다 받고서야 거절하면 상한을 넘는 업로드가 대역폭을 다 쓰고 거절된다.
export function decideBeforeBody(
  headers: IncomingMessage["headers"],
  verify: FileReturnDeps["verify"],
  maxBytes: number,
): { ok: true; claims: JobTokenClaims; name: string } | { ok: false; reply: Reply } {
  const token = bearerTokenOf(headers.authorization);
  let claims: JobTokenClaims | null = null;
  if (token !== null) {
    try {
      claims = verify(token);
    } catch {
      claims = null;
    }
  }
  if (claims === null) {
    return { ok: false, reply: { status: 401, body: { ok: false, error: "작업 토큰이 없거나 유효하지 않아요." }, close: true } };
  }
  const name = decodeFileNameHeader(headers[FILE_NAME_HEADER]);
  if (name === null) {
    return { ok: false, reply: { status: 400, body: { ok: false, error: `${FILE_NAME_HEADER} 헤더에 쓸 수 있는 파일 이름(percent-encoding)이 필요해요.` }, close: true } };
  }
  const declared = Number(headers["content-length"]);
  if (Number.isFinite(declared) && declared > maxBytes) {
    return { ok: false, reply: tooLarge(maxBytes) };
  }
  return { ok: true, claims, name };
}

function tooLarge(maxBytes: number): Reply {
  return { status: 413, body: { ok: false, error: `파일이 상한(${maxBytes} 바이트)을 넘어요.`, maxBytes }, close: true };
}

export function makeFileReturnHandler(deps: FileReturnDeps): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  const maxBytes = deps.maxBytes ?? FILE_RETURN_MAX_BYTES;
  return async (req, res) => {
    // 응답을 쓰고(선택적으로) 연결을 끊는다. close 는 거절 응답에 쓴다 — 거절한 뒤에도 클라이언트가 본문을
    // 계속 흘려보내면 그 바이트를 받을 이유가 없다. 소켓이 이미 죽어 finish 가 안 오는 경우에도 매달리지
    // 않도록 close/error 에서도 풀어 준다.
    const reply = (r: Reply): Promise<void> =>
      new Promise((resolve) => {
        if (res.writableEnded || res.destroyed) {
          resolve();
          return;
        }
        res.once("close", () => resolve());
        res.once("error", () => resolve());
        res.writeHead(r.status, { "content-type": "application/json; charset=utf-8", ...(r.close ? { connection: "close" } : {}) });
        res.end(JSON.stringify(r.body), () => {
          if (r.close) req.destroy();
          resolve();
        });
      });
    try {
      const pre = decideBeforeBody(req.headers, deps.verify, maxBytes);
      if (!pre.ok) return await reply(pre.reply);
      const body = await readBodyCapped(req, maxBytes);
      if (!body.ok) {
        return await reply(body.reason === "too_large" ? tooLarge(maxBytes) : { status: 400, body: { ok: false, error: "본문 수신이 중단됐어요." }, close: true });
      }
      if (body.data.length === 0) return await reply({ status: 400, body: { ok: false, error: "본문이 비어 있어요." }, close: false });
      deps.publish({ type: "assistant_file", channel: "discord", channelRef: pre.claims.channelRef, name: pre.name, data: body.data, ts: deps.now() });
      return await reply({ status: 200, body: { ok: true, name: pre.name, bytes: body.data.length }, close: false });
    } catch (err) {
      console.error("[files] 처리 오류:", err);
      if (!res.headersSent) await reply({ status: 500, body: { ok: false, error: "서버 오류" }, close: true });
    }
  };
}
