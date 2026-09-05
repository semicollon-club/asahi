import { describe, it, expect, afterEach } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import {
  FILE_RETURN_PATH, FILE_RETURN_MAX_BYTES, FILE_NAME_HEADER,
  fileReturnUrlOf, bearerTokenOf, decodeFileNameHeader, makeFileReturnHandler,
} from "../src/core/fileReturn.js";
import { FILE_LIMITS } from "../src/core/attachments.js";
import type { AssistantFileEvent } from "../src/events/bus.js";
import type { JobTokenClaims } from "../src/core/jobToken.js";

// 봇의 `POST /files`(풀 하네스 설계 §8, 0단계 0.2). 워커의 send_file 이 파일 바이트를 여기로 올리면
// 봇이 그 대화 채널로 첨부 이벤트(assistant_file)를 낸다. 1MB 프레임 한계(hub.ts 의 MAX_FRAME_CHARS)를
// 우회하는 유일한 통로라 상한(8MB — attachments.ts 의 FILE_LIMITS 와 같은 값)과 인증(작업 토큰)이 전부다.
//
// 실제 http 서버를 임시 포트에 띄워 fetch 로 친다 — content-length 유무·청크 스트리밍·헤더 처리는 가짜
// req/res 로 흉내내면 정확히 그 부분이 검증에서 빠진다.

const goodClaims: JobTokenClaims = { jobId: "j", userId: "u1", conversationId: 5, channelRef: "chan-5", exp: 99 };

