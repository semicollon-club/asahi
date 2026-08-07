import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openTestDb } from "../src/store/db.js";
import { MemoriesRepo } from "../src/store/memoriesRepo.js";
import { UsersRepo } from "../src/store/usersRepo.js";
import { AllowedDirsRepo } from "../src/store/allowedDirsRepo.js";
import { ProjectsRepo } from "../src/store/projectsRepo.js";
import { IntrospectRepo } from "../src/store/introspectRepo.js";
import {
  buildToolCtx, buildMultimodalMessage, buildRemoteCtx, resolveTurnWorker,
  resolveWebToolsEnabled, resolveMemoryWriteEnabled, progressFromMessage,
  type TurnContext, type ToolRepos, type PendingTool,
} from "../src/core/agent.js";
import { allowDirHandler, allowedToolsFor, type RuntimeInfo } from "../src/core/tools.js";

const testRuntime: RuntimeInfo = { model: "claude-opus-4-8", sdkVersion: "0.3.207", deployTarget: "local", maxTurns: 30, workers: [] };

// buildToolCtx 를 makeRunAgentTurn 안의 인라인 리터럴이 아니라 별도 순수 함수로 뽑아 두면,
// TurnContext → ToolCtx 변환에서 필드 하나가 조용히 빠지는 종류의 버그(과거 실제로 있었다 —
// ownWorkstation 필드 누락. 그 필드 자체가 FIX6(최종 리뷰)로 완전히 삭제되며 이 히스토리는
// 종료됐다 — tools.ts 의 canManagePc 주석 참고)를 이 테스트가 직접 잡아낸다.
async function repos(): Promise<ToolRepos> {
  const db = await openTestDb();
  return { memories: new MemoriesRepo(db), users: new UsersRepo(db), allowedDirs: new AllowedDirsRepo(db), introspect: new IntrospectRepo(db), projects: new ProjectsRepo(db) };
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
    const repos: ToolRepos = { memories: {} as any, users: {} as any, allowedDirs: {} as any, introspect: new IntrospectRepo(db), projects: new ProjectsRepo(db) };
    const runtime: RuntimeInfo = { model: "claude-opus-4-8", sdkVersion: "0.3.207", deployTarget: "local", maxTurns: 30, workers: [] };
    const ctx = buildToolCtx(repos, { role: "owner", isPrivate: true, isOwner: true, userId: "o", conversationId: 1 }, runtime);
    expect(ctx.repos.introspect).toBe(repos.introspect);
    expect(ctx.runtime.model).toBe("claude-opus-4-8");
  });
});

