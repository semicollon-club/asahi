# 컨텍스트 블록 예산·경계 구현 계획

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 컨텍스트 블록의 기억 섹션에 예산을 두고, `/새세션`(끊고 새로)과 `/기억정리`(요약해서 넘기기)를 가른다.

**Architecture:** `conversations.context_floor_ts` 하나로 두 명령을 가른다 — 최근 대화는 `ts > floor`, 요약은 `created_ts >= floor` 로 거른다. `/새세션` 은 바닥선만 긋고 캐릭터 설정을 지우며, `/기억정리` 는 요약한 뒤 바닥선을 긋는다. 기억 섹션은 문자 예산을 넘으면 나머지를 제목만 싣는다.

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
- **페르소나 재적용 경로는 건드리지 않는다.** `session_id` 를 비우면 새 세션에 현재 시스템 프롬프트가 적용되는데, 그것이 `/새세션` 의 원래 목적이고 지금도 잘 동작한다
- **`recall` 에는 예산을 걸지 않는다.** 사용자가 명시적으로 물어본 결과라 잘라낼 이유가 없다 — 예산은 컨텍스트 블록에만 건다

## 파일 구조

| 파일 | 역할 | 태스크 |
|---|---|---|
| `agent/src/core/memoryScope.ts` | 기억 섹션 예산(순수) | 1 |
| `agent/src/store/schema.ts` | `context_floor_ts` 컬럼 | 2 |
| `agent/src/store/conversationsRepo.ts` | 타입·`setContextFloor` | 2 |
| `agent/src/store/messagesRepo.ts` | `recent` 에 `sinceTs` | 2 |
| `agent/src/store/summariesRepo.ts` | `recent` 에 `sinceTs` | 2 |
| `agent/src/core/turnPrep.ts` | 바닥선으로 거르기 + 예산 적용 | 1, 2 |
| `agent/src/store/memoriesRepo.ts` | `deleteCharacterFacts` | 3 |
| `agent/src/core/core.ts` | `/새세션` 재정의, `/기억정리` 신규 | 3, 4 |
| `agent/src/core/commands.ts` | `/기억정리` 예약어·help | 4 |
| `deploy/smoke-test.md`, `docs/status/STATUS.md`, `docs/architecture/overview.md` | 문서 | 5 |

---

### Task 1: 기억 섹션의 문자 예산

**Files:**
- Modify: `agent/src/core/memoryScope.ts`, `agent/src/core/turnPrep.ts`
- Test: `agent/tests/memoryScope.test.ts`, `agent/tests/turnPrep.test.ts`

**Interfaces:**
- Consumes: 없음
- Produces:
  - `export const MEMORY_SECTION_BUDGET = 6000`
  - `renderMemories(mems: Memory[], names: Record<string, string>, opts?: { budget?: number }): string`

**왜 자르지 않고 제목만 남기는가:** 잘린 기억은 모델에게 존재 자체가 안 보인다. 아는 것이 있는데 없는 줄 아는 상태이고, 그것은 이 프로젝트가 반복해서 피해온 조용한 실패다. 제목이 남으면 모델이 "그 주제가 있다"는 것을 알고 `recall` 할 수 있다.

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`agent/tests/memoryScope.test.ts` 에 추가한다. 이 파일의 기존 `mem()` 헬퍼를 그대로 쓴다.

```ts
import { MEMORY_SECTION_BUDGET } from "../src/core/memoryScope.js";

describe("renderMemories — 문자 예산", () => {
  const big = (i: number, len: number) =>
    mem({ id: i, userId: "u1", scope: "shared" as const, title: `주제${i}`, content: "가".repeat(len) });

  it("예산을 안 넘으면 지금과 똑같다", () => {
    const out = renderMemories([big(1, 100), big(2, 100)], { u1: "우성현" }, { budget: 6000 });
    expect(out).toContain("가".repeat(100));
    expect(out).not.toContain("제목만");
  });

  it("예산을 넘으면 나머지는 제목만 싣고 안내를 붙인다", () => {
    // 자르지 않는다 — 잘린 기억은 모델에게 존재 자체가 안 보여 recall 할 생각도 못 한다.
    const out = renderMemories([big(1, 500), big(2, 500), big(3, 500)], {}, { budget: 700 });
    expect(out).toContain("가".repeat(500)); // 첫 건은 내용까지
    expect(out).toContain("주제3");          // 넘친 건도 제목은 남는다
    expect(out).toContain("recall");         // 어떻게 가져오는지 알려준다
  });

  it("넘친 기억의 내용은 실리지 않는다", () => {
    const out = renderMemories([big(1, 600), mem({ id: 2, scope: "shared" as const, title: "뒤", content: "비밀내용" })], {}, { budget: 650 });
    expect(out).toContain("뒤");
    expect(out).not.toContain("비밀내용");
  });

  it("예산을 안 주면 전부 내용까지 싣는다(recall 은 예산이 없다)", () => {
    const out = renderMemories([big(1, 5000), big(2, 5000)], {});
    expect(out).toContain("주제1");
    expect(out).toContain("주제2");
    expect(out).not.toContain("제목만");
  });

  it("첫 건이 이미 예산을 넘겨도 그 건은 내용까지 싣는다", () => {
    // 예산 때문에 아무것도 못 싣는 상태를 만들지 않는다 — 그러면 블록이 통째로 색인이 된다.
    const out = renderMemories([big(1, 5000)], {}, { budget: 100 });
    expect(out).toContain("가".repeat(5000));
  });

  it("상한 상수는 6000 이다", () => {
    expect(MEMORY_SECTION_BUDGET).toBe(6000);
  });
});
```

- [ ] **Step 2: 테스트를 돌려 실패를 확인**

```bash
cd agent && npx vitest run tests/memoryScope.test.ts 2>&1 | tail -12
```

기대: FAIL — `MEMORY_SECTION_BUDGET` 없음, `opts` 인자 무시.

- [ ] **Step 3: `memoryScope.ts` 를 고친다**

