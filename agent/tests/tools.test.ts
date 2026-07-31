import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openTestDb } from "../src/store/db.js";
import { IntrospectRepo } from "../src/store/introspectRepo.js";
import { MemoriesRepo } from "../src/store/memoriesRepo.js";
import { UsersRepo } from "../src/store/usersRepo.js";
import { AllowedDirsRepo } from "../src/store/allowedDirsRepo.js";
import {
  rememberHandler, recallHandler, manageAccessHandler,
  allowDirHandler, revokeDirHandler, listDirsHandler,
  dbSchemaHandler, dbQueryHandler, runtimeInfoHandler,
  characterFactHandler, CHARACTER_FACT_MAX_LEN, CHARACTER_FACT_TITLE_MAX_LEN,
  allowedToolsFor, buildToolDefinitions, type ToolCtx,
} from "../src/core/tools.js";
import { CHARACTER_FACT_LIMIT } from "../src/core/turnPrep.js";

// remote 는 부분만 받아 나머지를 기본값으로 채운다. 이 파일의 테스트가 지정하는 건 roots·call·
// workerId 정도인데 ToolCtx["remote"] 는 workerKind 까지 요구한다 — 매번 다 적으면 잡음이고,
// 캐스팅으로 뭉개면 실제 타입과 어긋난 가짜가 조용히 통과한다(그게 CoreRepos 누락을 가렸던
// 방식이다). workerKind 기본값 "personal" 은 scopeDirs 가 좁히지 않는 쪽이라 이 파일의 기본
// 맥락(소유자)과 맞는다 — 공유 워커·손님 스코프를 보는 테스트는 remote 로 명시해 덮어쓴다.
type CtxOver = Partial<Omit<ToolCtx, "remote">> & { remote?: Partial<NonNullable<ToolCtx["remote"]>> };

async function ctx(over: CtxOver = {}): Promise<ToolCtx> {
  const db = await openTestDb();
  const { remote, ...rest } = over;
  return {
    repos: { memories: new MemoriesRepo(db), users: new UsersRepo(db), allowedDirs: new AllowedDirsRepo(db), introspect: new IntrospectRepo(db) },
    role: "allowed", isPrivate: true, isOwner: false, userId: "guest", conversationId: 1,
    runtime: { model: "claude-opus-4-8", sdkVersion: "0.3.207", deployTarget: "local", maxTurns: 30, workers: [] },
    ...rest,
    ...(remote
      ? {
          remote: {
            roots: [], workerId: "test-worker", workerKind: "personal" as const,
            call: async () => ({ ok: true, content: "" }),
            ...remote,
          },
        }
      : {}),
  };
}

async function ownerCtx(over = {}) {
  const db = await openTestDb();
  return {
    repos: { memories: new MemoriesRepo(db), users: new UsersRepo(db), allowedDirs: new AllowedDirsRepo(db), introspect: new IntrospectRepo(db) },
    role: "owner", isPrivate: true, isOwner: true, userId: "owner", conversationId: 1,
    runtime: { model: "claude-opus-4-8", sdkVersion: "0.3.207", deployTarget: "local", maxTurns: 30, workers: [] },
    ...over,
  } as any;
}

describe("remember 도구", () => {
  it("항상 현재 상대(userId)·scope='user' 로 저장한다(손님은 shared 를 못 쓴다)", async () => {
    const c = await ctx({ userId: "guest", isPrivate: true, isOwner: false });
    await rememberHandler(c, { title: "선호", content: "커피는 아메리카노" });
    const all = await c.repos.memories.all();
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ userId: "guest", scope: "user", title: "선호" });
  });
});

describe("recall 도구 — 프라이버시 스코프", () => {
  it("손님 DM 은 본인+공용만, 타인 개인기억은 제외", async () => {
    const c = await ctx({ userId: "guest", isPrivate: true, isOwner: false });
    await c.repos.memories.insert({ userId: "guest", scope: "user", title: "g", content: "손님메모입니다" });
    await c.repos.memories.insert({ userId: "owner", scope: "user", title: "o", content: "소유자메모입니다" });
    await c.repos.memories.insert({ userId: "owner", scope: "shared", title: "s", content: "공용메모입니다" });
    const out = await recallHandler(c, { query: "메모" });
    expect(out).toContain("손님메모입니다");
    expect(out).toContain("공용메모입니다");
    expect(out).not.toContain("소유자메모입니다");
  });

  it("소유자 DM 은 전원 기억을 검색한다", async () => {
    const c = await ctx({ userId: "owner", isPrivate: true, isOwner: true });
    await c.repos.memories.insert({ userId: "guest", scope: "user", title: "g", content: "손님메모입니다" });
    await c.repos.memories.insert({ userId: "owner", scope: "user", title: "o", content: "소유자메모입니다" });
    await c.repos.memories.insert({ userId: "owner", scope: "shared", title: "s", content: "공용메모입니다" });
    const out = await recallHandler(c, { query: "메모" });
    expect(out).toContain("손님메모입니다");
    expect(out).toContain("소유자메모입니다");
    expect(out).toContain("공용메모입니다");
  });

  it("서버(비공개 아님)는 소유자여도 공용만 검색한다(개인기억 미노출)", async () => {
    const c = await ctx({ userId: "owner", isPrivate: false, isOwner: true });
    await c.repos.memories.insert({ userId: "owner", scope: "user", title: "o", content: "소유자메모입니다" });
    await c.repos.memories.insert({ userId: "owner", scope: "shared", title: "s", content: "공용메모입니다" });
    const out = await recallHandler(c, { query: "메모" });
    expect(out).toContain("공용메모입니다");
    expect(out).not.toContain("소유자메모입니다");
  });
});

