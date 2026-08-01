# 동아리 공용 기억 구현 계획

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 서버 채널에서 저장한 기억이 동아리 전체의 공용 기억(`scope='shared'`)이 되어, 모든 부원의 `recall` 에 보이게 한다.

**Architecture:** 새 도구도 스코프 인자도 만들지 않는다 — `remember` 를 서버 채널에도 열고 **위치가 스코프를 정한다**(DM=`user`, 서버=`shared`). 모델이 고르면 틀릴 수 있지만 위치는 틀릴 수가 없다. 누구나 쓸 수 있게 하는 대신 `recall` 이 작성자를 보여주고, 지우는 것은 소유자 전용 `forget` 이 맡는다.

**Tech Stack:** TypeScript (ESM/NodeNext), Postgres(Supabase), vitest

## Global Constraints

- TypeScript ESM/NodeNext — **상대 임포트는 반드시 `.js` 로 끝난다** (소스가 `.ts` 여도)
- 주석·커밋 메시지·사용자 노출 문자열은 전부 **한국어**. 이모지 금지
- 주석은 *왜* 를 설명한다. 코드를 옮겨 적는 주석은 쓰지 않는다
- TDD: 실패하는 테스트를 먼저 쓰고 **실패를 눈으로 확인한 뒤** 구현한다
- 커밋: Conventional Commits + 한국어 제목, 본문 끝에 `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`
- 모든 npm 명령의 작업 디렉터리는 `agent/` 다
- 태스크 완료 전 `npm test` 와 `npm run typecheck` 가 모두 통과해야 한다
- 문서를 건드린 태스크는 리포 루트에서 `node scripts/check-docs.mjs` 가 `문서 검사 통과` 를 내야 한다
- **DB 마이그레이션은 없다.** `memories.scope` 는 이미 `shared` 를 담을 수 있고 읽는 쿼리도 이미 있다 — 이 계획은 **쓰는 경로만** 만든다
- `character_fact`(`scope='character'`)는 이 계획이 건드리지 않는다. 그건 지어낸 캐릭터 신상이라 실제 기억과 물리적으로 분리돼 있고, DM 전용도 그대로다

## 파일 구조

| 파일 | 역할 | 태스크 |
|---|---|---|
| `agent/src/core/memoryScope.ts` | **신규** — 스코프 판정·렌더링(순수) | 1, 2 |
| `agent/src/core/tools.ts` | `rememberHandler` 스코프·상한, `recallHandler` 작성자, `forgetHandler` 신규, 도구 노출 | 1, 2, 3 |
| `agent/src/core/persona.ts` | 능력 안내에서 공용 기억 저장을 알린다 | 4 |
| `deploy/smoke-test.md`, `docs/status/STATUS.md`, `docs/security/capability-model.md` | 문서 | 4 |

**왜 `memoryScope.ts` 를 새로 만드는가:** `tools.ts` 는 이미 크고 여러 도구의 핸들러를 담고 있다. 이 계획이 더하는 것은 **판정과 표현** 두 순수 함수인데, 그것을 뽑아 두면 SDK·DB 없이 테스트할 수 있고 `tools.ts` 는 배선만 남는다. 이 리포가 `workerSelect.ts`·`staleWorker.ts`·`attachments.ts` 에 이미 쓰는 패턴이다.

---

### Task 1: 위치가 스코프를 정한다

**Files:**
- Create: `agent/src/core/memoryScope.ts`
- Create: `agent/tests/memoryScope.test.ts`
- Modify: `agent/src/core/tools.ts`
- Test: `agent/tests/tools.test.ts`

**Interfaces:**
- Consumes: 없음
- Produces:
  - `export function memoryScopeFor(ctx: { isPrivate: boolean }): "user" | "shared"`
  - `export const SHARED_MEMORY_MAX_LEN = 4000`
  - `rememberHandler` 가 서버 채널에서 `scope: "shared"` 로 저장한다
  - `allowedToolsFor` 가 소유자 서버·손님 서버 분기에도 `remember` 를 낸다

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`agent/tests/memoryScope.test.ts` 를 새로 만든다.

```ts
import { describe, it, expect } from "vitest";
import { memoryScopeFor, SHARED_MEMORY_MAX_LEN } from "../src/core/memoryScope.js";

describe("memoryScopeFor — 어디서 말하느냐가 스코프를 정한다", () => {
  it("DM 은 개인 기억이다", () => {
    expect(memoryScopeFor({ isPrivate: true })).toBe("user");
  });

  it("서버 채널은 동아리 공용 기억이다", () => {
    // 모델이 스코프를 고르게 하면 틀릴 수 있다 — 개인 얘기가 전원에게 보이거나 동아리
    // 사실이 한 사람에게만 남는다. 위치는 틀릴 수가 없다.
    expect(memoryScopeFor({ isPrivate: false })).toBe("shared");
  });

  it("신원과 무관하다 — 소유자든 손님이든 위치만 본다", () => {
    // 이 함수가 isOwner 를 받지 않는 것이 설계다. 받으면 "소유자는 서버에서도 개인 기억"
    // 같은 갈래가 생기고, 그때부터 어디에 뭐가 저장됐는지 사람이 추적할 수 없게 된다.
    expect(memoryScopeFor({ isPrivate: false })).toBe("shared");
    expect(memoryScopeFor({ isPrivate: true })).toBe("user");
  });

  it("상한은 4000자다", () => {
    expect(SHARED_MEMORY_MAX_LEN).toBe(4000);
  });
});
```

