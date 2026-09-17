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
  // label 도 같은 이유로 회전에서 살아남아야 하는 신원 메타데이터다 — --label 없이 재등록하면
  // (o.label === undefined, 즉 아래에서 null 로 넘어감) 기존 값을 그대로 두고, 명시적으로 준
  // 라벨만 교체한다. COALESCE(EXCLUDED.label, workers.label) 이 그 "생략 시 보존" 을 구현한다.
  async upsert(o: { id: string; kind: WorkerKind; userId: string | null; tokenHash: string; label?: string; ts: number }): Promise<void> {
    await this.db.query(
      `INSERT INTO workers (id, kind, user_id, token_hash, label, created_ts)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (id) DO UPDATE SET
         kind = EXCLUDED.kind,
         user_id = EXCLUDED.user_id,
         token_hash = EXCLUDED.token_hash,
         label = COALESCE(EXCLUDED.label, workers.label)`,
      [o.id, o.kind, o.userId, o.tokenHash, o.label ?? null, o.ts],
    );
  }

  async touchLastSeen(id: string, ts: number): Promise<void> {
    await this.db.query("UPDATE workers SET last_seen_ts = $1 WHERE id = $2", [ts, id]);
  }

  // 2026-09-17(ADR 0011): personalWorkerOf 가 삭제됐다. 모든 턴이 공유 워커로 가므로 개인 워커를
  // 찾는 호출부가 하나도 남지 않았다. kind 컬럼과 'personal' 값 자체는 그대로 둔다 — 이미 등록된
  // 행(owner-laptop 등)의 기록이고, 정책을 되돌리면 이 조회를 다시 만들면 된다.
  //
  // 공용 워커가 여러 대인 상황은 1단계에서 만들지 않지만, 그래도 결정적으로 하나를 고른다 —
  // 정렬 없이 LIMIT 1 을 쓰면 어느 행이 나올지 DB 가 정한다.
  async sharedWorkerId(): Promise<string | null> {
    const r = await this.db.query("SELECT id FROM workers WHERE kind = 'shared' ORDER BY created_ts, id LIMIT 1");
    return (r.rows as { id: string }[])[0]?.id ?? null;
  }
}
