import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openTestDb } from "../src/store/db.js";
import { MemoriesRepo } from "../src/store/memoriesRepo.js";
import { UsersRepo } from "../src/store/usersRepo.js";
import { AllowedDirsRepo } from "../src/store/allowedDirsRepo.js";
import { IntrospectRepo } from "../src/store/introspectRepo.js";
import {
  buildToolCtx, buildMultimodalMessage, shouldConnectWorker, buildRemoteCtx, resolveWorkerConnected,
  type TurnContext, type ToolRepos,
} from "../src/core/agent.js";
import { allowDirHandler, allowedToolsFor, type RuntimeInfo } from "../src/core/tools.js";

const testRuntime: RuntimeInfo = { model: "claude-opus-4-8", sdkVersion: "0.3.207", deployTarget: "local", maxTurns: 30 };

// buildToolCtx 를 makeRunAgentTurn 안의 인라인 리터럴이 아니라 별도 순수 함수로 뽑아 두면,
// TurnContext → ToolCtx 변환에서 필드 하나가 조용히 빠지는 종류의 버그(과거 실제로 있었다 —
// ownWorkstation 필드 누락. 그 필드 자체가 FIX6(최종 리뷰)로 완전히 삭제되며 이 히스토리는
// 종료됐다 — tools.ts 의 canManagePc 주석 참고)를 이 테스트가 직접 잡아낸다.
async function repos(): Promise<ToolRepos> {
  const db = await openTestDb();
  return { memories: new MemoriesRepo(db), users: new UsersRepo(db), allowedDirs: new AllowedDirsRepo(db), introspect: new IntrospectRepo(db) };
}

describe("buildToolCtx — makeRunAgentTurn 의 ToolCtx 구성", () => {
  it("TurnContext 의 필드를 ToolCtx 로 빠짐없이 복사한다", async () => {
    const r = await repos();
    const context: TurnContext = { role: "allowed", isPrivate: true, isOwner: false, userId: "guest", conversationId: 7 };
    const ctx = buildToolCtx(r, context, testRuntime);
    expect(ctx).toMatchObject({ role: "allowed", isPrivate: true, isOwner: false, userId: "guest", conversationId: 7 });
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

// FIX2(치명, 최종 리뷰) — ctx.remote 를 구성하는 로직을 순수 함수로 뽑아 hub.rootsOf 배선을
// 직접 검증한다. 예전엔 allowDirHandler(tools.ts)가 봇 프로세스의 fs.statSync/fs.realpathSync 로
// 경로를 검증했다 — 봇과 워커가 서로 다른 머신일 수 있어(클라우드는 물론 local 배포도 마찬가지)
// 이 검증은 실제로 아무 의미가 없었다. 이제 allowDirHandler 는 ctx.remote.roots(워커가 hello
// 프레임으로 알려온 실제 작업 폴더)로 검증하므로, makeRunAgentTurn 이 그 값을 실제로 채워야 한다 —
// WorkerHub.rootsOf(userId) 는 이 함수가 생기기 전까지 프로덕션 호출자가 없었다(테스트 전용).
describe("buildRemoteCtx — ctx.remote 구성(FIX2: hub.rootsOf 를 실제로 배선)", () => {
  it("workerConnected 가 true 고 hub 가 있으면 roots 는 hub.rootsOf 결과로, call 은 hub.call 로 이어진다", async () => {
    const seen: Array<{ userId: string; tool: string; args: Record<string, unknown> }> = [];
    const hub = {
      call: async (userId: string, tool: string, args: Record<string, unknown>) => {
        seen.push({ userId, tool, args });
        return { ok: true, content: "본문" };
      },
      rootsOf: (userId: string) => (userId === "owner" ? ["/w/proj"] : []),
    };
    const remote = buildRemoteCtx(true, hub, "owner");
    expect(remote?.roots).toEqual(["/w/proj"]);
    const result = await remote!.call("fs_read", { path: "/w/proj/a.txt" });
    expect(result).toEqual({ ok: true, content: "본문" });
    expect(seen).toEqual([{ userId: "owner", tool: "fs_read", args: { path: "/w/proj/a.txt" } }]);
  });

  it("workerConnected 가 false 면 hub 가 있어도 undefined 다(ctx.remote 를 채우지 않는다)", () => {
    const hub = { call: async () => ({ ok: true, content: "" }), rootsOf: () => ["/w"] };
    expect(buildRemoteCtx(false, hub, "owner")).toBeUndefined();
  });

  it("hub 자체가 없으면 workerConnected 값과 무관하게 undefined 다", () => {
    expect(buildRemoteCtx(true, undefined, "owner")).toBeUndefined();
  });
});

// FIX4(중요, 최종 리뷰) — 유휴 대화 요약 턴(core.ts 의 summarizeAndClose)은 사람이 지켜보지
// 않는 타이머로 돌고, 이전에 모델이 읽은 파일 등을 통해 프롬프트 인젝션이 심어졌을 수도 있는
// 세션을 그대로 이어받는다(resume). 그런 턴에도 fs_*/sh_exec 가 열려 있으면 그 인젝션이 아무도
// 모르는 사이에 실제 PC 작업으로 이어질 수 있다 — noRemoteTools 플래그로 워커 연결 여부와
// 무관하게 강제로 닫는다.
describe("resolveWorkerConnected — noRemoteTools 는 워커 연결 여부와 무관하게 강제로 닫는다(FIX4)", () => {
  const connectedHub = { isConnected: () => true };
  const context = { isOwner: true, isPrivate: true, userId: "owner" };

  it("noRemoteTools 가 없으면 shouldConnectWorker 와 동일하게 동작한다(회귀 없음)", () => {
    expect(resolveWorkerConnected({ context }, connectedHub)).toBe(true);
    expect(resolveWorkerConnected({ context: { ...context, isPrivate: false } }, connectedHub)).toBe(false);
  });

  it("noRemoteTools=true 면 워커가 연결돼 있고 소유자 DM 이어도 false 다(유휴 요약 턴)", () => {
    expect(resolveWorkerConnected({ context, noRemoteTools: true }, connectedHub)).toBe(false);
  });

  it("FIX4 — noRemoteTools 인 요청은 워커가 연결돼 있어도 allowedToolsFor 에 원격 도구 이름을 하나도 넘기지 않는다(유휴 요약 턴이 실제로 받는 도구 목록)", () => {
    const workerConnected = resolveWorkerConnected({ context, noRemoteTools: true }, connectedHub);
    const tools = allowedToolsFor("owner", context.isPrivate, context.isOwner, "local", workerConnected);
    expect(tools.some((n) => n.startsWith("mcp__asahi__fs_") || n === "mcp__asahi__sh_exec")).toBe(false);
    // dir 관리 도구(FIX2 로 workerConnected 하나로 묶임)도 마찬가지로 닫힌다.
    expect(tools).not.toContain("mcp__asahi__allow_dir");
    // 기억·접근관리처럼 워커와 무관한 도구는 그대로 남는다(요약 자체는 대화 처리이므로).
    expect(tools).toContain("mcp__asahi__remember");
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
