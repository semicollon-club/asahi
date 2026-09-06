import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { sendFileHandler, type SendFileDeps } from "../src/mcp/sendFileServer.js";
import { FILE_NAME_HEADER } from "../src/core/fileReturn.js";

// 세션 인프로세스 send_file(풀 하네스 4단계 4.5). 하네스 턴이 만든 파일을 봇의 POST /files(작업 토큰)로 올려
// 디스코드에 첨부한다. 여기서는 업로드 본체(sendFileHandler)를 임시 파일·가짜 fetch 로 고정한다 — 경로 스코프,
// 크기 상한, 헤더(작업 토큰·파일 이름), 업스트림 상태 처리.

let cwd: string;
beforeEach(() => { cwd = fs.mkdtempSync(path.join(os.tmpdir(), "asahi-sendfile-")); });
afterEach(() => { fs.rmSync(cwd, { recursive: true, force: true }); });

type Captured = { url: string; headers: Record<string, string>; bodyLen: number };
function fakeFetch(status: number, capture: Captured[]): typeof fetch {
  return (async (url: string | URL, init?: RequestInit) => {
    const headers = init?.headers as Record<string, string>;
    const body = init?.body as Uint8Array;
    capture.push({ url: String(url), headers, bodyLen: body?.byteLength ?? 0 });
    return new Response(status === 200 ? "ok" : "err", { status });
  }) as unknown as typeof fetch;
}

const deps = (over: Partial<SendFileDeps>): SendFileDeps => ({
  fileReturnUrl: "http://127.0.0.1:3100/files", token: "asahi-job.x.y", cwd, ...over,
});

describe("sendFileHandler", () => {
  it("작업 폴더 안 파일을 작업 토큰·파일 이름 헤더와 함께 /files 로 올린다", async () => {
    fs.writeFileSync(path.join(cwd, "out.png"), Buffer.from("PNGDATA"));
    const cap: Captured[] = [];
    const r = await sendFileHandler(deps({ fetchImpl: fakeFetch(200, cap) }), { path: "out.png" });
    expect(r.isError).toBeFalsy();
    expect(r.content[0].text).toContain("out.png");
    expect(cap).toHaveLength(1);
    expect(cap[0].url).toBe("http://127.0.0.1:3100/files");
    expect(cap[0].headers.authorization).toBe("Bearer asahi-job.x.y");
    expect(cap[0].headers[FILE_NAME_HEADER]).toBe(encodeURIComponent("out.png"));
    expect(cap[0].bodyLen).toBe(7);
  });

  it("작업 폴더 밖 경로는 거부하고 업로드하지 않는다", async () => {
    const cap: Captured[] = [];
    const r = await sendFileHandler(deps({ fetchImpl: fakeFetch(200, cap) }), { path: "../../etc/hosts" });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain("작업 폴더");
    expect(cap).toHaveLength(0);
  });

  it("없는 파일은 오류로 드러낸다(속이지 않는다)", async () => {
    const cap: Captured[] = [];
    const r = await sendFileHandler(deps({ fetchImpl: fakeFetch(200, cap) }), { path: "nope.txt" });
    expect(r.isError).toBe(true);
    expect(cap).toHaveLength(0);
  });

  it("상한을 넘는 파일은 올리지 않고 안내한다", async () => {
    fs.writeFileSync(path.join(cwd, "big.bin"), Buffer.alloc(100));
    const cap: Captured[] = [];
    const r = await sendFileHandler(deps({ maxBytes: 50, fetchImpl: fakeFetch(200, cap) }), { path: "big.bin" });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain("상한");
    expect(cap).toHaveLength(0);
  });

  it("업스트림 413·401 을 사람 문구로 바꾼다", async () => {
    fs.writeFileSync(path.join(cwd, "a.txt"), "x");
    const r413 = await sendFileHandler(deps({ fetchImpl: fakeFetch(413, []) }), { path: "a.txt" });
    expect(r413.isError).toBe(true);
    expect(r413.content[0].text).toContain("상한");
    const r401 = await sendFileHandler(deps({ fetchImpl: fakeFetch(401, []) }), { path: "a.txt" });
    expect(r401.isError).toBe(true);
    expect(r401.content[0].text).toContain("토큰");
  });

  it("폴더는 보낼 수 없다", async () => {
    fs.mkdirSync(path.join(cwd, "sub"));
    const r = await sendFileHandler(deps({ fetchImpl: fakeFetch(200, []) }), { path: "sub" });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain("폴더");
  });
});