기존 `renderMemories` 의 본문(각 기억 한 줄을 만드는 부분)을 **한 건짜리 함수로 뽑고**, `renderMemories` 가 그것을 예산과 함께 쓴다. 한 줄을 만드는 규칙(공용엔 작성자, 개인·캐릭터엔 없음, 개행 제거)은 **바꾸지 않는다.**

```ts
// 컨텍스트 블록의 기억 섹션 문자 예산. recall 에는 걸지 않는다 — 그쪽은 사용자가 명시적으로
// 물어본 결과다.
//
// 6000 인 이유: 기억 1건 상한이 4000자(SHARED_MEMORY_MAX_LEN)이므로 큰 기억 한 건이 예산을
// 통째로 먹지 않고, 2026-08-03 실제 규모(공용 7건 1,409자)의 네 배까지는 동작이 전혀 바뀌지
// 않는다.
export const MEMORY_SECTION_BUDGET = 6000;

// 예산을 넘긴 기억을 "자르지" 않고 제목만 남기는 이유: 잘린 기억은 모델에게 존재 자체가 안
// 보인다. 아는 것이 있는데 없는 줄 아는 상태가 되고, 그러면 recall 할 생각도 못 한다. 제목이
// 남으면 "그 주제가 있다"는 것을 알고 가져올 수 있다.
export function renderMemories(
  mems: Memory[],
  names: Record<string, string>,
  opts: { budget?: number } = {},
): string {
  const budget = opts.budget;
  const full: string[] = [];
  const titlesOnly: string[] = [];
  let used = 0;
  for (const m of mems) {
    const line = renderOne(m, names);
    // 첫 건은 예산을 넘겨도 싣는다 — 안 그러면 큰 기억 하나 때문에 섹션 전체가 색인이 된다.
    if (budget === undefined || full.length === 0 || used + line.length <= budget) {
      full.push(line);
      used += line.length;
    } else {
      titlesOnly.push(`- [${stripNewlines(m.title)}]`);
    }
  }
  if (titlesOnly.length === 0) return full.join("\n");
  return [
    ...full,
    "(아래 주제는 제목만 있어요 — 내용이 필요하면 recall 로 물어보세요)",
    ...titlesOnly,
  ].join("\n");
}
```

`renderOne(m, names)` 은 지금 `renderMemories` 안에 있는 `.map(...)` 콜백 본문을 그대로 옮긴 것이다 — **동작을 바꾸지 말고 이름만 붙여 밖으로 뺀다.** `stripNewlines` 는 이 파일에 이미 있다.

- [ ] **Step 4: 테스트가 통과하는지 확인**

```bash
cd agent && npx vitest run tests/memoryScope.test.ts 2>&1 | tail -4
```

- [ ] **Step 5: `turnPrep` 이 예산을 넘긴다**

`agent/src/core/turnPrep.ts` 의 기억 줄만 바꾼다. **캐릭터 설정에는 예산을 걸지 않는다** — 그쪽은 `CHARACTER_FACT_LIMIT` 로 이미 건수 상한이 있다.

```ts
  const memoryLines = memories.length > 0 ? renderMemories(memories, names, { budget: MEMORY_SECTION_BUDGET }) : "(기억 없음)";
```

import 에 `MEMORY_SECTION_BUDGET` 을 더한다.

- [ ] **Step 6: `turnPrep` 테스트를 더한다**

`agent/tests/turnPrep.test.ts` 에 추가한다. 이 파일의 `repos`·`serverConv()` 를 그대로 쓴다.

```ts
  it("공용 기억이 예산을 넘으면 뒷부분이 제목만 실린다", async () => {
    for (let i = 0; i < 5; i++) {
      await repos.memories.insert({ userId: "u1", scope: "shared", title: `주제${i}`, content: "가".repeat(2000) });
    }
    const block = await buildContextBlock(repos, await serverConv(), -1);
    expect(block).toContain("주제4");      // 마지막 것도 제목은 보인다
    expect(block).toContain("recall");     // 가져오는 방법을 알려준다
  });
```

- [ ] **Step 7: 역전 시험**

`renderMemories` 의 `titlesOnly` 갈래를 지우고(넘쳐도 `full` 에 넣게) 돌린다. "예산을 넘으면 나머지는 제목만" 과 "넘친 기억의 내용은 실리지 않는다" 가 **FAIL** 해야 한다. 확인 후 되돌린다.

- [ ] **Step 8: 전체 검증**

```bash
cd agent && npm test && npm run typecheck
```

- [ ] **Step 9: 커밋**

```bash
git add agent/src/core/memoryScope.ts agent/src/core/turnPrep.ts agent/tests/memoryScope.test.ts agent/tests/turnPrep.test.ts
git commit -F - <<'EOF'
feat(core): 컨텍스트 블록의 기억 섹션에 문자 예산을 둔다

블록의 다른 섹션은 전부 상한이 있는데(캐릭터 설정 40건, 요약 3건, 최근 대화 20건) 기억만
무제한이었다. 지금은 공용 7건 1,409자라 무해하지만 2026-08-02 에 "동아리 문서를 주제별로
나눠 저장하라"를 프롬프트에 넣었고 실제로 그렇게 쓰이기 시작했다 — 기억 1건 상한이 4000자라
50건이면 최대 20만 자다.

예산을 넘으면 자르지 않고 제목만 남긴다. 잘린 기억은 모델에게 존재 자체가 안 보여, 아는 것이
있는데 없는 줄 아는 상태가 된다 — 이 프로젝트가 반복해서 피해온 조용한 실패다. 제목이 남으면
"그 주제가 있다"는 것을 알고 recall 할 수 있다.

첫 건은 예산을 넘겨도 싣는다. 안 그러면 큰 기억 하나 때문에 섹션 전체가 색인이 된다.

recall 에는 예산을 걸지 않는다 — 사용자가 명시적으로 물어본 결과라 잘라낼 이유가 없다.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
```

---

### Task 2: 컨텍스트 바닥선 배선

**Files:**
- Modify: `agent/src/store/schema.ts`, `agent/src/store/conversationsRepo.ts`, `agent/src/store/messagesRepo.ts`, `agent/src/store/summariesRepo.ts`, `agent/src/core/turnPrep.ts`
- Test: `agent/tests/turnPrep.test.ts`

