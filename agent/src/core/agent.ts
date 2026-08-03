import { query } from "@anthropic-ai/claude-agent-sdk";
import type { SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import type { Role } from "../store/usersRepo.js";
import type { UsersRepo } from "../store/usersRepo.js";
import type { MemoriesRepo } from "../store/memoriesRepo.js";
import type { AllowedDirsRepo } from "../store/allowedDirsRepo.js";
import type { IntrospectRepo } from "../store/introspectRepo.js";
import type { WorkerKind } from "../store/workersRepo.js";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { buildTools, allowedToolsFor, TOOL_SERVER, type ToolCtx, type RuntimeInfo } from "./tools.js";
import { resolveWorkerSelector } from "./workerSelect.js";
import type { ImageInput } from "./images.js";
import { skillPluginDirFrom, resolveSkillsEnabled, skillPluginsFor } from "./skills.js";

// 자기인지(§Task5): SDK_VERSION 은 package.json 의 @anthropic-ai/claude-agent-sdk 버전과 동기화한다.
// DEFAULT_MODEL 은 makeRunAgentTurn 의 model 인자가 없을 때 쓰는 기본 모델이다.
const SDK_VERSION = "0.3.207"; // package.json 과 동기화
const DEFAULT_MODEL = "claude-opus-4-8";

// 프로세스 수명 동안 바뀌지 않으므로 턴마다 다시 계산하지 않는다. 존재 확인도 여기서 한 번만
// 한다 — 턴마다 디스크를 보는 것은 낭비이고, 스킬 폴더는 배포 산출물이라 도는 중에 생기거나
// 사라지지 않는다.
const PLUGIN_DIR = skillPluginDirFrom(path.dirname(fileURLToPath(import.meta.url)));
const SKILL_PLUGINS = skillPluginsFor({ pluginDir: PLUGIN_DIR, exists: fs.existsSync(PLUGIN_DIR) });
if (SKILL_PLUGINS.length === 0) console.warn(`[agent] 스킬 폴더가 없어 스킬 없이 돕니다: ${PLUGIN_DIR}`);

// 현재 턴의 상대·대화 컨텍스트. 이걸로 role·is_private 별 도구셋(allowedTools)을 정한다(§7.1).
export type TurnContext = { role: Role; isPrivate: boolean; isOwner: boolean; userId: string; conversationId: number };
// 턴 처리 중 진행 상황(판별 유니온). 표시용 텍스트로 바꾸는 건 core.ts 의 formatProgress 가 맡는다.
export type ProgressUpdate =
  | { kind: "tool"; name: string; input?: string }
  // 표시와 기록이 같은 값에서 나오도록 확장했다(2026-07-28 관측 기반 스펙 §3).
  // ok/summary 는 SDK 의 tool_result 블록에서, input/durationMs 는 짝지은 tool 이벤트에서 온다.
  | { kind: "tool_result"; name?: string; input?: string; ok: boolean; summary?: string; durationMs?: number }
  | { kind: "answering" };

// tool_use_id → 그 호출의 이름·입력·시작 시각. 예전엔 이름(string)만 담았는데, 기록 한 행을
// 채우려면 input 과 소요시간이 필요하다. 짝짓기는 반드시 id 로 한다 — 이름으로 짝지으면 같은
// 도구를 연달아 부를 때 어긋난다.
export type PendingTool = { name: string; input?: string; startedAt: number };

// 결과 요약의 기록 상한 — actions.result_summary 에 남길 해상도다. 표시 줄의 상한은 이 값이
// 아니라 core.ts 의 PROGRESS_SUMMARY_MAX(80)가 따로 갖는다. 같은 이벤트에서 나온 두 소비자가
// 서로 다른 예산을 갖는 지점이라, 표시를 늘리려고 이 값을 건드리면 표시는 그대로이고 DB
// 해상도만 바뀐다(최종 리뷰 Important 2 로 갈라진 뒤 이 주석이 낡아 바로잡았다).
export const RESULT_SUMMARY_MAX = 200;

// images(§Task3 이미지 입력): 있으면 query() 의 prompt 를 문자열 대신 async-iterable(SDKUserMessage 1개)로
// 바꿔 멀티모달 턴을 만든다(buildMultimodalMessage). 없으면 기존 문자열 prompt 경로 그대로(회귀 없음).
// noRemoteTools(FIX4, 최종 리뷰): true 면 이 턴은 워커 연결 여부와 무관하게 원격
// 도구(fs_*/sh_exec, 그리고 FIX2 로 같은 축에 묶인 allow_dir 등)를 강제로 닫는다(resolveTurnWorker
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
// noMemoryWrite(Important 4, 최종 전체 브랜치 리뷰): noRemoteTools/noSkills 와 같은 자리의 세
// 번째 축이다. 정기 게시(digest.ts)는 isOwner:false, isPrivate:false 로 돌아 손님 서버 계층과
// 신원이 같은데, 이 브랜치가 그 계층에 remember 를 열면서 사람이 안 보는 타이머 + 신뢰할 수
// 없는 웹 검색 결과라는 이 턴의 위협 모델이 remember 호출까지 도달하게 됐다. true 면 기억을
// 바꾸는 도구(remember·forget)를 닫는다 — recall(공용 기억 읽기)은 공용 기억이 어차피 전
// 부원에게 열려 있고 digest 출력도 공개 채널로 가므로 막을 이유가 없다.
//
// Important 2(리뷰 후속): 처음엔 remember 만 닫았는데, 요약 턴(core.ts 의 writeSummary)이 이
// 축을 두 번째 호출부로 쓰면서 구멍이 드러났다 — 그 턴은 대화 주인의 신원으로 서므로 소유자
// 스레드에서는 forget 까지 들고 도는데, forget 은 동아리 공용 기억을 지운다. "기억을 쓰면 안
// 되는 턴"이라는 축이 삭제 도구를 열어 두는 것은 다음 호출부를 향한 함정이라, 둘을 한 축으로
// 묶었다(tools.ts 의 memoryWriteEnabled).
export type TurnRequest = {
  prompt: string; systemPrompt: string; resume?: string; cwd: string; context: TurnContext;
  onProgress?: (u: ProgressUpdate) => void; images?: ImageInput[]; noRemoteTools?: boolean; noWebTools?: boolean;
  noSkills?: boolean; noMemoryWrite?: boolean;
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

// tool_result 블록의 content 에서 표시·요약용 텍스트를 뽑는다. Anthropic 메시지 스펙(SDK 의
// ToolResultBlockParam)상 content 는 string 이거나 블록 배열(TextBlockParam 등)이다 — 그런데 이
// 저장소의 모든 도구는 tools.ts 의 textResult(`{ content: [{ type: "text", text }] }`)를 거치므로
// 실제로 오는 건 항상 배열 쪽이다. content 를 string 으로만 가정했던 예전 구현(`typeof
// block.content === "string" ? block.content : undefined`)은 이 배열을 그냥 지나쳐 body 가 항상
// undefined 가 됐고, summary 는 실사용에서 한 번도 채워진 적이 없었다(리뷰 지적 — 지금까지의
// 테스트가 content 를 전부 string 으로만 넣어 이 구멍을 못 잡았다). 아래는 is_error 방어(없으면
// 성공으로 간주)와 같은 정신으로 SDK 가 어느 모양으로 주든 동작하게 둘 다 받는다: 배열이면
// type==="text" 인 블록들의 text 만 골라 구분자 없이 이어붙이고(이미지 등 다른 타입 블록은
// 무시), text 블록이 하나도 없으면 undefined.
function extractResultText(content: unknown): string | undefined {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return undefined;
  const texts = content
    .filter((b): b is { type: "text"; text: string } =>
      !!b && typeof b === "object" && (b as { type?: unknown }).type === "text" && typeof (b as { text?: unknown }).text === "string")
    .map((b) => b.text);
  return texts.length > 0 ? texts.join("") : undefined;
}

// query() 스트림 메시지 하나에서 진행 업데이트들을 뽑는 순수 함수. assistant 의 tool_use → 'tool',
// 그 뒤 user 의 tool_result → 'tool_result'(이름·입력은 pending 으로 되찾고 성패·요약은 이 블록
// 자체에서, 소요시간은 짝지은 tool 의 시작 시각과의 차로 계산), text 블록 → 'answering'.
// pending 은 호출자가 턴 하나 동안 유지하는 tool_use_id → PendingTool 맵(이 함수가 채우고 소비한다).
// now(기본 Date.now)는 테스트가 시계를 주입해 durationMs 를 결정적으로 검증할 수 있게 한다.
type ProgressSourceMessage = { type: string; message?: unknown };
export function progressFromMessage(
  message: ProgressSourceMessage,
  pending: Map<string, PendingTool>,
  now: () => number = Date.now,
): ProgressUpdate[] {
  const inner = message.message;
  const content = inner && typeof inner === "object" ? (inner as { content?: unknown }).content : undefined;
  if (!Array.isArray(content)) return [];
  const updates: ProgressUpdate[] = [];
  for (const raw of content) {
    if (!raw || typeof raw !== "object") continue;
    const block = raw as {
      type?: unknown; name?: unknown; id?: unknown; input?: unknown;
      tool_use_id?: unknown; is_error?: unknown; content?: unknown;
    };
    if (block.type === "tool_use" && typeof block.name === "string") {
      const name = shortToolName(block.name);
      const input = summarizeToolInput(block.input);
      if (typeof block.id === "string") pending.set(block.id, { name, input, startedAt: now() });
      updates.push({ kind: "tool", name, input });
    } else if (block.type === "tool_result" && typeof block.tool_use_id === "string") {
      const p = pending.get(block.tool_use_id);
      pending.delete(block.tool_use_id);
      // is_error 가 실려 오지 않는 SDK 버전에서도 안전하게 동작한다 — 없으면 성공으로 본다.
      const ok = block.is_error !== true;
      const body = extractResultText(block.content);
      updates.push({
        kind: "tool_result",
        name: p?.name,
        input: p?.input,
        ok,
        summary: body === undefined ? undefined : body.slice(0, RESULT_SUMMARY_MAX),
        durationMs: p === undefined ? undefined : now() - p.startedAt,
      });
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
// (어느 워커를 쓸지 정하는 resolveTurnWorker 판정이 끝난 뒤에야 알 수 있는 값이라 여기서 계산할 수 없다).
export function buildToolCtx(repos: ToolRepos, context: TurnContext, runtime: RuntimeInfo): ToolCtx {
  return {
    repos, role: context.role, isPrivate: context.isPrivate,
    isOwner: context.isOwner, userId: context.userId, conversationId: context.conversationId,
    runtime,
  };
}

// Task 7(워커 라우팅): 이 턴이 실제로 쓸 워커를 정하는 함수 — 예전의 shouldConnectWorker(신원
// 판정)와 resolveWorkerConnected(noRemoteTools 합성)를 이 함수 하나로 합쳤다. 예전 shouldConnectWorker
// 는 "소유자 DM(소유자 && 비공개)이면서 hub.isConnected(그 userId)"의 AND 였다 — 그 판정이
// 성립했던 건 그 시절엔 워커 1대 = 소유자 1명이라 워커의 id 자체가 곧 소유자의 userId 였기
// 때문이다. 이제 워커는 레지스트리(workers 테이블)에 등록된 별도의 id 를 갖고(예: 동아리
// 공용 PC 의 "semicolon-shared" — registerWorker.ts 참고), 손님도 그 공유 워커에 붙는다 —
// "누가 묻는가"(userId)와 "어느 기계인가"(workerId)가 서로 다른 축이 됐으므로, hub.isConnected 를
// 부르기 전에 레지스트리로 실제 workerId 를 먼저 찾아야 한다(예전 코드는 이 조회 없이
// hub.isConnected(userId) 를 직접 불렀는데, 실제 등록된 워커 id 와 userId 가 다른 한 이 호출은
// 항상 어긋났다 — registry 도입 전에는 드러나지 않았던 잠재적 버그다).
//
// 규칙은 resolveWorkerSelector(workerSelect.ts) 한 줄이 전부다 — "어디서 말하느냐가 어느
// 기계냐를 정한다": 소유자 DM 은 그 소유자의 개인 워커, 그 외(소유자의 서버 채널·손님의 DM·
// 손님의 서버 채널 전부)는 공유 워커. 이 함수는 그 선택자를 실제 id 로 바꾸고 연결 여부까지
// 확인하는 부분만 맡는다 — allowedToolsFor·remoteToolHandler 양쪽이 "워커가 있는가"를 판단할
// 때 쓰는 것과 동일한 하나의 결정이다(도구 목록과 실행 핸들러가 서로 다른 판정을 쓰면 "보이는데
// 실행은 거부"가 생긴다 — remoteTools.ts 상단 주석 참고).
//
// noRemoteTools 가 true 면(유휴 요약 턴) 레지스트리·허브 조회 자체를 건너뛰고 무조건 null 이다 —
// 예전 resolveWorkerConnected 가 하던 noRemoteTools 합성을 그대로 유지한다(사람이 지켜보지 않는
// 타이머로 도는 턴에는 워커가 실제로 연결돼 있어도 강제로 닫아야 한다는 FIX4 의 취지 그대로).
export async function resolveTurnWorker(
  req: { context: { isOwner: boolean; isPrivate: boolean; userId: string }; noRemoteTools?: boolean },
  registry?: { personalWorkerOf(userId: string): Promise<string | null>; sharedWorkerId(): Promise<string | null> },
  hub?: { isConnected(workerId: string): boolean },
): Promise<{ workerId: string; kind: WorkerKind } | null> {
  if (req.noRemoteTools === true || !registry || !hub) return null;
  const sel = resolveWorkerSelector(req.context);
  const id = sel.kind === "personal" ? await registry.personalWorkerOf(sel.userId) : await registry.sharedWorkerId();
  if (id === null || !hub.isConnected(id)) return null;
  return { workerId: id, kind: sel.kind };
}

// FIX3(중요, 최종 리뷰 3차): req.noWebTools 를 뽑아내는 순수 함수 — resolveWorkerConnected 를
// 뽑은 이유와 같다(SDK query() 전체를 목업하지 않고 이 판정 하나만 검증하기 위해서). 워커
// 연결과 달리 이 값은 hub 상태를 보지 않는다 — WebSearch 는 워커 유무와 무관한 SDK 내장 도구라
// "닫을지"가 오직 요청 쪽 플래그 하나로만 정해진다(요약 턴이면 true, 그 외엔 항상 false).
export function resolveWebToolsEnabled(req: { noWebTools?: boolean }): boolean {
  return !req.noWebTools;
}

// Important 4(최종 전체 브랜치 리뷰) — req.noMemoryWrite 를 뽑아내는 순수 함수. 위
// resolveWebToolsEnabled 와 같은 이유로 순수 함수다 — SDK query() 전체를 목업하지 않고 이
// 판정 하나만 검증하기 위해서다. digest.ts 와 core.ts 의 writeSummary 가 이 값을 true 로 세운다
// (둘 다 사람이 안 보는 채로 신뢰할 수 없는 텍스트를 이어받으면서, 텍스트만 만들면 되는 턴이다).
export function resolveMemoryWriteEnabled(req: { noMemoryWrite?: boolean }): boolean {
  return !req.noMemoryWrite;
}

// Task 7: ctx.remote(호출 통로 + workerId + workerKind + 워커의 실제 작업 폴더)를 구성하는
// 순수 함수. resolveTurnWorker 가 이미 "어느 워커, 어느 종류(personal/shared)"까지 정했으므로
// 이 함수는 그 결과를 hub.call/rootsOf 에 실제로 연결하기만 한다 — worker 가 null 이거나 hub 가
// 없으면 undefined(= ctx.remote 를 아예 채우지 않음)를 돌려준다. roots 는 tools.ts 의
// allowDirHandler 가 "이 경로가 워커의 실제 작업 폴더 안인가"를 검증하는 데 쓴다(봇 프로세스
// 자신의 파일시스템은 더 이상 보지 않는다 — 봇과 워커는 서로 다른 머신일 수 있다). workerKind 는
// remoteToolHandler(remoteTools.ts)가 scopeDirs 로 손님을 자기 폴더 안에 가두는 데 쓴다 —
// personal 워커(소유자의 개인 기계)는 좁히지 않고, shared 워커에서만 좁힌다.
export function buildRemoteCtx(
  worker: { workerId: string; kind: WorkerKind } | null,
  hub?: { rootsOf(id: string): string[]; call(id: string, tool: string, args: Record<string, unknown>): Promise<{ ok: boolean; content: string }> },
): ToolCtx["remote"] {
  if (!worker || !hub) return undefined;
  return {
    workerId: worker.workerId,
    workerKind: worker.kind,
    roots: hub.rootsOf(worker.workerId),
    call: (tool, args) => hub.call(worker.workerId, tool, args),
  };
}

// 도구 리포를 클로저로 받아 실제 SDK 턴 러너를 만든다. 매 턴 컨텍스트로
// 인프로세스 도구(remember/recall/manage_access)와 allowedTools 를 구성한다.
// deployTarget(Railway 조각2, 기본 local): cloud 면 owner-DM 이라도 PC 도구(파일/Bash)를 allowedToolsFor
// 단계에서 이미 뺀다.
// model(자기인지 §Task5, 기본 DEFAULT_MODEL): query() 에 그대로 전달되고, ctx.runtime.model 로도 실려
// runtime_info 도구가 "설정값"으로 보고한다. init 메시지의 실제 model 과 다르면 아래에서 warn 로그를 남긴다.
// registry(Task 7, 선택): workers 테이블 조회 — resolveTurnWorker 가 "이 턴이 어느 워커를 쓰는가"를
// 실제 id 로 풀 때 쓴다(index.ts 는 repos.workers 를 그대로 넘긴다). hub 와 항상 짝으로 쓰인다 —
// 어느 한쪽이라도 없으면 resolveTurnWorker 가 워커 없음(null)으로 취급한다.
// hub(원격 워커, 선택 — Task 7): 봇(index.ts)만 넘긴다. resolveTurnWorker 가 registry 로 찾은
// workerId 가 실제로 이 허브에 연결돼 있으면 ctx.remote 를 채우고 원격 도구(fs_*/sh_exec)를 연다 —
// 소유자 DM 뿐 아니라 소유자의 서버 채널·손님의 DM·서버 채널도 각자의 워커(개인 또는 공유)로
// 연결될 수 있다(§workerSelect.ts). 워커 프로세스(worker.ts)는 이 함수 자체를 쓰지 않는다 —
// 워커는 startWorkerClient 로 도구 호출을 직접 받는다.
// rootsOf(FIX2, 최종 리뷰): hub 가 그 워커가 hello 로 알려온 실제 작업 폴더를 돌려준다 —
// buildRemoteCtx 가 이 값을 ctx.remote.roots 에 실어, tools.ts 의 allowDirHandler 가 등록 요청을
// 그 값으로 재검증할 수 있게 한다.
export function makeRunAgentTurn(
  repos: ToolRepos,
  deployTarget: "local" | "cloud" = "local",
  model: string = DEFAULT_MODEL,
  registry?: { personalWorkerOf(userId: string): Promise<string | null>; sharedWorkerId(): Promise<string | null> },
  hub?: {
    isConnected(workerId: string): boolean;
    call(workerId: string, tool: string, args: Record<string, unknown>): Promise<{ ok: boolean; content: string }>;
    rootsOf(workerId: string): string[];
    workersInfo(): Array<{ workerId: string; commit?: string; connectedAt: number }>;
  },
): TurnRunner {
  return async (req) => {
    const runtime: RuntimeInfo = { model, sdkVersion: SDK_VERSION, deployTarget, maxTurns: 30, botCommit: process.env.RAILWAY_GIT_COMMIT_SHA, workers: hub?.workersInfo() ?? [] };
    const ctx: ToolCtx = buildToolCtx(repos, req.context, runtime);
    const server = buildTools(ctx);

    // Task 7: "어느 기계를, 그것이 있기는 한가"를 여기 한 곳에서만 정한다 — resolveTurnWorker 가
    // resolveWorkerSelector(위치 기반 선택)로 개인/공유를 가르고, registry 로 실제 workerId 를
    // 찾고, hub 로 연결 여부까지 확인한다. remoteToolHandler(remoteTools.ts)는 더 이상 이 판정을
    // 독립적으로 다시 하지 않는다 — ctx.remote 가 채워져 있다는 사실 자체가 이 판정의 결과다.
    // allowedTools 산정에도 같은 workerConnected 값을 넘겨야 "도구는 보이는데 실행하면 거부"라는
    // 불일치가 생기지 않는다(아래에서 확인).
    // FIX4(최종 리뷰): req.noRemoteTools 가 있으면(유휴 요약 턴) resolveTurnWorker 가 레지스트리·
    // 허브 조회 자체를 건너뛰고 무조건 null 을 돌려준다(그 합성을 그대로 유지).
    const worker = await resolveTurnWorker(req, registry, hub);
    const workerConnected = worker !== null;
    // FIX3(최종 리뷰 3차): req.noWebTools 가 있으면(유휴 요약 턴) 웹 검색도 함께 강제로 닫는다 —
    // resolveWebToolsEnabled 가 그 판정을 담당한다. allowedToolsFor 와 builtinTools 양쪽에
    // 반드시 같은 값을 넘겨야 "허용 목록엔 있는데 실행 화이트리스트엔 없음(또는 그 반대)" 불일치가
    // 생기지 않는다.
    const webToolsEnabled = resolveWebToolsEnabled(req);
    // 스킬도 같은 축으로 닫는다 — 유휴 요약 턴은 사람이 지켜보지 않고 인젝션이 심겼을 수도 있는
    // 세션을 이어받는다(core.ts 의 noWebTools 주석 참고). 요약에 스킬이 필요하지 않다.
    const skillsEnabled = resolveSkillsEnabled(req);
    // Important 4: 정기 게시(digest.ts)와 요약 턴(core.ts 의 writeSummary)이 req.noMemoryWrite:true
    // 로 기억을 바꾸는 도구(remember·forget)를 닫는다(recall 은 그대로) — noRemoteTools/noWebTools
    // 와 같은 방식으로 뽑아 allowedToolsFor 에 넘긴다.
    const memoryWriteEnabled = resolveMemoryWriteEnabled(req);
    // ctx.remote 구성(호출 통로 + workerId/workerKind + 워커 roots) 자체도 buildRemoteCtx 로
    // 뽑아 테스트한다(agent.test.ts).
    ctx.remote = buildRemoteCtx(worker, hub);
    const allowedTools = allowedToolsFor(req.context.role, req.context.isPrivate, req.context.isOwner, deployTarget, {
      workerConnected, webToolsEnabled, memoryWriteEnabled,
    });
    // 원격 도구는 전부 mcp__asahi__* 이므로 bare 사전승인으로 두고, 내장 파일/Bash 도구는 아예 열지 않는다
    // (builtinTools=[] 이 SDK 내장 도구를 전부 닫는다). 경로 검사는 이제 워커(remote/roots.ts)가 최종
    // 권한을 갖는다 — 이 프로세스는 내장 도구를 안 여니 canUseTool 로 판정할 대상 자체가 없다.
    const preApprovedTools = allowedTools;
    // SDK 내장 도구는 웹 검색과 스킬만 연다. 파일/Bash 는 원격 도구(fs_*·sh_exec)가 대신하므로
    // 계속 닫아 둔다 — 열면 봇 컨테이너의 파일시스템을 건드리게 된다.
    //
    // Skill 을 여기 넣어야 하는 이유(2026-08-01 실측, src/scripts/skillProbe.ts): tools 가 비면
    // SDK 는 Skill 도구까지 닫으며, skills: 'all' 을 줘도 되살아나지 않는다. 즉 스킬을 켜고 끄는
    // 실제 스위치는 skills 옵션이 아니라 이 배열이다 — WebSearch 와 같은 방식이다.
    const builtinTools: string[] = [
      ...(webToolsEnabled ? ["WebSearch"] : []),
      ...(skillsEnabled ? ["Skill"] : []),
    ];

    let sessionId: string | undefined;
    let text = "";
    let ok = false;
    // 턴 하나 동안 tool_use_id → PendingTool(이름·입력·시작 시각, 진행 이벤트용). onProgress 가
    // 없으면 추출도 하지 않는다.
    const pendingToolNames = new Map<string, PendingTool>();
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
        // 스킬은 agent/skill-plugin/ 에 플러그인 하나로 모여 있다(agent/skill-plugin/.claude-plugin).
        // 외부 스킬은 그 폴더에 그대로 복사해 커밋하는 것이 설치 방식이다.
        plugins: SKILL_PLUGINS,
        // 항상 'all' 이다. 끄는 일은 위 builtinTools 가 한다 — skills: [] 가 실제로 끄는지는
        // 실측으로 증명되지 않았고(Task 1 의 C 갈래는 tools: [] 와 겹쳐 분리되지 않았다),
        // 증명되지 않은 경로에 차단을 걸지 않는다.
        skills: "all" as const,
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