describe("manage_access 도구", () => {
  it("소유자 DM 이 아니면 거부하고 아무것도 바꾸지 않는다", async () => {
    const guest = await ctx({ isOwner: false, isPrivate: true });
    expect(await manageAccessHandler(guest, { userId: "999", role: "allowed" })).toContain("소유자");
    expect(await guest.repos.users.getRole("999")).toBe("blocked");

    const ownerServer = await ctx({ isOwner: true, isPrivate: false });
    await manageAccessHandler(ownerServer, { userId: "999", role: "allowed" });
    expect(await ownerServer.repos.users.getRole("999")).toBe("blocked");
  });

  it("소유자 DM 에서 명시적 숫자 ID 로 역할을 설정한다", async () => {
    const owner = await ctx({ userId: "owner", isOwner: true, isPrivate: true });
    const out = await manageAccessHandler(owner, { userId: "123456789", role: "allowed" });
    expect(await owner.repos.users.getRole("123456789")).toBe("allowed");
    expect(out).toContain("123456789");
  });

  it("표시명 등 비-스노플레이크는 거부한다(오작동 방지)", async () => {
    const owner = await ctx({ userId: "owner", isOwner: true, isPrivate: true });
    await manageAccessHandler(owner, { userId: "철수", role: "allowed" });
    expect(await owner.repos.users.getRole("철수")).toBe("blocked");
  });

  it("owner 역할 부여는 거부한다(제2 소유자 생성 차단 — 신원 게이트 우회 방지)", async () => {
    const owner = await ctx({ userId: "owner", isOwner: true, isPrivate: true });
    await manageAccessHandler(owner, { userId: "123456789", role: "owner" });
    expect(await owner.repos.users.getRole("123456789")).toBe("blocked"); // 미적용
  });
});

