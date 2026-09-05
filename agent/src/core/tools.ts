import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import type { Role } from "../store/usersRepo.js";
import type { UsersRepo } from "../store/usersRepo.js";
import type { MemoriesRepo, Memory } from "../store/memoriesRepo.js";
import type { AllowedDirsRepo } from "../store/allowedDirsRepo.js";
import type { IntrospectRepo } from "../store/introspectRepo.js";
import type { WorkerKind } from "../store/workersRepo.js";
import { assertReadOnlySql, formatQueryResult } from "./sqlGuard.js";
import { REMOTE_TOOL_NAMES, remoteToolHandler, displayNameOf, noreplyEmailOf } from "./remoteTools.js";
import { isPathWithinAny, normalizeDir } from "./paths.js";
import type { ProjectsRepo, ProjectRow } from "../store/projectsRepo.js";
import type { GithubAppConfig, FetchLike } from "../github/appToken.js";
import { mintInstallationToken, createOrgRepo, createPullRequest } from "../github/appToken.js";
import { listInstallationRepos, formatRepoList } from "../github/repos.js";
import { fetchPrFeedback, formatPrFeedback } from "../github/pulls.js";
import type { ShellTokenSource } from "../github/shellToken.js";
import { normalizeRepoName, decideOwnership, publishSourceDir } from "./publish.js";
import { scopeDirs } from "./workerSelect.js";
import { memoryScopeFor, SHARED_MEMORY_MAX_LEN, SHARED_MEMORY_TITLE_MAX_LEN, renderMemories } from "./memoryScope.js";

// 도구 서버 이름 → 모델에는 mcp__asahi__<tool> 로 노출된다.
export const TOOL_SERVER = "asahi";
const t = (name: string): string => `mcp__${TOOL_SERVER}__${name}`;

// SDK 내장 웹 검색. MCP 도구가 아니라 이름 그대로 allowedTools 에 들어간다.
// WebFetch(임의 URL 페치)는 열지 않는다 — 지금 필요한 건 검색이고 노출 표면이 훨씬 넓다.
const WEB_TOOLS = ["WebSearch"];

// 자기인지(§Task4): 이 봇이 어떤 모델·SDK·배포 설정으로 동작 중인지. runtime_info 도구가 그대로 보고한다.
export type RuntimeInfo = {
  model: string;
  sdkVersion: string;
  deployTarget: "local" | "cloud";
  maxTurns: number;
  // Railway 가 주입하는 git 변수. 로컬 PM2 에는 없으므로 선택적이다 — 없으면 보고하지 않는다.
  botCommit?: string;
  // 그 커밋이 어느 갈래의 것인지(RAILWAY_GIT_BRANCH). 워커 커밋과 나란히 놓였을 때 "왜 다른가"를
  // 한 화면에서 설명하는 값이라, 커밋 옆에 붙여야 의미가 있다 — 없으면 커밋만 보고한다.
  botBranch?: string;
  workers: Array<{ workerId: string; commit?: string; connectedAt: number }>;
};

// 현재 턴의 상대·대화 컨텍스트를 클로저로 받는다. 도구 handler 는 이걸로 스코프를 강제한다.
export type ToolCtx = {
  repos: {
    memories: MemoriesRepo; users: UsersRepo; allowedDirs: AllowedDirsRepo; introspect: IntrospectRepo;
    projects: ProjectsRepo;
  };
  role: Role;
  isPrivate: boolean;
  isOwner: boolean;
  userId: string;
  conversationId: number;
  runtime: RuntimeInfo;
  // 깃허브 발행 설정. null 이면 발행 도구가 애초에 노출되지 않지만(allowedToolsFor 의
  // githubReady), 핸들러도 다시 확인한다 — 노출 판정과 실행 판정이 갈리면 조용히 새는 자리다.
  github: GithubAppConfig | null;
  // 시각 주입. 토큰 발급의 JWT iat/exp 와 projects.last_push_ts 에 쓴다.
  now: () => number;
  // sh_exec 의 git 이 쓸 단기 토큰 공급원(github/shellToken.ts, agent.ts 가 프로세스당 하나 만든다).
  // 깃허브 설정이 없으면 없다 — 그러면 remoteTools.ts 의 shellGitArgs 가 토큰 대신 사유를 실어 보낸다.
  shellTokens?: ShellTokenSource;
  // 깃허브 API 호출에 쓸 fetch. 테스트가 실제 네트워크 없이 토큰 발급·PR 생성 경로를 끝까지 태우기
  // 위한 이음매다 — 없으면 전역 fetch 다(appToken.ts 의 fetchImpl 기본값).
  githubFetch?: FetchLike;
  // 원격 워커 호출 통로. 워커가 연결돼 있을 때만 주입된다(index.ts 배선, agent.ts 의
  // buildRemoteCtx). roots 는 그 워커가 hello 프레임으로 알려온 실제 작업 폴더 목록 —
  // allowDirHandler(아래)가 이 값으로 등록 요청을 재검증한다(FIX2: 봇 프로세스 자신의
  // 파일시스템은 더 이상 참조하지 않는다 — 봇과 워커는 서로 다른 머신일 수 있다).
  remote?: {
    call(tool: string, args: Record<string, unknown>): Promise<{ ok: boolean; content: string }>;
    roots: string[];
    // 이 턴이 쓰는 워커의 id. allowed_dirs 가 워커 기준이 되면서 필요해졌다 —
    // "누가 물어보는가"(ctx.userId)와 "어느 기계인가"(이 값)는 이제 다른 축이다.
    workerId: string;
    // Task 7: 그 워커가 개인(personal, 소유자의 개인 기계)인지 공유(shared, 동아리방 공용 PC 처럼
    // 여러 사람이 함께 쓰는 기계)인지. remoteToolHandler(remoteTools.ts)가 scopeDirs 로 허용
    // 폴더를 사용자별 하위 폴더로 좁힐지 정하는 데 쓴다 — 공유 워커에서만 손님을 좁히고, 개인
    // 워커는 좁히지 않는다(resolveWorkerSelector 규칙상 개인 워커엔 애초에 그 소유자만 붙는다).
    workerKind: WorkerKind;
  };
};

// PC 관리 도구(allow_dir/revoke_dir/list_dirs)를 쓸 수 있는 신원인지: 소유자뿐이다.
// Task 7 이전에는 소유자 DM(ctx.isPrivate && ctx.isOwner)만 통과했다 — 그땐 워커가 곧 소유자의
// 개인 기계였으니 DM 밖에서는 관리할 대상 자체가 없었다. 이제 소유자는 서버 채널에서도 공유
// 기계(동아리 공용 PC)에 연결되고, 그 기계의 관리자 역시 소유자다 — 그래서 isPrivate 조건을
// 뺐다. 손님은 DM 이든 서버든 항상 거부한다: 공유 기계 안에서 자기 하위 폴더를 다루는 것(scopeDirs)
// 과, 그 기계의 허용 폴더 "목록 자체"를 바꾸는 것은 서로 다른 권한이고 후자는 관리자 전용이다.
// FIX6(사소하지만 함정, 최종 리뷰): 예전엔 ctx.ownWorkstation===true(손님이 자기 PC 워커 위에서
// 도는 턴)도 통과시켰다 — 그 값을 채우던 유일한 생산자(worker/jobRunner.ts)는 이미 삭제되어
// 항상 undefined 였던 죽은 분기였고, 그 분기가 전제하던 경로 강제(canUseTool)도 이미 사라진
// 상태라 "혹시라도 이 필드가 다시 채워지면" 손님 DM 이 경로 게이트 없이 폴더 관리 도구를 얻는
// 잠재적 함정이었다(리뷰 지적). 필드 자체(ToolCtx.ownWorkstation)를 삭제해 이 분기가 되살아날
// 여지를 없앴다 — isOwner 하나만 보는 지금도 이 사실은 그대로다.
function canManagePc(ctx: ToolCtx): boolean {
  return ctx.isOwner;
}

