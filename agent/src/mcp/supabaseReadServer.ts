import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { IntrospectRepo } from "../store/introspectRepo.js";
import { assertReadOnlySql, formatQueryResult } from "../core/sqlGuard.js";

// 허브 Supabase 읽기 MCP 서버(풀 하네스 4단계 4.2). 봇(계정 A)에서 도는 MCP 서버로, 소유자 하네스 세션이
// 루프백 HTTP MCP(core/mcpHub.ts)로 붙어 `mcp__supabase__*` 로 쓴다. 접속 문자열(DATABASE_URL)은 A 를 떠나지
// 않는다 — 세션은 작업 토큰으로 허브에 인증할 뿐이고, 실제 조회는 이 서버가 A 의 풀로 한다.
//
// 봇의 기존 자기인지 도구(tools.ts 의 db_schema/db_query)와 정확히 같은 재료를 그대로 노출한다: 스키마는
// IntrospectRepo.schema(), 쿼리는 assertReadOnlySql(1차 방어) + IntrospectRepo.readOnlyQuery(Postgres READ ONLY
// 트랜잭션 — 핵심 방어) + formatQueryResult. 쓰기는 구조적으로 불가능하다(READ ONLY 트랜잭션이 DB 에서 거부).

export type SupabaseReadDeps = {
  introspect: IntrospectRepo;
  // 한 쿼리가 돌려줄 최대 행(기본은 IntrospectRepo 의 100). 그 이상은 "…외 N행" 으로 접힌다.
  maxRows?: number;
};

const asError = (err: unknown) => ({ content: [{ type: "text" as const, text: err instanceof Error ? err.message : String(err) }], isError: true });

export function makeSupabaseReadServer(deps: SupabaseReadDeps): McpServer {
  const server = new McpServer({ name: "asahi-supabase", version: "1.0.0" });

  server.registerTool(
    "db_schema",
    {
      title: "DB 스키마",
      description: "public 스키마의 테이블·컬럼 구조를 돌려준다. 쿼리를 쓰기 전에 구조를 확인하는 데 쓴다.",
      inputSchema: {},
    },
    async () => {
      try {
        return { content: [{ type: "text", text: await deps.introspect.schema() }] };
      } catch (err) {
        return asError(err);
      }
    },
  );

  server.registerTool(
    "db_query",
    {
      title: "DB 읽기 쿼리",
      description: "읽기 전용 SELECT(또는 WITH … SELECT) 한 문장을 실행해 결과를 표로 돌려준다. 쓰기·다중문은 거부된다.",
      inputSchema: { sql: z.string().min(1) },
    },
    async ({ sql }) => {
      // 1차 방어(빠른 거부). 진짜 방어선은 아래 readOnlyQuery 의 READ ONLY 트랜잭션이다.
      try {
        assertReadOnlySql(sql);
      } catch (e) {
        return { content: [{ type: "text", text: e instanceof Error ? e.message : "잘못된 쿼리예요." }], isError: true };
      }
      try {
        const { rows, truncated } = await deps.introspect.readOnlyQuery(sql, deps.maxRows !== undefined ? { maxRows: deps.maxRows } : {});
        return { content: [{ type: "text", text: formatQueryResult(rows, truncated) }] };
      } catch (err) {
        return asError(err);
      }
    },
  );

  return server;
}