// FIX2(치명, 최종 리뷰) — allowDirHandler 는 더 이상 fs.statSync/fs.realpathSync 로 "봇 프로세스의"
// 파일시스템을 검사하지 않는다. 봇과 워커는 서로 다른 머신일 수 있어(클라우드는 물론, local 배포도
// 워커가 다른 PC 에서 돌 수 있다) 그 검증은 애초에 성립하지 않았다 — cloud 배포에서는 이 검사가
// 실행되기도 전에 도구 자체가 노출되지 않아 문제가 가려져 있었을 뿐이다(allowedToolsFor 쪽 FIX2).
// 이제는 그 사용자의 워커가 hello 프레임으로 알려온 실제 작업 폴더(ctx.remote.roots)만을 문자열
// 포함 검사로 대조한다 — 존재 여부·실경로 확인은 워커 쪽(remote/roots.ts 의 checkPath)이 실제
// 파일 접근 시점에 이미 하고 있다(이중 방어의 두 번째 겹, 위 "경로 게이팅" 참고).
describe("allow_dir/revoke_dir/list_dir 도구(§원격개발 A2, FIX2: 워커 roots 기준 재검증) — 소유자 DM 전용, 워커(ctx.remote.workerId) 별로 저장", () => {
  it("소유자 DM 에서 워커의 작업 폴더(roots) 안 경로를 허용하면 list 에 반영된다", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "asahi-allowdir-"));
    const owner = await ctx({
      isOwner: true, isPrivate: true,
      remote: { roots: [os.tmpdir()], call: async () => ({ ok: true, content: "" }), workerId: "owner-laptop" },
    });
    const out = await allowDirHandler(owner, { path: dir });
    expect(out).toContain(path.resolve(dir));
    expect(await owner.repos.allowedDirs.list("owner-laptop")).toEqual([path.resolve(dir)]);
    expect(await listDirsHandler(owner)).toContain(path.resolve(dir));
  });

  it("FIX2 — 워커가 연결돼 있지 않으면(ctx.remote 없음) 거부하고 아무것도 추가하지 않는다", async () => {
    const owner = await ctx({ isOwner: true, isPrivate: true }); // remote 미설정 — 워커 미연결과 동일
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "asahi-allowdir-noworker-"));
    const out = await allowDirHandler(owner, { path: dir });
    expect(out).toContain("워커");
    expect(await owner.repos.allowedDirs.list(owner.userId)).toEqual([]);
  });

  it("FIX2 — 워커의 작업 폴더(roots) 밖 경로는 거부하고, 거부 메시지에 워커의 실제 폴더를 알려준다", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "asahi-allowdir-outside-"));
    const workerRoot = fs.mkdtempSync(path.join(os.tmpdir(), "asahi-workerroot-"));
    const owner = await ctx({
      isOwner: true, isPrivate: true,
      remote: { roots: [workerRoot], call: async () => ({ ok: true, content: "" }), workerId: "owner-laptop" },
    });
    const out = await allowDirHandler(owner, { path: dir }); // dir 는 workerRoot 의 형제 — roots 밖
    expect(out).toContain("밖");
    expect(out).toContain(workerRoot);
    expect(await owner.repos.allowedDirs.list("owner-laptop")).toEqual([]);
  });

  it("FIX2 — 존재 여부는 더 이상 봇이 검사하지 않는다(워커와 다른 머신이라 확인 불가) — roots 안이면 실존하지 않아도 등록된다", async () => {
    // 예전엔 fs.statSync 로 "존재하는 디렉토리인가"를 봇이 직접 확인해 거부했다. 이제 그 확인은
    // 워커만 할 수 있고(파일시스템을 가진 쪽), 봇은 roots 포함 여부만 본다 — 의도된 동작 변화다.
    const workerRoot = fs.mkdtempSync(path.join(os.tmpdir(), "asahi-workerroot2-"));
    const bogus = path.join(workerRoot, "does-not-exist-xyz");
    const owner = await ctx({
      isOwner: true, isPrivate: true,
      remote: { roots: [workerRoot], call: async () => ({ ok: true, content: "" }), workerId: "owner-laptop" },
    });
    const out = await allowDirHandler(owner, { path: bogus });
    expect(out).toContain(path.resolve(bogus));
    expect(await owner.repos.allowedDirs.list("owner-laptop")).toEqual([path.resolve(bogus)]);
  });

  it("revoke_dir 은 허용 목록에서 제거한다", async () => {
    const owner = await ctx({
      isOwner: true, isPrivate: true,
      remote: { roots: [os.tmpdir()], call: async () => ({ ok: true, content: "" }), workerId: "owner-laptop" },
    });
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "asahi-revokedir-"));
    await owner.repos.allowedDirs.add("owner-laptop", dir);
    const out = await revokeDirHandler(owner, { path: dir });
    expect(await owner.repos.allowedDirs.list("owner-laptop")).toEqual([]);
    expect(out).toContain(path.resolve(dir));
  });

  it("list_dir 은 비어있으면 안내 문구를 반환한다", async () => {
    const owner = await ctx({
      isOwner: true, isPrivate: true,
      remote: { roots: [os.tmpdir()], call: async () => ({ ok: true, content: "" }), workerId: "owner-laptop" },
    });
    expect(await listDirsHandler(owner)).toContain("없어요");
  });

  // allowed_dirs 가 워커 기준으로 바뀌면서 revoke_dir/list_dir 도 "어느 워커 몫인지" 를 알아야
  // 동작할 수 있게 됐다 — allowDirHandler 가 이미 갖고 있던 "워커 미연결 시 거부" 분기를 두
  // 핸들러에도 맞춰 추가했다(예전엔 ctx.userId 를 썼으므로 워커 연결 여부와 무관하게 항상 값이
  // 있었다).
  it("워커가 연결돼 있지 않으면 revoke_dir/list_dir 도 거부한다(allowed_dirs 가 워커 기준이라 어느 워커 몫인지 알 수 없다)", async () => {
    const owner = await ctx({ isOwner: true, isPrivate: true }); // remote 미설정
    expect(await revokeDirHandler(owner, { path: "C:\\proj\\a" })).toContain("워커");
    expect(await listDirsHandler(owner)).toContain("워커");
  });

  it("손님 DM 에서는 세 도구 모두 거부하고 아무것도 바꾸지 않는다", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "asahi-guest-"));
    const guest = await ctx({
      isOwner: false, isPrivate: true,
      remote: { roots: [os.tmpdir()], call: async () => ({ ok: true, content: "" }), workerId: "guest-worker" },
    });
    expect(await allowDirHandler(guest, { path: dir })).toContain("소유자");
    expect(await guest.repos.allowedDirs.list(guest.userId)).toEqual([]);
    await guest.repos.allowedDirs.add(guest.userId, dir); // 이후 상태로 revoke 시도 검증
    expect(await revokeDirHandler(guest, { path: dir })).toContain("소유자");
    expect(await guest.repos.allowedDirs.list(guest.userId)).toEqual([path.resolve(dir)]);
    expect(await listDirsHandler(guest)).toContain("소유자");
  });

  // Task 7: 이 테스트는 예전엔 "서버(비공개 아님)에서는 소유자여도 세 도구 모두 거부한다"였다 —
  // 그땐 워커가 곧 소유자의 개인 기계였으니 DM 밖에서는 관리할 대상 자체가 없다는 전제였다.
  // 이제 소유자는 서버 채널에서도 공유 기계(동아리 공용 PC)에 연결되고, 그 기계의 관리자
  // 역시 소유자다(canManagePc 가 isOwner 만 본다) — 그래서 이제는 반대로 "허용한다"를 확인한다.
  it("서버(비공개 아님)에서도 소유자면 세 도구 모두 허용한다(공유 기계의 관리자 — Task 7 반전)", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "asahi-ownerserver-"));
    const ownerServer = await ctx({
      isOwner: true, isPrivate: false,
      remote: { roots: [os.tmpdir()], call: async () => ({ ok: true, content: "" }), workerId: "shared-worker", workerKind: "shared" },
    });
    const out = await allowDirHandler(ownerServer, { path: dir });
    expect(out).toContain(path.resolve(dir));
    expect(await ownerServer.repos.allowedDirs.list("shared-worker")).toEqual([path.resolve(dir)]);
    expect(await listDirsHandler(ownerServer)).toContain(path.resolve(dir));
  });

  // FIX6(사소하지만 함정, 최종 리뷰) — canManagePc 는 예전에 ctx.isPrivate && (ctx.isOwner ||
  // ctx.ownWorkstation === true) 였다. ownWorkstation 을 채우는 생산자는 이미 없었지만(죽은
  // 분기), 필드 자체는 ToolCtx/TurnContext 에 남아 있어 "혹시라도 다시 채워지면" 손님 DM 이 경로
  // 강제 없이 이 도구들을 얻는 잠재적 함정이었다. 필드 자체를 삭제했으므로, 이제 이 이름의
  // 프로퍼티를 억지로 흘려 넣어도(예: 실수로 되살아난 코드) canManagePc 는 isOwner 만 본다.
  it("FIX6 — canManagePc 는 ownWorkstation 같은 임의의 추가 필드를 더 이상 신뢰하지 않는다(죽은 게이트 제거 회귀)", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "asahi-fix6-stray-"));
    const guest = await ctx({
      isOwner: false, isPrivate: true, userId: "guest",
      remote: { roots: [os.tmpdir()], call: async () => ({ ok: true, content: "" }), workerId: "guest-worker" },
    });
    (guest as unknown as Record<string, unknown>).ownWorkstation = true; // 과거엔 이 값으로 게이트를 통과했다
    expect(await allowDirHandler(guest, { path: dir })).toContain("소유자");
    expect(await guest.repos.allowedDirs.list(guest.userId)).toEqual([]);
  });

  it("허용 폴더는 워커(ctx.remote.workerId) 별로 격리된다 — 같은 소유자라도 다른 워커의 목록에 서로 영향 없음", async () => {
    // 이 태스크의 핵심 회귀: 예전엔 ctx.userId 로 격리됐지만, 이제는 "같은 사람이 서로 다른
    // 기계(예: 소유자의 노트북 vs 동아리방 공용 PC)에서 연결해도 허용 폴더가 섞이면 안 된다"가
    // 기준이다 — 그래서 userId 는 두 컨텍스트에서 동일하게 두고 workerId 만 다르게 준다.
    const db = await openTestDb();
    const repos = { memories: new MemoriesRepo(db), users: new UsersRepo(db), allowedDirs: new AllowedDirsRepo(db) };
    const runtime = { model: "claude-opus-4-8", sdkVersion: "0.3.207", deployTarget: "local" as const, maxTurns: 30, workers: [] };
    const call = async () => ({ ok: true, content: "" });
    const ownerA: ToolCtx = { repos, role: "owner", isPrivate: true, isOwner: true, userId: "owner", conversationId: 1, runtime, remote: { roots: [os.tmpdir()], call, workerId: "owner-laptop" } } as unknown as ToolCtx;
    const ownerB: ToolCtx = { repos, role: "owner", isPrivate: true, isOwner: true, userId: "owner", conversationId: 1, runtime, remote: { roots: [os.tmpdir()], call, workerId: "semicolon-shared" } } as unknown as ToolCtx;
    const dirA = fs.mkdtempSync(path.join(os.tmpdir(), "asahi-userA-"));
    const dirB = fs.mkdtempSync(path.join(os.tmpdir(), "asahi-userB-"));

    await allowDirHandler(ownerA, { path: dirA });
    await allowDirHandler(ownerB, { path: dirB });

    expect(await listDirsHandler(ownerA)).toContain(path.resolve(dirA));
    expect(await listDirsHandler(ownerA)).not.toContain(path.resolve(dirB));
    expect(await listDirsHandler(ownerB)).toContain(path.resolve(dirB));
    expect(await listDirsHandler(ownerB)).not.toContain(path.resolve(dirA));

    await revokeDirHandler(ownerA, { path: dirA });
    expect(await listDirsHandler(ownerA)).toContain("없어요");
    expect(await listDirsHandler(ownerB)).toContain(path.resolve(dirB)); // 영향 없음
  });
});

