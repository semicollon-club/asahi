import { describe, it, expect, beforeEach } from "vitest";
import { openTestDb } from "../src/store/db.js";
import { BackupsRepo } from "../src/store/backupsRepo.js";

// 백업 기록(부원 오픈 게이트 2D). `backups` 표는 오래전부터 DDL 만 있었다 — 이 저장소가 그 첫 사용자다.
// 실행기(core/backup.ts)는 lastSuccessTs 로 "오늘 것을 이미 만들었는가"를 판정한다.

describe("BackupsRepo", () => {
  let repo: BackupsRepo;
  beforeEach(async () => { repo = new BackupsRepo(await openTestDb()); });

  it("기록을 남기고 최근 목록으로 돌려준다", async () => {
    await repo.record({ ts: 1_000, path: "/b/a.json", sizeBytes: 10, kind: "memories", status: "ok" });
    await repo.record({ ts: 2_000, path: "/b/b.json", sizeBytes: 20, kind: "memories", status: "ok" });
    const rows = await repo.recent();
    expect(rows.map((r) => r.path)).toEqual(["/b/b.json", "/b/a.json"]); // 최신 먼저
    expect(rows[0]).toMatchObject({ ts: 2_000, sizeBytes: 20, kind: "memories", status: "ok", note: null });
  });

  it("마지막 성공 시각만 돌려준다 — 실패는 세지 않는다", async () => {
    expect(await repo.lastSuccessTs("memories")).toBeNull();
    await repo.record({ ts: 1_000, path: "/b/a.json", sizeBytes: 10, kind: "memories", status: "ok" });
    await repo.record({ ts: 3_000, path: "", sizeBytes: 0, kind: "memories", status: "error", note: "디스크 가득 참" });
    // 실패가 더 최근이어도 마지막 "성공" 은 1_000 이다 — 그래야 다음 주기에 다시 시도한다.
    expect(await repo.lastSuccessTs("memories")).toBe(1_000);
  });

  it("실패 기록의 사유(note)를 남긴다 — 조용히 사라지지 않게", async () => {
    await repo.record({ ts: 5_000, path: "", sizeBytes: 0, kind: "memories", status: "error", note: "권한 없음" });
    expect((await repo.recent())[0].note).toBe("권한 없음");
  });
});