`agent/tests/tools.test.ts` 에도 추가한다. 이 파일의 `ctx()` 헬퍼를 그대로 쓴다.

```ts
describe("remember — 위치가 스코프를 정한다", () => {
  it("서버 채널에서는 공용 기억으로 저장한다", async () => {
    const c = await ctx({ userId: "u1", isPrivate: false, isOwner: false });
    await rememberHandler(c, { title: "회비", content: "학기당 2만원" });
    const shared = await c.repos.memories.sharedOnly();
    expect(shared.map((m) => m.title)).toEqual(["회비"]);
  });

  it("DM 에서는 개인 기억으로 저장한다(회귀 없음)", async () => {
    const c = await ctx({ userId: "u1", isPrivate: true, isOwner: false });
    await rememberHandler(c, { title: "내 취향", content: "커피" });
    expect(await c.repos.memories.sharedOnly()).toEqual([]);
    expect((await c.repos.memories.forUser("u1")).map((m) => m.title)).toEqual(["내 취향"]);
  });

  it("공용 기억이 상한을 넘으면 저장하지 않고 길이와 상한을 함께 말한다", async () => {
    // 자르지 않는다 — 조용히 잘린 기억은 사실의 일부만 남아 더 위험하다.
    const c = await ctx({ userId: "u1", isPrivate: false, isOwner: false });
    const long = "가".repeat(SHARED_MEMORY_MAX_LEN + 1);
    const out = await rememberHandler(c, { title: "회칙", content: long });
    expect(await c.repos.memories.sharedOnly()).toEqual([]);
    expect(out).toContain(String(SHARED_MEMORY_MAX_LEN));
    expect(out).toContain(String(SHARED_MEMORY_MAX_LEN + 1));
  });

  it("개인 기억에는 그 상한을 걸지 않는다", async () => {
    // 개인 기억은 본인만 보고 본인이 쓴다. 기존 동작을 이 계획이 바꾸지 않는다.
    const c = await ctx({ userId: "u1", isPrivate: true, isOwner: false });
    const long = "가".repeat(SHARED_MEMORY_MAX_LEN + 1);
    await rememberHandler(c, { title: "긴 메모", content: long });
    expect((await c.repos.memories.forUser("u1")).map((m) => m.title)).toEqual(["긴 메모"]);
  });
});

describe("allowedToolsFor — 서버에서도 기억을 저장할 수 있다", () => {
  it("소유자 서버 채널에 remember 가 열린다", () => {
    expect(allowedToolsFor("owner", false, true)).toContain("mcp__asahi__remember");
  });

  it("손님 서버 채널에도 remember 가 열린다", () => {
    // 동아리 지식이 소유자 한 사람 손으로만 쌓이지 않게 한다(스펙 §2.1).
    expect(allowedToolsFor("allowed", false, false)).toContain("mcp__asahi__remember");
  });

  it("character_fact 는 여전히 DM 전용이다", () => {
    // 지어낸 캐릭터 신상은 이 계획의 대상이 아니다.
    expect(allowedToolsFor("allowed", false, false)).not.toContain("mcp__asahi__character_fact");
    expect(allowedToolsFor("owner", false, true)).not.toContain("mcp__asahi__character_fact");
  });
});
```

`SHARED_MEMORY_MAX_LEN` 을 `tools.test.ts` 의 import 에 더한다(`../src/core/memoryScope.js` 에서).

- [ ] **Step 2: 테스트를 돌려 실패를 확인**

```bash
cd agent && npx vitest run tests/memoryScope.test.ts tests/tools.test.ts 2>&1 | tail -20
```

기대: FAIL — `Cannot find module '../src/core/memoryScope.js'`.

- [ ] **Step 3: `memoryScope.ts` 를 만든다**

`agent/src/core/memoryScope.ts`:

```ts
import type { Memory } from "../store/memoriesRepo.js";

// 공용 기억 1건의 내용 상한. recall 은 걸린 기억의 "내용 전체"를 돌려주므로, 문서를 통째로
// 넣으면 "회비 얼마야"에 회칙 전문이 딸려온다. 문서 원본이 필요하면 그건 기억이 아니라
// 파일이다 — 워커에 두고 fs_read 로 읽으면 된다.
export const SHARED_MEMORY_MAX_LEN = 4000;

// 이번 저장이 개인 기억인지 동아리 공용 기억인지. 위치 하나로만 정한다.
//
// 모델이 스코프를 고르게 하면 틀릴 수 있고, 틀리면 개인 얘기가 전원에게 보이거나 동아리
// 사실이 한 사람에게만 남는다. 위치는 틀릴 수가 없다 — workerSelect.ts 가 어느 기계를 쓸지
// 정할 때 쓰는 규칙과 같은 축이다.
//
// isOwner 를 받지 않는 것이 설계다. 받으면 "소유자는 서버에서도 개인 기억" 같은 갈래가 생기고,
// 그때부터 무엇이 어디에 저장됐는지 사람이 추적할 수 없게 된다.
export function memoryScopeFor(ctx: { isPrivate: boolean }): "user" | "shared" {
  return ctx.isPrivate ? "user" : "shared";
}
```

