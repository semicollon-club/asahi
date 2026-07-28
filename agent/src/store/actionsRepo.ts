import type { Db } from "./db.js";

// 도구 호출 1건 = 1행. 스키마(schema.ts 의 actions)는 자기인지 조각B 용으로 이미 정확한 모양이라
// 손대지 않는다 — 이 리포는 그 테이블을 처음으로 실제로 쓰는 코드다.
export type ActionRow = {
  ts: number;
  conversationId: number | null;
  userId: string | null;
  tool: string;
  input?: string;
  resultSummary?: string;
  status: string;
  durationMs?: number;
};

type Raw = {
  ts: number | string; conversation_id: number | string | null; user_id: string | null;
  tool: string; input: string | null; result_summary: string | null;
  status: string; duration_ms: number | string | null;
};

export class ActionsRepo {
  constructor(private db: Db) {}

  async record(a: ActionRow): Promise<void> {
    await this.db.query(
      `INSERT INTO actions (ts, conversation_id, user_id, tool, input, result_summary, status, duration_ms)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [a.ts, a.conversationId, a.userId, a.tool, a.input ?? null, a.resultSummary ?? null, a.status, a.durationMs ?? null],
    );
  }

  async recent(limit: number): Promise<ActionRow[]> {
    const r = await this.db.query("SELECT * FROM actions ORDER BY ts DESC, id DESC LIMIT $1", [limit]);
    return (r.rows as Raw[]).map((row) => ({
      ts: Number(row.ts),
      conversationId: row.conversation_id === null ? null : Number(row.conversation_id),
      userId: row.user_id,
      tool: row.tool,
      input: row.input ?? undefined,
      resultSummary: row.result_summary ?? undefined,
      status: row.status,
      durationMs: row.duration_ms === null ? undefined : Number(row.duration_ms),
    }));
  }
}