**Interfaces:**
- Consumes: 없음
- Produces:
  - `Conversation` 에 `contextFloorTs: number | null`
  - `conversationsRepo.setContextFloor(id: number, ts: number): Promise<void>`
  - `messagesRepo.recent(conversationId: number, limit: number, sinceTs?: number)` — `sinceTs` 가 있으면 `ts > sinceTs` 만
  - `summariesRepo.recent(conversationId: number, limit: number, sinceTs?: number)` — `sinceTs` 가 있으면 `created_ts >= sinceTs` 만

**이 태스크만으로는 동작이 안 바뀐다.** 바닥선을 긋는 명령이 아직 없어 모든 대화가 `NULL` 이다. Task 3·4 가 그것을 쓴다.

**부등호가 다른 것이 이 태스크의 핵심이다.** 요약은 경계 시점에 만들어져 그 이전을 **대신하는** 것이라 포함되어야 하고(`>=`), 그 시점 이전의 원문 메시지는 그 요약으로 대체됐으므로 빠져야 한다(`>`).

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`agent/tests/turnPrep.test.ts` 에 추가한다.

```ts
describe("buildContextBlock — 컨텍스트 바닥선", () => {
  let db: Db;
  let repos: { memories: MemoriesRepo; summaries: SummariesRepo; messages: MessagesRepo; users: UsersRepo };
  let convs: ConversationsRepo;

  beforeEach(async () => {
    db = await openTestDb();
    repos = { memories: new MemoriesRepo(db), summaries: new SummariesRepo(db), messages: new MessagesRepo(db), users: new UsersRepo(db) };
    convs = new ConversationsRepo(db);
    await convs.create({ kind: "dm", discordChannelId: "c", primaryUserId: "u1", isPrivate: true, lastActiveTs: 1 });
  });

  const conv = async () => (await convs.getByChannelId("c"))!;

  it("바닥선이 없으면 지금과 똑같이 전부 싣는다(회귀 방지)", async () => {
    const c = await conv();
    await repos.messages.insert({ conversationId: c.id, role: "user", content: "옛날얘기", ts: 100, processed: true });
    expect(await buildContextBlock(repos, c, -1)).toContain("옛날얘기");
  });

  it("바닥선 이전 메시지는 빠지고 이후는 남는다", async () => {
    const c = await conv();
    await repos.messages.insert({ conversationId: c.id, role: "user", content: "옛날얘기", ts: 100, processed: true });
    await repos.messages.insert({ conversationId: c.id, role: "user", content: "새얘기", ts: 300, processed: true });
    await convs.setContextFloor(c.id, 200);
    const block = await buildContextBlock(repos, await conv(), -1);
    expect(block).not.toContain("옛날얘기");
    expect(block).toContain("새얘기");
  });

  it("바닥선 이전 요약은 빠진다", async () => {
    const c = await conv();
    await repos.summaries.insert({ conversationId: c.id, fromMessageId: 0, toMessageId: 1, content: "옛요약", createdTs: 100 });
    await convs.setContextFloor(c.id, 200);
    expect(await buildContextBlock(repos, await conv(), -1)).not.toContain("옛요약");
  });

  it("바닥선과 같은 시각의 요약은 남는다", async () => {
    // /기억정리 가 만드는 요약이 정확히 이 경우다 — 경계에서 만들어져 그 이전을 대신하므로
    // 포함되어야 한다. 메시지는 반대로 그 시점 이전이 대체된 것이라 빠진다(부등호가 다른 이유).
    const c = await conv();
    await repos.summaries.insert({ conversationId: c.id, fromMessageId: 0, toMessageId: 1, content: "경계요약", createdTs: 200 });
    await repos.messages.insert({ conversationId: c.id, role: "user", content: "경계메시지", ts: 200, processed: true });
    await convs.setContextFloor(c.id, 200);
    const block = await buildContextBlock(repos, await conv(), -1);
    expect(block).toContain("경계요약");
    expect(block).not.toContain("경계메시지");
  });
});
```

`messagesRepo.insert` 의 실제 시그니처는 `{ conversationId, ts, role, userId?, discordMessageId?, content, processed? }` 다(`messagesRepo.ts:12`) — 위 테스트가 그 형태를 쓰고 있다. `summariesRepo.insert` 는 `{ conversationId, fromMessageId, toMessageId, content, createdTs }` 다.

- [ ] **Step 2: 테스트를 돌려 실패를 확인**

```bash
cd agent && npx vitest run tests/turnPrep.test.ts -t "바닥선" 2>&1 | tail -10
```

기대: FAIL — `convs.setContextFloor` 없음.

- [ ] **Step 3: 스키마에 컬럼을 더한다**

`agent/src/store/schema.ts` 의 `ALTER TABLE` 들이 모여 있는 자리(170행 부근)에 더한다.

```sql
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS context_floor_ts BIGINT;
```

- [ ] **Step 4: `conversationsRepo` 를 고친다**

`Conversation` 타입과 `Row` 와 `toConversation` 세 곳에 `contextFloorTs` / `context_floor_ts` 를 더한다(`firstMessageId` 가 세 곳에 다 있는 것과 같은 방식 — `Number()` 변환도 그대로 따르되 `null` 을 유지한다).

메서드를 더한다.

```ts
  // 이 시각 이전의 대화 내용은 새 세션의 컨텍스트 블록에 싣지 않는다(turnPrep.buildContextBlock).
  // 데이터를 지우는 것이 아니라 "안 싣는다"는 표시일 뿐이다 — messages·summaries 행은 남는다.
  async setContextFloor(id: number, ts: number): Promise<void> {
    await this.db.query("UPDATE conversations SET context_floor_ts = $1 WHERE id = $2", [ts, id]);
  }
```

- [ ] **Step 5: 두 리포에 `sinceTs` 를 더한다**

`agent/src/store/messagesRepo.ts`:

