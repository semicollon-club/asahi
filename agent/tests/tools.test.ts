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
  characterFactHandler, CHARACTER_FACT_MAX_LEN,
  allowedToolsFor, type ToolCtx,
} from "../src/core/tools.js";

async function ctx(over: Partial<ToolCtx> = {}): Promise<ToolCtx> {
  const db = await openTestDb();
  return {
    repos: { memories: new MemoriesRepo(db), users: new UsersRepo(db), allowedDirs: new AllowedDirsRepo(db), introspect: new IntrospectRepo(db) },
    role: "allowed", isPrivate: true, isOwner: false, userId: "guest", conversationId: 1,
    runtime: { model: "claude-opus-4-8", sdkVersion: "0.3.207", deployTarget: "local", maxTurns: 30 },
    ...over,
  };
}

async function ownerCtx(over = {}) {
  const db = await openTestDb();
  return {
    repos: { memories: new MemoriesRepo(db), users: new UsersRepo(db), allowedDirs: new AllowedDirsRepo(db), introspect: new IntrospectRepo(db) },
    role: "owner", isPrivate: true, isOwner: true, userId: "owner", conversationId: 1,
    runtime: { model: "claude-opus-4-8", sdkVersion: "0.3.207", deployTarget: "local", maxTurns: 30 },
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

describe("allow_dir/revoke_dir/list_dir 도구(§원격개발 A2) — 소유자 DM 전용, ctx.userId 별로 저장", () => {
  it("소유자 DM 에서 실제 존재하는 디렉토리를 허용하면 list 에 반영된다", async () => {
    const owner = await ctx({ isOwner: true, isPrivate: true });
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "asahi-allowdir-"));
    const out = await allowDirHandler(owner, { path: dir });
    expect(out).toContain(path.resolve(dir));
    expect(await owner.repos.allowedDirs.list(owner.userId)).toEqual([path.resolve(dir)]);
    expect(await listDirsHandler(owner)).toContain(path.resolve(dir));
  });

  it("존재하지 않는 경로는 거부하고 아무것도 추가하지 않는다", async () => {
    const owner = await ctx({ isOwner: true, isPrivate: true });
    const bogus = path.join(os.tmpdir(), "asahi-does-not-exist-xyz");
    const out = await allowDirHandler(owner, { path: bogus });
    expect(await owner.repos.allowedDirs.list(owner.userId)).toEqual([]);
    expect(out).toContain("찾을 수 없어요");
  });

  it("디렉토리가 아닌 파일 경로는 거부한다", async () => {
    const owner = await ctx({ isOwner: true, isPrivate: true });
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "asahi-allowdir-file-"));
    const file = path.join(dir, "a.txt");
    fs.writeFileSync(file, "x");
    await allowDirHandler(owner, { path: file });
    expect(await owner.repos.allowedDirs.list(owner.userId)).toEqual([]);
  });

  it("심링크(정션)로 등록해도 실경로로 정규화해 저장한다(과차단 방지, 보안리뷰 #4)", async () => {
    const owner = await ctx({ isOwner: true, isPrivate: true });
    const target = fs.mkdtempSync(path.join(os.tmpdir(), "asahi-realdir-"));
    const link = path.join(os.tmpdir(), `asahi-junction-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    try {
      fs.symlinkSync(target, link, "junction");
    } catch {
      // 이 환경에서 정션/심링크 생성 권한이 없으면 스킵한다(코드리뷰로 갈음).
      return;
    }
    try {
      const real = fs.realpathSync(link);
      const out = await allowDirHandler(owner, { path: link });
      expect(await owner.repos.allowedDirs.list(owner.userId)).toEqual([real]);
      expect(await owner.repos.allowedDirs.list(owner.userId)).not.toContain(path.resolve(link));
      expect(out).toContain(real);
    } finally {
      fs.rmSync(link, { recursive: true, force: true });
    }
  });

  it("revoke_dir 은 허용 목록에서 제거한다", async () => {
    const owner = await ctx({ isOwner: true, isPrivate: true });
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "asahi-revokedir-"));
    await owner.repos.allowedDirs.add(owner.userId, dir);
    const out = await revokeDirHandler(owner, { path: dir });
    expect(await owner.repos.allowedDirs.list(owner.userId)).toEqual([]);
    expect(out).toContain(path.resolve(dir));
  });

  it("list_dir 은 비어있으면 안내 문구를 반환한다", async () => {
    const owner = await ctx({ isOwner: true, isPrivate: true });
    expect(await listDirsHandler(owner)).toContain("없어요");
  });

  it("손님 DM 에서는 세 도구 모두 거부하고 아무것도 바꾸지 않는다", async () => {
    const guest = await ctx({ isOwner: false, isPrivate: true });
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "asahi-guest-"));
    expect(await allowDirHandler(guest, { path: dir })).toContain("소유자");
    expect(await guest.repos.allowedDirs.list(guest.userId)).toEqual([]);
    await guest.repos.allowedDirs.add(guest.userId, dir); // 이후 상태로 revoke 시도 검증
    expect(await revokeDirHandler(guest, { path: dir })).toContain("소유자");
    expect(await guest.repos.allowedDirs.list(guest.userId)).toEqual([path.resolve(dir)]);
    expect(await listDirsHandler(guest)).toContain("소유자");
  });

  it("서버(비공개 아님)에서는 소유자여도 세 도구 모두 거부한다", async () => {
    const ownerServer = await ctx({ isOwner: true, isPrivate: false });
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "asahi-ownerserver-"));
    expect(await allowDirHandler(ownerServer, { path: dir })).toContain("소유자");
    expect(await ownerServer.repos.allowedDirs.list(ownerServer.userId)).toEqual([]);
    expect(await listDirsHandler(ownerServer)).toContain("소유자");
  });

  it("ownWorkstation(자기 PC 워커 실행)이면 손님(isOwner=false)이라도 DM 에서 세 도구 모두 허용한다", async () => {
    const guestOnOwnPc = await ctx({ isOwner: false, isPrivate: true, ownWorkstation: true, userId: "guest" });
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "asahi-ownworkstation-"));
    const out = await allowDirHandler(guestOnOwnPc, { path: dir });
    expect(out).toContain(path.resolve(dir));
    expect(await guestOnOwnPc.repos.allowedDirs.list(guestOnOwnPc.userId)).toEqual([path.resolve(dir)]);
    expect(await listDirsHandler(guestOnOwnPc)).toContain(path.resolve(dir));
    const revoked = await revokeDirHandler(guestOnOwnPc, { path: dir });
    expect(revoked).toContain(path.resolve(dir));
    expect(await guestOnOwnPc.repos.allowedDirs.list(guestOnOwnPc.userId)).toEqual([]);
  });

  it("ownWorkstation 이라도 서버(비공개 아님)에서는 세 도구 모두 거부한다", async () => {
    const guestOnOwnPcServer = await ctx({ isOwner: false, isPrivate: false, ownWorkstation: true });
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "asahi-ownworkstation-server-"));
    expect(await allowDirHandler(guestOnOwnPcServer, { path: dir })).toContain("소유자");
    expect(await listDirsHandler(guestOnOwnPcServer)).toContain("소유자");
  });

  it("허용 폴더는 ctx.userId 별로 격리된다 — 다른 사용자의 허용 목록에 서로 영향 없음", async () => {
    const db = await openTestDb();
    const repos = { memories: new MemoriesRepo(db), users: new UsersRepo(db), allowedDirs: new AllowedDirsRepo(db) };
    const ownerA: ToolCtx = { repos, role: "owner", isPrivate: true, isOwner: true, userId: "ownerA", conversationId: 1 };
    const ownerB: ToolCtx = { repos, role: "owner", isPrivate: true, isOwner: true, userId: "ownerB", conversationId: 1 };
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

describe("allowedToolsFor — 능력 계층(§7.1)", () => {
  it("소유자 DM 은 파일 도구 + remember/recall/manage_access + Bash + dir 관리 도구", () => {
    const tools = allowedToolsFor("owner", true, true);
    expect(tools).toContain("Read");
    expect(tools).toContain("Write");
    expect(tools).toContain("mcp__asahi__remember");
    expect(tools).toContain("mcp__asahi__recall");
    expect(tools).toContain("mcp__asahi__manage_access");
    expect(tools).toContain("Bash");
    expect(tools).toContain("mcp__asahi__allow_dir");
    expect(tools).toContain("mcp__asahi__revoke_dir");
    expect(tools).toContain("mcp__asahi__list_dirs");
  });

  it("손님 DM 은 remember/recall/character_fact 만(파일·manage_access·Bash·dir 도구 없음)", () => {
    const tools = allowedToolsFor("allowed", true, false);
    expect(tools).toEqual(["mcp__asahi__remember", "mcp__asahi__recall", "mcp__asahi__character_fact"]);
    expect(tools).not.toContain("Read");
    expect(tools).not.toContain("Bash");
    expect(tools).not.toContain("mcp__asahi__manage_access");
    expect(tools).not.toContain("mcp__asahi__allow_dir");
  });

  it("서버 턴은 recall(공용)만 — 개인기억 저장·PC 도구·dir 도구 불가", () => {
    expect(allowedToolsFor("owner", false, false)).toEqual(["mcp__asahi__recall"]);
    expect(allowedToolsFor("allowed", false, false)).toEqual(["mcp__asahi__recall"]);
  });

  it("deployTarget 을 생략하거나 'local' 로 주면 기존(로컬) 동작과 완전히 동일하다", () => {
    expect(allowedToolsFor("owner", true, true)).toEqual(allowedToolsFor("owner", true, true, "local"));
    expect(allowedToolsFor("allowed", true, false)).toEqual(allowedToolsFor("allowed", true, false, "local"));
    expect(allowedToolsFor("owner", false, false)).toEqual(allowedToolsFor("owner", false, false, "local"));
  });

  it("deployTarget='cloud' + 소유자 DM 이면 PC 도구(파일·Bash·dir 관리)를 빼고 remember/recall/character_fact/manage_access/db_schema/db_query/runtime_info 만 남는다", () => {
    const tools = allowedToolsFor("owner", true, true, "cloud");
    expect(tools).toEqual([
      "mcp__asahi__remember",
      "mcp__asahi__recall",
      "mcp__asahi__character_fact",
      "mcp__asahi__manage_access",
      "mcp__asahi__db_schema",
      "mcp__asahi__db_query",
      "mcp__asahi__runtime_info",
    ]);
    expect(tools).not.toContain("Read");
    expect(tools).not.toContain("Write");
    expect(tools).not.toContain("Bash");
    expect(tools).not.toContain("mcp__asahi__allow_dir");
    expect(tools).not.toContain("mcp__asahi__revoke_dir");
    expect(tools).not.toContain("mcp__asahi__list_dirs");
  });

  it("deployTarget='cloud' 라도 손님 DM·서버는 로컬과 동일(영향 없음)", () => {
    expect(allowedToolsFor("allowed", true, false, "cloud")).toEqual(["mcp__asahi__remember", "mcp__asahi__recall", "mcp__asahi__character_fact"]);
    expect(allowedToolsFor("owner", false, false, "cloud")).toEqual(["mcp__asahi__recall"]);
    expect(allowedToolsFor("allowed", false, false, "cloud")).toEqual(["mcp__asahi__recall"]);
  });

  describe("ownWorkstation(하이브리드 조각3 — 로컬 워커: 자기 PC 전권)", () => {
    it("손님(isOwner=false)+ownWorkstation+DM 이면 파일/Bash/allow_dir/remember/recall 을 포함하되 manage_access 는 없다", () => {
      const tools = allowedToolsFor("allowed", true, false, "local", true);
      expect(tools).toContain("Read");
      expect(tools).toContain("Write");
      expect(tools).toContain("Edit");
      expect(tools).toContain("Glob");
      expect(tools).toContain("Grep");
      expect(tools).toContain("Bash");
      expect(tools).toContain("mcp__asahi__remember");
      expect(tools).toContain("mcp__asahi__recall");
      expect(tools).toContain("mcp__asahi__allow_dir");
      expect(tools).toContain("mcp__asahi__revoke_dir");
      expect(tools).toContain("mcp__asahi__list_dirs");
      expect(tools).not.toContain("mcp__asahi__manage_access");
    });

    it("소유자(isOwner=true)+ownWorkstation+DM 이면 기존 소유자 DM 도구셋과 동일(manage_access 포함)", () => {
      expect(allowedToolsFor("owner", true, true, "local", true)).toEqual(allowedToolsFor("owner", true, true, "local", false));
      expect(allowedToolsFor("owner", true, true, "local", true)).toContain("mcp__asahi__manage_access");
    });

    it("ownWorkstation 이라도 서버(비공개 아님)에서는 영향 없음(recall 만)", () => {
      expect(allowedToolsFor("allowed", false, false, "local", true)).toEqual(["mcp__asahi__recall"]);
    });

    it("ownWorkstation=false(기본값, 봇 경로)면 기존 손님 DM 동작과 동일", () => {
      expect(allowedToolsFor("allowed", true, false, "local")).toEqual(allowedToolsFor("allowed", true, false, "local", false));
    });

    it("deployTarget='cloud' 이면 ownWorkstation 이 true 여도 PC 도구가 열리지 않는다(워커가 아니므로)", () => {
      const tools = allowedToolsFor("allowed", true, false, "cloud", true);
      expect(tools).toEqual(["mcp__asahi__remember", "mcp__asahi__recall", "mcp__asahi__character_fact"]);
      expect(tools).not.toContain("Read");
      expect(tools).not.toContain("Bash");
    });
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
  it("손님 DM·서버·손님 자기PC(ownWorkstation)엔 노출하지 않는다", () => {
    expect(allowedToolsFor("allowed", true, false, "local")).not.toContain("mcp__asahi__db_query");
    expect(allowedToolsFor("allowed", false, false, "local")).not.toContain("mcp__asahi__db_query");
    expect(allowedToolsFor("allowed", true, false, "local", true)).not.toContain("mcp__asahi__db_query");
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
});

describe("allowedToolsFor — character_fact 노출 계층", () => {
  const CF = "mcp__asahi__character_fact";

  it("DM 계열 네 분기 전부에 노출한다", () => {
    expect(allowedToolsFor("owner", true, true, "local")).toContain(CF);
    expect(allowedToolsFor("owner", true, true, "cloud")).toContain(CF);
    expect(allowedToolsFor("allowed", true, false, "local", true)).toContain(CF); // ownWorkstation
    expect(allowedToolsFor("allowed", true, false, "local")).toContain(CF);       // 일반 손님 DM
  });

  it("공개 서버 채널에는 노출하지 않는다", () => {
    expect(allowedToolsFor("allowed", false, false, "local")).not.toContain(CF);
    expect(allowedToolsFor("owner", false, true, "local")).not.toContain(CF);
  });
});