- [ ] **Step 4: `tools.ts` 의 `rememberHandler` 를 고친다**

import 에 더한다.

```ts
import { memoryScopeFor, SHARED_MEMORY_MAX_LEN } from "./memoryScope.js";
```

`rememberHandler` 를 바꾼다.

```ts
export async function rememberHandler(ctx: ToolCtx, args: { title: string; content: string }): Promise<string> {
  // 스코프는 위치가 정한다(memoryScope.ts) — DM 은 개인, 서버 채널은 동아리 공용이다.
  const scope = memoryScopeFor(ctx);
  if (scope === "shared") {
    // 코드포인트로 센다 — length 는 UTF-16 코드유닛이라 이모지가 2로 세어진다(이 파일의
    // truncateChars 가 같은 이유로 스프레드를 쓴다).
    const len = [...(args.content ?? "")].length;
    if (len > SHARED_MEMORY_MAX_LEN) {
      // 자르지 않고 거절한다. 조용히 잘린 기억은 사실의 일부만 남아, 아사히가 그 반쪽을
      // 전체인 것처럼 전원에게 말하게 된다.
      return `공용 기억은 ${SHARED_MEMORY_MAX_LEN}자까지예요. 지금 ${len}자라 저장하지 않았어요 — 주제별로 나눠서 저장해 주세요.`;
    }
  }
  await ctx.repos.memories.insert({ userId: ctx.userId, scope, title: args.title, content: args.content, sourceConversationId: ctx.conversationId });
  return scope === "shared" ? `동아리 공용으로 기억했어요: "${args.title}"` : `기억했어요: "${args.title}"`;
}
```

- [ ] **Step 5: 도구 노출을 넓힌다**

`allowedToolsFor` 의 **소유자 서버 분기**에 `t("remember")` 를 더한다.

```ts
  // runtime_info 는 예외로 여기서도 연다(2026-08-01): 소유자가 공유 기계에 닿는 곳이 서버
  // 채널뿐이라, 그 기계의 버전을 물어볼 수 있는 유일한 장소도 여기다.
  // remember 도 마찬가지로 연다(2026-08-02): 서버 채널의 저장은 개인 기억이 아니라 동아리
  // 공용 기억이고(memoryScope.ts), 그것을 만들 수 있는 곳이 여기뿐이다.
  if (isOwner) return [...remote, t("remember"), t("recall"), ...dirTools, t("runtime_info"), ...webTools];
```

**손님 서버 분기**(마지막 `return`)에도 더한다.

```ts
  // 손님 서버: 동아리 공용 기억은 누구나 쌓을 수 있다(스펙 §2.1). 개인 기억 저장은 DM 에서만
  // 되므로 여기서 remember 를 부르면 반드시 공용이 된다 — character_fact 는 주지 않는다.
  return [...remote, t("remember"), t("recall"), ...webTools];
```

- [ ] **Step 6: 테스트가 통과하는지 확인**

```bash
cd agent && npx vitest run tests/memoryScope.test.ts tests/tools.test.ts 2>&1 | tail -5
```

기대: PASS.

- [ ] **Step 7: 역전 시험**

셋을 차례로 확인하고 각각 되돌린다.

1. `memoryScopeFor` 를 `return "user";` 로 → "서버 채널은 동아리 공용 기억이다" 와 `remember` 서버 저장 테스트가 **FAIL**
2. 상한 검사를 지움 → "상한을 넘으면 저장하지 않고" 가 **FAIL**
3. 손님 서버 분기의 `t("remember")` 를 지움 → "손님 서버 채널에도 remember 가 열린다" 가 **FAIL**

- [ ] **Step 8: 전체 검증**

```bash
cd agent && npm test && npm run typecheck
```

- [ ] **Step 9: 커밋**

