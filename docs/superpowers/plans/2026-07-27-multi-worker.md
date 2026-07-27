# 다중 워커 1단계 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 워커에 고유한 신원과 토큰을 주고, 대화 위치로 어느 기계를 쓸지 정하고, 공유 기계 안에서 사용자별로 폴더를 격리한다.

**Architecture:** `workers` 테이블이 워커 신원의 정본이 된다. 허브는 `hello` 의 `workerId` 로 행을 찾아 토큰 해시를 대조한다. 봇은 대화 컨텍스트에서 워커 선택자(개인/공유)를 순수 함수로 뽑아 레지스트리로 실제 워커 id 를 얻고, 그 워커의 허용 폴더에 사용자별 하위 트리를 씌워 경로 1차 필터로 쓴다.

**Tech Stack:** TypeScript ESM, Node 22, vitest, pg + pg-mem, ws, tsx

## Global Constraints

- 스펙 정본: `docs/superpowers/specs/2026-07-27-multi-worker-design.md`. 충돌하면 스펙이 이긴다.
- 주석·커밋 메시지·사용자 노출 문구는 **모두 한국어**.
- `core/` 는 `discord.js` 를 import 하지 않는다. 새 의존성을 추가하지 않는다.
- 베이스라인: `cd agent && npm test` → **584 passed / 1 skipped**. 매 태스크 후 **테스트 실패 0** 을 유지한다.
- `npx tsc --noEmit` 은 Task 2·5 의 끝에서 **의도적으로 빨갛다**(프레임·스키마를 먼저 바꾸고 그 소비자를 다음 태스크가 고치는 구조). 그 두 곳은 각 태스크가 어떤 오류가 남는지 명시한다. 나머지 태스크 끝에서는 반드시 무출력이어야 한다.
- `npx tsc --noEmit` 은 `include: ["src"]` 라 `tests/` 를 검사하지 않는다. 테스트 픽스처의 타입 오류는 tsc 가 아니라 실행으로만 드러난다 — `Config`/`ToolCtx` 리터럴을 만들 때 필드 누락에 주의한다.
- 워커 쪽 최종 경로 관문(`agent/src/remote/roots.ts` 의 `checkPath`)은 **이 계획에서 수정하지 않는다**.
- `sh_exec` 는 경로로 봉쇄되지 않는다(의도된 설계). 이 계획은 그 사실을 바꾸지 않는다.
- 거부 사유 문구는 토큰 오류·신원 오류를 **구분하지 않는다**(인증 오라클 방지, 기존 FIX5).

## 먼저 알아야 할 것 — Task 6 은 지금 깨져 있는 것을 고친다

계획 자체 검토 중 프로브로 확인한 사실이다. 봇 쪽 1차 필터(`isPathWithin`)는 `node:path` 의
**자기 플랫폼 구현**으로 경로를 정규화한다. 봇은 Railway(리눅스)에서 돌고 워커는 윈도우이므로,
리눅스의 `path.resolve` 는 역슬래시를 구분자로 보지 않는다 — 윈도우 경로 전체가 파일명 한 조각으로
취급된다.

프로브 결과(리눅스 플레이버로 현재 로직을 그대로 재현):

```
정상: 허용 폴더 안의 파일   dir=C:\ws        target=C:\ws\my.txt
  리눅스 봇의 현재 판정 = 거부 / 올바른 판정 = 허용   >>> 불일치 <<<
정상: 손님 폴더 안의 파일   dir=C:\ws\111    target=C:\ws\111\my.txt
  리눅스 봇의 현재 판정 = 거부 / 올바른 판정 = 허용   >>> 불일치 <<<
공격: 상위 참조로 남의 폴더 dir=C:\ws\111    target=C:\ws\111\..\222\secret.txt
  리눅스 봇의 현재 판정 = 거부 / 올바른 판정 = 거부   일치
```

**격리가 뚫리는 게 아니라 전부 막힌다(fail-closed).** 즉 지금 Railway 봇 + 윈도우 워커 조합에서는
`fs_read`/`fs_write`/`fs_edit`/`fs_glob`/`fs_grep` 이 모두 "허용된 폴더 밖 경로예요" 로 거부된다.
`sh_exec` 만 이 필터의 대상이 아니라서 동작한다. `deploy/smoke-test.md` 의 "봇 ↔ 워커 실 WebSocket
왕복" 이 아직 미검증인 것과 앞뒤가 맞는다.

Task 6 의 앞부분이 이 문제를 고친다. Task 1~5 는 이 수정에 의존하지 않으므로, 이 버그만 먼저
떼어내 배포하고 싶다면 Task 6 의 Step 1~4 만 별도 브랜치로 진행해도 된다.

## File Structure

| 파일 | 책임 |
|---|---|
| `agent/src/store/schema.ts` | `workers` 테이블 DDL 추가, `allowed_dirs` 키 변경 |
| `agent/src/store/workersRepo.ts` | **신규** — 워커 행 조회·등록·`last_seen_ts` 갱신. 토큰 해시/생성 순수 함수 포함 |
| `agent/src/scripts/registerWorker.ts` | **신규** — 등록 CLI. 토큰을 한 번만 출력 |
| `agent/src/store/allowedDirsRepo.ts` | `user_id` → `worker_id` |
| `agent/src/remote/protocol.ts` | `hello` 의 `userId` → `workerId` |
| `agent/src/remote/hub.ts` | 레지스트리 조회 인증, 3-상태 인증, `workerId` 키잉 |
| `agent/src/remote/workerClient.ts` | `userId` → `workerId` 전송 |
| `agent/src/remote/executors.ts` | `fs_mkdir` 추가 |
| `agent/src/core/workerSelect.ts` | **신규** — `resolveWorkerSelector`·`scopeDirs` 순수 함수 |
| `agent/src/core/paths.ts` | `joinUnderRoot` 추가(플랫폼별 경로 결합) |
| `agent/src/core/agent.ts` | 워커 해석을 선택자 기반으로 교체 |
| `agent/src/core/tools.ts` | 계층 분기에서 `workerConnected` 반영, `ToolCtx.remote` 확장 |
| `agent/src/core/remoteTools.ts` | 신원 재확인 기준 교체, `scopeDirs` 적용, 폴더 자동 생성 |
| `agent/src/config.ts` | 봇 `WORKER_TOKEN` 제거, 워커 `WORKER_ID` 추가 |
| `agent/src/index.ts` | 허브에 레지스트리 주입 |

---

### Task 1: `workers` 테이블 · WorkersRepo · 등록 스크립트

**Files:**
- Modify: `agent/src/store/schema.ts`
- Create: `agent/src/store/workersRepo.ts`
- Create: `agent/src/scripts/registerWorker.ts`
- Modify: `agent/package.json` (scripts 에 `register-worker` 추가)
- Test: `agent/tests/workersRepo.test.ts`

**Interfaces:**
- Produces:
  - `type WorkerKind = "personal" | "shared"`
  - `type WorkerRow = { id: string; kind: WorkerKind; userId: string | null; tokenHash: string; label: string | null; createdTs: number; lastSeenTs: number | null }`
  - `hashWorkerToken(token: string): string` — sha256 hex
  - `generateWorkerToken(): string` — 32바이트 랜덤 hex
  - `class WorkersRepo`
    - `getById(id: string): Promise<WorkerRow | null>`
    - `upsert(o: { id: string; kind: WorkerKind; userId: string | null; tokenHash: string; label?: string; ts: number }): Promise<void>`
    - `touchLastSeen(id: string, ts: number): Promise<void>`
    - `personalWorkerOf(userId: string): Promise<string | null>`
    - `sharedWorkerId(): Promise<string | null>`

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`agent/tests/workersRepo.test.ts` 를 만든다. DB 셋업은 `agent/tests/allowedDirsRepo.test.ts` 와 똑같이 `openTestDb()`(pg-mem, 스키마까지 적용해 준다)를 쓴다.

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { openTestDb } from "../src/store/db.js";
import { WorkersRepo, hashWorkerToken, generateWorkerToken } from "../src/store/workersRepo.js";

describe("hashWorkerToken / generateWorkerToken", () => {
  it("같은 토큰은 같은 해시, 다른 토큰은 다른 해시", () => {
    expect(hashWorkerToken("abc")).toBe(hashWorkerToken("abc"));
    expect(hashWorkerToken("abc")).not.toBe(hashWorkerToken("abd"));
  });

  it("해시는 평문을 담지 않는다", () => {
    expect(hashWorkerToken("secret-token-value")).not.toContain("secret");
  });

  it("생성된 토큰은 매번 다르고 충분히 길다", () => {
    const a = generateWorkerToken();
    const b = generateWorkerToken();
    expect(a).not.toBe(b);
    expect(a.length).toBeGreaterThanOrEqual(64);
  });
});

describe("WorkersRepo", () => {
  let repo: WorkersRepo;

  beforeEach(async () => {
    repo = new WorkersRepo(await openTestDb());
  });

  it("등록한 워커를 id 로 찾는다", async () => {
    await repo.upsert({ id: "semicolon-shared", kind: "shared", userId: null, tokenHash: "h1", label: "동아리 미니PC", ts: 100 });
    const row = await repo.getById("semicolon-shared");
    expect(row).toMatchObject({ id: "semicolon-shared", kind: "shared", userId: null, tokenHash: "h1", label: "동아리 미니PC", createdTs: 100 });
    expect(row?.lastSeenTs).toBeNull();
  });

  it("없는 id 는 null", async () => {
    expect(await repo.getById("없음")).toBeNull();
  });

  it("같은 id 로 다시 등록하면 토큰 해시가 교체된다(회전)", async () => {
    await repo.upsert({ id: "w1", kind: "shared", userId: null, tokenHash: "old", ts: 100 });
    await repo.upsert({ id: "w1", kind: "shared", userId: null, tokenHash: "new", ts: 200 });
    const row = await repo.getById("w1");
    expect(row?.tokenHash).toBe("new");
  });

  it("personal 워커를 담당 사용자로 찾는다", async () => {
    await repo.upsert({ id: "owner-laptop", kind: "personal", userId: "owner", tokenHash: "h", ts: 100 });
    expect(await repo.personalWorkerOf("owner")).toBe("owner-laptop");
    expect(await repo.personalWorkerOf("guest")).toBeNull();
  });

  it("shared 워커를 찾는다 — 없으면 null", async () => {
    expect(await repo.sharedWorkerId()).toBeNull();
    await repo.upsert({ id: "semicolon-shared", kind: "shared", userId: null, tokenHash: "h", ts: 100 });
    expect(await repo.sharedWorkerId()).toBe("semicolon-shared");
  });

  it("shared 워커가 여럿이면 가장 먼저 등록된 것을 돌려준다(결정적)", async () => {
    await repo.upsert({ id: "b-shared", kind: "shared", userId: null, tokenHash: "h", ts: 200 });
    await repo.upsert({ id: "a-shared", kind: "shared", userId: null, tokenHash: "h", ts: 100 });
    expect(await repo.sharedWorkerId()).toBe("a-shared");
  });

  it("last_seen_ts 를 갱신한다", async () => {
    await repo.upsert({ id: "w1", kind: "shared", userId: null, tokenHash: "h", ts: 100 });
    await repo.touchLastSeen("w1", 500);
    expect((await repo.getById("w1"))?.lastSeenTs).toBe(500);
  });
});
```

`tests/helpers/db.ts` 가 없다면, `allowedDirsRepo.test.ts` 가 인라인으로 하고 있는 pg-mem 셋업을 그 파일에서 복사해 이 테스트 파일 안에 인라인으로 둔다(헬퍼 파일을 새로 만들지 말 것 — 기존 테스트들이 각자 셋업하는 패턴을 따른다).

- [ ] **Step 2: 실패를 확인한다**

Run: `cd agent && npx vitest run tests/workersRepo.test.ts`
Expected: FAIL — `Cannot find module '../src/store/workersRepo.js'`

- [ ] **Step 3: 스키마에 `workers` 테이블을 추가한다**

`agent/src/store/schema.ts` 의 SQL 문자열 끝(마지막 `CREATE TABLE` 뒤)에 추가한다.

```sql
-- 워커 신원의 정본. 워커는 hello 프레임에 자기 id 와 토큰을 실어 보내고, 허브가 여기서 행을
-- 찾아 token_hash 를 대조한다(remote/hub.ts). 평문 토큰은 저장하지 않는다 — 발급 시점에
-- 스크립트가 한 번 출력할 뿐이다.
-- kind: 'personal' 이면 user_id 가 담당 사용자, 'shared' 면 NULL(동아리 공용 기계).
CREATE TABLE IF NOT EXISTS workers (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  user_id TEXT,
  token_hash TEXT NOT NULL,
  label TEXT,
  created_ts BIGINT NOT NULL,
  last_seen_ts BIGINT
);
CREATE INDEX IF NOT EXISTS idx_workers_user ON workers(user_id);
```

- [ ] **Step 4: WorkersRepo 를 만든다**

`agent/src/store/workersRepo.ts`:

```ts
import { createHash, randomBytes } from "node:crypto";
import type { Db } from "./db.js";

