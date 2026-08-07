---
lastReviewed: 2026-08-07
---

# 깃허브 발행·되받기 구현 계획

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 부원이 디스코드로 만든 프로젝트를 동아리 조직(`semicollon-club`)에 발행하고, 미니PC 로컬이 망가져도 원격에서 되받아 채팅만으로 작업을 이어가게 한다.

**Architecture:** 자격증명은 봇만 갖는다 — 봇이 GitHub App 개인키로 **요청마다** 단일 리포·`contents:write`·1시간 설치 토큰을 발급해 워커에 넘기고, 워커는 그 토큰으로 git 명령 한 번을 돌린 뒤 버린다. 대상 리포와 소스 폴더는 **봇이 정한다**(모델은 프로젝트 이름만 말한다) — `projects` 테이블이 소유권의 정본이다.

**Tech Stack:** TypeScript / Node 22, vitest, pg-mem, `node:crypto`(RS256 JWT), `git` CLI(워커).

정본 설계: [../specs/2026-08-07-github-publish-design.md](../specs/2026-08-07-github-publish-design.md)

## Global Constraints

- **개인키·토큰을 절대 로그·응답·`.git/config`·명령줄 인자에 남기지 않는다.** 환경변수로 자식 프로세스에 넘긴다(설계 §9).
- **조직은 `semicollon-club` 고정**, 리포는 **비공개**(`private: true`), 리포명은 조직 내 유일(설계 §4).
- **토큰은 요청마다 새로 발급**한다. 캐시·재사용·갱신 개념을 만들지 않는다(설계 §3.1).
- **모델은 리포도 경로도 고르지 않는다.** 프로젝트 이름만 받고 나머지는 봇이 계산한다(설계 §5·§6).
- 주석·사용자 대면 문구는 **한국어 존댓말**. 도구 이름·코드 식별자는 영어.
- 외부 왕복(GitHub·git)은 **주입 가능한 이음매**로 둔다 — `gitCommit.ts` 의 `RunGit`, `executors.ts` 의 `runPm2` 와 같은 방식. 유닛 테스트는 네트워크·실제 git 없이 돈다.
- 각 태스크 끝에서 `npm run typecheck` 와 `npm test` 가 **둘 다** 통과해야 한다. CI 가 리눅스·윈도우 양쪽에서 같은 것을 돌린다.
- **경로 기대값은 host `path` 로 만들지 않는다.** 윈도우 리터럴을 쓰는 테스트는 `path.win32` 로 계산한다(2026-08-07 CI 가 이 유형으로 28건을 잡았다).

---

### Task 1: `projects` 테이블 + ProjectsRepo — 소유권의 정본

**Files:**
- Modify: `agent/src/store/schema.ts` (테이블 목록 끝, `workers` 다음)
- Create: `agent/src/store/projectsRepo.ts`
- Test: `agent/tests/projectsRepo.test.ts`

**Interfaces:**
- Consumes: `Db`(`agent/src/store/db.ts`), `openTestDb`(테스트용)
- Produces:
  - `type ProjectRow = { id: number; repoName: string; ownerUserId: string; createdTs: number; lastPushTs: number | null }`
  - `class ProjectsRepo { byRepoName(repoName: string): Promise<ProjectRow | null>; claim(o: { repoName: string; ownerUserId: string; ts: number }): Promise<ProjectRow>; touchPush(repoName: string, ts: number): Promise<void>; listByOwner(ownerUserId: string): Promise<ProjectRow[]> }`

- [ ] **Step 1: 스키마에 테이블을 더한다**

`agent/src/store/schema.ts` 의 `workers` 테이블 정의 **뒤**에 붙인다.

```sql
-- 깃허브 발행의 소유권 정본(docs/superpowers/specs/2026-08-07-github-publish-design.md §5).
-- 모델이 리포를 고르지 못하게 하는 장치다 — 봇이 프로젝트 이름을 이 표에 대조해 대상을 정한다.
-- repo_name 이 UNIQUE 인 것이 핵심이다: 같은 이름을 다른 사람이 주장하면 INSERT 가 실패하고,
-- 그 실패가 곧 "남의 리포에 푸시하려 했다"는 판정이 된다(경합 상태에서도 성립한다).
CREATE TABLE IF NOT EXISTS projects (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  repo_name TEXT NOT NULL UNIQUE,
  owner_user_id TEXT NOT NULL,
  created_ts BIGINT NOT NULL,
  last_push_ts BIGINT
);
CREATE INDEX IF NOT EXISTS idx_projects_owner ON projects(owner_user_id);
```

- [ ] **Step 2: 실패하는 테스트를 쓴다**

`agent/tests/projectsRepo.test.ts`:

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { openTestDb } from "../src/store/db.js";
import { ProjectsRepo } from "../src/store/projectsRepo.js";

describe("ProjectsRepo", () => {
  let repo: ProjectsRepo;
  beforeEach(async () => { repo = new ProjectsRepo(await openTestDb()); });

  it("없는 이름은 null 이다", async () => {
    expect(await repo.byRepoName("todo-app")).toBeNull();
  });

  it("claim 하면 소유자와 함께 저장되고 조회된다", async () => {
    const row = await repo.claim({ repoName: "todo-app", ownerUserId: "u1", ts: 1000 });
    expect(row.repoName).toBe("todo-app");
    expect(row.ownerUserId).toBe("u1");
    expect(row.lastPushTs).toBeNull();
    expect(await repo.byRepoName("todo-app")).toEqual(row);
  });

  // 이 케이스가 이 리포의 존재 이유다 — 같은 이름을 다른 사람이 주장하면 조용히 덮어쓰거나
  // 두 행이 생기면 안 된다. 기존 소유자의 행이 그대로 돌아와야 호출측이 "남의 것"으로 판정한다.
  it("같은 이름을 다른 사람이 claim 하면 기존 소유자 행이 그대로 돌아온다", async () => {
    await repo.claim({ repoName: "todo-app", ownerUserId: "u1", ts: 1000 });
    const again = await repo.claim({ repoName: "todo-app", ownerUserId: "u2", ts: 2000 });
    expect(again.ownerUserId).toBe("u1");
    expect((await repo.listByOwner("u2")).length).toBe(0);
  });

  it("같은 사람이 다시 claim 하면 같은 행이다(재발행)", async () => {
    const first = await repo.claim({ repoName: "todo-app", ownerUserId: "u1", ts: 1000 });
    const second = await repo.claim({ repoName: "todo-app", ownerUserId: "u1", ts: 2000 });
    expect(second.id).toBe(first.id);
  });

  it("touchPush 는 마지막 푸시 시각을 남긴다", async () => {
    await repo.claim({ repoName: "todo-app", ownerUserId: "u1", ts: 1000 });
    await repo.touchPush("todo-app", 5000);
    expect((await repo.byRepoName("todo-app"))!.lastPushTs).toBe(5000);
  });

  it("listByOwner 는 그 사람 것만 돌려준다", async () => {
    await repo.claim({ repoName: "a", ownerUserId: "u1", ts: 1 });
    await repo.claim({ repoName: "b", ownerUserId: "u2", ts: 2 });
    expect((await repo.listByOwner("u1")).map((p) => p.repoName)).toEqual(["a"]);
  });
});
```

- [ ] **Step 3: 실패를 확인한다**

Run: `cd agent && npx vitest run tests/projectsRepo.test.ts`
Expected: FAIL — `Cannot find module '../src/store/projectsRepo.js'`

- [ ] **Step 4: 리포를 구현한다**

`agent/src/store/projectsRepo.ts`:

```ts
import type { Db } from "./db.js";

export type ProjectRow = {
  id: number;
  repoName: string;
  ownerUserId: string;
  createdTs: number;
  lastPushTs: number | null;
};

type Raw = {
  id: number | string; repo_name: string; owner_user_id: string;
  created_ts: number | string; last_push_ts: number | string | null;
};

// pg 는 BIGINT 를 문자열로 돌려줄 수 있다(정밀도 보존). 다른 레포들과 같은 방식으로 숫자화한다.
function toRow(r: Raw): ProjectRow {
  return {
    id: Number(r.id),
    repoName: r.repo_name,
    ownerUserId: r.owner_user_id,
    createdTs: Number(r.created_ts),
    lastPushTs: r.last_push_ts === null ? null : Number(r.last_push_ts),
  };
}

export class ProjectsRepo {
  constructor(private db: Db) {}

  async byRepoName(repoName: string): Promise<ProjectRow | null> {
    const r = await this.db.query("SELECT * FROM projects WHERE repo_name = $1", [repoName]);
    return r.rows.length > 0 ? toRow(r.rows[0] as Raw) : null;
  }

  // 이름을 선점한다. 이미 있으면 **기존 행을 그대로 돌려준다** — 덮어쓰지 않는다.
  // ON CONFLICT DO NOTHING + 재조회로 처리하는 이유는 경합 때문이다: 두 사람이 같은 이름을
  // 동시에 주장해도 UNIQUE 제약이 하나만 통과시키고, 진 쪽은 이긴 쪽의 행을 읽게 된다.
  // 호출측(publish.ts)이 그 행의 ownerUserId 로 "내 것인가"를 판정하므로 여기서는 판정하지 않는다.
  async claim(o: { repoName: string; ownerUserId: string; ts: number }): Promise<ProjectRow> {
    await this.db.query(
      "INSERT INTO projects (repo_name, owner_user_id, created_ts) VALUES ($1, $2, $3) ON CONFLICT (repo_name) DO NOTHING",
      [o.repoName, o.ownerUserId, o.ts],
    );
    const row = await this.byRepoName(o.repoName);
    if (row === null) throw new Error(`프로젝트 등록에 실패했어요: ${o.repoName}`);
    return row;
  }

  async touchPush(repoName: string, ts: number): Promise<void> {
    await this.db.query("UPDATE projects SET last_push_ts = $1 WHERE repo_name = $2", [ts, repoName]);
  }

