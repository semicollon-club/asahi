import { describe, it, expect } from "vitest";
import { listInstallationRepos, formatRepoList, REPO_LIST_PAGE_SIZE, REPO_LIST_MAX_PAGES, type RepoSummary } from "../src/github/repos.js";

// 깃허브의 GET /installation/repositories 를 흉내 낸다 — page 쿼리로 페이지를 고른다. 무엇을
// 어떤 헤더로 불렀는지 기록한다(appToken.test.ts 와 같은 방식).
function fakeGithub(pages: Array<Array<Record<string, unknown>>>, opts: { status?: number } = {}) {
  const seen: Array<{ url: string; auth: string }> = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    seen.push({ url: String(url), auth: String((init.headers as Record<string, string>).authorization) });
    if (opts.status !== undefined && opts.status !== 200) {
      return new Response(JSON.stringify({ message: "Resource not accessible by integration" }), { status: opts.status });
    }
    const page = Number(new URL(String(url)).searchParams.get("page") ?? "1");
    const items = pages[page - 1] ?? [];
    return new Response(JSON.stringify({ total_count: pages.flat().length, repositories: items }), { status: 200 });
  }) as unknown as typeof fetch;
  return { seen, fetchImpl };
}

const raw = (name: string, over: Record<string, unknown> = {}) => ({
  name, description: null, private: true, default_branch: "main", pushed_at: "2026-09-01T00:00:00Z",
  archived: false, html_url: `https://github.com/semicollon-club/${name}`, ...over,
});

describe("listInstallationRepos", () => {
  it("설치 저장소 엔드포인트를 Bearer 토큰으로 부르고 요약 필드로 좁힌다", async () => {
    const { seen, fetchImpl } = fakeGithub([[raw("homepage", { description: "동아리 홈페이지", private: false })]]);
    const repos = await listInstallationRepos({ token: "ghs_meta", fetchImpl });
    expect(seen).toHaveLength(1);
    expect(seen[0].url.startsWith("https://api.github.com/installation/repositories?")).toBe(true);
    expect(seen[0].url).toContain(`per_page=${REPO_LIST_PAGE_SIZE}`);
    expect(seen[0].auth).toBe("Bearer ghs_meta");
    expect(repos).toEqual([{
      name: "homepage", description: "동아리 홈페이지", private: false, defaultBranch: "main",
      pushedAt: "2026-09-01T00:00:00Z", archived: false, url: "https://github.com/semicollon-club/homepage",
    }]);
  });

  it("한 페이지가 가득 차면 다음 페이지를 이어 받고, 덜 차면 멈춘다", async () => {
    const full = Array.from({ length: REPO_LIST_PAGE_SIZE }, (_, i) => raw(`r${i}`));
    const { seen, fetchImpl } = fakeGithub([full, [raw("last-1"), raw("last-2")]]);
    const repos = await listInstallationRepos({ token: "t", fetchImpl });
    expect(seen).toHaveLength(2);
    expect(repos).toHaveLength(REPO_LIST_PAGE_SIZE + 2);
  });

  // 조직 저장소가 수백 개일 일은 없지만, 상한이 없으면 깃허브가 잘못 답할 때 무한히 돈다.
  it("페이지 상한을 넘기지 않는다", async () => {
    const full = Array.from({ length: REPO_LIST_PAGE_SIZE }, (_, i) => raw(`r${i}`));
    const { seen, fetchImpl } = fakeGithub(Array.from({ length: REPO_LIST_MAX_PAGES + 2 }, () => full));
    await listInstallationRepos({ token: "t", fetchImpl });
    expect(seen).toHaveLength(REPO_LIST_MAX_PAGES);
  });

  it("실패하면 깃허브의 사유를 담아 던진다", async () => {
    const { fetchImpl } = fakeGithub([[]], { status: 403 });
    await expect(listInstallationRepos({ token: "t", fetchImpl })).rejects.toThrow(/Resource not accessible/);
  });
});

describe("formatRepoList", () => {
  const repo = (over: Partial<RepoSummary> = {}): RepoSummary => ({
    name: "homepage", description: null, private: true, defaultBranch: "main", pushedAt: "2026-09-01T00:00:00Z",
    archived: false, url: "https://github.com/semicollon-club/homepage", ...over,
  });

  it("빈 목록이면 그렇다고 말한다", () => {
    expect(formatRepoList([])).toContain("없어요");
  });

  it("마지막 push 가 최근인 순서로, 이름·기본 브랜치·공개 여부·설명을 한 줄씩 적는다", () => {
    const out = formatRepoList([
      repo({ name: "old", pushedAt: "2026-01-01T00:00:00Z", private: false, description: "옛 것" }),
      repo({ name: "asahi", pushedAt: "2026-09-05T00:00:00Z", defaultBranch: "main" }),
    ]);
    const lines = out.split("\n").filter((l) => l.startsWith("- "));
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("asahi");
    expect(lines[0]).toContain("main");
    expect(lines[0]).toContain("비공개");
    expect(lines[1]).toContain("old");
    expect(lines[1]).toContain("공개");
    expect(lines[1]).toContain("옛 것");
    expect(out).toContain("2개");
  });

  it("보관(archived)된 저장소는 뒤로 보내고 표시한다", () => {
    const out = formatRepoList([
      repo({ name: "archived-one", archived: true, pushedAt: "2026-09-05T00:00:00Z" }),
      repo({ name: "live", pushedAt: "2026-01-01T00:00:00Z" }),
    ]);
    const lines = out.split("\n").filter((l) => l.startsWith("- "));
    expect(lines[0]).toContain("live");
    expect(lines[1]).toContain("archived-one");
    expect(lines[1]).toContain("보관");
  });
});