export type WorkerKind = "personal" | "shared";

export type WorkerRow = {
  id: string;
  kind: WorkerKind;
  userId: string | null;
  tokenHash: string;
  label: string | null;
  createdTs: number;
  lastSeenTs: number | null;
};

// 토큰은 평문으로 저장하지 않는다. DB 가 유출돼도 그 값만으로는 워커로 붙지 못한다.
// 토큰 자체가 128비트 이상의 고엔트로피 랜덤이라 사전 공격 대상이 아니므로 salt·KDF 없이
// 단순 해시로 충분하다(사람이 고른 비밀번호가 아니다).
export function hashWorkerToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export function generateWorkerToken(): string {
  return randomBytes(32).toString("hex");
}

type Raw = {
  id: string; kind: string; user_id: string | null; token_hash: string;
  label: string | null; created_ts: number | string; last_seen_ts: number | string | null;
};

// pg 는 BIGINT 를 문자열로 돌려줄 수 있다(정밀도 보존). 다른 레포들과 같은 방식으로 숫자화한다.
function toRow(r: Raw): WorkerRow {
  return {
    id: r.id,
    kind: r.kind === "personal" ? "personal" : "shared",
    userId: r.user_id,
    tokenHash: r.token_hash,
    label: r.label,
    createdTs: Number(r.created_ts),
    lastSeenTs: r.last_seen_ts === null ? null : Number(r.last_seen_ts),
  };
}

export class WorkersRepo {
  constructor(private db: Db) {}

  async getById(id: string): Promise<WorkerRow | null> {
    const r = await this.db.query("SELECT * FROM workers WHERE id = $1", [id]);
    const row = (r.rows as Raw[])[0];
    return row ? toRow(row) : null;
  }

  // 같은 id 로 다시 부르면 토큰 해시가 교체된다(회전·폐기 경로). created_ts 는 유지한다 —
  // "언제 처음 등록했는가"는 회전으로 사라져선 안 되는 정보다.
  async upsert(o: { id: string; kind: WorkerKind; userId: string | null; tokenHash: string; label?: string; ts: number }): Promise<void> {
    await this.db.query(
      `INSERT INTO workers (id, kind, user_id, token_hash, label, created_ts)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (id) DO UPDATE SET
         kind = EXCLUDED.kind,
         user_id = EXCLUDED.user_id,
         token_hash = EXCLUDED.token_hash,
         label = EXCLUDED.label`,
      [o.id, o.kind, o.userId, o.tokenHash, o.label ?? null, o.ts],
    );
  }

  async touchLastSeen(id: string, ts: number): Promise<void> {
    await this.db.query("UPDATE workers SET last_seen_ts = $1 WHERE id = $2", [ts, id]);
  }

  async personalWorkerOf(userId: string): Promise<string | null> {
    const r = await this.db.query(
      "SELECT id FROM workers WHERE kind = 'personal' AND user_id = $1 ORDER BY created_ts LIMIT 1",
      [userId],
    );
    return (r.rows as { id: string }[])[0]?.id ?? null;
  }

  // 공용 워커가 여러 대인 상황은 1단계에서 만들지 않지만, 그래도 결정적으로 하나를 고른다 —
  // 정렬 없이 LIMIT 1 을 쓰면 어느 행이 나올지 DB 가 정한다.
  async sharedWorkerId(): Promise<string | null> {
    const r = await this.db.query("SELECT id FROM workers WHERE kind = 'shared' ORDER BY created_ts, id LIMIT 1");
    return (r.rows as { id: string }[])[0]?.id ?? null;
  }
}
```

- [ ] **Step 5: 테스트 통과를 확인한다**

Run: `cd agent && npx vitest run tests/workersRepo.test.ts`
Expected: PASS (13개)

- [ ] **Step 6: 등록 스크립트를 만든다**

`agent/src/scripts/registerWorker.ts`:

```ts
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

  const repo = new WorkersRepo({ query: (sql, params) => client.query(sql, params) });
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
```

`SCHEMA_SQL` 은 `agent/src/store/schema.ts:10` 이 이미 export 하고 있다(`SCHEMA_VERSION` 과 함께). 스키마 SQL 을 스크립트에 복사하지 말 것 — 한 곳에만 있어야 한다.

- [ ] **Step 7: npm 스크립트를 추가한다**

`agent/package.json` 의 `scripts` 에 추가한다(`sync-images` 바로 아래):

```json
"register-worker": "tsx src/scripts/registerWorker.ts"
```

- [ ] **Step 8: 전체 검증**

Run: `cd agent && npm test && npx tsc --noEmit && npm run build`
Expected: 실패 0(베이스라인 584 + 이 태스크가 추가한 테스트 수), 1 skipped, tsc 무출력, 빌드 성공

- [ ] **Step 9: 커밋**

```bash
git add agent/src/store agent/src/scripts agent/tests/workersRepo.test.ts agent/package.json && git commit -m "feat(store): workers 테이블·레포·등록 스크립트"
```

---

### Task 2: `hello` 프레임을 workerId 로 바꾼다

**Files:**
- Modify: `agent/src/remote/protocol.ts:4`, `:33-36`
- Test: `agent/tests/remoteProtocol.test.ts`

**Interfaces:**
- Consumes: 없음
- Produces: `type WorkerHello = { type: "hello"; token: string; workerId: string; roots: string[] }`

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`agent/tests/remoteProtocol.test.ts` 끝에 추가한다.

```ts
describe("hello — 신원이 userId 에서 workerId 로 바뀐다", () => {
  it("workerId 가 있는 hello 를 파싱한다", () => {
    const raw = JSON.stringify({ type: "hello", token: "t", workerId: "semicolon-shared", roots: ["C:\\ws"] });
    expect(parseFrame(raw)).toEqual({ type: "hello", token: "t", workerId: "semicolon-shared", roots: ["C:\\ws"] });
  });

  it("옛 형식(userId)은 거부한다 — 구버전 워커가 조용히 붙으면 안 된다", () => {
    const raw = JSON.stringify({ type: "hello", token: "t", userId: "123", roots: ["/ws"] });
    expect(parseFrame(raw)).toBeNull();
  });

  it("workerId 가 문자열이 아니면 거부한다", () => {
    for (const bad of [123, null, {}, []]) {
      const raw = JSON.stringify({ type: "hello", token: "t", workerId: bad, roots: ["/ws"] });
      expect(parseFrame(raw)).toBeNull();
    }
  });

  it("encode → parse 왕복이 보존된다", () => {
    const f = { type: "hello" as const, token: "t", workerId: "w1", roots: ["/a", "/b"] };
    expect(parseFrame(encodeFrame(f))).toEqual(f);
  });
});
```

- [ ] **Step 2: 실패를 확인한다**

Run: `cd agent && npx vitest run tests/remoteProtocol.test.ts`
Expected: FAIL — 첫 테스트가 `null` 을 받는다(파서가 아직 `userId` 를 요구한다)

- [ ] **Step 3: 구현한다**

`agent/src/remote/protocol.ts:4` 를 바꾼다.

```ts
// workerId: "나는 누구의 워커다"가 아니라 "나는 어느 워커다". 허브가 이 값으로 workers 행을
// 찾아 토큰 해시를 대조한다. 옛 형식(userId)은 파서가 거부하므로 구버전 워커는 조용히 붙지 못하고
// 명확히 실패한다 — 이게 의도된 동작이다.
export type WorkerHello = { type: "hello"; token: string; workerId: string; roots: string[] };
```

`:33-36` 의 `case "hello"` 를 바꾼다.

```ts
    case "hello":
      return isStr(v.token) && isStr(v.workerId) && isStrArray(v.roots)
        ? { type: "hello", token: v.token, workerId: v.workerId, roots: v.roots }
        : null;
