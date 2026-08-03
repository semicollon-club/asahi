import type { Db } from "./db.js";

export type Conversation = {
  id: number; kind: "dm" | "thread"; discordChannelId: string; originMessageId: string | null;
  guildId: string | null; parentChannelId: string | null; primaryUserId: string; isPrivate: boolean;
  sessionId: string | null; firstMessageId: number | null; privateMemoryLoaded: boolean;
  lastActiveTs: number; status: "active" | "idle" | "closed"; contextFloorTs: number | null;
};

type Row = {
  id: number | string; kind: "dm" | "thread"; discord_channel_id: string; origin_message_id: string | null;
  guild_id: string | null; parent_channel_id: string | null; primary_user_id: string; is_private: boolean;
  session_id: string | null; first_message_id: number | string | null; private_memory_loaded: boolean;
  last_active_ts: number; status: "active" | "idle" | "closed"; context_floor_ts: number | string | null;
};

function toConversation(r: Row): Conversation {
  return {
    id: Number(r.id), kind: r.kind, discordChannelId: r.discord_channel_id, originMessageId: r.origin_message_id,
    guildId: r.guild_id, parentChannelId: r.parent_channel_id, primaryUserId: r.primary_user_id,
    isPrivate: r.is_private, sessionId: r.session_id,
    firstMessageId: r.first_message_id === null ? null : Number(r.first_message_id),
    privateMemoryLoaded: r.private_memory_loaded, lastActiveTs: r.last_active_ts, status: r.status,
    contextFloorTs: r.context_floor_ts === null ? null : Number(r.context_floor_ts),
  };
}

export class ConversationsRepo {
  constructor(private db: Db) {}

  async create(c: { kind: "dm" | "thread"; discordChannelId: string; originMessageId?: string; guildId?: string; parentChannelId?: string; primaryUserId: string; isPrivate: boolean; lastActiveTs: number }): Promise<number> {
    const r = await this.db.query(
      `INSERT INTO conversations (kind, discord_channel_id, origin_message_id, guild_id, parent_channel_id, primary_user_id, is_private, last_active_ts, status, created_ts)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'active', $8) RETURNING id`,
      [
        c.kind, c.discordChannelId, c.originMessageId ?? null, c.guildId ?? null, c.parentChannelId ?? null,
        c.primaryUserId, c.isPrivate, c.lastActiveTs,
      ],
    );
    return Number((r.rows[0] as { id: number | string }).id);
  }

  async getById(id: number): Promise<Conversation | null> {
    const r = await this.db.query("SELECT * FROM conversations WHERE id = $1", [id]);
    const row = r.rows[0] as Row | undefined;
    return row ? toConversation(row) : null;
  }

  async getByChannelId(discordChannelId: string): Promise<Conversation | null> {
    const r = await this.db.query("SELECT * FROM conversations WHERE discord_channel_id = $1", [discordChannelId]);
    const row = r.rows[0] as Row | undefined;
    return row ? toConversation(row) : null;
  }

  // 소유자에게 능동적으로 알리려면 보낼 채널이 필요한데, 지금까지 이 리포에는 "이 사람의 DM
  // 대화"를 찾는 경로가 없었다(전부 채널 id 나 대화 id 로 찾는다). 한 사용자가 DM 대화를
  // 여럿 가질 일은 없지만, 혹시라도 있다면 가장 최근에 활동한 것을 고른다.
  async findDmFor(userId: string): Promise<Conversation | null> {
    const r = await this.db.query(
      "SELECT * FROM conversations WHERE kind = 'dm' AND primary_user_id = $1 ORDER BY last_active_ts DESC LIMIT 1",
      [userId],
    );
    const row = r.rows[0] as Row | undefined;
    return row ? toConversation(row) : null;
  }

  // 유휴 정리 대상: 활성 상태 + 열린 세션 + last_active 가 컷오프 이전. 오래된 것부터.
  async listActiveIdle(cutoffTs: number, limit = 100): Promise<Conversation[]> {
    const r = await this.db.query(
      "SELECT * FROM conversations WHERE status = 'active' AND session_id IS NOT NULL AND last_active_ts < $1 ORDER BY last_active_ts ASC LIMIT $2",
      [cutoffTs, limit],
    );
    return (r.rows as Row[]).map(toConversation);
  }

  async getByOriginMessageId(originMessageId: string): Promise<Conversation | null> {
    const r = await this.db.query("SELECT * FROM conversations WHERE origin_message_id = $1", [originMessageId]);
    const row = r.rows[0] as Row | undefined;
    return row ? toConversation(row) : null;
  }

  async setSession(id: number, sessionId: string | null, lastActiveTs: number): Promise<void> {
    await this.db.query("UPDATE conversations SET session_id = $1, last_active_ts = $2 WHERE id = $3", [sessionId, lastActiveTs, id]);
  }

  async setPrivateMemoryLoaded(id: number, loaded: boolean): Promise<void> {
    await this.db.query("UPDATE conversations SET private_memory_loaded = $1 WHERE id = $2", [loaded, id]);
  }

  async setStatus(id: number, status: "active" | "idle" | "closed"): Promise<void> {
    await this.db.query("UPDATE conversations SET status = $1 WHERE id = $2", [status, id]);
  }

  async setFirstMessageId(id: number, messageId: number): Promise<void> {
    await this.db.query("UPDATE conversations SET first_message_id = $1 WHERE id = $2", [messageId, id]);
  }

  // 이 시각 이전의 대화 내용은 새 세션의 컨텍스트 블록에 싣지 않는다(turnPrep.buildContextBlock).
  // 데이터를 지우는 것이 아니라 "안 싣는다"는 표시일 뿐이다 — messages·summaries 행은 남는다.
  async setContextFloor(id: number, ts: number): Promise<void> {
    await this.db.query("UPDATE conversations SET context_floor_ts = $1 WHERE id = $2", [ts, id]);
  }
}
