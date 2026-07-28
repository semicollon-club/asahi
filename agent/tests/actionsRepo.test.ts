import { describe, it, expect } from "vitest";
import { openTestDb } from "../src/store/db.js";
import { ActionsRepo } from "../src/store/actionsRepo.js";

describe("ActionsRepo", () => {
  it("기록한 행을 최근 순으로 돌려준다", async () => {
    const repo = new ActionsRepo(await openTestDb());
    await repo.record({ ts: 100, conversationId: 1, userId: "guest", tool: "fs_read", input: "a.txt", resultSummary: "본문", status: "ok", durationMs: 12 });
    await repo.record({ ts: 200, conversationId: 1, userId: "guest", tool: "fs_write", status: "error", resultSummary: "허용된 폴더 밖 경로예요" });

    const rows = await repo.recent(10);
    expect(rows.map((r) => r.tool)).toEqual(["fs_write", "fs_read"]);
    expect(rows[0]!.status).toBe("error");
    expect(rows[1]!.durationMs).toBe(12);
  });

  it("선택 필드가 없어도 기록된다 — 세 선택 필드 전부 undefined 로 되읽힌다", async () => {
    const repo = new ActionsRepo(await openTestDb());
    await repo.record({ ts: 1, conversationId: null, userId: null, tool: "sh_exec", status: "ok" });
    const rows = await repo.recent(10);
    expect(rows).toHaveLength(1);
    // 리뷰 후속(Minor 2): input 만 단정하면 나머지 둘의 null→undefined 변환이 검증되지 않는다.
    // recent() 는 세 컬럼 모두 `?? undefined`/`=== null ? undefined` 로 돌려주도록 돼 있는데, 그중
    // durationMs 는 Number(null)===0 이라 변환을 한 줄만 잘못 써도 "0초"라는 그럴듯한 거짓값이 된다.
    expect(rows[0]!.input).toBeUndefined();
    expect(rows[0]!.resultSummary).toBeUndefined();
    expect(rows[0]!.durationMs).toBeUndefined();
  });
});