```

- [ ] **Step 4: 테스트 통과를 확인한다**

Run: `cd agent && npx vitest run tests/remoteProtocol.test.ts`
Expected: PASS

- [ ] **Step 5: 컴파일 오류를 확인한다**

Run: `cd agent && npx tsc --noEmit`
Expected: `hub.ts` 와 `workerClient.ts` 에서 `userId` 관련 오류. **이 태스크에서는 고치지 않는다** — Task 3·4 가 각각 담당한다. 오류 목록을 그대로 기록해 두고 다음으로 넘어간다.

- [ ] **Step 6: 커밋**

`tsc` 가 아직 빨간 상태이므로 이 커밋은 중간 상태다. 다음 태스크와 함께 초록이 된다.

```bash
git add agent/src/remote/protocol.ts agent/tests/remoteProtocol.test.ts && git commit -m "feat(remote): hello 프레임 신원을 workerId 로 교체"
```

---

### Task 3: 허브 — 레지스트리 인증과 3-상태 인증

**Files:**
- Modify: `agent/src/remote/hub.ts:56-140`
- Test: `agent/tests/remoteHub.test.ts`

**Interfaces:**
- Consumes: `WorkersRepo.getById`, `WorkersRepo.touchLastSeen`, `hashWorkerToken` (Task 1); `WorkerHello.workerId` (Task 2)
- Produces:
  - `WorkerHub` 생성자가 `{ registry: WorkerRegistry; now?: () => number; callTimeoutMs?; helloTimeoutMs? }` 를 받는다 (`token`·`ownerId` 제거)
  - `type WorkerRegistry = { getById(id: string): Promise<{ tokenHash: string } | null>; touchLastSeen(id: string, ts: number): Promise<void> }`
  - `isConnected(workerId)`·`rootsOf(workerId)`·`call(workerId, ...)` — 인자 의미가 userId 에서 workerId 로 바뀐다(시그니처 형태는 동일)

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`agent/tests/remoteHub.test.ts` 를 연다. 기존 테스트가 `new WorkerHub({ token, ownerId })` 로 만들고 있을 것이다. 그 헬퍼를 레지스트리 기반으로 바꾸고 아래를 추가한다.

```ts
// 가짜 레지스트리. 실제 DB 없이 허브의 인증 판정만 검증한다.
function fakeRegistry(rows: Record<string, string>) {
  const seen: Array<{ id: string; ts: number }> = [];
  return {
    seen,
    getById: async (id: string) => (rows[id] ? { tokenHash: rows[id] } : null),
    touchLastSeen: async (id: string, ts: number) => { seen.push({ id, ts }); },
  };
}

describe("WorkerHub — 워커 레지스트리 인증", () => {
  it("등록된 워커가 올바른 토큰으로 붙으면 ready 를 받는다", async () => {
    const registry = fakeRegistry({ "semicolon-shared": hashWorkerToken("good-token") });
    const hub = new WorkerHub({ registry, now: () => 777 });
    const s = fakeSocket();
    hub.handleConnection(s);
    s.emit(JSON.stringify({ type: "hello", token: "good-token", workerId: "semicolon-shared", roots: ["/ws"] }));
    await flush();

    expect(s.sent).toContain(JSON.stringify({ type: "ready" }));
    expect(hub.isConnected("semicolon-shared")).toBe(true);
    expect(registry.seen).toEqual([{ id: "semicolon-shared", ts: 777 }]);
  });

  it("등록되지 않은 workerId 는 거부된다", async () => {
    const hub = new WorkerHub({ registry: fakeRegistry({}) });
    const s = fakeSocket();
    hub.handleConnection(s);
    s.emit(JSON.stringify({ type: "hello", token: "any", workerId: "없는워커", roots: ["/ws"] }));
    await flush();

    expect(s.closed).toBe(true);
    expect(hub.isConnected("없는워커")).toBe(false);
  });

  it("토큰이 틀리면 거부된다", async () => {
    const registry = fakeRegistry({ w1: hashWorkerToken("real") });
    const hub = new WorkerHub({ registry });
    const s = fakeSocket();
    hub.handleConnection(s);
    s.emit(JSON.stringify({ type: "hello", token: "fake", workerId: "w1", roots: ["/ws"] }));
    await flush();

    expect(s.closed).toBe(true);
    expect(hub.isConnected("w1")).toBe(false);
  });

  it("'없는 워커'와 '틀린 토큰'의 거부 문구가 완전히 같다 — 인증 오라클 방지", async () => {
    const registry = fakeRegistry({ w1: hashWorkerToken("real") });

    const s1 = fakeSocket();
    new WorkerHub({ registry }).handleConnection(s1);
    s1.emit(JSON.stringify({ type: "hello", token: "real", workerId: "없음", roots: ["/ws"] }));
    await flush();

    const s2 = fakeSocket();
    new WorkerHub({ registry }).handleConnection(s2);
    s2.emit(JSON.stringify({ type: "hello", token: "틀림", workerId: "w1", roots: ["/ws"] }));
    await flush();

    expect(s1.sent).toEqual(s2.sent);
  });

  it("인증 조회 중(authenticating) 도착한 프레임은 처리되지 않고 연결이 끊긴다", async () => {
    // getById 를 테스트가 직접 풀어줄 때까지 붙잡아 authenticating 상태를 관찰한다.
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const registry = {
      getById: async (id: string) => { await gate; return { tokenHash: hashWorkerToken("t") }; },
      touchLastSeen: async () => {},
    };
    const hub = new WorkerHub({ registry });
    const s = fakeSocket();
    hub.handleConnection(s);

    s.emit(JSON.stringify({ type: "hello", token: "t", workerId: "w1", roots: ["/ws"] }));
    // 아직 조회가 안 끝난 상태에서 다음 프레임이 도착한다.
    s.emit(JSON.stringify({ type: "result", id: "1", ok: true, content: "몰래" }));
    expect(s.closed).toBe(true);

    release();
    await flush();
    // 연결이 끊겼으므로 인증도 성립하지 않는다.
    expect(hub.isConnected("w1")).toBe(false);
  });

  it("hello 를 두 번 보내면 끊는다", async () => {
    const registry = fakeRegistry({ w1: hashWorkerToken("t") });
    const hub = new WorkerHub({ registry });
    const s = fakeSocket();
    hub.handleConnection(s);
    s.emit(JSON.stringify({ type: "hello", token: "t", workerId: "w1", roots: ["/ws"] }));
    await flush();
    s.emit(JSON.stringify({ type: "hello", token: "t", workerId: "w1", roots: ["/ws"] }));
    expect(s.closed).toBe(true);
  });

  it("같은 workerId 로 재연결하면 이전 연결이 정리된다", async () => {
    const registry = fakeRegistry({ w1: hashWorkerToken("t") });
    const hub = new WorkerHub({ registry });

    const s1 = fakeSocket();
    hub.handleConnection(s1);
    s1.emit(JSON.stringify({ type: "hello", token: "t", workerId: "w1", roots: ["/a"] }));
    await flush();

    const s2 = fakeSocket();
    hub.handleConnection(s2);
    s2.emit(JSON.stringify({ type: "hello", token: "t", workerId: "w1", roots: ["/b"] }));
    await flush();

    expect(s1.closed).toBe(true);
    expect(hub.isConnected("w1")).toBe(true);
    expect(hub.rootsOf("w1")).toEqual(["/b"]);
  });
});
```

`fakeSocket`·`flush` 는 기존 `remoteHub.test.ts` 에 이미 있는 헬퍼를 쓴다. 없으면 그 파일의 기존 테스트가 쓰는 방식을 그대로 따른다. `hashWorkerToken` 을 `../src/store/workersRepo.js` 에서 import 한다.

- [ ] **Step 2: 실패를 확인한다**

Run: `cd agent && npx vitest run tests/remoteHub.test.ts`
Expected: FAIL — 생성자가 `registry` 를 모른다

- [ ] **Step 3: 허브를 고친다**

`agent/src/remote/hub.ts` 에서 `import` 에 해시 함수를 추가한다.

```ts
import { hashWorkerToken } from "../store/workersRepo.js";
```

`tokensMatch` 는 그대로 두되(상수 시간 비교), 이제 **해시끼리** 비교한다. `WorkerHub` 클래스를 바꾼다.

```ts
// 허브가 인증에 필요한 최소 인터페이스. WorkersRepo 전체를 받지 않는 이유는 테스트에서
// 가짜를 만들기 쉽게 하기 위해서다 — 허브는 조회와 접속 기록만 필요하다.
export type WorkerRegistry = {
  getById(id: string): Promise<{ tokenHash: string } | null>;
  touchLastSeen(id: string, ts: number): Promise<void>;
};

// 인증 상태. authenticating 은 hello 를 받아 레지스트리를 조회하는 중이라는 뜻이고, 그 사이
// 도착한 프레임은 무조건 연결 종료로 다룬다 — 조회가 비동기가 되면서 생긴 창이라, 여기서
// 얼버무리면 "인증 전 프레임은 즉시 끊는다"는 기존 규칙에 구멍이 난다.
type AuthState = "unauth" | "authenticating" | "authed";

export class WorkerHub {
  private conns = new Map<string, Conn>();
  private unauthSockets = new Map<HubSocket, ReturnType<typeof setTimeout>>();
  private seq = 0;
  private registry: WorkerRegistry;
  private now: () => number;
  private callTimeoutMs: number;
  private helloTimeoutMs: number;

  constructor(opts: { registry: WorkerRegistry; now?: () => number; callTimeoutMs?: number; helloTimeoutMs?: number }) {
    this.registry = opts.registry;
    this.now = opts.now ?? Date.now;
    this.callTimeoutMs = opts.callTimeoutMs ?? DEFAULT_CALL_TIMEOUT_MS;
    this.helloTimeoutMs = opts.helloTimeoutMs ?? DEFAULT_HELLO_TIMEOUT_MS;
  }

  handleConnection(socket: HubSocket): void {
    let state: AuthState = "unauth";
    let workerId: string | null = null;

    const helloTimer = setTimeout(() => {
      this.unauthSockets.delete(socket);
      socket.close();
    }, this.helloTimeoutMs);
    this.unauthSockets.set(socket, helloTimer);

    socket.onMessage((raw) => {
      if (raw.length > MAX_FRAME_CHARS) { socket.close(); return; }

      const frame = parseFrame(raw);
      if (!frame) { socket.close(); return; }

      // 조회 중에는 어떤 프레임도 받지 않는다(hello 재전송 포함).
      if (state === "authenticating") { socket.close(); return; }

      if (state === "unauth") {
        if (frame.type !== "hello") { socket.close(); return; }
        state = "authenticating";
        // 조회는 비동기다. 이 프로미스는 절대 reject 되지 않게 감싼다 — 여기서 던지면
        // onMessage 콜백 밖으로 새어 프로세스 전체가 죽는다.
        void this.authenticate(socket, frame.workerId, frame.token, frame.roots)
          .then((ok) => {
            if (!ok) { state = "unauth"; return; }  // 이미 close() 된 상태
            state = "authed";
            workerId = frame.workerId;
          })
          .catch((e) => {
            console.error("[hub] 인증 처리 오류:", e);
            state = "unauth";
            socket.close();
          });
        return;
      }

      // state === "authed"
      if (frame.type === "hello") { socket.close(); return; }
      if (workerId === null) return;
      const conn = this.conns.get(workerId);
      if (!conn || conn.socket !== socket) return;
      if (frame.type === "result") {
        const p = conn.pending.get(frame.id);
        if (!p) return;
        conn.pending.delete(frame.id);
        clearTimeout(p.timer);
        p.resolve({ ok: frame.ok, content: frame.content });
      } else if (frame.type === "ping") {
        socket.send(encodeFrame({ type: "pong" }));
      }
    });

    socket.onClose(() => {
      this.clearHelloTimer(socket);
      if (workerId === null) return;
      const conn = this.conns.get(workerId);
      if (!conn || conn.socket !== socket) return;
      this.conns.delete(workerId);
      this.failAllPending(conn, "워커 연결이 끊겼어요.");
    });
  }

