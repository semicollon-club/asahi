import type { Db } from "./db.js";

// 대화(conversation)별 요약. 1단계 summaries 테이블과 이름 충돌을 피해 conversation_summaries 사용.
export class SummariesRepo {
  constructor(private db: Db) {}

  async insert(s: { conversationId: number; fromMessageId: number; toMessageId: number; content: string; createdTs: number }): Promise<void> {
    await this.db.query(
      "INSERT INTO conversation_summaries (conversation_id, from_message_id, to_message_id, content, created_ts) VALUES ($1, $2, $3, $4, $5)",
      [s.conversationId, s.fromMessageId, s.toMessageId, s.content, s.createdTs],
    );
  }

  async recent(conversationId: number, limit: number, sinceTs?: number): Promise<string[]> {
    // 메시지와 달리 경계 시각의 요약은 포함한다(>= 이지 > 가 아니다) — /기억정리 가 만드는
    // 요약이 정확히 그 시각에 생기고, 그것이 그 이전 대화를 대신하는 물건이기 때문이다.
    const r = await this.db.query(
      sinceTs === undefined
        ? "SELECT content FROM conversation_summaries WHERE conversation_id = $1 ORDER BY id DESC LIMIT $2"
        : "SELECT content FROM conversation_summaries WHERE conversation_id = $1 AND created_ts >= $3 ORDER BY id DESC LIMIT $2",
      sinceTs === undefined ? [conversationId, limit] : [conversationId, limit, sinceTs],
    );
    return (r.rows as Array<{ content: string }>).map((row) => row.content);
  }
}