// Task 7: makeRunAgentTurn 이 ctx.remote(+ 원격 도구 6종)를 열지 정하는 가장 보안에 민감한
// 판단인데도(FIX7) 예전엔 테스트가 없었다 — 그 판단만 순수 함수로 뽑아(agent.ts 의
// resolveTurnWorker) 직접 검증한다. resolveTurnWorker 는 예전의 shouldConnectWorker(신원 판정)와
// resolveWorkerConnected(noRemoteTools 합성)를 하나로 합친 함수다 — 아래 describe 블록이 각각을
// 대체한다. makeRunAgentTurn 자체는 SDK query() 를 통째로 목업해야 호출까지 갈 수 있어 이 판정
// 하나만 떼어 보기 번거로웠다(다른 테스트들도 실제 query() 호출까지는 가지 않는다는 점에서 이
// 파일의 관례와도 맞다).
//
// 예전 shouldConnectWorker 는 "연결은 됐지만 공개 채널"·"연결은 됐지만 손님" 두 경우 모두
// false(워커 없음)를 돌려줬다 — 그땐 원격 워커 자체가 owner-DM 전용이었다. Task 7 이후로는
// 그 두 경우도 워커가 "없는" 게 아니라 다른 워커(공유 워커)로 resolve 된다 — 위치가 어느
// 기계냐를 정한다(workerSelect.ts 의 resolveWorkerSelector). 그래서 아래 테스트들은 "false"
// 대신 "어느 워커로 resolve 됐는가(kind)"를 확인한다 — registry 에 personal/shared 를 서로
// 다른 id 로 응답하게 해서, 실제로 옳은 쪽이 쓰였는지까지 검증한다(이게 예전 회귀가 지키려던
// 성질의 갱신판이다 — "소유자의 개인 워커가 공개 채널·손님에게 새지 않는다").
describe("resolveTurnWorker — 이 턴이 실제로 쓸 워커를 정한다(Task 7, 예전 shouldConnectWorker 를 대체)", () => {
  function registryStub(o: { personal?: string | null; shared?: string | null } = {}) {
    return {
      personalWorkerOf: async (_userId: string) => (o.personal === undefined ? "personal-worker" : o.personal),
      sharedWorkerId: async () => (o.shared === undefined ? "shared-worker" : o.shared),
    };
  }
  const connectedHub = { isConnected: (_id: string) => true };
  const disconnectedHub = { isConnected: (_id: string) => false };

  it("소유자·DM(비공개)·워커 연결 셋 다 맞으면 그 소유자의 개인 워커로 resolve 한다", async () => {
    const worker = await resolveTurnWorker({ context: { isOwner: true, isPrivate: true, userId: "owner" } }, registryStub(), connectedHub);
    expect(worker).toEqual({ workerId: "personal-worker", kind: "personal" });
  });

  it("워커는 연결돼 있지만 공개 채널(isPrivate=false)이면 소유자라도 개인 워커가 아니라 공유 워커로 resolve 한다(예전엔 여기서 아예 없음이었지만, 이제는 공유 기계로 간다 — Task 7 반전)", async () => {
    const worker = await resolveTurnWorker({ context: { isOwner: true, isPrivate: false, userId: "owner" } }, registryStub(), connectedHub);
    expect(worker).toEqual({ workerId: "shared-worker", kind: "shared" });
  });

  it("워커는 연결돼 있지만 손님(isOwner=false)이면 DM 이어도 개인 워커가 아니라 공유 워커로 resolve 한다(같은 반전)", async () => {
    const worker = await resolveTurnWorker({ context: { isOwner: false, isPrivate: true, userId: "guest" } }, registryStub(), connectedHub);
    expect(worker).toEqual({ workerId: "shared-worker", kind: "shared" });
  });

  it("소유자 DM 이어도 그 워커가 허브에 연결돼 있지 않으면 null", async () => {
    const worker = await resolveTurnWorker({ context: { isOwner: true, isPrivate: true, userId: "owner" } }, registryStub(), disconnectedHub);
    expect(worker).toBeNull();
  });

  it("registry 가 그 선택자에 해당하는 워커를 못 찾으면(등록되지 않음) null", async () => {
    const worker = await resolveTurnWorker(
      { context: { isOwner: true, isPrivate: true, userId: "owner" } },
      registryStub({ personal: null }),
      connectedHub,
    );
    expect(worker).toBeNull();
  });

  it("registry 자체를 안 넘기면 null(hub 만으로는 workerId 를 알 수 없다)", async () => {
    expect(await resolveTurnWorker({ context: { isOwner: true, isPrivate: true, userId: "owner" } }, undefined, connectedHub)).toBeNull();
  });

  it("hub 자체를 안 넘기면(봇이 아닌 워커 경로 등) null", async () => {
    expect(await resolveTurnWorker({ context: { isOwner: true, isPrivate: true, userId: "owner" } }, registryStub(), undefined)).toBeNull();
  });
});

