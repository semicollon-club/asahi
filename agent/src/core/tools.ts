import fs from "node:fs";
import path from "node:path";
import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import type { Role } from "../store/usersRepo.js";
import type { UsersRepo } from "../store/usersRepo.js";
import type { MemoriesRepo, Memory } from "../store/memoriesRepo.js";
import type { AllowedDirsRepo } from "../store/allowedDirsRepo.js";
import type { IntrospectRepo } from "../store/introspectRepo.js";
import { assertReadOnlySql, formatQueryResult } from "./sqlGuard.js";
import { CHARACTER_FACT_LIMIT } from "./turnPrep.js";
import { REMOTE_TOOL_NAMES, remoteToolHandler } from "./remoteTools.js";

// 도구 서버 이름 → 모델에는 mcp__asahi__<tool> 로 노출된다.
export const TOOL_SERVER = "asahi";
const t = (name: string): string => `mcp__${TOOL_SERVER}__${name}`;

// 자기인지(§Task4): 이 봇이 어떤 모델·SDK·배포 설정으로 동작 중인지. runtime_info 도구가 그대로 보고한다.
export type RuntimeInfo = { model: string; sdkVersion: string; deployTarget: "local" | "cloud"; maxTurns: number };

// 현재 턴의 상대·대화 컨텍스트를 클로저로 받는다. 도구 handler 는 이걸로 스코프를 강제한다.
export type ToolCtx = {
  repos: { memories: MemoriesRepo; users: UsersRepo; allowedDirs: AllowedDirsRepo; introspect: IntrospectRepo };
  role: Role;
  isPrivate: boolean;
  isOwner: boolean;
  userId: string;
  conversationId: number;
  // 로컬 워커가 이 턴을 그 사용자 자신의 PC 에서 실행 중이면 true(아래 canManagePc 가 참조).
  // Task 8(위임 기계장치 삭제): 이 값을 true 로 설정하던 유일한 생산자(worker/jobRunner.ts)가
  // 삭제되어 지금은 항상 undefined 다 — canManagePc 는 사실상 isOwner 로만 판정된다. allowedToolsFor
  // 는 더 이상 이 필드를 보지 않는다(그쪽의 ownWorkstation 분기는 Task 8 에서 제거했다).
  // manage_access·recall 전원열람 등 신원 기반 특권에는 영향을 주지 않는다(isOwner 로만 판정).
  ownWorkstation?: boolean;
  runtime: RuntimeInfo;
  // 원격 워커 호출 통로. 워커가 연결돼 있을 때만 주입된다(index.ts 배선).
  remote?: { call(tool: string, args: Record<string, unknown>): Promise<{ ok: boolean; content: string }> };
};

// PC 관리 도구(allow_dir/revoke_dir/list_dirs)를 쓸 수 있는 신원인지: 소유자 DM, 또는
// 워커가 실행 중인 자기 PC 의 DM(손님 포함). 서버/스레드(비공개)는 어느 쪽이든 항상 거부한다.
function canManagePc(ctx: ToolCtx): boolean {
  return ctx.isPrivate && (ctx.isOwner || ctx.ownWorkstation === true);
}

// ── 순수 핸들러(테스트 대상) ────────────────────────────────────────────────
export async function rememberHandler(ctx: ToolCtx, args: { title: string; content: string }): Promise<string> {
  // 항상 현재 상대(userId)·scope='user' 로만 저장한다. 손님은 shared 를 쓸 수 없다.
  await ctx.repos.memories.insert({ userId: ctx.userId, scope: "user", title: args.title, content: args.content, sourceConversationId: ctx.conversationId });
  return `기억했어요: "${args.title}"`;
}

// 캐릭터 설정 1건의 최대 길이. 신상 한 줄에는 충분하고, 프롬프트 무한 증식을 막는다.
export const CHARACTER_FACT_MAX_LEN = 200;
// 제목 상한. 제목은 "짧은 제목"으로 쓰도록 안내하지만, 손님이 쓸 수 있는 전역 저장소라 실제로 강제한다.
export const CHARACTER_FACT_TITLE_MAX_LEN = 40;

// 코드포인트 단위로 자른다. slice() 는 UTF-16 코드유닛 기준이라 이모지가 경계에 걸리면 서로게이트 쌍이 쪼개진다.
const truncateChars = (s: string, max: number): string => [...(s ?? "")].slice(0, max).join("");