// 최종 pre-merge 리뷰 FIX1(치명) — 이 세 핸들러는 remoteToolHandler(remoteTools.ts)의 1차 필터와
// 달리 그동안 repo 호출을 try/catch 로 감싸지 않았다. allowed_dirs 가 옛 컬럼 모양일 때(리뷰가
// 실제로 재현한 상황 — schema.test.ts 의 "allowed_dirs 레거시 전환" 참고) 뿐 아니라 그 외 어떤
// DB 오류(연결 끊김 등)에도 드라이버가 던진 원문 SQL 오류가 그대로 디스코드 채팅으로 노출됐다.
// 여기서는 리포 자체를 던지는 스텁으로 바꿔, "무엇이 실패를 일으켰는지"와 무관하게 항상 한국어
// 안내 문자열로 돌아오는지만 확인한다(schema.test.ts 쪽은 실제 컬럼 오류로 이 경로에 도달하는
// 것을 확인하고, 여기는 그 도달 이후의 처리 자체를 확인한다).
describe("allow_dir/revoke_dir/list_dir — repo 실패는 원문 오류가 아니라 한국어 안내로 돌아온다(최종 pre-merge 리뷰 FIX1)", () => {
  const dbError = () => Promise.reject(new Error('column "worker_id" does not exist'));

  it("allow_dir — repo.add 가 reject 해도 던지지 않고 한국어 안내 문구로 돌아온다", async () => {
    const owner = await ctx({
      isOwner: true, isPrivate: true,
      remote: { roots: [os.tmpdir()], call: async () => ({ ok: true, content: "" }), workerId: "owner-laptop" },
    });
    owner.repos.allowedDirs = { add: dbError, list: async () => [], remove: async () => {} } as any;
    const out = await allowDirHandler(owner, { path: os.tmpdir() });
    expect(out).toContain("오류");
    expect(out).toContain("worker_id");
  });

  it("revoke_dir — repo.remove 가 reject 해도 던지지 않고 한국어 안내 문구로 돌아온다", async () => {
    const owner = await ctx({
      isOwner: true, isPrivate: true,
      remote: { roots: [os.tmpdir()], call: async () => ({ ok: true, content: "" }), workerId: "owner-laptop" },
    });
    owner.repos.allowedDirs = { add: async () => {}, list: async () => [], remove: dbError } as any;
    const out = await revokeDirHandler(owner, { path: os.tmpdir() });
    expect(out).toContain("오류");
    expect(out).toContain("worker_id");
  });

  it("list_dirs — repo.list 가 reject 해도 던지지 않고 한국어 안내 문구로 돌아온다", async () => {
    const owner = await ctx({
      isOwner: true, isPrivate: true,
      remote: { roots: [os.tmpdir()], call: async () => ({ ok: true, content: "" }), workerId: "owner-laptop" },
    });
    owner.repos.allowedDirs = { add: async () => {}, list: dbError, remove: async () => {} } as any;
    const out = await listDirsHandler(owner);
    expect(out).toContain("오류");
    expect(out).toContain("worker_id");
  });
});

