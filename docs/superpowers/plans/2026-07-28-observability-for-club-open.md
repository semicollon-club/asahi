# 부원 오픈을 위한 관측 기반 — M1 구현 계획

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 도구 호출 하나하나를 `actions` 에 기록하고 같은 이벤트를 부원에게 실시간으로 보여주며, 폴더 구조를 전용 도구로 조회할 수 있게 한다.

**Architecture:** 진행 이벤트(`ProgressUpdate`)를 확장해 표시와 기록이 **같은 값**에서 나오게 한다. 짝짓기(`tool` ↔ `tool_result`)는 `tool_use_id` 가 있는 `agent.ts` 에서 하고, 기록은 `conv.id`·`userId` 를 이미 들고 있는 `core.ts` 의 `onProgress` 클로저에서 한다. `fs_tree` 는 새 게이팅을 만들지 않고 `fs_glob` 과 동일한 경로에 얹는다.

**Tech Stack:** TypeScript(ESM, NodeNext) · vitest · pg-mem · zod · `@anthropic-ai/claude-agent-sdk`

**설계 정본:** `docs/superpowers/specs/2026-07-28-observability-for-club-open-design.md`

## Global Constraints

- 작업 디렉토리는 `agent/` 다. 모든 명령은 거기서 실행한다.
- **TDD.** 실패하는 테스트를 먼저 쓰고, 실패를 눈으로 확인한 뒤 구현한다(`CONTRIBUTING.md`).
- 검증은 **두 개 다** 통과해야 한다: `npm test` 와 `npm run typecheck`. 테스트는 `tsconfig.json` 의 `include` 에 없으므로 `npm test` 만으로는 타입 오류가 잡히지 않는다.
- 주석·커밋 메시지·사용자 노출 문자열은 **한국어**. 기존 파일의 주석 밀도와 어투를 따른다.
- 커밋 메시지는 conventional commits + 한국어 제목. 끝에 `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>` 를 붙인다.
- **이모지를 사용자 노출 문자열에 넣지 않는다.** 단 진행 표시의 `✓`/`✗` 는 시스템 UI 기호로 허용한다(`discord.ts` 의 `PROCESSING_REACTION` 과 같은 취급).
- `actions` 테이블 스키마는 **변경하지 않는다**(`schema.ts` 에 이미 있다).

---

### Task 1: `tool_result` 이벤트 확장과 짝짓기

**Files:**
- Modify: `agent/src/core/agent.ts` (`ProgressUpdate`, `progressFromMessage`, 호출부)
- Test: `agent/tests/agent.test.ts`

**Interfaces:**
- Produces: `ProgressUpdate` 의 `tool_result` 변형이 `{ kind: "tool_result"; name?: string; input?: string; ok: boolean; summary?: string; durationMs?: number }` 가 된다. Task 2·3 이 이 필드들을 소비한다.
- Produces: `progressFromMessage(message, pending)` 의 두 번째 인자 타입이 `Map<string, string>` → `Map<string, PendingTool>` 로 바뀐다. `export type PendingTool = { name: string; input?: string; startedAt: number }`.
- Consumes: 없음.

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`agent/tests/agent.test.ts` 끝에 추가한다.

```ts
describe("progressFromMessage — tool_result 에 성패·입력·소요시간을 싣는다", () => {
  const toolUse = (id: string, name: string, input: unknown) => ({
    type: "assistant",
    message: { content: [{ type: "tool_use", id, name, input }] },
  });
  const toolResult = (id: string, extra: Record<string, unknown> = {}) => ({
    type: "user",
    message: { content: [{ type: "tool_result", tool_use_id: id, ...extra }] },
  });

  it("is_error 가 없으면 ok:true, 있으면 ok:false", () => {
    const pending = new Map<string, PendingTool>();
    progressFromMessage(toolUse("t1", "fs_read", { path: "/w/a" }), pending, () => 1000);
    const okUpdates = progressFromMessage(toolResult("t1", { content: "본문" }), pending, () => 1300);
    expect(okUpdates[0]).toMatchObject({ kind: "tool_result", ok: true });

    progressFromMessage(toolUse("t2", "fs_write", {}), pending, () => 2000);
    const failUpdates = progressFromMessage(
      toolResult("t2", { is_error: true, content: "허용된 폴더 밖 경로예요" }), pending, () => 2100);
    expect(failUpdates[0]).toMatchObject({ kind: "tool_result", ok: false });
  });

  it("짝지어진 tool 의 입력과 소요시간을 함께 싣는다", () => {
    const pending = new Map<string, PendingTool>();
    progressFromMessage(toolUse("t1", "fs_read", { path: "/w/a.txt" }), pending, () => 1000);
    const [u] = progressFromMessage(toolResult("t1", { content: "본문" }), pending, () => 1450);
    expect(u).toMatchObject({ kind: "tool_result", name: "fs_read", durationMs: 450 });
    expect((u as { input?: string }).input).toContain("a.txt");
  });

  it("같은 도구를 연달아 불러도 id 로 각각 짝지어진다", () => {
    const pending = new Map<string, PendingTool>();
    progressFromMessage(toolUse("a", "fs_read", { path: "/w/first.txt" }), pending, () => 100);
    progressFromMessage(toolUse("b", "fs_read", { path: "/w/second.txt" }), pending, () => 200);
    const [second] = progressFromMessage(toolResult("b", { content: "x" }), pending, () => 260);
    const [first] = progressFromMessage(toolResult("a", { content: "y" }), pending, () => 900);
    expect((second as { input?: string }).input).toContain("second.txt");
    expect((second as { durationMs?: number }).durationMs).toBe(60);
    expect((first as { input?: string }).input).toContain("first.txt");
    expect((first as { durationMs?: number }).durationMs).toBe(800);
  });

  it("결과 요약은 200자에서 자른다", () => {
    const pending = new Map<string, PendingTool>();
    progressFromMessage(toolUse("t1", "sh_exec", { command: "ls" }), pending, () => 0);
    const [u] = progressFromMessage(toolResult("t1", { content: "가".repeat(500) }), pending, () => 10);
    expect((u as { summary?: string }).summary!.length).toBeLessThanOrEqual(200);
  });

  it("짝이 없는 tool_result 도 버리지 않는다(ok 는 살린다)", () => {
    const pending = new Map<string, PendingTool>();
    const [u] = progressFromMessage(toolResult("unknown", { content: "x" }), pending, () => 5);
    expect(u).toMatchObject({ kind: "tool_result", ok: true });
    expect((u as { durationMs?: number }).durationMs).toBeUndefined();
  });
});
```

