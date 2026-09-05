import type { Db } from "./db.js";

// 봇이 create_pull_request 로 만든 PR 의 추적 표(2026-09-05, 스키마 주석 참고). 이 표를 읽고 쓰는
// 곳은 셋이다 — core/tools.ts 의 createPullRequestHandler(기록)·prStatusHandler(조회·갱신),
// core/prTracker.ts(1분 타이머의 갱신·알림).
export type PrState = "open" | "merged" | "closed";

export type PullRequestRow = {
  id: number;
  repo: string;
  number: number;
  url: string;
  head: string;
  base: string;
  title: string;
  requesterUserId: string;
  conversationId: number | null;
  createdTs: number;
  state: PrState;
  // CI 상태 문자열. 값의 의미(unknown/pending/success/failure/none)는 github/pulls.ts 의 CiState 가
  // 정한다 — store 는 그 계층에 의존하지 않으므로(docs/architecture/module-boundaries.md) 여기서는
  // 문자열로만 다룬다.
  ciState: string;
  headSha: string | null;
  ownerNotifiedTs: number | null;
  ciNotifiedTs: number | null;
  closedNotifiedTs: number | null;
  lastCheckedTs: number | null;
};

type Raw = {
  id: number | string; repo: string; pr_number: number | string; url: string; head: string; base: string; title: string;
  requester_user_id: string; conversation_id: number | string | null; created_ts: number | string;
  state: PrState; ci_state: string; head_sha: string | null;
  owner_notified_ts: number | string | null; ci_notified_ts: number | string | null;
  closed_notified_ts: number | string | null; last_checked_ts: number | string | null;
};

// pg 는 BIGINT 를 문자열로 돌려줄 수 있다(정밀도 보존). 다른 레포들과 같은 방식으로 숫자화한다.
const num = (v: number | string | null): number | null => (v === null ? null : Number(v));

function toRow(r: Raw): PullRequestRow {
  return {
    id: Number(r.id), repo: r.repo, number: Number(r.pr_number), url: r.url, head: r.head, base: r.base, title: r.title,
    requesterUserId: r.requester_user_id, conversationId: num(r.conversation_id), createdTs: Number(r.created_ts),
    state: r.state, ciState: r.ci_state, headSha: r.head_sha,
    ownerNotifiedTs: num(r.owner_notified_ts), ciNotifiedTs: num(r.ci_notified_ts),
    closedNotifiedTs: num(r.closed_notified_ts), lastCheckedTs: num(r.last_checked_ts),
  };
}

// 갱신할 수 있는 열만. 신원 열(repo·number·요청자·대화)은 기록 뒤 바뀌지 않는다 — 바뀌면 "누구의
// 어느 PR 인가"가 흔들려 알림이 엉뚱한 곳으로 간다.
export type PullRequestPatch = Partial<
  Pick<PullRequestRow, "state" | "ciState" | "headSha" | "ownerNotifiedTs" | "ciNotifiedTs" | "closedNotifiedTs" | "lastCheckedTs">
>;
const PATCH_COLUMNS: Record<keyof PullRequestPatch, string> = {
  state: "state", ciState: "ci_state", headSha: "head_sha", ownerNotifiedTs: "owner_notified_ts",
  ciNotifiedTs: "ci_notified_ts", closedNotifiedTs: "closed_notified_ts", lastCheckedTs: "last_checked_ts",
};

export class PullRequestsRepo {
  constructor(private db: Db) {}

  // 기록한다. 이미 있으면 **기존 행을 그대로 돌려준다** — 덮어쓰지 않는다. ON CONFLICT DO NOTHING +
  // 재조회인 이유는 projectsRepo.claim 과 같다: 같은 PR 이 두 경로로 기록돼도 UNIQUE 가 하나만
  // 통과시키고, 알림 상태(*_notified_ts)가 초기화되지 않아 같은 알림이 두 번 나가지 않는다.
  async record(o: {
    repo: string; number: number; url: string; head: string; base: string; title: string;
    requesterUserId: string; conversationId: number | null; ts: number;
  }): Promise<PullRequestRow> {
    await this.db.query(
      `INSERT INTO pull_requests (repo, pr_number, url, head, base, title, requester_user_id, conversation_id, created_ts)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) ON CONFLICT (repo, pr_number) DO NOTHING`,
      [o.repo, o.number, o.url, o.head, o.base, o.title, o.requesterUserId, o.conversationId, o.ts],
    );
    const row = await this.byRepoNumber(o.repo, o.number);
    if (row === null) throw new Error(`PR 기록에 실패했어요: ${o.repo}#${o.number}`);
    return row;
  }

  async byRepoNumber(repo: string, number: number): Promise<PullRequestRow | null> {
    const r = await this.db.query("SELECT * FROM pull_requests WHERE repo = $1 AND pr_number = $2", [repo, number]);
    return r.rows.length > 0 ? toRow(r.rows[0] as Raw) : null;
  }

  // 폴러가 훑는 대상. 오래된 것부터 — 상한에 걸리면 새 PR 보다 오래 기다린 PR 이 먼저다.
  async listOpen(limit = 50): Promise<PullRequestRow[]> {
    const r = await this.db.query(
      "SELECT * FROM pull_requests WHERE state = 'open' ORDER BY created_ts ASC, id ASC LIMIT $1",
      [limit],
    );
    return (r.rows as Raw[]).map(toRow);
  }

  async listByRequester(userId: string, limit = 10): Promise<PullRequestRow[]> {
    const r = await this.db.query(
      "SELECT * FROM pull_requests WHERE requester_user_id = $1 ORDER BY created_ts DESC, id DESC LIMIT $2",
      [userId, limit],
    );
    return (r.rows as Raw[]).map(toRow);
  }

  async listRecent(limit = 10): Promise<PullRequestRow[]> {
    const r = await this.db.query("SELECT * FROM pull_requests ORDER BY created_ts DESC, id DESC LIMIT $1", [limit]);
    return (r.rows as Raw[]).map(toRow);
  }

  // 준 필드만 바꾼다. undefined 는 "건드리지 않는다" — null 은 "비운다"(예: 새 커밋이 올라와 CI 알림
  // 기록을 초기화할 때 ciNotifiedTs: null).
  async update(id: number, patch: PullRequestPatch): Promise<void> {
    const entries = (Object.keys(PATCH_COLUMNS) as Array<keyof PullRequestPatch>)
      .filter((k) => patch[k] !== undefined)
      .map((k) => [PATCH_COLUMNS[k], patch[k] as string | number | null] as const);
    if (entries.length === 0) return;
    const sets = entries.map(([col], i) => `${col} = $${i + 1}`).join(", ");
    await this.db.query(`UPDATE pull_requests SET ${sets} WHERE id = $${entries.length + 1}`, [...entries.map(([, v]) => v), id]);
  }
}
