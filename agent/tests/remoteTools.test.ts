import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { REMOTE_TOOL_NAMES, remoteToolHandler } from "../src/core/remoteTools.js";
import type { ToolCtx } from "../src/core/tools.js";
import { makeExecutors } from "../src/remote/executors.js";

// 기본값은 "소유자 DM"을 나타낸다 — remoteToolHandler 가 최상단에서 신원을 독립적으로 재확인하므로
// (FIX1), 신원 자체를 검증 대상으로 삼지 않는 테스트는 소유자 DM 으로 고정해 통과시킨다.
// over 로 repos 등 추가 필드를 덧붙일 수 있다(경로 인자가 있는 케이스에서 필요).
//
// remote 는 부분만 받아 나머지를 기본값으로 채운다. 테스트들이 관심 있는 건 call 하나뿐인데,
// ToolCtx["remote"] 는 roots·workerId·workerKind 까지 요구한다 — 매 호출마다 그 셋을 적으면
// 잡음만 늘고, 반대로 캐스팅으로 뭉개면 실제 타입과 어긋난 가짜가 조용히 통과한다.
// workerKind 기본값은 "personal" 이다: scopeDirs 가 좁히지 않아 위 주석의 "소유자 DM" 기본과
// 맞는다. 공유 워커·손님 스코프를 검증하는 테스트는 over 나 remote 로 명시해 덮어쓴다.
const ctxWith = (
  remote: Partial<NonNullable<ToolCtx["remote"]>> | undefined,
  over: Record<string, unknown> = {},
): ToolCtx =>
  ({
    remote: remote && {
      roots: ["/w"],
      workerId: "test-worker",
      workerKind: "personal",
      call: async () => ({ ok: true, content: "" }),
      ...remote,
    },
    isOwner: true,
    isPrivate: true,
    ...over,
  } as unknown as ToolCtx);

// 최종 리뷰 Critical 1 — 반환이 문자열에서 { content, ok } 로 넓어졌다. 예전엔 워커와 이 함수의
// 1차 필터가 이미 계산해 둔 성패가 이 반환 지점에서 통째로 소실돼, MCP 의 isError 를 세울 값 자체가
// 없었다(→ 실패 전부가 ✓·status='ok' 로 표시·기록됨). 그래서 아래 테스트들은 문구만이 아니라 ok 를
// 함께 단정한다 — 문구가 맞아도 ok 가 어긋나면 그 버그가 그대로 되살아나기 때문이다.
// content 만 편하게 꺼내 쓰기 위한 헬퍼(문구만 보면 되는 단정에서 쓴다).
const contentOf = async (p: Promise<{ content: string; ok: boolean }>): Promise<string> => (await p).content;

describe("원격 도구", () => {
  it("도구 이름 11개를 고정으로 노출한다", () => {
    // Task 4: fs_tree 추가 — 폴더 구조 전용 조회 도구.
    // proc_* 넷은 PROC_TOOL_NAMES(proc.ts)를 펴서 들어온다 — 이 목록이 늘어난다는 건 게이트를
    // 타야 할 도구가 늘었다는 뜻이므로, 개수 자체를 여기서 고정해 조용한 추가를 막는다.
    expect([...REMOTE_TOOL_NAMES].sort()).toEqual([
      "fs_edit", "fs_glob", "fs_grep", "fs_read", "fs_tree", "fs_write",
      "proc_list", "proc_logs", "proc_start", "proc_stop", "sh_exec",
    ]);
  });

  it("허브 호출 결과를 그대로 돌려준다 — 내용도, 성패(ok)도", async () => {
    // path 인자가 있으므로 1차 필터가 동작한다 — repos.allowedDirs 를 채워 통과시킨다(이 테스트의
    // 관심사는 신원 재확인이 아니라 허브 결과의 그대로 전달이다).
    const ctx = ctxWith(
      { call: async () => ({ ok: true, content: "본문" }) },
      { userId: "owner", repos: { allowedDirs: { list: async () => ["/w"] } } },
    );
    expect(await remoteToolHandler(ctx, "fs_read", { path: "/w/a" })).toEqual({ content: "본문", ok: true });
  });

  it("워커가 계산한 실패는 예외가 아니라 ok:false 로 돌아온다(턴이 죽지 않게, 그러나 성공으로 둔갑하지도 않게)", async () => {
    const ctx = ctxWith(
      { call: async () => ({ ok: false, content: "폴더 밖 경로예요" }) },
      { userId: "owner", repos: { allowedDirs: { list: async () => ["/x"] } } },
    );
    // 허용 폴더(/x) 안이라 봇 쪽 필터는 통과하고, 실패를 판정한 건 워커다 — 그 ok:false 가
    // 그대로 살아 나와야 tools.ts 가 isError 를 세울 수 있다.
    expect(await remoteToolHandler(ctx, "fs_read", { path: "/x" })).toEqual({ content: "폴더 밖 경로예요", ok: false });
  });

  it("워커 연결이 없으면 안내 문구를 ok:false 로 돌려준다", async () => {
    const ctx = ctxWith(undefined);
    const r = await remoteToolHandler(ctx, "fs_read", {});
    expect(r.content).toContain("워커");
    expect(r.ok).toBe(false);
  });

  // 워커가 빈 내용을 주는 경우의 대체 문구도 성패를 바꾸지 않는다 — "내용이 없다"와 "실패했다"는
  // 서로 다른 사실이고, 이 함수는 성패를 새로 판단하지 않는다.
  it("내용이 비어도 워커의 성패를 그대로 유지한다", async () => {
    const okCtx = ctxWith({ call: async () => ({ ok: true, content: "" }) }, { userId: "owner" });
    expect(await remoteToolHandler(okCtx, "sh_exec", { command: "true" })).toEqual({ content: "(완료)", ok: true });
    const failCtx = ctxWith({ call: async () => ({ ok: false, content: "" }) }, { userId: "owner" });
    expect(await remoteToolHandler(failCtx, "sh_exec", { command: "false" })).toEqual({ content: "(실패했지만 내용이 없어요)", ok: false });
  });

  it("호출한 도구 이름과 인자를 그대로 허브에 전달한다", async () => {
    const seen: Array<{ tool: string; args: Record<string, unknown> }> = [];
    const ctx = ctxWith({ call: async (tool, args) => { seen.push({ tool, args }); return { ok: true, content: "" }; } });
    await remoteToolHandler(ctx, "sh_exec", { command: "ls" });
    expect(seen).toEqual([{ tool: "sh_exec", args: { command: "ls" } }]);
  });
});

describe("봇 쪽 1차 경로 필터", () => {
  // ctxWith 와 같은 이유로 remote 는 부분만 받아 나머지를 채운다(파일 상단 주석 참고).
  const withDirs = (dirs: string[], remote: Partial<NonNullable<ToolCtx["remote"]>>): ToolCtx =>
    ({
      remote: { roots: ["/w"], workerId: "test-worker", workerKind: "personal", ...remote },
      isOwner: true, isPrivate: true, userId: "owner",
      repos: { allowedDirs: { list: async () => dirs } },
    } as unknown as ToolCtx);

  it("allowed_dirs 밖 경로는 허브를 부르지 않고 거부한다", async () => {
    let called = false;
    const ctx = withDirs(["/w/proj"], { call: async () => { called = true; return { ok: true, content: "" }; } });
    const out = await remoteToolHandler(ctx, "fs_read", { path: "/etc/passwd" });
    expect(called).toBe(false);
    expect(out.content).toContain("허용");
    expect(out.ok).toBe(false);
  });

  it("allowed_dirs 안 경로는 통과시킨다", async () => {
    const ctx = withDirs(["/w/proj"], { call: async () => ({ ok: true, content: "본문" }) });
    await expect(remoteToolHandler(ctx, "fs_read", { path: "/w/proj/a.txt" })).resolves.toEqual({ content: "본문", ok: true });
  });

  it("allowed_dirs 가 비어 있으면 등록을 안내한다(안내지만 요청은 수행되지 않았으므로 실패다)", async () => {
    const ctx = withDirs([], { call: async () => ({ ok: true, content: "" }) });
    const out = await remoteToolHandler(ctx, "fs_read", { path: "/w/a" });
    expect(out.content).toContain("allow_dir");
    expect(out.ok).toBe(false);
  });

  it("sh_exec 는 경로 인자가 없어 1차 필터 대상이 아니다(셸은 경로 인자로 봉쇄할 수 없다는 설계 그대로 — FIX6 은 문서만 바로잡고 이 동작은 바꾸지 않는다)", async () => {
    const ctx = withDirs(["/w/proj"], { call: async () => ({ ok: true, content: "출력" }) });
    await expect(remoteToolHandler(ctx, "sh_exec", { command: "ls" })).resolves.toEqual({ content: "출력", ok: true });
  });
});