```ts
  async recent(conversationId: number, limit: number, sinceTs?: number): Promise<StoredMessage[]> {
    // sinceTs 는 컨텍스트 바닥선이다 — 그 시각 이전의 원문은 요약으로 대체됐거나(/기억정리)
    // 일부러 끊긴 것이다(/새세션). 경계 시각의 메시지는 제외한다(> 이지 >= 가 아니다).
    const r = await this.db.query(
      sinceTs === undefined
        ? "SELECT * FROM (SELECT * FROM messages WHERE conversation_id = $1 ORDER BY id DESC LIMIT $2) AS recent_sub ORDER BY id ASC"
        : "SELECT * FROM (SELECT * FROM messages WHERE conversation_id = $1 AND ts > $3 ORDER BY id DESC LIMIT $2) AS recent_sub ORDER BY id ASC",
      sinceTs === undefined ? [conversationId, limit] : [conversationId, limit, sinceTs],
    );
    return (r.rows as Row[]).map(toMessage);
  }
```

`agent/src/store/summariesRepo.ts`:

```ts
  async recent(conversationId: number, limit: number, sinceTs?: number): Promise<string[]> {
    // 메시지와 달리 경계 시각의 요약은 포함한다(>= 이지 > 가 아니다) — /기억정리 가 만드는
    // 요약이 정확히 그 시각에 생기고, 그것이 그 이전 대화를 대신하는 물건이기 때문이다.
    const r = await this.db.query(
      sinceTs === undefined
        ? "SELECT content FROM conversation_summaries WHERE conversation_id = $1 ORDER BY id DESC LIMIT $2"
        : "SELECT content FROM conversation_summaries WHERE conversation_id = $1 AND created_ts >= $3 ORDER BY id DESC LIMIT $2",
      sinceTs === undefined ? [conversationId, limit] : [conversationId, limit, sinceTs],
    );
    return (r.rows as Array<{ content: string }>).map((row) => row.content);
  }
```

`conversation_summaries` 의 실제 컬럼명이 `created_ts` 인지 `schema.ts` 에서 확인한다.

- [ ] **Step 6: `turnPrep` 이 바닥선을 넘긴다**

```ts
  const floor = conv.contextFloorTs ?? undefined;
  const summaries = await repos.summaries.recent(conv.id, 3, floor);
  const recentAll = await repos.messages.recent(conv.id, 21, floor);
```

- [ ] **Step 7: 테스트가 통과하는지 확인**

```bash
cd agent && npx vitest run tests/turnPrep.test.ts 2>&1 | tail -4
```

- [ ] **Step 8: 역전 시험**

`summariesRepo.recent` 의 `>=` 를 `>` 로 바꿔 돌린다. "바닥선과 같은 시각의 요약은 남는다" 가 **FAIL** 해야 한다. 확인 후 되돌린다.

- [ ] **Step 9: 전체 검증**

```bash
cd agent && npm test && npm run typecheck
```

- [ ] **Step 10: 커밋**

```bash
git add agent/src/store agent/src/core/turnPrep.ts agent/tests/turnPrep.test.ts
git commit -F - <<'EOF'
feat(store): 컨텍스트 바닥선을 도입한다

conversations.context_floor_ts — "이 시각 이전의 대화 내용은 새 세션 컨텍스트에 싣지 않는다"
는 표시다. 데이터를 지우는 것이 아니라 안 싣는 것뿐이라 messages·summaries 행은 남는다.

메시지는 ts > floor, 요약은 created_ts >= floor 로 거른다. 부등호가 다른 것이 핵심이다 —
요약은 경계 시점에 만들어져 그 이전을 대신하는 것이라 포함되어야 하고, 그 시점 이전의 원문은
그 요약으로 대체됐으므로 빠져야 한다.

시각 기준인 이유: 메시지 id 로 하면 요약(범위를 가진 것)과 메시지(점인 것)를 서로 다른 규칙으로
걸러야 해서 경계가 어긋난다.

이 커밋만으로는 동작이 바뀌지 않는다 — 바닥선을 긋는 명령이 아직 없어 모든 대화가 NULL 이다.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
```

---

### Task 3: `/새세션` 재정의

**Files:**
- Modify: `agent/src/store/memoriesRepo.ts`, `agent/src/core/core.ts`
- Test: `agent/tests/identityRepos.test.ts`(또는 `memories` 리포를 검증하는 파일), `agent/tests/coreMulti.test.ts`

**Interfaces:**
- Consumes: Task 2 의 `setContextFloor`
- Produces: `memoriesRepo.deleteCharacterFacts(): Promise<number>` — 지운 건수

**이 태스크에서 가장 위험한 지점은 삭제 범위다.** `scope='character'` 만 지워야 하고 `user`·`shared` 는 남아야 한다. 동아리 공용 기억을 실수로 지우면 복구할 방법이 없다.

- [ ] **Step 1: 리포 삭제 테스트를 먼저 쓴다**

`memories` 리포를 검증하는 테스트 파일을 찾아(`ls tests | grep -i repo`) 그 파일의 방식대로 추가한다.

```ts
  it("deleteCharacterFacts 는 캐릭터 설정만 지우고 개수를 돌려준다", async () => {
    const db = await openTestDb();
    const repo = new MemoriesRepo(db);
    await repo.insert({ userId: "u", scope: "character", title: "학년", content: "2학년" });
    await repo.insert({ userId: "u", scope: "character", title: "취향", content: "커피" });
    await repo.insert({ userId: "u", scope: "user", title: "개인", content: "내 메모" });
    await repo.insert({ userId: "u", scope: "shared", title: "회비", content: "2만원" });

    expect(await repo.deleteCharacterFacts()).toBe(2);
    expect(await repo.characterFacts(40)).toEqual([]);
    // 동아리 공용 기억과 개인 기억은 남아야 한다 — 여기서 범위가 새면 복구할 방법이 없다.
    expect((await repo.sharedOnly()).map((m) => m.title)).toEqual(["회비"]);
    expect((await repo.forUser("u")).map((m) => m.title).sort()).toEqual(["개인", "회비"]);
  });

  it("지울 것이 없으면 0 을 돌려준다", async () => {
    const db = await openTestDb();
    expect(await new MemoriesRepo(db).deleteCharacterFacts()).toBe(0);
  });
```