describe("allowedToolsFor — 능력 계층(§7.1)", () => {
  // Task 7(원격 워커 배선)부터 owner-DM(local) 은 SDK 내장 파일/Bash 도구를 더 이상 받지 않는다 —
  // core/agent.ts 가 builtinTools=[] 로 그 도구들을 아예 닫으므로, 예전처럼 allowedTools 목록에
  // Read/Write/Bash 를 넣어두면 실행할 대상이 없는 이름만 보고하는 셈이 된다(허수아비 권한).
  // 파일/셸 작업은 이제 워커 연결 시에만 원격 도구(mcp__asahi__fs_*·sh_exec)로 한다.
  // FIX2(치명, 최종 리뷰): dir 관리 도구(allow_dir/revoke_dir/list_dirs)는 이제 workerConnected
  // 하나로만 결정된다 — 예전엔 deployTarget="local" 이면 워커 연결 여부와 무관하게 항상 노출됐다.
  // 이 도구가 검증할 워커의 roots 자체가 없는 상태(워커 미연결)에서 노출해 봐야 실행하면 항상
  // 거부되므로, workerConnected:true 를 명시해야 이 세 도구가 나온다(바로 아래 별도 테스트가
  // workerConnected 생략/false 시 이 셋이 빠지는 것을 확인한다).
  it("소유자 DM + 워커 연결 시 remember/recall/manage_access + dir 관리 도구(SDK 내장 파일·Bash 도구는 없다)", () => {
    const tools = allowedToolsFor("owner", true, true, "local", true);
    expect(tools).toContain("mcp__asahi__remember");
    expect(tools).toContain("mcp__asahi__recall");
    expect(tools).toContain("mcp__asahi__manage_access");
    expect(tools).toContain("mcp__asahi__allow_dir");
    expect(tools).toContain("mcp__asahi__revoke_dir");
    expect(tools).toContain("mcp__asahi__list_dirs");
    expect(tools).not.toContain("Read");
    expect(tools).not.toContain("Write");
    expect(tools).not.toContain("Edit");
    expect(tools).not.toContain("Glob");
    expect(tools).not.toContain("Grep");
    expect(tools).not.toContain("Bash");
  });

  it("FIX2 — 워커가 연결돼 있지 않으면 dir 관리 도구는 local 이라도 노출하지 않는다(워커 roots 가 없어 검증할 수 없으므로)", () => {
    const withoutArg = allowedToolsFor("owner", true, true);
    const explicitFalse = allowedToolsFor("owner", true, true, "local", false);
    for (const tools of [withoutArg, explicitFalse]) {
      expect(tools).toContain("mcp__asahi__remember");
      expect(tools).toContain("mcp__asahi__manage_access");
      expect(tools).not.toContain("mcp__asahi__allow_dir");
      expect(tools).not.toContain("mcp__asahi__revoke_dir");
      expect(tools).not.toContain("mcp__asahi__list_dirs");
    }
  });

  // Task 3(웹 검색 개방)로 WebSearch 가 모든 계층에 추가돼 이 계층의 정확 배열도 갱신했다 —
  // 다른 항목은 그대로고 WebSearch 만 늘었다.
  it("손님 DM 은 remember/recall/character_fact 와 WebSearch 만(파일·manage_access·Bash·dir 도구 없음)", () => {
    const tools = allowedToolsFor("allowed", true, false);
    expect(tools).toEqual(["mcp__asahi__remember", "mcp__asahi__recall", "mcp__asahi__character_fact", "WebSearch"]);
    expect(tools).not.toContain("Read");
    expect(tools).not.toContain("Bash");
    expect(tools).not.toContain("mcp__asahi__manage_access");
    expect(tools).not.toContain("mcp__asahi__allow_dir");
  });

  it("서버 턴은 recall(공용)과 WebSearch 만 — 개인기억 저장·PC 도구·dir 도구 불가", () => {
    expect(allowedToolsFor("owner", false, false)).toEqual(["mcp__asahi__recall", "WebSearch"]);
    expect(allowedToolsFor("allowed", false, false)).toEqual(["mcp__asahi__recall", "WebSearch"]);
  });

  it("deployTarget 을 생략하거나 'local' 로 주면 기존(로컬) 동작과 완전히 동일하다", () => {
    expect(allowedToolsFor("owner", true, true)).toEqual(allowedToolsFor("owner", true, true, "local"));
    expect(allowedToolsFor("allowed", true, false)).toEqual(allowedToolsFor("allowed", true, false, "local"));
    expect(allowedToolsFor("owner", false, false)).toEqual(allowedToolsFor("owner", false, false, "local"));
  });

  // FIX2 갱신(최종 리뷰): 아래 결과 자체(이 셋이 빠짐)는 그대로지만, 진짜 이유가 바뀌었다 —
  // deployTarget="cloud" 자체가 아니라 workerConnected 가 기본값 false 라서다. 바로 아래 두
  // 테스트가 FIX2 의 핵심(워커만 연결되면 cloud 에서도 dir 관리 도구가 열린다)을 직접 확인한다.
  it("deployTarget='cloud' + 소유자 DM + 워커 미연결이면 PC 도구(파일·Bash·dir 관리)를 빼고 remember/recall/character_fact/manage_access/db_schema/db_query/runtime_info/WebSearch 만 남는다", () => {
    const tools = allowedToolsFor("owner", true, true, "cloud");
    expect(tools).toEqual([
      "mcp__asahi__remember",
      "mcp__asahi__recall",
      "mcp__asahi__character_fact",
      "mcp__asahi__manage_access",
      "mcp__asahi__db_schema",
      "mcp__asahi__db_query",
      "mcp__asahi__runtime_info",
      "WebSearch",
    ]);
    expect(tools).not.toContain("Read");
    expect(tools).not.toContain("Write");
    expect(tools).not.toContain("Bash");
    expect(tools).not.toContain("mcp__asahi__allow_dir");
    expect(tools).not.toContain("mcp__asahi__revoke_dir");
    expect(tools).not.toContain("mcp__asahi__list_dirs");
  });

  it("FIX2(치명 수정) — deployTarget='cloud' 라도 워커가 연결되면 allow_dir/revoke_dir/list_dirs 를 연다(예전엔 cloud 에서 영원히 열리지 않아 allowed_dirs 를 채울 방법이 없었다 — 리뷰 재현)", () => {
    const tools = allowedToolsFor("owner", true, true, "cloud", true);
    expect(tools).toContain("mcp__asahi__allow_dir");
    expect(tools).toContain("mcp__asahi__revoke_dir");
    expect(tools).toContain("mcp__asahi__list_dirs");
    // fs_*/sh_exec 는 이미 워커 연결 기준으로 열려 있었다 — 이제 그 전제조건인 allow_dir 도 같은
    // 기준으로 열려서, "fs_read 는 되는데 allow_dir 가 없어 allowed_dirs 를 못 채운다"는 모순이 없다.
    expect(tools).toContain("mcp__asahi__fs_read");
    expect(tools).toContain("mcp__asahi__sh_exec");
  });

  it("FIX2 — local·cloud 모두 dir 관리 도구는 이제 workerConnected 하나로만 결정된다(더 이상 deployTarget 로 갈리지 않는다)", () => {
    for (const dt of ["local", "cloud"] as const) {
      const connected = allowedToolsFor("owner", true, true, dt, true);
      const disconnected = allowedToolsFor("owner", true, true, dt, false);
      expect(connected).toContain("mcp__asahi__allow_dir");
      expect(disconnected).not.toContain("mcp__asahi__allow_dir");
    }
    // local·cloud 는 이제 완전히 동일한 도구 목록을 낸다(같은 workerConnected 값 기준).
    expect(allowedToolsFor("owner", true, true, "local", true)).toEqual(allowedToolsFor("owner", true, true, "cloud", true));
    expect(allowedToolsFor("owner", true, true, "local", false)).toEqual(allowedToolsFor("owner", true, true, "cloud", false));
  });

  it("deployTarget='cloud' 라도 손님 DM·서버는 로컬과 동일(영향 없음)", () => {
    expect(allowedToolsFor("allowed", true, false, "cloud")).toEqual(["mcp__asahi__remember", "mcp__asahi__recall", "mcp__asahi__character_fact", "WebSearch"]);
    expect(allowedToolsFor("owner", false, false, "cloud")).toEqual(["mcp__asahi__recall", "WebSearch"]);
    expect(allowedToolsFor("allowed", false, false, "cloud")).toEqual(["mcp__asahi__recall", "WebSearch"]);
  });
});