// ── FIX6: fs_glob·fs_grep 는 path 인자 유무만으로 1차 필터를 건너뛰면 안 된다 ───────────────
// path 가 생략되면 allowedDirs 검사 자체가 통째로 스킵됐었다(빈 allowedDirs 로도 워커 루트 전체를
// 열거할 수 있었다) — 그리고 path 가 허용 폴더 안이어도 pattern 이 '../../**/*' 같은 값이면 봇 쪽은
// path 만 보고 통과시켰다(워커도 roots 만 재검사할 뿐 allowedDirs 는 모른다). 이 두 도구가 대체한
// 로컬 SDK Glob/Grep 게이트(pathPermission.ts 의 extractCandidatePaths)가 이미 풀어 둔 문제라
// 그 로직을 재사용해 검증한다.
describe("FIX6 — fs_glob·fs_grep 는 path 가 없어도, pattern 이 벗어나도 1차 필터를 건너뛰지 않는다", () => {
  // ctxWith 와 같은 이유로 remote 는 부분만 받아 나머지를 채운다(파일 상단 주석 참고).
  const withDirs = (dirs: string[], remote: Partial<NonNullable<ToolCtx["remote"]>>): ToolCtx =>
    ({
      remote: { roots: ["/w"], workerId: "test-worker", workerKind: "personal", ...remote },
      isOwner: true, isPrivate: true, userId: "owner",
      repos: { allowedDirs: { list: async () => dirs } },
    } as unknown as ToolCtx);

  it("fs_glob 는 path 생략 + allowedDirs 가 비어 있으면 허브를 부르지 않고 거부한다(전체 루트 열거 방지)", async () => {
    let called = false;
    const ctx = withDirs([], { call: async () => { called = true; return { ok: true, content: "" }; } });
    const out = await remoteToolHandler(ctx, "fs_glob", { pattern: "**/*" });
    expect(called).toBe(false);
    expect(out.content).toContain("allow_dir");
    expect(out.ok).toBe(false);
  });

  it("fs_grep 는 path 생략 + allowedDirs 가 비어 있으면 허브를 부르지 않고 거부한다(전체 루트 열거 방지)", async () => {
    let called = false;
    const ctx = withDirs([], { call: async () => { called = true; return { ok: true, content: "" }; } });
    const out = await remoteToolHandler(ctx, "fs_grep", { pattern: "secret" });
    expect(called).toBe(false);
    expect(out.content).toContain("allow_dir");
    expect(out.ok).toBe(false);
  });

  it("fs_glob 는 path 를 생략해도 allowedDirs 가 있으면 그 첫 폴더를 기본값으로 검사해 통과시킨다(기존 동작 유지)", async () => {
    const ctx = withDirs(["/w/proj"], { call: async () => ({ ok: true, content: "목록" }) });
    await expect(remoteToolHandler(ctx, "fs_glob", { pattern: "**/*" })).resolves.toEqual({ content: "목록", ok: true });
  });

  it("fs_grep 는 path 를 생략해도 allowedDirs 가 있으면 그 첫 폴더를 기본값으로 검사해 통과시킨다(기존 동작 유지)", async () => {
    const ctx = withDirs(["/w/proj"], { call: async () => ({ ok: true, content: "결과" }) });
    await expect(remoteToolHandler(ctx, "fs_grep", { pattern: "TODO" })).resolves.toEqual({ content: "결과", ok: true });
  });

  it("fs_glob 는 path 는 허용 폴더 안이어도 pattern 이 '../../**/*' 로 그 밖을 가리키면 허브를 부르지 않고 거부한다", async () => {
    let called = false;
    const ctx = withDirs(["/w/proj"], { call: async () => { called = true; return { ok: true, content: "" }; } });
    const out = await remoteToolHandler(ctx, "fs_glob", { path: "/w/proj", pattern: "../../**/*" });
    expect(called).toBe(false);
    expect(out.content).toContain("허용된 폴더 밖");
    expect(out.ok).toBe(false);
  });

  it("fs_glob 는 path·pattern 이 전부 허용 폴더 안이면 정상적으로 허브를 부른다(회귀 없음)", async () => {
    const ctx = withDirs(["/w/proj"], { call: async () => ({ ok: true, content: "목록2" }) });
    await expect(remoteToolHandler(ctx, "fs_glob", { path: "/w/proj", pattern: "**/*.ts" })).resolves.toEqual({ content: "목록2", ok: true });
  });
});

// ── Task 7: 신원 재확인은 이제 "ctx.remote 가 있는가" 하나다(옛 FIX1 의 isOwnerDm 재확인은
// 삭제됨) ───────────────────────────────────────────────────────────────────────────────
// 예전엔 이 핸들러가 isOwnerDm 으로 신원을 독립적으로 재확인해, 손님·공개 서버 채널을 여기서도
// 한 번 더 거부했다(allowedToolsFor 와 별개의 방어선). 그 방어선이 지금은 사라졌다 — 대신 "어느
// 기계를, 그것이 있기는 한가"를 agent.ts 의 resolveTurnWorker 단 한 곳에서 정하고, 그 결과가
// ctx.remote 로 나타난다. 도구 목록(allowedToolsFor)과 이 핸들러가 서로 다른 판정을 쓰면
// "보이는데 실행은 거부"가 생기므로, 이제 둘 다 ctx.remote 의 존재 여부 하나만 본다 — 손님도,
// 공개 서버 채널의 소유자도 ctx.remote 가 채워져 있으면(agent.ts 가 이미 워커가 있다고 판정했다는
// 뜻) 그대로 허브를 부른다. 권한 차이(손님은 자기 폴더만)는 아래 "공유 기계에서 사용자별 격리"
// 가 확인하는 scopeDirs 가 만든다.
describe("신원 재확인은 이제 ctx.remote 존재 여부 하나다(옛 FIX1 의 isOwnerDm 재확인 삭제 — Task 7)", () => {
  it("손님이라도 ctx.remote 가 있으면(agent.ts 가 이미 판정한 결과) 허브를 부른다", async () => {
    let called = false;
    const ctx = ({
      remote: { call: async () => { called = true; return { ok: true, content: "본문" }; }, roots: [], workerId: "shared-worker", workerKind: "shared" },
      isOwner: false, isPrivate: true, userId: "guest",
    } as unknown as ToolCtx);
    await remoteToolHandler(ctx, "sh_exec", { command: "ls" });
    expect(called).toBe(true);
  });

  it("공개 서버 채널의 소유자도 ctx.remote 가 있으면 허브를 부른다(공유 기계의 관리자)", async () => {
    let called = false;
    const ctx = ({
      remote: { call: async () => { called = true; return { ok: true, content: "본문" }; }, roots: [], workerId: "shared-worker", workerKind: "shared" },
      isOwner: true, isPrivate: false, userId: "owner",
    } as unknown as ToolCtx);
    await remoteToolHandler(ctx, "sh_exec", { command: "ls" });
    expect(called).toBe(true);
  });

  it("ctx.remote 가 없으면 신원과 무관하게 거부한다(agent.ts 의 판정이 이미 '워커 없음'으로 정한 것)", async () => {
    const ctx = ({ isOwner: true, isPrivate: true, userId: "owner" } as unknown as ToolCtx); // remote 자체가 없음
    const out = await remoteToolHandler(ctx, "sh_exec", { command: "ls" });
    expect(out.content).toContain("워커가 연결돼 있지 않아");
    expect(out.ok).toBe(false);
  });
});

