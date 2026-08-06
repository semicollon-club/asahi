import type { Db } from "./db.js";

// 'character' 는 2026-08-05 에 쓰기 경로가 사라졌지만 기존 행이 DB 에 남아 있어 타입에는 둔다.
export type MemoryScope = "user" | "shared" | "character";
export type Memory = { id: number; userId: string; scope: MemoryScope; title: string; content: string };
type Row = { id: number | string; user_id: string; scope: MemoryScope; title: string; content: string };
function toMemory(r: Row): Memory { return { id: Number(r.id), userId: r.user_id, scope: r.scope, title: r.title, content: r.content }; }

export class MemoriesRepo {
  private now: () => number;
  constructor(private db: Db, now: () => number = Date.now) { this.now = now; }

  async insert(m: { userId: string; scope: MemoryScope; title: string; content: string; sourceConversationId?: number }): Promise<number> {
    const t = this.now();
    const r = await this.db.query(
      "INSERT INTO memories (user_id, scope, title, content, source_conversation_id, created_ts, updated_ts) VALUES ($1, $2, $3, $4, $5, $6, $6) RETURNING id",
      [m.userId, m.scope, m.title, m.content, m.sourceConversationId ?? null, t],
    );
    return Number((r.rows[0] as { id: number | string }).id);
  }

  async forUser(userId: string): Promise<Memory[]> {
    const r = await this.db.query(
      "SELECT id, user_id, scope, title, content FROM memories WHERE scope = 'shared' OR (scope = 'user' AND user_id = $1) ORDER BY id",
      [userId],
    );
    return (r.rows as Row[]).map(toMemory);
  }

  async sharedOnly(): Promise<Memory[]> {
    const r = await this.db.query("SELECT id, user_id, scope, title, content FROM memories WHERE scope = 'shared' ORDER BY id");
    return (r.rows as Row[]).map(toMemory);
  }

  // 소유자 recall 풀. scope='character'(옛 캐릭터 설정)는 제외한다 — 그 시절 지어낸 픽션이
  // 실제 기억 조회 결과에 섞이면 "작업 사실은 지어내지 않는다"는 경계가 무너진다. 쓰기 경로는
  // 사라졌지만 기존 행이 DB 에 남아 있으므로 이 필터는 계속 필요하다.
  async all(): Promise<Memory[]> {
    const r = await this.db.query("SELECT id, user_id, scope, title, content FROM memories WHERE scope <> 'character' ORDER BY id");
    return (r.rows as Row[]).map(toMemory);
  }

  // FTS5 대체: 제목/본문 대소문자 무시 부분 문자열 검색. ILIKE '%...%' 대신
  // strpos(lower(x), lower(y)) > 0 를 쓴다: ILIKE 는 검색어에 포함된 %,_ 를 이스케이프하지
  // 않으면 와일드카드로 해석해 오매칭이 나는데, strpos 는 순수 위치 검색이라 그 문제 자체가
  // 없다(이스케이프 불필요, db.ts 의 strpos 스텁 참고).
  async searchForUser(userId: string, query: string): Promise<Memory[]> {
    const r = await this.db.query(
      `SELECT id, user_id, scope, title, content FROM memories
       WHERE (scope = 'shared' OR (scope = 'user' AND user_id = $1)) AND (strpos(lower(title), lower($2)) > 0 OR strpos(lower(content), lower($2)) > 0) ORDER BY id`,
      [userId, query],
    );
    return (r.rows as Row[]).map(toMemory);
  }

  async update(id: number, patch: { title?: string; content?: string }): Promise<void> {
    await this.db.query(
      "UPDATE memories SET title = COALESCE($1, title), content = COALESCE($2, content), updated_ts = $3 WHERE id = $4",
      [patch.title ?? null, patch.content ?? null, this.now(), id],
    );
  }

  async delete(id: number): Promise<void> {
    await this.db.query("DELETE FROM memories WHERE id = $1", [id]);
  }
}