파일 상단 import 에 `PendingTool` 을 추가한다.

```ts
import { progressFromMessage, type PendingTool } from "../src/core/agent.js";
```

- [ ] **Step 2: 실패를 확인한다**

Run: `npx vitest run tests/agent.test.ts -t "tool_result 에 성패"`
Expected: FAIL — `PendingTool` 가 export 되지 않았고 `progressFromMessage` 가 인자 3개를 받지 않는다.

- [ ] **Step 3: `agent.ts` 를 고친다**

`ProgressUpdate` 의 `tool_result` 변형을 바꾸고, 짝짓기용 타입을 export 한다.

```ts
export type ProgressUpdate =
  | { kind: "tool"; name: string; input?: string }
  // 표시와 기록이 같은 값에서 나오도록 확장했다(2026-07-28 관측 기반 스펙 §3).
  // ok/summary 는 SDK 의 tool_result 블록에서, input/durationMs 는 짝지은 tool 이벤트에서 온다.
  | { kind: "tool_result"; name?: string; input?: string; ok: boolean; summary?: string; durationMs?: number }
  | { kind: "answering" };

// tool_use_id → 그 호출의 이름·입력·시작 시각. 예전엔 이름(string)만 담았는데, 기록 한 행을
// 채우려면 input 과 소요시간이 필요하다. 짝짓기는 반드시 id 로 한다 — 이름으로 짝지으면 같은
// 도구를 연달아 부를 때 어긋난다.
export type PendingTool = { name: string; input?: string; startedAt: number };

// 결과 요약 상한. 표시 한 줄과 actions.result_summary 양쪽에 쓴다.
export const RESULT_SUMMARY_MAX = 200;
```

`progressFromMessage` 에 시계를 주입받고 두 블록을 고친다.

```ts
export function progressFromMessage(
  message: ProgressSourceMessage,
  pending: Map<string, PendingTool>,
  now: () => number = Date.now,
): ProgressUpdate[] {
  const inner = message.message;
  const content = inner && typeof inner === "object" ? (inner as { content?: unknown }).content : undefined;
  if (!Array.isArray(content)) return [];
  const updates: ProgressUpdate[] = [];
  for (const raw of content) {
    if (!raw || typeof raw !== "object") continue;
    const block = raw as {
      type?: unknown; name?: unknown; id?: unknown; input?: unknown;
      tool_use_id?: unknown; is_error?: unknown; content?: unknown;
    };
    if (block.type === "tool_use" && typeof block.name === "string") {
      const name = shortToolName(block.name);
      const input = summarizeToolInput(block.input);
      if (typeof block.id === "string") pending.set(block.id, { name, input, startedAt: now() });
      updates.push({ kind: "tool", name, input });
    } else if (block.type === "tool_result" && typeof block.tool_use_id === "string") {
      const p = pending.get(block.tool_use_id);
      pending.delete(block.tool_use_id);
      // is_error 가 실려 오지 않는 SDK 버전에서도 안전하게 동작한다 — 없으면 성공으로 본다.
      const ok = block.is_error !== true;
      const body = typeof block.content === "string" ? block.content : undefined;
      updates.push({
        kind: "tool_result",
        name: p?.name,
        input: p?.input,
        ok,
        summary: body === undefined ? undefined : body.slice(0, RESULT_SUMMARY_MAX),
        durationMs: p === undefined ? undefined : now() - p.startedAt,
      });
    } else if (block.type === "text") {
      updates.push({ kind: "answering" });
    }
  }
  return updates;
}
```

`makeRunAgentTurn` 안에서 `pendingToolNames` 를 만드는 자리의 타입을 바꾼다. `new Map<string, string>()` 을 `new Map<string, PendingTool>()` 로 고치고, `progressFromMessage(msg, pendingToolNames)` 호출은 그대로 둔다(시계는 기본값).

- [ ] **Step 4: 통과를 확인한다**

Run: `npx vitest run tests/agent.test.ts`
Expected: PASS (기존 테스트 포함 전부)

- [ ] **Step 5: 전체 검증**

Run: `npm run typecheck && npm test`
Expected: typecheck exit 0, 전체 테스트 통과

- [ ] **Step 6: 커밋**

```bash
git add agent/src/core/agent.ts agent/tests/agent.test.ts
git commit -m "feat(agent): tool_result 에 성패·입력·소요시간·결과요약을 싣는다"
```

---

### Task 2: `ActionsRepo` 와 코어 배선

