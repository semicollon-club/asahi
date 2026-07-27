import { describe, it, expect } from "vitest";
import { openTestDb, getSchemaVersion, convertLegacyAllowedDirs, type Db } from "../src/store/db.js";
import { AllowedDirsRepo } from "../src/store/allowedDirsRepo.js";

async function tableNames(db: Db): Promise<string[]> {
  const r = await db.query("SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'");
  return (r.rows as Array<{ table_name: string }>).map((row) => row.table_name);
}

describe("새 스키마(Postgres)", () => {
  it("새 정규화 테이블이 모두 생성된다", async () => {
    const db = await openTestDb();
    const names = await tableNames(db);
    for (const t of [
      "users", "conversations", "conversation_participants", "messages",
      "memories", "conversation_summaries", "logs", "actions", "turns", "backups", "triggers", "meta",
    ]) {
      expect(names).toContain(t);
    }
  });

  it("settings 테이블이 있다", async () => {
    const db = await openTestDb();
    const names = await tableNames(db);
    expect(names).toContain("settings");
  });

  it("schema_version 이 기록된다", async () => {
    const db = await openTestDb();
    expect(await getSchemaVersion(db)).toBeGreaterThanOrEqual(2);
  });

  it("messages 에 ILIKE 로 부분 문자열 검색이 된다(FTS5 대체)", async () => {
    const db = await openTestDb();
    await db.query(
      "INSERT INTO conversations (kind, discord_channel_id, primary_user_id, is_private, last_active_ts, status, created_ts) VALUES ('dm','c1','u1',true,1,'active',1)",
    );
    await db.query(
      "INSERT INTO messages (conversation_id, ts, role, user_id, content, processed) VALUES (1,1,'user','u1','병원에 다녀왔다',true)",
    );
    const r = await db.query("SELECT content FROM messages WHERE content ILIKE $1", ["%병원%"]);
    expect((r.rows as Array<{ content: string }>).map((row) => row.content)).toContain("병원에 다녀왔다");
  });
});

// 최종 pre-merge 리뷰 FIX1(치명) — allowed_dirs 의 PK 를 (user_id,dir)→(worker_id,dir) 로 바꾼
// DDL(09a4eb9)은 `CREATE TABLE IF NOT EXISTS` 라서, 이 봇을 한 번이라도 띄운 적 있는 모든 DB 에서
// 그대로 no-op 이었다 — 리뷰가 실제 *pre-merge* DDL 을 적용한 뒤 이 브랜치의 initSchema 를 태워
// column "worker_id" does not exist 로 세 dir 핸들러·fs_* 1차 필터가 전부 깨지는 것을 재현했다
// (빈 테이블에도 재현된다 — 컬럼 해석은 행 수와 무관하다). 아래 테스트는 그 정확한 재현 순서
// (옛 DDL + 행 하나 → 지금의 initSchema)를 pg-mem 으로 고정한다 — 기존 테스트는 전부 openTestDb()
// 로 "빈" DB 를 새로 만들었으므로, 이 시나리오는 테스트 스위트 전체가 초록이었어도 전혀
// 커버되지 않았다(이게 바로 이 버그가 병합 직전까지 살아남은 이유).
describe("allowed_dirs 레거시 전환(최종 pre-merge 리뷰 FIX1) — 옛 user_id 모양의 DB 에서도 봇이 기동한다", () => {
  const legacyDdl = `
    CREATE TABLE IF NOT EXISTS allowed_dirs (
      user_id TEXT NOT NULL,
      dir TEXT NOT NULL,
      PRIMARY KEY (user_id, dir)
    );
  `;

  it("옛 user_id 모양 + 행 하나가 있는 DB 에 현재 initSchema 를 적용하면 실제 핸들러가 쓰는 AllowedDirsRepo 가 worker_id 로 정상 동작한다", async () => {
    const db = await openTestDb({
      beforeSchema: async (raw) => {
        await raw.query(legacyDdl);
        await raw.query("INSERT INTO allowed_dirs (user_id, dir) VALUES ('owner', 'C:\\ws\\legacy')");
      },
    });

    const repo = new AllowedDirsRepo(db);
    // list: 리뷰 재현에서 "column worker_id does not exist" 로 던지던 자리 그대로(allow_dir/
    // revoke_dir/list_dirs 세 핸들러가 전부 이 리포를 거친다).
    expect(await repo.list("semicolon-shared")).toEqual([]);
    await repo.add("semicolon-shared", "C:\\ws");
    expect(await repo.list("semicolon-shared")).toEqual(["C:\\ws"]);
    await repo.remove("semicolon-shared", "C:\\ws");
    expect(await repo.list("semicolon-shared")).toEqual([]);

    // 옛 행(user_id='owner')의 값 자체는 옮기지 않는다 — 설계상 버려도 되는 값이다(재등록이
    // 이관 코드보다 싸다는 09a4eb9/schema.ts 의 결정 그대로).
    const raw = await db.query("SELECT * FROM allowed_dirs");
    expect(raw.rows).toEqual([]);
  });

  it("전환은 멱등이다 — 두 번째 이후 부팅에서 그 사이 쌓인 새 행을 건드리지 않는다", async () => {
    const db = await openTestDb({
      beforeSchema: async (raw) => {
        await raw.query(legacyDdl);
        await raw.query("INSERT INTO allowed_dirs (user_id, dir) VALUES ('owner', 'C:\\ws\\legacy')");
      },
    });
    const repo = new AllowedDirsRepo(db);
    await repo.add("semicolon-shared", "C:\\ws\\new"); // "부팅 1회" 동안 운영자가 실제로 등록한 값.

    // "다음 부팅"을 흉내낸다 — initSchema 가 매 부팅마다 맨 먼저 부르는 그 함수를 다시 부른다.
    // (SCHEMA_SQL 전체를 pg-mem 위에서 두 번 부르는 건 이 기능과 무관한 pg-mem 자체의 한계와
    // 부딪힌다 — pg-mem 은 이미 존재하는 테이블에 대한 CREATE TABLE IF NOT EXISTS 재실행을
    // 지원하지 않는다는 것을 스파이크로 확인했다(현재 코드의 SCHEMA_SQL 을 이 브랜치 변경 없이
    // 그대로 두 번 돌려도 동일하게 던진다 — 이 브랜치가 만든 한계가 아니다). 실제 Postgres 의
    // CREATE TABLE IF NOT EXISTS 재실행은 표준적으로 안전한 no-op 이라 별도 검증이 필요 없고,
    // 여기서 실제로 검증해야 할 새 로직은 우리가 추가한 convertLegacyAllowedDirs 의 멱등성이다.)
    await convertLegacyAllowedDirs(db);

    expect(await repo.list("semicolon-shared")).toEqual(["C:\\ws\\new"]);
  });

  it("이미 새 모양인 DB(신규 설치)에는 아무 영향이 없다", async () => {
    const db = await openTestDb(); // 처음부터 새 스키마로 생성됨
    const repo = new AllowedDirsRepo(db);
    await repo.add("owner-laptop", "C:\\dev");
    await convertLegacyAllowedDirs(db);
    expect(await repo.list("owner-laptop")).toEqual(["C:\\dev"]);
  });
});