- [ ] **Step 2: 실패 확인 후 구현**

```bash
cd agent && npx vitest run tests/ -t "deleteCharacterFacts" 2>&1 | tail -6
```

기대: FAIL — 함수 없음. 그다음 `agent/src/store/memoriesRepo.ts` 에 더한다.

```ts
  // /새세션 이 캐릭터 설정(즉흥으로 지어낸 자기 신상)을 비울 때 쓴다. 전역이다 — 캐릭터 설정은
  // user_id·conversation_id 로 스코프되지 않으므로(characterFacts 참고) 방별로 가릴 수가 없다.
  // scope 가 정확히 'character' 인 것만 지운다: user·shared 는 동아리 지식과 개인 기억이라
  // 여기서 범위가 새면 복구할 방법이 없다.
  async deleteCharacterFacts(): Promise<number> {
    const r = await this.db.query("DELETE FROM memories WHERE scope = 'character'");
    return r.rowCount ?? 0;
  }
```

`r.rowCount` 가 이 DB 래퍼에서 실제로 오는지 확인한다 — 안 오면 `DELETE ... RETURNING id` 로 바꿔 `r.rows.length` 를 쓴다.

- [ ] **Step 3: `/새세션` 핸들러를 고친다**

`agent/src/core/core.ts` 의 `parseSessionCommand(text) === "reset"` 블록을 바꾼다.

```ts
    if (parseSessionCommand(text) === "reset") {
      // 세 가지를 함께 한다.
      // 1) session_id 를 비운다 — 다음 턴에 새 SDK 세션이 열리고 현재 시스템 프롬프트가
      //    적용된다. resume 된 세션은 만들어질 때의 프롬프트를 유지하므로, 페르소나 파일을
      //    고쳐 배포해도 활발한 DM 에는 반영되지 않는다. 이 명령의 원래 목적이다.
      // 2) 컨텍스트 바닥선을 긋는다 — 이전 대화도 이전 요약도 다음 세션에 싣지 않는다.
      //    데이터는 남는다(소유자는 db_query 로 볼 수 있다).
      // 3) 캐릭터 설정을 지운다 — 페르소나를 바꾼 뒤에도 옛 즉흥 신상이 남으면 새 페르소나와
      //    충돌한다. 가리지 않고 지우는 이유는 그것이 전역이기 때문이다: 방별로 가리면 같은
      //    아사히가 방마다 다른 신상을 갖게 된다(memoriesRepo.characterFacts 주석 참고).
      const t = this.now();
      await this.repos.conversations.setSession(conv.id, null, t);
      await this.repos.conversations.setContextFloor(conv.id, t);
      const cleared = await this.repos.memories.deleteCharacterFacts();
      const factNote = cleared > 0 ? ` 지어낸 설정 ${cleared}개도 지웠어.` : "";
      this.bus.publish({
        type: "assistant_message", channel: "discord", channelRef: conv.discordChannelId,
        text: `…알겠어. 여기까지 나눈 얘기는 안 가져갈게.${factNote} 기억해둔 건 그대로 있어.`,
        ts: t,
      });
      return;
    }
```

문구가 **무엇이 빠지고 무엇이 남는지**를 말해야 한다. 지금 문구("새 세션으로 시작할게")는 대화가 끊기는지 아닌지를 알려주지 않는다.

- [ ] **Step 4: 배선 테스트를 더한다**

`agent/tests/coreMulti.test.ts` 의 `describe("AgentCore — DM 세션 예약어(/새세션)")`(595행 부근) 안에 추가한다. 그 블록의 기존 테스트가 쓰는 `setup()`·`pub()`·`dmHint()`·`t.core.drain()` 을 그대로 쓴다.

```ts
  it("/새세션 은 바닥선을 긋고 캐릭터 설정을 지우되 기억은 남긴다", async () => {
    const t = await setup();
    await t.repos.memories.insert({ userId: "owner", scope: "character", title: "학년", content: "2학년" });
    await t.repos.memories.insert({ userId: "owner", scope: "shared", title: "회비", content: "2만원" });
    await t.repos.memories.insert({ userId: "owner", scope: "user", title: "개인", content: "내 메모" });
    pub(t.bus, dmHint("owner", "owner"), "안녕", 1);
    await t.core.drain();

    pub(t.bus, dmHint("owner", "owner"), "/새세션", 2);
    await t.core.drain();

    const after = await t.repos.conversations.getByChannelId("dm-owner");
    expect(after?.sessionId).toBeNull();
    expect(after?.contextFloorTs).not.toBeNull();
    expect(await t.repos.memories.characterFacts(40)).toEqual([]);
    // 여기가 핵심 — 삭제 범위가 새면 동아리 공용 기억이 복구 불가능하게 사라진다.
    expect((await t.repos.memories.sharedOnly()).map((m) => m.title)).toEqual(["회비"]);
    expect((await t.repos.memories.forUser("owner")).map((m) => m.title).sort()).toEqual(["개인", "회비"]);
    expect(t.calls).toHaveLength(1); // 예약어는 LLM 턴 없이 끝난다(회귀 방지)
  });
```

`t.repos.memories` 가 `setup()` 의 반환에 있는지 먼저 확인한다 — 없으면 그 파일이 리포를 노출하는 방식을 따른다.

- [ ] **Step 5: 역전 시험**

`deleteCharacterFacts` 의 `WHERE scope = 'character'` 를 지워 전부 지우게 만든 뒤 돌린다. "개수를 돌려준다" 테스트의 `sharedOnly`·`forUser` 단정이 **FAIL** 해야 한다. 확인 후 되돌린다.

- [ ] **Step 6: 전체 검증**

```bash
cd agent && npm test && npm run typecheck
```

- [ ] **Step 7: 커밋**

