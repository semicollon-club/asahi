import pg, { Pool } from "pg";
import type { PoolClient } from "pg";
import { SCHEMA_SQL, SCHEMA_VERSION } from "./schema.js";

// 안전망(T3): 실제 pg 드라이버는 int8(bigint)·COUNT(*) 결과를 문자열로 반환한다.
// Repo 들이 이미 Number(...)로 감싸지만, 전역 타입 파서로 int8 컬럼을 항상 JS number 로
// 파싱해 이중으로 방어한다. pg-mem(openTestDb) 은 와이어 프로토콜을 타지 않으므로 이 파서의
// 영향을 받지 않는다(스파이크로 확인) — 즉 테스트 경로는 그대로다.
pg.types.setTypeParser(20, (v: string | null) => (v === null ? null : Number(v)));

// 팀 계약(T2/T3 의 Repo 들이 생성자 인자로 이 타입을 받는다): pg 의 Pool 그대로.
// 운영에서는 실제 Postgres(Supabase) 에 붙는 Pool, 테스트에서는 pg-mem 이 만들어주는
// pg 호환 Pool 이다 — 둘 다 동일한 `query(text, params)` 인터페이스를 제공한다.
export type Db = Pool;

// 운영: 실제 Postgres 연결 문자열로 Pool 을 만들고 스키마를 보장한다.
export async function openDb(connectionString: string): Promise<Db> {
  const pool = new Pool({ connectionString });
  await initSchema(pool);
  return pool;
}

// 테스트: pg-mem 인메모리 DB 위에 pg 호환 Pool 을 만들어 스키마를 보장한다.
// 기존 코드가 `openDb(":memory:")` 를 많이 쓰던 것을 대체하는 통로 — 테스트는 이걸 쓴다.
// beforeSchema: initSchema 가 실행되기 "전" 원하는 DDL/행을 미리 심어 둘 훅이다(FIX1 회귀
// 테스트 전용 — 예: 리팩터 전 스키마를 재현해 마이그레이션 로직을 검증한다). 생략하면 기존과
// 동일하게 빈 pg-mem 위에 바로 initSchema 를 태운다.
export async function openTestDb(opts?: { beforeSchema?: (db: Db) => Promise<void> }): Promise<Db> {
  const { newDb, DataType } = await import("pg-mem");
  const mem = newDb({ autoCreateForeignKeyIndices: true });

  // pg-mem 은 pg_advisory_xact_lock 을 구현하지 않는다(스파이크로 확인).
  // TurnsRepo(다음 태스크) 가 동시성 제어에 이 함수를 쓸 예정이므로, 테스트에서는
  // no-op 스텁으로 등록해 SQL 이 그대로 실행되게 한다. 실제 동시성 보장은
  // 프로덕션 Postgres 에서만 유효하며, pg-mem 은 트랜잭션이 순차 실행되므로
  // 락 자체를 테스트하지는 못한다(아래 openTestDb 문서 참고).
  mem.public.registerFunction({
    name: "pg_advisory_xact_lock",
    args: [DataType.bigint],
    returns: DataType.bool,
    implementation: () => true,
  });

  // pg-mem 은 strpos() 를 내장하지 않는다(스파이크로 확인). messagesRepo/memoriesRepo 의 검색이
  // ILIKE '%...%' 대신 strpos(lower(x), lower(y)) > 0 를 쓰는 이유: pg-mem 의 LIKE/ILIKE 에뮬레이션은
  // ESCAPE 절 구문 자체를 파싱하지 못하고(스파이크로 확인 — 파싱 실패), 이스케이프 없이도 검색어의
  // %,_ 를 항상 와일드카드로 해석해버려(백슬래시 이스케이프를 전혀 이해하지 못함) 사용자가 검색어에
  // %,_ 를 포함하면 오매칭이 난다. strpos 는 순수 부분문자열 위치 검색이라 와일드카드 해석 자체가
  // 없어 이 문제가 애초에 발생하지 않는다. 실 Postgres 는 strpos 를 내장하므로 이 스텁은 테스트 전용.
  mem.public.registerFunction({
    name: "strpos",
    args: [DataType.text, DataType.text],
    returns: DataType.integer,
    implementation: (haystack: string | null, needle: string | null) => {
      if (haystack === null || needle === null) return null;
      if (needle.length === 0) return 1;
      const idx = haystack.indexOf(needle);
      return idx === -1 ? 0 : idx + 1;
    },
  });

  const { Pool: MemPool } = mem.adapters.createPg();
  const pool = new MemPool() as Db;
  if (opts?.beforeSchema) await opts.beforeSchema(pool);
  await initSchema(pool);
  return pool;
}

async function initSchema(db: Db): Promise<void> {
  await convertLegacyAllowedDirs(db);
  await db.query(SCHEMA_SQL);
  await setSchemaVersion(db, Math.max(await getSchemaVersion(db), SCHEMA_VERSION));
}