  // 성공하면 conns 에 등록하고 true, 실패하면 denied 를 보내고 닫은 뒤 false.
  private async authenticate(socket: HubSocket, workerId: string, token: string, roots: string[]): Promise<boolean> {
    const row = await this.registry.getById(workerId);
    // FIX5 유지: "그런 워커 없음"과 "토큰 틀림"을 구분하지 않는다. 구분하면 인증되지 않은
    // 클라이언트가 유효한 workerId 를 캐낼 수 있는 오라클이 된다. 행이 없어도 해시 비교를
    // 흉내내 응답 시간 차이도 줄인다.
    const expected = row?.tokenHash ?? hashWorkerToken("");
    const ok = row !== null && tokensMatch(hashWorkerToken(token), expected);
    if (!ok) {
      socket.send(encodeFrame({ type: "denied", reason: DENIED_REASON }));
      socket.close();
      return false;
    }

    this.clearHelloTimer(socket);
    this.dropExisting(workerId);
    this.conns.set(workerId, { socket, roots, pending: new Map() });
    socket.send(encodeFrame({ type: "ready" }));
    // 접속 기록은 실패해도 인증을 되돌리지 않는다 — 부가 정보다.
    await this.registry.touchLastSeen(workerId, this.now()).catch(() => {});
    return true;
  }
```

`isConnected`/`rootsOf`/`call`/`dropExisting` 의 파라미터 이름을 `userId` → `workerId` 로 바꾼다(동작 동일). `closeAll` 의 루프 변수도 마찬가지다.

- [ ] **Step 4: 테스트 통과를 확인한다**

Run: `cd agent && npx vitest run tests/remoteHub.test.ts`
Expected: PASS

- [ ] **Step 5: 커밋**

```bash
git add agent/src/remote/hub.ts agent/tests/remoteHub.test.ts && git commit -m "feat(remote): 허브 인증을 워커 레지스트리 기반으로 전환"
```

---

### Task 4: 배선 — 워커 클라이언트·설정·index

**Files:**
- Modify: `agent/src/remote/workerClient.ts:46`
- Modify: `agent/src/config.ts:17-57`, `:92-119`
- Modify: `agent/src/index.ts:66`
- Modify: `agent/.env.example`
- Test: `agent/tests/config.test.ts`, `agent/tests/remoteWorkerClient.test.ts`

**Interfaces:**
- Consumes: `WorkerRegistry` (Task 3), `WorkersRepo` (Task 1)
- Produces: `WorkerConfig.workerId` (`WORKER_ID` 환경변수). 봇 `Config` 에서 `workerToken` 제거

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`agent/tests/config.test.ts` 에 추가한다.

```ts
describe("워커 설정 — WORKER_ID", () => {
  const base = {
    DISCORD_OWNER_ID: "owner", WORKER_ID: "semicolon-shared",
    WORKER_TOKEN: "x".repeat(40), HUB_URL: "wss://h/worker", WORKER_ROOTS: "C:\\ws",
  };

  it("WORKER_ID 를 읽는다", () => {
    expect(loadWorkerConfig(base).workerId).toBe("semicolon-shared");
  });

  it("WORKER_ID 가 없으면 기동에 실패한다", () => {
    const { WORKER_ID, ...without } = base;
    expect(() => loadWorkerConfig(without)).toThrow(/WORKER_ID/);
  });

  it("옛 WORKER_USER_ID 만 있으면 실패한다 — 조용히 무시하지 않는다", () => {
    const { WORKER_ID, ...without } = base;
    expect(() => loadWorkerConfig({ ...without, WORKER_USER_ID: "123" })).toThrow(/WORKER_ID/);
  });
});

describe("봇 설정 — WORKER_TOKEN 제거", () => {
  it("WORKER_TOKEN 없이도 봇 설정이 로드된다(워커 신원은 이제 DB 에 있다)", () => {
    const cfg = loadConfig({
      DISCORD_TOKEN: "t", DISCORD_OWNER_ID: "o", DATABASE_URL: "postgres://x",
    });
    expect(cfg.ownerId).toBe("o");
    expect("workerToken" in cfg).toBe(false);
  });
});
```

- [ ] **Step 2: 실패를 확인한다**

Run: `cd agent && npx vitest run tests/config.test.ts`
Expected: FAIL

- [ ] **Step 3: 설정을 고친다**

`agent/src/config.ts`:
- 봇 `Config` 에서 `workerToken` 필드를 지우고, `missing` 목록에서 `"WORKER_TOKEN"` 을 뺀다. `MIN_WORKER_TOKEN_LENGTH` 검사와 그 상수도 지운다(워커 쪽으로 옮기지 않는다 — 이제 토큰을 사람이 정하지 않고 스크립트가 생성하므로 길이 검사가 의미 없다).
- `WorkerConfig` 의 `workerUserId` 를 `workerId` 로 바꾸고, `missing` 목록의 `"WORKER_USER_ID"` 를 `"WORKER_ID"` 로 바꾼다. `"DISCORD_OWNER_ID"` 도 워커 필수 목록에서 뺀다 — 워커는 더 이상 소유자가 누구인지 알 필요가 없다.

```ts
export function loadWorkerConfig(env: NodeJS.ProcessEnv = process.env): WorkerConfig {
  const missing = ["WORKER_ID", "WORKER_TOKEN", "HUB_URL", "WORKER_ROOTS"].filter((k) => !env[k]);
  if (missing.length > 0) throw new Error(`환경변수 누락: ${missing.join(", ")}`);
  // ... roots 파싱은 그대로 ...
  return {
    workerId: env.WORKER_ID as string,
    workerToken: env.WORKER_TOKEN as string,
    hubUrl: env.HUB_URL as string,
    roots,
  };
}
```

`agent/src/remote/workerClient.ts:46` 의 hello 전송을 바꾼다.

```ts
        socket.send(encodeFrame({ type: "hello", token: opts.token, workerId: opts.workerId, roots: opts.roots }));
```

`workerClient` 의 `opts` 타입에서 `userId` 를 `workerId` 로 바꾸고, `agent/src/worker.ts` 의 호출부도 `workerId: cfg.workerId` 로 바꾼다.

`agent/src/index.ts:66` 의 허브 생성을 바꾼다. `repos` 에 `workers: new WorkersRepo(db)` 를 추가한 뒤:

```ts
  const hub = new WorkerHub({ registry: repos.workers });
```

`agent/.env.example` 에서 봇 쪽 `WORKER_TOKEN` 항목을 지우고, 워커 쪽에 `WORKER_ID` 를 추가한다. 두 값 모두 `npm run register-worker` 가 출력한다고 적는다.

- [ ] **Step 4: 테스트 통과를 확인한다**

Run: `cd agent && npm test && npx tsc --noEmit && npm run build`
Expected: 실패 0, tsc 무출력, 빌드 성공. `remoteWorkerClient.test.ts` 의 기존 테스트가 `userId` 를 쓰고 있으면 `workerId` 로 고친다(단언 값은 바꾸지 않는다).

- [ ] **Step 5: 커밋**

```bash
git add agent/src agent/tests agent/.env.example && git commit -m "feat(remote): 워커 신원 배선을 WORKER_ID 로 전환"
```

---

### Task 5: `allowed_dirs` 를 워커 기준으로 바꾼다

**Files:**
- Modify: `agent/src/store/schema.ts:194-198`
- Modify: `agent/src/store/allowedDirsRepo.ts`
- Modify: `agent/src/core/tools.ts` (allowDir/revokeDir/listDirs 핸들러)
- Test: `agent/tests/allowedDirsRepo.test.ts`

**Interfaces:**
- Produces: `AllowedDirsRepo.list(workerId)`·`add(workerId, dir)`·`remove(workerId, dir)` — 첫 인자의 의미가 userId 에서 workerId 로 바뀐다

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`agent/tests/allowedDirsRepo.test.ts` 의 기존 테스트에서 첫 인자 이름을 `workerId` 로 바꾸고(값은 `"owner-laptop"` 같은 워커 id 로), 아래를 추가한다.

```ts
it("서로 다른 워커의 목록은 섞이지 않는다", async () => {
  await repo.add("owner-laptop", "C:\\dev");
  await repo.add("semicolon-shared", "C:\\workspace");
  expect(await repo.list("owner-laptop")).toEqual(["C:\\dev"]);
  expect(await repo.list("semicolon-shared")).toEqual(["C:\\workspace"]);
});
```

- [ ] **Step 2: 실패를 확인한다**

Run: `cd agent && npx vitest run tests/allowedDirsRepo.test.ts`
Expected: FAIL — 컬럼 이름이 `user_id` 라 새 테스트가 통과할 수 없다(pg-mem 은 컬럼 없음 오류를 낸다)

- [ ] **Step 3: 스키마와 레포를 고친다**

`agent/src/store/schema.ts:194-198`:

```sql
-- 워커별로 원격 작업을 허용한 폴더 목록. 예전에는 user_id 키였는데, "한 사람 = 한 대"가
-- 성립할 때만 맞는 전제였다 — 공용 워커가 생기면서 폴더는 사람이 아니라 기계에 속한다는
-- 사실에 맞췄다. 마이그레이션은 하지 않는다(옛 행은 소유자 폴더 몇 개뿐이라 재등록이 싸다).
CREATE TABLE IF NOT EXISTS allowed_dirs (
  worker_id TEXT NOT NULL,
  dir TEXT NOT NULL,
  PRIMARY KEY (worker_id, dir)
);
```

`agent/src/store/allowedDirsRepo.ts` 의 세 메서드에서 `user_id` → `worker_id`, 파라미터 이름 `userId` → `workerId`, 파일 상단 주석도 새 사실에 맞게 고친다.

`agent/src/core/tools.ts` 의 `allowDirHandler`/`revokeDirHandler`/`listDirsHandler` 가 `ctx.userId` 를 넘기고 있다. `ctx.remote` 에 워커 id 를 실어 보내야 한다 — Task 6 에서 `ToolCtx.remote.workerId` 를 추가하므로, 이 태스크에서는 **먼저 그 필드를 추가**한다.

`agent/src/core/tools.ts` 의 `ToolCtx.remote` 를 확장한다.

```ts
  remote?: {
    call(tool: string, args: Record<string, unknown>): Promise<{ ok: boolean; content: string }>;
    roots: string[];
    // 이 턴이 쓰는 워커의 id. allowed_dirs 가 워커 기준이 되면서 필요해졌다 —
    // "누가 물어보는가"(ctx.userId)와 "어느 기계인가"(이 값)는 이제 다른 축이다.
    workerId: string;
  };
```

세 핸들러에서 `ctx.userId` 대신 `ctx.remote.workerId` 를 쓴다. `ctx.remote` 가 없으면 이미 기존 코드가 거부하고 있으므로 그 분기를 그대로 둔다.

- [ ] **Step 4: 테스트 통과를 확인한다**

Run: `cd agent && npm test`
Expected: `agent.ts` 의 `buildRemoteCtx` 가 아직 `workerId` 를 채우지 않아 tsc 가 빨갛다. 테스트는 통과하되 `npx tsc --noEmit` 에서 오류가 남는다 — Task 6 이 채운다. 오류가 `buildRemoteCtx` 한 곳뿐인지 확인한다.

- [ ] **Step 5: 커밋**

```bash
git add agent/src/store agent/src/core/tools.ts agent/tests/allowedDirsRepo.test.ts && git commit -m "feat(store): allowed_dirs 를 워커 기준으로 전환"
```

---

### Task 6: 플랫폼 인식 경로 비교 · 워커 선택과 폴더 스코프

이 태스크는 두 부분이다. **앞부분(Step 1~4)은 지금 깨져 있는 것을 고치고**(위 "먼저 알아야 할 것"
참고), 뒷부분(Step 5~8)이 새 기능을 얹는다. 앞부분만 따로 배포해도 된다.

**Files:**
- Modify: `agent/src/core/paths.ts`
- Create: `agent/src/core/workerSelect.ts`
- Test: `agent/tests/paths.test.ts`, `agent/tests/workerSelect.test.ts`

**Interfaces:**
- Produces:
  - `pathFlavorOf(p: string): path.PlatformPath` (paths.ts)
  - `joinUnderRoot(root: string, segment: string): string` (paths.ts)
  - `type WorkerSelector = { kind: "personal"; userId: string } | { kind: "shared" }`
  - `resolveWorkerSelector(ctx: { isOwner: boolean; isPrivate: boolean; userId: string }): WorkerSelector`
  - `scopeDirs(dirs: string[], o: { workerKind: "personal" | "shared"; isOwner: boolean; userId: string }): string[]`
- 시그니처가 바뀌지 않는 것: `isPathWithin`·`isPathWithinAny`·`normalizeDir` — 내부 판정만 바뀐다

- [ ] **Step 1: 경로 비교의 실패 테스트를 쓴다**

`agent/tests/paths.test.ts` 에 추가한다. **이 테스트는 반드시 리눅스에서도 통과해야 한다** —
지금 로직이 깨지는 조합이 바로 "리눅스 봇 + 윈도우 경로" 이므로, 로컬(윈도우)에서만 통과하는
테스트는 이 버그를 잡지 못한다. 그래서 `process.platform` 에 의존하지 않는 단언만 쓴다.

```ts
describe("경로 비교는 대상 경로의 플랫폼을 따른다 — 봇(리눅스)이 윈도우 워커 경로를 판정한다", () => {
  it("윈도우 경로: 허용 폴더 안의 파일을 허용한다", () => {
    expect(isPathWithin(String.raw`C:\ws\my.txt`, String.raw`C:\ws`)).toBe(true);
    expect(isPathWithin(String.raw`C:\ws\111\my.txt`, String.raw`C:\ws\111`)).toBe(true);
  });

  it("윈도우 경로: 상위 참조로 빠져나가면 거부한다", () => {
    expect(isPathWithin(String.raw`C:\ws\111\..\222\secret.txt`, String.raw`C:\ws\111`)).toBe(false);
    expect(isPathWithin(String.raw`C:\ws\222\secret.txt`, String.raw`C:\ws\111`)).toBe(false);
  });

  it("윈도우 경로: 대소문자를 구분하지 않는다(NTFS)", () => {
    expect(isPathWithin(String.raw`c:\WS\My.TXT`, String.raw`C:\ws`)).toBe(true);
  });

  it("윈도우 경로: 접두사만 같은 형제 폴더는 거부한다", () => {
    expect(isPathWithin(String.raw`C:\ws2\my.txt`, String.raw`C:\ws`)).toBe(false);
  });

  it("UNC 경로도 윈도우 규칙으로 판정한다", () => {
    expect(isPathWithin(String.raw`\\nas\share\a\b.txt`, String.raw`\\nas\share\a`)).toBe(true);
    expect(isPathWithin(String.raw`\\nas\share\a\..\c\b.txt`, String.raw`\\nas\share\a`)).toBe(false);
  });

  it("POSIX 경로는 POSIX 규칙으로 판정한다(대소문자 구분)", () => {
    expect(isPathWithin("/srv/ws/my.txt", "/srv/ws")).toBe(true);
    expect(isPathWithin("/srv/ws/../other/x", "/srv/ws")).toBe(false);
    expect(isPathWithin("/srv/WS/my.txt", "/srv/ws")).toBe(false);
  });

  it("normalizeDir 도 대상 경로의 플랫폼을 따른다 — 리눅스 봇이 윈도우 경로를 저장할 때", () => {
    expect(normalizeDir(String.raw`C:\ws\`)).toBe(String.raw`C:\ws`);
    expect(normalizeDir(String.raw`C:\ws\a\..\b`)).toBe(String.raw`C:\ws\b`);
    expect(normalizeDir("/srv/ws/")).toBe("/srv/ws");
  });
});
```

- [ ] **Step 2: 실패를 확인한다**

Run: `cd agent && npx vitest run tests/paths.test.ts`
Expected: 윈도우 개발 머신에서는 대부분 통과하고 POSIX 케이스가 실패한다. 이것만으로는 이 버그를
재현했다고 할 수 없다 — 리눅스에서 돌 때의 동작이 문제이기 때문이다. 아래로 재현을 확정한다.

Run: `cd agent && npx tsx -e "import path from 'node:path'; const d=path.posix.resolve(String.raw\`C:\ws\`), t=path.posix.resolve(String.raw\`C:\ws\my.txt\`); console.log(path.posix.relative(d,t))"`
Expected: `../C:\ws\my.txt` — 두 경로가 형제 파일명으로 취급돼 `..` 로 시작한다. 즉 리눅스에서는
정상 경로도 "밖" 으로 판정된다.

- [ ] **Step 3: `paths.ts` 를 플랫폼 인식으로 고친다**

`agent/src/core/paths.ts` 를 다음으로 바꾼다(파일 전체).

```ts
import path from "node:path";

// 이 경로가 어느 플랫폼의 것인지 판정해 그 규칙으로 다루게 한다.
//
// 봇은 Railway(리눅스)에서 돌고 워커는 윈도우일 수 있다. node:path 의 기본 구현은 자기 플랫폼
// 규칙을 쓰므로, 리눅스에서 `C:\ws\my.txt` 를 resolve 하면 역슬래시가 구분자가 아니라 파일명
// 문자로 취급돼 경로 전체가 한 조각이 된다 — 그러면 `C:\ws` 와 `C:\ws\my.txt` 가 서로 형제
// 파일명이 되어 "안에 있다"는 판정이 절대 성립하지 않는다(정상 경로까지 전부 거부된다).
//
// 드라이브 문자(C:\) 또는 UNC(\\서버\공유) 로 시작하면 윈도우, 그 외에는 POSIX 로 본다.
export function pathFlavorOf(p: string): path.PlatformPath {
  return /^[a-zA-Z]:[\\/]/.test(p) || p.startsWith("\\\\") ? path.win32 : path.posix;
}

// 경로 판정 순수 함수 — fs 접근 없이 문자열만으로 target 이 dir 안(같거나 하위)인지 판정한다.
// 심볼릭 링크 realpath 해석은 이 함수의 범위 밖이다(호출측이 fs 로 처리).
//
// 플레이버는 dir(허용 폴더) 기준으로 고른다 — 판정의 기준점이 그쪽이고, target 은 신뢰할 수 없는
// 입력이라 그 생김새로 규칙을 고르게 하면 공격자가 판정 규칙 자체를 고를 수 있게 된다.
export function isPathWithin(target: string, dir: string): boolean {
  const flavor = pathFlavorOf(dir);
  let d = flavor.resolve(dir);
  let t = flavor.resolve(target);
  // 윈도우 파일시스템은 대소문자를 구분하지 않는다. 판정 대상 경로가 윈도우일 때만 무시한다
  // (예전엔 봇 프로세스의 process.platform 으로 갈랐는데, 그건 워커의 파일시스템과 무관한 값이다).
  if (flavor === path.win32) {
    d = d.toLowerCase();
    t = t.toLowerCase();
  }
  if (d === t) return true;
  const rel = flavor.relative(d, t);
  // rel 이 ".." 로 시작하는지 여부는 정확히 ".."(부모 자신) 이거나 ".."+구분자 로 시작하는 경우만 확인한다.
  // 단순 rel.startsWith("..") 는 "..foobar" 같은(부모 탈출이 아닌) 이름을 오판할 수 있어 제외한다.
  return rel !== ".." && !rel.startsWith(".." + flavor.sep) && !flavor.isAbsolute(rel);
}

export function isPathWithinAny(target: string, dirs: readonly string[]): boolean {
  return dirs.some((dir) => isPathWithin(target, dir));
}

// 저장·비교 일관성을 위해 절대경로로 정규화한다. 여기서도 플레이버를 따른다 — 리눅스 봇이
// `C:\ws` 를 기본 resolve 로 저장하면 `/app/C:\ws` 같은 값이 DB 에 들어간다.
export function normalizeDir(p: string): string {
  return pathFlavorOf(p).resolve(p);
}

// 워커의 루트 경로 아래에 한 단계를 잇는다. 문자열을 "/" 로 잇지 않는 이유는 위와 같다 —
// `C:\ws/111` 처럼 구분자가 섞이면 두 겹의 경로 검사가 서로 다른 판정을 하게 된다.
export function joinUnderRoot(root: string, segment: string): string {
  const flavor = pathFlavorOf(root);
  return `${root.replace(/[\\/]+$/, "")}${flavor.sep}${segment}`;
}
```

- [ ] **Step 4: 통과를 확인하고 커밋한다**

Run: `cd agent && npm test && npx tsc --noEmit`
Expected: 실패 0. `pathPermission.test.ts`·`remoteRoots.test.ts` 등 이 함수를 쓰는 기존 테스트가
모두 그대로 통과해야 한다 — 하나라도 깨지면 플레이버 판정이 기존 동작을 바꾼 것이므로 멈추고 원인을 본다.

```bash
git add agent/src/core/paths.ts agent/tests/paths.test.ts && git commit -m "fix(paths): 경로 비교를 대상 플랫폼 기준으로 — 리눅스 봇이 윈도우 워커 경로를 거부하던 문제"
```

- [ ] **Step 5: 워커 선택·스코프의 실패 테스트를 쓴다**

`agent/tests/workerSelect.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { resolveWorkerSelector, scopeDirs } from "../src/core/workerSelect.js";
import { joinUnderRoot } from "../src/core/paths.js";

describe("resolveWorkerSelector — 어디서 말하느냐가 어느 기계냐를 정한다", () => {
  it("소유자 DM 은 그 소유자의 개인 워커", () => {
    expect(resolveWorkerSelector({ isOwner: true, isPrivate: true, userId: "owner" }))
      .toEqual({ kind: "personal", userId: "owner" });
  });

  it("소유자가 서버에 있으면 공유 워커", () => {
    expect(resolveWorkerSelector({ isOwner: true, isPrivate: false, userId: "owner" }))
      .toEqual({ kind: "shared" });
  });

  it("손님은 DM 이든 서버든 공유 워커", () => {
    expect(resolveWorkerSelector({ isOwner: false, isPrivate: true, userId: "g" })).toEqual({ kind: "shared" });
    expect(resolveWorkerSelector({ isOwner: false, isPrivate: false, userId: "g" })).toEqual({ kind: "shared" });
  });
});

describe("joinUnderRoot — 워커 플랫폼의 구분자를 따른다", () => {
  it("윈도우 루트에는 역슬래시로 잇는다", () => {
    expect(joinUnderRoot("C:\\workspace", "123")).toBe("C:\\workspace\\123");
    expect(joinUnderRoot("C:\\workspace\\", "123")).toBe("C:\\workspace\\123");
  });

  it("POSIX 루트에는 슬래시로 잇는다", () => {
    expect(joinUnderRoot("/srv/workspace", "123")).toBe("/srv/workspace/123");
    expect(joinUnderRoot("/srv/workspace/", "123")).toBe("/srv/workspace/123");
  });

  it("UNC 경로도 역슬래시", () => {
    expect(joinUnderRoot("\\\\nas\\share", "123")).toBe("\\\\nas\\share\\123");
  });
});

describe("scopeDirs — 공유 기계 안에서 사용자별로 가른다", () => {
  const dirs = ["C:\\workspace", "D:\\projects"];

  it("개인 워커는 목록을 그대로 쓴다", () => {
    expect(scopeDirs(dirs, { workerKind: "personal", isOwner: true, userId: "owner" })).toEqual(dirs);
  });

  it("공유 워커 + 소유자는 루트 전체", () => {
    expect(scopeDirs(dirs, { workerKind: "shared", isOwner: true, userId: "owner" })).toEqual(dirs);
  });

  it("공유 워커 + 손님은 본인 폴더로 좁혀진다", () => {
    expect(scopeDirs(dirs, { workerKind: "shared", isOwner: false, userId: "123" }))
      .toEqual(["C:\\workspace\\123", "D:\\projects\\123"]);
  });

  it("허용 폴더가 없으면 결과도 없다 — 빈 목록을 전체 허용으로 바꾸지 않는다", () => {
    expect(scopeDirs([], { workerKind: "shared", isOwner: false, userId: "123" })).toEqual([]);
  });
});
```

- [ ] **Step 6: 실패를 확인한다**

Run: `cd agent && npx vitest run tests/workerSelect.test.ts`
Expected: FAIL — 모듈 없음. (`joinUnderRoot` 는 Step 3 에서 이미 만들었으므로 그 describe 블록만
통과하고 나머지가 실패한다.)

- [ ] **Step 7: `workerSelect.ts` 를 만든다**

```ts
import { joinUnderRoot } from "./paths.js";

// 이 턴이 어느 기계를 쓰는가. 규칙은 한 줄이다 — "어디서 말하느냐가 어느 기계냐를 정한다".
// 유일한 예외가 손님인데, 손님은 개인 워커가 없으므로 어디서든 공유 기계로 간다.
//
// 순수 함수로 떼어 둔 이유는 shouldConnectWorker 와 같다: 이 판단 하나를 검증하려고 SDK
// query() 나 DB 전체를 목업하고 싶지 않다. 실제 워커 id 로 바꾸는 것은 호출측(레지스트리 조회)의 몫이다.
export type WorkerSelector = { kind: "personal"; userId: string } | { kind: "shared" };

export function resolveWorkerSelector(ctx: { isOwner: boolean; isPrivate: boolean; userId: string }): WorkerSelector {
  return ctx.isOwner && ctx.isPrivate ? { kind: "personal", userId: ctx.userId } : { kind: "shared" };
}

// 봇 쪽 1차 필터가 쓸 폴더 목록. 공유 기계에서 손님은 자기 하위 폴더로만 좁혀진다.
// 소유자는 관리자이므로 좁히지 않는다 — 다른 사람의 작업을 조회할 수 있어야 한다.
//
// 빈 목록은 빈 목록 그대로 돌려준다. "허용 폴더가 하나도 없다"를 "전부 허용"으로 바꾸면
// 1차 필터가 통째로 무력화된다(fail closed 유지 — 호출측이 빈 목록을 거부로 다룬다).
export function scopeDirs(
  dirs: string[],
  o: { workerKind: "personal" | "shared"; isOwner: boolean; userId: string },
): string[] {
  if (o.workerKind === "personal" || o.isOwner) return dirs;
  return dirs.map((d) => joinUnderRoot(d, o.userId));
}
```

- [ ] **Step 8: 테스트 통과를 확인한다**

Run: `cd agent && npx vitest run tests/workerSelect.test.ts tests/paths.test.ts`
Expected: PASS

- [ ] **Step 9: 커밋**

```bash
git add agent/src/core/workerSelect.ts agent/tests/workerSelect.test.ts && git commit -m "feat(core): 워커 선택·폴더 스코프 순수 함수"
```

---

### Task 7: 도구 계층과 핸들러 배선

**Files:**
- Modify: `agent/src/core/agent.ts:124-180`
- Modify: `agent/src/core/tools.ts:205-238`
- Modify: `agent/src/core/remoteTools.ts:9-18`, `:67-126`
- Test: `agent/tests/tools.test.ts`, `agent/tests/agent.test.ts`, `agent/tests/remoteTools.test.ts`

**Interfaces:**
- Consumes: `resolveWorkerSelector`·`scopeDirs` (Task 6), `WorkersRepo.personalWorkerOf`·`sharedWorkerId` (Task 1), `ToolCtx.remote.workerId` (Task 5)
- Produces: `allowedToolsFor(role, isPrivate, isOwner, deployTarget, workerConnected, webToolsEnabled)` — 시그니처는 그대로, 동작만 바뀐다

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`agent/tests/tools.test.ts` 에 추가한다.

```ts
describe("allowedToolsFor — 공유 워커로 계층이 넓어진다", () => {
  const remoteNames = ["fs_read", "fs_write", "fs_edit", "fs_glob", "fs_grep", "sh_exec"];
  const hasRemote = (tools: string[]) => remoteNames.every((n) => tools.some((t) => t.endsWith(n)));

  it("공개 서버 + 워커 연결이면 원격 도구가 열린다(예전엔 무조건 닫혔다)", () => {
    expect(hasRemote(allowedToolsFor("allowed", false, false, "local", true))).toBe(true);
  });

  it("공개 서버 + 워커 미연결이면 열리지 않는다", () => {
    expect(hasRemote(allowedToolsFor("allowed", false, false, "local", false))).toBe(false);
  });

  it("손님 DM + 워커 연결이면 열린다(공유 워커로 간다)", () => {
    expect(hasRemote(allowedToolsFor("allowed", true, false, "local", true))).toBe(true);
  });

  it("손님에게는 폴더 관리 도구를 주지 않는다 — 워커가 연결돼 있어도", () => {
    const tools = allowedToolsFor("allowed", false, false, "local", true);
    expect(tools.some((t) => t.endsWith("allow_dir"))).toBe(false);
    expect(tools.some((t) => t.endsWith("revoke_dir"))).toBe(false);
  });

  it("소유자는 서버에서도 폴더 관리 도구를 갖는다", () => {
    const tools = allowedToolsFor("owner", false, true, "local", true);
    expect(tools.some((t) => t.endsWith("allow_dir"))).toBe(true);
  });

  it("손님에게는 DB·접근관리 도구를 여전히 주지 않는다", () => {
    const tools = allowedToolsFor("allowed", true, false, "local", true);
    for (const n of ["db_query", "db_schema", "manage_access", "runtime_info"]) {
      expect(tools.some((t) => t.endsWith(n))).toBe(false);
    }
  });
});
```

`agent/tests/remoteTools.test.ts` 에 추가한다.

```ts
describe("remoteToolHandler — 공유 기계에서 사용자별 격리", () => {
  function ctxFor(o: { isOwner: boolean; isPrivate: boolean; userId: string; dirs: string[]; workerKind: "personal" | "shared" }) {
    const calls: Array<{ tool: string; args: Record<string, unknown> }> = [];
    const ctx = {
      repos: { allowedDirs: { list: async () => o.dirs } },
      role: o.isOwner ? "owner" : "allowed",
      isPrivate: o.isPrivate, isOwner: o.isOwner, userId: o.userId, conversationId: 1,
      runtime: {} as any,
      remote: {
        workerId: o.workerKind === "shared" ? "semicolon-shared" : "owner-laptop",
        workerKind: o.workerKind,
        roots: o.dirs,
        call: async (tool: string, args: Record<string, unknown>) => { calls.push({ tool, args }); return { ok: true, content: "ok" }; },
      },
    } as any;
    return { ctx, calls };
  }

  it("손님이 남의 폴더를 읽으려 하면 거부한다 — 이 설계의 핵심 불변식", async () => {
    const { ctx, calls } = ctxFor({ isOwner: false, isPrivate: false, userId: "111", dirs: ["C:\\ws"], workerKind: "shared" });
    const out = await remoteToolHandler(ctx, "fs_read", { path: "C:\\ws\\222\\secret.txt" });
    expect(out).toContain("허용된 폴더 밖");
    expect(calls).toHaveLength(0);
  });

  it("손님이 자기 폴더 안을 읽는 것은 통과한다", async () => {
    const { ctx, calls } = ctxFor({ isOwner: false, isPrivate: false, userId: "111", dirs: ["C:\\ws"], workerKind: "shared" });
    await remoteToolHandler(ctx, "fs_read", { path: "C:\\ws\\111\\my.txt" });
    expect(calls).toHaveLength(1);
  });

  it("손님이 상위 참조로 빠져나가려 하면 거부한다", async () => {
    const { ctx, calls } = ctxFor({ isOwner: false, isPrivate: false, userId: "111", dirs: ["C:\\ws"], workerKind: "shared" });
    const out = await remoteToolHandler(ctx, "fs_read", { path: "C:\\ws\\111\\..\\222\\secret.txt" });
    expect(out).toContain("허용된 폴더 밖");
    expect(calls).toHaveLength(0);
  });

  it("소유자는 공유 기계에서 남의 폴더도 읽는다(관리자)", async () => {
    const { ctx, calls } = ctxFor({ isOwner: true, isPrivate: false, userId: "owner", dirs: ["C:\\ws"], workerKind: "shared" });
    await remoteToolHandler(ctx, "fs_read", { path: "C:\\ws\\222\\any.txt" });
    expect(calls).toHaveLength(1);
  });

  it("path 를 생략한 fs_grep 은 손님의 하위 폴더가 주입된다", async () => {
    const { ctx, calls } = ctxFor({ isOwner: false, isPrivate: false, userId: "111", dirs: ["C:\\ws"], workerKind: "shared" });
    await remoteToolHandler(ctx, "fs_grep", { pattern: "TODO" });
    expect(calls[0].args.path).toBe("C:\\ws\\111");
  });

  it("워커가 없으면 안내하고 호출하지 않는다", async () => {
    const { ctx } = ctxFor({ isOwner: false, isPrivate: false, userId: "111", dirs: ["C:\\ws"], workerKind: "shared" });
    delete (ctx as any).remote;
    expect(await remoteToolHandler(ctx, "fs_read", { path: "C:\\ws\\111\\a" })).toContain("워커가 연결돼 있지 않아");
  });
});
```

- [ ] **Step 2: 실패를 확인한다**

Run: `cd agent && npx vitest run tests/tools.test.ts tests/remoteTools.test.ts`
Expected: FAIL — 공개 서버 분기가 아직 원격 도구를 닫고 있고, `remoteToolHandler` 가 `isOwnerDm` 으로 거부한다

- [ ] **Step 3: `allowedToolsFor` 를 고친다**

`agent/src/core/tools.ts:227-237` 의 세 분기를 바꾼다. 위쪽의 낡은 주석("1단계는 소유자 DM 전용")도 함께 고친다.

```ts
  if (isOwner && isPrivate) {
    return [
      ...remote,
      t("remember"), t("recall"), t("character_fact"), t("manage_access"),
      ...dirTools,
      t("db_schema"), t("db_query"), t("runtime_info"),
      ...webTools,
    ];
  }
  // 소유자가 서버에 있으면 공유 기계 + 관리자 권한(폴더 관리 포함). DB·접근관리는 DM 전용을
  // 유지한다 — 그건 기계가 아니라 봇 자신에 대한 권한이라 공개 채널에서 열 이유가 없다.
  if (isOwner) return [...remote, t("recall"), ...dirTools, ...webTools];
  // 손님: DM 이든 서버든 공유 기계. 폴더 관리는 주지 않는다.
  if (isPrivate && (role === "owner" || role === "allowed")) {
    return [...remote, t("remember"), t("recall"), t("character_fact"), ...webTools];
  }
  return [...remote, t("recall"), ...webTools];
```

`dirTools` 계산을 `workerConnected && isOwner` 로 바꾼다.

```ts
  const dirTools = workerConnected && isOwner ? [t("allow_dir"), t("revoke_dir"), t("list_dirs")] : [];
```

- [ ] **Step 4: `agent.ts` 의 워커 해석을 교체한다**

`shouldConnectWorker` 를 지우고, 레지스트리를 받아 워커 id 를 푸는 비동기 함수로 바꾼다. `resolveWorkerConnected` 의 `noRemoteTools` 합성은 유지한다.

```ts
import { resolveWorkerSelector } from "./workerSelect.js";
import type { WorkerKind } from "../store/workersRepo.js";

// 이 턴이 실제로 쓸 워커. 선택자(순수)를 레지스트리로 실제 id 로 바꾼다.
// noRemoteTools 가 참이면(유휴 요약 턴) 워커가 붙어 있어도 무조건 null 이다 — 기존 FIX4 유지.
export async function resolveTurnWorker(
  req: { context: { isOwner: boolean; isPrivate: boolean; userId: string }; noRemoteTools?: boolean },
  registry?: { personalWorkerOf(userId: string): Promise<string | null>; sharedWorkerId(): Promise<string | null> },
  hub?: { isConnected(workerId: string): boolean },
): Promise<{ workerId: string; kind: WorkerKind } | null> {
  if (req.noRemoteTools === true || !registry || !hub) return null;
  const sel = resolveWorkerSelector(req.context);
  const id = sel.kind === "personal" ? await registry.personalWorkerOf(sel.userId) : await registry.sharedWorkerId();
  if (id === null || !hub.isConnected(id)) return null;
  return { workerId: id, kind: sel.kind };
}
```

`makeRunAgentTurn` 에서 `resolveWorkerConnected` 호출을 `await resolveTurnWorker(...)` 로 바꾸고, `workerConnected = worker !== null` 로 계산한다. `buildRemoteCtx` 는 `workerId` 와 `kind` 를 함께 채운다.

```ts
export function buildRemoteCtx(
  worker: { workerId: string; kind: WorkerKind } | null,
  hub?: { rootsOf(id: string): string[]; call(id: string, tool: string, args: Record<string, unknown>): Promise<{ ok: boolean; content: string }> },
): ToolCtx["remote"] {
  if (!worker || !hub) return undefined;
  return {
    workerId: worker.workerId,
    workerKind: worker.kind,
    roots: hub.rootsOf(worker.workerId),
    call: (tool, args) => hub.call(worker.workerId, tool, args),
  };
}
```

`ToolCtx.remote` 에 `workerKind: WorkerKind` 를 추가한다(Task 5 에서 `workerId` 만 넣었다).

`makeRunAgentTurn` 의 인자에 `registry` 를 추가하고, `index.ts` 에서 `repos.workers` 를 넘긴다.

- [ ] **Step 5: `remoteToolHandler` 를 고친다**

`agent/src/core/remoteTools.ts` 의 `isOwnerDm` 게이트를 지운다. 판정 기준은 이제 "이 컨텍스트에 워커가 해석돼 있는가" 하나다 — 그 판정은 `agent.ts` 의 `resolveTurnWorker` 가 이미 했고, 그 결과가 `ctx.remote` 의 존재로 나타난다.

```ts
// 신원 재확인은 이제 "ctx.remote 가 있는가" 하나다. 예전에는 isOwnerDm 을 여기서 다시 확인했지만,
// 그 판정은 워커가 소유자 DM 전용이던 시절의 것이다. 지금은 어느 기계를 쓸지 자체가
// resolveTurnWorker(agent.ts) 의 결과이고, 그 결과가 ctx.remote 로 나타난다 — 도구 목록과
// 핸들러가 같은 하나의 판정을 공유하므로 "도구는 보이는데 실행은 거부"가 생기지 않는다.
// 권한 차이는 아래 scopeDirs 가 만든다(손님은 자기 폴더로 좁혀진다).
export async function remoteToolHandler(
  ctx: ToolCtx,
  tool: string,
  args: Record<string, unknown>,
): Promise<string> {
  const remote = ctx.remote;
  if (!remote) return "지금은 워커가 연결돼 있지 않아 PC 작업을 할 수 없어요.";
```

`OWNER_DM_ONLY` 상수와 `isOwnerDm` 함수를 지운다.

허용 폴더 조회를 워커 기준 + 스코프 적용으로 바꾼다.

```ts
    let allowed: string[];
    try {
      const dirs = await ctx.repos.allowedDirs.list(remote.workerId);
      allowed = scopeDirs(dirs, { workerKind: remote.workerKind, isOwner: ctx.isOwner, userId: ctx.userId });
    } catch (e) {
      return `허용 폴더 확인 중 오류가 발생했어요: ${e instanceof Error ? e.message : String(e)}`;
    }
    if (allowed.length === 0) return "먼저 allow_dir 로 작업할 폴더를 허용해 주세요.";
```

`import { scopeDirs } from "./workerSelect.js";` 를 추가한다. 나머지(후보 추출, `isPathWithinAny`, `allowed[0]` 주입)는 그대로 둔다 — 이제 `allowed` 가 이미 좁혀진 목록이므로 기존 로직이 자동으로 사용자별 격리를 강제한다.

- [ ] **Step 6: 전체 검증**

Run: `cd agent && npm test && npx tsc --noEmit && npm run build`
Expected: 실패 0, tsc 무출력, 빌드 성공. `coreMulti.test.ts`·`agent.test.ts` 의 기존 테스트가 `shouldConnectWorker`/`resolveWorkerConnected` 를 쓰고 있으면 새 함수로 고친다 — **단언 값은 바꾸지 않는다.** 소유자 DM 동작이 그대로 유지되는지가 그 테스트들의 핵심이다.

- [ ] **Step 7: 커밋**

```bash
git add agent/src/core agent/tests && git commit -m "feat(core): 워커 라우팅·도구 계층·사용자별 폴더 격리"
```

---

### Task 8: `fs_mkdir` 과 손님 폴더 자동 생성

**Files:**
- Modify: `agent/src/remote/executors.ts:34-`
- Modify: `agent/src/core/remoteTools.ts`
- Test: `agent/tests/remoteExecutors.test.ts`, `agent/tests/remoteTools.test.ts`

**Interfaces:**
- Consumes: `scopeDirs` (Task 6), `checkPath` (기존)
- Produces: 실행기 `fs_mkdir` (인자 `{ path: string }`). **`REMOTE_TOOL_NAMES` 에 넣지 않는다** — 모델이 부르는 도구가 아니다

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`agent/tests/remoteExecutors.test.ts` 에 추가한다(기존 파일의 임시 디렉토리 셋업 방식을 그대로 따른다).

```ts
describe("fs_mkdir", () => {
  it("루트 안에 폴더를 만든다", async () => {
    const ex = makeExecutors([tmpRoot]);
    const target = path.join(tmpRoot, "111");
    const r = await ex.fs_mkdir({ path: target });
    expect(r.ok).toBe(true);
    expect(fs.existsSync(target)).toBe(true);
  });

  it("이미 있으면 성공으로 취급한다(멱등)", async () => {
    const ex = makeExecutors([tmpRoot]);
    const target = path.join(tmpRoot, "111");
    await ex.fs_mkdir({ path: target });
    expect((await ex.fs_mkdir({ path: target })).ok).toBe(true);
  });

  it("중간 경로가 없어도 만든다", async () => {
    const ex = makeExecutors([tmpRoot]);
    const target = path.join(tmpRoot, "a", "b", "c");
    expect((await ex.fs_mkdir({ path: target })).ok).toBe(true);
    expect(fs.existsSync(target)).toBe(true);
  });

  it("루트 밖은 거부한다 — 다른 fs_* 와 같은 관문을 거친다", async () => {
    const ex = makeExecutors([tmpRoot]);
    const r = await ex.fs_mkdir({ path: path.join(tmpRoot, "..", "탈출") });
    expect(r.ok).toBe(false);
  });

  it("path 가 없으면 거부한다", async () => {
    const ex = makeExecutors([tmpRoot]);
    expect((await ex.fs_mkdir({})).ok).toBe(false);
  });
});
```

- [ ] **Step 2: 실패를 확인한다**

Run: `cd agent && npx vitest run tests/remoteExecutors.test.ts`
Expected: FAIL — `ex.fs_mkdir is not a function`

- [ ] **Step 3: 실행기를 추가한다**

`agent/src/remote/executors.ts` 의 `makeExecutors` 가 돌려주는 객체에 추가한다. 기존 실행기들이 쓰는 경로 검사 헬퍼(파일 상단의 `checkPath` 를 감싼 함수, `:39` 근처)를 그대로 재사용한다.

```ts
    // 손님의 개인 폴더를 만들기 위한 실행기. 모델이 부르는 도구가 아니라 봇이 첫 원격 호출 직전에
    // 자동으로 끼워 넣는다(remoteTools.ts) — 그래서 REMOTE_TOOL_NAMES 에는 넣지 않는다.
    // 다른 fs_* 와 똑같이 checkPath 를 거친다. 예외 경로를 만들지 않는다.
    fs_mkdir: async (args) => {
      const p = typeof args.path === "string" ? args.path : "";
      if (p.trim().length === 0) return { ok: false, content: "path 가 필요합니다." };
      const c = checkPath(p, roots);
      if (!c.ok) return { ok: false, content: c.message };
      try {
        // recursive:true 는 이미 있을 때도 성공한다 — 멱등이 필요한 용도라 그게 맞다.
        await fsp.mkdir(c.path, { recursive: true });
        return { ok: true, content: "(완료)" };
      } catch (e) {
        return { ok: false, content: `폴더를 만들지 못했어요: ${e instanceof Error ? e.message : String(e)}` };
      }
    },
```

`checkPath` 의 반환 타입은 `agent/src/remote/roots.ts:5` 의 `PathCheck = { ok: true; path: string } | { ok: false; message: string }` 이다 — 실패 쪽은 `message` 이지 `reason` 이 아니다. 성공 시 `c.path` 는 realpath 로 정규화된 경로이므로, `fsp.mkdir` 에는 원본 `p` 가 아니라 반드시 `c.path` 를 넘긴다.

- [ ] **Step 4: 봇이 자동으로 호출하게 한다**

`agent/src/core/remoteTools.ts` 의 허용 폴더 계산 직후, 손님이 공유 기계를 쓰는 경우에만 한 번 호출한다.

```ts
    // 손님의 개인 폴더는 첫 접근 때 만든다("1인당 1폴더"가 규칙이라 없다고 거부할 이유가 없다).
    // 모델에게 시키지 않고 봇이 직접 끼워 넣는다 — 모델이 fs_write 나 sh_exec 로 제각각
    // 만들게 두면 실패 처리도 제각각이 된다. 실패해도 진행한다: 폴더가 없으면 어차피 뒤이은
    // 실제 호출이 자연스러운 오류를 낸다.
    if (remote.workerKind === "shared" && !ctx.isOwner) {
      await remote.call("fs_mkdir", { path: allowed[0] }).catch(() => {});
    }
```

`allowed[0]` 은 이미 `scopeDirs` 로 좁혀진 값이라 정확히 그 손님의 폴더다.

- [ ] **Step 5: 자동 생성 테스트를 추가한다**

`agent/tests/remoteTools.test.ts` 에 추가한다(Task 7 의 `ctxFor` 헬퍼를 재사용).

```ts
it("손님의 첫 호출 전에 개인 폴더를 만든다", async () => {
  const { ctx, calls } = ctxFor({ isOwner: false, isPrivate: false, userId: "111", dirs: ["C:\\ws"], workerKind: "shared" });
  await remoteToolHandler(ctx, "fs_read", { path: "C:\\ws\\111\\a.txt" });
  expect(calls[0]).toEqual({ tool: "fs_mkdir", args: { path: "C:\\ws\\111" } });
  expect(calls[1].tool).toBe("fs_read");
});

it("소유자에게는 폴더를 만들지 않는다", async () => {
  const { ctx, calls } = ctxFor({ isOwner: true, isPrivate: false, userId: "owner", dirs: ["C:\\ws"], workerKind: "shared" });
  await remoteToolHandler(ctx, "fs_read", { path: "C:\\ws\\a.txt" });
  expect(calls.every((c) => c.tool !== "fs_mkdir")).toBe(true);
});

it("개인 워커에서는 폴더를 만들지 않는다", async () => {
  const { ctx, calls } = ctxFor({ isOwner: true, isPrivate: true, userId: "owner", dirs: ["C:\\dev"], workerKind: "personal" });
  await remoteToolHandler(ctx, "fs_read", { path: "C:\\dev\\a.txt" });
  expect(calls.every((c) => c.tool !== "fs_mkdir")).toBe(true);
});
```

- [ ] **Step 6: 전체 검증**

Run: `cd agent && npm test && npx tsc --noEmit && npm run build`
Expected: 실패 0, tsc 무출력, 빌드 성공

- [ ] **Step 7: 커밋**

```bash
git add agent/src agent/tests && git commit -m "feat(remote): fs_mkdir 과 손님 개인 폴더 자동 생성"
```

---

### Task 9: 문서 갱신

**Files:**
- Modify: `docs/security/capability-model.md`
- Modify: `docs/status/STATUS.md`
- Modify: `docs/architecture/module-boundaries.md`
- Modify: `docs/architecture/data-flow.md`
- Modify: `deploy/worker-셋업.md`
- Modify: `deploy/smoke-test.md`
- Modify: `agent/.env.example`

- [ ] **Step 1: `capability-model.md` 의 위협 모델을 고친다**

이 문서는 "PC 도구는 소유자 DM 전용"을 근간으로 서술돼 있다. 다음을 정확히 반영한다.

- 능력 계층표에 소유자-서버·손님 행을 추가하고 원격 도구 열림을 표시
- `allowed` 역할이면 누구나 공유 기계에서 `sh_exec` 를 실행할 수 있다는 사실
- 공개 채널 콘텐츠가 이제 PC 도구를 가진 턴에 섞인다는 것 — 이전에는 "그 계층에 PC 도구가 없다"가 완화책이었고 그 완화책이 사라졌다는 것을 명시
- 억제 요소 둘: `decideRoute` 가 미등록 사용자를 무시한다는 것, 페르소나의 외부 콘텐츠 불신 규칙(프롬프트라 완전하지 않음)
- 사용자별 폴더 격리가 새 방어선이며 `sh_exec` 에는 적용되지 않는다는 것 — 손님은 파일 도구로는 자기 폴더에 갇히지만 셸로는 갇히지 않는다
- 보안-핵심 파일 목록에 `workerSelect.ts`·`workersRepo.ts` 추가
- 미니PC 표준 계정 요구사항(스펙 §6)

- [ ] **Step 2: `STATUS.md` 를 고친다**

"원격 개발 워크플로우(얇은 워커)" 항목이 "소유자 DM에서만"이라고 적혀 있다. 스펙 §2 의 표를 반영하고, 테스트 수를 실제 값으로 갱신한다(`npm test` 출력 확인).

알려진 한계에 추가한다.

```markdown
- **`sh_exec` 는 사용자별 폴더 격리의 대상이 아니다**: 공유 기계에서 손님은 파일 도구
  (`fs_read` 등)로는 자기 폴더 밖을 볼 수 없지만, 셸 명령은 경로로 봉쇄되지 않으므로 워커
  프로세스의 OS 계정 권한이 닿는 곳은 모두 접근할 수 있다. 경계는 미니PC 의 계정 분리다
  (`docs/security/capability-model.md`).
- **공유 워커는 한 대만 쓴다**: `workers` 테이블은 여러 대를 표현할 수 있지만 라우팅은
  가장 먼저 등록된 `shared` 워커 하나만 고른다.
```

- [ ] **Step 3: 아키텍처 문서를 고친다**

`module-boundaries.md` — `store/` 에 `workersRepo.ts`, `core/` 에 `workerSelect.ts` 추가. `allowed_dirs` 가 워커 기준이 됐다는 것. 예약어 경로 서술 중 `allowed_dirs` 를 언급하는 부분이 있으면 함께 고친다.

`data-flow.md` — 워커 인증 흐름(hello → 레지스트리 조회 → ready)과 턴에서의 워커 해석(`resolveWorkerSelector` → 레지스트리 → `hub.isConnected`)을 반영한다. 이 문서는 "서술한 사실은 모두 코드 원문을 근거로 한다"고 선언하므로, 옛 `shouldConnectWorker` 서술이 남아 있으면 반드시 지운다.

- [ ] **Step 4: 배포 문서를 고친다**

`deploy/worker-셋업.md` 를 다시 쓴다. 최소한 다음을 담는다.

- `npm run register-worker -- --id ... --kind ...` 로 토큰을 발급받는 절차(토큰은 한 번만 보인다)
- 워커 `.env` 의 `WORKER_ID`/`WORKER_TOKEN`/`HUB_URL`/`WORKER_ROOTS`
- **미니PC(윈도우) 셋업**: 관리자가 아닌 표준 로컬 계정으로 실행, 그 프로필에 SSH 키·`.env`·저장된 자격증명을 두지 않음, `WORKER_ROOTS` 는 워크스페이스 루트 하나만, 작업 트리는 별도 클론
- **`allowed_dirs` 재등록**: 마이그레이션하지 않으므로 워커 등록 후 `allow_dir` 로 폴더를 다시 넣어야 한다는 것
- 토큰 회전 시 기존 연결이 즉시 끊기지 않는다는 것과, 즉시 끊으려면 봇을 재시작해야 한다는 것

`agent/.env.example` 의 워커 절에 `WORKER_ID` 를 넣고, 봇 절의 `WORKER_TOKEN` 을 지우고, 두 값이 `register-worker` 출력에서 온다고 적는다.

- [ ] **Step 5: 스모크 테스트 항목을 추가한다**

`deploy/smoke-test.md` 에 추가한다.

```markdown
- [ ] **워커 등록·인증** — `npm run register-worker` 로 미니PC 워커를 등록하고 출력된 두 값을
  미니PC `.env` 에 넣어 워커를 띄운다.
  기대 결과: 워커 콘솔에 `준비됨`, 봇 로그에 그 워커 id 가 찍힌다.

- [ ] **틀린 토큰은 거부되고 재시도를 멈추는가** — 미니PC `.env` 의 `WORKER_TOKEN` 을 한 글자
  바꿔 워커를 띄운다.
  기대 결과: 거부되고 워커가 재연결을 멈춘다. 거부 문구가 "없는 워커"일 때와 구분되지 않는다.

- [ ] **손님이 자기 폴더 안에서만 작업하는가** — 손님 계정으로 공개 채널에서 파일을 만들고 읽는다.
  기대 결과: `<루트>/<그 손님의 디스코드 id>/` 안에 만들어진다. 다른 사람의 폴더 경로를 지정하면
  "허용된 폴더 밖" 으로 거부된다.

- [ ] **손님 폴더가 자동으로 생기는가** — 한 번도 작업한 적 없는 손님이 파일 작업을 요청한다.
  기대 결과: 그 손님의 폴더가 자동으로 만들어지고 작업이 성공한다.

- [ ] **소유자가 서버에서 남의 폴더를 조회하는가** — 소유자 계정으로 공개 채널에서 손님 폴더를 읽는다.
  기대 결과: 읽힌다(관리자).

- [ ] **소유자 DM 은 여전히 본인 PC 인가** — 소유자 DM 에서 파일을 읽는다.
  기대 결과: 미니PC 가 아니라 소유자 로컬 워커의 파일이 읽힌다. 소유자 로컬 워커를 내리면
  DM 에서 PC 작업이 불가해지고, 그래도 서버에서는 미니PC 작업이 된다.
```

- [ ] **Step 6: 문서 검사와 커밋**

Run: `node scripts/check-docs.mjs` (리포 루트)
Expected: `문서 검사 통과`

```bash
git add docs deploy agent/.env.example && git commit -m "docs: 다중 워커 1단계 반영"
```

---

## 완료 기준

- `cd agent && npm test` — 실패 0
- `cd agent && npx tsc --noEmit` — 무출력
- `cd agent && npm run build` — 성공
- `node scripts/check-docs.mjs` — 통과
- 핵심 불변식 회귀 테스트가 존재하고, 구현을 되돌리면 실제로 빨간불이 켜진다:
  손님이 `<루트>/<남의 id>/...` 를 요청하면 거부된다
