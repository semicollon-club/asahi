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

  it("선택 필드가 없어도 기록된다", async () => {
    const repo = new ActionsRepo(await openTestDb());
    await repo.record({ ts: 1, conversationId: null, userId: null, tool: "sh_exec", status: "ok" });
    const rows = await repo.recent(10);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.input).toBeUndefined();
  });
});