**Files:**
- Create: `agent/src/store/actionsRepo.ts`
- Modify: `agent/src/core/core.ts` (`CoreRepos`, `runConversationTurn` 의 `onProgress`)
- Modify: `agent/src/index.ts` (repos 에 actions 추가)
- Test: `agent/tests/actionsRepo.test.ts` (신규), `agent/tests/coreMulti.test.ts`

**Interfaces:**
- Consumes: Task 1 의 `ProgressUpdate.tool_result` 필드들.
- Produces: `class ActionsRepo { constructor(db: Db); record(a: ActionRow): Promise<void>; recent(limit: number): Promise<ActionRow[]> }` 와 `export type ActionRow = { ts: number; conversationId: number | null; userId: string | null; tool: string; input?: string; resultSummary?: string; status: string; durationMs?: number }`.
- Produces: `CoreRepos` 에 `actions: ActionsRepo` 가 추가된다.

- [ ] **Step 1: 리포 테스트를 쓴다**

`agent/tests/actionsRepo.test.ts` 를 만든다.

```ts
import { describe, it, expect } from "vitest";
import { openTestDb } from "../src/store/db.js";
import { ActionsRepo } from "../src/store/actionsRepo.js";

describe("ActionsRepo", () => {
  it("기록한 행을 최근 순으로 돌려준다", async () => {
    const repo = new ActionsRepo(await openTestDb());
    await repo.record({ ts: 100, conversationId: 1, userId: "guest", tool: "fs_read", input: "a.txt", resultSummary: "본문", status: "ok", durationMs: 12 });
    await repo.record({ ts: 200, conversationId: 1, userId: "guest", tool: "fs_write", status: "error", resultSummary: "허용된 폴더 밖 경로예요" });

    const rows = await repo.recent(10);
    expect(rows.map((r) => r.tool)).toEqual(["fs_write", "fs_read"]);
    expect(rows[0]!.status).toBe("error");
    expect(rows[1]!.durationMs).toBe(12);
  });

  it("선택 필드가 없어도 기록된다", async () => {
    const repo = new ActionsRepo(await openTestDb());
    await repo.record({ ts: 1, conversationId: null, userId: null, tool: "sh_exec", status: "ok" });
    const rows = await repo.recent(10);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.input).toBeUndefined();
  });
});
```

- [ ] **Step 2: 실패를 확인한다**

Run: `npx vitest run tests/actionsRepo.test.ts`
Expected: FAIL — `actionsRepo.js` 가 없다.

- [ ] **Step 3: `ActionsRepo` 를 만든다**

`agent/src/store/actionsRepo.ts`:

```ts
import type { Db } from "./db.js";

// 도구 호출 1건 = 1행. 스키마(schema.ts 의 actions)는 자기인지 조각B 용으로 이미 정확한 모양이라
// 손대지 않는다 — 이 리포는 그 테이블을 처음으로 실제로 쓰는 코드다.
export type ActionRow = {
  ts: number;
  conversationId: number | null;
  userId: string | null;
  tool: string;
  input?: string;
  resultSummary?: string;
  status: string;
  durationMs?: number;
};

type Raw = {
  ts: number | string; conversation_id: number | string | null; user_id: string | null;
  tool: string; input: string | null; result_summary: string | null;
  status: string; duration_ms: number | string | null;
};

export class ActionsRepo {
  constructor(private db: Db) {}

  async record(a: ActionRow): Promise<void> {
    await this.db.query(
      `INSERT INTO actions (ts, conversation_id, user_id, tool, input, result_summary, status, duration_ms)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [a.ts, a.conversationId, a.userId, a.tool, a.input ?? null, a.resultSummary ?? null, a.status, a.durationMs ?? null],
    );
  }

  async recent(limit: number): Promise<ActionRow[]> {
    const r = await this.db.query("SELECT * FROM actions ORDER BY ts DESC, id DESC LIMIT $1", [limit]);
    return (r.rows as Raw[]).map((row) => ({
      ts: Number(row.ts),
      conversationId: row.conversation_id === null ? null : Number(row.conversation_id),
      userId: row.user_id,
      tool: row.tool,
      input: row.input ?? undefined,
      resultSummary: row.result_summary ?? undefined,
      status: row.status,
      durationMs: row.duration_ms === null ? undefined : Number(row.duration_ms),
    }));
  }
}
```

- [ ] **Step 4: 리포 테스트 통과를 확인한다**

Run: `npx vitest run tests/actionsRepo.test.ts`
Expected: PASS

- [ ] **Step 5: 배선 테스트를 쓴다**

`agent/tests/coreMulti.test.ts` 의 `setup()` 안 `repos` 에 한 줄을 추가한다(파일 상단에 `import { ActionsRepo } from "../src/store/actionsRepo.js";` 도 추가).

```ts
    actions: new ActionsRepo(db),
