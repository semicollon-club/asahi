// 워커 등록·토큰 발급 CLI. 토큰은 여기서 한 번만 출력되고 DB 에는 해시만 들어간다.
//
// 실행: cd agent && npm run register-worker -- --id semicolon-shared --kind shared --label "동아리 미니PC"
//       cd agent && npm run register-worker -- --id owner-laptop --kind personal --user 123456789
//
// sync-images.mjs 와 달리 .mjs 가 아니라 TS 인 이유는 WorkersRepo·스키마를 그대로 가져다 쓰기
// 위해서다 — 해시 방식이나 컬럼 이름을 스크립트가 따로 적어 두면 본체와 갈린다.
import pg from "pg";
import dotenv from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WorkersRepo, generateWorkerToken, hashWorkerToken, type WorkerKind } from "../store/workersRepo.js";
import { SCHEMA_SQL } from "../store/schema.js";
import type { Db } from "../store/db.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
dotenv.config({ path: path.join(ROOT, ".env") });

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function fail(msg: string): never {
  console.error(msg);
  process.exit(1);
}

const id = arg("id") ?? fail("--id 가 필요합니다 (예: semicolon-shared)");
const kindRaw = arg("kind") ?? fail("--kind 가 필요합니다 (personal | shared)");
if (kindRaw !== "personal" && kindRaw !== "shared") fail("--kind 는 personal 또는 shared 여야 합니다.");
const kind = kindRaw as WorkerKind;
const userId = arg("user") ?? null;
const label = arg("label");

if (kind === "personal" && !userId) fail("--kind personal 에는 --user <디스코드 id> 가 필요합니다.");
if (kind === "shared" && userId) fail("--kind shared 에는 --user 를 주지 않습니다(공용 기계는 담당자가 없습니다).");

const databaseUrl = process.env.DATABASE_URL ?? fail("환경변수 누락: DATABASE_URL — .env 를 확인하세요.");

const client = new pg.Client({ connectionString: databaseUrl });
await client.connect();
try {
  // 봇보다 먼저 돌 수 있다(첫 셋업이 정확히 그 상황이다). 전체 스키마를 여기서도 보장한다 —
  // 전부 IF NOT EXISTS 라 어느 쪽이 먼저 돌든 결과가 같다.
  await client.query(SCHEMA_SQL);

  // Db(=pg.Pool) 타입 그대로는 만들 수 없다 — 이 스크립트는 커넥션 하나(pg.Client)면 충분해
  // Pool 을 쓰지 않는다. WorkersRepo 는 db.query(text, params) 만 호출하므로, 그 한 메서드만
  // client 에 위임하는 어댑터로 충분하다(나머지 Pool 멤버는 애초에 호출되지 않는다).
  const repo = new WorkersRepo({ query: (sql: string, params?: unknown[]) => client.query(sql, params) } as unknown as Db);
  const existing = await repo.getById(id);
  const token = generateWorkerToken();
  await repo.upsert({ id, kind, userId, tokenHash: hashWorkerToken(token), label, ts: Date.now() });

  console.log(existing ? `\n워커 '${id}' 의 토큰을 재발급했습니다.` : `\n워커 '${id}' 를 등록했습니다.`);
  console.log(`  종류: ${kind}${userId ? ` (담당: ${userId})` : ""}`);
  if (label) console.log(`  이름: ${label}`);
  console.log("\n워커 PC 의 .env 에 다음 두 줄을 넣으세요. 이 토큰은 다시 볼 수 없습니다:\n");
  console.log(`WORKER_ID=${id}`);
  console.log(`WORKER_TOKEN=${token}\n`);
  if (existing) {
    console.log("이전 토큰은 무효가 됐지만, 그 토큰으로 이미 붙어 있는 연결은 끊기지 않습니다");
    console.log("— 허브는 인증 시점에만 해시를 봅니다. 즉시 끊어야 하면 봇을 재시작하세요.\n");
  }
} finally {
  await client.end();
}