// 캐릭터가 대화 중 지어낸 자기 신상을 확정 설정으로 고정한다. 항상 scope='character' —
// 실제 기억(user/shared)과 물리적으로 분리해, 지어낸 설정이 recall 결과에 섞이지 않게 한다.
export async function characterFactHandler(ctx: ToolCtx, args: { title: string; content: string }): Promise<string> {
  // 상한에 도달하면 저장하지 않고 그 사실을 그대로 알린다. 저장은 됐지만 주입되지 않는 행을 만들면
  // 도구가 "고정했다"고 거짓 보고하게 되고, 모델은 그걸 사실로 사용자에게 전달한다 — 이 기능이
  // 막으려는 실패(도구 결과 조작) 그 자체다.
  const existing = await ctx.repos.memories.characterFacts(CHARACTER_FACT_LIMIT);
  if (existing.length >= CHARACTER_FACT_LIMIT) {
    return `설정이 가득 차서(${CHARACTER_FACT_LIMIT}개) 고정하지 못했어. 이미 정해진 설정 안에서 답해.`;
  }
  const title = truncateChars(args.title, CHARACTER_FACT_TITLE_MAX_LEN);
  const content = truncateChars(args.content, CHARACTER_FACT_MAX_LEN);
  await ctx.repos.memories.insert({ userId: ctx.userId, scope: "character", title, content, sourceConversationId: ctx.conversationId });
  return `설정 고정: "${title}"`;
}

export async function recallHandler(ctx: ToolCtx, args: { query: string }): Promise<string> {
  // 프라이버시 스코프: 소유자 DM=전원, 손님 DM=본인+공용, 서버=공용만.
  let pool: Memory[];
  if (ctx.isOwner && ctx.isPrivate) pool = await ctx.repos.memories.all();
  else if (ctx.isPrivate) pool = await ctx.repos.memories.forUser(ctx.userId);
  else pool = await ctx.repos.memories.sharedOnly();

  const q = (args.query ?? "").trim().toLowerCase();
  const hits = pool.filter((m) => q.length === 0 || `${m.title} ${m.content}`.toLowerCase().includes(q));
  if (hits.length === 0) return "관련 기억이 없어요.";
  return hits.map((m) => `- [${m.title}] ${m.content}`).join("\n");
}

export async function manageAccessHandler(ctx: ToolCtx, args: { userId: string; role: Role }): Promise<string> {
  // 소유자 DM(진짜 사설 1:1)에서만. 서버·손님 턴에서는 거부.
  if (!(ctx.isOwner && ctx.isPrivate)) return "이 작업은 소유자 DM에서만 할 수 있어요.";
  // 명시적 스노플레이크(디스코드 숫자 ID)만 허용 — 표시명·동명 오작동 방지.
  if (!/^\d{5,}$/.test(args.userId)) return "사용자의 디스코드 숫자 ID(@멘션)를 정확히 지정해 주세요.";
  // 'owner' 부여는 거부한다 — 소유자는 단일 신원(config)이며, 제2 소유자 생성은 신원 게이트를 우회시킨다.
  if (!["allowed", "blocked"].includes(args.role)) return "부여할 수 있는 역할은 allowed 또는 blocked 예요. (소유자는 바꿀 수 없어요)";
  await ctx.repos.users.upsert(args.userId, { role: args.role });
  return `${args.userId} 님의 접근 권한을 '${args.role}'(으)로 설정했어요.`;
}

// 원격 개발 워크플로우(Phase A): 소유자 DM 전용 게이트 — 실제 경로 제한(canUseTool)은 별도 태스크(A3)의 몫이다.
const OWNER_DM_ONLY = "이 작업은 소유자 DM에서만 할 수 있어요.";

export async function allowDirHandler(ctx: ToolCtx, args: { path: string }): Promise<string> {
  if (!canManagePc(ctx)) return OWNER_DM_ONLY;
  let stat: fs.Stats;
  try {
    stat = fs.statSync(args.path);
  } catch {
    return `경로를 찾을 수 없어요: ${args.path}`;
  }
  if (!stat.isDirectory()) return `디렉토리가 아니에요: ${args.path}`;
  // 보안리뷰 #4: 심볼릭 링크/정션으로 등록하면 canUseTool 의 realpath 후보와 어긋나 통째로 과차단되므로,
  // statSync 로 존재를 확인한 뒤 실경로로 저장한다(normalizeDir 자체는 순수 함수로 그대로 둔다).
  const real = fs.realpathSync(args.path);
  await ctx.repos.allowedDirs.add(ctx.userId, real);
  return `허용 폴더에 추가했어요: ${path.resolve(real)}`;
}