```bash
git add agent/src/core/memoryScope.ts agent/tests/memoryScope.test.ts agent/src/core/tools.ts agent/tests/tools.test.ts
git commit -F - <<'EOF'
feat(core): 서버 채널의 저장을 동아리 공용 기억으로 만든다

memories 에 shared 스코프가 있고 읽는 쿼리가 세 군데인데 쓰는 코드가 리포 전체에 없었다 —
rememberHandler 가 항상 scope: 'user' 로만 저장했다. 그래서 서버 채널의 recall 은 구조적으로
항상 빈손이었고, 아사히가 동아리 마스코트인데 동아리 지식을 쌓을 방법이 없었다.

새 도구도 스코프 인자도 만들지 않는다. remember 를 서버 채널에 열고 위치가 스코프를 정한다.
모델이 고르게 하면 틀릴 수 있지만 위치는 틀릴 수가 없다 — workerSelect.ts 가 어느 기계를
쓸지 정할 때와 같은 축이다. 동아리 사실을 공개된 자리에서 등록하게 되는 것 자체도 건강하다.

손님도 쓸 수 있다. 동아리 지식이 소유자 한 사람 손으로만 쌓이지 않는 편이 낫다는 판단이고,
그 대가는 작성자 표시와 소유자 전용 삭제가 받는다(다음 태스크).

공용 기억에 4000자 상한을 두되 자르지 않고 거절한다. 조용히 잘린 기억은 사실의 일부만 남아,
아사히가 그 반쪽을 전체인 것처럼 전원에게 말하게 된다.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
```

---

### Task 2: `recall` 이 공용 기억의 작성자를 보여준다

**Files:**
- Modify: `agent/src/core/memoryScope.ts`, `agent/src/core/tools.ts`
- Test: `agent/tests/memoryScope.test.ts`, `agent/tests/tools.test.ts`

**Interfaces:**
- Consumes: Task 1 의 `memoryScope.ts`
- Produces: `export function renderMemories(mems: Memory[], names: Record<string, string>): string`

**왜 필요한가:** 누구나 공용 기억을 쓸 수 있게 되면 **누가 넣었는지가 그 정보를 얼마나 믿을지의 근거**가 된다. `memories.user_id` 에 작성자가 이미 저장되는데 `recall` 출력에는 없다.

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`agent/tests/memoryScope.test.ts` 에 추가한다.

```ts
import { renderMemories } from "../src/core/memoryScope.js";

const mem = (o: Partial<{ id: number; userId: string; scope: "user" | "shared" | "character"; title: string; content: string }> = {}) =>
  ({ id: 1, userId: "u1", scope: "shared" as const, title: "회비", content: "학기당 2만원", ...o }) as never;

describe("renderMemories — 공용 기억에는 작성자를 붙인다", () => {
  it("공용 기억에 작성자 이름을 붙인다", () => {
    const out = renderMemories([mem()], { u1: "우성현" });
    expect(out).toContain("회비");
    expect(out).toContain("학기당 2만원");
    expect(out).toContain("우성현");
  });

  it("개인 기억에는 붙이지 않는다", () => {
    // 본인 것이라 작성자가 자명하다.
    const out = renderMemories([mem({ scope: "user", title: "내 취향", content: "커피" })], { u1: "우성현" });
    expect(out).toContain("내 취향");
    expect(out).not.toContain("우성현");
  });

  it("이름을 모르면 표시를 생략한다", () => {
    // 숫자 id 를 보여주면 읽는 사람에게 아무 의미가 없다.
    const out = renderMemories([mem()], {});
    expect(out).toContain("회비");
    expect(out).not.toContain("u1");
  });

  it("비어 있으면 빈 문자열이다", () => {
    expect(renderMemories([], {})).toBe("");
  });
});
```

`agent/tests/tools.test.ts` 에 추가한다.

```ts
  it("recall 이 공용 기억의 작성자를 보여준다", async () => {
    const c = await ctx({ userId: "u1", isPrivate: false, isOwner: false });
    await c.repos.users.upsert("u1", { role: "allowed", displayName: "우성현" });
    await rememberHandler(c, { title: "회비", content: "학기당 2만원" });
    expect(await recallHandler(c, { query: "회비" })).toContain("우성현");
  });

  it("이름 조회가 실패해도 기억은 그대로 보여준다", async () => {
    // 부가 정보가 본 기능을 인질로 잡지 않는다(proc_list 의 이름 표시와 같은 원칙).
    const c = await ctx({ userId: "u1", isPrivate: false, isOwner: false });
    await rememberHandler(c, { title: "회비", content: "학기당 2만원" });
    c.repos.users.displayNames = async () => { throw new Error("db down"); };
    const out = await recallHandler(c, { query: "회비" });
    expect(out).toContain("학기당 2만원");
  });
```

- [ ] **Step 2: 테스트를 돌려 실패를 확인**

```bash
cd agent && npx vitest run tests/memoryScope.test.ts tests/tools.test.ts -t "작성자" 2>&1 | tail -10
```

기대: FAIL — `renderMemories` 가 없음.

- [ ] **Step 3: `renderMemories` 를 더한다**

`agent/src/core/memoryScope.ts` 에 추가한다.

