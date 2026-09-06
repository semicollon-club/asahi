import { describe, it, expect } from "vitest";
import path from "node:path";
import {
  decideBackupDue, backupFileName, isBackupFile, buildMemoryBackup, pruneList, makeBackupRunner,
  BACKUP_VERSION, type BackupFs,
} from "../src/core/backup.js";
import type { BackupsRepo } from "../src/store/backupsRepo.js";
import type { Memory } from "../src/store/memoriesRepo.js";

// 기억 백업(부원 오픈 게이트 2D). 공용 기억은 부원이 쌓는 유일한 복구 불가 데이터인데 앱 차원의 내보내기
// 경로가 없었다(`backups` 표는 DDL 만 있었다). 판정·조립·정리는 순수 함수로 두고 파일 쓰기만 주입한다.

const HOUR = 60 * 60 * 1000;
const mem = (id: number, over: Partial<Memory> = {}): Memory =>
  ({ id, userId: "u1", scope: "shared", title: `t${id}`, content: `c${id}`, ...over });

describe("decideBackupDue", () => {
  it("백업이 하나도 없으면 곧바로 만든다 — 그 상태가 이 게이트가 걱정하는 상태다", () => {
    expect(decideBackupDue(null, 1_000, 24 * HOUR)).toBe(true);
  });
  it("주기가 안 지났으면 안 만들고, 지났으면 만든다(경계 포함)", () => {
    const last = 1_000_000;
    expect(decideBackupDue(last, last + 24 * HOUR - 1, 24 * HOUR)).toBe(false);
    expect(decideBackupDue(last, last + 24 * HOUR, 24 * HOUR)).toBe(true);
  });
});

describe("backupFileName·isBackupFile", () => {
  it("이름이 시각순으로 정렬된다(문자열 정렬 = 시간 정렬)", () => {
    const a = backupFileName(Date.parse("2026-09-06T01:00:00Z"));
    const b = backupFileName(Date.parse("2026-09-06T02:00:00Z"));
    expect([b, a].sort()).toEqual([a, b]);
    expect(isBackupFile(a)).toBe(true);
  });
  it("백업이 아닌 파일은 걸러낸다", () => {
    expect(isBackupFile("notes.txt")).toBe(false);
    expect(isBackupFile("memories-x.txt")).toBe(false);
  });
});

describe("buildMemoryBackup", () => {
  it("버전·시각·개수와 기억을 그대로 담는다", () => {
    const rows = [mem(1), mem(2, { scope: "user" })];
    expect(buildMemoryBackup(rows, 5_000)).toEqual({ version: BACKUP_VERSION, createdTs: 5_000, count: 2, memories: rows });
  });
});

describe("pruneList — 남길 개수를 넘긴 오래된 것만", () => {
  const files = ["memories-a.json", "memories-b.json", "memories-c.json", "other.txt"];
  it("최신 N개를 남기고 나머지를 돌려준다(백업 아닌 파일은 건드리지 않는다)", () => {
    expect(pruneList(files, 2)).toEqual(["memories-a.json"]);
    expect(pruneList(files, 3)).toEqual([]);
    expect(pruneList(files, 99)).toEqual([]);
  });
  it("keep 이 0 이하면 전부 지울 대상이다", () => {
    expect(pruneList(files, 0)).toEqual(["memories-a.json", "memories-b.json", "memories-c.json"]);
  });
});

// 가짜 파일시스템·저장소로 실행기를 끝까지 돌린다.
function fakes(o: { last?: number | null; memories?: Memory[]; failWrite?: boolean } = {}) {
  const written = new Map<string, string>();
  const unlinked: string[] = [];
  const recorded: Array<Record<string, unknown>> = [];
  const dirs: string[] = [];
  const fs: BackupFs = {
    mkdir: async (d) => { dirs.push(d); },
    writeFile: async (f, data) => { if (o.failWrite) throw new Error("디스크 가득 참"); written.set(f, data); },
    readdir: async () => [...written.keys()].map((f) => path.basename(f)),
    unlink: async (f) => { unlinked.push(path.basename(f)); written.delete(f); },
  };
  const backups = {
    lastSuccessTs: async () => (o.last === undefined ? null : o.last),
    record: async (row: Record<string, unknown>) => { recorded.push(row); },
  } as unknown as BackupsRepo;
  const memories = { all: async () => o.memories ?? [mem(1)] };
  return { fs, backups, memories, written, unlinked, recorded, dirs };
}

describe("makeBackupRunner", () => {
  it("주기가 안 됐으면 아무것도 하지 않는다", async () => {
    const f = fakes({ last: 1_000 });
    const runner = makeBackupRunner({ ...f, dir: "/b", intervalMs: 24 * HOUR, now: () => 1_000 + HOUR });
    await runner.runIfDue();
    expect(f.written.size).toBe(0);
    expect(f.recorded).toHaveLength(0);
  });

  it("주기가 됐으면 JSON 을 쓰고 성공을 표에 남긴다", async () => {
    const f = fakes({ last: null, memories: [mem(1), mem(2)] });
    const runner = makeBackupRunner({ ...f, dir: "/b", now: () => 9_000 });
    await runner.runIfDue();
    expect(f.dirs).toEqual(["/b"]);
    expect(f.written.size).toBe(1);
    const [file, body] = [...f.written.entries()][0];
    expect(path.basename(file)).toBe(backupFileName(9_000));
    const parsed = JSON.parse(body) as { count: number; memories: Memory[] };
    expect(parsed.count).toBe(2);
    expect(parsed.memories[1].title).toBe("t2");
    expect(f.recorded[0]).toMatchObject({ ts: 9_000, kind: "memories", status: "ok", path: file });
    expect(Number(f.recorded[0].sizeBytes)).toBeGreaterThan(0);
  });

  it("성공한 뒤에만 오래된 파일을 정리한다", async () => {
    const f = fakes({ last: null });
    // 이미 둘이 있다고 두고, keep=1 로 돌린다 → 새로 쓴 것 하나만 남아야 한다.
    // 키는 실행기와 같은 방식(path.join)으로 만든다 — 윈도우에서는 구분자가 역슬래시라 문자열로 적으면 안 지워진다.
    f.written.set(path.join("/b", "memories-2026-01-01.json"), "{}");
    f.written.set(path.join("/b", "memories-2026-01-02.json"), "{}");
    const runner = makeBackupRunner({ ...f, dir: "/b", keep: 1, now: () => Date.parse("2026-09-06T00:00:00Z") });
    await runner.runIfDue();
    expect(f.unlinked.sort()).toEqual(["memories-2026-01-01.json", "memories-2026-01-02.json"]);
    expect(f.written.size).toBe(1);
  });

  it("실패해도 던지지 않고 실패를 표에 남긴다(부가 기능이 봇을 죽이지 않는다)", async () => {
    const f = fakes({ last: null, failWrite: true });
    const runner = makeBackupRunner({ ...f, dir: "/b", now: () => 7_000 });
    await expect(runner.runIfDue()).resolves.toBeUndefined();
    expect(f.written.size).toBe(0);
    expect(f.recorded[0]).toMatchObject({ ts: 7_000, kind: "memories", status: "error" });
    expect(String(f.recorded[0].note)).toContain("디스크");
  });
});