  async listByOwner(ownerUserId: string): Promise<ProjectRow[]> {
    const r = await this.db.query(
      "SELECT * FROM projects WHERE owner_user_id = $1 ORDER BY created_ts",
      [ownerUserId],
    );
    return (r.rows as Raw[]).map(toRow);
  }
}
```

- [ ] **Step 5: 통과를 확인한다**

Run: `cd agent && npx vitest run tests/projectsRepo.test.ts && npm run typecheck`
Expected: 6 tests PASS, typecheck 무출력

- [ ] **Step 6: 커밋**

```bash
git add agent/src/store/schema.ts agent/src/store/projectsRepo.ts agent/tests/projectsRepo.test.ts
git commit -m "feat(store): projects 테이블과 소유권 리포를 더한다"
```

---

### Task 2: 이름·경로·소유권 판정 — 순수 함수

**Files:**
- Create: `agent/src/core/publish.ts`
- Test: `agent/tests/publish.test.ts`

**Interfaces:**
- Consumes: `ProjectRow`(Task 1), `joinUnderRoot`(`agent/src/core/paths.ts`)
- Produces:
  - `const REPO_NAME_PATTERN: RegExp`
  - `function normalizeRepoName(raw: string): string | null`
  - `type OwnershipDecision = { ok: true; repoName: string } | { ok: false; reason: string }`
  - `function decideOwnership(o: { repoName: string; requesterUserId: string; existing: ProjectRow | null }): OwnershipDecision`
  - `function publishSourceDir(o: { workspaceDir: string; repoName: string }): string`

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`agent/tests/publish.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import path from "node:path";
import { normalizeRepoName, decideOwnership, publishSourceDir } from "../src/core/publish.js";

describe("normalizeRepoName", () => {
  it("영숫자·하이픈·밑줄은 그대로 통과한다", () => {
    expect(normalizeRepoName("todo-app")).toBe("todo-app");
    expect(normalizeRepoName("my_site2")).toBe("my_site2");
  });

  it("앞뒤 공백은 다듬는다", () => {
    expect(normalizeRepoName("  todo-app  ")).toBe("todo-app");
  });

  // 이 거절이 경로 조작을 막는 자리다 — 이름이 그대로 폴더 이름이 되기 때문이다.
  it("경로 구분자·상위 이동·드라이브 문자는 거절한다", () => {
    expect(normalizeRepoName("../etc")).toBeNull();
    expect(normalizeRepoName("a/b")).toBeNull();
    expect(normalizeRepoName("a\\b")).toBeNull();
    expect(normalizeRepoName("C:")).toBeNull();
    expect(normalizeRepoName(".")).toBeNull();
  });

  it("빈 이름·공백뿐인 이름은 거절한다", () => {
    expect(normalizeRepoName("")).toBeNull();
    expect(normalizeRepoName("   ")).toBeNull();
  });

  it("너무 긴 이름은 거절한다(깃허브 상한 100자)", () => {
    expect(normalizeRepoName("a".repeat(100))).toBe("a".repeat(100));
    expect(normalizeRepoName("a".repeat(101))).toBeNull();
  });
});

describe("decideOwnership", () => {
  const row = { id: 1, repoName: "todo-app", ownerUserId: "u1", createdTs: 1, lastPushTs: null };

  it("없는 이름이면 새로 만들 수 있다", () => {
    expect(decideOwnership({ repoName: "todo-app", requesterUserId: "u1", existing: null }))
      .toEqual({ ok: true, repoName: "todo-app" });
  });

  it("내 것이면 통과한다", () => {
    expect(decideOwnership({ repoName: "todo-app", requesterUserId: "u1", existing: row }))
      .toEqual({ ok: true, repoName: "todo-app" });
  });

  // 남의 리포에 푸시하는 것을 막는 유일한 지점이다.
  it("남의 것이면 거절하고, 사유에 남의 아이디를 노출하지 않는다", () => {
    const d = decideOwnership({ repoName: "todo-app", requesterUserId: "u2", existing: row });
    expect(d.ok).toBe(false);
    if (!d.ok) {
      expect(d.reason).toContain("todo-app");
      expect(d.reason).not.toContain("u1");
    }
  });
});

describe("publishSourceDir", () => {
  it("작업 폴더 아래 프로젝트 이름을 잇는다(윈도우 워커)", () => {
    expect(publishSourceDir({ workspaceDir: "C:\\ws\\111", repoName: "todo-app" }))
      .toBe(path.win32.join("C:\\ws\\111", "todo-app"));
  });

  it("POSIX 워커도 그 플레이버로 잇는다", () => {
    expect(publishSourceDir({ workspaceDir: "/ws/111", repoName: "todo-app" }))
      .toBe(path.posix.join("/ws/111", "todo-app"));
  });
});
```

- [ ] **Step 2: 실패를 확인한다**

Run: `cd agent && npx vitest run tests/publish.test.ts`
Expected: FAIL — `Cannot find module '../src/core/publish.js'`

- [ ] **Step 3: 구현한다**

`agent/src/core/publish.ts`:

```ts
import { joinUnderRoot } from "./paths.js";
import type { ProjectRow } from "../store/projectsRepo.js";

// 리포 이름은 그대로 미니PC 의 폴더 이름이 되고 GitHub URL 의 한 조각이 된다. 그래서 경로
// 구분자·상위 이동·드라이브 문자가 섞이면 고쳐 쓰지 않고 **거절한다** — 고치면 무엇으로
// 고쳐졌는지 사람도 모델도 모른다(attachments.ts 의 safeFileName 과 같은 원칙).
export const REPO_NAME_PATTERN = /^[A-Za-z0-9._-]+$/;
const REPO_NAME_MAX_LEN = 100; // GitHub 리포명 상한

export function normalizeRepoName(raw: string): string | null {
  const n = raw.trim();
  if (n.length === 0 || n.length > REPO_NAME_MAX_LEN) return null;
  if (!REPO_NAME_PATTERN.test(n)) return null;
  // 패턴은 통과하지만 경로로서 위험한 둘을 따로 막는다.
  if (n === "." || n === "..") return null;
  return n;
}

export type OwnershipDecision = { ok: true; repoName: string } | { ok: false; reason: string };

// 남의 리포에 푸시하는 것을 막는 유일한 지점이다. 사유에 기존 소유자의 아이디를 넣지 않는다 —
// 누가 무엇을 만들었는지가 이 경로로 새어 나갈 이유가 없다.
export function decideOwnership(o: {
  repoName: string;
  requesterUserId: string;
  existing: ProjectRow | null;
}): OwnershipDecision {
  if (o.existing === null) return { ok: true, repoName: o.repoName };
  if (o.existing.ownerUserId === o.requesterUserId) return { ok: true, repoName: o.repoName };
  return { ok: false, reason: `「${o.repoName}」 은 다른 분이 쓰고 있는 이름이에요. 다른 이름으로 해주세요.` };
}

// 발행 소스는 봇이 계산한다 — 모델이 경로를 주면 남의 폴더를 발행할 수 있다(설계 §6).
// joinUnderRoot 는 세그먼트를 영숫자·밑줄·하이픈으로 제한하고 base 의 플레이버로 잇는다.
export function publishSourceDir(o: { workspaceDir: string; repoName: string }): string {
  return joinUnderRoot(o.workspaceDir, o.repoName);
}
```

- [ ] **Step 4: `joinUnderRoot` 가 점(`.`)을 허용하는지 확인하고 맞춘다**

Run: `cd agent && npx vitest run tests/publish.test.ts`

`joinUnderRoot` 의 `SEGMENT_PATTERN` 은 `/^[A-Za-z0-9_-]+$/` 라 **점을 허용하지 않는다**(`agent/src/core/paths.ts`). `REPO_NAME_PATTERN` 이 점을 허용하면 `publishSourceDir` 이 던진다. 두 규칙을 일치시킨다 — `publish.ts` 의 패턴에서 점을 뺀다:

```ts
export const REPO_NAME_PATTERN = /^[A-Za-z0-9_-]+$/;
```

그리고 테스트에 그 사실을 고정하는 케이스를 더한다:

```ts
  // joinUnderRoot(paths.ts)의 세그먼트 규칙과 반드시 같아야 한다 — 여기서 통과시킨 이름이
  // 거기서 던지면 사용자에게는 "알 수 없는 오류"로만 보인다.
  it("점이 든 이름은 거절한다(joinUnderRoot 세그먼트 규칙과 일치)", () => {
    expect(normalizeRepoName("my.app")).toBeNull();
  });
```

`normalizeRepoName("a".repeat(100))` 케이스는 그대로 통과한다(하이픈·점 없이 영문자만).

- [ ] **Step 5: 통과를 확인한다**

Run: `cd agent && npx vitest run tests/publish.test.ts && npm run typecheck`
Expected: 모든 케이스 PASS

- [ ] **Step 6: 커밋**

```bash
git add agent/src/core/publish.ts agent/tests/publish.test.ts
git commit -m "feat(core): 발행 이름·경로·소유권 판정을 순수 함수로 뗀다"
```

---

### Task 3: GitHub App 설치 토큰 발급 — 봇 쪽

**Files:**
- Create: `agent/src/github/appToken.ts`
- Test: `agent/tests/appToken.test.ts`

**Interfaces:**
- Consumes: `node:crypto`
- Produces:
  - `type GithubAppConfig = { appId: string; installationId: string; org: string; privateKeyPem: string }`
  - `type FetchLike = typeof fetch`
  - `function buildAppJwt(o: { appId: string; privateKeyPem: string; nowMs: number }): string`
  - `function mintInstallationToken(o: { config: GithubAppConfig; repoNames: string[]; permissions: Record<string, string>; nowMs: number; fetchImpl?: FetchLike }): Promise<{ token: string; expiresAt: string }>`
  - `function createOrgRepo(o: { config: GithubAppConfig; token: string; repoName: string; fetchImpl?: FetchLike }): Promise<{ cloneUrl: string }>`

**참고:** `agent/src/scripts/githubProbe.ts` 가 이 호출들을 **실측으로 검증**했다(2026-08-07). JWT 조립·엔드포인트·응답 형태는 그 파일을 그대로 따른다.

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`agent/tests/appToken.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import crypto from "node:crypto";
import { buildAppJwt, mintInstallationToken, createOrgRepo } from "../src/github/appToken.js";