```ts
// recall 결과를 사람이 읽을 문자열로. 공용 기억에만 작성자를 붙인다 — 누구나 쓸 수 있는
// 저장소라 "누가 넣었는지"가 그 정보를 얼마나 믿을지의 근거가 된다. 개인 기억은 본인 것이라
// 작성자가 자명하므로 붙이지 않는다.
//
// 이름을 모르면 생략한다. 숫자 id 를 보여주면 읽는 사람에게 아무 의미가 없고, "누가 넣었는지
// 알 수 없다"는 사실은 이름이 없는 것만으로 이미 드러난다.
export function renderMemories(mems: Memory[], names: Record<string, string>): string {
  return mems
    .map((m) => {
      const who = m.scope === "shared" ? names[m.userId] : undefined;
      return who ? `- [${m.title}] ${m.content} (${who}이 등록)` : `- [${m.title}] ${m.content}`;
    })
    .join("\n");
}
```

- [ ] **Step 4: `recallHandler` 를 고친다**

```ts
export async function recallHandler(ctx: ToolCtx, args: { query: string }): Promise<string> {
  // 프라이버시 스코프: 소유자 DM=전원, 손님 DM=본인+공용, 서버=공용만.
  let pool: Memory[];
  if (ctx.isOwner && ctx.isPrivate) pool = await ctx.repos.memories.all();
  else if (ctx.isPrivate) pool = await ctx.repos.memories.forUser(ctx.userId);
  else pool = await ctx.repos.memories.sharedOnly();

  const q = (args.query ?? "").trim().toLowerCase();
  const hits = pool.filter((m) => q.length === 0 || `${m.title} ${m.content}`.toLowerCase().includes(q));
  if (hits.length === 0) return "관련 기억이 없어요.";
  // 이름 조회 실패는 대화를 막지 않는다 — 작성자 표시만 생략하고 기억은 그대로 보여준다.
  let names: Record<string, string> = {};
  try {
    names = await ctx.repos.users.displayNames();
  } catch (err) {
    console.error("[recall] 표시 이름 조회 실패 — 작성자 없이 진행:", err);
  }
  return renderMemories(hits, names);
}
```

import 에 `renderMemories` 를 더한다.

- [ ] **Step 5: 테스트가 통과하는지 확인**

```bash
cd agent && npx vitest run tests/memoryScope.test.ts tests/tools.test.ts 2>&1 | tail -5
```

- [ ] **Step 6: 역전 시험**

`renderMemories` 의 `m.scope === "shared"` 를 `true` 로 바꿔 돌린다. "개인 기억에는 붙이지 않는다" 가 **FAIL** 해야 한다. 확인 후 되돌린다.

- [ ] **Step 7: 전체 검증**

```bash
cd agent && npm test && npm run typecheck
```

- [ ] **Step 8: 커밋**

```bash
git add agent/src/core/memoryScope.ts agent/tests/memoryScope.test.ts agent/src/core/tools.ts agent/tests/tools.test.ts
git commit -F - <<'EOF'
feat(core): recall 이 공용 기억의 작성자를 보여준다

누구나 공용 기억을 쓸 수 있게 되면 누가 넣었는지가 그 정보를 얼마나 믿을지의 근거가 된다.
memories.user_id 에 작성자가 이미 저장되는데 출력에는 없었다.

개인 기억에는 붙이지 않는다 — 본인 것이라 작성자가 자명하다. 이름을 모르면 생략한다:
숫자 id 를 보여주면 읽는 사람에게 아무 의미가 없고, "누가 넣었는지 알 수 없다"는 사실은
이름이 없는 것만으로 이미 드러난다.

이름 조회 실패는 대화를 막지 않는다. 부가 정보가 본 기능을 인질로 잡지 않는다는 원칙은
proc_list 의 이름 표시와 같다.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
```

---

### Task 3: `forget` — 소유자 전용 공용 기억 삭제

**Files:**
- Modify: `agent/src/core/tools.ts`
- Test: `agent/tests/tools.test.ts`

**Interfaces:**
- Consumes: Task 1·2
- Produces: `export async function forgetHandler(ctx: ToolCtx, args: { title: string }): Promise<string>`

**왜 소유자 전용인가:** 넣는 것은 보태는 일이고 지우는 것은 **다른 사람의 기여를 없애는** 일이다. 같은 권한이 아니다.

**공용 기억만 대상이다.** 남의 개인 기억은 건드리지 않는다.

`memoriesRepo` 에 `delete(id: number): Promise<void>` 가 **이미 있다.** 새로 만들지 않는다.

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`agent/tests/tools.test.ts` 에 추가한다.