// ── FIX2: 두 await 지점 모두 절대 던지지 않는다 ─────────────────────────────
// WorkerHub.call 은 reject 하지 않도록 설계돼 있지만 그 보장이 깨지는 경우까지 대비하고,
// allowedDirs.list 는 실제 DB 호출이라 애초에 그런 보장이 없다. 둘 다 reject 하면 예외가 아니라
// 문자열이 되어야 한다 — remoteToolHandler 는 절대 던지지 않는다는 게 이 함수의 계약이다.
describe("FIX2 — 원격 호출·DB 조회 실패는 예외가 아니라 ok:false 결과로 돌아온다", () => {
  it("허브 call() 이 reject 해도 예외를 던지지 않고 이유를 담은 실패 결과를 돌려준다", async () => {
    const ctx = ({
      remote: { call: async () => { throw new Error("hub 폭발"); } },
      isOwner: true, isPrivate: true, userId: "owner",
    } as unknown as ToolCtx);
    const out = await remoteToolHandler(ctx, "sh_exec", { command: "ls" });
    expect(out.content).toContain("오류");
    expect(out.content).toContain("hub 폭발");
    expect(out.ok).toBe(false);
  });

  it("allowedDirs.list() 가 reject 해도(DB 다운 등) 예외를 던지지 않고 이유를 담은 실패 결과를 돌려준다", async () => {
    let hubCalled = false;
    const ctx = ({
      remote: { call: async () => { hubCalled = true; return { ok: true, content: "본문" }; } },
      isOwner: true, isPrivate: true, userId: "owner",
      repos: { allowedDirs: { list: async () => { throw new Error("db down"); } } },
    } as unknown as ToolCtx);
    const out = await remoteToolHandler(ctx, "fs_read", { path: "/w/a" });
    expect(out.content).toContain("오류");
    expect(out.content).toContain("db down");
    expect(out.ok).toBe(false);
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
      expect(out.content).toContain("비어");
      expect(out.ok).toBe(false);
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
    expect(out.content).toContain("확인할 수 없어");
    expect(out.ok).toBe(false);
  });
});

// ── 최종 pre-merge 리뷰 FIX1(치명) — fs_glob·fs_grep 가 path 생략/glob 이탈로 봇 쪽 필터를
// 우회한다 ───────────────────────────────────────────────────────────────────────────────
// (주의: 파일 상단 "FIX6"/이 파일의 "FIX1~FIX4" 라벨은 이 브랜치 이전 SDD 라운드(Task 6/7)의
// 번호다 — 이번 최종 리뷰의 FIX 번호와는 다른 이름공간이다. 아래 두 describe 는 이번 최종
// 리뷰가 매긴 "FIX1"(치명, glob/grep 우회)을 가리킨다.)
//
// 두 가지 우회 경로:
// (a) path 를 생략하면 봇은 allowed_dirs[0] 을 "검사"만 하고, 실제로 허브에 보내는 args 는
//     그대로 두었다 — 워커(executors.ts)는 path 가 없으면 자신의 roots[0](워커 루트, 보통
//     allowed_dirs 보다 넓다)을 기본값으로 쓰므로, 봇이 검사한 값과 워커가 실제로 쓰는 값이
//     달랐다.
// (b) fs_grep 의 glob 인자(검색 대상 파일 필터)는 pathPermission.ts 의 extractCandidatePaths
//     Grep 분기가 전혀 들여다보지 않았다 — path 는 허용 폴더 안이어도 glob 으로 그 밖(형제
//     폴더)을 가리키면 봇 쪽 검사를 그대로 통과했다.
//
// 아래 첫 describe 는 실제 워커 실행기(executors.ts)를 ctx.remote 에 직접 연결해(네트워크
// 계층만 생략) 리뷰가 재현한 두 프로브를 문자 그대로 재현한다. 두 번째 describe 는 그 우회를
// 막는 메커니즘(허브로 나가는 args 에 검사한 기본값을 실제로 주입) 을 스텁으로 더 세밀하게 검증한다.
describe("FIX1(치명, 최종 리뷰) — fs_glob·fs_grep 가 path 생략/glob 이탈로 봇 쪽 필터를 우회한다(리뷰 재현)", () => {
  let root: string;
  let allowedSub: string;
  let secretDir: string;
  let executors: ReturnType<typeof makeExecutors>;

  beforeEach(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "asahi-fix1-root-")));
    allowedSub = path.join(root, "allowed");
    secretDir = path.join(root, "secret");
    fs.mkdirSync(allowedSub, { recursive: true });
    fs.mkdirSync(secretDir, { recursive: true });
    fs.writeFileSync(path.join(secretDir, "creds.txt"), "AWS_KEY=PROBE6_SECRET\nAPI_TOKEN=PROBE_SECRET_VALUE\n");
    // 워커는 root 전체를 연다 — 실제 배포에서 흔한 구성이다(워커 루트가 사용자의 allow_dir
    // 승인 범위보다 넓다). 봇이 승인한 건 allowedSub 하나뿐이다.
    executors = makeExecutors([root]);
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  const ctxWithRealWorker = (allowed: string[]): ToolCtx =>
    ({
      isOwner: true, isPrivate: true, userId: "owner",
      repos: { allowedDirs: { list: async () => allowed } },
      remote: { call: (tool: string, args: Record<string, unknown>) => (executors as Record<string, (a: Record<string, unknown>) => Promise<{ ok: boolean; content: string }>>)[tool](args) },
    } as unknown as ToolCtx);

  it("(a) path 생략 시 워커의 기본값(roots[0]=전체 루트)이 아니라 봇이 승인한 폴더(allowed_dirs[0])를 검색한다", async () => {
    const ctx = ctxWithRealWorker([allowedSub]);
    const out = await contentOf(remoteToolHandler(ctx, "fs_grep", { pattern: "PROBE6_SECRET" }));
    expect(out).not.toContain("PROBE6_SECRET");
  });

  it("(b) path 가 허용 폴더 안이어도 glob 인자로 형제 폴더(secret)를 가리키면 거부한다", async () => {
    const ctx = ctxWithRealWorker([allowedSub]);
    const out = await contentOf(remoteToolHandler(ctx, "fs_grep", {
      pattern: "PROBE_SECRET_VALUE",
      path: allowedSub,
      glob: "../secret/**/*",
    }));
    expect(out).not.toContain("PROBE_SECRET_VALUE");
    expect(out).not.toContain("creds.txt");
  });

  it("fs_glob 도 (a)와 동일하다 — path 생략 시 워커 루트 전체가 아니라 허용 폴더만 나열한다", async () => {
    fs.writeFileSync(path.join(secretDir, "leaked-marker.txt"), "x");
    const ctx = ctxWithRealWorker([allowedSub]);
    const out = await contentOf(remoteToolHandler(ctx, "fs_glob", { pattern: "**/*" }));
    expect(out).not.toContain("leaked-marker.txt");
  });
});

describe("FIX1(치명, 최종 리뷰) — path 생략 시 허브로 나가는 args 에 검사한 기본값을 실제로 주입한다", () => {
  // ctxWith 와 같은 이유로 remote 는 부분만 받아 나머지를 채운다(파일 상단 주석 참고).
  const withDirs = (dirs: string[], remote: Partial<NonNullable<ToolCtx["remote"]>>): ToolCtx =>
    ({
      remote: { roots: ["/w"], workerId: "test-worker", workerKind: "personal", ...remote },
      isOwner: true, isPrivate: true, userId: "owner",
      repos: { allowedDirs: { list: async () => dirs } },
    } as unknown as ToolCtx);

  it("fs_grep 에 path 를 생략하면 허브로 나가는 args.path 에 allowed_dirs[0] 이 채워진다(워커가 roots[0] 을 기본값으로 쓰지 못하게)", async () => {
    const seen: Array<Record<string, unknown>> = [];
    const ctx = withDirs(["/w/proj"], { call: async (_tool, args) => { seen.push(args); return { ok: true, content: "" }; } });
    await remoteToolHandler(ctx, "fs_grep", { pattern: "TODO" });
    expect(seen).toEqual([{ pattern: "TODO", path: "/w/proj" }]);
  });

  it("fs_glob 에 path 를 생략하면 허브로 나가는 args.path 에 allowed_dirs[0] 이 채워진다", async () => {
    const seen: Array<Record<string, unknown>> = [];
    const ctx = withDirs(["/w/proj"], { call: async (_tool, args) => { seen.push(args); return { ok: true, content: "" }; } });
    await remoteToolHandler(ctx, "fs_glob", { pattern: "**/*" });
    expect(seen).toEqual([{ pattern: "**/*", path: "/w/proj" }]);
  });

  it("path 를 이미 명시했으면 주입하지 않고 그대로 전달한다(사용자가 지정한 값을 덮어쓰지 않는다)", async () => {
    const seen: Array<Record<string, unknown>> = [];
    const ctx = withDirs(["/w/proj"], { call: async (_tool, args) => { seen.push(args); return { ok: true, content: "" }; } });
    await remoteToolHandler(ctx, "fs_glob", { pattern: "**/*", path: "/w/proj/sub" });
    expect(seen).toEqual([{ pattern: "**/*", path: "/w/proj/sub" }]);
  });

  it("fs_read 는 이 주입 대상이 아니다(원래도 path 가 필수라 생략 케이스가 없다) — args 를 그대로 전달한다(회귀 없음)", async () => {
    const seen: Array<Record<string, unknown>> = [];
    const ctx = withDirs(["/w/proj"], { call: async (_tool, args) => { seen.push(args); return { ok: true, content: "" }; } });
    await remoteToolHandler(ctx, "fs_read", { path: "/w/proj/a.txt" });
    expect(seen).toEqual([{ path: "/w/proj/a.txt" }]);
  });

  it("sh_exec 는 이 주입 대상이 아니다(경로 인자 자체가 없다) — args 를 그대로 전달한다(회귀 없음)", async () => {
    const seen: Array<Record<string, unknown>> = [];
    const ctx = withDirs(["/w/proj"], { call: async (_tool, args) => { seen.push(args); return { ok: true, content: "" }; } });
    await remoteToolHandler(ctx, "sh_exec", { command: "ls" });
    expect(seen).toEqual([{ command: "ls" }]);
  });
});