// ── 순수 핸들러(테스트 대상) ────────────────────────────────────────────────
export async function rememberHandler(ctx: ToolCtx, args: { title: string; content: string }): Promise<string> {
  // 스코프는 위치가 정한다(memoryScope.ts) — DM 은 개인, 서버 채널은 동아리 공용이다.
  const scope = memoryScopeFor(ctx);
  if (scope === "shared") {
    // 코드포인트로 센다 — length 는 UTF-16 코드유닛이라 이모지가 2로 세어진다.
    // Important 1(최종 전체 브랜치 리뷰) — 예전엔 이 상한 검사가 content 에만 걸려 title 은
    // 무제한이었다(12,000자 제목 저장이 실측으로 성공했다). title 은 recall 뿐 아니라
    // turnPrep 프롬프트에도 매 서버 턴마다 실리므로, content 와 같은 이유로(자르면 사실 손상,
    // 조용히 잘린 제목은 전체인 것처럼 보인다) 자르지 않고 거절한다. title 을 먼저 검사한다 —
    // 둘 다 상한을 넘으면 사용자가 고쳐야 할 것부터 알려주는 편이 낫다.
    const titleLen = [...(args.title ?? "")].length;
    if (titleLen > SHARED_MEMORY_TITLE_MAX_LEN) {
      return `공용 기억 제목은 ${SHARED_MEMORY_TITLE_MAX_LEN}자까지예요. 지금 ${titleLen}자라 저장하지 않았어요 — 제목을 더 짧게 줄여주세요.`;
    }
    const len = [...(args.content ?? "")].length;
    if (len > SHARED_MEMORY_MAX_LEN) {
      // 자르지 않고 거절한다. 조용히 잘린 기억은 사실의 일부만 남아, 아사히가 그 반쪽을
      // 전체인 것처럼 전원에게 말하게 된다.
      return `공용 기억은 ${SHARED_MEMORY_MAX_LEN}자까지예요. 지금 ${len}자라 저장하지 않았어요 — 주제별로 나눠서 저장해 주세요.`;
    }
  }
  await ctx.repos.memories.insert({ userId: ctx.userId, scope, title: args.title, content: args.content, sourceConversationId: ctx.conversationId });
  return scope === "shared" ? `동아리 공용으로 기억했어요: "${args.title}"` : `기억했어요: "${args.title}"`;
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
  // 이름 조회 실패는 대화를 막지 않는다 — 작성자 표시만 생략하고 기억은 그대로 보여준다.
  let names: Record<string, string> = {};
  try {
    names = await ctx.repos.users.displayNames();
  } catch (err) {
    console.error("[recall] 표시 이름 조회 실패 — 작성자 없이 진행:", err);
  }
  return renderMemories(hits, names);
}

// 개행을 공백으로 바꾼다. forget 목록의 제목은 recall 의 작성자 이름(memoryScope.ts 의
// sanitizeAuthorName 이 다루는 것)과 같은 종류의 입력이다 — 그 기억을 쓴 회원이 정하는 임의
// 문자열이다. 이 목록의 안전장치는 "여러 개면 지우지 않고 보여준다"는 것 하나뿐이고, owner 가
// 그걸 신뢰하려면 줄 수가 곧 건수와 같아야 한다 — 제목에 개행이 섞이면 한 건이 두 줄로 보여
// 그 전제가 깨진다. recall 처럼 대괄호로 감싸는 형식이 아니므로 대괄호까지 지울 이유는 없다.
const singleLine = (s: string): string => s.replace(/[\r\n]+/g, " ");