export async function revokeDirHandler(ctx: ToolCtx, args: { path: string }): Promise<string> {
  if (!canManagePc(ctx)) return OWNER_DM_ONLY;
  await ctx.repos.allowedDirs.remove(ctx.userId, args.path);
  return `허용 폴더에서 제거했어요: ${path.resolve(args.path)}`;
}

export async function listDirsHandler(ctx: ToolCtx): Promise<string> {
  if (!canManagePc(ctx)) return OWNER_DM_ONLY;
  const dirs = await ctx.repos.allowedDirs.list(ctx.userId);
  if (dirs.length === 0) return "허용된 폴더가 없어요.";
  return dirs.map((d) => `- ${d}`).join("\n");
}

// 자기인지 도구(§Task4): 소유자 DM 전용 — db_schema/db_query/runtime_info.
// 손님·서버·ownWorkstation 은 어느 경우에도 노출·실행 둘 다 거부한다(isOwner && isPrivate 로만 판정).
function isOwnerDm(ctx: ToolCtx): boolean { return ctx.isOwner && ctx.isPrivate; }

export async function dbSchemaHandler(ctx: ToolCtx): Promise<string> {
  if (!isOwnerDm(ctx)) return OWNER_DM_ONLY;
  return await ctx.repos.introspect.schema();
}

export async function dbQueryHandler(ctx: ToolCtx, args: { sql: string }): Promise<string> {
  if (!isOwnerDm(ctx)) return OWNER_DM_ONLY;
  try { assertReadOnlySql(args.sql); } catch (e) { return e instanceof Error ? e.message : "잘못된 쿼리예요."; }
  try {
    const { rows, truncated } = await ctx.repos.introspect.readOnlyQuery(args.sql);
    return formatQueryResult(rows, truncated);
  } catch (e) {
    return `쿼리 실행 오류: ${e instanceof Error ? e.message : String(e)}`;
  }
}

export async function runtimeInfoHandler(ctx: ToolCtx): Promise<string> {
  if (!isOwnerDm(ctx)) return OWNER_DM_ONLY;
  const r = ctx.runtime;
  return [
    `모델(설정): ${r.model}`,
    `SDK: @anthropic-ai/claude-agent-sdk@${r.sdkVersion}`,
    `배포 대상: ${r.deployTarget}`,
    `한 응답 내 도구 반복 상한(maxTurns): ${r.maxTurns}`,
    `한도: 소유자는 무제한, 손님은 시간당 제한(유저별/전역).`,
  ].join("\n");
}

