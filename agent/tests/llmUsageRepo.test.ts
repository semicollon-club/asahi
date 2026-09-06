import { describe, it, expect, beforeEach } from "vitest";
import { openTestDb } from "../src/store/db.js";
import { LlmUsageRepo, type LlmUsageInsert } from "../src/store/llmUsageRepo.js";

// LLM 사용량 저장소(3단계 3.2·3.3). 프록시가 모델 호출마다 record 로 한 행씩 남기고, 봇의 사전
// 게이트가 sumTokensForUserSince 로 부원의 창 안 소비를 합산한다(부원별 창 상한 3.3).
const base: LlmUsageInsert = {
  ts: 1_000_000, jobId: "j1", userId: "u1", conversationId: 7, model: "claude-sonnet-5",
  inputTokens: 100, outputTokens: 50, cacheCreationInputTokens: 0, cacheReadInputTokens: 10,
};

describe("LlmUsageRepo", () => {
  let repo: LlmUsageRepo;
  beforeEach(async () => { repo = new LlmUsageRepo(await openTestDb()); });

  it("한 턴(job)의 여러 모델 호출을 각각 한 행으로 남기고, 부원 창 합은 입력+출력의 합이다", async () => {
    await repo.record(base);
    await repo.record({ ...base, ts: 1_000_100, inputTokens: 200, outputTokens: 80 });
    // u1 의 창(0 이후) 합 = (100+50) + (200+80) = 430
    expect(await repo.sumTokensForUserSince("u1", 0)).toBe(430);
    const t = await repo.totalsForUserSince("u1", 0);
    expect(t).toEqual({ inputTokens: 300, outputTokens: 130, totalTokens: 430, calls: 2 });
  });

  it("창 밖(sinceTs 이전) 사용은 합산하지 않는다", async () => {
    await repo.record({ ...base, ts: 500 });          // 창 밖
    await repo.record({ ...base, ts: 2_000 });         // 창 안
    expect(await repo.sumTokensForUserSince("u1", 1_000)).toBe(150); // 2_000 행만
  });

  it("다른 부원의 사용은 섞이지 않는다", async () => {
    await repo.record(base);
    await repo.record({ ...base, userId: "u2", inputTokens: 999, outputTokens: 999 });
    expect(await repo.sumTokensForUserSince("u1", 0)).toBe(150);
    expect(await repo.sumTokensForUserSince("u2", 0)).toBe(1998);
  });

  it("conversation_id 가 없어도(null) 저장된다", async () => {
    await repo.record({ ...base, conversationId: null });
    expect(await repo.sumTokensForUserSince("u1", 0)).toBe(150);
  });
});
