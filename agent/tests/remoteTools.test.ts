import { describe, it, expect } from "vitest";
import { REMOTE_TOOL_NAMES, remoteToolHandler } from "../src/core/remoteTools.js";
import type { ToolCtx } from "../src/core/tools.js";

// 기본값은 "소유자 DM"을 나타낸다 — remoteToolHandler 가 최상단에서 신원을 독립적으로 재확인하므로
// (FIX1), 신원 자체를 검증 대상으로 삼지 않는 테스트는 소유자 DM 으로 고정해 통과시킨다.
// over 로 repos 등 추가 필드를 덧붙일 수 있다(경로 인자가 있는 케이스에서 필요).
const ctxWith = (call: ToolCtx["remote"], over: Record<string, unknown> = {}): ToolCtx =>
  ({ remote: call, isOwner: true, isPrivate: true, ...over } as unknown as ToolCtx);

describe("원격 도구", () => {
  it("도구 이름 6개를 고정으로 노출한다", () => {
    expect([...REMOTE_TOOL_NAMES].sort()).toEqual(["fs_edit", "fs_glob", "fs_grep", "fs_read", "fs_write", "sh_exec"]);
  });

  it("허브 호출 결과를 그대로 문자열로 돌려준다", async () => {
    // path 인자가 있으므로 1차 필터가 동작한다 — repos.allowedDirs 를 채워 통과시킨다(이 테스트의
    // 관심사는 신원 재확인이 아니라 허브 결과의 그대로 전달이다).
    const ctx = ctxWith(
      { call: async () => ({ ok: true, content: "본문" }) },
      { userId: "owner", repos: { allowedDirs: { list: async () => ["/w"] } } },
    );
    expect(await remoteToolHandler(ctx, "fs_read", { path: "/w/a" })).toBe("본문");
  });

  it("실패해도 예외를 던지지 않고 내용을 돌려준다(턴이 죽지 않게)", async () => {
    const ctx = ctxWith(
      { call: async () => ({ ok: false, content: "폴더 밖 경로예요" }) },
      { userId: "owner", repos: { allowedDirs: { list: async () => ["/x"] } } },
    );
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
    ({ remote: call, isOwner: true, isPrivate: true, userId: "owner", repos: { allowedDirs: { list: async () => dirs } } } as unknown as ToolCtx);

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

  it("sh_exec 는 경로 인자가 없어 1차 필터 대상이 아니다(셸은 경로 인자로 봉쇄할 수 없다는 설계 그대로 — FIX6 은 문서만 바로잡고 이 동작은 바꾸지 않는다)", async () => {
    const ctx = withDirs(["/w/proj"], { call: async () => ({ ok: true, content: "출력" }) });
    await expect(remoteToolHandler(ctx, "sh_exec", { command: "ls" })).resolves.toBe("출력");
  });
});

// ── FIX6: fs_glob·fs_grep 는 path 인자 유무만으로 1차 필터를 건너뛰면 안 된다 ───────────────
// path 가 생략되면 allowedDirs 검사 자체가 통째로 스킵됐었다(빈 allowedDirs 로도 워커 루트 전체를
// 열거할 수 있었다) — 그리고 path 가 허용 폴더 안이어도 pattern 이 '../../**/*' 같은 값이면 봇 쪽은
// path 만 보고 통과시켰다(워커도 roots 만 재검사할 뿐 allowedDirs 는 모른다). 이 두 도구가 대체한
// 로컬 SDK Glob/Grep 게이트(pathPermission.ts 의 extractCandidatePaths)가 이미 풀어 둔 문제라
// 그 로직을 재사용해 검증한다.
describe("FIX6 — fs_glob·fs_grep 는 path 가 없어도, pattern 이 벗어나도 1차 필터를 건너뛰지 않는다", () => {
  const withDirs = (dirs: string[], call: ToolCtx["remote"]): ToolCtx =>
    ({ remote: call, isOwner: true, isPrivate: true, userId: "owner", repos: { allowedDirs: { list: async () => dirs } } } as unknown as ToolCtx);

  it("fs_glob 는 path 생략 + allowedDirs 가 비어 있으면 허브를 부르지 않고 거부한다(전체 루트 열거 방지)", async () => {
    let called = false;
    const ctx = withDirs([], { call: async () => { called = true; return { ok: true, content: "" }; } });
    const out = await remoteToolHandler(ctx, "fs_glob", { pattern: "**/*" });
    expect(called).toBe(false);
    expect(out).toContain("allow_dir");
  });

  it("fs_grep 는 path 생략 + allowedDirs 가 비어 있으면 허브를 부르지 않고 거부한다(전체 루트 열거 방지)", async () => {
    let called = false;
    const ctx = withDirs([], { call: async () => { called = true; return { ok: true, content: "" }; } });
    const out = await remoteToolHandler(ctx, "fs_grep", { pattern: "secret" });
    expect(called).toBe(false);
    expect(out).toContain("allow_dir");
  });

  it("fs_glob 는 path 를 생략해도 allowedDirs 가 있으면 그 첫 폴더를 기본값으로 검사해 통과시킨다(기존 동작 유지)", async () => {
    const ctx = withDirs(["/w/proj"], { call: async () => ({ ok: true, content: "목록" }) });
    await expect(remoteToolHandler(ctx, "fs_glob", { pattern: "**/*" })).resolves.toBe("목록");
  });

  it("fs_grep 는 path 를 생략해도 allowedDirs 가 있으면 그 첫 폴더를 기본값으로 검사해 통과시킨다(기존 동작 유지)", async () => {
    const ctx = withDirs(["/w/proj"], { call: async () => ({ ok: true, content: "결과" }) });
    await expect(remoteToolHandler(ctx, "fs_grep", { pattern: "TODO" })).resolves.toBe("결과");
  });

  it("fs_glob 는 path 는 허용 폴더 안이어도 pattern 이 '../../**/*' 로 그 밖을 가리키면 허브를 부르지 않고 거부한다", async () => {
    let called = false;
    const ctx = withDirs(["/w/proj"], { call: async () => { called = true; return { ok: true, content: "" }; } });
    const out = await remoteToolHandler(ctx, "fs_glob", { path: "/w/proj", pattern: "../../**/*" });
    expect(called).toBe(false);
    expect(out).toContain("허용된 폴더 밖");
  });

  it("fs_glob 는 path·pattern 이 전부 허용 폴더 안이면 정상적으로 허브를 부른다(회귀 없음)", async () => {
    const ctx = withDirs(["/w/proj"], { call: async () => ({ ok: true, content: "목록2" }) });
    await expect(remoteToolHandler(ctx, "fs_glob", { path: "/w/proj", pattern: "**/*.ts" })).resolves.toBe("목록2");
  });
});

// ── FIX1: 핸들러 자체의 신원 재확인(allowedToolsFor 와 독립) ─────────────────
// ctx.remote 는 "워커 연결 여부"만 보고 채워질 수 있어(허브 배선은 이 턴이 공개 채널인지 모른다),
// allowedToolsFor 가 이번 턴에 도구를 안 줬다는 사실 하나에만 기대면 안 된다. 핸들러 자신이
// dbQueryHandler 등의 isOwnerDm/allowDirHandler 등의 canManagePc 처럼 다시 신원을 확인해야 한다.
describe("FIX1 — 핸들러 자체의 신원 재확인", () => {
  it("손님 DM 은 거부하고 허브를 부르지 않는다", async () => {
    let called = false;
    const ctx = ({
      remote: { call: async () => { called = true; return { ok: true, content: "본문" }; } },
      isOwner: false, isPrivate: true, userId: "guest",
    } as unknown as ToolCtx);
    const out = await remoteToolHandler(ctx, "sh_exec", { command: "ls" });
    expect(called).toBe(false);
    expect(out).toContain("소유자");
  });

  it("공개 서버 채널은 소유자여도 거부하고 허브를 부르지 않는다", async () => {
    // 리뷰가 지적한 시나리오: 소유자의 워커가 연결돼 있어 ctx.remote 는 채워지지만, 이 턴 자체는
    // 공개 서버 채널이다(isPrivate=false) — allowedToolsFor 가 도구를 안 줘도 handler 는 그와
    // 무관하게 독립적으로 거부해야 한다.
    let called = false;
    const ctx = ({
      remote: { call: async () => { called = true; return { ok: true, content: "본문" }; } },
      isOwner: true, isPrivate: false, userId: "owner",
    } as unknown as ToolCtx);
    const out = await remoteToolHandler(ctx, "sh_exec", { command: "ls" });
    expect(called).toBe(false);
    expect(out).toContain("소유자");
  });
});

// ── FIX2: 두 await 지점 모두 절대 던지지 않는다 ─────────────────────────────
// WorkerHub.call 은 reject 하지 않도록 설계돼 있지만 그 보장이 깨지는 경우까지 대비하고,
// allowedDirs.list 는 실제 DB 호출이라 애초에 그런 보장이 없다. 둘 다 reject 하면 예외가 아니라
// 문자열이 되어야 한다 — remoteToolHandler 는 절대 던지지 않는다는 게 이 함수의 계약이다.
describe("FIX2 — 원격 호출·DB 조회 실패는 예외가 아니라 문자열로 돌아온다", () => {
  it("허브 call() 이 reject 해도 예외를 던지지 않고 이유를 담은 문자열을 돌려준다", async () => {
    const ctx = ({
      remote: { call: async () => { throw new Error("hub 폭발"); } },
      isOwner: true, isPrivate: true, userId: "owner",
    } as unknown as ToolCtx);
    const out = await remoteToolHandler(ctx, "sh_exec", { command: "ls" });
    expect(out).toContain("오류");
    expect(out).toContain("hub 폭발");
  });

  it("allowedDirs.list() 가 reject 해도(DB 다운 등) 예외를 던지지 않고 이유를 담은 문자열을 돌려준다", async () => {
    let hubCalled = false;
    const ctx = ({
      remote: { call: async () => { hubCalled = true; return { ok: true, content: "본문" }; } },
      isOwner: true, isPrivate: true, userId: "owner",
      repos: { allowedDirs: { list: async () => { throw new Error("db down"); } } },
    } as unknown as ToolCtx);
    const out = await remoteToolHandler(ctx, "fs_read", { path: "/w/a" });
    expect(out).toContain("오류");
    expect(out).toContain("db down");
    expect(hubCalled).toBe(false); // 1차 필터에서 이미 실패했으니 허브까지 갈 이유가 없다
  });
});

// ── FIX3: 빈/공백 path 는 "인자 없음"이 아니라 "잘못된 인자"다 ──────────────
// pathArgOf 가 빈 문자열을 "없음"으로 취급하면 1차 필터 자체가 조용히 스킵된다 — fs_read 등은
// path: z.string() 에 최소 길이 제약이 없어 모델이 "" 를 그대로 만들어낼 수 있다.
describe("FIX3 — 빈/공백 path 는 1차 필터를 건너뛰지 않고 거부한다", () => {
  it("path 가 빈 문자열이거나 공백만이면 허브를 부르지 않고 명확히 거부한다", async () => {
    for (const blank of ["", "   "]) {
      let called = false;
      const ctx = ({
        remote: { call: async () => { called = true; return { ok: true, content: "본문" }; } },
        isOwner: true, isPrivate: true, userId: "owner",
        repos: { allowedDirs: { list: async () => ["/w/proj"] } },
      } as unknown as ToolCtx);
      const out = await remoteToolHandler(ctx, "fs_read", { path: blank });
      expect(called).toBe(false);
      expect(out).toContain("비어");
    }
  });
});

// ── FIX4: repos 를 확인할 수 없으면 통과가 아니라 거부다(fail closed) ───────
// 지금은 buildToolCtx 가 항상 repos 를 채우므로 실운영에서 도달 불가능해야 하지만, "판정 불가"를
// "통과"로 처리하는 건 이 1차 필터가 없는 것과 같다. 안전한 기본값은 거부다.
describe("FIX4 — repos 부재는 통과가 아니라 거부다(fail closed)", () => {
  it("경로 인자가 있는데 repos 가 없으면 거부하고 허브를 부르지 않는다", async () => {
    let called = false;
    const ctx = ({
      remote: { call: async () => { called = true; return { ok: true, content: "본문" }; } },
      isOwner: true, isPrivate: true, userId: "owner",
      // repos 필드 자체가 없다.
    } as unknown as ToolCtx);
    const out = await remoteToolHandler(ctx, "fs_read", { path: "/w/a" });
    expect(called).toBe(false);
    expect(out).toContain("확인할 수 없어");
  });
});
