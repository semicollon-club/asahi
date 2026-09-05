import { githubGet, type FetchLike } from "./appToken.js";

// 설치(App 이 조직에 설치된 단위)가 볼 수 있는 저장소 목록(2026-09-05, 2단계). 부원이 "동아리 저장소
// 뭐 있어?" 라고 물을 때, 그리고 clone·create_pull_request 의 대상 이름을 잘못 적지 않게 할 때
// 쓴다(core/tools.ts 의 listReposHandler). 표준 절차(persona.ts 의 PUBLISH_LINES)의 첫 단계다 —
// 이 도구가 생기기 전에는 부원이 저장소 이름을 스스로 알아 와야 했다.
//
// 토큰은 호출측이 설치 전체·metadata:read 로 발급한다 — 이름·설명·기본 브랜치·공개 여부는 전부
// metadata 다. 어느 리포를 볼지 미리 알 수 없어 범위를 좁힐 축이 없는 것은 셸 토큰
// (github/shellToken.ts)과 같지만, 이쪽은 쓰기 권한이 전혀 없어 새도 이름을 보는 것 이상은 못 한다.
export type RepoSummary = {
  name: string;
  description: string | null;
  private: boolean;
  defaultBranch: string;
  // ISO 8601. 깃허브가 한 번도 push 되지 않은 리포에 null 을 줄 수 있어 선택이다.
  pushedAt: string | null;
  archived: boolean;
  url: string;
};

export const REPO_LIST_PAGE_SIZE = 100;
// 동아리 조직에 저장소가 수백 개일 일은 없다. 상한이 없으면 깃허브가 잘못 답할 때(늘 가득 찬
// 페이지를 주는 경우) 무한히 돈다.
export const REPO_LIST_MAX_PAGES = 3;
// 표시 상한. 그 이상은 "…외 N개" 로 접는다 — 디스코드 메시지도 모델 컨텍스트도 수백 줄을 원하지 않는다.
export const REPO_LIST_MAX_LINES = 50;

type RawRepo = {
  name: string; description: string | null; private: boolean; default_branch: string;
  pushed_at: string | null; archived: boolean; html_url: string;
};
type RawPage = { total_count: number; repositories: RawRepo[] };

export async function listInstallationRepos(o: { token: string; fetchImpl?: FetchLike }): Promise<RepoSummary[]> {
  const out: RepoSummary[] = [];
  for (let page = 1; page <= REPO_LIST_MAX_PAGES; page++) {
    const r = await githubGet<RawPage>({
      token: o.token,
      url: `https://api.github.com/installation/repositories?per_page=${REPO_LIST_PAGE_SIZE}&page=${page}`,
      fetchImpl: o.fetchImpl,
    });
    if (!r.ok) throw new Error(`저장소 목록을 가져오지 못했어요: ${r.message}`);
    const items = Array.isArray(r.body?.repositories) ? r.body.repositories : [];
    for (const x of items) {
      out.push({
        name: x.name, description: x.description ?? null, private: x.private === true, defaultBranch: x.default_branch,
        pushedAt: x.pushed_at ?? null, archived: x.archived === true, url: x.html_url,
      });
    }
    // 덜 찬 페이지가 마지막이다. total_count 를 믿지 않고 실제로 받은 개수로 판정한다 — 두 값이
    // 어긋나도 이쪽은 받은 만큼만 보고하면 되기 때문이다.
    if (items.length < REPO_LIST_PAGE_SIZE) break;
  }
  return out;
}

// 최근에 push 된 것부터. 보관(archived)된 저장소는 작업 대상이 아니므로 뒤로 보내되 숨기지는
// 않는다 — "그 저장소 없어졌어?" 에 답할 수 있어야 한다.
export function formatRepoList(repos: RepoSummary[]): string {
  if (repos.length === 0) {
    return "이 App 이 볼 수 있는 저장소가 없어요 — 조직에 저장소가 없거나, App 설치 범위에 들어 있지 않아요.";
  }
  const ts = (r: RepoSummary) => (r.pushedAt ? Date.parse(r.pushedAt) || 0 : 0);
  const sorted = [...repos].sort((a, b) => Number(a.archived) - Number(b.archived) || ts(b) - ts(a));
  const shown = sorted.slice(0, REPO_LIST_MAX_LINES);
  const lines = shown.map((r) => {
    const facts = [
      `기본 브랜치 ${r.defaultBranch}`,
      r.private ? "비공개" : "공개",
      r.pushedAt ? `마지막 push ${r.pushedAt.slice(0, 10)}` : null,
      r.archived ? "보관됨" : null,
    ].filter((s): s is string => s !== null);
    const desc = r.description ? ` — ${r.description}` : "";
    return `- ${r.name}${desc} (${facts.join(" · ")})`;
  });
  const more = sorted.length > shown.length ? [`…외 ${sorted.length - shown.length}개`] : [];
  return [`동아리 저장소 ${repos.length}개:`, ...lines, ...more].join("\n");
}
