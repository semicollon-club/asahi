import type { Db } from "./db.js";

export type ProjectRow = {
  id: number;
  repoName: string;
  ownerUserId: string;
  createdTs: number;
  lastPushTs: number | null;
};

type Raw = {
  id: number | string; repo_name: string; owner_user_id: string;
  created_ts: number | string; last_push_ts: number | string | null;
};

// pg 는 BIGINT 를 문자열로 돌려줄 수 있다(정밀도 보존). 다른 레포들과 같은 방식으로 숫자화한다.
function toRow(r: Raw): ProjectRow {
  return {
    id: Number(r.id),
    repoName: r.repo_name,
    ownerUserId: r.owner_user_id,
    createdTs: Number(r.created_ts),
    lastPushTs: r.last_push_ts === null ? null : Number(r.last_push_ts),
  };
}

export class ProjectsRepo {
  constructor(private db: Db) {}

  async byRepoName(repoName: string): Promise<ProjectRow | null> {
    const r = await this.db.query("SELECT * FROM projects WHERE repo_name = $1", [repoName]);
    return r.rows.length > 0 ? toRow(r.rows[0] as Raw) : null;
  }

  // 이름을 선점한다. 이미 있으면 **기존 행을 그대로 돌려준다** — 덮어쓰지 않는다.
  // ON CONFLICT DO NOTHING + 재조회로 처리하는 이유는 경합 때문이다: 두 사람이 같은 이름을
  // 동시에 주장해도 UNIQUE 제약이 하나만 통과시키고, 진 쪽은 이긴 쪽의 행을 읽게 된다.
  // 호출측(publish.ts)이 그 행의 ownerUserId 로 "내 것인가"를 판정하므로 여기서는 판정하지 않는다.
  async claim(o: { repoName: string; ownerUserId: string; ts: number }): Promise<ProjectRow> {
    await this.db.query(
      "INSERT INTO projects (repo_name, owner_user_id, created_ts) VALUES ($1, $2, $3) ON CONFLICT (repo_name) DO NOTHING",
      [o.repoName, o.ownerUserId, o.ts],
    );
    const row = await this.byRepoName(o.repoName);
    if (row === null) throw new Error(`프로젝트 등록에 실패했어요: ${o.repoName}`);
    return row;
  }

  async touchPush(repoName: string, ts: number): Promise<void> {
    await this.db.query("UPDATE projects SET last_push_ts = $1 WHERE repo_name = $2", [ts, repoName]);
  }

  async listByOwner(ownerUserId: string): Promise<ProjectRow[]> {
    const r = await this.db.query(
      "SELECT * FROM projects WHERE owner_user_id = $1 ORDER BY created_ts",
      [ownerUserId],
    );
    return (r.rows as Raw[]).map(toRow);
  }
}
