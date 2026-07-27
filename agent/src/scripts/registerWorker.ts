// 워커 등록·토큰 발급 CLI. 토큰은 여기서 한 번만 출력되고 DB 에는 해시만 들어간다.
//
// 실행: cd agent && npm run register-worker -- --id semicolon-shared --kind shared --label "동아리 미니PC"
//       cd agent && npm run register-worker -- --id owner-laptop --kind personal --user 123456789
//
// sync-images.mjs 와 달리 .mjs 가 아니라 TS 인 이유는 WorkersRepo·스키마를 그대로 가져다 쓰기
// 위해서다 — 해시 방식이나 컬럼 이름을 스크립트가 따로 적어 두면 본체와 갈린다.
import dotenv from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WorkersRepo, generateWorkerToken, hashWorkerToken, type WorkerKind } from "../store/workersRepo.js";
import { openDb } from "../store/db.js";

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

async function main(): Promise<void> {
  // openDb 가 SCHEMA_SQL 적용과 스키마 버전 기록까지 다 한다(db.ts initSchema) — 봇보다 먼저
  // 돌 수 있는 상황(첫 셋업이 정확히 그 상황이다)에도 index.ts 등 다른 모든 Repo 생성 경로와
  // 동일하게 동작한다. WorkersRepo 는 다른 Repo 들과 똑같이 진짜 Db(Pool)를 받는다 — 어댑터로
  // 흉내 낼 필요가 없다.
  const db = await openDb(databaseUrl);
  try {
    const repo = new WorkersRepo(db);
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
    await db.end();
  }
}

main().catch((err) => {
  console.error("워커 등록 실패:", err);
  process.exit(1);
});
