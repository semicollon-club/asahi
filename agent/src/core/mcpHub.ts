import http from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { bearerTokenOf } from "./fileReturn.js";
import type { JobTokenClaims } from "./jobToken.js";

// MCP 허브(풀 하네스 4단계 4.1) — 봇(계정 A)의 `/mcp/<이름>`. 비밀이 필요한 MCP 서버(GitHub·나중에 Supabase·Railway)를
// A 에서 띄우고 루프백 HTTP MCP 로 노출한다. 세션(계정 B)의 Claude Code 가 mcpServers 로 여기 붙어 `mcp__<이름>__*` 로 쓴다.
// 인증은 /llm·/files 와 같은 작업 토큰(HMAC, 2시간, 부원·대화·모델). 비밀은 A 를 떠나지 않는다 — 세션은 이름만 알고
// 토큰으로 인증한다. 허브가 127.0.0.1 에만 묶여(HUB_BIND) 미니PC 밖에서는 이 엔드포인트가 보이지 않는다.
//
// 전송은 stateless StreamableHTTP 다: 요청마다 새 McpServer+transport 를 만들어 연결하고 응답 뒤 닫는다. 읽기 전용
// 서버라 세션 상태(서버→클라이언트 알림)가 필요 없어 이 방식이 가장 단순하다(연결·세션 관리 표면이 없다).

export const MCP_HUB_PREFIX = "/mcp";

export type McpRoute = { kind: "server"; name: string } | { kind: "notFound" };

// `/mcp/<이름>` 만 받는다. 이름에 `/` 나 빈 값은 없다 — 서버 표(index.ts)의 키와 정확히 대조된다.
export function decideMcpRoute(url: string | undefined): McpRoute {
  if (!url) return { kind: "notFound" };
  const path = url.split("?")[0];
  if (!path.startsWith(`${MCP_HUB_PREFIX}/`)) return { kind: "notFound" };
  const name = path.slice(MCP_HUB_PREFIX.length + 1);
  if (name === "" || name.includes("/")) return { kind: "notFound" };
  return { kind: "server", name };
}

export type McpHubDeps = {
  // 작업 토큰 검증(index.ts 가 makeJobTokenMinter 의 verify 를 넘긴다). null/던짐은 401.
  verify(token: string): JobTokenClaims | null;
  // 이름 → 요청마다 새 McpServer 를 만드는 팩토리(stateless). 표에 없는 이름은 404.
  servers: Record<string, () => McpServer>;
};

function replyJson(res: http.ServerResponse, status: number, message: string): void {
  if (res.headersSent || res.writableEnded) return;
  res.writeHead(status, { "content-type": "application/json" });
  // MCP 클라이언트가 읽을 수 있게 JSON-RPC 오류 모양으로 낸다(id 는 알 수 없으니 null).
  res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: status === 401 ? -32001 : -32601, message }, id: null }));
}

export function makeMcpHubHandler(deps: McpHubDeps): (req: http.IncomingMessage, res: http.ServerResponse) => void {
  return (req, res) => {
    const route = decideMcpRoute(req.url);
    if (route.kind === "notFound" || !(route.name in deps.servers)) {
      replyJson(res, 404, "이 허브에 없는 MCP 서버예요.");
      return;
    }
    // 토큰은 본문(초기화·도구 인자)을 전송에 넘기기 전에 본다 — 토큰 없는 요청이 MCP 핸드셰이크로 들어오지 못하게.
    const token = bearerTokenOf(req.headers.authorization);
    let claims: JobTokenClaims | null = null;
    if (token !== null) {
      try {
        claims = deps.verify(token);
      } catch {
        claims = null;
      }
    }
    if (claims === null) {
      replyJson(res, 401, "작업 토큰이 없거나 만료됐어요.");
      return;
    }
    // 신원별 허용 목록(설계 §9): 토큰이 이 서버를 열도록 발급됐는지 본다. 세션이 mcpServers 설정을 우회해
    // (Bash 로 직접) 다른 서버에 붙으려 해도, 토큰에 그 이름이 없으면 거부한다 — 손님 프로필이 Supabase 를
    // 열지 않는다는 경계가 프로필뿐 아니라 토큰에서도 선다.
    if (!(claims.mcpHub ?? []).includes(route.name)) {
      replyJson(res, 403, "이 세션은 그 MCP 서버를 쓸 수 없어요.");
      return;
    }

    void (async () => {
      const server = deps.servers[route.name]();
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      // 응답이 끝나면(또는 클라이언트가 끊으면) 이 요청용 서버·전송을 닫는다 — stateless 라 요청마다 하나다.
      res.on("close", () => {
        void transport.close();
        void server.close();
      });
      try {
        await server.connect(transport);
        await transport.handleRequest(req, res);
      } catch (err) {
        console.error(`[mcp] ${route.name} 요청 처리 오류:`, err instanceof Error ? err.message : String(err));
        replyJson(res, 500, "MCP 요청을 처리하지 못했어요.");
      }
    })();
  };
}