```bash
git add agent/src/store/memoriesRepo.ts agent/src/core/core.ts agent/tests
git commit -F - <<'EOF'
feat(core): /새세션 이 대화를 끊고 캐릭터 설정을 비운다

session_id 만 비우던 것에 두 가지를 더한다. 컨텍스트 바닥선을 긋고(이전 대화·요약을 다음
세션에 안 싣는다), 캐릭터 설정을 지운다(즉흥으로 지어낸 자기 신상).

이름과 실제가 어긋나 있었다. 이 명령은 페르소나 재적용 용도로 만들어졌고 그건 지금도 잘
동작하지만, buildContextBlock 이 직전 메시지 20개를 원문 그대로 다시 실어 말투만 리셋되고
내용은 이어졌다. 사용자가 /새세션 에 기대하는 것은 주제를 갈아타는 것이다.

캐릭터 설정을 가리지 않고 지우는 이유는 그것이 전역이기 때문이다 — characterFacts() 는
user_id 로도 conversation_id 로도 안 거른다. 방별로 가리면 같은 아사히가 방마다 다른 신상을
갖게 되어, 코드 주석이 "소유자에게 한 말이 손님에게도 같아야 한다"며 막으려던 상태가 된다.

손님도 그대로 쓸 수 있다. character_fact 쓰기가 이미 손님 DM 에 열려 있어 부원 한 명의
잡담이 전역 canon 을 정하는 구조인데, 쓰기가 전역인 채로 비우기만 막는 것은 앞뒤가 맞지
않는다. 되돌릴 수는 없지만 다시 물어보면 새로 지어내므로 복구 불가능한 손실이 아니다.

기억(user/shared)은 남는다. 동아리 회비가 얼마인지는 주제를 갈아탄다고 잊을 일이 아니다.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
```

---

### Task 4: `/기억정리` 신규

**Files:**
- Modify: `agent/src/core/commands.ts`, `agent/src/core/core.ts`
- Test: `agent/tests/commands.test.ts`, `agent/tests/coreMulti.test.ts`

**Interfaces:**
- Consumes: Task 2 의 `setContextFloor`
- Produces: `parseSessionCommand` 가 `"compact"` 도 돌려준다

**핵심: 실패하면 아무것도 바꾸지 않는다.** 세션과 바닥선을 밀어놓고 요약이 실패하면 **대화를 잃고 대신 받은 것도 없는 상태**가 된다. 유휴 요약(`summarizeAndClose`)은 반대로 "실패해도 세션은 반드시 닫는다"인데(그 주석에 근거가 있다), 그쪽은 요약이 부수적이고 이쪽은 사용자가 **요약을 받으려고** 부른 명령이라 다르다.

- [ ] **Step 1: 예약어 테스트를 먼저 쓴다**

`agent/tests/commands.test.ts` 에 추가한다.

```ts
  it("/기억정리 를 compact 로 인식한다", () => {
    expect(parseSessionCommand("/기억정리")).toBe("compact");
    expect(parseSessionCommand(" /기억정리 ")).toBe("compact");
  });

  it("/새세션 은 여전히 reset 이다", () => {
    expect(parseSessionCommand("/새세션")).toBe("reset");
  });

  it("/기억정리 는 대화 없는 채널에서 처리하지 않는다", () => {
    // /새세션 과 같은 이유다 — 정리할 세션이 있어야 의미가 있고, 대화가 없는 채널에는
    // 대상 자체가 없다. 통과시키면 그 채널이 대화로 채택돼 이후 잡담에 봇이 끼어든다.
    expect(isChannelCommand("/기억정리")).toBe(false);
  });
```

- [ ] **Step 2: 실패 확인 후 `commands.ts` 를 고친다**

```bash
cd agent && npx vitest run tests/commands.test.ts 2>&1 | tail -6
```

그다음:

```ts
const RESET_COMMANDS = new Set(["/새세션", "/새대화", "/새로시작", "/reset"]);
// 지금 세션의 대화를 요약해 다음 세션으로 넘긴다(Claude Code 의 /compact 에 해당).
// /새세션 과 달리 캐릭터 설정을 지우지 않는다 — 이 명령은 "정리해서 넘긴다"는 뜻이지
// "다른 사람이 되자"가 아니다.
const COMPACT_COMMANDS = new Set(["/기억정리", "/compact"]);

export type SessionCommand = "reset" | "compact";

export function parseSessionCommand(text: string): SessionCommand | null {
  const t = text.trim().toLowerCase();
  if (RESET_COMMANDS.has(t)) return "reset";
  if (COMPACT_COMMANDS.has(t)) return "compact";
  return null;
}
```

`COMMAND_HELP` 에 항목을 더하고, 기존 `/새세션` 설명도 새 동작에 맞게 고친다.

```ts
  { commands: [...RESET_COMMANDS], description: "지금까지의 대화를 끊고 새로 시작한다. 지어낸 설정도 지운다(기억은 남는다)" },
  { commands: [...COMPACT_COMMANDS], description: "지금까지의 대화를 요약해서 다음 세션으로 넘긴다" },
```

`isChannelCommand` 는 **바꾸지 않는다** — `/기억정리` 도 `parseSessionCommand` 로만 인식되므로 자동으로 제외된다. Step 1 의 세 번째 테스트가 그것을 고정한다.

- [ ] **Step 3: 요약 턴을 재사용 가능하게 뽑는다**

`agent/src/core/core.ts` 의 `summarizeAndClose` 에서 **요약 턴을 도는 부분만** 별도 private 메서드로 뽑는다. 유휴 검사·compare-and-close·세션 정리는 `summarizeAndClose` 에 그대로 둔다.

```ts
  // 이 대화의 지금 세션을 요약해 summaries 에 넣는다. 성공하면 true.
  // summarizeAndClose(유휴 스윕)와 /기억정리 가 함께 쓴다 — 요약 턴의 안전 플래그
  // (noRemoteTools·noWebTools·noSkills·noMemoryWrite)를 두 곳에서 따로 관리하면 한쪽만
  // 빠뜨렸을 때 아무도 모른다.
  private async writeSummary(conv: Conversation, createdTs: number): Promise<boolean> { ... }
```

**옮기는 것이지 고치는 것이 아니다.** 안전 플래그 네 개와 `workerConnected: false`, `systemPrompt` 구성, `toMessageId` 계산을 **한 줄도 바꾸지 말고** 그대로 옮긴다. `createdTs` 만 인자로 받는다(§2.4 — `/기억정리` 가 바닥선과 같은 값을 써야 한다).

