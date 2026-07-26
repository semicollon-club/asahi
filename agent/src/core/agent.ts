import { query } from "@anthropic-ai/claude-agent-sdk";
import type { SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import type { Role } from "../store/usersRepo.js";
import type { UsersRepo } from "../store/usersRepo.js";
import type { MemoriesRepo } from "../store/memoriesRepo.js";
import type { AllowedDirsRepo } from "../store/allowedDirsRepo.js";
import type { IntrospectRepo } from "../store/introspectRepo.js";
import { buildTools, allowedToolsFor, TOOL_SERVER, type ToolCtx, type RuntimeInfo } from "./tools.js";
import type { ImageInput } from "./images.js";

// 자기인지(§Task5): SDK_VERSION 은 package.json 의 @anthropic-ai/claude-agent-sdk 버전과 동기화한다.
// DEFAULT_MODEL 은 makeRunAgentTurn 의 model 인자가 없을 때 쓰는 기본 모델이다.
const SDK_VERSION = "0.3.207"; // package.json 과 동기화
const DEFAULT_MODEL = "claude-opus-4-8";

// 현재 턴의 상대·대화 컨텍스트. 이걸로 role·is_private 별 도구셋(allowedTools)을 정한다(§7.1).
export type TurnContext = { role: Role; isPrivate: boolean; isOwner: boolean; userId: string; conversationId: number };
// 턴 처리 중 진행 상황(판별 유니온). 표시용 텍스트로 바꾸는 건 core.ts 의 formatProgress 가 맡는다.
export type ProgressUpdate =
  | { kind: "tool"; name: string; input?: string }
  | { kind: "tool_result"; name?: string }
  | { kind: "answering" };
// images(§Task3 이미지 입력): 있으면 query() 의 prompt 를 문자열 대신 async-iterable(SDKUserMessage 1개)로
// 바꿔 멀티모달 턴을 만든다(buildMultimodalMessage). 없으면 기존 문자열 prompt 경로 그대로(회귀 없음).
// noRemoteTools(FIX4, 최종 리뷰): true 면 이 턴은 워커 연결 여부·소유자 DM 여부와 무관하게 원격
// 도구(fs_*/sh_exec, 그리고 FIX2 로 같은 축에 묶인 allow_dir 등)를 강제로 닫는다(resolveWorkerConnected
// 참고). core.ts 의 유휴 대화 요약 턴(summarizeAndClose)이 이 값을 쓴다 — 그 턴은 사람이 지켜보지
// 않는 타이머로 돌고, 이전에 모델이 읽은 파일 등을 통해 프롬프트 인젝션이 심어졌을 수도 있는 세션을
// 그대로 이어받는다(resume). 그런 턴에 PC 접근을 열어 두면 그 인젝션이 아무도 모르는 사이에 실제
// 파일/셸 작업으로 이어질 수 있다.
// noWebTools(FIX3, 최종 리뷰 3차): noRemoteTools 와 짝을 이루는 별도 플래그다 — noRemoteTools 는
// 이름 그대로 원격 도구(fs_*/sh_exec) 축만 잠그고 SDK 내장 WebSearch 는 건드리지 않는다(builtinTools
// 는 이 파일 아래쪽의 별도 상수). 이 브랜치로 모든 턴이 WebSearch 를 갖게 되면서, noRemoteTools 만
// 세운 유휴 요약 턴도 실제로는 WebSearch 를 그대로 쓸 수 있었다(리뷰 재현 — db_schema/db_query 로
// 소유자 DB 전체를 읽는 턴에 외부 전송 통로까지 열려 있었던 셈). 요약은 이미 끝난 대화를 요약할
// 뿐 검색이 필요 없으므로, true 로 세워도 잃는 기능이 없다.
export type TurnRequest = {
  prompt: string; systemPrompt: string; resume?: string; cwd: string; context: TurnContext;
  onProgress?: (u: ProgressUpdate) => void; images?: ImageInput[]; noRemoteTools?: boolean; noWebTools?: boolean;
};
export type TurnResult = { text: string; sessionId?: string; ok: boolean };
export type TurnRunner = (req: TurnRequest) => Promise<TurnResult>;

export type ToolRepos = { memories: MemoriesRepo; users: UsersRepo; allowedDirs: AllowedDirsRepo; introspect: IntrospectRepo };

// mcp__asahi__recall → recall 처럼 인프로세스 MCP 접두어를 벗겨 짧게 만든다. 접두어가 없으면 그대로.
export function shortToolName(name: string): string {
  const parts = name.split("__");
  return name.startsWith("mcp__") && parts.length >= 3 ? parts.slice(2).join("__") : name;
}

function truncate(s: string, max = 40): string {
  const t = s.trim();
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

// 도구 입력 객체에서 사람이 읽을 만한 짧은 요약 하나를 뽑는다(대표 키 우선순위). 없으면 undefined.
export function summarizeToolInput(input: unknown): string | undefined {
  if (typeof input === "string") return input.trim().length > 0 ? truncate(input) : undefined;
  if (input && typeof input === "object") {
    const obj = input as Record<string, unknown>;
    for (const key of ["query", "title", "content", "path", "file_path", "pattern", "command", "description"]) {
      const v = obj[key];
      if (typeof v === "string" && v.length > 0) return truncate(v);
    }
  }
  return undefined;
}

// 이미지가 있는 턴의 SDK 입력 메시지(멀티모달). 텍스트가 비면 이미지 블록만 넣는다.
export function buildMultimodalMessage(text: string, images: ImageInput[]): SDKUserMessage {
  const content: Array<Record<string, unknown>> = [];
  if (text.trim()) content.push({ type: "text", text });
  for (const img of images) {
    content.push({ type: "image", source: { type: "base64", media_type: img.mediaType, data: img.base64 } });
  }
  return { type: "user", parent_tool_use_id: null, message: { role: "user", content } } as unknown as SDKUserMessage;
}

// query() 스트림 메시지 하나에서 진행 업데이트들을 뽑는 순수 함수. assistant 의 tool_use → 'tool',
// 그 뒤 user 의 tool_result → 'tool_result'(이름은 pendingToolNames 로 되찾음), text 블록 → 'answering'.
// pendingToolNames 는 호출자가 턴 하나 동안 유지하는 tool_use_id → 짧은 도구명 맵(이 함수가 채우고 소비한다).
type ProgressSourceMessage = { type: string; message?: unknown };
export function progressFromMessage(message: ProgressSourceMessage, pendingToolNames: Map<string, string>): ProgressUpdate[] {
  const inner = message.message;
  const content = inner && typeof inner === "object" ? (inner as { content?: unknown }).content : undefined;
  if (!Array.isArray(content)) return [];
  const updates: ProgressUpdate[] = [];
  for (const raw of content) {
    if (!raw || typeof raw !== "object") continue;
    const block = raw as { type?: unknown; name?: unknown; id?: unknown; input?: unknown; tool_use_id?: unknown };
    if (block.type === "tool_use" && typeof block.name === "string") {
      const name = shortToolName(block.name);
      if (typeof block.id === "string") pendingToolNames.set(block.id, name);
      updates.push({ kind: "tool", name, input: summarizeToolInput(block.input) });
    } else if (block.type === "tool_result" && typeof block.tool_use_id === "string") {
      const name = pendingToolNames.get(block.tool_use_id);
      pendingToolNames.delete(block.tool_use_id);
      updates.push({ kind: "tool_result", name });
    } else if (block.type === "text") {
      updates.push({ kind: "answering" });
    }
  }
  return updates;
}

// TurnContext → ToolCtx 로 옮기는 순수 함수(테스트 대상) — makeRunAgentTurn 안에 인라인
// 리터럴로 두지 않고 뽑아 둔 이유는, 필드 하나가 조용히 안 옮겨지는 종류의 버그(과거 실제로
// 있었다 — ownWorkstation 필드 누락. 그 필드 자체가 FIX6(최종 리뷰)로 완전히 삭제되며 이
// 히스토리는 종료됐다 — tools.ts 의 canManagePc 주석 참고)를 이 함수 자체를 직접 테스트해서
// 잡기 위해서다(agent.test.ts).
// 자기인지(§Task5): runtime(RuntimeInfo) 을 별도 인자로 받아 ctx.runtime 에 그대로 싣는다. repos 는
// 그대로 넘기기만 하면 introspect 도 함께 옮겨진다(ToolRepos 에 introspect 가 포함돼 있으므로).
// ctx.remote 는 이 함수가 다루지 않는다 — makeRunAgentTurn 이 buildRemoteCtx 로 별도로 채운다
// (워커 연결 판정(resolveWorkerConnected)이 끝난 뒤에야 알 수 있는 값이라 여기서 계산할 수 없다).
export function buildToolCtx(repos: ToolRepos, context: TurnContext, runtime: RuntimeInfo): ToolCtx {
  return {
    repos, role: context.role, isPrivate: context.isPrivate,
    isOwner: context.isOwner, userId: context.userId, conversationId: context.conversationId,
    runtime,
  };
}

// FIX7(중요): 이 턴에 원격 워커(ctx.remote + fs_*/sh_exec 6종)를 열지 정하는 술어만 따로 뽑은
// 순수 함수 — makeRunAgentTurn 안에 인라인으로 두면 이 판단 하나를 검증하려고 SDK query() 전체를
// 목업해야 해서 테스트가 없었다(리뷰 지적: 가장 보안에 민감한 줄인데도 회귀를 잡을 방법이 없었다).
// 정확히 "소유자 DM(소유자 && 비공개)이면서 그 소유자의 워커가 허브에 연결돼 있다"의 AND 다 —
// "연결은 됐지만 공개 채널"(isPrivate=false)과 "연결은 됐지만 손님"(isOwner=false) 두 경우가 이
// 판정이 지켜야 할 핵심 회귀다: 허브 쪽 배선(hub.isConnected)은 이 턴이 공개 채널인지도, 소유자인지도
// 모르고 오직 "그 userId 의 워커가 연결돼 있는가"만 안다 — 그래서 나머지 두 조건은 반드시 여기서
// 함께 확인해야 한다(remoteToolHandler 가 실행 시점에 독립적으로 다시 확인하는 것과 같은 기준).
export function shouldConnectWorker(
  context: { isOwner: boolean; isPrivate: boolean; userId: string },
  hub?: { isConnected(userId: string): boolean },
): boolean {
  return context.isOwner && context.isPrivate && hub?.isConnected(context.userId) === true;
}

// FIX4(중요, 최종 리뷰): req.noRemoteTools 를 shouldConnectWorker 판정과 합성하는 순수 함수 —
// noRemoteTools 가 true 면(유휴 요약 턴) 워커가 실제로 연결돼 있고 소유자 DM 이어도 무조건
// false 를 돌려준다. makeRunAgentTurn 안에 인라인으로 두지 않고 뽑은 이유는 shouldConnectWorker
// 를 뽑은 이유와 같다 — SDK query() 전체를 목업하지 않고 이 판정 하나만 검증하기 위해서다.
export function resolveWorkerConnected(
  req: { context: { isOwner: boolean; isPrivate: boolean; userId: string }; noRemoteTools?: boolean },
  hub?: { isConnected(userId: string): boolean },
): boolean {
  if (req.noRemoteTools) return false;
  return shouldConnectWorker(req.context, hub);
}

// FIX3(중요, 최종 리뷰 3차): req.noWebTools 를 뽑아내는 순수 함수 — resolveWorkerConnected 를
// 뽑은 이유와 같다(SDK query() 전체를 목업하지 않고 이 판정 하나만 검증하기 위해서). 워커
// 연결과 달리 이 값은 hub 상태를 보지 않는다 — WebSearch 는 워커 유무와 무관한 SDK 내장 도구라
// "닫을지"가 오직 요청 쪽 플래그 하나로만 정해진다(요약 턴이면 true, 그 외엔 항상 false).
export function resolveWebToolsEnabled(req: { noWebTools?: boolean }): boolean {
  return !req.noWebTools;
}

// FIX2(치명, 최종 리뷰): ctx.remote(호출 통로 + 워커의 실제 작업 폴더)를 구성하는 순수 함수.
// makeRunAgentTurn 안에 인라인으로 두면 hub.rootsOf 배선을 직접 검증하려고 SDK query() 전체를
// 목업해야 해서(다른 추출 함수들과 같은 이유) 테스트가 무거워진다. workerConnected 가 false 거나
// hub 가 없으면 undefined(= ctx.remote 를 아예 채우지 않음)를 돌려준다. roots 는 tools.ts 의
// allowDirHandler 가 "이 경로가 워커의 실제 작업 폴더 안인가"를 검증하는 데 쓴다(봇 프로세스
// 자신의 파일시스템은 더 이상 보지 않는다 — 봇과 워커는 서로 다른 머신일 수 있다) —
// WorkerHub.rootsOf(userId) 는 이 함수가 생기기 전까지 프로덕션 호출자가 없었다(테스트 전용).
export function buildRemoteCtx(
  workerConnected: boolean,
  hub: { call(userId: string, tool: string, args: Record<string, unknown>): Promise<{ ok: boolean; content: string }>; rootsOf(userId: string): string[] } | undefined,
  userId: string,
): ToolCtx["remote"] {
  if (!workerConnected || !hub) return undefined;
  return { call: (tool, args) => hub.call(userId, tool, args), roots: hub.rootsOf(userId) };
}

// 도구 리포를 클로저로 받아 실제 SDK 턴 러너를 만든다. 매 턴 컨텍스트로
// 인프로세스 도구(remember/recall/manage_access)와 allowedTools 를 구성한다.
// deployTarget(Railway 조각2, 기본 local): cloud 면 owner-DM 이라도 PC 도구(파일/Bash)를 allowedToolsFor
// 단계에서 이미 뺀다.
// model(자기인지 §Task5, 기본 DEFAULT_MODEL): query() 에 그대로 전달되고, ctx.runtime.model 로도 실려
// runtime_info 도구가 "설정값"으로 보고한다. init 메시지의 실제 model 과 다르면 아래에서 warn 로그를 남긴다.
// hub(원격 워커 1단계, 선택 — Task 7): 봇(index.ts)만 넘긴다. 소유자 DM 이고 그 소유자의 워커가
// 허브에 연결돼 있으면 ctx.remote 를 채우고 원격 도구(fs_*/sh_exec)를 연다. 워커 프로세스(worker.ts)는
// 이 함수 자체를 쓰지 않는다 — 워커는 startWorkerClient 로 도구 호출을 직접 받는다.
// rootsOf(FIX2, 최종 리뷰): hub 가 그 사용자의 워커가 hello 로 알려온 실제 작업 폴더를 돌려준다 —
// buildRemoteCtx 가 이 값을 ctx.remote.roots 에 실어, tools.ts 의 allowDirHandler 가 등록 요청을
// 그 값으로 재검증할 수 있게 한다.
export function makeRunAgentTurn(
  repos: ToolRepos,
  deployTarget: "local" | "cloud" = "local",
  model: string = DEFAULT_MODEL,
  hub?: {
    isConnected(userId: string): boolean;
    call(userId: string, tool: string, args: Record<string, unknown>): Promise<{ ok: boolean; content: string }>;
    rootsOf(userId: string): string[];
  },
): TurnRunner {
  return async (req) => {
    const runtime: RuntimeInfo = { model, sdkVersion: SDK_VERSION, deployTarget, maxTurns: 30 };
    const ctx: ToolCtx = buildToolCtx(repos, req.context, runtime);
    const server = buildTools(ctx);

    // 원격 통로는 "소유자 DM"(진짜 사설 1:1) 일 때만 연다 — remoteToolHandler(remoteTools.ts)가
    // 실행 시점에 다시 확인하는 것과 동일한 기준이다. hub.isConnected(userId) 만으로 판단하면
    // (허브 쪽 배선은 이 턴이 공개 채널인지 모른다) 소유자가 공개 서버 채널에 쓴 턴에도 ctx.remote 가
    // 채워져, 그 채널의 모델이 sh_exec 등 PC 도구를 호출할 길이 생긴다. allowedTools 산정에도 같은
    // workerConnected 값을 넘겨야 "도구는 보이는데 실행하면 거부"라는 불일치가 생기지 않는다.
    // FIX7: 이 판정 자체는 shouldConnectWorker 로 뽑아 따로 테스트한다(agent.test.ts) — 이 함수
    // (makeRunAgentTurn)는 SDK query() 호출까지 가므로 판정 하나만 검증하기엔 무겁다.
    // FIX4(최종 리뷰): req.noRemoteTools 가 있으면(유휴 요약 턴) shouldConnectWorker 결과와
    // 무관하게 강제로 false 다 — resolveWorkerConnected 가 그 합성을 담당한다.
    const workerConnected = resolveWorkerConnected(req, hub);
    // FIX3(최종 리뷰 3차): req.noWebTools 가 있으면(유휴 요약 턴) 웹 검색도 함께 강제로 닫는다 —
    // resolveWebToolsEnabled 가 그 판정을 담당한다. allowedToolsFor 와 builtinTools 양쪽에
    // 반드시 같은 값을 넘겨야 "허용 목록엔 있는데 실행 화이트리스트엔 없음(또는 그 반대)" 불일치가
    // 생기지 않는다.
    const webToolsEnabled = resolveWebToolsEnabled(req);
    // FIX2(최종 리뷰): ctx.remote 구성(호출 통로 + 워커 roots) 자체도 buildRemoteCtx 로 뽑아
    // 테스트한다.
    ctx.remote = buildRemoteCtx(workerConnected, hub, req.context.userId);
    const allowedTools = allowedToolsFor(req.context.role, req.context.isPrivate, req.context.isOwner, deployTarget, workerConnected, webToolsEnabled);
    // 원격 도구는 전부 mcp__asahi__* 이므로 bare 사전승인으로 두고, 내장 파일/Bash 도구는 아예 열지 않는다
    // (builtinTools=[] 이 SDK 내장 도구를 전부 닫는다). 경로 검사는 이제 워커(remote/roots.ts)가 최종
    // 권한을 갖는다 — 이 프로세스는 내장 도구를 안 여니 canUseTool 로 판정할 대상 자체가 없다.
    const preApprovedTools = allowedTools;
    // SDK 내장 도구는 웹 검색만 연다(webToolsEnabled 가 false 면 그마저도 닫는다 — 유휴 요약
    // 턴 전용, FIX3). 파일/Bash 는 원격 도구(fs_*·sh_exec)가 대신하므로 내장 쪽은 계속 닫아
    // 둔다 — 열면 봇 컨테이너의 파일시스템을 건드리게 된다.
    const builtinTools: string[] = webToolsEnabled ? ["WebSearch"] : [];

    let sessionId: string | undefined;
    let text = "";
    let ok = false;
    // 턴 하나 동안 tool_use_id → 짧은 도구명(진행 이벤트용). onProgress 가 없으면 추출도 하지 않는다.
    const pendingToolNames = new Map<string, string>();
    // 이미지가 있으면 async-iterable(멀티모달 1메시지)로, 없으면 기존 문자열 prompt 그대로(회귀 금지).
    const promptInput = req.images && req.images.length > 0
      ? (async function* () { yield buildMultimodalMessage(req.prompt, req.images!); })()
      : req.prompt;

    for await (const message of query({
      prompt: promptInput,
      options: {
        cwd: req.cwd,
        systemPrompt: req.systemPrompt,
        resume: req.resume,
        allowedTools: preApprovedTools,
        tools: builtinTools,
        mcpServers: { [TOOL_SERVER]: server },
        permissionMode: "default",
        model,
        maxTurns: 30,
      },
    })) {
      if (req.onProgress) {
        for (const update of progressFromMessage(message, pendingToolNames)) {
          req.onProgress(update);
        }
      }
      if (message.type === "system" && message.subtype === "init") {
        sessionId = message.session_id;
        // 자기인지(§Task5): 설정한 model 과 SDK 가 실제로 실행한 model 이 다르면(예: 모델 별칭이 다른
        // 버전으로 라우팅됨) 즉시 알아챌 수 있도록 warn 으로 남긴다. 같으면 확인용 info 로그만.
        const actual = (message as { model?: string }).model;
        if (actual && actual !== model) console.warn(`[agent] 설정 모델(${model}) ≠ 실제 실행 모델(${actual})`);
        else if (actual) console.log(`[agent] 실행 모델: ${actual}`);
      }
      if (message.type === "result") {
        sessionId = message.session_id ?? sessionId;
        if (message.subtype === "success") {
          text = message.result;
          ok = true;
        } else {
          text = `(에이전트 오류: ${message.subtype})`;
          ok = false;
        }
      }
    }

    return { text, sessionId, ok };
  };
}