// FIX4(중요, 최종 리뷰): req.noRemoteTools 를 resolveTurnWorker 안에서 합성한다 — 유휴 요약
// 턴(core.ts 의 summarizeAndClose)이 이 값을 쓴다. 예전엔 resolveWorkerConnected 라는 별도
// 함수가 이 합성을 맡았지만, Task 7 로 shouldConnectWorker 와 함께 resolveTurnWorker 하나로
// 합쳐졌다.
describe("resolveTurnWorker — noRemoteTools 는 워커 연결 여부와 무관하게 강제로 닫는다(FIX4, 예전 resolveWorkerConnected 를 대체)", () => {
  const registry = { personalWorkerOf: async () => "personal-worker", sharedWorkerId: async () => "shared-worker" };
  const connectedHub = { isConnected: () => true };
  const context = { isOwner: true, isPrivate: true, userId: "owner" };

  it("noRemoteTools 가 없으면 평소처럼 워커를 resolve 한다(회귀 없음)", async () => {
    expect(await resolveTurnWorker({ context }, registry, connectedHub)).toEqual({ workerId: "personal-worker", kind: "personal" });
    expect(await resolveTurnWorker({ context: { ...context, isPrivate: false } }, registry, connectedHub)).toEqual({ workerId: "shared-worker", kind: "shared" });
  });

  it("noRemoteTools=true 면 워커가 연결돼 있고 소유자 DM 이어도 null 이다(유휴 요약 턴) — registry·hub 조회 자체를 건너뛴다", async () => {
    expect(await resolveTurnWorker({ context, noRemoteTools: true }, registry, connectedHub)).toBeNull();
  });

  it("FIX4 — noRemoteTools 인 요청은 워커가 연결돼 있어도 allowedToolsFor 에 원격 도구 이름을 하나도 넘기지 않는다(유휴 요약 턴이 실제로 받는 도구 목록)", async () => {
    const worker = await resolveTurnWorker({ context, noRemoteTools: true }, registry, connectedHub);
    const workerConnected = worker !== null;
    const tools = allowedToolsFor("owner", context.isPrivate, context.isOwner, "local", { workerConnected });
    expect(tools.some((n) => n.startsWith("mcp__asahi__fs_") || n === "mcp__asahi__sh_exec")).toBe(false);
    // dir 관리 도구(FIX2 로 workerConnected 하나로 묶임)도 마찬가지로 닫힌다.
    expect(tools).not.toContain("mcp__asahi__allow_dir");
    // 기억·접근관리처럼 워커와 무관한 도구는 그대로 남는다(요약 자체는 대화 처리이므로).
    expect(tools).toContain("mcp__asahi__remember");
  });
});

// 최종 리뷰 FIX2(치명) — 정기 게시(digest.ts) 턴은 공개 채널 계층(isOwner:false, isPrivate:false,
// userId:"digest")으로 돈다. Task 7 이전에는 그 계층 자체에 원격 도구가 없어 안전했지만, 이제는
// 그 계층도 워커가 연결되면 fs_*/sh_exec 를 받는다 — 아래 첫 테스트가 "고치기 전이었다면
// 이랬을 것"(리뷰가 재현한 정확한 확인: shared-worker 로 resolve)을 보여주고, 두 번째 테스트가
// digest.ts 가 실제로 세우는 noRemoteTools:true 를 이 컨텍스트에 적용하면 워커 자체가 resolve
// 되지 않는다는 것(고친 뒤의 상태)을 증명한다.
describe("resolveTurnWorker — 정기 게시(digest) 컨텍스트도 noRemoteTools 없이는 공유 워커로 resolve 된다(최종 리뷰 FIX2)", () => {
  const digestContext = { isOwner: false, isPrivate: false, userId: "digest" };
  const registry = { personalWorkerOf: async () => null, sharedWorkerId: async () => "semicolon-shared" };
  const connectedHub = { isConnected: () => true };

  it("(고치기 전 상태 재현) noRemoteTools 없이 digest 컨텍스트를 넘기면 연결된 공유 워커로 resolve 된다 — 리뷰가 지적한 바로 그 결과", async () => {
    const worker = await resolveTurnWorker({ context: digestContext }, registry, connectedHub);
    expect(worker).toEqual({ workerId: "semicolon-shared", kind: "shared" });
  });

  it("digest.ts 가 세우는 noRemoteTools:true 를 적용하면, 공유 워커가 연결돼 있어도 워커가 resolve 되지 않고 allowedToolsFor 에도 원격 도구가 하나도 없다", async () => {
    const worker = await resolveTurnWorker({ context: digestContext, noRemoteTools: true }, registry, connectedHub);
    expect(worker).toBeNull();
    const workerConnected = worker !== null;
    const tools = allowedToolsFor("allowed", digestContext.isPrivate, digestContext.isOwner, "local", { workerConnected });
    expect(tools.some((n) => n.startsWith("mcp__asahi__fs_") || n === "mcp__asahi__sh_exec")).toBe(false);
    expect(tools).not.toContain("mcp__asahi__allow_dir");
    // 공개 채널 계층이 원래 받던 것(공용 recall)은 그대로 남는다.
    expect(tools).toContain("mcp__asahi__recall");
  });

  // Important 4(최종 전체 브랜치 리뷰) — digest.ts 가 실제로 세우는 noMemoryWrite:true 까지
  // 합쳐야, 이 턴이 실제로 받는 도구 목록에서 remember 가 빠진다(고치기 전엔 이 계층에
  // remember 가 조건 없이 들어 있었다 — 위 두 테스트가 원격 도구·recall 만 확인해서 그 구멍을
  // 못 잡았다).
  it("digest.ts 가 세우는 noMemoryWrite:true 까지 적용하면 allowedToolsFor 에 remember 가 없고 recall 은 그대로 남는다", () => {
    const memoryWriteEnabled = resolveMemoryWriteEnabled({ noMemoryWrite: true });
    const tools = allowedToolsFor("allowed", digestContext.isPrivate, digestContext.isOwner, "local", { memoryWriteEnabled });
    expect(tools).not.toContain("mcp__asahi__remember");
    expect(tools).toContain("mcp__asahi__recall");
  });
});