// ── 턴별 도구셋(능력 계층, §7.1) ────────────────────────────────────────────
// owner-DM → 기억 + 접근관리 + 허용폴더 관리 + db_schema/db_query/runtime_info(+ 워커가 연결돼 있으면
// 원격 파일/셸 도구까지). 손님 DM → 기억(본인)만. 서버 → recall(공용)만.
// Task 7(원격 워커 배선): owner-DM 분기에서 SDK 내장 파일/Bash 도구(Read/Write/Edit/Glob/Grep/Bash)를
// 뺐다 — core/agent.ts 가 builtinTools=[] 로 그 도구들을 아예 닫아버리므로, 여기 목록에 이름을 남겨봐야
// 실행할 대상이 없는 허수아비 항목이 된다(있지도 않은 능력을 있다고 보고하는 셈). 실제 파일/셸 작업은
// 워커가 연결돼 있을 때만 원격 도구(mcp__asahi__fs_*·sh_exec)로 한다.
// deployTarget="cloud"(Railway 조각2): 소유자 PC 가 없는 컨테이너 실행이므로 owner-DM 이라도
// allow_dir/revoke_dir/list_dirs(PC 폴더 개념을 전제하는 도구)는 빼고 대화·기억·접근관리·db 도구만
// 남긴다. local(기본)은 기존과 완전히 동일.
// workerConnected(원격 워커 1단계): owner-DM 두 분기(local/cloud) 모두에 원격 도구 6종을 추가로 연다.
// 손님 DM·서버 분기는 그대로 둔다 — 1단계 원격 도구는 소유자 전용이다.
// Task 8(위임 기계장치 삭제): 이 함수가 갖고 있던 ownWorkstation 분기(손님이라도 자기 PC 전권으로
// SDK 내장 파일/Bash 를 여는 경로)를 제거했다 — canUseTool 의 경로 검사가 이미 다른 태스크에서
// 빠진 상태라, 그 분기가 살아있었다면 Read/Write/Edit/Glob/Grep/Bash 를 경로 검사 없이 그대로
// 여는 셈이었다. 그 분기를 여는 ownWorkstation:true 는 worker/jobRunner.ts 에서만 만들어졌는데
// 그 파일 자체가 이 태스크로 삭제되어 원래도 도달 불가능한 코드였다. ToolCtx.ownWorkstation 필드
// 자체는 handler 게이트인 canManagePc 가 여전히 참조하므로 남겨둔다(위 타입 정의 참고).
export function allowedToolsFor(
  role: Role,
  isPrivate: boolean,
  isOwner: boolean,
  deployTarget: "local" | "cloud" = "local",
  workerConnected = false,
): string[] {
  // 원격 도구는 워커 연결이 있을 때만 연다. 판정 축이 "어디서 실행 중인가"(deployTarget)가 아니라
  // "워커가 붙어 있는가"로 바뀐 것이 이 단계의 핵심이다 — cloud 에서도 워커만 붙으면 PC 작업이 된다.
  // 1단계는 소유자 DM 전용으로 좁힌다 — 아래 두 owner-DM 분기 외에는 추가하지 않는다.
  const remote = workerConnected ? REMOTE_TOOL_NAMES.map((n) => t(n)) : [];
  if (isOwner && isPrivate) {
    if (deployTarget === "cloud") {
      return [
        ...remote,
        t("remember"), t("recall"), t("character_fact"), t("manage_access"), t("db_schema"), t("db_query"), t("runtime_info"),
      ];
    }
    return [
      ...remote,
      t("remember"), t("recall"), t("character_fact"), t("manage_access"),
      t("allow_dir"), t("revoke_dir"), t("list_dirs"),
      t("db_schema"), t("db_query"), t("runtime_info"),
    ];
  }
  if (isPrivate && (role === "owner" || role === "allowed")) return [t("remember"), t("recall"), t("character_fact")];
  return [t("recall")];
}

// ── 인프로세스 MCP 서버(SDK) — handler 는 위 순수 함수를 감싼다 ──────────────
const textResult = (text: string) => ({ content: [{ type: "text" as const, text }] });