// 실제 키를 리포에 두지 않는다 — 테스트마다 생성한다(2048비트도 vitest 에서 충분히 빠르다).
const { privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
const privateKeyPem = privateKey.export({ type: "pkcs1", format: "pem" }).toString();

const config = { appId: "4514057", installationId: "151876954", org: "semicollon-club", privateKeyPem };

describe("buildAppJwt", () => {
  it("세 조각으로 나뉘고 헤더가 RS256 이다", () => {
    const jwt = buildAppJwt({ appId: "4514057", privateKeyPem, nowMs: 1_700_000_000_000 });
    const parts = jwt.split(".");
    expect(parts.length).toBe(3);
    expect(JSON.parse(Buffer.from(parts[0], "base64url").toString())).toEqual({ alg: "RS256", typ: "JWT" });
  });

  // iat 를 60초 앞당기는 것은 GitHub 권고다 — 이쪽 시계가 조금 빠르면 "미래에 발급된 토큰"으로
  // 거부된다. 이 값이 사라지면 시계가 맞는 기계에서는 멀쩡히 돌아 회귀를 알아채기 어렵다.
  it("iat 를 60초 앞당기고 exp 를 10분 안으로 둔다", () => {
    const nowMs = 1_700_000_000_000;
    const nowSec = Math.floor(nowMs / 1000);
    const payload = JSON.parse(
      Buffer.from(buildAppJwt({ appId: "4514057", privateKeyPem, nowMs }).split(".")[1], "base64url").toString(),
    );
    expect(payload.iat).toBe(nowSec - 60);
    expect(payload.iss).toBe("4514057");
    expect(payload.exp - nowSec).toBeLessThanOrEqual(600);
    expect(payload.exp).toBeGreaterThan(nowSec);
  });

  it("서명이 그 공개키로 검증된다", () => {
    const jwt = buildAppJwt({ appId: "4514057", privateKeyPem, nowMs: 1_700_000_000_000 });
    const [h, p, s] = jwt.split(".");
    expect(crypto.verify("RSA-SHA256", Buffer.from(`${h}.${p}`), privateKey, Buffer.from(s, "base64url"))).toBe(true);
  });
});

describe("mintInstallationToken", () => {
  it("리포와 권한을 좁혀 요청하고 토큰·만료를 돌려준다", async () => {
    let seenUrl = "";
    let seenBody: unknown = null;
    const fetchImpl = (async (url: string, init: RequestInit) => {
      seenUrl = String(url);
      seenBody = JSON.parse(String(init.body));
      return new Response(JSON.stringify({ token: "ghs_x", expires_at: "2026-08-07T08:00:00Z" }), { status: 201 });
    }) as unknown as typeof fetch;

    const r = await mintInstallationToken({
      config, repoNames: ["todo-app"], permissions: { contents: "write" },
      nowMs: 1_700_000_000_000, fetchImpl,
    });

    expect(seenUrl).toBe("https://api.github.com/app/installations/151876954/access_tokens");
    expect(seenBody).toEqual({ repositories: ["todo-app"], permissions: { contents: "write" } });
    expect(r).toEqual({ token: "ghs_x", expires_at: undefined, expiresAt: "2026-08-07T08:00:00Z" });
  });

  it("실패하면 본문의 message 를 담아 던진다", async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ message: "Bad credentials" }), { status: 401 })) as unknown as typeof fetch;
    await expect(
      mintInstallationToken({ config, repoNames: ["x"], permissions: {}, nowMs: 1, fetchImpl }),
    ).rejects.toThrow(/Bad credentials/);
  });

  // 진단 로그가 곧 유출 경로가 되면 안 된다(설계 §3).
  it("던지는 오류 메시지에 개인키가 섞이지 않는다", async () => {
    const fetchImpl = (async () => new Response("{}", { status: 500 })) as unknown as typeof fetch;
    await expect(
      mintInstallationToken({ config, repoNames: ["x"], permissions: {}, nowMs: 1, fetchImpl }),
    ).rejects.toThrow(/^(?!.*BEGIN RSA)/s);
  });
});

describe("createOrgRepo", () => {
  it("조직 엔드포인트로 비공개 리포를 만든다", async () => {
    let seenUrl = "";
    let seenBody: Record<string, unknown> = {};
    const fetchImpl = (async (url: string, init: RequestInit) => {
      seenUrl = String(url);
      seenBody = JSON.parse(String(init.body));
      return new Response(
        JSON.stringify({ clone_url: "https://github.com/semicollon-club/todo-app.git" }),
        { status: 201 },
      );
    }) as unknown as typeof fetch;

    const r = await createOrgRepo({ config, token: "ghs_x", repoName: "todo-app", fetchImpl });

    expect(seenUrl).toBe("https://api.github.com/orgs/semicollon-club/repos");
    expect(seenBody.private).toBe(true);
    expect(seenBody.name).toBe("todo-app");
    expect(r.cloneUrl).toBe("https://github.com/semicollon-club/todo-app.git");
  });

  it("이미 있으면 그 사실을 알 수 있게 던진다", async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ message: "name already exists on this account" }), { status: 422 })) as unknown as typeof fetch;
    await expect(createOrgRepo({ config, token: "t", repoName: "x", fetchImpl })).rejects.toThrow(/already exists/);
  });
});
```

- [ ] **Step 2: 실패를 확인한다**

Run: `cd agent && npx vitest run tests/appToken.test.ts`
Expected: FAIL — `Cannot find module '../src/github/appToken.js'`

- [ ] **Step 3: 구현한다**

`agent/src/github/appToken.ts`:

```ts
import crypto from "node:crypto";

export type GithubAppConfig = {
  appId: string;
  installationId: string;
  org: string;
  privateKeyPem: string;
};

export type FetchLike = typeof fetch;

const b64url = (b: Buffer): string => b.toString("base64url");

// App JWT. iss 는 App ID, 서명은 RS256. iat 를 60초 앞당기는 것은 GitHub 권고다 — 이쪽 시계가
// 조금 빠르면 "미래에 발급된 토큰"으로 거부된다. exp 는 GitHub 상한이 10분이라 9분으로 둔다.
export function buildAppJwt(o: { appId: string; privateKeyPem: string; nowMs: number }): string {
  const now = Math.floor(o.nowMs / 1000);
  const header = b64url(Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })));
  const payload = b64url(Buffer.from(JSON.stringify({ iat: now - 60, exp: now + 540, iss: o.appId })));
  const sig = b64url(crypto.sign("RSA-SHA256", Buffer.from(`${header}.${payload}`), o.privateKeyPem));
  return `${header}.${payload}.${sig}`;
}

// 오류 메시지에 자격증명이 섞이지 않게 한다 — 진단 로그가 곧 유출 경로가 되면 안 된다.
// 응답 본문의 message 만 뽑고, 그것도 없으면 상태 코드만 남긴다.
async function messageOf(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as Record<string, unknown>;
    const m = body?.message;
    return typeof m === "string" ? m : `HTTP ${res.status}`;
  } catch {
    return `HTTP ${res.status}`;
  }
}

function headers(auth: string, hasBody: boolean): Record<string, string> {
  return {
    accept: "application/vnd.github+json",
    authorization: `Bearer ${auth}`,
    "x-github-api-version": "2022-11-28",
    ...(hasBody ? { "content-type": "application/json" } : {}),
  };
}

// 요청마다 새로 발급한다. 캐시하지 않는다 — 만료를 관리하는 상태가 생기는 순간 그 상태가
// 틀렸을 때의 실패 모드가 따라오고, 발급 자체는 왕복 한 번이라 아낄 이유가 없다(설계 §3.1).
export async function mintInstallationToken(o: {
  config: GithubAppConfig;
  repoNames: string[];
  permissions: Record<string, string>;
  nowMs: number;
  fetchImpl?: FetchLike;
}): Promise<{ token: string; expiresAt: string }> {
  const jwt = buildAppJwt({ appId: o.config.appId, privateKeyPem: o.config.privateKeyPem, nowMs: o.nowMs });
  const res = await (o.fetchImpl ?? fetch)(
    `https://api.github.com/app/installations/${o.config.installationId}/access_tokens`,
    {
      method: "POST",
      headers: headers(jwt, true),
      body: JSON.stringify({ repositories: o.repoNames, permissions: o.permissions }),
    },
  );
  if (res.status !== 201) throw new Error(`깃허브 토큰을 발급하지 못했어요: ${await messageOf(res)}`);
  const body = (await res.json()) as { token: string; expires_at: string };
  return { token: body.token, expiresAt: body.expires_at };
}

// 조직 리포만 만든다. 개인 계정(POST /user/repos)은 설치 토큰으로 부를 수 없다(설계 §4.1, 실측).
export async function createOrgRepo(o: {
  config: GithubAppConfig;
  token: string;
  repoName: string;
  fetchImpl?: FetchLike;
}): Promise<{ cloneUrl: string }> {
  const res = await (o.fetchImpl ?? fetch)(`https://api.github.com/orgs/${o.config.org}/repos`, {
    method: "POST",
    headers: headers(o.token, true),
    body: JSON.stringify({ name: o.repoName, private: true, auto_init: false }),
  });
  if (res.status !== 201) throw new Error(`리포를 만들지 못했어요: ${await messageOf(res)}`);
  const body = (await res.json()) as { clone_url: string };
  return { cloneUrl: body.clone_url };
}
```

- [ ] **Step 4: 테스트의 기대값을 실제 반환 모양에 맞춘다**

Step 1 의 `mintInstallationToken` 첫 케이스는 `{ token, expires_at: undefined, expiresAt }` 를 기대하는데, 구현은 `{ token, expiresAt }` 만 돌려준다. 기대값을 고친다:

```ts
    expect(r).toEqual({ token: "ghs_x", expiresAt: "2026-08-07T08:00:00Z" });
