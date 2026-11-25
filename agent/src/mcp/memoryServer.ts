import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { MemoriesRepo } from "../store/memoriesRepo.js";
import type { UsersRepo } from "../store/usersRepo.js";
import type { JobTokenClaims } from "../core/jobToken.js";
import { rememberHandler, recallHandler, forgetHandler, MEMORY_TOOL_SPECS, type MemoryToolCtx } from "../core/tools.js";

// 허브 기억 MCP 서버(2026-11-25, 기억 정비 3-1). 봇(계정 A)에서 도는 MCP 서버로, 하네스 세션이 루프백 HTTP MCP
// (core/mcpHub.ts)로 붙어 `mcp__memory__remember`·`recall`·`forget` 로 쓴다. 소유자 턴이 하네스로 가면서 기억 도구가
// 통째로 빠져 있던 것을 되돌린다 — 그동안 forget(소유자 전용)은 사실상 부를 길이 없었다.
//
// 핸들러는 봇 세션과 **같은 함수**다(tools.ts). 범위(DM=개인, 서버=공용)·공용 기억 상한·recall 풀·forget 권한·작성자
// 표시가 두 경로에서 갈라질 수 없다. 이 서버가 하는 일은 둘뿐이다: 세션이 보낸 인자가 아니라 **검증된 작업 토큰
// 클레임**에서 신원과 위치를 꺼내 핸들러의 컨텍스트를 채우는 것, 그리고 실제로 일어난 쓰기·삭제를 봇 로그에 남기는 것.
// 소유자 여부는 클레임의 userId 를 봇 설정의 소유자 id 와 견준다(core.ts 와 같은 규칙).

export type MemoryServerDeps = {
  memories: MemoriesRepo;
  users: UsersRepo;
  // 봇 설정의 소유자 디스코드 id(DISCORD_OWNER_ID).
  ownerId: string;
  // 감사 줄·오류를 남길 곳. 기본은 봇 로그(console.log).
  log?: (line: string) => void;
};

const NO_LOCATION =
  "이 작업 토큰에는 대화 위치(DM·서버)가 없어 기억 도구를 쓸 수 없어요 — 개인 기억과 공용 기억을 가를 수 없어서예요.";

// DB 오류의 원문(접속 호스트·제약 이름 등)은 세션으로 돌려보내지 않는다 — 모델이 그대로 채널에 옮길 수 있다.
// 원문은 봇 로그에만 남긴다.
const STORE_ERROR = "기억 저장소에 닿지 못했어요. 잠시 뒤 다시 시도해 주세요.";

const logOf = (deps: MemoryServerDeps) => deps.log ?? ((line: string) => console.log(line));

// 누가(토큰의 userId)·어느 대화·어느 작업 토큰(jobId 앞 6자)인지. 감사 줄과 오류 줄이 함께 쓴다.
const whoOf = (claims: JobTokenClaims) =>
  `사용자 ${claims.userId}, 대화 ${claims.conversationId}, 작업 ${claims.jobId.slice(0, 6)}`;

// 쓰기·삭제 지점을 감싼 기억 리포. 감사 줄은 시도가 아니라 **실제로 DB 에 쓰거나 지운 결과**만 남긴다 — 소유자 전용
// 거절·여러 건이 걸려 지우지 않음·상한 초과는 쓰기에 닿지 않으므로 줄이 없다. 남기는 것은 기억 번호와 범위뿐이다
// (제목·내용은 남기지 않는다 — 개인 기억이 로그 파일로 새지 않게). 이 줄이 필요한 이유: 하네스 세션과 부원의 셸은
// 같은 계정이라, 진행 중인 소유자 작업 토큰이 같은 계정의 프로세스에 보인다(위험 등록부 §14). 세션을 거치지 않고 이
// 서버를 직접 두드린 호출은 그 턴의 진행 표시·actions 에 남지 않으므로, 여기 한 줄이 유일한 흔적이다. 지운 번호는
// 매일 백업에서 찾아 되살린다. 조회는 DB 읽기가 전원에게 열려 있어(ADR 0010) 새로 드러나는 것이 없으니 남기지 않는다.
function auditedMemories(memories: MemoriesRepo, line: (what: string) => void): MemoryToolCtx["repos"]["memories"] {
  return {
    insert: async (m) => {
      const id = await memories.insert(m);
      line(`remember — ${m.scope} 기억 번호 ${id}`);
      return id;
    },
    delete: async (id) => {
      await memories.delete(id);
      line(`forget — 기억 번호 ${id}`);
    },
    all: () => memories.all(),
    forUser: (userId) => memories.forUser(userId),
    sharedOnly: () => memories.sharedOnly(),
  };
}

// 클레임 → 핸들러 컨텍스트. 위치(isPrivate)가 없으면 null — 개인·공용을 가를 수 없으니 기억 도구를 열지 않는다
// (fail closed). 하네스 턴의 토큰은 runHarnessTurn 이 늘 위치를 싣는다. 위치가 없는 것은 파일 반환 토큰 같은 다른
// 용도의 토큰뿐이고, 그 토큰은 허용 목록(mcpHub)이 없어 애초에 허브에서 403 이다 — 이 검사는 두 번째 겹이다.
export function memoryCtxFromClaims(deps: MemoryServerDeps, claims: JobTokenClaims): MemoryToolCtx | null {
  if (typeof claims.isPrivate !== "boolean") return null;
  const log = logOf(deps);
  const who = whoOf(claims);
  return {
    repos: { memories: auditedMemories(deps.memories, (what) => log(`[mcp] memory ${what} (${who})`)), users: deps.users },
    isPrivate: claims.isPrivate,
    isOwner: claims.userId === deps.ownerId,
    userId: claims.userId,
    conversationId: claims.conversationId,
  };
}

const textOf = (text: string, isError = false) => ({
  content: [{ type: "text" as const, text }],
  ...(isError ? { isError: true } : {}),
});

export function makeMemoryServer(deps: MemoryServerDeps, claims: JobTokenClaims): McpServer {
  const server = new McpServer({ name: "asahi-memory", version: "1.0.0" });
  const ctx = memoryCtxFromClaims(deps, claims);
  const log = logOf(deps);

  // 핸들러의 거절(상한 초과·소유자 전용 등)은 봇 세션처럼 평문 결과로 돌려준다(tools.ts 의 textResult 와 같은 모양).
  // 예외(DB 장애 등)만 isError 로 바꾸고, 원문은 봇 로그에만 남긴다.
  const run = async (f: (c: MemoryToolCtx) => Promise<string>) => {
    if (ctx === null) return textOf(NO_LOCATION, true);
    try {
      return textOf(await f(ctx));
    } catch (err) {
      log(`[mcp] memory 오류 — ${err instanceof Error ? err.message : String(err)} (${whoOf(claims)})`);
      return textOf(STORE_ERROR, true);
    }
  };

  server.registerTool(
    "remember",
    { title: "기억 저장", description: MEMORY_TOOL_SPECS.remember.description, inputSchema: MEMORY_TOOL_SPECS.remember.args },
    async (args) => run((c) => rememberHandler(c, args)),
  );

  server.registerTool(
    "recall",
    { title: "기억 조회", description: MEMORY_TOOL_SPECS.recall.description, inputSchema: MEMORY_TOOL_SPECS.recall.args },
    async (args) => run((c) => recallHandler(c, args)),
  );

  server.registerTool(
    "forget",
    { title: "공용 기억 삭제", description: MEMORY_TOOL_SPECS.forget.description, inputSchema: MEMORY_TOOL_SPECS.forget.args },
    async (args) => run((c) => forgetHandler(c, args)),
  );

  return server;
}