```

그리고 파일 끝에 describe 를 추가한다.

```ts
describe("AgentCore — 도구 호출을 actions 에 기록한다", () => {
  it("도구 호출 1건이 1행이 되고 대화·사용자가 함께 남는다", async () => {
    const t = await setup({ hub: { isConnected: () => true } });
    pub(t.bus, dmHint("owner", "owner"), "파일 읽어줘", 1);
    await t.core.drain();
    // setup 의 runTurn 가짜는 onProgress 로 answering 만 보낸다 — 도구 이벤트를 직접 흘려보낸다.
    t.calls[0].onProgress?.({ kind: "tool", name: "fs_read", input: "a.txt" });
    t.calls[0].onProgress?.({ kind: "tool_result", name: "fs_read", input: "a.txt", ok: true, summary: "본문", durationMs: 12 });
    await t.core.drain();

    const rows = await t.repos.actions.recent(10);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ tool: "fs_read", status: "ok", durationMs: 12, userId: "owner" });
  });

  it("answering·tool 이벤트는 기록하지 않는다(도구 호출 1건 = 1행)", async () => {
    const t = await setup({ hub: { isConnected: () => true } });
    pub(t.bus, dmHint("owner", "owner"), "안녕", 1);
    await t.core.drain();
    t.calls[0].onProgress?.({ kind: "tool", name: "fs_read", input: "a.txt" });
    t.calls[0].onProgress?.({ kind: "answering" });
    await t.core.drain();
    expect(await t.repos.actions.recent(10)).toHaveLength(0);
  });

  it("기록이 실패해도 턴을 죽이지 않는다", async () => {
    const t = await setup({ hub: { isConnected: () => true } });
    t.repos.actions.record = async () => { throw new Error("DB 오류(테스트용)"); };
    pub(t.bus, dmHint("owner", "owner"), "파일 읽어줘", 1);
    await t.core.drain();
    t.calls[0].onProgress?.({ kind: "tool_result", name: "fs_read", ok: false, durationMs: 1 });
    await t.core.drain();
    expect(t.published.some((e) => e.type === "assistant_message")).toBe(true);
  });
});
```

- [ ] **Step 6: 실패를 확인한다**

Run: `npx vitest run tests/coreMulti.test.ts -t "actions 에 기록"`
Expected: FAIL — `repos.actions` 가 `CoreRepos` 에 없다(런타임 `undefined`).

- [ ] **Step 7: `core.ts` 를 배선한다**

`CoreRepos` 에 추가한다.

```ts
import type { ActionsRepo } from "../store/actionsRepo.js";
```

```ts
  allowedDirs: AllowedDirsRepo;
  // 도구 호출 기록. 표시(bus)와 같은 이벤트에서 나온다 — 두 벌을 만들면 반드시 어긋난다.
  actions: ActionsRepo;
```

`runConversationTurn` 의 `onProgress` 를 두 갈래로 바꾼다.

```ts
      const onProgress = (u: ProgressUpdate) => {
        this.bus.publish({ type: "progress", channel: "discord", channelRef: conv.discordChannelId, text: formatProgress(u, workspaceDirs), ts: this.now() });
        // 기록은 도구 호출이 끝난 시점에만 남긴다(tool 이벤트는 짝이 맞춰져 이 한 행에 흡수된다).
        // 부가 기능이므로 실패해도 턴을 죽이지 않는다 — hub.ts 의 touchLastSeen 과 같은 패턴.
        if (u.kind !== "tool_result") return;
        void this.repos.actions
          .record({
            ts: this.now(), conversationId: conv.id, userId,
            tool: u.name ?? "(unknown)", input: u.input,
            resultSummary: u.summary, status: u.ok ? "ok" : "error", durationMs: u.durationMs,
          })
          .catch((err) => console.error("[core] 도구 기록 실패:", err));
      };
```

`index.ts` 의 `repos` 객체에 `actions: new ActionsRepo(db),` 를 추가하고 import 를 넣는다.

- [ ] **Step 8: 통과를 확인한다**

Run: `npm run typecheck && npm test`
Expected: typecheck exit 0, 전체 통과

- [ ] **Step 9: 커밋**

```bash
git add agent/src/store/actionsRepo.ts agent/src/core/core.ts agent/src/index.ts agent/tests/actionsRepo.test.ts agent/tests/coreMulti.test.ts
git commit -m "feat(store): ActionsRepo 로 도구 호출을 기록한다"
```

---

### Task 3: 진행 표시에 성패·사유·시간을 드러낸다

**Files:**
- Modify: `agent/src/core/core.ts` (`formatProgress`)
- Test: `agent/tests/progress.test.ts`

**Interfaces:**
- Consumes: Task 1 의 `tool_result` 필드, Task 2 에서 이미 넘기고 있는 `workspaceDirs`.
- Produces: `formatProgress(u: ProgressUpdate, baseDirs?: string[]): string`.

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`agent/tests/progress.test.ts` 끝에 추가한다.

```ts
describe("formatProgress — 성패와 사유가 보인다", () => {
  const BASE = ["C:\\asahi-workspace\\1517428698368704650"];

  it("성공은 체크 표시와 소요시간을 붙인다", () => {
    const s = formatProgress({ kind: "tool_result", name: "fs_read", ok: true, summary: "본문", durationMs: 320 });
    expect(s).toContain("✓");
    expect(s).toContain("fs_read");
    expect(s).toContain("0.3");
  });

  it("실패는 X 표시와 사유를 그대로 보여준다", () => {
    const s = formatProgress({ kind: "tool_result", name: "fs_write", ok: false, summary: "허용된 폴더 밖 경로예요", durationMs: 5 });
    expect(s).toContain("✗");
    expect(s).toContain("허용된 폴더 밖 경로예요");
    expect(s).not.toContain("완료");
  });

  it("경로는 그 사용자의 폴더 기준으로 줄인다", () => {
    const s = formatProgress({ kind: "tool", name: "fs_read", input: "C:\\asahi-workspace\\1517428698368704650\\src\\a.ts" }, BASE);
    expect(s).toContain("src\\a.ts");
    expect(s).not.toContain("1517428698368704650");
  });

  it("기준 폴더 밖 경로는 줄이지 않는다", () => {
    const s = formatProgress({ kind: "tool", name: "fs_read", input: "C:\\other\\a.ts" }, BASE);
    expect(s).toContain("C:\\other\\a.ts");
  });

  it("answering 은 그대로다(회귀 없음)", () => {
    expect(formatProgress({ kind: "answering" })).toBe("답변 작성 중");
  });
});
```

- [ ] **Step 2: 실패를 확인한다**

Run: `npx vitest run tests/progress.test.ts -t "성패와 사유"`
Expected: FAIL — 현재 `tool_result` 는 `"fs_read 완료"` 만 돌려준다.

- [ ] **Step 3: `formatProgress` 를 고친다**

```ts
// 표시용 경로 축약: 그 사용자의 작업 폴더로 시작하면 그 앞부분을 떼어 낸다. 긴 절대경로가
// 상태 메시지의 12줄 예산을 잡아먹는 것을 막고, 부원에게 "내 폴더 안"이라는 게 자연스럽게
// 드러난다. 밖의 경로는 그대로 둔다 — 줄이면 어디인지 알 수 없어진다.
function shortenPath(text: string, baseDirs?: string[]): string {
  if (!baseDirs) return text;
  for (const base of baseDirs) {
    const prefix = base.endsWith("\\") || base.endsWith("/") ? base : `${base}\\`;
    if (text.startsWith(prefix)) return text.slice(prefix.length);
    const posix = `${base.replace(/\\+$/, "")}/`;
    if (text.startsWith(posix)) return text.slice(posix.length);
  }
  return text;
}

function seconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)}초`;
}

export function formatProgress(u: ProgressUpdate, baseDirs?: string[]): string {
  switch (u.kind) {
    case "tool":
      return u.input !== undefined ? `${u.name} ${shortenPath(u.input, baseDirs)}` : `${u.name}()`;
    case "tool_result": {
      // 실패를 "완료"로 찍던 것이 이 함수의 가장 큰 결함이었다 — 부원이 왜 안 됐는지 알 수
      // 있는 경로가 이 한 줄뿐이다.
      const mark = u.ok ? "✓" : "✗";
      const name = u.name ?? "도구";
      const tail = u.ok
        ? [u.summary === undefined ? undefined : shortenPath(u.summary.split("\n")[0]!, baseDirs), u.durationMs === undefined ? undefined : `(${seconds(u.durationMs)})`]
        : [u.summary === undefined ? undefined : shortenPath(u.summary.split("\n")[0]!, baseDirs)];
      const rest = tail.filter((x) => x !== undefined).join(" ");
      return rest.length > 0 ? `${mark} ${name} — ${rest}` : `${mark} ${name}`;
    }
    case "answering":
      return "답변 작성 중";
  }
}
```

- [ ] **Step 4: 통과를 확인한다**

Run: `npm run typecheck && npm test`
Expected: typecheck exit 0, 전체 통과. 기존 `progress.test.ts` 의 `"완료"` 를 기대하던 단정이 있으면 **테스트를 새 문구에 맞춰 고친다**(동작이 의도적으로 바뀐 것이므로 회귀가 아니다).

- [ ] **Step 5: 커밋**

```bash
git add agent/src/core/core.ts agent/tests/progress.test.ts
git commit -m "feat(core): 진행 표시에 성패·사유·소요시간을 드러낸다"
```

---

### Task 4: `fs_tree` 전용 도구

**Files:**
- Create: `agent/src/remote/tree.ts` (렌더링 순수 함수)
- Modify: `agent/src/remote/executors.ts` (`fs_tree` 실행기)
- Modify: `agent/src/core/remoteTools.ts` (`REMOTE_TOOL_NAMES`, `LOCAL_TOOL_NAME` 취급)
- Modify: `agent/src/core/tools.ts` (도구 선언)
- Test: `agent/tests/tree.test.ts` (신규), `agent/tests/remoteExecutors.test.ts`, `agent/tests/remoteTools.test.ts`

**Interfaces:**
- Produces: `renderTree(entries: TreeEntry[], opts): string` 와 `export type TreeEntry = { relPath: string; isDir: boolean; depth: number }`.
- Produces: 실행기 `fs_tree(args: { path?: string; depth?: number })`.
- Consumes: `checkPath`(`remote/roots.ts`), `OUTPUT_MAX`(`executors.ts`).

- [ ] **Step 1: 렌더링 테스트를 쓴다**

`agent/tests/tree.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { renderTree, TREE_MAX_ENTRIES, type TreeEntry } from "../src/remote/tree.js";

const e = (relPath: string, isDir: boolean, depth: number): TreeEntry => ({ relPath, isDir, depth });

describe("renderTree", () => {
  it("깊이에 따라 들여쓰고 폴더는 구분한다", () => {
    const out = renderTree([e("src", true, 0), e("src/a.ts", false, 1)], { root: "C:\\ws\\u1", truncated: false });
    expect(out).toContain("src/");
    expect(out).toContain("  a.ts");
  });

  it("비어 있으면 비었다고 말한다(조용히 빈 문자열을 돌려주지 않는다)", () => {
    const out = renderTree([], { root: "C:\\ws\\u1", truncated: false });
    expect(out).toContain("비어");
  });

  it("잘렸으면 명시한다", () => {
    const out = renderTree([e("a.ts", false, 0)], { root: "C:\\ws\\u1", truncated: true });
    expect(out).toContain("잘랐");
  });

  it("항목 상한이 정의돼 있다", () => {
    expect(TREE_MAX_ENTRIES).toBe(500);
  });
});
```