```

- [ ] **Step 5: 통과를 확인한다**

Run: `cd agent && npx vitest run tests/appToken.test.ts && npm run typecheck`
Expected: 8 tests PASS

- [ ] **Step 6: 커밋**

```bash
git add agent/src/github/appToken.ts agent/tests/appToken.test.ts
git commit -m "feat(github): App 설치 토큰 발급과 조직 리포 생성"
```

---

### Task 4: 워커 쪽 git 실행 — 발행

**Files:**
- Create: `agent/src/remote/gitPublish.ts`
- Test: `agent/tests/gitPublish.test.ts`

**Interfaces:**
- Consumes: `RunGit`(`agent/src/remote/gitCommit.ts`) — **이 태스크에서 env 를 받도록 확장한다**
- Produces:
  - `const DEFAULT_EXCLUDES: readonly string[]`, `const MAX_PUBLISH_BYTES = 50 * 1024 * 1024`
  - `function gitignoreBody(extra?: readonly string[]): string`
  - `const CREDENTIAL_HELPER: string`
  - `function pushEnv(token: string): Record<string, string>`
  - `type PublishArgs = { dir: string; cloneUrl: string; token: string; message: string; authorName: string; authorEmail: string }`
  - `function publishArgv(a: PublishArgs): string[][]`
  - `type PublishDeps = { runGit: RunGit; writeFile: (p: string, body: string) => Promise<void>; sizeOf: (dir: string, rels: string[]) => Promise<number> }`
  - `async function runPublish(a: PublishArgs, deps: PublishDeps): Promise<{ ok: boolean; content: string }>`

**먼저 `RunGit` 을 확장한다.** `agent/src/remote/gitCommit.ts` 의 타입에 선택 인자를 더한다 —
기존 호출부(`readCommit`)는 인자를 안 주므로 그대로 돈다.

```ts
export type RunGit = (args: string[], env?: Record<string, string>) => Promise<{ ok: boolean; stdout: string }>;

export const defaultRunGit: RunGit = (args, env) =>
  new Promise((resolve) => {
    // env 를 주면 현재 환경에 얹는다. 토큰은 여기로만 전달된다 — 명령줄 인자로 주면 같은
    // 계정의 프로세스 목록(Win32_Process 의 CommandLine)에 그대로 노출된다(설계 §9).
    const child = spawn("git", args, env ? { env: { ...process.env, ...env } } : undefined);
    let stdout = "";
    child.stdout.on("data", (c: Buffer) => { stdout += c.toString(); });
    child.stderr.on("data", (c: Buffer) => { stdout += c.toString(); });
    child.on("error", () => resolve({ ok: false, stdout: "" }));
    child.on("close", (code) => resolve({ ok: code === 0, stdout }));
  });
```

`stderr` 도 함께 모으는 것이 이 확장의 일부다 — git 은 실패 사유를 stderr 로 낸다. 지금처럼
stdout 만 보면 실패 메시지가 통째로 비어 "왜 실패했는지 모르는" 상태가 된다.

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`agent/tests/gitPublish.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { DEFAULT_EXCLUDES, gitignoreBody, publishArgv, pushEnv, runPublish } from "../src/remote/gitPublish.js";
import type { RunGit } from "../src/remote/gitCommit.js";

const base = {
  dir: "/ws/111/todo-app",
  cloneUrl: "https://github.com/semicollon-club/todo-app.git",
  token: "ghs_secret",
  message: "발행",
  authorName: "홍길동",
  authorEmail: "1@users.noreply.github.com",
};

describe("제외 규칙", () => {
  it("비밀·빌드 산출물을 기본으로 뺀다", () => {
    for (const p of ["node_modules/", ".env", "dist/", "*.pem"]) expect(DEFAULT_EXCLUDES).toContain(p);
  });

  it("gitignore 본문은 한 줄에 하나씩이고 끝에 줄바꿈이 있다", () => {
    const body = gitignoreBody();
    expect(body.endsWith("\n")).toBe(true);
    expect(body.split("\n").filter(Boolean)).toEqual([...DEFAULT_EXCLUDES]);
  });

  it("추가 제외를 덧붙일 수 있다", () => {
    expect(gitignoreBody(["secret.txt"]).split("\n")).toContain("secret.txt");
  });
});

describe("publishArgv", () => {
  // 토큰이 명령줄에 실리면 같은 계정의 프로세스 목록으로 새어 나간다(설계 §9).
  it("어떤 인자에도 토큰이 들어가지 않는다", () => {
    const flat = publishArgv(base).flat().join(" ");
    expect(flat).not.toContain("ghs_secret");
  });

  it("remote 를 토큰 없는 URL 로 설정한다", () => {
    const flat = publishArgv(base).flat().join(" ");
    expect(flat).toContain("https://github.com/semicollon-club/todo-app.git");
  });

  it("author 를 부원 이름으로 지정한다", () => {
    const commit = publishArgv(base).find((a) => a[0] === "commit");
    expect(commit).toBeDefined();
    expect(commit!.join(" ")).toContain("--author=홍길동 <1@users.noreply.github.com>");
  });

  it("현재 브랜치를 main 으로 고정해 푸시한다", () => {
    const argv = publishArgv(base);
    expect(argv.some((a) => a[0] === "branch" && a.includes("main"))).toBe(true);
    expect(argv.some((a) => a[0] === "push")).toBe(true);
  });
});

describe("pushEnv", () => {
  // 토큰을 환경변수로만 넘긴다 — .git/config 에도 명령줄에도 남기지 않는다.
  it("자격증명을 환경변수로 넘긴다", () => {
    const env = pushEnv("ghs_secret");
    expect(Object.values(env).join(" ")).toContain("ghs_secret");
  });
});

describe("runPublish", () => {
  // 모든 케이스가 쓰는 기본 의존성. 용량은 작게, 파일 쓰기는 기록만.
  const deps = (runGit: RunGit, size = 10) => {
    const written: Array<[string, string]> = [];
    return {
      written,
      deps: { runGit, writeFile: async (p: string, b: string) => { written.push([p, b]); }, sizeOf: async () => size },
    };
  };
  const okGit: RunGit = async () => ({ ok: true, stdout: "" });

  it("모든 git 명령이 성공하면 ok 다", async () => {
    const calls: string[][] = [];
    const runGit: RunGit = async (args) => { calls.push(args); return { ok: true, stdout: "" }; };
    const r = await runPublish(base, deps(runGit).deps);
    expect(r.ok).toBe(true);
    // publishArgv 목록 + add 뒤의 ls-files 한 번
    expect(calls.length).toBe(publishArgv(base).length + 1);
  });

  // 이것이 제외 규칙이 실제로 집행되는 유일한 지점이다 — 목록만 있고 파일을 안 쓰면
  // node_modules 와 .env 가 그대로 커밋된다.
  it("add 전에 .gitignore 를 쓴다", async () => {
    const { written, deps: d } = deps(okGit);
    await runPublish(base, d);
    expect(written.length).toBe(1);
    expect(written[0][0]).toBe("/ws/111/todo-app/.gitignore");
    expect(written[0][1]).toContain("node_modules/");
    expect(written[0][1]).toContain(".env");
  });

  it("상한을 넘으면 commit·push 전에 멈춘다", async () => {
    const calls: string[][] = [];
    const runGit: RunGit = async (args) => { calls.push(args); return { ok: true, stdout: "big.bin\n" }; };
    const r = await runPublish(base, deps(runGit, 60 * 1024 * 1024).deps);
    expect(r.ok).toBe(false);
    expect(r.content).toContain("50MB");
    expect(calls.some((c) => c.includes("commit") || c.includes("push"))).toBe(false);
  });

  // 실패를 삼키면 "올렸다"고 말해놓고 아무것도 안 올라간 상태가 된다 — 이 저장소가 결함 유형으로
  // 다루는 "안내와 실제가 어긋남" 그 자체다.
  it("중간에 실패하면 거기서 멈추고 실패를 돌려준다", async () => {
    const calls: string[][] = [];
    const runGit: RunGit = async (args) => {
      calls.push(args);
      return args.includes("push") ? { ok: false, stdout: "rejected" } : { ok: true, stdout: "" };
    };
    const r = await runPublish(base, deps(runGit).deps);
    expect(r.ok).toBe(false);
    expect(r.content).toContain("push");
    expect(calls[calls.length - 1]).toContain("push");
  });

  // push 에만 토큰을 준다 — 토큰이 닿는 프로세스 수를 최소로 둔다.
  it("자격증명은 push 에만 넘긴다", async () => {
    const seen: Array<{ cmd: string[]; env: Record<string, string> | undefined }> = [];
    const runGit: RunGit = async (args, env) => { seen.push({ cmd: args, env }); return { ok: true, stdout: "" }; };
    await runPublish(base, deps(runGit).deps);
    const withToken = seen.filter((s) => s.env !== undefined);
    expect(withToken.length).toBe(1);
    expect(withToken[0].cmd).toContain("push");
    expect(withToken[0].env!.ASAHI_GH_TOKEN).toBe("ghs_secret");
  });

  it("실패 메시지에도 토큰이 섞이지 않는다", async () => {
    const runGit: RunGit = async () => ({ ok: false, stdout: "fatal: could not read Password for 'https://ghs_secret@github.com'" });
    const r = await runPublish(base, deps(runGit).deps);
    expect(r.content).not.toContain("ghs_secret");
  });
});
```

- [ ] **Step 2: 실패를 확인한다**

Run: `cd agent && npx vitest run tests/gitPublish.test.ts`
Expected: FAIL — `Cannot find module '../src/remote/gitPublish.js'`

- [ ] **Step 3: 구현한다**

`agent/src/remote/gitPublish.ts`:

```ts
import type { RunGit } from "./gitCommit.js";

// 제외 규칙은 편의가 아니라 방어선이다 — 부원 폴더에 남은 비밀이 그대로 발행되는 것을 막는
// 유일한 장치다(설계 §6). 목록 기반이라 완전하지 않다는 것은 설계 §11 에 적혀 있다.
export const DEFAULT_EXCLUDES = [
  "node_modules/", ".git/", ".env", ".env.*",
  "dist/", "build/", ".next/", "out/",
  "*.log", "*.pem", "*.key", "*.p12", "*.pfx",
] as const;

export function gitignoreBody(extra: readonly string[] = []): string {
  return [...DEFAULT_EXCLUDES, ...extra].join("\n") + "\n";
}

