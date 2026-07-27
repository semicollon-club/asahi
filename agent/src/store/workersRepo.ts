import { createHash, randomBytes } from "node:crypto";
import type { Db } from "./db.js";

export type WorkerKind = "personal" | "shared";

export type WorkerRow = {
  id: string;
  kind: WorkerKind;
  userId: string | null;
  tokenHash: string;
  label: string | null;
  createdTs: number;
  lastSeenTs: number | null;
};

// 토큰은 평문으로 저장하지 않는다. DB 가 유출돼도 그 값만으로는 워커로 붙지 못한다.
// 토큰 자체가 128비트 이상의 고엔트로피 랜덤이라 사전 공격 대상이 아니므로 salt·KDF 없이
// 단순 해시로 충분하다(사람이 고른 비밀번호가 아니다).
export function hashWorkerToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export function generateWorkerToken(): string {
  return randomBytes(32).toString("hex");
}

type Raw = {
  id: string; kind: string; user_id: string | null; token_hash: string;
  label: string | null; created_ts: number | string; last_seen_ts: number | string | null;
};

// pg 는 BIGINT 를 문자열로 돌려줄 수 있다(정밀도 보존). 다른 레포들과 같은 방식으로 숫자화한다.
function toRow(r: Raw): WorkerRow {
  return {
    id: r.id,
    kind: r.kind === "personal" ? "personal" : "shared",
    userId: r.user_id,
    tokenHash: r.token_hash,
    label: r.label,
    createdTs: Number(r.created_ts),
    lastSeenTs: r.last_seen_ts === null ? null : Number(r.last_seen_ts),
  };
}

export class WorkersRepo {
  constructor(private db: Db) {}

  async getById(id: string): Promise<WorkerRow | null> {
    const r = await this.db.query("SELECT * FROM workers WHERE id = $1", [id]);
    const row = (r.rows as Raw[])[0];
    return row ? toRow(row) : null;
  }

  // 같은 id 로 다시 부르면 토큰 해시가 교체된다(회전·폐기 경로). created_ts 는 유지한다 —
  // "언제 처음 등록했는가"는 회전으로 사라져선 안 되는 정보다.
  async upsert(o: { id: string; kind: WorkerKind; userId: string | null; tokenHash: string; label?: string; ts: number }): Promise<void> {
    await this.db.query(
      `INSERT INTO workers (id, kind, user_id, token_hash, label, created_ts)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (id) DO UPDATE SET
         kind = EXCLUDED.kind,
         user_id = EXCLUDED.user_id,
         token_hash = EXCLUDED.token_hash,
         label = EXCLUDED.label`,
      [o.id, o.kind, o.userId, o.tokenHash, o.label ?? null, o.ts],
    );
  }

  async touchLastSeen(id: string, ts: number): Promise<void> {
    await this.db.query("UPDATE workers SET last_seen_ts = $1 WHERE id = $2", [ts, id]);
  }

  async personalWorkerOf(userId: string): Promise<string | null> {
    const r = await this.db.query(
      "SELECT id FROM workers WHERE kind = 'personal' AND user_id = $1 ORDER BY created_ts LIMIT 1",
      [userId],
    );
    return (r.rows as { id: string }[])[0]?.id ?? null;
  }

  // 공용 워커가 여러 대인 상황은 1단계에서 만들지 않지만, 그래도 결정적으로 하나를 고른다 —
  // 정렬 없이 LIMIT 1 을 쓰면 어느 행이 나올지 DB 가 정한다.
  async sharedWorkerId(): Promise<string | null> {
    const r = await this.db.query("SELECT id FROM workers WHERE kind = 'shared' ORDER BY created_ts, id LIMIT 1");
    return (r.rows as { id: string }[])[0]?.id ?? null;
  }
}
