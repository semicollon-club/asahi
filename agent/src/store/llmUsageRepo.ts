import type { Db } from "./db.js";

// LLM 사용량 저장소(풀 하네스 3단계 3.2·3.3). 인증 프록시가 하네스 세션의 모델 호출 하나마다
// record 로 한 행을 남기고, 봇의 사전 게이트(core.ts, 부원별 창 상한)가 sumTokensForUserSince 로
// "이 부원이 창 안에 얼마나 썼나"를 묻는다. 저장하는 것은 토큰 수·모델·시각뿐 — 프롬프트 본문·
// 자격증명은 없다(llmProxy.ts 가 usage 필드만 뽑아 넘긴다).

export type LlmUsageInsert = {
  ts: number;
  jobId: string;
  userId: string;
  conversationId?: number | null;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
};

export type LlmUsageTotals = { inputTokens: number; outputTokens: number; totalTokens: number; calls: number };

export class LlmUsageRepo {
  constructor(private db: Db) {}

  async record(u: LlmUsageInsert): Promise<void> {
    await this.db.query(
      `INSERT INTO llm_usage (ts, job_id, user_id, conversation_id, model, input_tokens, output_tokens, cache_creation_input_tokens, cache_read_input_tokens)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [u.ts, u.jobId, u.userId, u.conversationId ?? null, u.model, u.inputTokens, u.outputTokens, u.cacheCreationInputTokens, u.cacheReadInputTokens],
    );
  }

  // 부원별 창 상한(3.3)이 쓰는 합산 — 상한 지표는 입력+출력 토큰이다(캐시 읽기는 값이 싸 세지 않는다).
  // 창(sinceTs 이후)의 그 부원 합만 본다. 소유자는 이 게이트를 아예 거치지 않는다(core.ts).
  async sumTokensForUserSince(userId: string, sinceTs: number): Promise<number> {
    const r = await this.db.query(
      "SELECT COALESCE(SUM(input_tokens + output_tokens), 0) AS n FROM llm_usage WHERE user_id = $1 AND ts > $2",
      [userId, sinceTs],
    );
    return Number((r.rows[0] as { n: number | string }).n);
  }

  // 관측용(runtime_info·db_query 보조). 창 안 한 부원의 입력/출력/총합·호출 수.
  async totalsForUserSince(userId: string, sinceTs: number): Promise<LlmUsageTotals> {
    const r = await this.db.query(
      `SELECT COALESCE(SUM(input_tokens), 0) AS i, COALESCE(SUM(output_tokens), 0) AS o, COUNT(*) AS c
       FROM llm_usage WHERE user_id = $1 AND ts > $2`,
      [userId, sinceTs],
    );
    const row = r.rows[0] as { i: number | string; o: number | string; c: number | string };
    const inputTokens = Number(row.i);
    const outputTokens = Number(row.o);
    return { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens, calls: Number(row.c) };
  }
}