- [ ] **Step 2: 실패를 확인한다**

Run: `npx vitest run tests/tree.test.ts`
Expected: FAIL — `tree.js` 가 없다.

- [ ] **Step 3: `tree.ts` 를 만든다**

```ts
// 폴더 구조 렌더링. 순수 함수로 떼어 둔 이유는 실행기(파일시스템)를 목업하지 않고 출력 형식만
// 검증하기 위해서다.
export type TreeEntry = { relPath: string; isDir: boolean; depth: number };

export const TREE_MAX_ENTRIES = 500;
export const TREE_DEFAULT_DEPTH = 3;
export const TREE_MAX_DEPTH = 5;
// 코딩 동아리라 이게 없으면 출력이 즉시 상한을 친다.
export const TREE_EXCLUDED = new Set([".git", "node_modules", "dist", ".venv", "__pycache__"]);

export function renderTree(entries: TreeEntry[], o: { root: string; truncated: boolean }): string {
  if (entries.length === 0) return `${o.root} 는 비어 있어요.`;
  const lines = entries.map((x) => {
    const name = x.relPath.split(/[\\/]/).pop() ?? x.relPath;
    return `${"  ".repeat(x.depth)}${name}${x.isDir ? "/" : ""}`;
  });
  const head = `${o.root}`;
  const tail = o.truncated ? "\n… (항목이 많아 여기서 잘랐어요)" : "";
  return `${head}\n${lines.join("\n")}${tail}`;
}
```

- [ ] **Step 4: 렌더링 테스트 통과 확인**

Run: `npx vitest run tests/tree.test.ts`
Expected: PASS

- [ ] **Step 5: 실행기 테스트를 쓴다**

`agent/tests/remoteExecutors.test.ts` 끝에 추가한다.

```ts
describe("fs_tree 실행기", () => {
  it("루트 아래 구조를 돌려준다", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "asahi-tree-"));
    fs.mkdirSync(path.join(root, "src"));
    fs.writeFileSync(path.join(root, "src", "a.ts"), "x");
    fs.mkdirSync(path.join(root, "node_modules"));
    fs.writeFileSync(path.join(root, "node_modules", "junk.js"), "x");

    const ex = makeExecutors([root]);
    const r = await ex.fs_tree!({ path: root });
    expect(r.ok).toBe(true);
    expect(r.content).toContain("a.ts");
    expect(r.content).not.toContain("junk.js"); // node_modules 제외
  });

  it("심볼릭 링크를 따라가지 않는다(워크스페이스 밖 열거 방지)", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "asahi-tree-root-"));
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "asahi-tree-outside-"));
    fs.writeFileSync(path.join(outside, "secret.txt"), "x");
    try {
      fs.symlinkSync(outside, path.join(root, "escape"), "junction");
    } catch {
      return; // 링크를 만들 권한이 없는 환경에서는 건너뛴다
    }
    const ex = makeExecutors([root]);
    const r = await ex.fs_tree!({ path: root });
    expect(r.content).not.toContain("secret.txt");
  });

  it("roots 밖 경로는 거부한다", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "asahi-tree-gate-"));
    const other = fs.mkdtempSync(path.join(os.tmpdir(), "asahi-tree-other-"));
    const ex = makeExecutors([root]);
    const r = await ex.fs_tree!({ path: other });
    expect(r.ok).toBe(false);
  });
});
```

- [ ] **Step 6: 실패를 확인한다**

Run: `npx vitest run tests/remoteExecutors.test.ts -t "fs_tree"`
Expected: FAIL — `ex.fs_tree` 가 없다.

- [ ] **Step 7: 실행기를 구현한다**

`executors.ts` 상단에 import 를 추가한다.

```ts
import { renderTree, TREE_MAX_ENTRIES, TREE_DEFAULT_DEPTH, TREE_MAX_DEPTH, TREE_EXCLUDED, type TreeEntry } from "./tree.js";
```

`makeExecutors` 의 반환 객체에 추가한다.

```ts
    // 재귀 순회라 fs_read 에 없던 위험이 하나 있다 — 심볼릭 링크 하나로 워크스페이스 밖을
    // 열거할 수 있다. withFileTypes 로 링크를 아예 건너뛴다(따라가지 않는다).
    async fs_tree(args) {
      const g = gate(args.path);
      if (!g.ok) return g.res;
      const maxDepth = Math.min(num(args.depth) ?? TREE_DEFAULT_DEPTH, TREE_MAX_DEPTH);
      const entries: TreeEntry[] = [];
      let truncated = false;

      const walk = async (dir: string, rel: string, depth: number): Promise<void> => {
        if (depth > maxDepth || truncated) return;
        let items;
        try {
          items = await fs.readdir(dir, { withFileTypes: true });
        } catch {
          return; // 권한 없는 하위 폴더는 조용히 건너뛴다(전체를 실패시키지 않는다)
        }
        for (const it of items.sort((a, b) => a.name.localeCompare(b.name))) {
          if (it.isSymbolicLink()) continue;
          if (TREE_EXCLUDED.has(it.name)) continue;
          if (entries.length >= TREE_MAX_ENTRIES) { truncated = true; return; }
          const childRel = rel === "" ? it.name : `${rel}/${it.name}`;
          entries.push({ relPath: childRel, isDir: it.isDirectory(), depth });
          if (it.isDirectory()) await walk(path.join(dir, it.name), childRel, depth + 1);
        }
      };

      await walk(g.path, "", 0);
      return { ok: true, content: truncate(renderTree(entries, { root: g.path, truncated })) };
    },
```