// Task 7(워커 라우팅): 공유 기계(shared)에서는 손님마다 자기 하위 폴더로 좁혀진다(scopeDirs) —
// 이 설계의 핵심 불변식은 "손님이 남의 하위 폴더를 못 본다"는 것이다. 개인 워커(personal)나
// 소유자는 좁히지 않는다(관리자는 전체를 본다).
describe("remoteToolHandler — 공유 기계에서 사용자별 격리", () => {
  function ctxFor(o: { isOwner: boolean; isPrivate: boolean; userId: string; dirs: string[]; workerKind: "personal" | "shared" }) {
    const calls: Array<{ tool: string; args: Record<string, unknown> }> = [];
    const ctx = {
      repos: { allowedDirs: { list: async () => o.dirs } },
      role: o.isOwner ? "owner" : "allowed",
      isPrivate: o.isPrivate, isOwner: o.isOwner, userId: o.userId, conversationId: 1,
      runtime: {} as any,
      remote: {
        workerId: o.workerKind === "shared" ? "semicolon-shared" : "owner-laptop",
        workerKind: o.workerKind,
        roots: o.dirs,
        call: async (tool: string, args: Record<string, unknown>) => { calls.push({ tool, args }); return { ok: true, content: "ok" }; },
      },
    } as any;
    return { ctx, calls };
  }

  // Task 8: 손님(!isOwner) + 공유 워커(shared) 조합에서는 remoteToolHandler 가 실제 요청 전에
  // fs_mkdir 준비 호출을 하나 더 끼워 넣는다(아래 "손님의 개인 폴더 자동 생성" 참고) — 그 요청이
  // 결국 거부되더라도(자기 폴더 밖을 가리켜서 등) 준비 호출 자체는 이미 나간 뒤다. 그래서 이 아래
  // 테스트들은 calls 전체 개수 대신 fs_mkdir 을 제외한 "실제 도구 호출" 개수만 센다 — 세는 대상이
  // 바뀌는 것이지, 각 테스트가 원래 검증하려던 것(허용 여부)은 그대로다.
  const realCalls = (calls: Array<{ tool: string; args: Record<string, unknown> }>) =>
    calls.filter((c) => c.tool !== "fs_mkdir");

  it("손님이 남의 폴더를 읽으려 하면 거부한다 — 이 설계의 핵심 불변식", async () => {
    const { ctx, calls } = ctxFor({ isOwner: false, isPrivate: false, userId: "111", dirs: ["C:\\ws"], workerKind: "shared" });
    const out = await remoteToolHandler(ctx, "fs_read", { path: "C:\\ws\\222\\secret.txt" });
    expect(out.content).toContain("허용된 폴더 밖");
    expect(out.ok).toBe(false);
    expect(realCalls(calls)).toHaveLength(0);
  });

  it("손님이 자기 폴더 안을 읽는 것은 통과한다", async () => {
    const { ctx, calls } = ctxFor({ isOwner: false, isPrivate: false, userId: "111", dirs: ["C:\\ws"], workerKind: "shared" });
    await remoteToolHandler(ctx, "fs_read", { path: "C:\\ws\\111\\my.txt" });
    expect(realCalls(calls)).toHaveLength(1);
  });

  it("손님이 상위 참조로 빠져나가려 하면 거부한다", async () => {
    const { ctx, calls } = ctxFor({ isOwner: false, isPrivate: false, userId: "111", dirs: ["C:\\ws"], workerKind: "shared" });
    const out = await remoteToolHandler(ctx, "fs_read", { path: "C:\\ws\\111\\..\\222\\secret.txt" });
    expect(out.content).toContain("허용된 폴더 밖");
    expect(out.ok).toBe(false);
    expect(realCalls(calls)).toHaveLength(0);
  });

  it("소유자는 공유 기계에서 남의 폴더도 읽는다(관리자)", async () => {
    const { ctx, calls } = ctxFor({ isOwner: true, isPrivate: false, userId: "owner", dirs: ["C:\\ws"], workerKind: "shared" });
    await remoteToolHandler(ctx, "fs_read", { path: "C:\\ws\\222\\any.txt" });
    expect(calls).toHaveLength(1);
  });

  it("path 를 생략한 fs_grep 은 손님의 하위 폴더가 주입된다", async () => {
    const { ctx, calls } = ctxFor({ isOwner: false, isPrivate: false, userId: "111", dirs: ["C:\\ws"], workerKind: "shared" });
    await remoteToolHandler(ctx, "fs_grep", { pattern: "TODO" });
    // calls[0] 은 이제 Task 8 의 fs_mkdir 준비 호출이다 — 이 테스트가 실제로 보려는 건 fs_grep
    // 호출에 주입된 path 이므로 tool 로 정확히 찾는다(위치로 세면 fs_mkdir 의 path 가 우연히
    // 같은 값이라 실수로도 통과해버린다).
    const grepCall = calls.find((c) => c.tool === "fs_grep");
    expect(grepCall?.args.path).toBe("C:\\ws\\111");
  });

  // Task 8: 손님의 개인 폴더 자동 생성 — 공유 기계에서 손님(!isOwner)의 첫 원격 도구 호출 전에
  // fs_mkdir 을 한 번 끼워 넣는다. "1인당 1폴더"가 규칙이라 그 폴더가 없다고 거부할 이유가 없고,
  // 모델에게 만들게 시키면(fs_write·sh_exec 등) 실패 처리가 제각각이 되므로 봇이 직접 보장한다.
  it("손님의 첫 호출 전에 개인 폴더를 만든다", async () => {
    const { ctx, calls } = ctxFor({ isOwner: false, isPrivate: false, userId: "111", dirs: ["C:\\ws"], workerKind: "shared" });
    await remoteToolHandler(ctx, "fs_read", { path: "C:\\ws\\111\\a.txt" });
    expect(calls[0]).toEqual({ tool: "fs_mkdir", args: { path: "C:\\ws\\111" } });
    expect(calls[1].tool).toBe("fs_read");
  });

  it("소유자에게는 폴더를 만들지 않는다", async () => {
    const { ctx, calls } = ctxFor({ isOwner: true, isPrivate: false, userId: "owner", dirs: ["C:\\ws"], workerKind: "shared" });
    await remoteToolHandler(ctx, "fs_read", { path: "C:\\ws\\a.txt" });
    expect(calls.every((c) => c.tool !== "fs_mkdir")).toBe(true);
  });

  it("개인 워커에서는 폴더를 만들지 않는다", async () => {
    const { ctx, calls } = ctxFor({ isOwner: true, isPrivate: true, userId: "owner", dirs: ["C:\\dev"], workerKind: "personal" });
    await remoteToolHandler(ctx, "fs_read", { path: "C:\\dev\\a.txt" });
    expect(calls.every((c) => c.tool !== "fs_mkdir")).toBe(true);
  });

  it("워커가 없으면 안내하고 호출하지 않는다", async () => {
    const { ctx } = ctxFor({ isOwner: false, isPrivate: false, userId: "111", dirs: ["C:\\ws"], workerKind: "shared" });
    delete (ctx as any).remote;
    expect((await remoteToolHandler(ctx, "fs_read", { path: "C:\\ws\\111\\a" })).content).toContain("워커가 연결돼 있지 않아");
  });

  // 최종 리뷰 FIX1(치명) — 손님이 glob 메타문자로 시작하는 pattern/glob 으로 상위 탈출을 시도하면
  // (예: "**/../../222/*.txt") literalPrefixOfGlobPattern 이 리터럴 접두를 빈 문자열로 계산해
  // 후보가 하나도 안 나왔다 — path 만 검사되고(자기 폴더라 legal) args 는 그대로 워커로 넘어가,
  // 워커가 실제로 그 glob 을 풀어 다른 회원의 폴더(222)를 노출했다(리뷰 재현: fs_grep 이 파일
  // 내용까지 돌려줬다). 봇 쪽 1차 필터가 허브를 부르기 전에 반드시 거부해야 한다.
  describe("손님의 glob 메타문자-시작 상위 탈출은 허브를 부르기 전에 거부된다(최종 리뷰 FIX1, 리뷰 재현)", () => {
    it("fs_grep — glob:'**/../../222/*.txt' (path 는 자기 폴더) → 허브를 부르지 않고 거부한다", async () => {
      const { ctx, calls } = ctxFor({ isOwner: false, isPrivate: false, userId: "111", dirs: ["C:\\ws"], workerKind: "shared" });
      const out = await remoteToolHandler(ctx, "fs_grep", { pattern: ".", path: "C:\\ws\\111", glob: "**/../../222/*.txt" });
      expect(out.content).toContain("허용된 폴더 밖");
      expect(out.ok).toBe(false);
      // Task 8: fs_mkdir 준비 호출은 이 거부보다 먼저 나가므로 제외하고 센다(위 realCalls 참고).
      expect(realCalls(calls)).toHaveLength(0);
    });

    it("fs_grep — glob:'**/../../222/*' (path 생략) → 허브를 부르지 않고 거부한다", async () => {
      const { ctx, calls } = ctxFor({ isOwner: false, isPrivate: false, userId: "111", dirs: ["C:\\ws"], workerKind: "shared" });
      const out = await remoteToolHandler(ctx, "fs_grep", { pattern: ".", glob: "**/../../222/*" });
      expect(out.content).toContain("허용된 폴더 밖");
      expect(out.ok).toBe(false);
      expect(realCalls(calls)).toHaveLength(0);
    });

    it("fs_glob — pattern:'**/../../222/*.txt' (path 는 자기 폴더) → 허브를 부르지 않고 거부한다", async () => {
      const { ctx, calls } = ctxFor({ isOwner: false, isPrivate: false, userId: "111", dirs: ["C:\\ws"], workerKind: "shared" });
      const out = await remoteToolHandler(ctx, "fs_glob", { path: "C:\\ws\\111", pattern: "**/../../222/*.txt" });
      expect(out.content).toContain("허용된 폴더 밖");
      expect(out.ok).toBe(false);
      expect(realCalls(calls)).toHaveLength(0);
    });

    it("대조군 — 평범한 재귀 glob('**/*.ts')은 자기 폴더 안에서 정상적으로 허브를 부른다(회귀 없음)", async () => {
      const { ctx, calls } = ctxFor({ isOwner: false, isPrivate: false, userId: "111", dirs: ["C:\\ws"], workerKind: "shared" });
      await remoteToolHandler(ctx, "fs_glob", { path: "C:\\ws\\111", pattern: "**/*.ts" });
      expect(realCalls(calls)).toHaveLength(1);
    });
  });

  // 최종 pre-merge 리뷰 FIX2(중요) — extractCandidatePaths(pathPermission.ts)가 후보 경로를
  // node:path 의 기본 export(host 프로세스의 process.platform 을 따름)로 계산하면, 리눅스
  // (Railway)에 배포된 봇이 윈도우 워커의 손님 폴더에서 리터럴 접두가 있는 흔한 상대 glob
  // (예: 'src/**/*.ts' — 모델이 가장 자연스럽게 만드는 모양)을 받을 때마다 정상 호출을 "허용된
  // 폴더 밖"으로 오거부했다(리뷰 재현: node:path 를 posix 로 동작시키고 cwd 를 '/app' 로 고정해
  // 확인 — 이 파일 위쪽의 다른 테스트는 전부 '**/*.ts' 처럼 리터럴 접두가 없는 패턴만 쓰므로 이
  // 버그를 건드리지 않았다). pathPermission.test.ts 가 extractCandidatePaths 단위로 고정한 것과
  // 같은 사실을, 여기서는 remoteToolHandler 를 통해 실제로 허브까지 도달하는지(그리고 탈출
  // 시도는 여전히 막히는지)를 손님·공유 워커 시나리오 그대로 재확인한다.
  describe("손님의 리터럴 접두 있는 상대 glob 은 정상적으로 허브에 도달한다(최종 pre-merge 리뷰 FIX2, 리뷰 재현)", () => {
    it("fs_glob — path=자기 폴더 + pattern='src/**/*.ts'(리터럴 접두 있는 흔한 상대 패턴) → 허브를 부른다", async () => {
      const { ctx, calls } = ctxFor({ isOwner: false, isPrivate: false, userId: "111", dirs: ["C:\\ws"], workerKind: "shared" });
      const out = await remoteToolHandler(ctx, "fs_glob", { path: "C:\\ws\\111", pattern: "src/**/*.ts" });
      expect(realCalls(calls)).toHaveLength(1);
      expect(out.content).not.toContain("허용된 폴더 밖");
    });

    it("fs_grep — path=자기 폴더 + glob='src/*.ts' → 허브를 부른다(Grep 쪽도 동일한 계산을 탄다)", async () => {
      const { ctx, calls } = ctxFor({ isOwner: false, isPrivate: false, userId: "111", dirs: ["C:\\ws"], workerKind: "shared" });
      const out = await remoteToolHandler(ctx, "fs_grep", { pattern: "TODO", path: "C:\\ws\\111", glob: "src/*.ts" });
      expect(realCalls(calls)).toHaveLength(1);
      expect(out.content).not.toContain("허용된 폴더 밖");
    });

    it("대조군 — 같은 상대 패턴 모양이라도 상위 탈출(예: '../222/*.ts')은 여전히 거부된다", async () => {
      const { ctx, calls } = ctxFor({ isOwner: false, isPrivate: false, userId: "111", dirs: ["C:\\ws"], workerKind: "shared" });
      const out = await remoteToolHandler(ctx, "fs_glob", { path: "C:\\ws\\111", pattern: "../222/*.ts" });
      expect(out.content).toContain("허용된 폴더 밖");
      expect(out.ok).toBe(false);
      expect(realCalls(calls)).toHaveLength(0);
    });
  });
});