옮긴 뒤 `summarizeAndClose` 가 그것을 부르게 하고, **기존 테스트가 전부 통과하는지 먼저 확인한다.** 여기서 깨지면 옮기다 뭔가 바꾼 것이다.

- [ ] **Step 4: `/기억정리` 핸들러를 더한다**

`parseSessionCommand` 결과를 받는 자리에서 갈래를 나눈다.

```ts
    const sessionCmd = parseSessionCommand(text);
    if (sessionCmd === "reset") { /* Task 3 의 블록 */ }
    if (sessionCmd === "compact") {
      if (!conv.sessionId) {
        this.bus.publish({ type: "assistant_message", channel: "discord", channelRef: conv.discordChannelId,
          text: "정리할 대화가 없어. 아직 이 세션에서 얘기한 게 없거든.", ts: this.now() });
        return;
      }
      // 바닥선과 요약의 created_ts 에 같은 값을 쓴다 — 두 번 시각을 구하면 순서에 따라 방금
      // 만든 요약이 스스로 걸러지는 경합이 생긴다(요약 필터가 created_ts >= floor 이므로).
      const t = this.now();
      const ok = await this.writeSummary(conv, t);
      if (!ok) {
        // 실패하면 아무것도 바꾸지 않는다. 세션과 바닥선을 밀어놓고 요약이 없으면 대화를 잃고
        // 대신 받은 것도 없는 상태가 된다 — 사용자는 요약을 받으려고 이 명령을 부른 것이다.
        this.bus.publish({ type: "assistant_message", channel: "discord", channelRef: conv.discordChannelId,
          text: "정리하다 실패했어. 대화는 그대로 두었으니 다시 시도해줘.", ts: this.now() });
        return;
      }
      await this.repos.conversations.setSession(conv.id, null, t);
      await this.repos.conversations.setContextFloor(conv.id, t);
      this.bus.publish({ type: "assistant_message", channel: "discord", channelRef: conv.discordChannelId,
        text: "…정리했어. 지금까지 얘기는 요약해서 가져갈게.", ts: t });
      return;
    }
```

손님이면 시간당 한도를 잡아야 한다 — `writeSummary` 안에서 `summarizeAndClose` 가 하던 `turns.reserve` 를 그대로 태우거나, 이 자리에서 같은 방식으로 잡는다. **어느 쪽이든 소유자는 무제한, 손님은 한도에 포함**이라는 기존 규칙을 그대로 따른다.

- [ ] **Step 5: 배선 테스트를 더한다**

`agent/tests/coreMulti.test.ts` 의 세션 예약어 `describe` 안에 추가한다.

```ts
  it("/기억정리 는 요약을 남기고 세션·바닥선을 설정한다", async () => {
    const t = await setup();
    pub(t.bus, dmHint("owner", "owner"), "안녕", 1);
    await t.core.drain();

    pub(t.bus, dmHint("owner", "owner"), "/기억정리", 2);
    await t.core.drain();

    const conv = (await t.repos.conversations.getByChannelId("dm-owner"))!;
    expect(await t.repos.summaries.recent(conv.id, 3)).toHaveLength(1);
    expect(conv.sessionId).toBeNull();
    expect(conv.contextFloorTs).not.toBeNull();
    // 바닥선과 요약의 created_ts 가 같아야 요약이 스스로 걸러지지 않는다(필터가 >= 다).
    expect(await t.repos.summaries.recent(conv.id, 3, conv.contextFloorTs!)).toHaveLength(1);
  });

  it("/기억정리 는 요약이 실패하면 세션도 바닥선도 건드리지 않는다", async () => {
    // 이 태스크의 핵심 안전장치다 — 밀어놓고 요약이 없으면 대화를 잃고 대신 받은 것도 없다.
    const t = await setup();
    pub(t.bus, dmHint("owner", "owner"), "안녕", 1);
    await t.core.drain();
    const before = (await t.repos.conversations.getByChannelId("dm-owner"))!;

    t.failNextTurn(); // 다음 runTurn 이 ok:false 를 돌려주게 한다
    pub(t.bus, dmHint("owner", "owner"), "/기억정리", 2);
    await t.core.drain();

    const after = (await t.repos.conversations.getByChannelId("dm-owner"))!;
    expect(after.sessionId).toBe(before.sessionId);
    expect(after.contextFloorTs).toBe(before.contextFloorTs);
    expect(await t.repos.summaries.recent(after.id, 3)).toHaveLength(0);
  });

  it("정리할 세션이 없으면 요약을 시도하지 않고 안내만 한다", async () => {
    const t = await setup();
    pub(t.bus, dmHint("owner", "owner"), "/기억정리", 1);
    await t.core.drain();
    expect(t.calls).toHaveLength(0);
    const notices = t.published.filter((p) => p.type === "assistant_message");
    expect(notices).toHaveLength(1);
  });
```

`t.failNextTurn()` 은 이 파일에 **없을 수도 있다.** 먼저 `setup()` 이 `runTurn` 결과를 바꾸는 수단(`nextResult` 를 노출하는지, `mode` 로 거는지)을 확인하고 그 방식을 쓴다 — `mode: "throw"` 는 예외를 던지는 것이라 `ok:false` 와 다르므로, `ok:false` 를 만드는 수단이 없으면 `setup()` 에 최소한으로 더한다(기존 `nextResult` 를 바꿀 수 있게 setter 하나).

- [ ] **Step 6: 역전 시험**

Step 4 의 `if (!ok) { ... return; }` 를 지워 실패해도 계속 진행하게 만든 뒤 돌린다. "요약 실패 시 안 바뀐다" 가 **FAIL** 해야 한다. 확인 후 되돌린다.

- [ ] **Step 7: 전체 검증**

```bash
cd agent && npm test && npm run typecheck
```

- [ ] **Step 8: 커밋**