```ts
describe("forget — 공용 기억 삭제(소유자 전용)", () => {
  it("소유자가 아니면 거부한다", async () => {
    const c = await ctx({ userId: "u1", isPrivate: false, isOwner: false });
    await rememberHandler(c, { title: "회비", content: "학기당 2만원" });
    expect(await forgetHandler(c, { title: "회비" })).toMatch(/소유자/);
    expect(await c.repos.memories.sharedOnly()).toHaveLength(1);
  });

  it("하나만 걸리면 지운다", async () => {
    const c = await ctx({ userId: "owner", isPrivate: false, isOwner: true });
    await rememberHandler(c, { title: "회비", content: "학기당 2만원" });
    const out = await forgetHandler(c, { title: "회비" });
    expect(out).toContain("회비");
    expect(await c.repos.memories.sharedOnly()).toEqual([]);
  });

  it("여러 개가 걸리면 지우지 않고 목록을 보여준다", async () => {
    // 무엇을 지웠는지 모르는 삭제가 가장 나쁘다.
    const c = await ctx({ userId: "owner", isPrivate: false, isOwner: true });
    await rememberHandler(c, { title: "회비 납부", content: "매 학기 초" });
    await rememberHandler(c, { title: "회비 금액", content: "2만원" });
    const out = await forgetHandler(c, { title: "회비" });
    expect(out).toContain("회비 납부");
    expect(out).toContain("회비 금액");
    expect(await c.repos.memories.sharedOnly()).toHaveLength(2);
  });

  it("하나도 없으면 그렇게 말한다", async () => {
    const c = await ctx({ userId: "owner", isPrivate: false, isOwner: true });
    expect(await forgetHandler(c, { title: "없는것" })).toContain("없");
  });

  it("개인 기억은 지우지 않는다", async () => {
    // 남의 개인 기억은 소유자도 이 도구로 건드리지 않는다.
    //
    // ctx() 는 호출마다 openTestDb() 로 새 DB 를 연다. 두 번 부르면 서로 다른 DB 가 되어
    // 이 테스트는 아무것도 검증하지 못한다 — 같은 컨텍스트에서 위치만 바꿔 파생시킨다.
    const c = await ctx({ userId: "owner", isPrivate: true, isOwner: true });
    await rememberHandler(c, { title: "내 메모", content: "비밀" });
    const server: ToolCtx = { ...c, isPrivate: false };
    await forgetHandler(server, { title: "내 메모" });
    expect((await c.repos.memories.forUser("owner")).map((m) => m.title)).toContain("내 메모");
  });
});

describe("allowedToolsFor — forget 노출", () => {
  it("소유자는 DM·서버 양쪽에서 forget 을 받는다", () => {
    expect(allowedToolsFor("owner", true, true)).toContain("mcp__asahi__forget");
    expect(allowedToolsFor("owner", false, true)).toContain("mcp__asahi__forget");
  });

  it("손님은 어디서도 받지 못한다", () => {
    expect(allowedToolsFor("allowed", true, false)).not.toContain("mcp__asahi__forget");
    expect(allowedToolsFor("allowed", false, false)).not.toContain("mcp__asahi__forget");
  });
});
```

`ToolCtx` 를 `tools.ts` 에서 import 해야 한다(이 파일이 이미 다른 타입을 그렇게 가져온다).

- [ ] **Step 2: 테스트를 돌려 실패를 확인**

```bash
cd agent && npx vitest run tests/tools.test.ts -t "forget" 2>&1 | tail -10
```

기대: FAIL — `forgetHandler` 가 없음.

- [ ] **Step 3: `forgetHandler` 를 만든다**

`agent/src/core/tools.ts` 에서 `recallHandler` 아래에 더한다.

```ts
// 공용 기억 삭제. 소유자 전용인 이유: 넣는 것은 보태는 일이고 지우는 것은 다른 사람의 기여를
// 없애는 일이라 같은 권한이 아니다. 공용 기억만 대상이며 남의 개인 기억은 건드리지 않는다.
//
// 여러 개가 걸리면 지우지 않고 목록을 돌려준다 — 무엇을 지웠는지 모르는 삭제가 가장 나쁘다.
export async function forgetHandler(ctx: ToolCtx, args: { title: string }): Promise<string> {
  if (!ctx.isOwner) return OWNER_ONLY;
  const q = (args.title ?? "").trim().toLowerCase();
  if (q.length === 0) return "지울 기억의 제목을 알려주세요.";
  const shared = await ctx.repos.memories.sharedOnly();
  const hits = shared.filter((m) => m.title.toLowerCase().includes(q));
  if (hits.length === 0) return `"${args.title}" 에 해당하는 공용 기억이 없어요.`;
  if (hits.length > 1) {
    const list = hits.map((m) => `- ${m.title}`).join("\n");
    return `여러 개가 걸려서 지우지 않았어요. 제목을 더 정확히 알려주세요:\n${list}`;
  }
  await ctx.repos.memories.delete(hits[0].id);
  return `공용 기억을 지웠어요: "${hits[0].title}"`;
}
```

- [ ] **Step 4: 도구를 등록하고 노출한다**

MCP 도구 정의를 다른 도구들 옆에 더한다.

```ts
    tool(
      "forget",
      "(소유자 전용) 동아리 공용 기억을 제목으로 찾아 지웁니다. 여러 개가 걸리면 지우지 않고 목록을 보여줍니다.",
      { title: z.string().describe("지울 공용 기억의 제목(일부만 적어도 됩니다)") },
      async (args) => textResult(await forgetHandler(ctx, args)),
    ),
```

`allowedToolsFor` 의 **소유자 DM 분기**와 **소유자 서버 분기** 양쪽에 `t("forget")` 을 더한다. 손님 분기에는 더하지 않는다.