export function buildTools(ctx: ToolCtx) {
  return createSdkMcpServer({
    name: TOOL_SERVER,
    version: "1.0.0",
    tools: [
      tool(
        "remember",
        "사용자에 대해 오래 기억할 사실·선호·결정·진행 중인 일을 저장합니다. 사소한 것은 저장하지 마세요.",
        { title: z.string().describe("짧은 제목"), content: z.string().describe("기억할 내용") },
        async (args) => textResult(await rememberHandler(ctx, args)),
      ),
      tool(
        "recall",
        "저장된 기억에서 관련 내용을 찾습니다.",
        { query: z.string().describe("찾을 키워드") },
        async (args) => textResult(await recallHandler(ctx, args)),
      ),
      tool(
        "character_fact",
        "대화 중 즉흥으로 지어낸 너 자신의 신상 설정을 확정해 고정합니다. 처음 말한 그 턴에만 저장하세요. 이미 저장된 설정과 충돌하는 내용은 저장하지 마세요.",
        { title: z.string().max(CHARACTER_FACT_TITLE_MAX_LEN).describe("짧은 제목(예: 학년, 동아리부장)"), content: z.string().max(CHARACTER_FACT_MAX_LEN).describe("확정할 설정 내용") },
        async (args) => textResult(await characterFactHandler(ctx, args)),
      ),
      tool(
        "manage_access",
        "(소유자 전용) 사용자의 접근 권한을 설정합니다. 디스코드 숫자 ID 로만. owner 는 부여할 수 없습니다.",
        { userId: z.string().describe("디스코드 숫자 ID"), role: z.enum(["allowed", "blocked"]).describe("부여할 역할(allowed 또는 blocked)") },
        async (args) => textResult(await manageAccessHandler(ctx, args)),
      ),
      tool(
        "allow_dir",
        "(소유자 전용) 원격 개발 작업을 허용할 폴더를 등록합니다. 실제 존재하는 디렉토리여야 합니다.",
        { path: z.string().describe("허용할 폴더의 절대경로") },
        async (args) => textResult(await allowDirHandler(ctx, args)),
      ),
      tool(
        "revoke_dir",
        "(소유자 전용) 등록된 허용 폴더를 해제합니다.",
        { path: z.string().describe("해제할 폴더의 경로") },
        async (args) => textResult(await revokeDirHandler(ctx, args)),
      ),
      tool(
        "list_dirs",
        "(소유자 전용) 현재 허용된 폴더 목록을 보여줍니다.",
        {},
        async () => textResult(await listDirsHandler(ctx)),
      ),
      tool(
        "db_schema",
        "(소유자 전용) 내 데이터베이스의 테이블·컬럼 구조를 보여줍니다.",
        {},
        async () => textResult(await dbSchemaHandler(ctx)),
      ),
      tool(
        "db_query",
        "(소유자 전용) 읽기 전용 SELECT 로 내 데이터를 조회합니다. SELECT 만 가능합니다.",
        { sql: z.string().describe("실행할 읽기 전용 SELECT 문") },
        async (args) => textResult(await dbQueryHandler(ctx, args)),
      ),
      tool(
        "runtime_info",
        "(소유자 전용) 내가 어떤 모델·SDK·배포 설정으로 동작 중인지 보여줍니다.",
        {},
        async () => textResult(await runtimeInfoHandler(ctx)),
      ),
      tool(
        "fs_read",
        "워커 PC 의 파일을 읽습니다. offset(1부터)·limit 로 일부만 읽을 수 있습니다.",
        { path: z.string().describe("읽을 파일의 절대경로"), offset: z.number().optional().describe("시작 줄(1부터)"), limit: z.number().optional().describe("읽을 줄 수") },
        async (args) => textResult(await remoteToolHandler(ctx, "fs_read", args)),
      ),
      tool(
        "fs_write",
        "워커 PC 에 파일을 씁니다. 상위 폴더가 없으면 만듭니다. 기존 파일은 덮어씁니다.",
        { path: z.string().describe("쓸 파일의 절대경로"), content: z.string().describe("파일 전체 내용") },
        async (args) => textResult(await remoteToolHandler(ctx, "fs_write", args)),
      ),
      tool(
        "fs_edit",
        "워커 PC 의 파일에서 문자열을 치환합니다. 여러 번 등장하면 replaceAll 이 필요합니다.",
        { path: z.string().describe("고칠 파일의 절대경로"), oldString: z.string().describe("찾을 문자열"), newString: z.string().describe("바꿀 문자열"), replaceAll: z.boolean().optional().describe("전부 바꿀지 여부") },
        async (args) => textResult(await remoteToolHandler(ctx, "fs_edit", args)),
      ),
      tool(
        "fs_glob",
        "워커 PC 에서 glob 패턴으로 파일을 찾습니다.",
        { pattern: z.string().describe("예: **/*.ts"), path: z.string().optional().describe("기준 폴더의 절대경로") },
        async (args) => textResult(await remoteToolHandler(ctx, "fs_glob", args)),
      ),
      tool(
        "fs_grep",
        "워커 PC 의 파일 내용에서 정규식으로 검색합니다.",
        { pattern: z.string().describe("찾을 정규식"), path: z.string().optional().describe("기준 폴더의 절대경로"), glob: z.string().optional().describe("검색 대상 파일 패턴") },
        async (args) => textResult(await remoteToolHandler(ctx, "fs_grep", args)),
      ),
      tool(
        "sh_exec",
        "워커 PC 에서 셸 명령을 실행합니다. 강력한 도구이니 신중히 쓰세요.",
        { command: z.string().describe("실행할 셸 명령"), timeoutMs: z.number().optional().describe("타임아웃(밀리초)") },
        async (args) => textResult(await remoteToolHandler(ctx, "sh_exec", args)),
      ),
    ],
  });
}