// FIX1(치명, 최종 pre-merge 리뷰): allowed_dirs 의 PK 를 (user_id, dir) 에서 (worker_id, dir) 로
// 바꾼 DDL(09a4eb9)은 `CREATE TABLE IF NOT EXISTS` 라서, 이 봇을 한 번이라도 띄운 적 있는 모든
// DB 에서 그대로 no-op 이다 — worker_id 컬럼이 영원히 생기지 않고, allow_dir/revoke_dir/list_dirs
// 와 fs_* 1차 필터가 전부 "column worker_id does not exist" 로 깨진다(리뷰 재현 — 행이 0개인 빈
// 테이블에서도 재현된다. 컬럼 해석은 행 수와 무관하다). 설계 결정(§5.2, allowedDirsRepo.ts 주석)은
// "옛 행은 버리고 워커 등록 후 allow_dir 로 재등록"이므로, 옛 모양의 테이블을 감지하면 여기서 직접
// 버리고 새로 만든다 — 운영자가 수동으로 처리해야 하는 절차로 남기지 않는다.
//
// DO $$ … $$ / ALTER TABLE … RENAME COLUMN 대신 information_schema 조회 + 조건부 DROP 을 쓴 이유는
// pg-mem(테스트 DB) 스파이크로 실측했다: pg-mem 은 정보 스키마 조회는 지원하지만, ① 같은 이름의
// 테이블이 이미 있는 상태에서 `CREATE TABLE IF NOT EXISTS` 를 다시 실행하면(모양이 같든 다르든)
// "AST 일부를 읽지 못했다"는 내부 오류를 던지고, ② `DROP TABLE` 은 그 테이블의 암묵적 PK 인덱스
// (`<table>_pkey`)를 카탈로그에서 지우지 않아 곧이은 재생성이 "relation already exists" 로
// 실패하며, ③ `RENAME COLUMN` 은 컬럼 이름은 바꾸지만 PK 제약이 그 이름을 따라가지 않아
// `ON CONFLICT (worker_id, dir)` 이 깨진다. 아래 순서(DROP TABLE 뒤 그 암묵적 인덱스까지 명시적으로
// DROP)는 이 세 가지를 전부 피해 pg-mem 에서도, 실제 Postgres 에서도 동일하게 동작한다 — 실제
// Postgres 에서는 DROP TABLE 이 이미 그 인덱스를 지우므로 `DROP INDEX IF EXISTS` 는 단순 no-op 이다.
//
// 멱등성은 판정 조건 자체가 보장한다 — 변환 후에는 worker_id 컬럼이 이미 있으므로 이 함수는 두
// 번째 이후 부팅에서 SELECT 한 번만 하고 즉시 반환한다(그 사이 쌓인 새 행에는 손대지 않는다).
export async function convertLegacyAllowedDirs(db: Db): Promise<void> {
  const r = await db.query(
    `SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'allowed_dirs'`,
  );
  const columns = new Set((r.rows as { column_name: string }[]).map((row) => row.column_name));
  if (columns.size === 0) return; // 테이블이 아직 없음 — 아래 SCHEMA_SQL 이 새 모양으로 만든다.
  if (columns.has("worker_id")) return; // 이미 새 모양(변환 완료 또는 신규 설치) — no-op.
  // 여기 도달하면 옛 모양(user_id, dir)이다 — 설계상 버려도 되는 옛 소유자 폴더 몇 개뿐이다.
  await db.query(`DROP TABLE IF EXISTS allowed_dirs`);
  await db.query(`DROP INDEX IF EXISTS allowed_dirs_pkey`);
}

export async function getSchemaVersion(db: Db): Promise<number> {
  const r = await db.query("SELECT value FROM meta WHERE key = 'schema_version'");
  const row = r.rows[0] as { value: string } | undefined;
  return row ? Number(row.value) : 0;
}

export async function setSchemaVersion(db: Db, v: number): Promise<void> {
  await db.query(
    "INSERT INTO meta (key, value) VALUES ('schema_version', $1) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
    [String(v)],
  );
}

// 트랜잭션 헬퍼: 커넥션을 하나 빌려 BEGIN/COMMIT/ROLLBACK 을 감싼다.
// TurnsRepo 같이 "조회 후 조건부 삽입"을 원자적으로 해야 하는 Repo 가 사용한다.
// 주의: pg-mem 은 SQL 레벨 ROLLBACK 을 실제로 되돌리지 않는다(스파이크로 확인).
// 커밋 경로는 pg-mem 으로 검증 가능하지만, "에러 시 롤백됨"을 확인하는 테스트는
// 실제 Postgres(통합 테스트) 에서만 신뢰할 수 있다.
export async function withTx<T>(db: Db, fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}