describe("fs_tree 는 fs_glob 과 동일하게 1차 필터를 탄다", () => {
  const withDirs = (dirs: string[], remote: Partial<NonNullable<ToolCtx["remote"]>>): ToolCtx =>
    ({
      remote: { roots: ["/w"], workerId: "test-worker", workerKind: "personal", ...remote },
      isOwner: true, isPrivate: true, userId: "owner",
      repos: { allowedDirs: { list: async () => dirs } },
    } as unknown as ToolCtx);

  it("path 를 생략하고 allowedDirs 가 비어 있으면 허브를 부르지 않는다", async () => {
    let called = false;
    const ctx = withDirs([], { call: async () => { called = true; return { ok: true, content: "" }; } });
    const out = await remoteToolHandler(ctx, "fs_tree", {});
    expect(called).toBe(false);
    expect(out.content).toContain("allow_dir");
    expect(out.ok).toBe(false);
  });

  it("path 를 생략하면 검사에 쓴 allowed[0] 을 args 에 실제로 주입한다", async () => {
    const seen: Array<Record<string, unknown>> = [];
    const ctx = withDirs(["/w/proj"], { call: async (_t, args) => { seen.push(args); return { ok: true, content: "" }; } });
    await remoteToolHandler(ctx, "fs_tree", {});
    expect(seen[0]!.path).toBe("/w/proj");
  });

  it("허용 폴더 밖 path 는 거부한다", async () => {
    const ctx = withDirs(["/w/proj"], { call: async () => ({ ok: true, content: "" }) });
    const out = await remoteToolHandler(ctx, "fs_tree", { path: "/etc" });
    expect(out.content).toContain("허용된 폴더 밖");
    expect(out.ok).toBe(false);
  });
});