// FIX2(치명, 최종 리뷰) — ctx.remote 를 구성하는 로직을 순수 함수로 뽑아 hub.rootsOf 배선을
// 직접 검증한다. 예전엔 allowDirHandler(tools.ts)가 봇 프로세스의 fs.statSync/fs.realpathSync 로
// 경로를 검증했다 — 봇과 워커가 서로 다른 머신일 수 있어(클라우드는 물론 local 배포도 마찬가지)
// 이 검증은 실제로 아무 의미가 없었다. 이제 allowDirHandler 는 ctx.remote.roots(워커가 hello
// 프레임으로 알려온 실제 작업 폴더)로 검증하므로, makeRunAgentTurn 이 그 값을 실제로 채워야 한다 —
// WorkerHub.rootsOf(workerId) 는 이 함수가 생기기 전까지 프로덕션 호출자가 없었다(테스트 전용).
// Task 7: 시그니처가 workerConnected(boolean)+userId 대신 worker({workerId,kind}|null) 하나를
// 받게 바뀌었다 — resolveTurnWorker 가 이미 어느 워커·어느 종류인지 정했으므로 이 함수는 그
// 결과를 hub 에 연결하기만 한다.
describe("buildRemoteCtx — ctx.remote 구성(Task 7: worker={workerId,kind} 기준으로 바뀜)", () => {
  it("worker 가 있고 hub 가 있으면 roots 는 hub.rootsOf(workerId) 결과로, call 은 hub.call(workerId,...) 로 이어지고, workerId·workerKind 도 그대로 실린다", async () => {
    const seen: Array<{ id: string; tool: string; args: Record<string, unknown> }> = [];
    const hub = {
      call: async (id: string, tool: string, args: Record<string, unknown>) => {
        seen.push({ id, tool, args });
        return { ok: true, content: "본문" };
      },
      rootsOf: (id: string) => (id === "owner-laptop" ? ["/w/proj"] : []),
    };
    const remote = buildRemoteCtx({ workerId: "owner-laptop", kind: "personal" }, hub);
    expect(remote?.roots).toEqual(["/w/proj"]);
    expect(remote?.workerId).toBe("owner-laptop");
    expect(remote?.workerKind).toBe("personal");
    const result = await remote!.call("fs_read", { path: "/w/proj/a.txt" });
    expect(result).toEqual({ ok: true, content: "본문" });
    expect(seen).toEqual([{ id: "owner-laptop", tool: "fs_read", args: { path: "/w/proj/a.txt" } }]);
  });

  // FIX3(중요, 최종 리뷰) — workerKind 는 이 함수가 옮기는 필드 중 remoteToolHandler 의
  // scopeDirs(remoteTools.ts) 가 손님을 자기 폴더로 가두는지 말지를 통째로 결정하는 값이다.
  // 위 테스트는 kind:"personal" 하나만 확인해서, buildRemoteCtx 가 worker.kind 를 무시하고
  // "personal" 을 하드코딩해도(리뷰의 M12 뮤테이션) 통과해 버렸다 — kind:"shared" 를 넣어도
  // 그대로 "personal" 이 나오는 셈이라 아무도 못 잡았다. kind:"shared" 케이스를 별도로 확인해야
  // 이 필드가 실제로 그대로 옮겨지는지(하드코딩되지 않는지) 검증된다.
  it("worker.kind 가 'shared' 면 workerKind 도 'shared' 로 그대로 실린다(FIX3 — 하드코딩 회귀 가드)", async () => {
    const hub = {
      call: async () => ({ ok: true, content: "" }),
      rootsOf: (id: string) => (id === "semicolon-shared" ? ["C:\\ws"] : []),
    };
    const remote = buildRemoteCtx({ workerId: "semicolon-shared", kind: "shared" }, hub);
    expect(remote?.workerKind).toBe("shared");
    expect(remote?.workerId).toBe("semicolon-shared");
    expect(remote?.roots).toEqual(["C:\\ws"]);
  });

  it("worker 가 null 이면 hub 가 있어도 undefined 다(ctx.remote 를 채우지 않는다)", () => {
    const hub = { call: async () => ({ ok: true, content: "" }), rootsOf: () => ["/w"] };
    expect(buildRemoteCtx(null, hub)).toBeUndefined();
  });

  it("hub 자체가 없으면 worker 가 있어도 undefined 다", () => {
    expect(buildRemoteCtx({ workerId: "owner-laptop", kind: "personal" }, undefined)).toBeUndefined();
  });
});