- [ ] **Step 8: 실행기 테스트 통과 확인**

Run: `npx vitest run tests/remoteExecutors.test.ts`
Expected: PASS

- [ ] **Step 9: 게이팅 테스트를 쓴다**

`agent/tests/remoteTools.test.ts` 끝에 추가한다.

```ts
describe("fs_tree 는 fs_glob 과 동일하게 1차 필터를 탄다", () => {
  const withDirs = (dirs: string[], remote: Partial<NonNullable<ToolCtx["remote"]>>): ToolCtx =>
    ({
      remote: { roots: ["/w"], workerId: "test-worker", workerKind: "personal", ...remote },
      isOwner: true, isPrivate: true, userId: "owner",
      repos: { allowedDirs: { list: async () => dirs } },
    } as unknown as ToolCtx);

  it("path 를 생략하고 allowedDirs 가 비어 있으면 허브를 부르지 않는다", async () => {
    let called = false;
    const ctx = withDirs([], { call: async () => { called = true; return { ok: true, content: "" }; } });
    const out = await remoteToolHandler(ctx, "fs_tree", {});
    expect(called).toBe(false);
    expect(out).toContain("allow_dir");
  });

  it("path 를 생략하면 검사에 쓴 allowed[0] 을 args 에 실제로 주입한다", async () => {
    const seen: Array<Record<string, unknown>> = [];
    const ctx = withDirs(["/w/proj"], { call: async (_t, args) => { seen.push(args); return { ok: true, content: "" }; } });
    await remoteToolHandler(ctx, "fs_tree", {});
    expect(seen[0]!.path).toBe("/w/proj");
  });

  it("허용 폴더 밖 path 는 거부한다", async () => {
    const ctx = withDirs(["/w/proj"], { call: async () => ({ ok: true, content: "" }) });
    const out = await remoteToolHandler(ctx, "fs_tree", { path: "/etc" });
    expect(out).toContain("허용된 폴더 밖");
  });
});
```

- [ ] **Step 10: 실패를 확인한다**

Run: `npx vitest run tests/remoteTools.test.ts -t "fs_tree"`
Expected: FAIL — `fs_tree` 가 `REMOTE_TOOL_NAMES` 에 없어 필터를 안 탄다.

- [ ] **Step 11: 봇 쪽에 등록한다**

`remoteTools.ts`:

```ts
export const REMOTE_TOOL_NAMES = ["fs_read", "fs_write", "fs_edit", "fs_glob", "fs_grep", "fs_tree", "sh_exec"] as const;
```

`LOCAL_TOOL_NAME` 매핑에 `fs_tree` 를 넣는다. **이게 이 태스크의 핵심이다** — 이 줄이 없으면 `path` 를 생략했을 때 `needsPathCheck` 가 거짓이 되어 1차 필터가 통째로 스킵된다(`fs_glob` 이 겪었던 FIX6 과 같은 구멍).

```ts
// fs_tree 도 path 를 생략할 수 있으므로 같은 취급을 받아야 한다. Glob 으로 매핑하는 이유는
// extractCandidatePaths 가 "path 생략 시 기본값을 검사한다"는 규칙을 그대로 태우기 위해서다 —
// fs_tree 에는 pattern 인자가 없으므로 그 부분은 자연히 후보를 만들지 않는다.
const LOCAL_TOOL_NAME: Partial<Record<string, string>> = { fs_glob: "Glob", fs_grep: "Grep", fs_tree: "Glob" };
```

`tools.ts` 의 `createSdkMcpServer` 도구 배열에 선언을 추가한다(다른 `fs_*` 선언 옆).

```ts
      tool(
        "fs_tree",
        "작업 폴더의 파일·폴더 구조를 보여줍니다. 사용자가 '내 폴더에 뭐 있어?' 처럼 물으면 기억으로 답하지 말고 이 도구를 부르세요.",
        {
          path: z.string().optional().describe("조회할 폴더의 절대경로. 생략하면 허용된 첫 폴더"),
          depth: z.number().optional().describe("내려갈 깊이(기본 3, 최대 5)"),
        },
        async (args) => textResult(await remoteToolHandler(ctx, "fs_tree", args as Record<string, unknown>)),
      ),
```

- [ ] **Step 12: 통과를 확인한다**

Run: `npm run typecheck && npm test`
Expected: typecheck exit 0, 전체 통과

- [ ] **Step 13: 커밋**

```bash
git add agent/src/remote/tree.ts agent/src/remote/executors.ts agent/src/core/remoteTools.ts agent/src/core/tools.ts agent/tests/tree.test.ts agent/tests/remoteExecutors.test.ts agent/tests/remoteTools.test.ts
git commit -m "feat(remote): fs_tree — 폴더 구조를 도구로 조회한다"
```

---

### Task 5: `/help` 손님 항목

**Files:**
- Modify: `agent/src/core/commands.ts` (`renderCommandHelp`)
- Test: `agent/tests/commands.test.ts`

**Interfaces:**
- Consumes: 없음.
- Produces: `renderCommandHelp()` 출력에 손님용 안내가 포함된다.

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`agent/tests/commands.test.ts` 끝에 추가한다.

