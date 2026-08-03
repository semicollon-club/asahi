import type { Db } from "./db.js";

export type StoredMessage = { id: number; conversationId: number; ts: number; role: "user" | "assistant" | "system"; userId: string | null; content: string };
type Row = { id: number | string; conversation_id: number | string; ts: number; role: "user" | "assistant" | "system"; user_id: string | null; content: string };
function toMessage(r: Row): StoredMessage {
  return { id: Number(r.id), conversationId: Number(r.conversation_id), ts: r.ts, role: r.role, userId: r.user_id, content: r.content };
}

export class MessagesRepo {
  constructor(private db: Db) {}

  async insert(m: { conversationId: number; ts: number; role: "user" | "assistant" | "system"; userId?: string; discordMessageId?: string; content: string; processed?: boolean }): Promise<number> {
    const r = await this.db.query(
      "INSERT INTO messages (conversation_id, ts, role, user_id, discord_message_id, content, processed) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id",
      [m.conversationId, m.ts, m.role, m.userId ?? null, m.discordMessageId ?? null, m.content, m.processed !== false],
    );
    return Number((r.rows[0] as { id: number | string }).id);
  }

  async recent(conversationId: number, limit: number, sinceTs?: number): Promise<StoredMessage[]> {
    // sinceTs 는 컨텍스트 바닥선이다 — 그 시각 이전의 원문은 요약으로 대체됐거나(/기억정리)
    // 일부러 끊긴 것이다(/새세션). 경계 시각의 메시지는 제외한다(> 이지 >= 가 아니다).
    const r = await this.db.query(
      sinceTs === undefined
        ? "SELECT * FROM (SELECT * FROM messages WHERE conversation_id = $1 ORDER BY id DESC LIMIT $2) AS recent_sub ORDER BY id ASC"
        : "SELECT * FROM (SELECT * FROM messages WHERE conversation_id = $1 AND ts > $3 ORDER BY id DESC LIMIT $2) AS recent_sub ORDER BY id ASC",
      sinceTs === undefined ? [conversationId, limit] : [conversationId, limit, sinceTs],
    );
    return (r.rows as Row[]).map(toMessage);
  }

  // FTS5 대체: 대소문자 무시 부분 문자열 검색(접두/형태소 매칭 없음, 단순 substring).
  // ILIKE '%...%' 대신 strpos(lower(x), lower(y)) > 0 를 쓴다: ILIKE 는 검색어에 포함된 %,_ 를
  // 이스케이프하지 않으면 와일드카드로 해석해 오매칭이 나는데, strpos 는 순수 위치 검색이라
  // 와일드카드 해석 자체가 없어 그 문제가 애초에 없다(이스케이프 불필요, db.ts 의 strpos 스텁 참고).
  async search(conversationId: number | null, query: string, limit: number): Promise<StoredMessage[]> {
    const trimmed = query.trim();
    if (trimmed.length === 0) return [];
    const r = conversationId === null
      ? await this.db.query("SELECT * FROM messages WHERE strpos(lower(content), lower($1)) > 0 ORDER BY id DESC LIMIT $2", [trimmed, limit])
      : await this.db.query("SELECT * FROM messages WHERE strpos(lower(content), lower($1)) > 0 AND conversation_id = $2 ORDER BY id DESC LIMIT $3", [trimmed, conversationId, limit]);
    return (r.rows as Row[]).map(toMessage);
  }

  async unprocessedUserMessages(): Promise<StoredMessage[]> {
    const r = await this.db.query("SELECT * FROM messages WHERE role = 'user' AND processed = FALSE ORDER BY id ASC");
    return (r.rows as Row[]).map(toMessage);
  }

  async markProcessed(id: number): Promise<void> {
    await this.db.query("UPDATE messages SET processed = TRUE WHERE id = $1", [id]);
  }

  // 친근도(rapportStage) 파생 소스: 그 사용자의 user 역할 메시지 누적 수.
  async countUserMessages(userId: string): Promise<number> {
    const r = await this.db.query(
      "SELECT COUNT(*) AS n FROM messages WHERE user_id = $1 AND role = 'user'",
      [userId],
    );
    return Number((r.rows[0] as { n: number | string }).n);
  }
}