describe("db_query 게이팅·안전", () => {
  it("소유자가 아니면 거부한다", async () => {
    const ctx = await ownerCtx({ isOwner: false });
    expect(await dbQueryHandler(ctx, { sql: "SELECT 1" })).toMatch(/소유자/);
  });
  it("비공개(DM)가 아니면 거부한다", async () => {
    const ctx = await ownerCtx({ isPrivate: false });
    expect(await dbQueryHandler(ctx, { sql: "SELECT 1" })).toMatch(/소유자|DM/);
  });
  it("쓰기 SQL 은 사전검사로 거부한다", async () => {
    const ctx = await ownerCtx();
    expect(await dbQueryHandler(ctx, { sql: "DELETE FROM messages" })).toMatch(/읽기 전용|SELECT/);
  });
  it("소유자 정상 SELECT 는 결과를 반환한다(introspect 스텁으로 성공 경로 검증)", async () => {
    const ctx = await ownerCtx();
    ctx.repos.introspect = { readOnlyQuery: async () => ({ rows: [{ n: 1 }], truncated: 0 }), schema: async () => "" } as any;
    const out = await dbQueryHandler(ctx, { sql: "SELECT 1 AS n" });
    expect(out).not.toMatch(/쿼리 실행 오류/);
    expect(out).toMatch(/n/);
    expect(out).toMatch(/1/);
  });
});

describe("db_schema 게이팅·조회", () => {
  it("소유자가 아니면 거부한다", async () => {
    expect(await dbSchemaHandler(await ownerCtx({ isOwner: false }))).toMatch(/소유자/);
  });
  it("소유자에게 테이블·컬럼 구조를 반환한다", async () => {
    const out = await dbSchemaHandler(await ownerCtx());
    expect(out).toMatch(/messages/);
  });
});

describe("runtime_info", () => {
  it("소유자에게 모델·배포·maxTurns 를 보고한다", async () => {
    const ctx = await ownerCtx();
    const out = await runtimeInfoHandler(ctx);
    expect(out).toMatch(/claude-opus-4-8/);
    expect(out).toMatch(/local/);
    expect(out).toMatch(/30/);
  });
  it("소유자가 아니면 거부한다", async () => {
    expect(await runtimeInfoHandler(await ownerCtx({ isOwner: false }))).toMatch(/소유자/);
  });

  it("runtime_info 는 워커의 커밋과 일치 여부를 보여준다", async () => {
    const c = await ctx({
      isOwner: true,
      isPrivate: true,
      runtime: {
        model: "m", sdkVersion: "s", deployTarget: "cloud", maxTurns: 30,
        botCommit: "abc1234",
        workers: [{ workerId: "semicolon-shared", commit: "abc1234", connectedAt: 1 }],
      },
    });
    const out = await runtimeInfoHandler(c);
    expect(out).toContain("semicolon-shared");
    expect(out).toContain("abc1234");
    expect(out).toContain("일치");
  });

  it("runtime_info 는 워커가 낡았으면 그렇게 말한다", async () => {
    const c = await ctx({
      isOwner: true,
      isPrivate: true,
      runtime: {
        model: "m", sdkVersion: "s", deployTarget: "cloud", maxTurns: 30,
        botCommit: "abc1234",
        workers: [{ workerId: "semicolon-shared", commit: "999zzzz", connectedAt: 1 }],
      },
    });
    expect(await runtimeInfoHandler(c)).toContain("다름");
  });

  it("봇 커밋을 모르면 비교하지 않는다(로컬 PM2)", async () => {
    // 비교할 기준이 없는 것과 불일치는 다른 상태다. 전자를 후자로 보고하면 거짓 경보가 된다.
    const c = await ctx({
      isOwner: true,
      isPrivate: true,
      runtime: {
        model: "m", sdkVersion: "s", deployTarget: "local", maxTurns: 30,
        workers: [{ workerId: "owner-laptop", commit: "abc1234", connectedAt: 1 }],
      },
    });
    const out = await runtimeInfoHandler(c);
    expect(out).toContain("abc1234");
    expect(out).not.toContain("다름");
    expect(out).not.toContain("일치");
  });

  it("워커 커밋을 모르면 비교하지 않는다(옛 워커·git 읽기 실패)", async () => {
    // 위 테스트와 대칭인 반대쪽 갈래: 이번엔 봇 커밋은 있고 워커 커밋만 없다. verdict() 는
    // botCommit===undefined 와 workerCommit===undefined 를 OR 로 묶는데, 후자 쪽은 이 테스트가
    // 생기기 전까지 아무 테스트도 지키지 않았다 — 그 갈래만 지워도 기존 테스트는 그대로 통과했다.
    // Task 2 이전 코드로 도는 옛 워커나 git 읽기에 실패한 워커가 commit 을 안 실으면 이 경로를
    // 타는데, 여기서 "모른다"를 "다르다"로 오판하면 거짓 경보가 되고 반복되면 진짜 불일치도
    // 무시하게 된다(리뷰 지적).
    const c = await ctx({
      isOwner: true,
      isPrivate: true,
      runtime: {
        model: "m", sdkVersion: "s", deployTarget: "cloud", maxTurns: 30,
        botCommit: "abc1234",
        workers: [{ workerId: "old-worker", connectedAt: 1 }],
      },
    });
    const out = await runtimeInfoHandler(c);
    expect(out).toContain("알 수 없음");
    expect(out).not.toContain("다름");
    expect(out).not.toContain("일치");
  });
});