export type PublishArgs = {
  dir: string;
  cloneUrl: string;
  token: string;
  message: string;
  authorName: string;
  authorEmail: string;
};

// 토큰을 URL 에도 명령줄 인자에도 넣지 않는다(설계 §9):
//   - remote URL 에 박으면 .git/config 에 평문으로 남아 그 부원이 fs_read 로 바로 읽는다
//   - 명령줄 인자로 주면 같은 계정의 프로세스 목록(Win32_Process 의 CommandLine)에 노출된다
//
// 대신 자격증명 헬퍼가 **환경변수를 읽게** 한다. 아래 문자열 자체에는 비밀이 없다 — `$ASAHI_GH_TOKEN`
// 이라는 이름만 들어 있어 명령줄에 실려도 안전하다. git 은 `!` 로 시작하는 헬퍼를 셸로 실행하며,
// Git for Windows 도 번들된 sh 로 같은 문법을 처리한다.
export const CREDENTIAL_HELPER =
  '!f() { echo "username=x-access-token"; echo "password=$ASAHI_GH_TOKEN"; }; f';

export function pushEnv(token: string): Record<string, string> {
  return {
    ASAHI_GH_TOKEN: token,
    // 대화형 프롬프트를 끈다 — 자격증명이 없을 때 워커가 입력을 기다리며 영원히 멈추면 안 된다.
    GIT_TERMINAL_PROMPT: "0",
  };
}

// 실행할 git 명령을 순서대로 돌려준다. 목록으로 뽑아 두는 이유는 순수 함수로 검증하기 위해서다
// — 실제 실행은 runPublish 가 하고, 이 목록에 토큰이 없다는 것을 테스트가 고정한다.
export function publishArgv(a: PublishArgs): string[][] {
  const dir = ["-C", a.dir];
  const auth = ["-c", `credential.helper=${CREDENTIAL_HELPER}`];
  return [
    [...dir, "init"],
    [...dir, "branch", "-M", "main"],
    [...dir, "remote", "remove", "origin"],
    [...dir, "remote", "add", "origin", a.cloneUrl],
    [...dir, "add", "-A"],
    [...dir, "commit", "-m", a.message, `--author=${a.authorName} <${a.authorEmail}>`, "--allow-empty"],
    // 자격증명 헬퍼는 네트워크로 나가는 명령에만 붙인다. 로컬 명령까지 붙이면 그 문자열이
    // 이유 없이 여러 프로세스의 명령줄에 퍼진다.
    [...dir, ...auth, "push", "-u", "origin", "main"],
  ];
}

// 토큰이 어떤 경로로든 사용자 대면 문자열에 섞이지 않게 마지막에 한 번 더 가린다. git 이
// 실패 메시지에 URL 을 통째로 실어 주는 경우가 있어, 상류에서 안 넣는 것만으로는 부족하다.
function redact(text: string, token: string): string {
  return token.length > 0 ? text.split(token).join("***") : text;
}

// 제외 후 총 용량 상한(설계 §6). 넘으면 발행하지 않고 무엇이 컸는지 알린다 — 조용히 자르면
// 부원이 "올렸는데 왜 안 도나"로 오해한다.
export const MAX_PUBLISH_BYTES = 50 * 1024 * 1024;

export type PublishDeps = {
  runGit: RunGit;
  writeFile: (p: string, body: string) => Promise<void>;
  sizeOf: (dir: string, rels: string[]) => Promise<number>;
};

export async function runPublish(a: PublishArgs, deps: PublishDeps): Promise<{ ok: boolean; content: string }> {
  const argv = publishArgv(a);
  const env = pushEnv(a.token);

  for (const args of argv) {
    // `add -A` 직전에 .gitignore 를 쓴다. 이것이 제외 규칙이 실제로 집행되는 유일한 지점이다 —
    // 목록만 만들어 두고 파일을 안 쓰면 node_modules 와 .env 가 그대로 커밋된다.
    // init 뒤에 쓰는 이유는 폴더가 그때 확실히 존재하기 때문이고, add 앞에 쓰는 이유는
    // .gitignore 자신도 함께 커밋되어야 다음 발행에서도 같은 규칙이 적용되기 때문이다.
    if (args.includes("add")) {
      await deps.writeFile(`${a.dir}/.gitignore`, gitignoreBody());
    }

    // push 만 자격증명이 필요하다. 나머지에 env 를 주지 않는 것은 토큰이 닿는 프로세스 수를
    // 최소로 두기 위해서다.
    const r = args.includes("push") ? await deps.runGit(args, env) : await deps.runGit(args);

    // remote remove 는 origin 이 없으면 실패한다 — 첫 발행에서는 정상이므로 넘어간다.
    if (!r.ok && args.includes("remote") && args.includes("remove")) continue;
    if (!r.ok) {
      const name = args.find((x) => !x.startsWith("-") && x !== a.dir) ?? "git";
      return { ok: false, content: redact(`git ${name} 에 실패했어요: ${r.stdout}`, a.token) };
    }

    // add 직후에 스테이징된 것의 총 용량을 잰다. commit·push 전에 멈춰야 되돌릴 것이 없다.
    if (args.includes("add")) {
      const listed = await deps.runGit(["-C", a.dir, "ls-files", "--cached"]);
      const rels = listed.stdout.split("\n").map((s) => s.trim()).filter(Boolean);
      const total = await deps.sizeOf(a.dir, rels);
      if (total > MAX_PUBLISH_BYTES) {
        const mb = (total / 1024 / 1024).toFixed(1);
        return {
          ok: false,
          content:
            `올릴 파일이 너무 커요(${mb}MB, 상한 50MB). 빌드 산출물이나 큰 파일이 섞여 있는지 ` +
            `확인해 주세요 — node_modules·dist 같은 폴더는 자동으로 빠집니다.`,
        };
      }
    }
  }
  return { ok: true, content: "발행했어요." };
}
```

- [ ] **Step 4: 통과를 확인한다**

Run: `cd agent && npx vitest run tests/gitPublish.test.ts && npm run typecheck`
Expected: 10 tests PASS

`runPublish` 의 두 번째 케이스에서 `r.content` 가 `"git push 에 실패했어요"` 를 담아 `toContain("push")` 를 만족한다. 실패하면 `args[2]` 인덱스를 확인한다 — `["-C", dir, "push", ...]` 이므로 명령 이름은 인덱스 2다.

- [ ] **Step 5: 커밋**

```bash
git add agent/src/remote/gitPublish.ts agent/tests/gitPublish.test.ts
git commit -m "feat(remote): 워커 쪽 발행 git 실행을 순수 목록 + 실행기로 나눈다"
```

---

### Task 5: 워커 쪽 git 실행 — 되받기

**Files:**
- Modify: `agent/src/remote/gitPublish.ts`
- Test: `agent/tests/gitPublish.test.ts` (같은 파일에 describe 추가)

**Interfaces:**
- Consumes: Task 4 의 `RunGit`, `pushEnv`, `redact`(내부)
- Produces:
  - `type LocalState = "missing" | "clean" | "dirty"`
  - `async function inspectLocal(dir: string, runGit: RunGit, exists: (p: string) => Promise<boolean>): Promise<LocalState>`
  - `type RestoreArgs = { dir: string; cloneUrl: string; token: string; discardLocal: boolean }`
  - `async function runRestore(a: RestoreArgs, deps: { runGit: RunGit; exists: (p: string) => Promise<boolean>; rmrf: (p: string) => Promise<void> }): Promise<{ ok: boolean; content: string }>`

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`agent/tests/gitPublish.test.ts` 끝에 추가:

```ts
import { inspectLocal, runRestore } from "../src/remote/gitPublish.js";

describe("inspectLocal", () => {
  const yes = async () => true;
  const no = async () => false;

  it("폴더가 없으면 missing", async () => {
    expect(await inspectLocal("/ws/x", (async () => ({ ok: true, stdout: "" })) as RunGit, no)).toBe("missing");
  });

  it("status 가 비어 있으면 clean", async () => {
    expect(await inspectLocal("/ws/x", (async () => ({ ok: true, stdout: "" })) as RunGit, yes)).toBe("clean");
  });

  it("status 에 내용이 있으면 dirty", async () => {
    const runGit: RunGit = async () => ({ ok: true, stdout: " M src/a.ts\n?? b.txt\n" });
    expect(await inspectLocal("/ws/x", runGit, yes)).toBe("dirty");
  });

  // git 저장소가 아니면 status 가 실패한다. 그것을 clean 으로 보면 다음 단계가 pull 을 시도해
  // 엉뚱한 오류를 낸다 — 폴더는 있는데 저장소가 아닌 것은 "망가진" 쪽에 가깝다.
  it("git 저장소가 아니면 dirty 로 본다(안전한 쪽)", async () => {
    const runGit: RunGit = async () => ({ ok: false, stdout: "not a git repository" });
    expect(await inspectLocal("/ws/x", runGit, yes)).toBe("dirty");
  });
});