describe("proc_* — 이름과 작업 폴더는 봇이 주입한다", () => {
  const withDirs = (dirs: string[], remote: Partial<NonNullable<ToolCtx["remote"]>>, over: Record<string, unknown> = {}): ToolCtx =>
    ({
      remote: { roots: ["/w"], workerId: "shared", workerKind: "shared", ...remote },
      isOwner: false, isPrivate: false, userId: "111",
      repos: { allowedDirs: { list: async () => dirs } },
      ...over,
    } as unknown as ToolCtx);

  // 이 describe 의 기본 ctx 는 손님 + 공유 워커라, remoteToolHandler 가 실제 proc_* 호출 앞에
  // 개인 폴더 생성(fs_mkdir) 준비 호출을 하나 끼워 넣는다 — proc_start 의 cwd 가 바로 그 폴더라
  // 이 준비는 proc 도구에도 필요하다(remoteTools.ts 참고). 그래서 인자를 위치로 세면 seen[0] 이
  // proc_* 이 아니라 그 준비 호출이 된다. 위 "공유 기계에서 사용자별 격리" 의 realCalls 와 같은
  // 이유로, 준비 호출은 기록에서 빼고 진짜 도구 호출의 인자만 본다.
  const recordArgs = (seen: Array<Record<string, unknown>>) =>
    async (tool: string, args: Record<string, unknown>) => {
      if (tool !== "fs_mkdir") seen.push(args);
      return { ok: true, content: "" };
    };

  // 리뷰 Finding 2: "도구 이름 11개를 고정으로 노출한다" 단정은 위 "원격 도구" describe(파일
  // 상단, :43)에 이미 원문 그대로 있다 — 브리프 Step 1 이 이 describe 안에도 같은 단정을
  // 요구했고 Step 4 가 기존 것을 11개로 갱신하라고 지시해 두 벌이 됐던 것으로, 어느 쪽도 다른
  // 쪽이 검증하지 않는 걸 검증하지 않는다. 이 describe 의 제목("proc_* — 이름과 작업 폴더는
  // 봇이 주입한다")과 실제로 맞는 원본은 저 위쪽 것이므로 이쪽 사본을 지운다.

  it("손님의 proc_start 는 모델이 준 name·cwd 를 무시하고 덮어쓴다", async () => {
    const seen: Array<Record<string, unknown>> = [];
    const ctx = withDirs(["/w"], { call: recordArgs(seen) });
    await remoteToolHandler(ctx, "proc_start", { command: "npm run dev", name: "asahi-999", cwd: "/etc" });
    expect(seen[0]!.name).toBe("asahi-111");
    expect(seen[0]!.cwd).toBe("/w/111");
  });

  // 위 recordArgs 가 준비 호출을 기록에서 빼므로, 그 준비 호출 자체는 여기서 따로 고정한다 —
  // 스코프 계산을 needsPathCheck 밖으로 끌어올린 이유가 정확히 이것이다. 이 단정이 없으면 훗날
  // 누군가 fs_mkdir 을 다시 경로 검사 블록 안으로 되돌려도 proc 테스트는 전부 통과하고, 손님의
  // 첫 proc_start 만 "그런 폴더가 없다"로 조용히 깨진다.
  it("손님의 proc_start 앞에 cwd 로 쓸 개인 폴더를 만든다(경로 인자가 없는 도구에도 준비가 필요하다)", async () => {
    const calls: Array<{ tool: string; args: Record<string, unknown> }> = [];
    const ctx = withDirs(["/w"], { call: async (tool, args) => { calls.push({ tool, args }); return { ok: true, content: "" }; } });
    await remoteToolHandler(ctx, "proc_start", { command: "npm run dev" });
    expect(calls[0]).toEqual({ tool: "fs_mkdir", args: { path: "/w/111" } });
    expect(calls[1]!.tool).toBe("proc_start");
    expect(calls[1]!.args.cwd).toBe("/w/111");
  });

  // 리뷰 지적(Minor, Finding 6): proc_stop·proc_list·proc_logs 는 isProcTool 이라 스코프 계산
  // (needsScope)은 타지만, 그 폴더(allowed[0])를 구조적으로 전혀 쓰지 않는다 — proc_start 만 cwd
  // 로 받는다. 그런데도 준비 호출(fs_mkdir) 조건이 needsScope 를 그대로 따라가면, 조회성 호출인
  // proc_list 하나에도 매번 워커 왕복이 하나 더 붙고 읽기 전용 요청이 폴더를 만드는 부작용을
  // 낳는다. 이 셋에는 fs_mkdir 이 나가지 않아야 한다.
  it("손님의 proc_stop·proc_list·proc_logs 앞에는 개인 폴더 준비 호출을 하지 않는다(그 폴더를 쓰지 않는 도구)", async () => {
    for (const tool of ["proc_stop", "proc_list", "proc_logs"] as const) {
      const calls: Array<{ tool: string; args: Record<string, unknown> }> = [];
      const ctx = withDirs(["/w"], { call: async (t, a) => { calls.push({ tool: t, args: a }); return { ok: true, content: "" }; } });
      await remoteToolHandler(ctx, tool, {});
      expect(calls.map((c) => c.tool), `${tool} 호출 앞에 fs_mkdir 이 섞여 나갔다`).toEqual([tool]);
    }
  });

  it("손님의 proc_stop 도 자기 이름으로 덮어쓴다(남의 것을 못 죽인다)", async () => {
    const seen: Array<Record<string, unknown>> = [];
    const ctx = withDirs(["/w"], { call: recordArgs(seen) });
    await remoteToolHandler(ctx, "proc_stop", { name: "asahi-999" });
    expect(seen[0]!.name).toBe("asahi-111");
  });

  // 리뷰 Finding 1(중요): remoteTools.ts 에서 proc_stop·proc_logs 는 한 줄에서 같이 처리되는데
  // (`if (tool === "proc_stop" || tool === "proc_logs")`), proc_logs 를 실제로 호출하는 테스트가
  // 이 파일에 하나도 없었다 — "|| tool === "proc_logs"" 를 지워도 통과하는 테스트가 없다는 뜻이다.
  // tools.ts 는 모든 호출자에게 name 을 선택 인자로 노출하고 executors.ts(557행 부근)는 받은
  // 이름을 그대로 믿으므로, 이 구멍을 그대로 두면 남의 로그를 읽을 수 있었다. proc_stop 과
  // 대칭으로 손님·소유자 케이스를 채운다.
  it("손님의 proc_logs 도 자기 이름으로 덮어쓴다(남의 로그를 못 본다)", async () => {
    const seen: Array<Record<string, unknown>> = [];
    const ctx = withDirs(["/w"], { call: recordArgs(seen) });
    await remoteToolHandler(ctx, "proc_logs", { name: "asahi-999" });
    expect(seen[0]!.name).toBe("asahi-111");
  });

  it("손님의 proc_list 는 자기 것만 보도록 필터가 주입된다", async () => {
    const seen: Array<Record<string, unknown>> = [];
    const ctx = withDirs(["/w"], { call: recordArgs(seen) });
    await remoteToolHandler(ctx, "proc_list", {});
    expect(seen[0]!.onlyUserId).toBe("111");
  });

  // 리뷰 Finding 4(사소함): "필터 없이 전원을 본다"는 onlyUserId 가 undefined 라는 것만으로는
  // 증명되지 않는다 — 아래 isProcTool 주입 블록을 통째로 지워도 args 에 onlyUserId 키 자체가
  // 생기지 않으니 결과는 마찬가지로 undefined 다("명시적으로 비웠다"와 "애초에 안 건드렸다"가
  // 구분이 안 된다). 키의 존재 여부까지 확인해야 주입이 실제로 실행됐다는 증거가 된다
  // (remoteTools.ts 는 소유자에게도 `onlyUserId: undefined` 를 키째로 싣는다 — 주석 참고).
  it("소유자의 proc_list 는 필터 없이 전원을 본다", async () => {
    const seen: Array<Record<string, unknown>> = [];
    const ctx = withDirs(["/w"], { call: recordArgs(seen) }, { isOwner: true });
    await remoteToolHandler(ctx, "proc_list", {});
    expect("onlyUserId" in seen[0]!).toBe(true);
    expect(seen[0]!.onlyUserId).toBeUndefined();
  });

  it("소유자의 proc_stop 은 지정한 이름을 존중한다(관리자)", async () => {
    const seen: Array<Record<string, unknown>> = [];
    const ctx = withDirs(["/w"], { call: recordArgs(seen) }, { isOwner: true });
    await remoteToolHandler(ctx, "proc_stop", { name: "asahi-999" });
    expect(seen[0]!.name).toBe("asahi-999");
  });

  // 리뷰 Finding 4(사소함): 바로 위 테스트는 소유자가 준 이름이 "그대로 전달"됨을 보이는데, 이는
  // 주입 블록이 소유자 분기를 타서 존중한 결과와 주입 블록 자체가 없어 값을 아예 안 건드린 결과를
  // 구분하지 못한다 — 둘 다 seen[0].name 이 "asahi-999"로 같다. 이름을 생략하면 갈린다: 주입이
  // 돌면 반드시 본인 이름(mine = procNameFor(ctx.userId))이 채워지고, 주입이 없으면 undefined 인
  // 채로 허브까지 간다.
  it("소유자가 이름 없이 proc_stop 을 불러도 자기 이름이 채워진다(주입이 실제로 도는지 확인 — 이름을 지정하는 위 테스트만으로는 주입이 삭제돼도 통과한다)", async () => {
    const seen: Array<Record<string, unknown>> = [];
    const ctx = withDirs(["/w"], { call: recordArgs(seen) }, { isOwner: true });
    await remoteToolHandler(ctx, "proc_stop", {});
    expect(seen[0]!.name).toBe("asahi-111");
  });

  // 리뷰 Finding 1: proc_logs 도 proc_stop 과 같은 줄에서 처리되므로 소유자 케이스를 대칭으로
  // 채운다(위 손님 케이스 참고). Finding 4 와 같은 이유로, 이름을 지정한 케이스와 생략한 케이스를
  // 둘 다 둔다 — 생략 케이스가 없으면 이 역시 주입 삭제와 구분되지 않는다.
  it("소유자의 proc_logs 는 지정한 이름을 존중한다(관리자)", async () => {
    const seen: Array<Record<string, unknown>> = [];
    const ctx = withDirs(["/w"], { call: recordArgs(seen) }, { isOwner: true });
    await remoteToolHandler(ctx, "proc_logs", { name: "asahi-999" });
    expect(seen[0]!.name).toBe("asahi-999");
  });

  it("소유자가 이름 없이 proc_logs 를 불러도 자기 이름이 채워진다(주입이 실제로 도는지 확인)", async () => {
    const seen: Array<Record<string, unknown>> = [];
    const ctx = withDirs(["/w"], { call: recordArgs(seen) }, { isOwner: true });
    await remoteToolHandler(ctx, "proc_logs", {});
    expect(seen[0]!.name).toBe("asahi-111");
  });

  it("허용 폴더가 없으면 proc_start 는 허브를 부르지 않고 거절한다", async () => {
    let called = false;
    const ctx = withDirs([], { call: async () => { called = true; return { ok: true, content: "" }; } });
    const out = await remoteToolHandler(ctx, "proc_start", { command: "npm run dev" });
    expect(called).toBe(false);
    expect(out.ok).toBe(false);
    expect(out.content).toContain("allow_dir");
  });

  // 리뷰 Finding 3(중요, 컨트롤러 결정): proc_stop·proc_list·proc_logs 는 allowed 를 전혀 읽지
  // 않는다 — 신원 인자(name·onlyUserId)는 위 손님/소유자 테스트들이 보이듯 언제나 ctx.userId 로만
  // 계산되고 무조건 주입된다. 그러니 allowed_dirs 가 비어 있어도 이 셋에는 지켜야 할 대상
  // (cross-member exposure)이 없다 — 오히려 종전 게이팅은 함정이었다: 관리자가 회원의 allow_dir
  // 를 회수했는데 그 회원의 dev 서버가 여전히 돌고 있으면, 회원도 관리자도 그 프로세스를 멈추거나
  // 로그를 들여다볼 방법이 없어지고, 그 순간 나가는 안내 문구("allow_dir 로 폴더를 허용해
  // 주세요")조차 이 세 도구와 무관한 조치를 가리킨다. "띄운 것은 항상 멈출 수 있어야 한다"는
  // 컨트롤러의 결정에 따라 이 셋만 예외로 둔다 — proc_start 는 cwd 로 쓸 allowed[0] 이 그대로
  // 필요하므로(바로 위 테스트) 계속 거부된다.
  // 최종 리뷰 Finding 1(중요): 위 세 테스트는 원래 `call: async () => { called = true; ... }` 로
  // "허브가 불렸는가"만 봤다 — 이미 남의 이름("asahi-999")을 넘기고 있었는데도 그 값이 실제로
  // 손님 자신의 이름으로 덮어써졌는지는 한 번도 확인하지 않았다. 그 결과 다음 두 변이(mutation)가
  // 스위트 전체를 그대로 통과했다(실제로 넣어서 확인함 — 태스크 보고서 참고):
  //   (A) remoteTools.ts 의 `if (isProcTool)` 를 `if (isProcTool && allowed.length > 0)` 로 바꾸면
  //       — 바로 두 줄 위에 이미 같은 모양의 가드(fs_mkdir 준비 호출)가 있어 다음 편집으로 나오기
  //       쉽다. 이 describe 의 다른 테스트는 전부 `withDirs(["/w"])`(allowed 가 비지 않음)라 안
  //       걸리고, allowed 가 실제로 빈 이 세 테스트만 injection 자체가 통째로 스킵된다. 그런데도
  //       `called`/`out.ok` 만 보면 여전히 참이다 — allow_dir 가 회수된 손님이 `proc_stop { name:
  //       "asahi-<다른 회원>" }` 로 남의 dev 서버를 끄고, `proc_logs` 로 남의 로그를 읽고,
  //       `proc_list {}` 로 전원의 목록을 볼 수 있게 됐는데도 테스트는 초록불이었다.
  //   (B) 위 fs_mkdir 준비 호출 가드의 `&& allowed.length > 0` 을 지우면 — `allowed[0]` 이
  //       `undefined` 인 채로 fs_mkdir 가 매 호출마다 섞여 나간다. `called` 는 어느 호출이 왔든
  //       true 이므로 이 변이도 잡히지 않는다.
  // 그래서 불리언 대신 (tool, args) 쌍을 전부 기록해 "정확히 그 도구 하나만 불렸는가"(B 를 잡는다)와
  // "신원이 실제로 강제됐는가"(A 를 잡는다)를 함께 확인한다 — recordArgs 는 fs_mkdir 을 기록에서
  // 빼므로 여기서는 쓰지 않는다(그러면 B 가 다시 안 잡힌다).
  const recordCalls = (calls: Array<{ tool: string; args: Record<string, unknown> }>) =>
    async (tool: string, args: Record<string, unknown>) => {
      calls.push({ tool, args });
      return { ok: true, content: "" };
    };

  it("허용 폴더가 없어도 proc_stop 은 허브를 부른다(떠 있는 걸 멈추는 데는 allow_dir 가 필요 없다) — 신원 주입도 여전히 강제된다", async () => {
    const calls: Array<{ tool: string; args: Record<string, unknown> }> = [];
    const ctx = withDirs([], { call: recordCalls(calls) });
    const out = await remoteToolHandler(ctx, "proc_stop", { name: "asahi-999" });
    expect(calls.map((c) => c.tool)).toEqual(["proc_stop"]);
    expect(calls[0]!.args.name).toBe("asahi-111");
    expect(out.ok).toBe(true);
  });

  it("허용 폴더가 없어도 proc_list 는 허브를 부른다 — 필터 주입도 여전히 강제된다", async () => {
    const calls: Array<{ tool: string; args: Record<string, unknown> }> = [];
    const ctx = withDirs([], { call: recordCalls(calls) });
    const out = await remoteToolHandler(ctx, "proc_list", {});
    expect(calls.map((c) => c.tool)).toEqual(["proc_list"]);
    expect(calls[0]!.args.onlyUserId).toBe("111");
    expect(out.ok).toBe(true);
  });

  it("허용 폴더가 없어도 proc_logs 는 허브를 부른다 — 신원 주입도 여전히 강제된다", async () => {
    const calls: Array<{ tool: string; args: Record<string, unknown> }> = [];
    const ctx = withDirs([], { call: recordCalls(calls) });
    const out = await remoteToolHandler(ctx, "proc_logs", { name: "asahi-999" });
    expect(calls.map((c) => c.tool)).toEqual(["proc_logs"]);
    expect(calls[0]!.args.name).toBe("asahi-111");
    expect(out.ok).toBe(true);
  });

  // 리뷰 Finding 2(사소함, 방어적 계층): allowed_dirs 가 빈 워커에서는 scopeDirs 가 joinUnderRoot 를
  // 한 번도 안 돌리므로(위 세 테스트와 같은 조건) ctx.userId 가 이 지점까지 전혀 검증되지 않은 채
  // 온다 — remoteTools.ts 의 isProcTool 블록 앞 isValidUserId 가드가 그 마지막 방어선이다. 오늘은
  // ctx.userId 가 항상 디스코드 스노플레이크라 실제로 이 경로를 타지 않지만(회원이 바꿔치기할 방법이
  // 없다), 그 사실에 기대지 않고 코드로도 막아 둔다는 것 자체를 이 테스트가 고정한다.
  it("ctx.userId 가 디스코드 스노플레이크 형태가 아니면(오늘은 일어나지 않는 입력) proc_* 를 거부한다 — 방어적 계층", async () => {
    let called = false;
    const ctx = withDirs([], { call: async () => { called = true; return { ok: true, content: "" }; } }, { userId: "not-a-snowflake" });
    const out = await remoteToolHandler(ctx, "proc_stop", { name: "asahi-999" });
    expect(called).toBe(false);
    expect(out.ok).toBe(false);
    expect(out.content).toContain("사용자 식별자");
  });
});