- [ ] **Step 5: 테스트가 통과하는지 확인**

```bash
cd agent && npx vitest run tests/tools.test.ts 2>&1 | tail -5
```

- [ ] **Step 6: 역전 시험**

둘을 차례로 확인하고 각각 되돌린다.

1. `if (!ctx.isOwner) return OWNER_ONLY;` 를 지움 → "소유자가 아니면 거부한다" 가 **FAIL**
2. `if (hits.length > 1)` 갈래를 지우고 `hits[0]` 을 그냥 지우게 함 → "여러 개가 걸리면 지우지 않고" 가 **FAIL**

- [ ] **Step 7: 전체 검증**

```bash
cd agent && npm test && npm run typecheck
```

- [ ] **Step 8: 커밋**

```bash
git add agent/src/core/tools.ts agent/tests/tools.test.ts
git commit -F - <<'EOF'
feat(core): 공용 기억을 지우는 forget 을 더한다(소유자 전용)

부원도 공용 기억을 쓸 수 있게 되면 틀린 정보와 낡은 정보가 반드시 생긴다 — 회장이 바뀌고
회비가 바뀌는데 아사히는 옛날 것을 계속 사실로 말한다. 악의보다 실수와 노후화가 문제다.
지금까지는 기억을 지우는 경로가 아예 없었다.

소유자 전용인 이유: 넣는 것은 보태는 일이고 지우는 것은 다른 사람의 기여를 없애는 일이라
같은 권한이 아니다. 공용 기억만 대상이며 남의 개인 기억은 건드리지 않는다.

여러 개가 걸리면 지우지 않고 목록을 돌려준다. 무엇을 지웠는지 모르는 삭제가 가장 나쁘다.

memoriesRepo.delete 는 이미 있었다 — 새로 만들지 않았다.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
```

---

### Task 4: 프롬프트와 문서

**Files:**
- Modify: `agent/src/core/persona.ts`, `deploy/smoke-test.md`, `docs/status/STATUS.md`, `docs/security/capability-model.md`
- Test: `agent/tests/persona.test.ts`

**Interfaces:**
- Consumes: Task 1~3
- Produces: 없음

**왜 필요한가:** 도구가 열려도 아사히가 **"서버에서는 저장할 수 없다"고 배운 상태**면 시도하지 않는다. 지금 `persona.ts` 가 정확히 그렇게 말한다.

- [ ] **Step 1: `persona.ts` 의 거짓이 된 문장을 고친다**

세 곳이 대상이다. **먼저 각 줄을 읽고** 실제 문구를 확인한 뒤 고친다.

- `:184`·`:190` — 소유자 서버 분기(워커 연결/미연결): `개인기억 저장·접근 권한 관리·DB 직접 조회는 이 채널에서 할 수 없습니다 — 소유자 DM 전용입니다.`
- `:238` — 손님 분기: `공용 기억 조회(recall)만 가능합니다. 개인기억 저장·접근 변경은 하지 않습니다.`

세 곳 모두 **공용 기억 저장이 가능하다**는 사실을 더한다. 담을 내용:

- 이 채널에서 `remember` 로 저장하면 **개인 기억이 아니라 동아리 공용 기억**이 되어 모든 부원에게 보인다
- 동아리 문서를 받으면 **주제별로 나눠** 저장한다("회비", "활동 시간", "가입 절차") — 한 건에 문서 전체를 넣으면 `recall` 이 매번 전문을 돌려준다
- 개인 기억 저장·접근 권한 관리·DB 직접 조회는 **여전히** 소유자 DM 전용이다

`:85`(`공개 채널에서는 새 설정을 저장할 수 없다`)는 **그대로 둔다** — 그건 `character_fact`(지어낸 캐릭터 신상) 얘기이고 여전히 DM 전용이다.

- [ ] **Step 2: 문구가 들어갔는지 확인한다**

```bash
cd agent && grep -c "동아리 공용" src/core/persona.ts
```

기대: 3 이상. 그리고 `:85` 의 문장이 그대로인지 함께 확인한다.

- [ ] **Step 3: `persona.test.ts` 에 테스트를 더한다**

이 파일이 능력 안내 분기를 검증하는 기존 방식을 그대로 따른다.

```ts
  it("서버 분기는 공용 기억 저장을 안내한다(소유자·손님 모두)", () => {
    // 도구가 열려도 "저장할 수 없다"고 배운 상태면 시도하지 않는다.
    for (const ctx of [
      { role: "owner" as const, isPrivate: false, isOwner: true, workerConnected: true },
      { role: "owner" as const, isPrivate: false, isOwner: true, workerConnected: false },
      { role: "allowed" as const, isPrivate: false, isOwner: false, workerConnected: false },
    ]) {
      expect(buildSystemPrompt(ctx)).toContain("동아리 공용");
    }
  });

  it("캐릭터 설정은 여전히 공개 채널에서 저장할 수 없다고 안내한다", () => {
    expect(buildSystemPrompt({ role: "allowed", isPrivate: false, isOwner: false })).toContain("새 설정을 저장할 수 없다");
  });
```