describe("runRestore", () => {
  const a = { dir: "/ws/111/todo-app", cloneUrl: "https://github.com/semicollon-club/todo-app.git", token: "ghs_secret", discardLocal: false };
  const never = async () => { throw new Error("불려서는 안 됩니다"); };

  it("없으면 clone 한다", async () => {
    const calls: string[][] = [];
    const runGit: RunGit = async (args) => { calls.push(args); return { ok: true, stdout: "" }; };
    const r = await runRestore(a, { runGit, exists: async () => false, rmrf: never });
    expect(r.ok).toBe(true);
    expect(calls.some((c) => c[0] === "clone")).toBe(true);
  });

  it("깨끗하면 pull --ff-only 한다", async () => {
    const calls: string[][] = [];
    const runGit: RunGit = async (args) => { calls.push(args); return { ok: true, stdout: "" }; };
    const r = await runRestore(a, { runGit, exists: async () => true, rmrf: never });
    expect(r.ok).toBe(true);
    const pull = calls.find((c) => c.includes("pull"));
    expect(pull).toBeDefined();
    expect(pull!).toContain("--ff-only");
  });

  // 이 케이스가 이 도구의 핵심이다 — 복구하려다 방금 한 작업을 없애면 안 된다(설계 §7.1).
  it("더러우면 아무것도 하지 않고 거절한다", async () => {
    const calls: string[][] = [];
    const runGit: RunGit = async (args) => {
      calls.push(args);
      return args.includes("status") ? { ok: true, stdout: " M a.ts\n" } : { ok: true, stdout: "" };
    };
    const r = await runRestore(a, { runGit, exists: async () => true, rmrf: never });
    expect(r.ok).toBe(false);
    expect(r.content).toContain("저장하지 않은 변경");
    expect(calls.some((c) => c.includes("pull") || c[0] === "clone")).toBe(false);
  });

  it("discardLocal 이면 더러워도 지우고 새로 clone 한다", async () => {
    const removed: string[] = [];
    const calls: string[][] = [];
    const runGit: RunGit = async (args) => {
      calls.push(args);
      return args.includes("status") ? { ok: true, stdout: " M a.ts\n" } : { ok: true, stdout: "" };
    };
    const r = await runRestore({ ...a, discardLocal: true }, {
      runGit, exists: async () => true, rmrf: async (p) => { removed.push(p); },
    });
    expect(r.ok).toBe(true);
    expect(removed).toEqual(["/ws/111/todo-app"]);
    expect(calls.some((c) => c[0] === "clone")).toBe(true);
    expect(r.content).toContain("지우고");
  });

  it("clone URL 과 실패 메시지에 토큰이 없다", async () => {
    const runGit: RunGit = async () => ({ ok: false, stdout: "fatal: https://ghs_secret@github.com denied" });
    const r = await runRestore(a, { runGit, exists: async () => false, rmrf: never });
    expect(r.content).not.toContain("ghs_secret");
  });
});
```

- [ ] **Step 2: 실패를 확인한다**

Run: `cd agent && npx vitest run tests/gitPublish.test.ts`
Expected: FAIL — `inspectLocal is not a function`

- [ ] **Step 3: 구현한다**

`agent/src/remote/gitPublish.ts` 끝에 추가:

```ts
export type LocalState = "missing" | "clean" | "dirty";

// 로컬이 어떤 상태인지. "폴더는 있는데 git 저장소가 아니다"는 dirty 로 본다 — 안전한 쪽이다.
// clean 으로 보면 다음 단계가 pull 을 시도해 엉뚱한 오류를 내고, 사람이 원인을 엉뚱한 곳에서
// 찾게 된다.
export async function inspectLocal(
  dir: string,
  runGit: RunGit,
  exists: (p: string) => Promise<boolean>,
): Promise<LocalState> {
  if (!(await exists(dir))) return "missing";
  const r = await runGit(["-C", dir, "status", "--porcelain"]);
  if (!r.ok) return "dirty";
  return r.stdout.trim().length === 0 ? "clean" : "dirty";
}

export type RestoreArgs = { dir: string; cloneUrl: string; token: string; discardLocal: boolean };

// 되받기. 로컬 상태로 셋으로 갈린다(설계 §7.1) — 없으면 clone, 깨끗하면 pull --ff-only,
// 더러우면 **거절한다.** 더러울 때 미는 것을 막는 게 이 도구의 핵심이다: 복구하려다 방금 한
// 작업을 조용히 없애면 안 된다. --ff-only 도 같은 이유로 갈라진 히스토리를 자동 병합하지 않는다.
export async function runRestore(
  a: RestoreArgs,
  deps: { runGit: RunGit; exists: (p: string) => Promise<boolean>; rmrf: (p: string) => Promise<void> },
): Promise<{ ok: boolean; content: string }> {
  const state = await inspectLocal(a.dir, deps.runGit, deps.exists);

  if (state === "dirty" && !a.discardLocal) {
    return {
      ok: false,
      content:
        "저장하지 않은 변경이 있어서 되받지 않았어요. 그대로 덮으면 그 작업이 사라져요. " +
        "먼저 발행해서 올리시거나, 버려도 괜찮으면 버리고 새로 받겠다고 말씀해 주세요.",
    };
  }

  let discarded = false;
  if (state !== "missing" && a.discardLocal) {
    await deps.rmrf(a.dir);
    discarded = true;
  }

  const needsClone = state === "missing" || discarded;
  const args = needsClone
    ? ["clone", a.cloneUrl, a.dir]
    : ["-C", a.dir, "pull", "--ff-only", "origin", "main"];

  const r = await deps.runGit(args);
  if (!r.ok) return { ok: false, content: redact(`되받지 못했어요: ${r.stdout}`, a.token) };

  return {
    ok: true,
    content: discarded ? "로컬을 지우고 새로 받았어요." : needsClone ? "새로 받았어요." : "최신으로 되받았어요.",
  };
}
```

- [ ] **Step 4: 통과를 확인한다**

Run: `cd agent && npx vitest run tests/gitPublish.test.ts && npm run typecheck`
Expected: 19 tests PASS

- [ ] **Step 5: 커밋**

```bash
git add agent/src/remote/gitPublish.ts agent/tests/gitPublish.test.ts
git commit -m "feat(remote): 되받기 — 없으면 clone, 깨끗하면 pull, 더러우면 거절"
```

---

### Task 6: 워커 실행기 배선 — `git_publish` · `git_restore`

**Files:**
- Modify: `agent/src/remote/executors.ts` (`file_fetch` 실행기 **뒤**에 추가)
- Test: `agent/tests/remoteExecutors.test.ts` (새 describe 블록)

**Interfaces:**
- Consumes: `runPublish`·`runRestore`(Task 4·5), `gate`(executors.ts 내부의 경로 관문)
- Produces: 실행기 두 개. **`REMOTE_TOOL_NAMES` 에 넣지 않는다** — `file_fetch` 와 같이 봇이 `hub.call` 로 직접 부르는 도구다(모델에 노출되지 않는다).

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`agent/tests/remoteExecutors.test.ts` 끝에 추가:

```ts
describe("git_publish / git_restore — 봇 전용 실행기", () => {
  it("워커 루트 밖 경로는 경로 관문이 거절한다", async () => {
    const ex = makeExecutors([root], { runPm2: async () => ({ ok: true, stdout: "[]" }) });
    const outside = process.platform === "win32" ? "C:\\nope\\x" : "/nope/x";
    const r = await ex.git_publish!({ dir: outside, cloneUrl: "https://g/x.git", token: "t", message: "m", authorName: "n", authorEmail: "e" });
    expect(r.ok).toBe(false);
    expect(r.content).toContain("폴더");
  });

  it("모델에게 노출되는 도구 목록에는 없다", async () => {
    const { REMOTE_TOOL_NAMES } = await import("../src/core/remoteTools.js");
    expect(REMOTE_TOOL_NAMES).not.toContain("git_publish");
    expect(REMOTE_TOOL_NAMES).not.toContain("git_restore");
  });
});
```

- [ ] **Step 2: 실패를 확인한다**

Run: `cd agent && npx vitest run tests/remoteExecutors.test.ts -t "봇 전용 실행기"`
Expected: FAIL — `ex.git_publish is not a function`

- [ ] **Step 3: 실행기를 더한다**

`agent/src/remote/executors.ts` 상단 import 에 추가:

```ts
import { runPublish, runRestore } from "./gitPublish.js";
import { defaultRunGit } from "./gitCommit.js";
```

`file_fetch` 실행기 **뒤**에 추가(같은 객체 리터럴 안):

```ts
    // 봇이 직접 부른다 — REMOTE_TOOL_NAMES 에 없으므로 모델에게 도구로 노출되지 않는다.
    // 모델이 cloneUrl·token 을 정하게 하면 워커가 임의 원격으로 푸시하는 표면이 열리는데,
    // 그 표면 자체가 없다(file_fetch 가 URL 을 봇에서만 받는 것과 같은 이유).
    async git_publish(args) {
      const dir = str(args.dir);
      if (!dir) return { ok: false, content: "dir 인자가 필요해요." };
      const g = gate(dir);
      if (!g.ok) return g.res;
      return runPublish(
        {
          dir: g.path,
          cloneUrl: str(args.cloneUrl) ?? "",
          token: str(args.token) ?? "",
          message: str(args.message) ?? "발행",
          authorName: str(args.authorName) ?? "asahi",
          authorEmail: str(args.authorEmail) ?? "asahi@users.noreply.github.com",
        },
        opts.runGit ?? defaultRunGit,
      );
    },

    async git_restore(args) {
      const dir = str(args.dir);
      if (!dir) return { ok: false, content: "dir 인자가 필요해요." };
      const g = gate(dir);
      if (!g.ok) return g.res;
      return runRestore(
        {
          dir: g.path,
          cloneUrl: str(args.cloneUrl) ?? "",
          token: str(args.token) ?? "",
          discardLocal: args.discardLocal === true,
        },
        {
          runGit: opts.runGit ?? defaultRunGit,
          exists: async (p) => { try { await fs.stat(p); return true; } catch { return false; } },
          rmrf: async (p) => { await fs.rm(p, { recursive: true, force: true }); },
        },
      );
    },