// 공용 기억 삭제. 소유자 전용인 이유: 넣는 것은 보태는 일이고 지우는 것은 다른 사람의 기여를
// 없애는 일이라 같은 권한이 아니다. 공용 기억만 대상이며 남의 개인 기억은 건드리지 않는다.
//
// 여러 개가 걸리면 지우지 않고 목록을 돌려준다 — 무엇을 지웠는지 모르는 삭제가 가장 나쁘다.
//
// Important 2(최종 전체 브랜치 리뷰) — 예전엔 판정이 title.includes(q) 뿐이라, 제목이 완전히
// 같은 두 건은 어떤 질의로도 항상 둘 다 걸려 소유자가 영원히 하나도 못 지웠다. persona.ts 가
// 회비·활동 시간처럼 주제별로 저장하라고 안내하므로, 회비가 바뀌어 누가 "회비"를 다시
// 등록하는 순간이 정확히 이 상태다 — forget 이 존재하는 이유(낡은 공용 기억 정리) 그 자체가
// 막히는 사고다. id(Memory 가 이미 갖는 고유 번호)를 목록에 함께 보여주고, 그 번호로 하나를
// 정확히 지정할 수 있게 한다 — title 검색으로 좁힌 뒤 id 로 확정하는 2단계 흐름이다.
export async function forgetHandler(ctx: ToolCtx, args: { title?: string; id?: number }): Promise<string> {
  if (!ctx.isOwner) return OWNER_ONLY;
  if (args.id !== undefined) {
    const shared = await ctx.repos.memories.sharedOnly();
    const hit = shared.find((m) => m.id === args.id);
    if (!hit) return `번호 ${args.id} 에 해당하는 공용 기억이 없어요.`;
    await ctx.repos.memories.delete(hit.id);
    return `공용 기억을 지웠어요: "${singleLine(hit.title)}"`;
  }
  const q = (args.title ?? "").trim().toLowerCase();
  if (q.length === 0) return "지울 기억의 제목이나 번호(id)를 알려주세요.";
  const shared = await ctx.repos.memories.sharedOnly();
  const hits = shared.filter((m) => m.title.toLowerCase().includes(q));
  if (hits.length === 0) return `"${args.title}" 에 해당하는 공용 기억이 없어요.`;
  if (hits.length > 1) {
    const list = hits.map((m) => `- (번호 ${m.id}) ${singleLine(m.title)}`).join("\n");
    return `여러 개가 걸려서 지우지 않았어요. 번호(id)로 정확히 지정해 주세요:\n${list}`;
  }
  await ctx.repos.memories.delete(hits[0].id);
  return `공용 기억을 지웠어요: "${singleLine(hits[0].title)}"`;
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

// 원격 개발 워크플로우(Phase A): 소유자 DM 전용 게이트(isOwnerDm, db_schema/db_query/runtime_info/
// manage_access 가 쓴다) — 실제 경로 제한(canUseTool)은 별도 태스크(A3)의 몫이다. 이 문구는 문자
// 그대로 "DM 에서만"이 맞다 — 이 셋은 봇 자신에 대한 권한이라 Task 7 이후에도 DM 전용 그대로다.
const OWNER_DM_ONLY = "이 작업은 소유자 DM에서만 할 수 있어요.";

// PC 관리 도구(allow_dir/revoke_dir/list_dirs, canManagePc 가 쓴다) 전용 거부 문구. Task 7 로
// canManagePc 가 isOwner 만 보게 되면서(서버의 소유자도 공유 기계를 관리할 수 있다) "DM 에서만"
// 이라는 문구가 더 이상 맞지 않는다 — 소유자는 서버에서도 이 도구를 쓸 수 있으므로, 그 경우까지
// 포괄하는 "소유자만"으로 표현한다.
const OWNER_ONLY = "이 작업은 소유자만 할 수 있어요.";

// FIX2(치명, 최종 리뷰): 예전엔 fs.statSync/fs.realpathSync 로 이 경로를 "봇 프로세스의"
// 파일시스템에서 검증했다 — 클라우드 배포(Railway 컨테이너)는 물론, 워커가 봇과 다른 머신에서
// 도는 한 local 배포에서도 이 검증은 실제로 아무 의미가 없다(봇과 워커는 서로 다른 파일시스템을
// 본다 — 리뷰 지적: 설령 이 도구가 노출돼 있었더라도, 실제 워커의 경로는 전부 거부됐을
// 것이다). 이제는 그 사용자의 워커가 hello 프레임으로 알려온 실제 작업 폴더(ctx.remote.roots)
// 만을 기준으로 문자열 포함 검사만 한다 — 존재 여부·실경로 확인(심볼릭 링크 등)은 워커 쪽
// (remote/roots.ts 의 checkPath)이 실제 파일 접근 시점에 이미 하고 있다(이중 방어의 두 번째
// 겹 — 위 canManagePc 와 별개로, 이건 "누가"가 아니라 "어디"의 문제다).
export async function allowDirHandler(ctx: ToolCtx, args: { path: string }): Promise<string> {
  if (!canManagePc(ctx)) return OWNER_ONLY;
  // ctx.remote 부재·roots 없음을 하나의 조건으로 합쳐 판정한다(기존과 동일한 거부 조건) —
  // 이렇게 하면 이 줄을 지난 뒤로는 TS 가 ctx.remote 를 항상 정의된 값으로 좁혀 준다(strict
  // null checks). allowed_dirs 는 이제 workerId 로 저장하므로 그 아래에서 ctx.remote.workerId 를
  // 그냥 쓸 수 있어야 한다.
  if (!ctx.remote || ctx.remote.roots.length === 0) return "워커가 연결돼 있지 않거나 워커에 열린 작업 폴더가 없어요.";
  const roots = ctx.remote.roots;
  if (!isPathWithinAny(args.path, roots)) {
    return `워커의 작업 폴더 밖 경로예요. 워커에 열린 폴더: ${roots.join(", ")}`;
  }
  const norm = normalizeDir(args.path);
  // FIX1(치명, 최종 pre-merge 리뷰): 이 아래는 실제 DB 호출이라 reject 할 수 있다 — remoteToolHandler
  // (remoteTools.ts)의 1차 필터는 같은 종류의 호출을 처음부터 try/catch 로 감싸 fail closed 로
  // 처리하는데, 이 세 dir 핸들러만 그 관례를 벗어나 있었다. 감싸지 않으면 드라이버가 던진 원문
  // SQL 오류(예: 컬럼이 없다는 오류)가 그대로 디스코드 채팅으로 노출된다.
  try {
    await ctx.repos.allowedDirs.add(ctx.remote.workerId, norm);
  } catch (e) {
    return `허용 폴더 추가 중 오류가 발생했어요: ${e instanceof Error ? e.message : String(e)}`;
  }
  return `허용 폴더에 추가했어요: ${norm}`;
}

export async function revokeDirHandler(ctx: ToolCtx, args: { path: string }): Promise<string> {
  if (!canManagePc(ctx)) return OWNER_ONLY;
  // allowDirHandler 와 같은 이유의 방어: allowed_dirs 가 workerId 로 저장되므로, 워커가 연결돼
  // 있지 않으면 어느 워커 몫에서 지울지 자체를 알 수 없다(예전엔 ctx.userId 라 항상 값이 있었다).
  if (!ctx.remote) return "워커가 연결돼 있지 않아요.";
  // FIX6(사소, 최종 pre-merge 리뷰): 이 안내 문구는 그동안 args.path 를 이 파일 상단에서 그대로
  // import 한 host-platform path.resolve 로 다시 계산했다 — DELETE 자체는 allowedDirsRepo.remove
  // 내부의 normalizeDir(대상 경로 자신의 플레이버를 따름, paths.ts)로 정규화되는데, 안내 문구만
  // host 플랫폼 기준이었던 셈이다. 리눅스로 배포된 봇이 윈도우 워커 경로를 다루면 삭제 자체는
  // 정확히 성공하고도 "/app/C:\ws\..." 처럼 실제로 지운 값과 다른(그리고 틀린) 경로를 보고했다.
  const norm = normalizeDir(args.path);
  // FIX1(치명, 최종 pre-merge 리뷰) — allowDirHandler 와 같은 이유로 감싼다.
  try {
    await ctx.repos.allowedDirs.remove(ctx.remote.workerId, args.path);
  } catch (e) {
    return `허용 폴더 제거 중 오류가 발생했어요: ${e instanceof Error ? e.message : String(e)}`;
  }
  return `허용 폴더에서 제거했어요: ${norm}`;
}

export async function listDirsHandler(ctx: ToolCtx): Promise<string> {
  if (!canManagePc(ctx)) return OWNER_ONLY;
  // revokeDirHandler 와 같은 이유(위 주석 참고).
  if (!ctx.remote) return "워커가 연결돼 있지 않아요.";
  // FIX1(치명, 최종 pre-merge 리뷰) — allowDirHandler 와 같은 이유로 감싼다. 문구는
  // remoteToolHandler(remoteTools.ts)의 같은 종류 실패와 동일하게 맞춘다.
  let dirs: string[];
  try {
    dirs = await ctx.repos.allowedDirs.list(ctx.remote.workerId);
  } catch (e) {
    return `허용 폴더 확인 중 오류가 발생했어요: ${e instanceof Error ? e.message : String(e)}`;
  }
  if (dirs.length === 0) return "허용된 폴더가 없어요.";
  return dirs.map((d) => `- ${d}`).join("\n");
}

// 자기인지 도구(§Task4) 중 db_schema/db_query 전용: 소유자 DM 에서만.
// 손님·서버는 어느 경우에도 노출·실행 둘 다 거부한다(isOwner && isPrivate 로만 판정).
//
// 2026-08-01: runtime_info 가 이 게이트에서 빠졌다(아래 runtimeInfoHandler 참고). 남은 둘은
// DB 를 직접 읽으므로 공개 채널에서 열 이유가 여전히 없다.
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

// 2026-08-01: 소유자 DM 전용에서 "소유자면 어디서든"으로 풀었다. 이 도구가 보고하는 워커
// 커밋은 곧 "지금 어느 기계가 어느 코드로 도나"인데, 소유자가 공유 미니PC 에 닿는 곳은 서버
// 채널뿐이다(workerSelect.ts — 소유자 DM 은 개인 워커로 간다). 그래서 미니PC 에서 파일·셸
// 작업을 하다 버전을 확인하려면 DM 으로 나가야 했고, 정작 DM 의 답은 다른 기계 얘기였다 —
// 같은 기계를 두고 두 도구가 서로 다른 장소를 요구해 실제로 사람을 오진으로 몰았다.
//
// 함께 묶여 있던 db_schema/db_query 는 그대로 DM 전용이다: 그 둘은 DB 를 직접 읽지만 이
// 도구는 모델명·SDK 버전·커밋·한도만 낸다. 노출(allowedToolsFor)과 실행(이 게이트)이 같은
// 기준(isOwner)을 쓰므로 "도구는 보이는데 실행하면 거부"가 생기지 않는다.
// 2026-09-03: 봇 커밋과 워커 커밋을 SHA 로 대조하던 판정(`봇과 일치` / `봇과 다름 — 워커 갱신
// 필요`)을 걷어냈다. 두 값은 애초에 같은 갈래의 커밋이 아니라, 다르다는 사실만으로는 워커가
// 낡았는지 알 수 없다. 두 가지가 각각 독립적으로 그 등식을 깬다.
//
// (1) 배포 브랜치가 갈렸다. 2026-09-02 부터 운영 반영이 `main → production` PR 병합이라,
//     production 팁은 main 에 존재하지 않는 머지 커밋이다. 봇이 보고하는 RAILWAY_GIT_COMMIT_SHA
//     는 그 머지 커밋이고, 워커는 자기 클론의 main HEAD 를 보고한다(deploy/update-worker.ps1 이
//     origin/main 만 따라간다) — 두 값이 같아질 수 있는 경우가 없다.
// (2) watch path 로 배포된다. asahi 서비스는 `/agent/**` 가 바뀔 때만 재배포되므로, 봇 커밋은
//     "브랜치 팁"이 아니라 "마지막으로 agent/ 를 바꾼 배포 커밋"에 머문다. server/ 만 바뀐 배포가
//     지나갈 때마다 봇 커밋은 그대로고 워커 커밋만 앞으로 간다.
//
// 그래서 2026-09-02 이후로는 워커가 최신이어도 이 도구가 항상 "워커 갱신 필요"를 냈다(실측:
// 봇 47ced9e / 워커 ffa3ed6 — 두 커밋의 agent/ 트리 해시는 같았다). 사람을 매번 미니PC 점검으로
// 몰고, 같은 문구를 몇 번 보면 진짜 갱신 실패도 무시하게 된다. 대조할 수 없는 두 값을 억지로
// 대조하는 대신 사실만 보고하고, 왜 대조하지 않는지 한 줄로 밝힌다 — "워커가 실제로 낡았는가"를
// 판정하려면 커밋 신원이 아니라 돌고 있는 코드를 견주는 다른 장치가 필요하고, 그건 별도 작업이다.
// 워커가 아예 사라지는 쪽은 staleWorker.ts 의 decideMissingAlerts 가 그대로 지킨다.
export async function runtimeInfoHandler(ctx: ToolCtx): Promise<string> {
  if (!ctx.isOwner) return OWNER_ONLY;
  const r = ctx.runtime;
  const short = (sha: string) => sha.slice(0, 7);
  const botLine =
    r.botCommit === undefined
      ? "봇 커밋: 알 수 없음"
      : `봇 커밋: ${short(r.botCommit)}${r.botBranch ? ` (${r.botBranch})` : ""}`;
  const workerLines =
    r.workers.length === 0
      ? ["워커: 붙어 있는 워커가 없어요."]
      : r.workers.map((w) => `워커 ${w.workerId}: 커밋 ${w.commit ? short(w.commit) : "알 수 없음"}`);
  // 안내 줄은 두 커밋이 실제로 한 화면에 같이 놓일 때만 낸다. 오탐 문구를 지우는 것만으로는
  // 부족하다 — 다른 SHA 두 개가 나란히 있고 아무 말도 없으면, 보는 사람이 그 자리에서 스스로
  // 대조하며 같은 오해를 다시 만든다. 반대로 화면에 SHA 가 하나뿐이면 설명할 대상 자체가 없다.
  const bothShown = r.botCommit !== undefined && r.workers.some((w) => w.commit !== undefined);
  const compareNote = bothShown
    ? ["※ 봇은 배포 브랜치의 커밋을, 워커는 자기 클론의 커밋을 보고해요 — 서로 다른 갈래라 대조하지 않아요."]
    : [];
  return [
    `모델(설정): ${r.model}`,
    `SDK: @anthropic-ai/claude-agent-sdk@${r.sdkVersion}`,
    `배포 대상: ${r.deployTarget}`,
    botLine,
    ...workerLines,
    ...compareNote,
    `한 응답 내 도구 반복 상한(maxTurns): ${r.maxTurns}`,
    `한도: 소유자는 무제한, 손님은 시간당 제한(유저별/전역).`,
  ].join("\n");
}

// ── 턴별 도구셋(능력 계층, §7.1) ────────────────────────────────────────────
// Task 7(워커 라우팅) 이후의 계층 요약 — "어디서 말하느냐가 어느 기계냐를 정한다"(workerSelect.ts
// 의 resolveWorkerSelector). 예전엔 원격 도구 자체가 owner-DM 전용이었지만, 이제는 그렇지 않다:
// - 소유자 DM: 기억 전체 + 접근관리 + forget(공용 기억 삭제) + db_schema/db_query/runtime_info
//   (전부 봇 자신에 대한 권한이라 DM 전용을 유지) + 워커(그 소유자의 개인 기계)가 연결돼 있으면
//   원격 파일/셸 도구(fs_*/sh_exec)와 허용폴더 관리 도구(allow_dir/revoke_dir/list_dirs)까지.
// - 소유자(서버 채널): 공유 기계(동아리 공용 PC)의 관리자다. recall + forget(둘 다 소유자만 —
//   forget 은 §Task3, 다른 사람의 기여를 지우는 일이라 공용 기억을 쓸 수 있는 손님과는 다른
//   권한이다) + 워커가 연결돼 있으면 원격 도구와 dir 관리 도구까지 그대로 받는다. DB·접근관리는
//   주지 않는다 — 그건 기계가 아니라 봇 자신에 대한 권한이라 공개 채널에서 열 이유가 없다.
// - 손님(DM·서버 공통): 항상 공유 기계로 연결된다. DM 이면 기억(본인)까지, 아니면 recall(공용)만.
//   워커가 연결돼 있으면 원격 도구도 받는다(remoteToolHandler 의 scopeDirs 가 자기 하위 폴더로
//   좁힌다) — 다만 dir 관리 도구는 절대 받지 않는다. 공유 목록 자체를 바꾸는 건 관리자만 한다.
// SDK 내장 파일/Bash 도구(Read/Write/Edit/Glob/Grep/Bash)는 어느 분기에도 없다 — core/agent.ts 가
// builtinTools=[] 로 그 도구들을 아예 닫아버리므로, 여기 목록에 이름을 남겨봐야 실행할 대상이
// 없는 허수아비 항목이 된다(있지도 않은 능력을 있다고 보고하는 셈). 실제 파일/셸 작업은 워커가
// 연결돼 있을 때만 원격 도구(mcp__asahi__fs_*·sh_exec)로 한다.
// FIX2(치명, 최종 리뷰): dir 관리 도구는 deployTarget 이 아니라 workerConnected(+isOwner, Task 7)
// 로 결정한다 — 예전엔 deployTarget="cloud"(Railway 조각2, 소유자 PC 가 없는 컨테이너 실행)면
// owner-DM 이라도 이 셋을 항상 뺐는데, fs_*/sh_exec 는 이미 workerConnected 기준(cloud 라도
// 워커만 연결되면 열림)이라 "cloud + 워커 연결"에서 fs_read 는 되는데 그 전제조건인 allow_dir
// 자체가 없어 allowed_dirs 를 영원히 못 채우는 모순이 있었다(리뷰 재현). allowDirHandler 자신은
// 실행 시점에 ctx.remote.roots(워커가 hello 로 알려온 실제 폴더)로 재검증한다(봇 프로세스의
// 로컬 파일시스템은 더 이상 보지 않는다).
// FIX6(사소하지만 함정, 최종 리뷰): 이 함수가 예전에 갖고 있던 ownWorkstation 분기(손님이라도
// 자기 PC 전권으로 SDK 내장 파일/Bash 를 여는 경로)는 이미 제거됐고, 그 분기가 참조하던
// ToolCtx.ownWorkstation/TurnContext.ownWorkstation 필드 자체도 완전히 삭제했다 — 생산자 없는
// 죽은 필드를 남겨 두면, 훗날 누군가 실수로(혹은 무심코) 그 필드를 다시 채우는 코드를 추가할 때
// canManagePc 가 경로 강제 없이 손님에게 폴더 관리 도구를 열어주는 잠재적 함정이 있었다.
// Important 4(최종 전체 브랜치 리뷰) — 뒤쪽 인자 묶음. 예전엔 workerConnected·webToolsEnabled
// 가 각각 독립된 위치 인자였다. 셋째(memoryWriteEnabled)가 그 자리에 하나 더 붙으면
// allowedToolsFor("owner", true, true, "local", false, true, false) 처럼 인접한 boolean 이
// 서로 다른 축을 뜻하는, 조용히 틀리기 좋은 호출부가 된다 — 이름 있는 옵션 객체로 묶으면
// typecheck 가 모든 호출부를 강제로 짚어 주므로 기계적이고 안전하다. role·isPrivate·isOwner·
// deployTarget 은 그대로 위치 인자로 둔다 — 이미 안정된 호출 관례이고, deployTarget 은 문자열
// 리터럴 타입이라 boolean 과 섞여도 타입 수준에서 구분된다.
export type AllowedToolsOptions = {
  workerConnected?: boolean;
  // 깃허브 발행 설정(config.github)이 갖춰졌는지. 없으면 도구를 아예 노출하지 않는다 —
  // 노출해 두고 부를 때 실패시키면 모델이 매번 시도했다가 실패를 사용자에게 전달한다.
  githubReady?: boolean;
  webToolsEnabled?: boolean;
  // memories 테이블에 행을 넣거나 지우는 도구(remember·forget) 둘을 한꺼번에 열고 닫는 축.
  // false 여도 recall(읽기)은 이 값과 무관하게 항상 그대로다 — 정기 게시
  // (digest.ts)·요약(core.ts 의 writeSummary)처럼 사람이 안 보는 채로 돌며 신뢰할 수 없는
  // 텍스트(웹 검색 결과·손님이 쓴 대화)를 이어받는 턴이 기억을 바꾸는 것만 막고, 공용 기억은
  // 어차피 전 부원이 읽을 수 있으므로 recall 까지 막을 이유는 없다.
  //
  // Important 2(리뷰 후속): 예전엔 이 축이 remember 만 닫고 forget 은 소유자 분기에서 따로
  // 열려 있었다. 기억을 지우는 것도 기억 쓰기다 — "기억을 쓰면 안 되는 턴"이라고 이름 붙인
  // 축이 삭제 도구를 열어 두면, 이 옵션을 믿고 쓰는 다음 호출부가 조용히 당한다(게다가 오염보다
  // 삭제가 더 되돌리기 어렵다). 두 도구를 한 축에 묶는다 — memories 행을 만들거나 지우는
  // 도구가 새로 생기면 그것도 같은 이유로 여기에 묶는다.
  memoryWriteEnabled?: boolean;
};

export function allowedToolsFor(
  role: Role,
  isPrivate: boolean,
  isOwner: boolean,
  deployTarget: "local" | "cloud" = "local",
  opts: AllowedToolsOptions = {},
): string[] {
  const {
    workerConnected = false,
    githubReady = false,
    // FIX3(중요, 최종 리뷰 3차): 웹 검색도 워커 원격 도구처럼 턴별로 열고 닫을 수 있어야 한다 —
    // 유휴 요약 턴(core.ts 의 summarizeAndClose)은 사람이 지켜보지 않는 타이머로 돌고 이전에
    // 심어졌을 수도 있는 프롬프트 인젝션을 담은 세션을 그대로 이어받는데, 요약은 검색이 필요
    // 없으므로 WebSearch 를 열어 둘 이유가 없다(agent.ts 의 resolveWebToolsEnabled 가 이 값을
    // 계산해 넘긴다). 기본값 true — 일반 대화·정기 게시는 이 옵션을 생략해 기존 동작 그대로다.
    webToolsEnabled = true,
    // 기본값 true — 일반 대화·기존 호출부는 이 옵션을 생략해 remember 가 그대로 열린다.
    memoryWriteEnabled = true,
  } = opts;
  // 원격 도구는 워커 연결이 있을 때만 연다. 판정 축이 "어디서 실행 중인가"(deployTarget)가 아니라
  // "워커가 붙어 있는가"로 바뀐 것이 이 단계의 핵심이다 — cloud 에서도 워커만 붙으면 PC 작업이 된다.
  // Task 7: 원격 도구는 더 이상 소유자 전용이 아니다 — 아래 네 분기(owner-DM/owner-서버/
  // 손님-DM/손님-서버) 모두 workerConnected 만 보고 remote 를 splice 한다. 계층을 가르는 건
  // 그 뒤에 붙는 다른 도구들(기억·DB·접근관리·dir 관리)이다.
  const remote = workerConnected ? REMOTE_TOOL_NAMES.map((n) => t(n)) : [];
  // 최종 리뷰 FIX5(사소) — dirTools 는 아래 owner 두 분기(owner-DM·owner-서버)에만 스플라이스된다
  // (:262-273). 손님이 받는 분기(세 번째·네 번째 return)는 dirTools 자체를 참조하지 않으므로,
  // 이 상수의 조건에 && isOwner 를 넣어도 결과는 절대 달라지지 않았다 — 죽은 조건이었는데, 그
  // 조건이 마치 손님을 막는 관문인 것처럼 comment 가 오해를 유발했다(리뷰 지적: "그 조건이 안
  // 하는 일을 한다고 주장하는 comment 를 남기지 마라"). 손님이 이 셋을 못 받는 진짜 이유는
  // "그 분기가 애초에 안 쓴다"는 구조 자체다 — 실행 시점에는 canManagePc(아래 dir 핸들러들이
  // 다시 확인)가 같은 기준(isOwner)으로 한 번 더 막는다. 공유 기계의 허용 폴더 "목록 자체를
  // 바꾸는" 권한은 관리자(소유자)만 갖는다는 사실 자체는 그대로다.
  // 발행 도구는 워커 연결과 깃허브 설정을 함께 요구한다. workerConnected 를 축으로 쓰는 것이
  // 의미상 정확하다 — 발행은 워커에서 git 을 돌리는 일이라 워커 없이는 할 것이 없다. 그리고 그
  // 덕에 사람이 지켜보지 않는 턴(요약·정기 게시)이 자동으로 닫힌다: 그 둘은 noRemoteTools 로
  // 이 축을 이미 끄고 있다(core.ts 의 summarizeAndClose, digest.ts). 별도 축을 새로 만들면
  // 그 축을 끄는 것을 잊은 새 무인 턴이 생겼을 때 조용히 열린다.
  // create_pull_request 도 같은 축이다(2026-09-05) — 워커 없이는 올릴 브랜치를 만들 방법이 없고, 사람이
  // 지켜보지 않는 턴에서 조직 리포에 PR 이 생기면 안 되는 것도 발행과 같다.
  // list_repos·pr_review_comments(2단계, 같은 날 오후)도 같은 축이다. 둘은 읽기 전용이라 워커가 꼭
  // 필요한 건 아니지만, 표준 절차(persona.ts)의 첫 단계와 리뷰 반영 단계를 받치는 도구라 절차가
  // 열릴 때만 함께 열리는 것이 맞고, 축을 새로 만들면 그 축을 끄는 것을 잊은 무인 턴에서 조직의
  // 비공개 저장소 이름·리뷰 내용이 조용히 열린다 — 위 문단이 발행에 대해 말한 것과 같은 함정이다.
  const publishTools = workerConnected && githubReady
    ? [t("publish_project"), t("restore_project"), t("create_pull_request"), t("list_repos"), t("pr_review_comments")]
    : [];
  const dirTools = workerConnected ? [t("allow_dir"), t("revoke_dir"), t("list_dirs")] : [];
  const webTools = webToolsEnabled ? WEB_TOOLS : [];
  // Important 4 — remember 는 네 분기 모두 이 배열 하나로만 열고 닫는다. memoryWriteEnabled
  // 가 기본값(true)인 한 아래 각 분기의 결과는 예전과 완전히 동일하다(회귀 없음) — false 를
  // 넘기는 호출부(정기 게시·요약 턴)만 remember 를 잃고 recall 은 그대로 유지한다.
  const memoryTools = memoryWriteEnabled ? [t("remember")] : [];
  // Important 2(리뷰 후속) — forget 도 같은 축에 묶는다. 소유자 두 분기에만 들어가므로 배열을
  // 따로 두는 이유는 자리다: remember 와 forget 이 각 분기에서 서로 다른 위치에 놓인다.
  const forgetTools = memoryWriteEnabled ? [t("forget")] : [];
  if (isOwner && isPrivate) {
    return [
      ...remote, ...publishTools,
      ...memoryTools, t("recall"), t("manage_access"), ...forgetTools,
      ...dirTools,
      t("db_schema"), t("db_query"), t("runtime_info"),
      ...webTools,
    ];
  }
  // 소유자가 서버에 있으면 공유 기계 + 관리자 권한(폴더 관리 포함). DB·접근관리는 DM 전용을
  // 유지한다 — 그건 기계가 아니라 봇 자신에 대한 권한이라 공개 채널에서 열 이유가 없다.
  // runtime_info 는 예외로 여기서도 연다(2026-08-01): 소유자가 공유 기계에 닿는 곳이 서버
  // 채널뿐이라, 그 기계의 버전을 물어볼 수 있는 유일한 장소도 여기다.
  // remember 도 마찬가지로 연다(2026-08-02): 서버 채널의 저장은 개인 기억이 아니라 동아리
  // 공용 기억이고(memoryScope.ts), 그것을 만들 수 있는 곳이 여기뿐이다.
  // forget 도 같은 이유로 연다(2026-08-02, Task 3): 부원이 쌓는 공용 기억이 틀리거나 낡으면
  // 정리해야 하는데, 그 정리 대상도 그걸 할 수 있는 소유자도 전부 이 서버 분기에만 있다.
  // 단 remember 와 마찬가지로 memoryWriteEnabled 축이 닫히면 함께 닫힌다(위 forgetTools).
  if (isOwner) return [...remote, ...publishTools, ...memoryTools, t("recall"), ...forgetTools, ...dirTools, t("runtime_info"), ...webTools];
  // 손님: DM 이든 서버든 공유 기계로 간다. 폴더 관리는 주지 않는다.
  if (isPrivate && (role === "owner" || role === "allowed")) {
    return [...remote, ...publishTools, ...memoryTools, t("recall"), ...webTools];
  }
  // Minor(최종 전체 브랜치 리뷰) — 이 마지막 catch-all 은 role 을 보지 않아
  // allowedToolsFor("blocked", ...) 도 remember·recall 을 돌려줬다(실측). 위 손님 DM 분기는
  // role === "owner" || role === "allowed" 를 명시로 확인하는데 이 분기만 안 했다.
  // decideRoute(discord.ts)가 owner/allowed 가 아닌 사용자의 메시지를 이미 걸러내 실제 도달은
  // 없지만, 이 브랜치 전에는 이 계층에 읽기(recall)만 있어 role 오분류가 위험하지 않았다 —
  // 지금은 쓰기(remember)까지 있으므로 이 함수 자신도 role 을 봐야 심층 방어가 유지된다.
  if (!(role === "owner" || role === "allowed")) return [];
  // 손님 서버: 동아리 공용 기억은 누구나 쌓을 수 있다(스펙 §2.1). 개인 기억 저장은 DM 에서만
  // 되므로 여기서 remember 를 부르면 반드시 공용이 된다.
  // 발행도 여기서 연다 — 부원이 만든 것을 올리는 것이 이 기능의 목적이고, 손님은 어차피 자기
  // 폴더·자기 리포에만 닿는다(publish.ts 의 decideOwnership, workerSelect.ts 의 scopeDirs).
  return [...remote, ...publishTools, ...memoryTools, t("recall"), ...webTools];
}

// ── 인프로세스 MCP 서버(SDK) — handler 는 위 순수 함수를 감싼다 ──────────────
// isError 는 실패일 때만 싣는다. MCP 는 이 필드가 없으면 성공으로 보므로, 인자를 생략하는
// 기존 핸들러(비원격)는 예전과 완전히 같은 결과를 낸다 — 이 태스크가 고치는 건 원격 도구의
// 성패 전달 하나뿐이다. 실패일 때 이 필드가 서야만 SDK 가 tool_result 블록에 is_error:true 를
// 실어 주고, 그래야 progressFromMessage 의 ok 가 false 가 되어 표시(✗)와 기록(status='error')
// 양쪽에 도달한다(agent.ts 의 `block.is_error !== true` 참고).
const textResult = (text: string, isError = false) => ({
  content: [{ type: "text" as const, text }],
  ...(isError ? { isError: true } : {}),
});

// 원격 도구 11개의 공통 배선. remoteToolHandler 가 돌려주는 { content, ok } 의 ok 를 그대로
// isError 로 뒤집어 싣는다 — 이 한 줄이 "워커가 계산한 성패"와 "모델·표시·기록이 보는 성패"를
// 잇는 이음매다(예전엔 여기서 문자열만 받아 ok 가 버려졌다).
const remoteResult = async (ctx: ToolCtx, tool: string, args: Record<string, unknown>) => {
  const r = await remoteToolHandler(ctx, tool, args);
  return textResult(r.content, !r.ok);
};


// ── 깃허브 발행 ──────────────────────────────────────────────────────────────
// 이름 하나로 "무엇을·어디서·어디로" 를 전부 결정한다. 모델이 준 값이 그대로 경로나 리포로
// 쓰이는 자리는 이 함수 안에 없다 — 이름은 normalizeRepoName 을 통과해야만 살아남고, 경로는
// 그 사람의 작업 폴더에서 계산되며, 대상 리포는 projects 표가 정한다(설계 §5·§6).
type Target =
  | { ok: false; content: string }
  | { ok: true; repoName: string; dir: string; existing: ProjectRow | null };

async function resolveTarget(ctx: ToolCtx, rawName: string): Promise<Target> {
  const remote = ctx.remote;
  if (!remote) return { ok: false, content: "지금은 워커가 연결돼 있지 않아 할 수 없어요." };
  if (!ctx.github) return { ok: false, content: "깃허브 발행이 아직 설정되지 않았어요. 관리자에게 알려주세요." };

  const repoName = normalizeRepoName(rawName);
  if (repoName === null) {
    return { ok: false, content: "프로젝트 이름은 영문·숫자·하이픈·밑줄만 쓸 수 있어요(100자 이내)." };
  }

  // 작업 폴더는 remoteToolHandler 와 **같은 방식**으로 구한다 — 두 경로가 서로 다른 기준으로
  // 폴더를 정하면, 파일 도구로는 못 건드리는 곳을 발행으로는 건드릴 수 있게 된다.
  let dirs: string[];
  try {
    const listed = await ctx.repos.allowedDirs.list(remote.workerId);
    dirs = scopeDirs(listed, { workerKind: remote.workerKind, isOwner: ctx.isOwner, userId: ctx.userId });
  } catch (e) {
    return { ok: false, content: `허용 폴더 확인 중 오류가 발생했어요: ${e instanceof Error ? e.message : String(e)}` };
  }
  const workspaceDir = dirs[0];
  if (!workspaceDir) return { ok: false, content: "작업 폴더가 없어요. 먼저 폴더를 등록해 달라고 관리자에게 요청해 주세요." };

  const existing = await ctx.repos.projects.byRepoName(repoName);
  const decision = decideOwnership({ repoName, requesterUserId: ctx.userId, existing });
  if (!decision.ok) return { ok: false, content: decision.reason };

  return { ok: true, repoName, dir: publishSourceDir({ workspaceDir, repoName }), existing };
}

// 커밋 author 에 쓸 이름은 remoteTools.ts 의 displayNameOf 가 정한다(sh_exec 의 커밋 신원과 같은
// 규칙 — 조회 실패·빈 이름이면 userId 로 폴백).
function cloneUrlFor(org: string, repoName: string): string {
  return `https://github.com/${org}/${repoName}.git`;
}

export async function publishHandler(ctx: ToolCtx, args: { name: string; message?: string }): Promise<{ ok: boolean; content: string }> {
  const t = await resolveTarget(ctx, args.name);
  if (!t.ok) return { ok: false, content: t.content };
  const github = ctx.github!;

  // 폴더가 없으면 **토큰을 발급하기도 전에** 멈춘다. 순서가 중요하다 — 뒤에 두면 폴더가 없는데도
  // 빈 깃허브 리포가 먼저 만들어지고 그 이름이 projects 표에 박힌다(테스트가 이 순서를 잡았다).
  // 그냥 넘기면 워커에서 `git -C <없는 폴더> init` 이 실패해 영문 git 오류가 그대로 올라오고
  // 사용자는 "왜 안 되는지" 를 모른다. 실제로 잘 나는 상황이라 문구를 따로 둔다 — 모델이
  // 프로젝트 폴더를 안 만들고 작업 폴더에 파일을 흩어 놓은 경우다(예방은 PUBLISH_LINES 의 몫).
  const there = await ctx.remote!.call("fs_tree", { path: t.dir, depth: 1 });
  if (!there.ok) {
    return {
      ok: false,
      content: `「${t.repoName}」 폴더를 찾지 못했어요. 발행은 작업 폴더 바로 밑의 프로젝트 폴더 하나를 올립니다 — 그 이름으로 폴더를 먼저 만들고 그 안에 파일을 두세요.`,
    };
  }

  if (t.existing === null) {
    // 리포 생성에만 administration 을 쓰고, 실제 푸시 토큰은 아래에서 contents 로만 새로
    // 발급한다 — 권한이 넓은 토큰이 워커까지 가지 않게 한다.
    try {
      const admin = await mintInstallationToken({
        config: github, repoNames: [], permissions: { administration: "write" }, nowMs: ctx.now(),
      });
      await createOrgRepo({ config: github, token: admin.token, repoName: t.repoName });
    } catch (err) {
      return { ok: false, content: err instanceof Error ? err.message : String(err) };
    }
    // 리포를 실제로 만든 뒤에 등록한다 — 만들기가 실패했는데 표에 남으면 그 이름이 영원히 막힌다.
    await ctx.repos.projects.claim({ repoName: t.repoName, ownerUserId: ctx.userId, ts: ctx.now() });
  }

  let token: string;
  try {
    token = (await mintInstallationToken({
      config: github, repoNames: [t.repoName], permissions: { contents: "write" }, nowMs: ctx.now(),
    })).token;
  } catch (err) {
    return { ok: false, content: err instanceof Error ? err.message : String(err) };
  }

  const r = await ctx.remote!.call("git_publish", {
    dir: t.dir,
    cloneUrl: cloneUrlFor(github.org, t.repoName),
    token,
    message: args.message ?? "아사히를 통해 발행",
    authorName: await displayNameOf(ctx),
    authorEmail: noreplyEmailOf(ctx.userId),
  });

  if (!r.ok) return r;
  await ctx.repos.projects.touchPush(t.repoName, ctx.now());
  // 주소는 성공했을 때만 알린다 — 실패했는데 링크를 주면 없는 것을 열게 된다.
  return { ok: true, content: `올렸어요: https://github.com/${github.org}/${t.repoName}` };
}

export async function restoreHandler(ctx: ToolCtx, args: { name: string; discard_local?: boolean }): Promise<{ ok: boolean; content: string }> {
  const t = await resolveTarget(ctx, args.name);
  if (!t.ok) return { ok: false, content: t.content };
  const github = ctx.github!;

  // 발행한 적 없는 이름은 되받을 것이 없다. 없는 리포로 clone 을 시도하면 깃허브가 인증
  // 오류를 내는데, 그 메시지는 사용자에게 "권한 문제" 로 읽혀 엉뚱한 곳을 보게 한다.
  if (t.existing === null) {
    return { ok: false, content: `「${t.repoName}」 은 아직 깃허브에 올린 적이 없어요. 먼저 발행해 주세요.` };
  }

  let token: string;
  try {
    token = (await mintInstallationToken({
      config: github, repoNames: [t.repoName], permissions: { contents: "write" }, nowMs: ctx.now(),
    })).token;
  } catch (err) {
    return { ok: false, content: err instanceof Error ? err.message : String(err) };
  }

  return ctx.remote!.call("git_restore", {
    dir: t.dir,
    cloneUrl: cloneUrlFor(github.org, t.repoName),
    token,
    discardLocal: args.discard_local === true,
  });
}

// ── PR 생성(2026-09-05) ──────────────────────────────────────────────────────
// 부원이 sh_exec 의 git 으로 브랜치를 올린 뒤 main 에 PR 을 내는 마지막 조각. 리포·브랜치 이름은
// 깃허브 API 경로와 JSON 본문으로만 나간다(워커 파일시스템에 닿지 않는다). 그래도 경로 구분자·상위
// 이동·공백을 거절하는 이유는 publish.ts 의 normalizeRepoName 과 같다 — 고쳐 쓰면 무엇으로 고쳐졌는지
// 사람도 모델도 모른다. 기존 리포 이름에는 점이 들어갈 수 있어(예: x.y) 점만은 허용한다.
const PR_REPO_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
// git check-ref-format 의 규칙 중 이 자리에서 실제로 걸리는 것만: 공백·제어문자 없음, "-" 로 시작 안
// 함, ".." 없음, 슬래시로 나뉜 조각이 비지 않음.
const PR_BRANCH_PATTERN = /^[A-Za-z0-9_][A-Za-z0-9._-]*(\/[A-Za-z0-9_][A-Za-z0-9._-]*)*$/;
const PR_BRANCH_MAX_LEN = 200;
const PR_TITLE_MAX_LEN = 200;

function validRepoName(s: string): boolean {
  return PR_REPO_PATTERN.test(s) && !s.includes("..");
}
function validBranchName(s: string): boolean {
  return s.length <= PR_BRANCH_MAX_LEN && PR_BRANCH_PATTERN.test(s) && !s.includes("..");
}

export async function createPullRequestHandler(
  ctx: ToolCtx,
  args: { repo: string; head: string; base?: string; title: string; body?: string },
): Promise<{ ok: boolean; content: string }> {
  // 워커 연결 + 깃허브 설정은 노출 조건(allowedToolsFor 의 publishTools)과 같다 — 여기서 다시 확인하는
  // 이유는 resolveTarget 과 같다(노출 판정과 실행 판정이 갈리면 조용히 새는 자리다).
  if (!ctx.remote) return { ok: false, content: "지금은 워커가 연결돼 있지 않아 할 수 없어요." };
  const github = ctx.github;
  if (!github) return { ok: false, content: "깃허브 발행이 아직 설정되지 않았어요. 관리자에게 알려주세요." };

  const repo = (args.repo ?? "").trim();
  const head = (args.head ?? "").trim();
  const base = (args.base ?? "main").trim();
  const title = (args.title ?? "").trim();
  if (!validRepoName(repo)) {
    return { ok: false, content: "저장소 이름은 조직 안의 리포 이름 하나여야 해요(영문·숫자·점·하이픈·밑줄 — 조직 이름이나 주소는 빼고)." };
  }
  if (!validBranchName(head) || !validBranchName(base)) {
    return { ok: false, content: "브랜치 이름에 공백이나 '..' 이 들어 있거나 형식이 맞지 않아요." };
  }
  if (head === base) return { ok: false, content: "head 와 base 가 같은 브랜치예요. 작업 브랜치를 head 로, 받을 브랜치를 base 로 주세요." };
  if (title.length === 0 || title.length > PR_TITLE_MAX_LEN) return { ok: false, content: `PR 제목은 1~${PR_TITLE_MAX_LEN}자여야 해요.` };
  // production 은 실서비스 배포 브랜치다 — 거기로 가는 PR 은 운영자가 main 에서 직접 낸다(AGENTS.md).
  // 소유자 우회를 여기 하나 두는 이유: 그 PR 을 디스코드로 내는 사람은 운영자뿐이고, 그것을 막으면
  // 운영자는 깃허브 웹으로 가야 한다. 병합은 어느 쪽이든 이 도구가 하지 않는다.
  if (base === "production" && !ctx.isOwner) {
    return { ok: false, content: "production 브랜치로 가는 PR 은 운영자만 만들 수 있어요. main 으로 PR 을 내 주세요." };
  }

  // 토큰은 그 리포 하나·pull_requests:write 로만 발급한다 — sh_exec 의 조직 전체 토큰과 달리 대상이
  // 정해져 있으므로 좁힐 수 있고, 좁힐 수 있으면 좁힌다(발행 설계 §3).
  let token: string;
  try {
    token = (await mintInstallationToken({
      config: github, repoNames: [repo], permissions: { pull_requests: "write" }, nowMs: ctx.now(), fetchImpl: ctx.githubFetch,
    })).token;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // 깃허브는 App 에 없는 권한을 요청하면 발급 자체를 거절한다 — 그 문구("permissions requested are not
    // granted")만으로는 어디를 고쳐야 하는지 알 수 없다. 2026-09-05 기준 asahi-publisher App 에는 이
    // 권한이 없으므로 셋업 문서로 안내한다.
    const hint = /permission/i.test(msg)
      ? " 깃허브 App(asahi-publisher)에 Pull requests: Read and write 권한을 추가하고 조직 설치에서 승인해야 해요 — deploy/github-app-셋업.md 참고."
      : "";
    return { ok: false, content: msg + hint };
  }

  // PR 의 깃허브 작성자는 App 이라 그것만으로는 누가 냈는지 안 보인다 — 본문 끝에 요청자를 남긴다.
  const requester = await displayNameOf(ctx);
  const body = `${(args.body ?? "").trim()}\n\n---\n아사히를 통해 ${requester} 님이 요청한 PR 입니다.`.trim();
  try {
    const pr = await createPullRequest({ config: github, token, repoName: repo, head, base, title, body, fetchImpl: ctx.githubFetch });
    return { ok: true, content: `PR 을 만들었어요: ${pr.url}` };
  } catch (err) {
    return { ok: false, content: err instanceof Error ? err.message : String(err) };
  }
}

// ── 2단계(2026-09-05 오후): 표준 절차를 받치는 읽기 도구 둘 ──────────────────────
// 운영자가 실환경에서 clone → 브랜치 → 커밋 → push → main PR 흐름을 확인한 뒤, 그 절차를 봇이 기본으로
// 따르게 했다(persona.ts 의 PUBLISH_LINES). 절차의 첫 단계("저장소 이름을 확인한다")와 마지막 뒤의
// 되돌아오는 단계("리뷰를 반영한다")에 도구가 없어 각각 하나씩 더한다. 둘 다 읽기만 하고, 노출
// 조건(allowedToolsFor 의 publishTools)과 같은 확인을 여기서 되풀이한다 — 노출 판정과 실행 판정이
// 갈리면 조용히 새는 자리다(resolveTarget·createPullRequestHandler 와 같은 이유).
function githubReadGate(ctx: ToolCtx): { ok: false; content: string } | { ok: true; github: GithubAppConfig } {
  if (!ctx.remote) return { ok: false, content: "지금은 워커가 연결돼 있지 않아 할 수 없어요." };
  if (!ctx.github) return { ok: false, content: "깃허브 발행이 아직 설정되지 않았어요. 관리자에게 알려주세요." };
  return { ok: true, github: ctx.github };
}

export async function listReposHandler(ctx: ToolCtx): Promise<{ ok: boolean; content: string }> {
  const gate = githubReadGate(ctx);
  if (!gate.ok) return gate;
  // 목록에는 이름·설명·기본 브랜치·공개 여부만 필요하다 — metadata 읽기가 그 최소 권한이다. 범위는
  // 설치 전체: 어느 리포를 볼지 미리 알 수 없어 좁힐 축이 없다(셸 토큰이 조직 전체인 것과 같은 이유,
  // github/shellToken.ts). 셸 토큰과 달리 쓰기 권한이 전혀 없어, 이 토큰이 새도 이름을 보는 것
  // 이상은 못 한다 — 그리고 워커로 가지도 않는다(봇 안에서만 쓰고 버린다).
  let token: string;
  try {
    token = (await mintInstallationToken({
      config: gate.github, repoNames: [], permissions: { metadata: "read" }, nowMs: ctx.now(), fetchImpl: ctx.githubFetch,
    })).token;
  } catch (err) {
    return { ok: false, content: err instanceof Error ? err.message : String(err) };
  }
  try {
    return { ok: true, content: formatRepoList(await listInstallationRepos({ token, fetchImpl: ctx.githubFetch })) };
  } catch (err) {
    return { ok: false, content: err instanceof Error ? err.message : String(err) };
  }
}

export async function prReviewCommentsHandler(
  ctx: ToolCtx,
  args: { repo: string; number: number },
): Promise<{ ok: boolean; content: string }> {
  const gate = githubReadGate(ctx);
  if (!gate.ok) return gate;
  const repo = (args.repo ?? "").trim();
  if (!validRepoName(repo)) {
    return { ok: false, content: "저장소 이름은 조직 안의 리포 이름 하나여야 해요(영문·숫자·점·하이픈·밑줄 — 조직 이름이나 주소는 빼고)." };
  }
  const number = args.number;
  if (!Number.isInteger(number) || number <= 0) return { ok: false, content: "PR 번호는 1 이상의 정수여야 해요." };

  // 대상 리포가 정해져 있으니 그 리포 하나·pull_requests 읽기로만 발급한다 — 좁힐 수 있으면 좁힌다
  // (발행 설계 §3). 읽기만 하는 도구라 write 를 요청할 이유도 없다.
  let token: string;
  try {
    token = (await mintInstallationToken({
      config: gate.github, repoNames: [repo], permissions: { pull_requests: "read" }, nowMs: ctx.now(), fetchImpl: ctx.githubFetch,
    })).token;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const hint = /permission/i.test(msg)
      ? " 깃허브 App(asahi-publisher)에 Pull requests 권한이 있어야 해요 — deploy/github-app-셋업.md 참고."
      : "";
    return { ok: false, content: msg + hint };
  }
  try {
    const feedback = await fetchPrFeedback({ org: gate.github.org, repo, number, token, fetchImpl: ctx.githubFetch });
    return { ok: true, content: formatPrFeedback(feedback) };
  } catch (err) {
    return { ok: false, content: err instanceof Error ? err.message : String(err) };
  }
}

// 도구 선언 목록을 buildTools 에서 분리해 내보낸다. 이 배열 자체가 "핸들러의 반환을 MCP 결과로
// 바꾸는" 이음매(seam)인데, createSdkMcpServer 안에 인라인으로 묻혀 있으면 그 변환을 테스트가
// 직접 실행할 방법이 없다 — 지금까지 성패 전달이 이 지점에서 끊긴 채로 여러 번의 리뷰를 통과한
// 이유가 정확히 그것이다(모든 테스트가 ProgressUpdate 를 손으로 지어내 이 변환을 건너뛰었다).
// 이제 tests 가 이 함수로 실제 선언을 받아 handler 를 그대로 호출할 수 있다.
export function buildToolDefinitions(ctx: ToolCtx) {
  return [
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
      "forget",
      "(소유자 전용) 동아리 공용 기억을 제목으로 찾아 지웁니다. 여러 개가 걸리면 지우지 않고 번호(id) 목록을 보여줍니다 — 그 번호를 id 인자로 다시 불러 하나만 정확히 지정해 지울 수 있습니다.",
      {
        title: z.string().optional().describe("지울 공용 기억의 제목(일부만 적어도 됩니다)"),
        id: z.number().optional().describe("여러 개가 걸렸을 때 그 목록에서 본 번호로 하나를 정확히 지정합니다"),
      },
      async (args) => textResult(await forgetHandler(ctx, args)),
    ),
    tool(
      "publish_project",
      "만든 프로젝트를 동아리 깃허브에 올립니다. 프로젝트 이름만 주세요 — 어느 폴더를 올릴지, 어느 리포에 올릴지는 시스템이 정합니다.",
      {
        name: z.string().describe("프로젝트 이름(영문·숫자·하이픈·밑줄)"),
        message: z.string().optional().describe("커밋 메시지"),
      },
      async (args) => { const r = await publishHandler(ctx, args); return textResult(r.content, !r.ok); },
    ),
    tool(
      "restore_project",
      "깃허브에서 프로젝트를 되받아 옵니다. 로컬이 없으면 받아오고, 최신이 아니면 갱신합니다. 저장하지 않은 변경이 있으면 거절합니다 — discard_local 은 사용자가 '버리고 새로 받아줘'라고 명시적으로 말했을 때만 켜세요.",
      {
        name: z.string().describe("프로젝트 이름"),
        discard_local: z.boolean().optional().describe("로컬을 버리고 새로 받을지(사용자가 명시적으로 요청했을 때만)"),
      },
      async (args) => { const r = await restoreHandler(ctx, args); return textResult(r.content, !r.ok); },
    ),
    tool(
      "create_pull_request",
      "동아리 깃허브 저장소에 풀 리퀘스트(PR)를 만듭니다. 먼저 sh_exec 의 git 으로 작업 브랜치를 push 해 두어야 합니다. base 는 기본 main 이고, production 은 운영자만 지정할 수 있습니다. 병합은 하지 않습니다 — 운영자가 합니다.",
      {
        repo: z.string().describe("조직 안의 저장소 이름(예: homepage). 조직 이름·주소는 빼세요"),
        head: z.string().describe("push 해 둔 작업 브랜치 이름"),
        base: z.string().optional().describe("받을 브랜치(기본 main)"),
        title: z.string().describe("PR 제목"),
        body: z.string().optional().describe("PR 설명(무엇을 왜 바꿨는지)"),
      },
      async (args) => { const r = await createPullRequestHandler(ctx, args); return textResult(r.content, !r.ok); },
    ),
    tool(
      "list_repos",
      "동아리 깃허브 조직(semicollon-club)의 저장소 목록을 보여줍니다 — 이름·설명·기본 브랜치·공개 여부. 사용자가 '저장소 뭐 있어?' 라고 묻거나 clone·PR 대상 이름이 불확실할 때 기억으로 답하지 말고 이 도구를 부르세요.",
      {},
      async () => { const r = await listReposHandler(ctx); return textResult(r.content, !r.ok); },
    ),
    tool(
      "pr_review_comments",
      "동아리 저장소 PR 에 달린 리뷰·코드 코멘트·대화 코멘트를 시간순으로 읽습니다. 리뷰를 반영하라는 요청을 받으면 먼저 이걸로 내용을 읽고, 같은 작업 브랜치에서 고쳐 새 커밋으로 push 하세요.",
      {
        repo: z.string().describe("조직 안의 저장소 이름(예: homepage). 조직 이름·주소는 빼세요"),
        number: z.number().int().positive().describe("PR 번호"),
      },
      async (args) => { const r = await prReviewCommentsHandler(ctx, args); return textResult(r.content, !r.ok); },
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
      "(소유자 전용) 내가 어떤 모델·SDK·배포 설정으로 동작 중인지, 그리고 지금 연결된 워커가 어느 커밋으로 도는지 보여줍니다.",
      {},
      async () => textResult(await runtimeInfoHandler(ctx)),
    ),
    tool(
      "fs_read",
      "워커 PC 의 파일을 읽습니다. offset(1부터)·limit 로 일부만 읽을 수 있습니다.",
      { path: z.string().describe("읽을 파일의 절대경로"), offset: z.number().optional().describe("시작 줄(1부터)"), limit: z.number().optional().describe("읽을 줄 수") },
      async (args) => remoteResult(ctx, "fs_read", args),
    ),
    tool(
      "fs_write",
      "워커 PC 에 파일을 씁니다. 상위 폴더가 없으면 만듭니다. 기존 파일은 덮어씁니다.",
      { path: z.string().describe("쓸 파일의 절대경로"), content: z.string().describe("파일 전체 내용") },
      async (args) => remoteResult(ctx, "fs_write", args),
    ),
    tool(
      "fs_edit",
      "워커 PC 의 파일에서 문자열을 치환합니다. 여러 번 등장하면 replaceAll 이 필요합니다.",
      { path: z.string().describe("고칠 파일의 절대경로"), oldString: z.string().describe("찾을 문자열"), newString: z.string().describe("바꿀 문자열"), replaceAll: z.boolean().optional().describe("전부 바꿀지 여부") },
      async (args) => remoteResult(ctx, "fs_edit", args),
    ),
    tool(
      "fs_glob",
      "워커 PC 에서 glob 패턴으로 파일을 찾습니다.",
      { pattern: z.string().describe("예: **/*.ts"), path: z.string().optional().describe("기준 폴더의 절대경로") },
      async (args) => remoteResult(ctx, "fs_glob", args),
    ),
    tool(
      "fs_grep",
      "워커 PC 의 파일 내용에서 정규식으로 검색합니다.",
      { pattern: z.string().describe("찾을 정규식"), path: z.string().optional().describe("기준 폴더의 절대경로"), glob: z.string().optional().describe("검색 대상 파일 패턴") },
      async (args) => remoteResult(ctx, "fs_grep", args),
    ),
    tool(
      "fs_tree",
      "작업 폴더의 파일·폴더 구조를 보여줍니다. 사용자가 '내 폴더에 뭐 있어?' 처럼 물으면 기억으로 답하지 말고 이 도구를 부르세요.",
      // depth 는 min(0) 으로 음수를 1차 방어한다 — 실제 하한 강제는 executors.ts 의 fs_tree 가
      // 스키마와 무관하게(모델이 이걸 우회해도) 한 번 더 한다(스키마만 믿지 않는다).
      { path: z.string().optional().describe("조회할 폴더의 절대경로. 생략하면 허용된 첫 폴더"), depth: z.number().min(0).optional().describe("내려갈 깊이(기본 3, 최대 5)") },
      async (args) => remoteResult(ctx, "fs_tree", args),
    ),
    tool(
      "sh_exec",
      "워커 PC 에서 셸 명령을 실행합니다. 명령이 끝날 때까지 기다렸다가 출력을 돌려주므로, 개발서버처럼 계속 도는 명령에는 쓰지 마세요 — 그건 proc_start 입니다. 강력한 도구이니 신중히 쓰세요.",
      { command: z.string().describe("실행할 셸 명령"), timeoutMs: z.number().optional().describe("타임아웃(밀리초)") },
      async (args) => remoteResult(ctx, "sh_exec", args),
    ),
    // proc_* 넷의 스키마에 name·cwd 가 없거나 "(소유자 전용)"으로만 있는 것은 실수가 아니다 —
    // 이 값들은 모델이 정하지 않고 remoteToolHandler 가 주입한다(거기 주석 참고). 스키마에 열어
    // 두면 모델이 남의 프로세스 이름을 만들어 낼 수 있고, 그러면 핸들러의 주입이 "모델이 준 값을
    // 덮어쓰는" 일이 되어 도구 설명과 실제 동작이 어긋난다.
    // path 는 name·cwd 와 다르다 — 모델이 정해도 된다. 대부분의 프로젝트는 회원 폴더 루트가 아니라
    // 그 아래 하위 폴더(예: "…\<id>\테스트 1\")에 있으므로, 모델이 실제 프로젝트 위치를 알려줄 수
    // 있어야 한다(운영 중 발견: path 가 없어 루트로 고정되던 시절엔 package.json 을 못 찾고 npm run
    // dev 가 항상 실패했다). remoteToolHandler 의 기존 경로 게이트(pathArgOf → needsPathCheck)가
    // 이 값을 allowed_dirs 로 그대로 검사하고, 검사를 통과한 값 그대로 cwd 로 주입한다(FIX1) —
    // name·cwd 처럼 봇이 값 자체를 정하는 게 아니라 모델이 제안한 값을 "검증"만 한다는 점이 다르다.
    tool(
      "proc_start",
      "개발서버처럼 오래 도는 프로세스를 띄웁니다. 한 사람당 하나만 띄울 수 있습니다.",
      {
        command: z.string().describe("실행할 명령. 예: npm run dev"),
        path: z.string().optional().describe("npm run dev 등을 실행할 프로젝트 폴더의 절대경로(package.json 이 있는 폴더 등). 생략하면 허용된 폴더 중 첫 번째를 써요."),
      },
      async (args) => remoteResult(ctx, "proc_start", args),
    ),
    tool(
      "proc_stop",
      "돌고 있는 프로세스를 멈춥니다.",
      { name: z.string().optional().describe("(소유자 전용) 멈출 프로세스 이름. 생략하면 본인 것") },
      async (args) => remoteResult(ctx, "proc_stop", args),
    ),
    tool(
      "proc_list",
      "지금 돌고 있는 프로세스를 보여줍니다. 무엇이 도는지 기억으로 답하지 말고 이 도구를 부르세요.",
      {},
      async (args) => remoteResult(ctx, "proc_list", args),
    ),
    tool(
      "proc_logs",
      "돌고 있는 프로세스의 최근 로그를 봅니다.",
      {
        lines: z.number().min(1).optional().describe("가져올 줄 수(기본 50, 최대 200)"),
        name: z.string().optional().describe("(소유자 전용) 대상 프로세스 이름. 생략하면 본인 것"),
      },
      async (args) => remoteResult(ctx, "proc_logs", args),
    ),
];
}