`buildSystemPrompt` 는 `{ role, isPrivate, isOwner }` 를 받고 `workerConnected` 는 선택이다(`persona.ts` 의 `PersonaContext`). 이 파일의 기존 테스트가 `buildSystemPrompt({ role: "owner", isPrivate: true, isOwner: true })` 형태로 부른다.

- [ ] **Step 4: `deploy/smoke-test.md` 에 항목 셋을 더한다**

```markdown
- [ ] **서버에서 저장한 것이 공용 기억이 되는가** — 서버 채널에서 "우리 동아리 회비는 학기당
  2만원이야, 기억해줘" 라고 한다. 그다음 **다른 부원 계정**으로 서버에서 "회비 얼마야?" 라고
  묻는다.
  기대 결과: 두 번째 계정이 그 답을 받는다. "관련 기억이 없어요" 가 나오면 저장이 개인
  기억으로 됐거나(`memoryScopeFor`) 저장 자체가 안 된 것이다.

- [ ] **작성자가 보이는가** — 위 답에 등록한 사람 이름이 붙는지 본다.
  기대 결과: `(우성현이 등록)` 같은 표시가 붙는다. 안 붙으면 그 사람의 `display_name` 이
  비어 있을 수 있다 — 그 계정으로 아무 메시지나 한 번 보내면 채워진다.

- [ ] **소유자가 지울 수 있고 부원은 못 지우는가** — 부원 계정으로 "회비 기억 지워줘" 라고
  해보고, 그다음 소유자 계정으로 같은 요청을 한다.
  기대 결과: 부원에게는 소유자 전용이라는 거부가, 소유자에게는 삭제 확인이 온다. 지운 뒤
  다시 "회비 얼마야?" 하면 없다고 답한다.
```

- [ ] **Step 5: `docs/security/capability-model.md` 를 갱신한다**

능력 계층표의 **소유자 서버**와 **손님 서버** 행에 `remember`(공용 기억)를 더하고, 소유자 두 행에 `forget` 을 더한다. 그리고 이 문서가 스코프를 설명하는 자리에 다음을 적는다.

- 저장 스코프는 **위치**가 정한다 — DM 은 `user`, 서버 채널은 `shared`
- 공용 기억은 **누구나 쓸 수 있고** 지우는 것은 소유자 전용이다
- `character_fact`(`scope='character'`)는 여전히 DM 전용이며 이 변경과 무관하다

`isOwnerDm` 이 지키는 목록(`db_schema`/`db_query`/`manage_access`)은 **바뀌지 않는다** — 그 서술을 건드리지 않도록 주의한다.

- [ ] **Step 6: `docs/status/STATUS.md` 를 갱신한다**

"병합된 주요 기능" 절의 기억 관련 항목에 공용 기억을 더한다. 담을 것: 서버 채널의 저장이 동아리 공용이 된다는 것, 누구나 쓰고 소유자만 지운다는 것, 4000자 상한과 그 이유, **이전에는 `shared` 를 쓰는 경로가 없어 서버 `recall` 이 항상 빈손이었다는 것**.

- [ ] **Step 7: 문서 검사**

```bash
node scripts/check-docs.mjs
```

기대: `문서 검사 통과`.

- [ ] **Step 8: 전체 검증**

```bash
cd agent && npm test && npm run typecheck
```

- [ ] **Step 9: 커밋**

```bash
git add agent/src/core/persona.ts agent/tests/persona.test.ts deploy/smoke-test.md docs/status/STATUS.md docs/security/capability-model.md
git commit -F - <<'EOF'
docs(memory): 공용 기억을 프롬프트와 문서에 반영한다

도구가 열려도 아사히가 "서버에서는 저장할 수 없다"고 배운 상태면 시도하지 않는다 —
persona.ts 가 정확히 그렇게 말하고 있었다. 서버 분기 셋에 공용 기억 저장을 안내하고, 동아리
문서를 받으면 주제별로 나눠 저장하도록 함께 안내한다(한 건에 전문을 넣으면 recall 이 매번
전문을 돌려준다).

character_fact 안내(:85)는 그대로 둔다 — 그건 지어낸 캐릭터 신상이고 여전히 DM 전용이다.

스모크 첫 항목이 이 기능의 핵심을 잡는다: 한 계정으로 저장하고 "다른 부원 계정"으로 조회해
보이는지. 같은 계정으로 확인하면 개인 기억이어도 통과해 버린다.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
```

---

## 배포 후 확인

이 계획의 변경은 **봇에만** 영향을 준다(워커는 기억을 다루지 않는다). main 에 머지하면 Railway 가 자동 배포한다. DB 마이그레이션은 없다 — `memories.scope` 는 이미 `shared` 를 담을 수 있다.

배포 후 `deploy/smoke-test.md` 의 새 세 항목을 실행한다. **첫 항목은 반드시 서로 다른 두 계정으로 한다** — 같은 계정으로 확인하면 개인 기억이어도 통과한다.