```bash
git add agent/src/core/commands.ts agent/src/core/core.ts agent/tests
git commit -F - <<'EOF'
feat(core): /기억정리 로 대화를 요약해 다음 세션에 넘긴다

Claude Code 의 /compact 에 해당한다. /새세션 이 "끊고 새로"라면 이쪽은 "정리해서 넘기기"다 —
지금 세션을 요약해 summaries 에 넣고, 바닥선을 그어 원문 20개 대신 그 요약이 실리게 한다.

바닥선과 요약의 created_ts 에 같은 시각을 쓴다. 요약 필터가 created_ts >= floor 라, 두 번
시각을 구하면 순서에 따라 방금 만든 요약이 스스로 걸러지는 경합이 생긴다.

실패하면 아무것도 바꾸지 않는다. 세션과 바닥선을 밀어놓고 요약이 없으면 대화를 잃고 대신
받은 것도 없는 상태가 된다 — 유휴 요약이 "실패해도 세션은 반드시 닫는다"인 것과 반대인
이유는, 그쪽은 요약이 부수적이고 이쪽은 사용자가 요약을 받으려고 부른 명령이기 때문이다.

요약 턴 자체는 summarizeAndClose 에서 뽑아 공유한다. 안전 플래그 네 개
(noRemoteTools·noWebTools·noSkills·noMemoryWrite)를 두 곳에서 따로 관리하면 한쪽만
빠뜨렸을 때 아무도 모른다.

캐릭터 설정은 지우지 않는다 — 이 명령은 "정리해서 넘긴다"는 뜻이지 "다른 사람이 되자"가
아니다. 그건 /새세션 의 몫이다.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
```

---

### Task 5: 문서와 스모크

**Files:**
- Modify: `deploy/smoke-test.md`, `docs/status/STATUS.md`, `docs/architecture/overview.md`

**Interfaces:**
- Consumes: Task 1~4
- Produces: 없음

- [ ] **Step 1: `docs/architecture/overview.md` 에 컨텍스트 블록을 적는다**

이 문서가 세션·컨텍스트를 설명하는 대목을 찾아(`grep -n "세션\|컨텍스트" docs/architecture/overview.md`) 다음을 적는다.

- 새 세션이 열릴 때 주입되는 블록의 네 섹션과 **각각의 상한**(캐릭터 설정 40건, 기억 6,000자 예산, 요약 3건, 최근 대화 20건)
- 컨텍스트 바닥선이 무엇이고 누가 긋는지(`/새세션`·`/기억정리`)
- 메시지는 `>`, 요약은 `>=` 라는 것과 **그 이유**

- [ ] **Step 2: `deploy/smoke-test.md` 에 항목 넷을 더한다**

```markdown
- [ ] **`/새세션` 이 대화를 끊는가** — DM 에서 몇 마디 나눈 뒤 `/새세션` 을 치고, 이어서
  **직전에 얘기한 주제**를 되묻는다("아까 뭐 얘기했지?").
  기대 결과: 모른다고 한다. 이전 대화를 이어서 말하면 바닥선이 안 걸린 것이다.

- [ ] **`/새세션` 이 기억은 남기는가** — 위에 이어서 "동아리 회비 얼마야?" 를 묻는다.
  기대 결과: 답한다. 여기서 모른다고 하면 **삭제 범위가 샌 것**이다 — 즉시 조사한다.
  공용 기억은 복구할 방법이 없다.

- [ ] **`/기억정리` 가 요약을 넘기는가** — DM 에서 몇 마디 나눈 뒤 `/기억정리` 를 치고,
  직전 주제를 되묻는다.
  기대 결과: **요약 수준으로는 안다**(세부는 흐릿해도 무슨 얘기였는지는 안다). 전혀 모르면
  요약이 안 실린 것이고(`created_ts >= floor` 확인), 원문 그대로 기억하면 바닥선이 안 걸린
  것이다.

- [ ] **기억이 예산을 넘겼을 때** — 공용 기억이 6,000자를 넘은 뒤 서버에서 새 세션을 열고
  뒤쪽 주제를 묻는다.
  기대 결과: 아사히가 그 주제가 **있다는 것은 알고** `recall` 로 내용을 가져온다. "그런 건
  없다"고 하면 제목까지 잘린 것이다.
```

- [ ] **Step 3: `docs/status/STATUS.md` 를 갱신한다**

"병합된 주요 기능" 절의 세션·기억 관련 항목에 더한다: 두 명령의 구분, 컨텍스트 바닥선, 기억 섹션 예산. **`/새세션` 이 캐릭터 설정을 전역으로 지운다는 것**을 명시한다 — 되돌릴 수 없는 동작이라 현황 문서에 있어야 한다.

- [ ] **Step 4: 문서 검사**

```bash
node scripts/check-docs.mjs
```

- [ ] **Step 5: 전체 검증**

```bash
cd agent && npm test && npm run typecheck
```

- [ ] **Step 6: 커밋**

```bash
git add deploy/smoke-test.md docs/status/STATUS.md docs/architecture/overview.md
git commit -F - <<'EOF'
docs(context): 컨텍스트 바닥선과 두 명령을 문서에 반영한다

overview 에 컨텍스트 블록의 네 섹션과 각각의 상한을 적었다 — 기억만 무제한이던 것이 이번에
예산을 갖게 됐고, 그 사실이 어디에도 적혀 있지 않으면 다음 사람이 또 무제한이라고 읽는다.

스모크 두 번째 항목이 가장 중요하다: /새세션 뒤에 동아리 회비를 물어 답하는지 본다.
여기서 모른다고 하면 삭제 범위가 새어 공용 기억까지 지운 것이고, 그건 복구할 방법이 없다.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
```

---

## 배포 후 확인

이 계획의 변경은 **봇에만** 영향을 준다. main 에 머지하면 Railway 가 자동 배포한다.

**스키마 변경이 하나 있다**(`ALTER TABLE conversations ADD COLUMN IF NOT EXISTS context_floor_ts BIGINT`). 부팅 시 `SCHEMA_SQL` 이 실행되므로 별도 절차는 없다.

**배포 직후에는 아무것도 바뀌지 않는다** — 기존 대화는 전부 `context_floor_ts` 가 `NULL` 이라 지금 동작 그대로다. 누군가 `/새세션` 이나 `/기억정리` 를 처음 칠 때부터 달라진다.