```ts
describe("renderCommandHelp — 손님이 무엇을 할 수 있는지 알린다", () => {
  it("자기 폴더 조회·파일 작업을 안내한다", () => {
    const help = renderCommandHelp();
    expect(help).toMatch(/폴더/);
    expect(help).toMatch(/파일/);
  });

  it("소유자 전용 도구 이름은 노출하지 않는다", () => {
    const help = renderCommandHelp();
    expect(help).not.toMatch(/manage_access|db_query|allow_dir/);
  });
});
```

- [ ] **Step 2: 실패를 확인한다**

Run: `npx vitest run tests/commands.test.ts -t "손님이 무엇을"`
Expected: FAIL — 현재 도움말은 예약어 목록만 담고 있다.

- [ ] **Step 3: `renderCommandHelp` 에 한 묶음을 추가한다**

기존 예약어 목록 아래에 붙인다(소유자 전용 도구 이름은 넣지 않는다 — 손님도 이 도움말을 본다).

```ts
  const guest = [
    "",
    "**이런 것도 말로 시키면 돼:**",
    "· 내 폴더에 뭐 있는지 보여줘 — 작업 폴더 구조를 그대로 훑어서 알려줘",
    "· 파일 만들어줘 / 읽어줘 / 고쳐줘 — 네 작업 폴더 안에서",
    "· 명령 실행해줘 — 예: 테스트 돌려줘, 빌드해줘",
  ].join("\n");
```

- [ ] **Step 4: 통과를 확인한다**

Run: `npm run typecheck && npm test`
Expected: typecheck exit 0, 전체 통과

- [ ] **Step 5: 커밋**

```bash
git add agent/src/core/commands.ts agent/tests/commands.test.ts
git commit -m "docs(help): 손님이 쓸 수 있는 것을 도움말에 넣는다"
```

---

### Task 6: 배포와 검증

**Files:** 없음(운영 절차)

- [ ] **Step 1: 브랜치를 푸시하고 main 에 머지한다**

```bash
git push -u origin feat/observability-m1
```

원격에서 PR 을 만들고 main 에 머지한다. Railway 가 자동 재배포한다.

- [ ] **Step 2: 미니PC 워커를 갱신한다**

`fs_tree` 는 워커 코드다 — **미니PC 를 갱신하지 않으면 이 도구만 조용히 실패한다.** `asahi` 계정 PowerShell 에서:

```powershell
cd C:\asahi-worker; git pull; cd agent; npm ci
```

관리자 PowerShell 에서 워커를 재시작한다.

```powershell
Stop-ScheduledTask -TaskName asahi-worker; Start-Sleep -Seconds 3; Start-ScheduledTask -TaskName asahi-worker
```

- [ ] **Step 3: 디스코드에서 확인한다**

공개 서버 채널에서 손님 계정으로 "내 폴더에 뭐 있는지 보여줘" 를 보낸다.

기대: 폴더 구조가 오고, 진행 표시에 `✓ fs_tree — …` 가 보인다. 일부러 실패시키면(`C:\Windows` 조회) `✗ fs_tree — 허용된 폴더 밖 경로예요` 가 보인다.

- [ ] **Step 4: 기록이 실제로 쌓였는지 확인한다**

Supabase SQL Editor 에서:

```sql
select ts, user_id, tool, status, duration_ms, left(coalesce(result_summary,''), 60) as summary
from actions order by ts desc limit 20;
```

기대: 방금 부른 도구가 행으로 남아 있고 `status` 가 `ok`/`error` 로 갈린다.

- [ ] **Step 5: 스모크 체크리스트를 갱신한다**

`deploy/smoke-test.md` 에 두 항목을 추가하고 커밋한다.

```markdown
- [ ] **폴더 구조 조회(`fs_tree`)** — 손님 계정으로 "내 폴더에 뭐 있어?" 라고 묻는다.
  기대 결과: 실제 구조가 오고, `node_modules`·`.git` 은 빠져 있다. 모델이 기억으로 지어낸
  목록이 아니라 도구 호출(진행 표시의 `fs_tree`)을 거친 결과여야 한다.

- [ ] **도구 호출이 `actions` 에 남는가** — 위 조회 뒤 `actions` 테이블을 확인한다.
  기대 결과: 도구 호출 1건당 1행이 있고 `status` 가 `ok`/`error` 로 갈린다. 실패한 호출도
  남아야 한다 — 부원이 어디서 막혔는지 아는 유일한 경로다.
```

---

## Self-Review

**스펙 커버리지**

| 스펙 절 | 태스크 |
|---|---|
| §3 이벤트 모델 | Task 1 |
| §4 배선 | Task 2 |
| §5 진행 표시 | Task 3 |
| §6 `fs_tree` | Task 4 |
| §7 `/help` | Task 5 |
| §9 M1 순서·미니PC 재배포 | Task 6 |
| §10 위험(`is_error` 미확인) | Task 1 Step 3 에서 `!== true` 로 안전 기본값 처리 |
| §10 위험(심볼릭 링크) | Task 4 Step 5 테스트로 고정 |

**빠진 것:** §2 "밖" 목록은 M2 이므로 태스크가 없다(의도).

**타입 일관성:** `PendingTool`(Task 1) → Task 2 는 참조하지 않는다. `ActionRow`(Task 2)의 필드명(`resultSummary`·`durationMs`)이 `ProgressUpdate.tool_result`(`summary`·`durationMs`)와 다르므로, Task 2 Step 7 의 매핑에서 `resultSummary: u.summary` 로 명시적으로 옮긴다 — 이름이 다른 것은 의도다(DB 컬럼명과 이벤트 필드명을 각자의 맥락에 맞췄다).