// FIX3(중요, 최종 리뷰 3차) — 유휴 대화 요약 턴(core.ts 의 summarizeAndClose)은 noRemoteTools 로
// fs_*/sh_exec 는 이미 막아 두었지만, WebSearch 는 SDK 내장 도구라 그 플래그의 영향을 받지
// 않는다(agent.ts 의 builtinTools 는 별도 상수였다 — 리뷰 재현: noRemoteTools:true 인 실제
// makeRunAgentTurn 호출에서도 allowedTools 에 WebSearch 가 그대로 나왔다). noRemoteTools 와
// 똑같은 방식으로 noWebTools 를 뽑아, 이번 턴에 WebSearch 를 열지 판정한다.
describe("resolveWebToolsEnabled — noWebTools 는 웹 검색을 별도로 강제로 닫는다(FIX3)", () => {
  it("noWebTools 가 없으면(기본) 웹 도구가 열려 있다(회귀 없음)", () => {
    expect(resolveWebToolsEnabled({})).toBe(true);
  });

  it("noWebTools=true 면 웹 도구가 닫힌다(유휴 요약 턴)", () => {
    expect(resolveWebToolsEnabled({ noWebTools: true })).toBe(false);
  });

  it("noWebTools=false 를 명시해도 열려 있다(회귀 없음)", () => {
    expect(resolveWebToolsEnabled({ noWebTools: false })).toBe(true);
  });

  it("FIX3 — noWebTools 인 요청은 allowedToolsFor 에 WebSearch 를 하나도 넘기지 않는다(유휴 요약 턴이 실제로 받는 도구 목록)", () => {
    const webToolsEnabled = resolveWebToolsEnabled({ noWebTools: true });
    const tools = allowedToolsFor("owner", true, true, "local", { workerConnected: false, webToolsEnabled });
    expect(tools).not.toContain("WebSearch");
    // 기억·접근관리처럼 웹 검색과 무관한 도구는 그대로 남는다(요약 자체는 대화 처리이므로).
    expect(tools).toContain("mcp__asahi__remember");
  });
});