```

`makeExecutors` 의 `opts` 타입에 `runGit?: RunGit` 를 더한다(주입 이음매, `runPm2` 와 같은 자리).

- [ ] **Step 4: 통과를 확인한다**

Run: `cd agent && npx vitest run tests/remoteExecutors.test.ts && npm run typecheck`
Expected: 전부 PASS

- [ ] **Step 5: 커밋**

```bash
git add agent/src/remote/executors.ts agent/tests/remoteExecutors.test.ts
git commit -m "feat(remote): git_publish·git_restore 실행기를 봇 전용으로 더한다"
```

---

### Task 7: 설정·배선 — `GITHUB_*` 환경변수와 리포 등록

**Files:**
- Modify: `agent/src/config.ts`
- Modify: `agent/src/core/core.ts` (`CoreRepos` 에 `projects` 추가)
- Modify: `agent/src/index.ts` (`ProjectsRepo` 배선)
- Test: `agent/tests/config.test.ts` (새 describe)

**Interfaces:**
- Produces: `config.github: GithubAppConfig | null`

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`agent/tests/config.test.ts` 끝에 추가:

```ts
describe("깃허브 발행 설정", () => {
  const key = "-----BEGIN RSA PRIVATE KEY-----\nabc\n-----END RSA PRIVATE KEY-----\n";
  const b64 = Buffer.from(key, "utf8").toString("base64");
  const withGithub = {
    DISCORD_TOKEN: "t", DISCORD_OWNER_ID: "o", DATABASE_URL: "postgres://x",
    GITHUB_ORG: "semicollon-club", GITHUB_APP_ID: "4514057",
    GITHUB_APP_INSTALLATION_ID: "151876954", GITHUB_APP_PRIVATE_KEY_B64: b64,
  };

  it("넷이 다 있으면 설정을 만든다(개인키는 디코드된다)", () => {
    const g = loadConfig(withGithub as NodeJS.ProcessEnv).github;
    expect(g).not.toBeNull();
    expect(g!.org).toBe("semicollon-club");
    expect(g!.privateKeyPem).toBe(key);
  });

  // 부가 기능이 본 기능을 인질로 잡지 않는다 — 스킬 폴더가 없을 때 plugins 를 안 넘기는 것과
  // 같은 원칙이다. 하나라도 비면 도구를 아예 노출하지 않기 위해 null 을 돌려준다.
  it("하나라도 비면 null 이고 기동은 막지 않는다", () => {
    for (const k of ["GITHUB_ORG", "GITHUB_APP_ID", "GITHUB_APP_INSTALLATION_ID", "GITHUB_APP_PRIVATE_KEY_B64"]) {
      const { [k]: _, ...without } = withGithub as Record<string, string>;
      expect(loadConfig(without as NodeJS.ProcessEnv).github).toBeNull();
    }
  });

  it("base64 가 깨져 있으면 null 이다(기동을 막지 않는다)", () => {
    expect(loadConfig({ ...withGithub, GITHUB_APP_PRIVATE_KEY_B64: "!!!not-base64!!!" } as NodeJS.ProcessEnv).github).toBeNull();
  });
});
```

- [ ] **Step 2: 실패를 확인한다**

Run: `cd agent && npx vitest run tests/config.test.ts -t "깃허브 발행 설정"`
Expected: FAIL — `github` 가 `undefined`

- [ ] **Step 3: `config.ts` 에 더한다**

`loadConfig` 의 반환 객체에 `github` 를 더하고, 그 위에 헬퍼를 둔다:

```ts
// 개인키는 base64 한 줄로 받는다. 줄바꿈이 든 PEM 은 .env 파서·배포 플랫폼·셸마다 다르게
// 다뤄져 조용히 망가지고, 깨진 키는 "인증 실패" 한 줄로만 드러나 원인을 엉뚱한 곳에서 찾게
// 된다(deploy/github-app-셋업.md §5).
//
// 넷 중 하나라도 없으면 null 이다 — 던지지 않는다. 발행은 부가 기능이므로 설정이 없다고
// 봇이 못 뜨면 안 된다(스킬 폴더가 없을 때 plugins 를 안 넘기는 것과 같은 원칙).
function loadGithubConfig(env: NodeJS.ProcessEnv): GithubAppConfig | null {
  const org = env.GITHUB_ORG?.trim();
  const appId = env.GITHUB_APP_ID?.trim();
  const installationId = env.GITHUB_APP_INSTALLATION_ID?.trim();
  const b64 = env.GITHUB_APP_PRIVATE_KEY_B64?.trim();
  if (!org || !appId || !installationId || !b64) return null;

  const pem = Buffer.from(b64, "base64").toString("utf8");
  // base64 가 깨져도 Buffer.from 은 던지지 않고 쓰레기를 돌려준다 — PEM 헤더로 검증한다.
  if (!pem.includes("PRIVATE KEY")) return null;
  return { org, appId, installationId, privateKeyPem: pem };
}
```

import 를 더한다: `import type { GithubAppConfig } from "./github/appToken.js";`

- [ ] **Step 4: `CoreRepos` 와 `index.ts` 를 배선한다**

`agent/src/core/core.ts` 의 `CoreRepos` 에 추가:

```ts
  // 깃허브 발행의 소유권 정본(publish.ts 의 decideOwnership 이 이 값을 읽는다).
  projects: ProjectsRepo;
```

`agent/src/index.ts` 의 리포 조립부에 추가:

```ts
    projects: new ProjectsRepo(db),
```

두 파일에 import 를 더한다. `npm run typecheck` 가 테스트의 가짜 `repos` 누락을 잡아 주므로, 실패하는 테스트 파일의 가짜 객체에도 `projects` 를 채운다.

- [ ] **Step 5: 통과를 확인한다**

Run: `cd agent && npm run typecheck && npm test`
Expected: 전부 PASS

- [ ] **Step 6: 커밋**

```bash
git add agent/src/config.ts agent/src/core/core.ts agent/src/index.ts agent/tests/
git commit -m "feat(config): GITHUB_* 설정을 읽고 ProjectsRepo 를 배선한다"
```

---

### Task 8: 모델 도구 — `publish_project` · `restore_project`

**Files:**
- Modify: `agent/src/core/tools.ts`
- Test: `agent/tests/tools.test.ts`

**Interfaces:**
- Consumes: Task 1~7 전부
- Produces: 모델에 노출되는 도구 둘. `allowedToolsFor` 가 **워커 연결 + `config.github !== null` + 사람이 지켜보는 턴**일 때만 편다.

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`agent/tests/tools.test.ts` 끝에 추가:

```ts
describe("발행 도구 게이팅", () => {
  it("워커가 붙어 있고 깃허브 설정이 있으면 열린다", () => {
    const tools = allowedToolsFor({ ...ownerDm, workerConnected: true, githubReady: true });
    expect(tools).toContain("mcp__asahi__publish_project");
    expect(tools).toContain("mcp__asahi__restore_project");
  });

  it("깃허브 설정이 없으면 안 열린다(부가 기능이 본 기능을 막지 않는다)", () => {
    const tools = allowedToolsFor({ ...ownerDm, workerConnected: true, githubReady: false });
    expect(tools).not.toContain("mcp__asahi__publish_project");
  });

  it("워커가 없으면 안 열린다(발행할 파일이 있는 곳이 워커다)", () => {
    const tools = allowedToolsFor({ ...ownerDm, workerConnected: false, githubReady: true });
    expect(tools).not.toContain("mcp__asahi__publish_project");
  });

  it("손님도 쓴다(자기 폴더·자기 리포)", () => {
    const tools = allowedToolsFor({ ...guestServer, workerConnected: true, githubReady: true });
    expect(tools).toContain("mcp__asahi__publish_project");
  });

  // 사람이 안 보는 턴에서 조직 리포에 푸시가 일어나면 안 된다 — 웹 검색 결과나 이전 세션에
  // 심긴 지시가 바깥으로 나가는 경로가 된다(remember 를 그 턴에서 막은 것과 같은 이유).
  it("유휴 요약·정기 게시 턴에서는 닫힌다", () => {
    const tools = allowedToolsFor({ ...ownerDm, workerConnected: true, githubReady: true, noMemoryWrite: true });
    expect(tools).not.toContain("mcp__asahi__publish_project");
    expect(tools).not.toContain("mcp__asahi__restore_project");
  });
});
```

`ownerDm`·`guestServer` 는 이 파일이 이미 쓰는 기존 픽스처를 재사용한다. 없으면 그 파일의 기존 케이스에서 쓰는 인자 모양을 그대로 복사해 상수로 뽑는다.

- [ ] **Step 2: 실패를 확인한다**

Run: `cd agent && npx vitest run tests/tools.test.ts -t "발행 도구 게이팅"`
Expected: FAIL — 도구가 목록에 없다

- [ ] **Step 3: `allowedToolsFor` 에 축을 더한다**

`agent/src/core/tools.ts`:

```ts
// 발행 도구는 세 축을 모두 만족할 때만 연다.
//   1. 워커 연결 — 발행할 파일이 있는 곳이 워커다
//   2. 깃허브 설정(config.github !== null) — 없으면 부르는 순간 실패할 뿐이다
//   3. 사람이 지켜보는 턴 — 유휴 요약·정기 게시에서는 닫는다(설계 §7)
// 신원(소유자/손님)으로는 가르지 않는다. 손님도 자기 폴더·자기 리포에만 닿는다(§5·§6).
const publishTools = o.workerConnected && o.githubReady && !o.noMemoryWrite
  ? [t("publish_project"), t("restore_project")]
  : [];
```

`allowedToolsFor` 의 인자 타입에 `githubReady: boolean` 을 더하고, 각 신원 분기의 반환 배열에 `...publishTools` 를 편다.

- [ ] **Step 4: 핸들러를 더한다**

`agent/src/core/tools.ts` 의 도구 정의부에 둘을 더한다. 인자는 **프로젝트 이름 하나**뿐이다(설계 §5·§6):

```ts
    tool(
      "publish_project",
      "만든 프로젝트를 동아리 깃허브에 올립니다. 프로젝트 이름만 주세요 — 어느 폴더를 올릴지, 어느 리포에 올릴지는 시스템이 정합니다.",
      { name: z.string().describe("프로젝트 이름(영문·숫자·하이픈·밑줄)"), message: z.string().optional().describe("커밋 메시지") },
      publishHandler(ctx),
    ),
    tool(
      "restore_project",
      "깃허브에서 프로젝트를 되받아 옵니다. 로컬이 없으면 받아오고, 최신이 아니면 갱신합니다. 저장하지 않은 변경이 있으면 거절합니다 — discard_local 은 사용자가 '버리고 새로 받아줘'라고 명시적으로 말했을 때만 켜세요.",
      { name: z.string().describe("프로젝트 이름"), discard_local: z.boolean().optional().describe("로컬을 버리고 새로 받을지") },
      restoreHandler(ctx),
    ),