// ── Defect 1(운영 중 발견): proc_start 가 cwd 를 항상 allowed[0](회원 폴더 루트)로 고정해서, 실제
// 프로젝트가 그 하위 폴더(예: "C:\asahi-workspace\<id>\테스트 1\")에 있는 흔한 경우 npm run dev 가
// package.json 을 못 찾고 즉시 실패했다. proc_start 에 선택적 path 인자를 추가해 프로젝트 폴더를
// 직접 가리킬 수 있게 한다 — 새 게이트를 만들지 않고 기존 pathArgOf/needsPathCheck 를 그대로
// 재사용한다("path" 라는 이름으로만 받으면 기존 후보 경로 검사가 자동으로 켜진다). cwd 주입은 그
// 검사에 쓴 값(singlePathArg) 그대로 써야 한다는 FIX1 원칙은 그대로 지킨다.
describe("proc_start — path 인자로 프로젝트 하위 폴더를 지정할 수 있다(Defect 1)", () => {
  const withDirs = (dirs: string[], remote: Partial<NonNullable<ToolCtx["remote"]>>, over: Record<string, unknown> = {}): ToolCtx =>
    ({
      remote: { roots: ["/w"], workerId: "shared", workerKind: "shared", ...remote },
      isOwner: false, isPrivate: false, userId: "111",
      repos: { allowedDirs: { list: async () => dirs } },
      ...over,
    } as unknown as ToolCtx);

  // 위 "proc_* — 이름과 작업 폴더는 봇이 주입한다" 의 recordArgs 와 같은 이유(Task 8 의 fs_mkdir
  // 준비 호출을 기록에서 뺀다) — 여기서도 그대로 반복한다.
  const recordArgs = (seen: Array<Record<string, unknown>>) =>
    async (tool: string, args: Record<string, unknown>) => {
      if (tool !== "fs_mkdir") seen.push(args);
      return { ok: true, content: "" };
    };

  it("허용된 자기 폴더 하위의 path 를 주면 그 경로가 그대로 cwd 로 주입된다(프로젝트가 폴더 루트가 아닌 하위 폴더에 있는 실제 사례 — 한글·공백 포함 폴더명도 그대로)", async () => {
    const seen: Array<Record<string, unknown>> = [];
    const ctx = withDirs(["/w"], { call: recordArgs(seen) });
    await remoteToolHandler(ctx, "proc_start", { command: "npm run dev", path: "/w/111/테스트 1" });
    expect(seen[0]!.cwd).toBe("/w/111/테스트 1");
    expect(seen[0]!.name).toBe("asahi-111"); // name 은 path 와 무관하게 여전히 봇이 정한다
  });

  it("다른 회원 폴더를 가리키는 path 는 허브를 부르지 않고 거부한다(fs_read 등과 동일한 1차 필터)", async () => {
    const calls: Array<{ tool: string; args: Record<string, unknown> }> = [];
    const ctx = withDirs(["/w"], { call: async (tool, args) => { calls.push({ tool, args }); return { ok: true, content: "" }; } });
    const out = await remoteToolHandler(ctx, "proc_start", { command: "npm run dev", path: "/w/222/project" });
    expect(out.ok).toBe(false);
    expect(out.content).toContain("허용된 폴더 밖");
    expect(calls.filter((c) => c.tool === "proc_start")).toHaveLength(0);
  });

  it("path 가 빈 문자열이면 거부한다(FIX3 과 같은 규칙이 proc_start 에도 그대로 적용된다)", async () => {
    const calls: Array<{ tool: string; args: Record<string, unknown> }> = [];
    const ctx = withDirs(["/w"], { call: async (tool, args) => { calls.push({ tool, args }); return { ok: true, content: "" }; } });
    const out = await remoteToolHandler(ctx, "proc_start", { command: "npm run dev", path: "" });
    expect(out.ok).toBe(false);
    expect(out.content).toContain("비어");
    expect(calls.filter((c) => c.tool === "proc_start")).toHaveLength(0);
  });

  it("path 를 생략하면 예전처럼 allowed[0](자기 폴더 루트)이 cwd 로 쓰인다(회귀 없음)", async () => {
    const seen: Array<Record<string, unknown>> = [];
    const ctx = withDirs(["/w"], { call: recordArgs(seen) });
    await remoteToolHandler(ctx, "proc_start", { command: "npm run dev" });
    expect(seen[0]!.cwd).toBe("/w/111");
  });

  it("소유자도 path 로 프로젝트 하위 폴더를 지정할 수 있다(관리자도 동일한 경로 게이트를 탄다)", async () => {
    // isOwner 만 덮어쓰고 userId 는 기본값("111", 유효한 디스코드 스노플레이크 형태)을 그대로
    // 쓴다 — 위 "proc_* — 이름과 작업 폴더는 봇이 주입한다" 의 소유자 케이스들과 같은 관례다.
    // 문자열 "owner" 를 userId 로 쓰면 isValidUserId(숫자만 허용)에 걸려 이 테스트가 의도와
    // 다른 이유(신원 거부)로 실패한다.
    const seen: Array<Record<string, unknown>> = [];
    const ctx = withDirs(["C:\\ws"], { call: recordArgs(seen) }, { isOwner: true, isPrivate: true });
    await remoteToolHandler(ctx, "proc_start", { command: "npm run dev", path: "C:\\ws\\sub\\project" });
    expect(seen[0]!.cwd).toBe("C:\\ws\\sub\\project");
  });

  it("소유자도 허용 폴더 밖 path 는 거부된다(경로 게이트는 신원과 무관하다)", async () => {
    const calls: Array<{ tool: string; args: Record<string, unknown> }> = [];
    const ctx = withDirs(
      ["C:\\ws"],
      { call: async (tool, args) => { calls.push({ tool, args }); return { ok: true, content: "" }; } },
      { isOwner: true, isPrivate: true },
    );
    const out = await remoteToolHandler(ctx, "proc_start", { command: "npm run dev", path: "C:\\other\\project" });
    expect(out.ok).toBe(false);
    expect(out.content).toContain("허용된 폴더 밖");
    expect(calls.filter((c) => c.tool === "proc_start")).toHaveLength(0);
  });
});
