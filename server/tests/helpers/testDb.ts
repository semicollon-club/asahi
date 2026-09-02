import type { Db } from "../../src/db.js";

// pg-mem 인메모리 DB 위에 pg 호환 Pool 을 만든다 (agent/tests 와 같은 방식).
// role·grant·RLS 는 pg-mem 이 지원하지 않으므로 테이블 DDL만 재현한다 —
// 권한 격리는 실제 Supabase에 적용된 마이그레이션(server/migrations)이 담당한다.
export async function openTestDb(): Promise<Db> {
  const { newDb } = await import("pg-mem");
  const mem = newDb({ autoCreateForeignKeyIndices: true });
  const pgAdapter = mem.adapters.createPg();
  const pool = new pgAdapter.Pool() as unknown as Db;
  await pool.query(`
    create schema web;
    create table web.users (
      id uuid primary key,
      username text not null unique,
      display_name text not null,
      password_hash text not null,
      created_at timestamptz not null default now()
    );
    create table web.sessions (
      token_hash text primary key,
      user_id uuid not null references web.users(id) on delete cascade,
      created_at timestamptz not null default now(),
      expires_at timestamptz not null
    );
  `);
  return pool;
}
