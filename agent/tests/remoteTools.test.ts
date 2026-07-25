import { describe, it, expect } from "vitest";
import { REMOTE_TOOL_NAMES, remoteToolHandler } from "../src/core/remoteTools.js";
import type { ToolCtx } from "../src/core/tools.js";

const ctxWith = (call: ToolCtx["remote"]): ToolCtx => ({ remote: call } as unknown as ToolCtx);

describe("원격 도구", () => {
  it("도구 이름 6개를 고정으로 노출한다", () => {
    expect([...REMOTE_TOOL_NAMES].sort()).toEqual(["fs_edit", "fs_glob", "fs_grep", "fs_read", "fs_write", "sh_exec"]);
  });

  it("허브 호출 결과를 그대로 문자열로 돌려준다", async () => {
    const ctx = ctxWith({ call: async () => ({ ok: true, content: "본문" }) });
    expect(await remoteToolHandler(ctx, "fs_read", { path: "/w/a" })).toBe("본문");
  });

  it("실패해도 예외를 던지지 않고 내용을 돌려준다(턴이 죽지 않게)", async () => {
    const ctx = ctxWith({ call: async () => ({ ok: false, content: "폴더 밖 경로예요" }) });
    await expect(remoteToolHandler(ctx, "fs_read", { path: "/x" })).resolves.toContain("폴더 밖");
  });

  it("워커 연결이 없으면 안내 문구를 돌려준다", async () => {
    const ctx = ctxWith(undefined);
    await expect(remoteToolHandler(ctx, "fs_read", {})).resolves.toContain("워커");
  });

  it("호출한 도구 이름과 인자를 그대로 허브에 전달한다", async () => {
    const seen: Array<{ tool: string; args: Record<string, unknown> }> = [];
    const ctx = ctxWith({ call: async (tool, args) => { seen.push({ tool, args }); return { ok: true, content: "" }; } });
    await remoteToolHandler(ctx, "sh_exec", { command: "ls" });
    expect(seen).toEqual([{ tool: "sh_exec", args: { command: "ls" } }]);
  });
});

describe("봇 쪽 1차 경로 필터", () => {
  const withDirs = (dirs: string[], call: ToolCtx["remote"]): ToolCtx =>
    ({ remote: call, userId: "owner", repos: { allowedDirs: { list: async () => dirs } } } as unknown as ToolCtx);

  it("allowed_dirs 밖 경로는 허브를 부르지 않고 거부한다", async () => {
    let called = false;
    const ctx = withDirs(["/w/proj"], { call: async () => { called = true; return { ok: true, content: "" }; } });
    const out = await remoteToolHandler(ctx, "fs_read", { path: "/etc/passwd" });
    expect(called).toBe(false);
    expect(out).toContain("허용");
  });

  it("allowed_dirs 안 경로는 통과시킨다", async () => {
    const ctx = withDirs(["/w/proj"], { call: async () => ({ ok: true, content: "본문" }) });
    await expect(remoteToolHandler(ctx, "fs_read", { path: "/w/proj/a.txt" })).resolves.toBe("본문");
  });

  it("allowed_dirs 가 비어 있으면 등록을 안내한다", async () => {
    const ctx = withDirs([], { call: async () => ({ ok: true, content: "" }) });
    await expect(remoteToolHandler(ctx, "fs_read", { path: "/w/a" })).resolves.toContain("allow_dir");
  });

  it("경로 인자가 없는 sh_exec 는 1차 필터를 건너뛴다(워커가 판정)", async () => {
    const ctx = withDirs(["/w/proj"], { call: async () => ({ ok: true, content: "출력" }) });
    await expect(remoteToolHandler(ctx, "sh_exec", { command: "ls" })).resolves.toBe("출력");
  });
});