// Important 4(최종 전체 브랜치 리뷰) — noRemoteTools/noWebTools 와 같은 방식으로
// req.noMemoryWrite 를 뽑아, 이번 턴에 remember(기억 쓰기)를 열지 판정한다. digest.ts 가
// 이 값을 세운다 — 사람이 안 보는 타이머로 돌며 신뢰할 수 없는 웹 검색 결과를 읽는 턴이
// remember 로 동아리 공용 기억을 오염시키는 것을 막는다.
describe("resolveMemoryWriteEnabled — noMemoryWrite 는 remember 만 별도로 강제로 닫는다(Important 4)", () => {
  it("noMemoryWrite 가 없으면(기본) 기억 쓰기가 열려 있다(회귀 없음)", () => {
    expect(resolveMemoryWriteEnabled({})).toBe(true);
  });

  it("noMemoryWrite=true 면 기억 쓰기가 닫힌다(정기 게시 턴)", () => {
    expect(resolveMemoryWriteEnabled({ noMemoryWrite: true })).toBe(false);
  });

  it("noMemoryWrite=false 를 명시해도 열려 있다(회귀 없음)", () => {
    expect(resolveMemoryWriteEnabled({ noMemoryWrite: false })).toBe(true);
  });

  it("noMemoryWrite 인 요청은 allowedToolsFor 에 remember 를 넘기지 않지만 recall 은 그대로 남긴다(정기 게시 턴이 실제로 받는 도구 목록)", () => {
    const memoryWriteEnabled = resolveMemoryWriteEnabled({ noMemoryWrite: true });
    const tools = allowedToolsFor("allowed", false, false, "local", { memoryWriteEnabled });
    expect(tools).not.toContain("mcp__asahi__remember");
    expect(tools).toContain("mcp__asahi__recall");
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

describe("progressFromMessage — tool_result 에 성패·입력·소요시간을 싣는다", () => {
  const toolUse = (id: string, name: string, input: unknown) => ({
    type: "assistant",
    message: { content: [{ type: "tool_use", id, name, input }] },
  });
  const toolResult = (id: string, extra: Record<string, unknown> = {}) => ({
    type: "user",
    message: { content: [{ type: "tool_result", tool_use_id: id, ...extra }] },
  });

  it("is_error 가 없으면 ok:true, 있으면 ok:false", () => {
    const pending = new Map<string, PendingTool>();
    progressFromMessage(toolUse("t1", "fs_read", { path: "/w/a" }), pending, () => 1000);
    const okUpdates = progressFromMessage(toolResult("t1", { content: "본문" }), pending, () => 1300);
    expect(okUpdates[0]).toMatchObject({ kind: "tool_result", ok: true });

    progressFromMessage(toolUse("t2", "fs_write", {}), pending, () => 2000);
    const failUpdates = progressFromMessage(
      toolResult("t2", { is_error: true, content: "허용된 폴더 밖 경로예요" }), pending, () => 2100);
    expect(failUpdates[0]).toMatchObject({ kind: "tool_result", ok: false });
  });

  it("짝지어진 tool 의 입력과 소요시간을 함께 싣는다", () => {
    const pending = new Map<string, PendingTool>();
    progressFromMessage(toolUse("t1", "fs_read", { path: "/w/a.txt" }), pending, () => 1000);
    const [u] = progressFromMessage(toolResult("t1", { content: "본문" }), pending, () => 1450);
    expect(u).toMatchObject({ kind: "tool_result", name: "fs_read", durationMs: 450 });
    expect((u as { input?: string }).input).toContain("a.txt");
  });

  it("같은 도구를 연달아 불러도 id 로 각각 짝지어진다", () => {
    const pending = new Map<string, PendingTool>();
    progressFromMessage(toolUse("a", "fs_read", { path: "/w/first.txt" }), pending, () => 100);
    progressFromMessage(toolUse("b", "fs_read", { path: "/w/second.txt" }), pending, () => 200);
    const [second] = progressFromMessage(toolResult("b", { content: "x" }), pending, () => 260);
    const [first] = progressFromMessage(toolResult("a", { content: "y" }), pending, () => 900);
    expect((second as { input?: string }).input).toContain("second.txt");
    expect((second as { durationMs?: number }).durationMs).toBe(60);
    expect((first as { input?: string }).input).toContain("first.txt");
    expect((first as { durationMs?: number }).durationMs).toBe(800);
  });

  it("결과 요약은 200자에서 자른다", () => {
    const pending = new Map<string, PendingTool>();
    progressFromMessage(toolUse("t1", "sh_exec", { command: "ls" }), pending, () => 0);
    const [u] = progressFromMessage(toolResult("t1", { content: "가".repeat(500) }), pending, () => 10);
    expect((u as { summary?: string }).summary!.length).toBeLessThanOrEqual(200);
  });

  it("짝이 없는 tool_result 도 버리지 않는다(ok 는 살린다)", () => {
    const pending = new Map<string, PendingTool>();
    const [u] = progressFromMessage(toolResult("unknown", { content: "x" }), pending, () => 5);
    expect(u).toMatchObject({ kind: "tool_result", ok: true });
    expect((u as { durationMs?: number }).durationMs).toBeUndefined();
  });
});

// 리뷰 후속(Task 1 코드리뷰 Important) — 위 describe 의 모든 케이스는 content 를 string 으로만
// 넣어 짝지어 왔다. 그런데 tools.ts 의 textResult(`{ content: [{ type: "text", text }] }`)를
// 거치는 이 저장소의 모든 도구는 실제로 배열을 돌려준다 — Anthropic 메시지 스펙(SDK 의
// ToolResultBlockParam)상 content 는 string | 블록배열 둘 다 정상이다. string 만 가정한 예전
// 구현은 이 배열 경로를 그냥 지나쳐 summary 가 실사용에서 늘 undefined 였다(현재 테스트들이
// string 만 써서 이 구멍을 못 잡았다). 아래는 배열 경로를 리뷰가 요구한 다섯 케이스 그대로
// 직접 검증한다.
describe("progressFromMessage — tool_result.content 가 배열이어도 summary 를 뽑는다(MCP 표준, textResult 가 실제로 만드는 모양)", () => {
  const toolUse = (id: string, name: string, input: unknown) => ({
    type: "assistant",
    message: { content: [{ type: "tool_use", id, name, input }] },
  });
  const toolResult = (id: string, extra: Record<string, unknown> = {}) => ({
    type: "user",
    message: { content: [{ type: "tool_result", tool_use_id: id, ...extra }] },
  });

  it("content 가 [{ type: 'text', text: '본문' }] 배열이면 summary 는 '본문'", () => {
    const pending = new Map<string, PendingTool>();
    progressFromMessage(toolUse("t1", "recall", { query: "병원" }), pending, () => 0);
    const [u] = progressFromMessage(
      toolResult("t1", { content: [{ type: "text", text: "본문" }] }), pending, () => 10);
    expect((u as { summary?: string }).summary).toBe("본문");
  });

  it("텍스트 블록이 여러 개면 이어붙인다", () => {
    const pending = new Map<string, PendingTool>();
    progressFromMessage(toolUse("t1", "recall", { query: "병원" }), pending, () => 0);
    const [u] = progressFromMessage(
      toolResult("t1", { content: [{ type: "text", text: "가" }, { type: "text", text: "나" }] }), pending, () => 10);
    expect((u as { summary?: string }).summary).toBe("가나");
  });

  it("텍스트 블록이 하나도 없는 배열(예: 이미지만)이면 summary 는 undefined", () => {
    const pending = new Map<string, PendingTool>();
    progressFromMessage(toolUse("t1", "recall", { query: "병원" }), pending, () => 0);
    const [u] = progressFromMessage(
      toolResult("t1", { content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: "" } }] }), pending, () => 10);
    expect((u as { summary?: string }).summary).toBeUndefined();
  });

  it("content 가 문자열이면 예전처럼 그 문자열 그대로 summary 가 된다(회귀 없음)", () => {
    const pending = new Map<string, PendingTool>();
    progressFromMessage(toolUse("t1", "recall", { query: "병원" }), pending, () => 0);
    const [u] = progressFromMessage(toolResult("t1", { content: "본문" }), pending, () => 10);
    expect((u as { summary?: string }).summary).toBe("본문");
  });

  it("200자 상한이 배열 경로에서도 적용된다", () => {
    const pending = new Map<string, PendingTool>();
    progressFromMessage(toolUse("t1", "sh_exec", { command: "ls" }), pending, () => 0);
    const [u] = progressFromMessage(
      toolResult("t1", { content: [{ type: "text", text: "가".repeat(500) }] }), pending, () => 10);
    expect((u as { summary?: string }).summary!.length).toBeLessThanOrEqual(200);
  });
});
