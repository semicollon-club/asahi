import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openTestDb } from "../src/store/db.js";
import { MemoriesRepo } from "../src/store/memoriesRepo.js";
import { UsersRepo } from "../src/store/usersRepo.js";
import { AllowedDirsRepo } from "../src/store/allowedDirsRepo.js";
import { IntrospectRepo } from "../src/store/introspectRepo.js";
import { buildToolCtx, buildMultimodalMessage, shouldConnectWorker, type TurnContext, type ToolRepos } from "../src/core/agent.js";
import { allowDirHandler, type RuntimeInfo } from "../src/core/tools.js";

const testRuntime: RuntimeInfo = { model: "claude-opus-4-8", sdkVersion: "0.3.207", deployTarget: "local", maxTurns: 30 };

// 리뷰 #1(HIGH): makeRunAgentTurn 이 ctx(ToolCtx) 를 만들 때 TurnContext.ownWorkstation 을 복사하지
// 않아서, 워커 턴(자기 PC 전권)에서도 allow_dir 등 PC 관리 도구의 실제 핸들러(canManagePc)가 항상
// 거부됐다 — allowedToolsFor 는 req.context.ownWorkstation 을 직접 보고 도구 목록엔 넣어주지만,
// 정작 핸들러에 전달되는 ctx 에는 그 필드가 빠져 있어 "도구는 보이는데 실행하면 거부"라는 불일치가
// 생겼다. buildToolCtx 를 별도 순수 함수로 뽑아 makeRunAgentTurn 과 이 테스트가 같은 경로를 검증한다.
async function repos(): Promise<ToolRepos> {
  const db = await openTestDb();
  return { memories: new MemoriesRepo(db), users: new UsersRepo(db), allowedDirs: new AllowedDirsRepo(db), introspect: new IntrospectRepo(db) };
}

describe("buildToolCtx — makeRunAgentTurn 의 ToolCtx 구성(리뷰 #1 회귀)", () => {
  it("ownWorkstation 을 포함해 TurnContext 의 모든 필드를 ToolCtx 로 그대로 복사한다", async () => {
    const r = await repos();
    const context: TurnContext = { role: "allowed", isPrivate: true, isOwner: false, userId: "guest", conversationId: 7, ownWorkstation: true };
    const ctx = buildToolCtx(r, context, testRuntime);
    expect(ctx).toMatchObject({ role: "allowed", isPrivate: true, isOwner: false, userId: "guest", conversationId: 7, ownWorkstation: true });
  });

  it("ownWorkstation 이 없으면(봇/소유자 DM 경로) undefined 로 그대로 전달된다", async () => {
    const r = await repos();
    const context: TurnContext = { role: "owner", isPrivate: true, isOwner: true, userId: "owner", conversationId: 1 };
    const ctx = buildToolCtx(r, context, testRuntime);
    expect(ctx.ownWorkstation).toBeUndefined();
  });

  it("회귀: ownWorkstation=true 로 만든 ctx 는 allowDirHandler(canManagePc) 를 통과시킨다(수정 전엔 누락되어 손님 워커 턴에서 거부됐다)", async () => {
    const r = await repos();
    const context: TurnContext = { role: "allowed", isPrivate: true, isOwner: false, userId: "guest", conversationId: 1, ownWorkstation: true };
    const ctx = buildToolCtx(r, context, testRuntime);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "asahi-buildctx-"));
    const out = await allowDirHandler(ctx, { path: dir });
    expect(out).toContain(path.resolve(dir));
    expect(await ctx.repos.allowedDirs.list("guest")).toEqual([path.resolve(dir)]);
  });

  it("buildToolCtx 는 introspect 리포와 runtime 을 ctx 로 옮긴다", async () => {
    const db = await openTestDb();
    const repos: ToolRepos = { memories: {} as any, users: {} as any, allowedDirs: {} as any, introspect: new IntrospectRepo(db) };
    const runtime: RuntimeInfo = { model: "claude-opus-4-8", sdkVersion: "0.3.207", deployTarget: "local", maxTurns: 30 };
    const ctx = buildToolCtx(repos, { role: "owner", isPrivate: true, isOwner: true, userId: "o", conversationId: 1 }, runtime);
    expect(ctx.repos.introspect).toBe(repos.introspect);
    expect(ctx.runtime.model).toBe("claude-opus-4-8");
  });
});

// FIX7: makeRunAgentTurn 이 ctx.remote(+ 원격 도구 6종)를 열지 정하는 가장 보안에 민감한 판단인데도
// 테스트가 없었다 — 그 판단만 순수 함수로 뽑아(agent.ts 의 shouldConnectWorker) 직접 검증한다.
// makeRunAgentTurn 자체는 SDK query() 를 통째로 목업해야 호출까지 갈 수 있어 이 판정 하나만
// 떼어 보기 번거로웠다(다른 테스트들도 실제 query() 호출까지는 가지 않는다는 점에서 이 파일의
// 관례와도 맞다). 리뷰가 지목한 핵심 회귀 두 가지: "연결은 됐지만 공개 채널", "연결은 됐지만 손님".
describe("shouldConnectWorker — 원격 워커 연결 판정(FIX7)", () => {
  const connectedHub = { isConnected: () => true };
  const disconnectedHub = { isConnected: () => false };

  it("소유자·DM(비공개)·워커 연결 셋 다 맞으면 true", () => {
    expect(shouldConnectWorker({ isOwner: true, isPrivate: true, userId: "owner" }, connectedHub)).toBe(true);
  });

  it("워커는 연결돼 있지만 공개 채널(isPrivate=false)이면 소유자여도 false(회귀 — 리뷰 지적)", () => {
    expect(shouldConnectWorker({ isOwner: true, isPrivate: false, userId: "owner" }, connectedHub)).toBe(false);
  });

  it("워커는 연결돼 있지만 손님(isOwner=false)이면 DM 이어도 false(회귀 — 리뷰 지적)", () => {
    expect(shouldConnectWorker({ isOwner: false, isPrivate: true, userId: "guest" }, connectedHub)).toBe(false);
  });

  it("소유자 DM 이어도 그 사용자의 워커가 연결돼 있지 않으면 false", () => {
    expect(shouldConnectWorker({ isOwner: true, isPrivate: true, userId: "owner" }, disconnectedHub)).toBe(false);
  });

  it("hub 자체를 안 넘기면(봇이 아닌 워커 경로 등) false", () => {
    expect(shouldConnectWorker({ isOwner: true, isPrivate: true, userId: "owner" }, undefined)).toBe(false);
  });
});

describe("buildMultimodalMessage", () => {
  const img = { mediaType: "image/png", base64: "AAA", name: "a.png" };
  it("텍스트+이미지를 content 블록으로 만든다", () => {
    const m = buildMultimodalMessage("이게 뭐야", [img]) as any;
    expect(m.type).toBe("user");
    expect(m.message.role).toBe("user");
    expect(m.message.content[0]).toEqual({ type: "text", text: "이게 뭐야" });
    expect(m.message.content[1]).toEqual({ type: "image", source: { type: "base64", media_type: "image/png", data: "AAA" } });
  });
  it("텍스트가 비면 이미지 블록만 넣는다", () => {
    const m = buildMultimodalMessage("   ", [img]) as any;
    expect(m.message.content).toHaveLength(1);
    expect(m.message.content[0].type).toBe("image");
  });
});
