import type { Db } from "./db.js";

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

  // 소유자 recall 풀. scope='character'(지어낸 캐릭터 설정)는 제외한다 —
  // 픽션이 실제 기억 조회 결과에 섞이면 "작업 사실은 지어내지 않는다"는 경계가 무너진다.
  async all(): Promise<Memory[]> {
    const r = await this.db.query("SELECT id, user_id, scope, title, content FROM memories WHERE scope <> 'character' ORDER BY id");
    return (r.rows as Row[]).map(toMemory);
  }

  // 캐릭터가 대화 중 지어내 확정한 자기 설정(픽션). 유저 스코프가 아니라 캐릭터 전역이다 —
  // 소유자에게 한 말이 손님에게도 동일해야 하므로 user_id 로 거르지 않는다.
  // id ASC: 먼저 말한 설정이 먼저 온다. 상한에 걸려 잘려도 초기 canon 이 안정적으로 남는다.
  // LIMIT 을 SQL 파라미터로 넘기지 않고 JS 에서 자르는 이유: pg-mem 의 LIMIT $n 지원이 불안정하고,
  // character 행은 설계상 소량이라 전량 조회 비용이 무시할 수준이다.
  async characterFacts(limit: number): Promise<Memory[]> {
    const r = await this.db.query("SELECT id, user_id, scope, title, content FROM memories WHERE scope = 'character' ORDER BY id");
    return (r.rows as Row[]).map(toMemory).slice(0, Math.max(0, limit));
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
