import "dotenv/config";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";
import type { Db } from "../db.js";

// 마이그레이션 러너.
// - server/migrations/NNNN_*.sql 을 파일명 순으로, 아직 적용 안 된 것만 실행한다.
// - 적용 이력은 web.schema_migrations 에 파일명으로 기록한다.
// - 각 파일은 트랜잭션으로 감싼다 (Postgres 는 DDL도 롤백 가능).
// - web_migrator role(web 스키마 한정 DDL)로 실행한다 — MIGRATE_DATABASE_URL.
//   운영: Railway pre-deploy 단계에서 자동 실행 / dev: 팀원이 npm run migrate 로 실행.

export async function runMigrations(
  db: Db,
  dir: string,
): Promise<{ applied: string[]; skipped: number }> {
  await db.query("create schema if not exists web");
  // 이력 테이블 보장. (pg-mem 호환: create table if not exists 재실행과 information_schema
  // 조회를 지원하지 않아, 조회 실패 시 생성하는 방식을 쓴다 — 실제 Postgres에서도 동일 동작)
  try {
    await db.query("select 1 from web.schema_migrations limit 0");
  } catch {
    await db.query(
      `create table web.schema_migrations (
         filename text primary key,
         applied_at timestamptz not null default now()
       )`,
    );
    // 심층 방어(다른 web 테이블과 동일 정책). 소유자(web_migrator)는 RLS를 우회하므로 러너 동작에는 영향 없음.
    await db.query("alter table web.schema_migrations enable row level security").catch(() => {});
  }

  const files = (await readdir(dir)).filter((f) => /^\d+_.+\.sql$/.test(f)).sort();
  const doneRes = await db.query("select filename from web.schema_migrations");
  const done = new Set((doneRes.rows as { filename: string }[]).map((r) => r.filename));

  const applied: string[] = [];
  for (const file of files) {
    if (done.has(file)) continue;
    const sql = await readFile(path.join(dir, file), "utf8");
    await db.query("begin");
    try {
      await db.query(sql);
      await db.query("insert into web.schema_migrations (filename) values ($1)", [file]);
      await db.query("commit");
    } catch (e) {
      await db.query("rollback");
      throw new Error(`마이그레이션 실패: ${file} — ${(e as Error).message}`);
    }
    applied.push(file);
  }
  return { applied, skipped: done.size };
}

// CLI 진입점 (dist/scripts/migrate.js 또는 tsx src/scripts/migrate.ts 로 실행)
const isCli = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isCli) {
  const url = process.env.MIGRATE_DATABASE_URL;
  if (!url) {
    console.error("[migrate] MIGRATE_DATABASE_URL 이 필요합니다 (web_migrator role 접속 문자열).");
    process.exit(1);
  }
  const migrationsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../migrations");
  const pool = new Pool({ connectionString: url, max: 1 });
  runMigrations(pool, migrationsDir)
    .then(({ applied, skipped }) => {
      console.log(`[migrate] 완료 — 새로 적용 ${applied.length}건${applied.length ? ` (${applied.join(", ")})` : ""}, 기존 ${skipped}건 유지`);
      return pool.end();
    })
    .catch(async (e) => {
      console.error(`[migrate] ${(e as Error).message}`);
      await pool.end();
      process.exit(1);
    });
}