describe("allowedToolsFor — db 도구 노출", () => {
  it("소유자 DM(local·cloud)에 db_schema/db_query/runtime_info 를 노출한다", () => {
    for (const dt of ["local", "cloud"] as const) {
      const tools = allowedToolsFor("owner", true, true, dt);
      expect(tools).toContain("mcp__asahi__db_query");
      expect(tools).toContain("mcp__asahi__db_schema");
      expect(tools).toContain("mcp__asahi__runtime_info");
    }
  });
  it("손님 DM·서버엔 노출하지 않는다", () => {
    expect(allowedToolsFor("allowed", true, false, "local")).not.toContain("mcp__asahi__db_query");
    expect(allowedToolsFor("allowed", false, false, "local")).not.toContain("mcp__asahi__db_query");
  });
});

describe("character_fact — 캐릭터 확정 설정 저장", () => {
  it("scope='character' 로 저장한다(실제 기억과 분리)", async () => {
    const c = await ctx({ userId: "owner", isPrivate: true, isOwner: true });

    await characterFactHandler(c, { title: "학년", content: "2학년" });

    const facts = await c.repos.memories.characterFacts(40);
    expect(facts.map((f) => f.title)).toEqual(["학년"]);
    expect(facts[0].scope).toBe("character");
    expect(await c.repos.memories.forUser("owner")).toEqual([]); // 실제 기억에는 안 들어간다
    expect(await c.repos.memories.all()).toEqual([]);            // recall 풀에도 안 들어간다
  });

  it("content 를 상한 길이로 자른다", async () => {
    const c = await ctx({ userId: "owner", isPrivate: true, isOwner: true });

    await characterFactHandler(c, { title: "긴설정", content: "가".repeat(CHARACTER_FACT_MAX_LEN + 50) });

    expect((await c.repos.memories.characterFacts(40))[0].content).toHaveLength(CHARACTER_FACT_MAX_LEN);
  });

  it("title 을 상한 길이(40)로 자른다 — 손님이 쓸 수 있는 전역 저장소라 실제로 강제해야 한다", async () => {
    const c = await ctx({ userId: "owner", isPrivate: true, isOwner: true });

    await characterFactHandler(c, { title: "제".repeat(CHARACTER_FACT_TITLE_MAX_LEN + 10), content: "내용" });

    expect((await c.repos.memories.characterFacts(40))[0].title).toHaveLength(CHARACTER_FACT_TITLE_MAX_LEN);
  });

  it("상한(40개)에 도달하면 저장을 거부하고 그 사실을 알린다 — 죽은 행을 만들어 거짓 성공을 보고하지 않는다", async () => {
    const c = await ctx({ userId: "owner", isPrivate: true, isOwner: true });
    for (let i = 0; i < CHARACTER_FACT_LIMIT; i++) {
      await c.repos.memories.insert({ userId: c.userId, scope: "character", title: `설정${i}`, content: `내용${i}` });
    }

    const out = await characterFactHandler(c, { title: "새설정", content: "새내용" });

    expect(out).toMatch(/가득 차/);
    expect(out).not.toMatch(/설정 고정/);
    // 행 수가 그대로다 — 41번째(주입되지 않을 죽은 행)가 실제로 저장되지 않았다.
    const facts = await c.repos.memories.characterFacts(CHARACTER_FACT_LIMIT + 1);
    expect(facts).toHaveLength(CHARACTER_FACT_LIMIT);
    expect(facts.map((f) => f.title)).not.toContain("새설정");
  });
});

describe("allowedToolsFor — character_fact 노출 계층", () => {
  const CF = "mcp__asahi__character_fact";

  it("DM 계열 세 분기 전부에 노출한다", () => {
    expect(allowedToolsFor("owner", true, true, "local")).toContain(CF);
    expect(allowedToolsFor("owner", true, true, "cloud")).toContain(CF);
    expect(allowedToolsFor("allowed", true, false, "local")).toContain(CF); // 손님 DM
  });

  it("공개 서버 채널에는 노출하지 않는다", () => {
    expect(allowedToolsFor("allowed", false, false, "local")).not.toContain(CF);
    expect(allowedToolsFor("owner", false, true, "local")).not.toContain(CF);
  });
});

describe("allowedToolsFor — 원격 도구 노출", () => {
  const RT = "mcp__asahi__fs_read";
  const SH = "mcp__asahi__sh_exec";

  it("워커가 연결돼 있으면 소유자 DM 에 원격 도구를 연다(local·cloud 동일)", () => {
    for (const target of ["local", "cloud"] as const) {
      const tools = allowedToolsFor("owner", true, true, target, true);
      expect(tools).toContain(RT);
      expect(tools).toContain(SH);
    }
  });

  it("워커가 없으면 원격 도구를 노출하지 않는다", () => {
    for (const target of ["local", "cloud"] as const) {
      const tools = allowedToolsFor("owner", true, true, target, false);
      expect(tools).not.toContain(RT);
      expect(tools).not.toContain(SH);
    }
  });

  it("workerConnected 를 생략하면 노출하지 않는다(안전한 기본값)", () => {
    expect(allowedToolsFor("owner", true, true, "local")).not.toContain(RT);
  });

  // Task 7: 예전엔 "1단계는 소유자 전용"이라 손님에게 원격 도구를 절대 주지 않았다. 이제는
  // 위치가 어느 기계냐를 정한다(workerSelect.ts) — 손님도 DM·서버 어디서든 공유 기계에 연결되면
  // 원격 도구를 받는다. 격리는 여기(도구 목록)가 아니라 remoteToolHandler 의 scopeDirs 가
  // 맡는다(자기 하위 폴더 밖은 읽지 못한다 — remoteTools.test.ts 의 "공유 기계에서 사용자별
  // 격리" 참고).
  it("손님 DM·서버 채널도 워커가 연결되면 원격 도구를 받는다(공유 기계로 연결 — Task 7 반전)", () => {
    expect(allowedToolsFor("allowed", true, false, "local", true)).toContain(RT);
    expect(allowedToolsFor("allowed", false, false, "local", true)).toContain(RT);
  });

  it("기억·접근관리 도구는 워커 연결 여부와 무관하다", () => {
    const off = allowedToolsFor("owner", true, true, "cloud", false);
    const on = allowedToolsFor("owner", true, true, "cloud", true);
    for (const t of ["mcp__asahi__remember", "mcp__asahi__recall", "mcp__asahi__manage_access"]) {
      expect(off).toContain(t);
      expect(on).toContain(t);
    }
  });
});

