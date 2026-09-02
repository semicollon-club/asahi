import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runMigrations } from "../src/scripts/migrate.js";
import { openTestDb } from "./helpers/testDb.js";

// pg-mem은 DO 블록을 지원하지 않으므로, 러너의 동작(순서·이력·건너뛰기·롤백)을
// 단순한 픽스처 SQL로 검증한다. 실제 마이그레이션 파일은 dev DB(실 Postgres)로 검증한다.
async function fixtureDir(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "mig-"));
  for (const [name, sql] of Object.entries(files)) await writeFile(path.join(dir, name), sql);
  return dir;
}

describe("마이그레이션 러너", () => {
  it("파일명 순서로 적용하고 이력에 기록한다", async () => {
    const db = await openTestDb();
    const dir = await fixtureDir({
      "0002_add_column.sql": "alter table web.notes add column body text",
      "0001_notes.sql": "create table web.notes (id int primary key)",
      "README.md": "무시되어야 함",
    });
    const res = await runMigrations(db, dir);
    expect(res.applied).toEqual(["0001_notes.sql", "0002_add_column.sql"]);
    const cols = await db.query("insert into web.notes (id, body) values (1, 'ok') returning body");
    expect(cols.rows[0].body).toBe("ok");
  });

  it("이미 적용된 파일은 건너뛴다 (두 번 실행해도 안전)", async () => {
    const db = await openTestDb();
    const dir = await fixtureDir({ "0001_notes.sql": "create table web.notes (id int primary key)" });
    await runMigrations(db, dir);
    const second = await runMigrations(db, dir);
    expect(second.applied).toEqual([]);
    expect(second.skipped).toBe(1);
  });

  it("실패한 파일은 이력에 남지 않는다", async () => {
    const db = await openTestDb();
    const dir = await fixtureDir({ "0001_bad.sql": "create table web.broken (definitely not sql" });
    await expect(runMigrations(db, dir)).rejects.toThrow(/0001_bad\.sql/);
    const done = await db.query("select count(*) as c from web.schema_migrations");
    expect(Number(done.rows[0].c)).toBe(0);
  });
});
