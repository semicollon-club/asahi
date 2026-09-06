import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { FetchLike } from "../github/appToken.js";
import { listInstallationRepos, formatRepoList } from "../github/repos.js";
import { fetchPrFeedback, formatPrFeedback } from "../github/pulls.js";

// 허브 GitHub 읽기 MCP 서버(풀 하네스 4단계 4.1). 봇(계정 A)에서 도는 MCP 서버로, 소유자 하네스 세션이
// 루프백 HTTP MCP(core/mcpHub.ts)로 붙어 `mcp__github__*` 로 쓴다. 비밀(App 키)은 A 를 떠나지 않는다 — 세션은
// 작업 토큰으로 허브에 인증할 뿐이고, 실제 깃허브 호출은 이 서버가 A 의 설치 토큰으로 한다.
//
// 도구는 봇이 이미 쓰는 읽기 헬퍼(src/github)를 그대로 노출한다 — 새 깃허브 클라이언트를 만들지 않는다.
// 쓰기(PR 생성 등)는 여기 없다: 이 서버는 읽기 스코프 토큰을 받고(index.ts), 발행·push 는 기존 경로(create_pull_request·
// sh_exec)가 맡는다. token 은 주입한다 — 테스트가 가짜 토큰·가짜 fetch 로 도구 동작을 고정한다.

export type GithubReadDeps = {
  // 설치 토큰 공급자(읽기 스코프). 도구 호출마다 부른다 — 캐시는 공급자(shellTokenSource) 안에서.
  token(): Promise<string>;
  // 조직 이름(PR 경로 org/repo 조립용). 봇의 GithubAppConfig.org.
  org: string;
  fetchImpl?: FetchLike;
};

const asError = (err: unknown) => ({ content: [{ type: "text" as const, text: err instanceof Error ? err.message : String(err) }], isError: true });

export function makeGithubReadServer(deps: GithubReadDeps): McpServer {
  const server = new McpServer({ name: "asahi-github", version: "1.0.0" });

  server.registerTool(
    "list_repos",
    {
      title: "저장소 목록",
      description: "이 깃허브 App 설치가 접근할 수 있는 저장소 목록(이름·설명·기본 브랜치·최근 push·보관 여부).",
      inputSchema: {},
    },
    async () => {
      try {
        const repos = await listInstallationRepos({ token: await deps.token(), fetchImpl: deps.fetchImpl });
        return { content: [{ type: "text", text: formatRepoList(repos) }] };
      } catch (err) {
        return asError(err);
      }
    },
  );

  server.registerTool(
    "get_pull_request",
    {
      title: "PR 조회",
      description: "PR 하나의 상태·리뷰·리뷰 코멘트·이슈 코멘트를 읽는다. repo 는 조직 안 저장소 이름, number 는 PR 번호.",
      inputSchema: { repo: z.string().min(1), number: z.number().int().positive() },
    },
    async ({ repo, number }) => {
      try {
        const fb = await fetchPrFeedback({ org: deps.org, repo, number, token: await deps.token(), fetchImpl: deps.fetchImpl });
        return { content: [{ type: "text", text: formatPrFeedback(fb) }] };
      } catch (err) {
        return asError(err);
      }
    },
  );

  return server;
}