describe("allowedToolsFor — 웹 검색", () => {
  const WS = "WebSearch";

  it("모든 계층에 WebSearch 가 포함된다", () => {
    expect(allowedToolsFor("owner", true, true, "local", true)).toContain(WS);
    expect(allowedToolsFor("owner", true, true, "cloud", true)).toContain(WS);
    expect(allowedToolsFor("owner", true, true, "local", false)).toContain(WS);
    expect(allowedToolsFor("allowed", true, false, "local", false)).toContain(WS);
    expect(allowedToolsFor("allowed", false, false, "local", false)).toContain(WS);
  });

  it("게시 작업 컨텍스트(공개 채널 계층)는 recall 과 WebSearch 만 받는다", () => {
    const tools = allowedToolsFor("allowed", false, false, "cloud", false);
    expect(tools.sort()).toEqual(["WebSearch", "mcp__asahi__recall"]);
  });

  it("WebFetch 는 어느 계층에도 없다", () => {
    for (const t of [
      allowedToolsFor("owner", true, true, "local", true),
      allowedToolsFor("allowed", true, false, "local", false),
      allowedToolsFor("allowed", false, false, "local", false),
    ]) {
      expect(t).not.toContain("WebFetch");
    }
  });

  // FIX3(중요, 최종 리뷰 3차) — 유휴 요약 턴은 noWebTools:true 로 이 6번째 인자(webToolsEnabled)를
  // false 로 넘긴다. 일반 대화·정기 게시는 이 인자를 생략하므로(기본값 true) 기존 동작 그대로다.
  it("FIX3 — webToolsEnabled=false 면 WebSearch 가 세 계층 어디에도 없다(유휴 요약 턴 전용)", () => {
    expect(allowedToolsFor("owner", true, true, "local", true, false)).not.toContain("WebSearch");
    expect(allowedToolsFor("allowed", true, false, "local", false, false)).not.toContain("WebSearch");
    expect(allowedToolsFor("allowed", false, false, "local", false, false)).not.toContain("WebSearch");
  });

  it("FIX3 — webToolsEnabled 를 생략하면 기존처럼 WebSearch 가 열려 있다(기본값 true, 회귀 없음)", () => {
    expect(allowedToolsFor("owner", true, true, "local", true)).toContain("WebSearch");
    expect(allowedToolsFor("allowed", true, false)).toContain("WebSearch");
  });

  it("FIX3 — webToolsEnabled=false 여도 WebSearch 이외의 도구는 그대로 남는다(owner-DM 예시)", () => {
    const tools = allowedToolsFor("owner", true, true, "local", true, false);
    expect(tools).toContain("mcp__asahi__remember");
    expect(tools).toContain("mcp__asahi__fs_read");
    expect(tools).toContain("mcp__asahi__manage_access");
  });
});

// Task 7(워커 라우팅): 원격 도구는 더 이상 owner-DM 전용이 아니다 — "어디서 말하느냐가 어느
// 기계냐를 정한다"(workerSelect.ts). 공개 서버·손님 DM 은 공유 기계(동아리 공용 PC)로 연결되고,
// 폴더 관리(allow_dir 등)만 관리자(소유자) 전용으로 남는다.
describe("allowedToolsFor — 공유 워커로 계층이 넓어진다", () => {
  const remoteNames = ["fs_read", "fs_write", "fs_edit", "fs_glob", "fs_grep", "sh_exec"];
  const hasRemote = (tools: string[]) => remoteNames.every((n) => tools.some((t) => t.endsWith(n)));

  it("공개 서버 + 워커 연결이면 원격 도구가 열린다(예전엔 무조건 닫혔다)", () => {
    expect(hasRemote(allowedToolsFor("allowed", false, false, "local", true))).toBe(true);
  });

  it("공개 서버 + 워커 미연결이면 열리지 않는다", () => {
    expect(hasRemote(allowedToolsFor("allowed", false, false, "local", false))).toBe(false);
  });

  it("손님 DM + 워커 연결이면 열린다(공유 워커로 간다)", () => {
    expect(hasRemote(allowedToolsFor("allowed", true, false, "local", true))).toBe(true);
  });

  it("손님에게는 폴더 관리 도구를 주지 않는다 — 워커가 연결돼 있어도", () => {
    const tools = allowedToolsFor("allowed", false, false, "local", true);
    expect(tools.some((t) => t.endsWith("allow_dir"))).toBe(false);
    expect(tools.some((t) => t.endsWith("revoke_dir"))).toBe(false);
  });

  it("소유자는 서버에서도 폴더 관리 도구를 갖는다", () => {
    const tools = allowedToolsFor("owner", false, true, "local", true);
    expect(tools.some((t) => t.endsWith("allow_dir"))).toBe(true);
  });

  it("손님에게는 DB·접근관리 도구를 여전히 주지 않는다", () => {
    const tools = allowedToolsFor("allowed", true, false, "local", true);
    for (const n of ["db_query", "db_schema", "manage_access", "runtime_info"]) {
      expect(tools.some((t) => t.endsWith(n))).toBe(false);
    }
  });
});

// Task 2(셸·프로세스 사용성): sh_exec 설명 전문에 proc_start 이야기가 아예 없어, 모델이
// npm run dev 처럼 계속 도는 명령을 sh_exec 로 시도하고 15초 타임아웃을 태운 건이 실사용에서
// 2건 있었다. buildToolDefinitions 가 내보내는 실제 선언(모델이 보는 것과 동일한 값)에서
// 문구를 직접 확인한다.
describe("sh_exec 도구 설명 — proc_start 유도", () => {
  it("sh_exec 설명은 계속 도는 명령을 proc_start 로 넘긴다", async () => {
    const defs = buildToolDefinitions(await ctx());
    const shExec = defs.find((d) => d.name === "sh_exec");
    expect(shExec).toBeDefined();
    expect(shExec!.description).toContain("proc_start");
    // 한정어가 있어야 한다 — 없으면 모델이 일회성 명령까지 sh_exec 를 피한다.
    expect(shExec!.description).toContain("계속 도는");
  });
});