// allowed 는 allowedToolsFor 의 결과다(mcp__asahi__ 접두사가 붙은 전체 이름 + WebSearch·Skill
// 같은 비-MCP 항목). 여기서는 이 서버가 등록할 MCP 도구만 걸러 쓴다.
//
// 2026-08-06: 예전에는 전부 등록하고 allowedTools 로만 걸렀다. 그래서 모델이 쓸 수 없는 도구를
// 보고, 부르고, SDK 가 만든 영문 거부("...but you haven't granted it yet")를 받았다. 그 문자열엔
// 이유가 없어서 모델이 그럴듯한 이유를 지어냈다 — 실제로 "이 채널에서는 안 된다"는 없는 규칙을
// 만들어 소유자에게까지 반복했다. 안 보여주면 그 경로 자체가 없다.
//
// 서버 생성과 분리해 둔 이유는 테스트다. createSdkMcpServer 반환값 내부 모양에 기대는 테스트는
// SDK 버전이 오를 때 조용히 깨진다 — 선언 배열은 이 저장소가 이미 쓰는 모양이다(:1033).
export function allowedToolDefinitions(ctx: ToolCtx, allowed: string[]) {
  const allowedSet = new Set(allowed);
  return buildToolDefinitions(ctx).filter((def) => allowedSet.has(t(def.name)));
}

export function buildTools(ctx: ToolCtx, allowed: string[]) {
  return createSdkMcpServer({
    name: TOOL_SERVER,
    version: "1.0.0",
    tools: allowedToolDefinitions(ctx, allowed),
  });
}