```

두 핸들러가 앞부분을 공유하므로 먼저 해석 함수를 둔다. **`dir` 도 `repoName` 도 봇이 계산한다** — 모델이 준 것은 이름 문자열뿐이다.

```ts
// 이름 하나로 "무엇을·어디서·어디로" 를 전부 결정한다. 모델이 준 값이 그대로 경로나 리포로
// 쓰이는 자리는 이 함수 안에 없다 — 이름은 normalizeRepoName 을 통과해야만 살아남고, 경로는
// ctx 의 작업 폴더에서 계산되며, 리포는 projects 표가 정한다(설계 §5·§6).
async function resolveTarget(
  ctx: ToolCtx,
  rawName: string,
): Promise<{ ok: false; content: string } | { ok: true; repoName: string; dir: string; existing: ProjectRow | null }> {
  const repoName = normalizeRepoName(rawName);
  if (repoName === null) {
    return { ok: false, content: "프로젝트 이름은 영문·숫자·하이픈·밑줄만 쓸 수 있어요(100자 이내)." };
  }
  const workspaceDir = ctx.workspaceDirs?.[0];
  if (!workspaceDir) {
    return { ok: false, content: "작업 폴더가 없어서 발행할 수 없어요. 관리자에게 폴더 등록을 요청해 주세요." };
  }
  const existing = await ctx.repos.projects.byRepoName(repoName);
  const decision = decideOwnership({ repoName, requesterUserId: ctx.userId, existing });
  if (!decision.ok) return { ok: false, content: decision.reason };

  return { ok: true, repoName, dir: publishSourceDir({ workspaceDir, repoName }), existing };
}

function cloneUrlFor(org: string, repoName: string): string {
  return `https://github.com/${org}/${repoName}.git`;
}
```

`publish_project` 핸들러:

```ts
const publishHandler = (ctx: ToolCtx) => async (args: { name: string; message?: string }) => {
  if (!ctx.github || !ctx.remote) return { ok: false, content: "지금은 발행할 수 없어요." };
  const t = await resolveTarget(ctx, args.name);
  if (!t.ok) return t;

  // 리포가 아직 없으면 만든다. administration 권한은 이 한 번에만 쓰고, 실제 푸시 토큰은
  // 아래에서 contents 로만 새로 발급한다 — 권한이 넓은 토큰이 워커까지 가지 않게 한다.
  if (t.existing === null) {
    try {
      const admin = await mintInstallationToken({
        config: ctx.github, repoNames: [], permissions: { administration: "write" }, nowMs: ctx.now(),
      });
      await createOrgRepo({ config: ctx.github, token: admin.token, repoName: t.repoName });
    } catch (err) {
      return { ok: false, content: err instanceof Error ? err.message : String(err) };
    }
    // 리포를 실제로 만든 뒤에 등록한다 — 만들기가 실패했는데 표에 남으면 그 이름이 영원히 막힌다.
    await ctx.repos.projects.claim({ repoName: t.repoName, ownerUserId: ctx.userId, ts: ctx.now() });
  }

  let token: string;
  try {
    token = (await mintInstallationToken({
      config: ctx.github, repoNames: [t.repoName], permissions: { contents: "write" }, nowMs: ctx.now(),
    })).token;
  } catch (err) {
    return { ok: false, content: err instanceof Error ? err.message : String(err) };
  }

  const r = await ctx.remote.hub.call(ctx.remote.workerId, "git_publish", {
    dir: t.dir,
    cloneUrl: cloneUrlFor(ctx.github.org, t.repoName),
    token,
    message: args.message ?? "아사히를 통해 발행",
    authorName: ctx.displayName ?? ctx.userId,
    authorEmail: `${ctx.userId}@users.noreply.github.com`,
  });

  if (r.ok) await ctx.repos.projects.touchPush(t.repoName, ctx.now());
  // 주소는 성공했을 때만 알린다 — 실패했는데 링크를 주면 없는 것을 열게 된다.
  return r.ok
    ? { ok: true, content: `올렸어요: https://github.com/${ctx.github.org}/${t.repoName}` }
    : r;
};
```

`restore_project` 핸들러:

```ts
const restoreHandler = (ctx: ToolCtx) => async (args: { name: string; discard_local?: boolean }) => {
  if (!ctx.github || !ctx.remote) return { ok: false, content: "지금은 되받을 수 없어요." };
  const t = await resolveTarget(ctx, args.name);
  if (!t.ok) return t;

  // 발행한 적 없는 이름은 되받을 것이 없다. 없는 리포로 clone 을 시도하면 git 이 인증 오류를
  // 내는데, 그 메시지가 사용자에게는 "권한 문제"로 읽혀 엉뚱한 곳을 보게 된다.
  if (t.existing === null) {
    return { ok: false, content: `「${t.repoName}」 은 아직 깃허브에 올린 적이 없어요. 먼저 발행해 주세요.` };
  }

  let token: string;
  try {
    token = (await mintInstallationToken({
      config: ctx.github, repoNames: [t.repoName], permissions: { contents: "write" }, nowMs: ctx.now(),
    })).token;
  } catch (err) {
    return { ok: false, content: err instanceof Error ? err.message : String(err) };
  }

  return ctx.remote.hub.call(ctx.remote.workerId, "git_restore", {
    dir: t.dir,
    cloneUrl: cloneUrlFor(ctx.github.org, t.repoName),
    token,
    discardLocal: args.discard_local === true,
  });
};
```

`ToolCtx` 에 `github: GithubAppConfig | null` 과 `displayName?: string` 을 더한다. `now()` 는 이 파일이 이미 쓰는 시각 주입 이음매를 따른다 — 없으면 `Date.now` 를 받는 필드를 추가한다.

- [ ] **Step 5: 통과를 확인한다**

Run: `cd agent && npm run typecheck && npm test`
Expected: 전부 PASS

- [ ] **Step 6: 커밋**

```bash
git add agent/src/core/tools.ts agent/tests/tools.test.ts
git commit -m "feat(tools): publish_project·restore_project 를 세 축 게이팅으로 연다"
```

---

### Task 9: 능력 안내 + 스모크 체크리스트

**Files:**
- Modify: `agent/src/core/persona.ts` (`buildCapabilityBlock`)
- Modify: `deploy/smoke-test.md`
- Modify: `docs/status/STATUS.md`
- Test: `agent/tests/persona.test.ts`

- [ ] **Step 1: 능력 안내에 한 줄을 더하는 테스트를 쓴다**

```ts
  it("깃허브 설정이 있고 워커가 붙어 있으면 발행을 안내한다", () => {
    const p = buildSystemPrompt({ ...ownerDm, workerConnected: true, githubReady: true });
    expect(p).toContain("깃허브");
  });

  it("깃허브 설정이 없으면 안내하지 않는다(없는 기능을 쓰라고 하지 않는다)", () => {
    const p = buildSystemPrompt({ ...ownerDm, workerConnected: true, githubReady: false });
    expect(p).not.toContain("publish_project");
  });
```

- [ ] **Step 2: 실패를 확인하고 구현한다**

Run: `cd agent && npx vitest run tests/persona.test.ts -t "깃허브"`

`buildCapabilityBlock` 에 조건부 한 줄을 더한다. **도구가 있는데 있는 줄 모르면 쓰이지 않는다** — `/help` 손님 항목을 더한 것과 같은 이유다. 도구 이름을 나열하지 않고 "만든 프로젝트를 동아리 깃허브에 올리고 되받을 수 있습니다" 수준으로 적는다.

- [ ] **Step 3: 스모크 항목을 더한다**

`deploy/smoke-test.md` 에 추가:

```markdown
- [ ] **발행이 실제로 올라가는가** — 서버 채널에서 작은 프로젝트를 만들고 "깃허브에 올려줘" 라고 한다.
  기대 결과: `https://github.com/semicollon-club/<이름>` 이 **비공개**로 생기고 커밋 author 가
  그 부원 이름이다. 리포가 public 이면 §4 의 강제가 깨진 것이다.

- [ ] **남의 프로젝트 이름은 거절되는가(음성 테스트)** — 다른 부원 계정으로 같은 이름을 발행한다.
  기대 결과: 거절되고, 메시지에 **원래 소유자의 아이디가 노출되지 않는다.**

- [ ] **토큰이 어디에도 남지 않는가** — 발행 후 워커에서 확인한다.
  기대 결과: `<프로젝트>/.git/config` 에 토큰이 없고, `Get-CimInstance Win32_Process` 의
  CommandLine 에도 없다. **이 항목이 설계 §9 의 주장을 확인하는 유일한 경로다.**

- [ ] **되받기 — 없을 때 clone** — 워커에서 프로젝트 폴더를 지운 뒤 "되받아줘" 라고 한다.
  기대 결과: 폴더가 다시 생기고 내용이 깃허브와 같다.

- [ ] **되받기 — 더러우면 거절** — 파일 하나를 고친 뒤(커밋하지 않고) "되받아줘" 라고 한다.
  기대 결과: **거절되고 그 변경이 그대로 남아 있다.** 덮였다면 §7.1 의 보호가 깨진 것이다.

- [ ] **되받기 — 버리고 새로** — 이어서 "버리고 새로 받아줘" 라고 한다.
  기대 결과: 받아지고, 무엇을 지웠는지 응답에 나온다.
```

- [ ] **Step 4: STATUS 를 갱신한다**

`docs/status/STATUS.md` "병합된 주요 기능" 에 항목을 더하고, "미완 / 미검증" 에 위 스모크 항목이 아직 안 눌렸다는 것을 남긴다.

- [ ] **Step 5: 전체 통과를 확인하고 커밋**

```bash
cd agent && npm run typecheck && npm test
cd .. && node scripts/check-docs.mjs
git add -A
git commit -m "docs: 발행 능력 안내와 스모크 체크리스트를 더한다"
```

---

## 이 계획이 다루지 않는 것

- **CI/CD 연결** — 발행이 돌아야 무엇을 배포할지가 정해진다(설계 §13). 다음 계획의 몫이다.
- **브랜치·PR 흐름** — 첫 판은 `main` 에 직접 푸시한다.
- **발행 취소·리포 삭제** — 사람이 GitHub 에서 직접 한다(설계 §11).
- **비밀 스캔** — 비공개 기본 + 제외 규칙으로 대신한다(설계 §6).
- **`Administration` 권한 축소** — 2026-08-07 에 유지하기로 정했다. 이 권한이 리포 삭제도 포함한다는 것은 실측으로 확인돼 설계 §11 에 적혀 있다.
