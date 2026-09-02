import { Pool } from "pg";

// agent/src/store/db.ts 와 같은 계약: 운영은 실제 Postgres Pool,
// 테스트는 pg-mem 이 만들어 주는 pg 호환 Pool. 둘 다 query(text, params)를 제공한다.
export type Db = Pool;

// 운영: Supabase 풀러(세션 모드)에 web_api 전용 role 로 접속한다.
// 이 role 은 web 스키마 DML만 가능하다 — agent 테이블·DDL 불가 (마이그레이션 참조).
export function openDb(connectionString: string): Db {
  return new Pool({ connectionString, max: 5 });
}