function makeServer(opts: { verify?: (t: string) => JobTokenClaims | null; maxBytes?: number } = {}) {
  const published: AssistantFileEvent[] = [];
  const handler = makeFileReturnHandler({
    verify: opts.verify ?? ((t) => (t === "good" ? goodClaims : null)),
    publish: (e) => { published.push(e); },
    now: () => 1_234,
    ...(opts.maxBytes !== undefined ? { maxBytes: opts.maxBytes } : {}),
  });
  const server = http.createServer((req, res) => {
    if (req.method === "POST" && req.url === FILE_RETURN_PATH) { void handler(req, res); return; }
    res.writeHead(404); res.end();
  });
  return new Promise<{ url: string; published: AssistantFileEvent[]; close: () => Promise<void> }>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${port}${FILE_RETURN_PATH}`,
        published,
        close: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}

const closers: Array<() => Promise<void>> = [];
afterEach(async () => { while (closers.length) await closers.pop()!(); });

async function up(opts?: Parameters<typeof makeServer>[0]) {
  const s = await makeServer(opts);
  closers.push(s.close);
  return s;
}

const post = (url: string, body: BodyInit | null, headers: Record<string, string>) =>
  fetch(url, { method: "POST", body, headers });

describe("fileReturnUrlOf — 워커가 HUB_URL 에서 업로드 주소를 유도한다", () => {
  it("wss://host/worker → https://host/files, ws → http", () => {
    expect(fileReturnUrlOf("wss://asahi.up.railway.app/worker")).toBe("https://asahi.up.railway.app/files");
    expect(fileReturnUrlOf("ws://127.0.0.1:3000/worker")).toBe("http://127.0.0.1:3000/files");
  });

  it("끝 슬래시·/worker 없는 주소도 /files 하나로 귀결된다", () => {
    expect(fileReturnUrlOf("wss://h/worker/")).toBe("https://h/files");
    expect(fileReturnUrlOf("wss://h")).toBe("https://h/files");
  });

  it("URL 이 아니거나 ws/wss/http/https 가 아니면 null", () => {
    expect(fileReturnUrlOf("not a url")).toBeNull();
    expect(fileReturnUrlOf("ftp://h/worker")).toBeNull();
  });
});

describe("헤더 파싱", () => {
  it("bearerTokenOf 는 Bearer 접두를 떼고, 다른 형식은 null", () => {
    expect(bearerTokenOf("Bearer abc")).toBe("abc");
    expect(bearerTokenOf("bearer abc")).toBe("abc");
    expect(bearerTokenOf("Basic abc")).toBeNull();
    expect(bearerTokenOf(undefined)).toBeNull();
    expect(bearerTokenOf("Bearer ")).toBeNull();
  });

  it("decodeFileNameHeader 는 percent-encoding 을 풀고 safeFileName 규칙을 적용한다", () => {
    expect(decodeFileNameHeader(encodeURIComponent("보고서 v2.pdf"))).toBe("보고서 v2.pdf");
    expect(decodeFileNameHeader("plain.png")).toBe("plain.png");
    expect(decodeFileNameHeader(encodeURIComponent("../escape.png"))).toBeNull();
    expect(decodeFileNameHeader(encodeURIComponent("a/b.png"))).toBeNull();
    expect(decodeFileNameHeader("%E0%A4%A")).toBeNull(); // 깨진 인코딩은 예외가 아니라 null
    expect(decodeFileNameHeader(undefined)).toBeNull();
    expect(decodeFileNameHeader("")).toBeNull();
  });
});

describe("POST /files", () => {
  it("상한 상수는 첨부 내려받기 상한(FILE_LIMITS.maxBytes)과 같은 값이다 — 두 방향이 갈리면 '올렸는데 못 돌려받는' 파일이 생긴다", () => {
    expect(FILE_RETURN_MAX_BYTES).toBe(FILE_LIMITS.maxBytes);
  });

  it("토큰이 없으면 401 이고 이벤트를 내지 않는다", async () => {
    const s = await up();
    const r = await post(s.url, "hello", { [FILE_NAME_HEADER]: "a.txt" });
    expect(r.status).toBe(401);
    expect(s.published).toHaveLength(0);
  });

  it("토큰이 틀리면 401", async () => {
    const s = await up();
    const r = await post(s.url, "hello", { authorization: "Bearer bad", [FILE_NAME_HEADER]: "a.txt" });
    expect(r.status).toBe(401);
    expect(s.published).toHaveLength(0);
  });

  it("파일 이름 헤더가 없거나 쓸 수 없는 이름이면 400", async () => {
    const s = await up();
    expect((await post(s.url, "hello", { authorization: "Bearer good" })).status).toBe(400);
    expect((await post(s.url, "hello", { authorization: "Bearer good", [FILE_NAME_HEADER]: encodeURIComponent("../x.txt") })).status).toBe(400);
    expect(s.published).toHaveLength(0);
  });

  it("content-length 가 상한을 넘으면 본문을 읽기 전에 413", async () => {
    const s = await up({ maxBytes: 10 });
    const r = await post(s.url, Buffer.alloc(11, 1), { authorization: "Bearer good", [FILE_NAME_HEADER]: "big.bin" });
    expect(r.status).toBe(413);
    expect(s.published).toHaveLength(0);
  });

  it("content-length 없이 흘려보내도 상한을 넘는 순간 413 으로 끊는다", async () => {
    const s = await up({ maxBytes: 10 });
    // ReadableStream 본문은 chunked 전송이 되어 content-length 가 없다 — 스트림 상한이 따로 있어야 한다.
    const stream = new ReadableStream<Uint8Array>({
      start(c) { c.enqueue(new Uint8Array(6)); c.enqueue(new Uint8Array(6)); c.close(); },
    });
    const r = await fetch(s.url, {
      method: "POST", body: stream, headers: { authorization: "Bearer good", [FILE_NAME_HEADER]: "big.bin" },
      // @ts-expect-error — Node 의 fetch(undici)는 스트림 본문에 duplex 지정을 요구한다.
      duplex: "half",
    }).catch((e: unknown) => e);
    // 서버가 연결을 끊어 응답을 못 받을 수도 있다(undici 가 write 중 EPIPE) — 어느 쪽이든 이벤트는 없어야 한다.
    if (r instanceof Response) expect(r.status).toBe(413);
    expect(s.published).toHaveLength(0);
  });

  it("본문이 비어 있으면 400", async () => {
    const s = await up();
    const r = await post(s.url, null, { authorization: "Bearer good", [FILE_NAME_HEADER]: "empty.txt" });
    expect(r.status).toBe(400);
    expect(s.published).toHaveLength(0);
  });

  it("성공하면 200 과 함께 토큰의 채널로 assistant_file 이벤트를 낸다 — 이름은 percent-decoding 되고 바이트는 그대로", async () => {
    const s = await up();
    const bytes = Buffer.from([0, 1, 2, 255, 128, 10, 13]);
    const r = await post(s.url, bytes, {
      authorization: "Bearer good",
      [FILE_NAME_HEADER]: encodeURIComponent("결과 그림.png"),
      "content-type": "application/octet-stream",
    });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ ok: true, name: "결과 그림.png", bytes: bytes.length });
    expect(s.published).toHaveLength(1);
    const e = s.published[0];
    expect(e.type).toBe("assistant_file");
    expect(e.channel).toBe("discord");
    expect(e.channelRef).toBe("chan-5"); // 요청이 아니라 토큰이 채널을 정한다
    expect(e.name).toBe("결과 그림.png");
    expect(Buffer.from(e.data).equals(bytes)).toBe(true);
    expect(e.ts).toBe(1_234);
  });

  it("verify 가 던져도 500 이 아니라 401 — 검증 실패와 같은 취급", async () => {
    const s = await up({ verify: () => { throw new Error("boom"); } });
    const r = await post(s.url, "x", { authorization: "Bearer good", [FILE_NAME_HEADER]: "a.txt" });
    expect(r.status).toBe(401);
  });
});

// 두 끝을 실제로 잇는다 — 워커 실행기(send_file, 진짜 fetch)가 봇 핸들러(진짜 http 서버)에 올려 이벤트가 나는지.
// 위 단위 테스트들은 각각 가짜 fetch·가짜 요청으로 한쪽만 보므로, 헤더 이름의 대소문자·percent-encoding·
// Buffer 본문 전송처럼 "양쪽이 같은 약속을 지키는가"는 여기서만 잡힌다.
describe("워커 send_file → 봇 /files 왕복(실제 HTTP)", () => {
  it("워커 폴더의 파일이 토큰의 채널로 첨부 이벤트가 되어 나온다", async () => {
    const { makeExecutors } = await import("../src/remote/executors.js");
    const { makeJobTokenMinter, newJobTokenSecret } = await import("../src/core/jobToken.js");
    const fs = await import("node:fs");
    const os = await import("node:os");
    const path = await import("node:path");

    const minter = makeJobTokenMinter(newJobTokenSecret());
    const published: AssistantFileEvent[] = [];
    const handler = makeFileReturnHandler({ verify: (t) => minter.verify(t), publish: (e) => { published.push(e); }, now: () => 7 });
    const server = http.createServer((req, res) => { void handler(req, res); });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    closers.push(() => new Promise((r) => server.close(() => r())));
    const { port } = server.address() as AddressInfo;
    // 워커는 HUB_URL 에서 주소를 유도한다 — 그 유도 함수를 그대로 태운다.
    const uploadUrl = fileReturnUrlOf(`ws://127.0.0.1:${port}/worker`);
    expect(uploadUrl).toBe(`http://127.0.0.1:${port}/files`);

    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "asahi-sf-")));
    closers.push(async () => fs.rmSync(root, { recursive: true, force: true }));
    const bytes = Buffer.from([137, 80, 78, 71, 0, 1, 2, 3]);
    fs.writeFileSync(path.join(root, "결과 그림.png"), bytes);

    const ex = makeExecutors([root], { fileReturnUrl: uploadUrl! });
    const token = minter.mint({ userId: "u1", conversationId: 9, channelRef: "chan-9" });
    const r = await ex.send_file({ path: path.join(root, "결과 그림.png"), upload: { token } });
    expect(r.ok).toBe(true);
    expect(published).toHaveLength(1);
    expect(published[0].channelRef).toBe("chan-9");
    expect(published[0].name).toBe("결과 그림.png");
    expect(Buffer.from(published[0].data).equals(bytes)).toBe(true);

    // 만료된 토큰은 봇이 401 — 워커 문구는 "토큰 거부".
    const expired = makeJobTokenMinter(newJobTokenSecret(), { ttlMs: 1, now: () => 0 }).mint({ userId: "u1", conversationId: 9, channelRef: "chan-9" });
    const r2 = await ex.send_file({ path: path.join(root, "결과 그림.png"), upload: { token: expired } });
    expect(r2.ok).toBe(false);
    expect(r2.content).toContain("토큰");
    expect(published).toHaveLength(1);
  });
});
