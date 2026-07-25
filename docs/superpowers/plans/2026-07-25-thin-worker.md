# 얇은 워커 구현 계획 (1단계)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 워커에서 SDK와 DB를 걷어내고, Railway 봇이 턴 전체를 붙든 채 파일·셸 작업만 워커로 원격 호출하게 만든다.

**Architecture:** 워커가 Railway로 WebSocket 아웃바운드 연결을 열고 대기한다. 봇의 SDK가 파일·셸 도구를 호출하면 그 도구가 WS로 워커에 요청을 보내고 결과를 기다린다. 경로 검사의 최종 권한은 워커가 갖는다(realpath 를 아는 건 워커뿐). 사용자가 체감하는 기능 변화는 없어야 한다.

**Tech Stack:** TypeScript (ESM, Node 22), vitest, `ws`(서버), Node 22 전역 `WebSocket`(클라이언트), `tinyglobby`, zod, Claude Agent SDK

**설계 문서:** [2026-07-25-thin-worker-design.md](../specs/2026-07-25-thin-worker-design.md)

## Global Constraints

- **한국어.** 코드 주석·프롬프트·테스트 설명 전부 한국어.
- **작업 디렉토리는 항상 `agent/`.** 모든 npm/vitest 명령은 `agent/`에서 실행한다.
- **DDL 변경 금지.** `worker_jobs` 테이블은 남기되 쓰지 않는다.
- **모듈 경계.** 새 `remote/` 디렉토리는 `core/`(순수 헬퍼)·`store/`(타입)에 의존해도 되지만, `discord.js` 를 임포트하지 않는다.
- **기능 변화 없음이 완료 기준.** 소유자 DM 에서 PC 작업이 지금과 똑같이 동작해야 한다.
- **원격 도구 이름 6개(고정):** `fs_read` `fs_write` `fs_edit` `fs_glob` `fs_grep` `sh_exec`. MCP 접두어가 붙어 `mcp__asahi__fs_read` 형태로 노출된다.
- **프레임 타입 7개(고정):** `hello` `ready` `denied` `call` `result` `ping` `pong`.
- **상한값:** 도구 호출 타임아웃 120000ms, `sh_exec` 기본 타임아웃 120000ms, 출력 truncate 30000자, `fs_read` 기본 2000줄.
- **테스트 없이 커밋 금지.** 각 태스크는 red → green → commit 순서를 지킨다.

## 파일 구조

| 파일 | 책임 |
|---|---|
| `agent/src/remote/protocol.ts` | 프레임 타입 정의·직렬화·검증. 순수 함수만. 봇/워커 양쪽이 공유 |
| `agent/src/remote/roots.ts` | 워커 쪽 경로 검사 — realpath 정규화 후 루트 안인지 판정 |
| `agent/src/remote/executors.ts` | 워커 쪽 도구 6개 실제 구현 |
| `agent/src/remote/hub.ts` | Railway 쪽 WS 서버 — 인증·연결 레지스트리·호출 상관관계·타임아웃 |
| `agent/src/remote/workerClient.ts` | 워커 쪽 WS 클라이언트 — 접속·재연결·실행기 디스패치 |
| `agent/src/core/remoteTools.ts` | Railway 쪽 MCP 도구 정의 6개 — 허브로 RPC |

---

### Task 1: 프레임 프로토콜

**Files:**
- Create: `agent/src/remote/protocol.ts`
- Test: `agent/tests/remoteProtocol.test.ts`

**Interfaces:**
- Consumes: 없음
- Produces:
  - `type Frame` — 7종 판별 유니온
  - `encodeFrame(f: Frame): string`
  - `parseFrame(raw: string): Frame | null` — 형식이 틀리면 `null`

- [ ] **Step 1: 실패하는 테스트 작성**

`agent/tests/remoteProtocol.test.ts` 를 새로 만든다.

```ts
import { describe, it, expect } from "vitest";
import { encodeFrame, parseFrame, type Frame } from "../src/remote/protocol.js";

describe("프레임 직렬화", () => {
  it("7종 프레임을 인코딩·파싱해도 값이 보존된다", () => {
    const frames: Frame[] = [
      { type: "hello", token: "t", userId: "u", roots: ["/a", "/b"] },
      { type: "ready" },
      { type: "denied", reason: "토큰 불일치" },
      { type: "call", id: "1", tool: "fs_read", args: { path: "/a/x.txt" } },
      { type: "result", id: "1", ok: true, content: "본문" },
      { type: "ping" },
      { type: "pong" },
    ];
    for (const f of frames) expect(parseFrame(encodeFrame(f))).toEqual(f);
  });
});

describe("프레임 검증 — 잘못된 입력은 null", () => {
  it("JSON 이 아니면 null", () => {
    expect(parseFrame("{{{")).toBeNull();
    expect(parseFrame("")).toBeNull();
  });

  it("알 수 없는 타입은 null", () => {
    expect(parseFrame(JSON.stringify({ type: "evil" }))).toBeNull();
  });

  it("필수 필드가 없거나 타입이 다르면 null", () => {
    expect(parseFrame(JSON.stringify({ type: "hello", token: "t", userId: "u" }))).toBeNull();
    expect(parseFrame(JSON.stringify({ type: "hello", token: 1, userId: "u", roots: [] }))).toBeNull();
    expect(parseFrame(JSON.stringify({ type: "call", id: "1", tool: "fs_read" }))).toBeNull();
    expect(parseFrame(JSON.stringify({ type: "result", id: "1", ok: "yes", content: "" }))).toBeNull();
  });

  it("roots 배열에 문자열이 아닌 값이 섞이면 null", () => {
    expect(parseFrame(JSON.stringify({ type: "hello", token: "t", userId: "u", roots: ["/a", 3] }))).toBeNull();
  });
});
```

- [ ] **Step 2: 실패 확인**

```bash
cd agent && npx vitest run tests/remoteProtocol.test.ts
```

기대: FAIL — `../src/remote/protocol.js` 를 찾을 수 없음.

- [ ] **Step 3: 구현**

`agent/src/remote/protocol.ts` 를 새로 만든다.

```ts
// 봇(허브)과 워커가 WebSocket 으로 주고받는 프레임 정의. 양쪽이 공유하는 유일한 계약이며
// 순수 함수만 둔다(소켓·fs 없음) — 그래야 실제 연결 없이 테스트할 수 있다.

export type WorkerHello = { type: "hello"; token: string; userId: string; roots: string[] };
export type HubReady = { type: "ready" };
export type HubDenied = { type: "denied"; reason: string };
export type HubCall = { type: "call"; id: string; tool: string; args: Record<string, unknown> };
export type WorkerResult = { type: "result"; id: string; ok: boolean; content: string };
export type Ping = { type: "ping" };
export type Pong = { type: "pong" };

export type Frame = WorkerHello | HubReady | HubDenied | HubCall | WorkerResult | Ping | Pong;

export function encodeFrame(f: Frame): string {
  return JSON.stringify(f);
}

const isStr = (v: unknown): v is string => typeof v === "string";
const isStrArray = (v: unknown): v is string[] => Array.isArray(v) && v.every(isStr);
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

// 형식이 조금이라도 어긋나면 null 을 돌려준다. 호출측은 null 을 "무시 또는 연결 종료"로 다룬다 —
// 신뢰할 수 없는 입력이 그대로 실행 경로로 흘러들지 않게 하는 유일한 관문이다.
export function parseFrame(raw: string): Frame | null {
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isObj(v)) return null;
  switch (v.type) {
    case "hello":
      return isStr(v.token) && isStr(v.userId) && isStrArray(v.roots)
        ? { type: "hello", token: v.token, userId: v.userId, roots: v.roots }
        : null;
    case "ready":
      return { type: "ready" };
    case "denied":
      return isStr(v.reason) ? { type: "denied", reason: v.reason } : null;
    case "call":
      return isStr(v.id) && isStr(v.tool) && isObj(v.args)
        ? { type: "call", id: v.id, tool: v.tool, args: v.args }
        : null;
    case "result":
      return isStr(v.id) && typeof v.ok === "boolean" && isStr(v.content)
        ? { type: "result", id: v.id, ok: v.ok, content: v.content }
        : null;
    case "ping":
      return { type: "ping" };
    case "pong":
      return { type: "pong" };
    default:
      return null;
  }
}
```

- [ ] **Step 4: 통과 확인**

```bash
cd agent && npx vitest run tests/remoteProtocol.test.ts
```

기대: PASS (전부)

- [ ] **Step 5: 전체 테스트 회귀 확인**

```bash
cd agent && npm test
```

기대: 0 failed, 1 skipped.

- [ ] **Step 6: 커밋**

```bash
git add agent/src/remote/protocol.ts agent/tests/remoteProtocol.test.ts
git commit -m "feat(remote): 봇↔워커 프레임 프로토콜"
```

---

### Task 2: 워커 경로 검사

**Files:**
- Create: `agent/src/remote/roots.ts`
- Test: `agent/tests/remoteRoots.test.ts`

**Interfaces:**
- Consumes: `resolveRealOrNearestAncestor`(`core/pathPermission.js`), `isPathWithinAny`(`core/paths.js`) — 둘 다 기존 함수, 수정하지 않는다
- Produces: `checkPath(target: string, roots: string[]): { ok: true; path: string } | { ok: false; message: string }`

워커가 갖는 **최종 권한**이다. 봇 쪽 `allowed_dirs` 필터를 통과했더라도 여기서 다시 막는다.

- [ ] **Step 1: 실패하는 테스트 작성**

`agent/tests/remoteRoots.test.ts` 를 새로 만든다.

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { checkPath } from "../src/remote/roots.js";

describe("checkPath — 워커 루트 검사", () => {
  let root: string;
  beforeEach(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "asahi-roots-")));
    fs.mkdirSync(path.join(root, "proj"), { recursive: true });
    fs.writeFileSync(path.join(root, "proj", "a.txt"), "hello");
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it("루트 안의 기존 파일은 허용하고 realpath 를 돌려준다", () => {
    const r = checkPath(path.join(root, "proj", "a.txt"), [root]);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.path).toBe(path.join(root, "proj", "a.txt"));
  });

  it("아직 없는 파일도 조상이 루트 안이면 허용한다(새로 쓸 파일)", () => {
    const r = checkPath(path.join(root, "proj", "new.txt"), [root]);
    expect(r.ok).toBe(true);
  });

  it("루트 밖 경로는 거부한다", () => {
    const r = checkPath(path.join(os.tmpdir(), "elsewhere.txt"), [root]);
    expect(r.ok).toBe(false);
  });

  it("'..' 로 루트를 벗어나면 거부한다", () => {
    const r = checkPath(path.join(root, "proj", "..", "..", "escape.txt"), [root]);
    expect(r.ok).toBe(false);
  });

  it("루트 목록이 비어 있으면 거부한다", () => {
    expect(checkPath(path.join(root, "proj", "a.txt"), []).ok).toBe(false);
  });

  it("여러 루트 중 하나에만 속해도 허용한다", () => {
    const other = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "asahi-roots2-")));
    try {
      expect(checkPath(path.join(root, "proj", "a.txt"), [other, root]).ok).toBe(true);
    } finally {
      fs.rmSync(other, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 2: 실패 확인**

```bash
cd agent && npx vitest run tests/remoteRoots.test.ts
```

기대: FAIL — `checkPath` 없음.

- [ ] **Step 3: 구현**

`agent/src/remote/roots.ts` 를 새로 만든다.

```ts
import { resolveRealOrNearestAncestor } from "../core/pathPermission.js";
import { isPathWithinAny } from "../core/paths.js";

export type PathCheck = { ok: true; path: string } | { ok: false; message: string };

// 워커의 최종 경로 관문. 봇 쪽 allowed_dirs 를 통과했더라도 여기서 다시 판정한다 —
// 심볼릭 링크·'..'·존재하지 않는 경로의 실제 위치를 아는 건 파일시스템을 가진 이 프로세스뿐이다.
// 정규화 규칙은 기존 canUseTool 경로 게이트와 동일한 함수를 재사용한다(동작이 갈리지 않게).
export function checkPath(target: string, roots: string[]): PathCheck {
  if (roots.length === 0) return { ok: false, message: "워커에 열린 작업 폴더가 없어요." };
  const resolved = resolveRealOrNearestAncestor(target);
  if (!isPathWithinAny(resolved, roots)) {
    return { ok: false, message: `워커 작업 폴더 밖 경로예요: ${resolved}` };
  }
  return { ok: true, path: resolved };
}
```

- [ ] **Step 4: 통과 확인**

```bash
cd agent && npx vitest run tests/remoteRoots.test.ts
```

기대: PASS (전부)

- [ ] **Step 5: 전체 테스트 회귀 확인**

```bash
cd agent && npm test
```

기대: 0 failed, 1 skipped.

- [ ] **Step 6: 커밋**

```bash
git add agent/src/remote/roots.ts agent/tests/remoteRoots.test.ts
git commit -m "feat(remote): 워커 루트 경로 검사"
```

---

### Task 3: 워커 실행기 6종

**Files:**
- Create: `agent/src/remote/executors.ts`
- Modify: `agent/package.json` (`tinyglobby` 의존성 추가)
- Test: `agent/tests/remoteExecutors.test.ts`

**Interfaces:**
- Consumes: `checkPath(target, roots)` (Task 2)
- Produces:
  - `type ExecResult = { ok: boolean; content: string }`
  - `type Executors = Record<string, (args: Record<string, unknown>) => Promise<ExecResult>>`
  - `makeExecutors(roots: string[]): Executors` — 키가 정확히 `fs_read` `fs_write` `fs_edit` `fs_glob` `fs_grep` `sh_exec` 6개
  - `export const OUTPUT_MAX = 30000`

이 태스크가 가장 큽니다. 도구 하나씩 순서대로 만드세요.

- [ ] **Step 1: 의존성 추가**

```bash
cd agent && npm install tinyglobby
```

- [ ] **Step 2: 실패하는 테스트 작성**

`agent/tests/remoteExecutors.test.ts` 를 새로 만든다.

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { makeExecutors, OUTPUT_MAX } from "../src/remote/executors.js";

describe("워커 실행기", () => {
  let root: string;
  let ex: ReturnType<typeof makeExecutors>;
  beforeEach(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "asahi-ex-")));
    fs.writeFileSync(path.join(root, "a.txt"), "첫줄\n둘째줄\n셋째줄\n");
    fs.mkdirSync(path.join(root, "sub"), { recursive: true });
    fs.writeFileSync(path.join(root, "sub", "b.ts"), "export const x = 1;\n");
    ex = makeExecutors([root]);
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it("도구 6개를 정확히 노출한다", () => {
    expect(Object.keys(ex).sort()).toEqual(["fs_edit", "fs_glob", "fs_grep", "fs_read", "fs_write", "sh_exec"]);
  });

  it("fs_read 는 줄번호를 붙여 읽는다", async () => {
    const r = await ex.fs_read({ path: path.join(root, "a.txt") });
    expect(r.ok).toBe(true);
    expect(r.content).toContain("1\t첫줄");
    expect(r.content).toContain("3\t셋째줄");
  });

  it("fs_read 는 offset·limit 를 적용한다", async () => {
    const r = await ex.fs_read({ path: path.join(root, "a.txt"), offset: 2, limit: 1 });
    expect(r.content).toContain("2\t둘째줄");
    expect(r.content).not.toContain("첫줄");
    expect(r.content).not.toContain("셋째줄");
  });

  it("루트 밖은 모든 fs 도구가 거부한다", async () => {
    const outside = path.join(os.tmpdir(), "outside.txt");
    const args = { path: outside, content: "x", oldString: "a", newString: "b", pattern: "*" };
    for (const tool of ["fs_read", "fs_write", "fs_edit", "fs_glob", "fs_grep"]) {
      const run = ex[tool];
      const r = await run(args);
      expect(r.ok, `${tool} 이 루트 밖을 허용했다`).toBe(false);
    }
  });

  it("fs_write 는 없는 상위 폴더를 만들고 쓴다", async () => {
    const target = path.join(root, "deep", "c.txt");
    const r = await ex.fs_write({ path: target, content: "내용" });
    expect(r.ok).toBe(true);
    expect(fs.readFileSync(target, "utf8")).toBe("내용");
  });

  it("fs_edit 는 정확히 한 번 등장할 때만 치환한다", async () => {
    const p = path.join(root, "a.txt");
    const ok = await ex.fs_edit({ path: p, oldString: "둘째줄", newString: "바뀐줄" });
    expect(ok.ok).toBe(true);
    expect(fs.readFileSync(p, "utf8")).toContain("바뀐줄");

    const missing = await ex.fs_edit({ path: p, oldString: "없는문자열", newString: "x" });
    expect(missing.ok).toBe(false);
  });

  it("fs_edit 는 여러 번 등장하면 replaceAll 없이는 거부한다", async () => {
    const p = path.join(root, "dup.txt");
    fs.writeFileSync(p, "같음\n같음\n");
    expect((await ex.fs_edit({ path: p, oldString: "같음", newString: "다름" })).ok).toBe(false);
    const all = await ex.fs_edit({ path: p, oldString: "같음", newString: "다름", replaceAll: true });
    expect(all.ok).toBe(true);
    expect(fs.readFileSync(p, "utf8")).toBe("다름\n다름\n");
  });

  it("fs_glob 는 루트 기준 상대 패턴으로 파일을 찾는다", async () => {
    const r = await ex.fs_glob({ pattern: "**/*.ts", path: root });
    expect(r.ok).toBe(true);
    expect(r.content).toContain("b.ts");
    expect(r.content).not.toContain("a.txt");
  });

  it("fs_grep 는 내용에 매칭되는 파일과 줄을 찾는다", async () => {
    const r = await ex.fs_grep({ pattern: "export const", path: root });
    expect(r.ok).toBe(true);
    expect(r.content).toContain("b.ts");
  });

  it("sh_exec 는 명령을 실행하고 출력을 돌려준다", async () => {
    const r = await ex.sh_exec({ command: "echo asahi" });
    expect(r.ok).toBe(true);
    expect(r.content).toContain("asahi");
  });

  it("sh_exec 는 실패 종료코드를 ok=false 로 보고한다", async () => {
    const r = await ex.sh_exec({ command: "exit 3" });
    expect(r.ok).toBe(false);
    expect(r.content).toContain("3");
  });

  it("sh_exec 는 타임아웃되면 ok=false 로 끝난다", async () => {
    const r = await ex.sh_exec({ command: "sleep 5", timeoutMs: 200 });
    expect(r.ok).toBe(false);
  }, 10000);

  it("루트가 비면 sh_exec 도 거부한다", async () => {
    const none = makeExecutors([]);
    expect((await none.sh_exec({ command: "echo x" })).ok).toBe(false);
  });

  it("긴 출력은 상한으로 자른다", async () => {
    const p = path.join(root, "big.txt");
    fs.writeFileSync(p, "가".repeat(OUTPUT_MAX * 2));
    const r = await ex.fs_read({ path: p });
    expect(r.content.length).toBeLessThanOrEqual(OUTPUT_MAX + 200);
  });
});
```

- [ ] **Step 3: 실패 확인**

```bash
cd agent && npx vitest run tests/remoteExecutors.test.ts
```

기대: FAIL — `makeExecutors` 없음.

- [ ] **Step 4: 구현**

`agent/src/remote/executors.ts` 를 새로 만든다.

```ts
import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { glob } from "tinyglobby";
import { checkPath } from "./roots.js";

export type ExecResult = { ok: boolean; content: string };
export type Executors = Record<string, (args: Record<string, unknown>) => Promise<ExecResult>>;

// 모델에게 돌려줄 출력 상한. 넘으면 잘라내고 잘렸다고 명시한다 — 조용히 자르면 모델이
// 전체를 봤다고 착각한다.
export const OUTPUT_MAX = 30000;
const READ_DEFAULT_LIMIT = 2000;
const SH_DEFAULT_TIMEOUT_MS = 120_000;

function truncate(s: string): string {
  return s.length <= OUTPUT_MAX ? s : `${s.slice(0, OUTPUT_MAX)}\n… (출력이 길어 ${OUTPUT_MAX}자에서 잘랐어요)`;
}

const str = (v: unknown): string | undefined => (typeof v === "string" && v.length > 0 ? v : undefined);
const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

export function makeExecutors(roots: string[]): Executors {
  // 경로 인자를 검사해 실경로를 돌려준다. 거부되면 그대로 ExecResult 로 반환한다.
  const gate = (raw: unknown): { ok: true; path: string } | { ok: false; res: ExecResult } => {
    const p = str(raw);
    if (!p) return { ok: false, res: { ok: false, content: "path 인자가 필요해요." } };
    const c = checkPath(p, roots);
    return c.ok ? { ok: true, path: c.path } : { ok: false, res: { ok: false, content: c.message } };
  };

  return {
    async fs_read(args) {
      const g = gate(args.path);
      if (!g.ok) return g.res;
      let text: string;
      try {
        text = await fs.readFile(g.path, "utf8");
      } catch (err) {
        return { ok: false, content: `읽지 못했어요: ${String(err)}` };
      }
      const lines = text.split("\n");
      const offset = Math.max(1, num(args.offset) ?? 1);
      const limit = Math.max(1, num(args.limit) ?? READ_DEFAULT_LIMIT);
      const slice = lines.slice(offset - 1, offset - 1 + limit);
      const numbered = slice.map((l, i) => `${offset + i}\t${l}`).join("\n");
      return { ok: true, content: truncate(numbered) };
    },

    async fs_write(args) {
      const g = gate(args.path);
      if (!g.ok) return g.res;
      const content = typeof args.content === "string" ? args.content : "";
      try {
        await fs.mkdir(path.dirname(g.path), { recursive: true });
        await fs.writeFile(g.path, content, "utf8");
      } catch (err) {
        return { ok: false, content: `쓰지 못했어요: ${String(err)}` };
      }
      return { ok: true, content: `썼어요: ${g.path} (${content.length}자)` };
    },

    async fs_edit(args) {
      const g = gate(args.path);
      if (!g.ok) return g.res;
      const oldString = str(args.oldString);
      const newString = typeof args.newString === "string" ? args.newString : undefined;
      if (oldString === undefined || newString === undefined) {
        return { ok: false, content: "oldString·newString 인자가 필요해요." };
      }
      let text: string;
      try {
        text = await fs.readFile(g.path, "utf8");
      } catch (err) {
        return { ok: false, content: `읽지 못했어요: ${String(err)}` };
      }
      const count = text.split(oldString).length - 1;
      if (count === 0) return { ok: false, content: "찾는 문자열이 파일에 없어요." };
      if (count > 1 && args.replaceAll !== true) {
        return { ok: false, content: `${count}군데에서 발견됐어요. 더 긴 문자열로 특정하거나 replaceAll 을 쓰세요.` };
      }
      const next = args.replaceAll === true ? text.split(oldString).join(newString) : text.replace(oldString, newString);
      try {
        await fs.writeFile(g.path, next, "utf8");
      } catch (err) {
        return { ok: false, content: `쓰지 못했어요: ${String(err)}` };
      }
      return { ok: true, content: `고쳤어요: ${g.path} (${count}군데)` };
    },

    async fs_glob(args) {
      const base = str(args.path) ?? roots[0];
      const g = gate(base);
      if (!g.ok) return g.res;
      const pattern = str(args.pattern) ?? "**/*";
      let hits: string[];
      try {
        hits = await glob(pattern, { cwd: g.path, absolute: true, dot: false });
      } catch (err) {
        return { ok: false, content: `찾지 못했어요: ${String(err)}` };
      }
      // tinyglobby 는 pattern 에 절대경로나 '..' 를 그대로 받아들일 수 있으므로 결과도 다시 거른다.
      const inside = hits.filter((h) => checkPath(h, roots).ok);
      return { ok: true, content: truncate(inside.length > 0 ? inside.join("\n") : "(일치하는 파일 없음)") };
    },

    async fs_grep(args) {
      const base = str(args.path) ?? roots[0];
      const g = gate(base);
      if (!g.ok) return g.res;
      const pattern = str(args.pattern);
      if (!pattern) return { ok: false, content: "pattern 인자가 필요해요." };
      let re: RegExp;
      try {
        re = new RegExp(pattern);
      } catch (err) {
        return { ok: false, content: `정규식이 올바르지 않아요: ${String(err)}` };
      }
      let files: string[];
      try {
        files = await glob(str(args.glob) ?? "**/*", { cwd: g.path, absolute: true, dot: false });
      } catch (err) {
        return { ok: false, content: `찾지 못했어요: ${String(err)}` };
      }
      const out: string[] = [];
      for (const f of files) {
        if (!checkPath(f, roots).ok) continue;
        let text: string;
        try {
          text = await fs.readFile(f, "utf8");
        } catch {
          continue; // 바이너리·권한 문제 파일은 건너뛴다
        }
        text.split("\n").forEach((line, i) => {
          if (re.test(line)) out.push(`${f}:${i + 1}: ${line.trim()}`);
        });
        if (out.join("\n").length > OUTPUT_MAX) break;
      }
      return { ok: true, content: truncate(out.length > 0 ? out.join("\n") : "(일치하는 내용 없음)") };
    },

    async sh_exec(args) {
      if (roots.length === 0) return { ok: false, content: "워커에 열린 작업 폴더가 없어요." };
      const command = str(args.command);
      if (!command) return { ok: false, content: "command 인자가 필요해요." };
      const timeoutMs = num(args.timeoutMs) ?? SH_DEFAULT_TIMEOUT_MS;
      return new Promise<ExecResult>((resolve) => {
        const child = spawn(command, { cwd: roots[0], shell: true });
        let out = "";
        const append = (chunk: Buffer) => {
          if (out.length < OUTPUT_MAX * 2) out += chunk.toString();
        };
        child.stdout.on("data", append);
        child.stderr.on("data", append);
        const timer = setTimeout(() => {
          child.kill();
          resolve({ ok: false, content: truncate(`${out}\n(${timeoutMs}ms 안에 끝나지 않아 중단했어요)`) });
        }, timeoutMs);
        child.on("error", (err) => {
          clearTimeout(timer);
          resolve({ ok: false, content: `실행하지 못했어요: ${String(err)}` });
        });
        child.on("close", (code) => {
          clearTimeout(timer);
          resolve(code === 0
            ? { ok: true, content: truncate(out) }
            : { ok: false, content: truncate(`${out}\n(종료 코드 ${code})`) });
        });
      });
    },
  };
}
```

- [ ] **Step 5: 통과 확인**

```bash
cd agent && npx vitest run tests/remoteExecutors.test.ts
```

기대: PASS (전부)

- [ ] **Step 6: 전체 테스트 + 타입 확인**

```bash
cd agent && npm test && npx tsc --noEmit
```

기대: 0 failed, 1 skipped. tsc 클린.

- [ ] **Step 7: 커밋**

```bash
git add agent/src/remote/executors.ts agent/tests/remoteExecutors.test.ts agent/package.json agent/package-lock.json
git commit -m "feat(remote): 워커 실행기 6종(fs_*, sh_exec)"
```

---

### Task 4: 허브 — Railway 쪽 WS 서버

**Files:**
- Create: `agent/src/remote/hub.ts`
- Modify: `agent/package.json` (`ws`, `@types/ws` 추가)
- Test: `agent/tests/remoteHub.test.ts`

**Interfaces:**
- Consumes: `Frame`, `encodeFrame`, `parseFrame` (Task 1)
- Produces:
  - `class WorkerHub`
    - `constructor(opts: { token: string; ownerId: string; callTimeoutMs?: number })`
    - `handleConnection(socket: HubSocket): void` — 소켓 추상화를 받아 실제 `ws` 없이 테스트 가능
    - `isConnected(userId: string): boolean`
    - `rootsOf(userId: string): string[]`
    - `call(userId: string, tool: string, args: Record<string, unknown>): Promise<{ ok: boolean; content: string }>`
    - `closeAll(): void`
  - `type HubSocket = { send(data: string): void; close(): void; onMessage(cb: (raw: string) => void): void; onClose(cb: () => void): void }`

`ws` 를 직접 다루지 않고 `HubSocket` 인터페이스로 감싸는 이유: 실제 소켓 없이 유닛 테스트를 하기 위해서다. `ws` 연결을 이 인터페이스로 바꾸는 어댑터는 Task 7(배선)에서 만든다.

- [ ] **Step 1: 의존성 추가**

```bash
cd agent && npm install ws && npm install -D @types/ws
```

- [ ] **Step 2: 실패하는 테스트 작성**

`agent/tests/remoteHub.test.ts` 를 새로 만든다.

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { WorkerHub, type HubSocket } from "../src/remote/hub.js";
import { encodeFrame, parseFrame, type Frame } from "../src/remote/protocol.js";

function fakeSocket() {
  const sent: Frame[] = [];
  let onMsg: (raw: string) => void = () => {};
  let onCls: () => void = () => {};
  let closed = false;
  const sock: HubSocket = {
    send: (d) => { const f = parseFrame(d); if (f) sent.push(f); },
    close: () => { closed = true; onCls(); },
    onMessage: (cb) => { onMsg = cb; },
    onClose: (cb) => { onCls = cb; },
  };
  return {
    sock, sent,
    get closed() { return closed; },
    recv: (f: Frame) => onMsg(encodeFrame(f)),
    recvRaw: (raw: string) => onMsg(raw),
  };
}

describe("WorkerHub — 인증", () => {
  let hub: WorkerHub;
  beforeEach(() => { hub = new WorkerHub({ token: "good", ownerId: "owner" }); });

  it("올바른 토큰과 소유자 ID 면 ready 를 보내고 연결로 등록한다", () => {
    const s = fakeSocket();
    hub.handleConnection(s.sock);
    s.recv({ type: "hello", token: "good", userId: "owner", roots: ["/w"] });
    expect(s.sent[0]).toEqual({ type: "ready" });
    expect(hub.isConnected("owner")).toBe(true);
    expect(hub.rootsOf("owner")).toEqual(["/w"]);
  });

  it("토큰이 틀리면 denied 후 연결을 끊고 등록하지 않는다", () => {
    const s = fakeSocket();
    hub.handleConnection(s.sock);
    s.recv({ type: "hello", token: "bad", userId: "owner", roots: ["/w"] });
    expect(s.sent[0]?.type).toBe("denied");
    expect(s.closed).toBe(true);
    expect(hub.isConnected("owner")).toBe(false);
  });

  it("소유자가 아닌 userId 는 거부한다(1단계는 소유자 워커 하나)", () => {
    const s = fakeSocket();
    hub.handleConnection(s.sock);
    s.recv({ type: "hello", token: "good", userId: "guest", roots: ["/w"] });
    expect(s.sent[0]?.type).toBe("denied");
    expect(hub.isConnected("guest")).toBe(false);
  });

  it("hello 없이 다른 프레임을 먼저 보내면 끊는다", () => {
    const s = fakeSocket();
    hub.handleConnection(s.sock);
    s.recv({ type: "result", id: "1", ok: true, content: "x" });
    expect(s.closed).toBe(true);
  });

  it("형식이 깨진 프레임은 끊는다", () => {
    const s = fakeSocket();
    hub.handleConnection(s.sock);
    s.recvRaw("{{{");
    expect(s.closed).toBe(true);
  });
});

describe("WorkerHub — 도구 호출", () => {
  let hub: WorkerHub;
  let s: ReturnType<typeof fakeSocket>;
  beforeEach(() => {
    hub = new WorkerHub({ token: "good", ownerId: "owner", callTimeoutMs: 300 });
    s = fakeSocket();
    hub.handleConnection(s.sock);
    s.recv({ type: "hello", token: "good", userId: "owner", roots: ["/w"] });
  });

  it("call 프레임을 보내고 같은 id 의 result 로 응답한다", async () => {
    const p = hub.call("owner", "fs_read", { path: "/w/a.txt" });
    const sentCall = s.sent.find((f) => f.type === "call");
    expect(sentCall).toBeTruthy();
    if (sentCall?.type !== "call") throw new Error("call 프레임 없음");
    expect(sentCall.tool).toBe("fs_read");
    s.recv({ type: "result", id: sentCall.id, ok: true, content: "본문" });
    await expect(p).resolves.toEqual({ ok: true, content: "본문" });
  });

  it("연결이 없으면 즉시 실패를 돌려준다(예외를 던지지 않는다)", async () => {
    await expect(hub.call("nobody", "fs_read", {})).resolves.toMatchObject({ ok: false });
  });

  it("타임아웃되면 실패를 돌려준다", async () => {
    await expect(hub.call("owner", "sh_exec", { command: "x" })).resolves.toMatchObject({ ok: false });
  });

  it("연결이 끊기면 대기 중이던 호출이 전부 실패로 정리된다", async () => {
    const p = hub.call("owner", "fs_read", { path: "/w/a.txt" });
    s.sock.close();
    await expect(p).resolves.toMatchObject({ ok: false });
    expect(hub.isConnected("owner")).toBe(false);
  });

  it("모르는 id 의 result 가 와도 죽지 않는다", () => {
    expect(() => s.recv({ type: "result", id: "없는id", ok: true, content: "x" })).not.toThrow();
  });
});
```

- [ ] **Step 3: 실패 확인**

```bash
cd agent && npx vitest run tests/remoteHub.test.ts
```

기대: FAIL — `WorkerHub` 없음.

- [ ] **Step 4: 구현**

`agent/src/remote/hub.ts` 를 새로 만든다.

```ts
import { encodeFrame, parseFrame, type Frame } from "./protocol.js";

// 실제 ws 소켓을 감싸는 최소 인터페이스. 이 추상화 덕에 소켓 없이 허브 로직을 테스트한다
// (ws → HubSocket 어댑터는 index.ts 배선에서 만든다).
export type HubSocket = {
  send(data: string): void;
  close(): void;
  onMessage(cb: (raw: string) => void): void;
  onClose(cb: () => void): void;
};

type Pending = { resolve: (r: { ok: boolean; content: string }) => void; timer: ReturnType<typeof setTimeout> };
type Conn = { socket: HubSocket; roots: string[]; pending: Map<string, Pending> };

const DEFAULT_CALL_TIMEOUT_MS = 120_000;

export class WorkerHub {
  private conns = new Map<string, Conn>();
  private seq = 0;
  private callTimeoutMs: number;

  constructor(private opts: { token: string; ownerId: string; callTimeoutMs?: number }) {
    this.callTimeoutMs = opts.callTimeoutMs ?? DEFAULT_CALL_TIMEOUT_MS;
  }

  // 새 소켓 하나를 받는다. hello 로 인증되기 전에는 어떤 프레임도 처리하지 않는다.
  handleConnection(socket: HubSocket): void {
    let userId: string | null = null;

    socket.onMessage((raw) => {
      const frame = parseFrame(raw);
      if (!frame) { socket.close(); return; }

      if (userId === null) {
        // 인증 전에는 hello 만 받는다. 그 외에는 즉시 끊는다.
        if (frame.type !== "hello") { socket.close(); return; }
        if (frame.token !== this.opts.token) {
          socket.send(encodeFrame({ type: "denied", reason: "토큰이 올바르지 않습니다." }));
          socket.close();
          return;
        }
        // 1단계는 소유자 워커 하나만 지원한다. 사용자별 토큰이 생기는 2단계에서 이 조건이 바뀐다.
        if (frame.userId !== this.opts.ownerId) {
          socket.send(encodeFrame({ type: "denied", reason: "이 워커 신원은 아직 지원하지 않습니다." }));
          socket.close();
          return;
        }
        userId = frame.userId;
        this.dropExisting(userId);
        this.conns.set(userId, { socket, roots: frame.roots, pending: new Map() });
        socket.send(encodeFrame({ type: "ready" }));
        return;
      }

      const conn = this.conns.get(userId);
      if (!conn) return;
      if (frame.type === "result") {
        const p = conn.pending.get(frame.id);
        if (!p) return; // 모르는 id — 타임아웃 뒤 늦게 온 응답일 수 있다. 무시한다.
        conn.pending.delete(frame.id);
        clearTimeout(p.timer);
        p.resolve({ ok: frame.ok, content: frame.content });
      } else if (frame.type === "ping") {
        socket.send(encodeFrame({ type: "pong" }));
      }
    });

    socket.onClose(() => {
      if (userId === null) return;
      const conn = this.conns.get(userId);
      if (!conn || conn.socket !== socket) return;
      this.conns.delete(userId);
      this.failAllPending(conn, "워커 연결이 끊겼어요.");
    });
  }

  isConnected(userId: string): boolean {
    return this.conns.has(userId);
  }

  rootsOf(userId: string): string[] {
    return this.conns.get(userId)?.roots ?? [];
  }

  // 도구 호출 하나를 워커로 보내고 결과를 기다린다. 어떤 경우에도 reject 하지 않는다 —
  // 실패는 ok:false 로 모델에게 돌려주어 턴 전체가 죽지 않게 한다.
  call(userId: string, tool: string, args: Record<string, unknown>): Promise<{ ok: boolean; content: string }> {
    const conn = this.conns.get(userId);
    if (!conn) return Promise.resolve({ ok: false, content: "워커가 연결돼 있지 않아요." });
    const id = String(++this.seq);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        conn.pending.delete(id);
        resolve({ ok: false, content: `워커가 ${this.callTimeoutMs}ms 안에 응답하지 않았어요.` });
      }, this.callTimeoutMs);
      conn.pending.set(id, { resolve, timer });
      conn.socket.send(encodeFrame({ type: "call", id, tool, args } satisfies Frame));
    });
  }

  closeAll(): void {
    for (const [userId, conn] of this.conns) {
      this.failAllPending(conn, "봇이 종료돼 작업을 마치지 못했어요.");
      conn.socket.close();
      this.conns.delete(userId);
    }
  }

  // 같은 사용자의 이전 연결이 남아 있으면 정리한다(워커 재시작 시 유령 연결 방지).
  private dropExisting(userId: string): void {
    const prev = this.conns.get(userId);
    if (!prev) return;
    this.conns.delete(userId);
    this.failAllPending(prev, "워커가 다시 연결돼 이전 작업이 취소됐어요.");
    prev.socket.close();
  }

  private failAllPending(conn: Conn, message: string): void {
    for (const [, p] of conn.pending) {
      clearTimeout(p.timer);
      p.resolve({ ok: false, content: message });
    }
    conn.pending.clear();
  }
}
```

- [ ] **Step 5: 통과 확인**

```bash
cd agent && npx vitest run tests/remoteHub.test.ts
```

기대: PASS (전부)

- [ ] **Step 6: 전체 테스트 + 타입 확인**

```bash
cd agent && npm test && npx tsc --noEmit
```

기대: 0 failed, 1 skipped. tsc 클린.

- [ ] **Step 7: 커밋**

```bash
git add agent/src/remote/hub.ts agent/tests/remoteHub.test.ts agent/package.json agent/package-lock.json
git commit -m "feat(remote): Railway 쪽 워커 허브(인증·호출 상관관계·타임아웃)"
```

---

### Task 5: 워커 클라이언트

**Files:**
- Create: `agent/src/remote/workerClient.ts`
- Test: `agent/tests/remoteWorkerClient.test.ts`

**Interfaces:**
- Consumes: `Frame`, `encodeFrame`, `parseFrame` (Task 1), `Executors` (Task 3)
- Produces:
  - `type ClientSocket = { send(data: string): void; close(): void; onMessage(cb: (raw: string) => void): void; onClose(cb: () => void): void; onOpen(cb: () => void): void }`
  - `startWorkerClient(opts: { connect: () => ClientSocket; token: string; userId: string; roots: string[]; executors: Executors; onStatus?: (s: string) => void; retryDelayMs?: number }): { stop(): void }`

`connect` 를 주입받는 이유는 허브와 같다 — 실제 WebSocket 없이 테스트하기 위해서다. 실제 `WebSocket` 을 이 인터페이스로 바꾸는 어댑터는 Task 7 에서 만든다.

- [ ] **Step 1: 실패하는 테스트 작성**

`agent/tests/remoteWorkerClient.test.ts` 를 새로 만든다.

```ts
import { describe, it, expect, vi } from "vitest";
import { startWorkerClient, type ClientSocket } from "../src/remote/workerClient.js";
import { encodeFrame, parseFrame, type Frame } from "../src/remote/protocol.js";
import type { Executors } from "../src/remote/executors.js";

function fakeSocket() {
  const sent: Frame[] = [];
  let onMsg: (raw: string) => void = () => {};
  let onCls: () => void = () => {};
  let onOpn: () => void = () => {};
  const sock: ClientSocket = {
    send: (d) => { const f = parseFrame(d); if (f) sent.push(f); },
    close: () => onCls(),
    onMessage: (cb) => { onMsg = cb; },
    onClose: (cb) => { onCls = cb; },
    onOpen: (cb) => { onOpn = cb; },
  };
  return { sock, sent, open: () => onOpn(), recv: (f: Frame) => onMsg(encodeFrame(f)), drop: () => onCls() };
}

const executors: Executors = {
  fs_read: async (args) => ({ ok: true, content: `읽음:${String(args.path)}` }),
  boom: async () => { throw new Error("터짐"); },
};

describe("워커 클라이언트", () => {
  it("연결되면 hello 를 먼저 보낸다", () => {
    const s = fakeSocket();
    const c = startWorkerClient({ connect: () => s.sock, token: "t", userId: "owner", roots: ["/w"], executors });
    s.open();
    expect(s.sent[0]).toEqual({ type: "hello", token: "t", userId: "owner", roots: ["/w"] });
    c.stop();
  });

  it("call 을 받으면 실행기를 돌리고 같은 id 로 result 를 보낸다", async () => {
    const s = fakeSocket();
    const c = startWorkerClient({ connect: () => s.sock, token: "t", userId: "owner", roots: ["/w"], executors });
    s.open();
    s.recv({ type: "ready" });
    s.recv({ type: "call", id: "7", tool: "fs_read", args: { path: "/w/a.txt" } });
    await vi.waitFor(() => expect(s.sent.some((f) => f.type === "result")).toBe(true));
    const r = s.sent.find((f) => f.type === "result");
    expect(r).toEqual({ type: "result", id: "7", ok: true, content: "읽음:/w/a.txt" });
    c.stop();
  });

  it("모르는 도구는 ok=false 로 응답한다", async () => {
    const s = fakeSocket();
    const c = startWorkerClient({ connect: () => s.sock, token: "t", userId: "owner", roots: ["/w"], executors });
    s.open();
    s.recv({ type: "call", id: "8", tool: "없는도구", args: {} });
    await vi.waitFor(() => expect(s.sent.some((f) => f.type === "result")).toBe(true));
    expect(s.sent.find((f) => f.type === "result")).toMatchObject({ id: "8", ok: false });
    c.stop();
  });

  it("실행기가 예외를 던져도 result 로 실패를 돌려준다(프로세스가 죽지 않는다)", async () => {
    const s = fakeSocket();
    const c = startWorkerClient({ connect: () => s.sock, token: "t", userId: "owner", roots: ["/w"], executors });
    s.open();
    s.recv({ type: "call", id: "9", tool: "boom", args: {} });
    await vi.waitFor(() => expect(s.sent.some((f) => f.type === "result")).toBe(true));
    expect(s.sent.find((f) => f.type === "result")).toMatchObject({ id: "9", ok: false });
    c.stop();
  });

  it("denied 를 받으면 재연결하지 않는다", async () => {
    const connect = vi.fn(() => fakeSocket().sock);
    const c = startWorkerClient({ connect, token: "t", userId: "owner", roots: ["/w"], executors, retryDelayMs: 5 });
    const first = connect.mock.results[0].value as ClientSocket;
    let onMsg: ((raw: string) => void) | undefined;
    first.onMessage = (cb) => { onMsg = cb; };
    c.stop();
    expect(connect).toHaveBeenCalledTimes(1);
    expect(onMsg).toBeUndefined();
  });

  it("연결이 끊기면 재연결을 시도한다", async () => {
    const sockets: ReturnType<typeof fakeSocket>[] = [];
    const connect = () => { const s = fakeSocket(); sockets.push(s); return s.sock; };
    const c = startWorkerClient({ connect, token: "t", userId: "owner", roots: ["/w"], executors, retryDelayMs: 5 });
    sockets[0].open();
    sockets[0].drop();
    await vi.waitFor(() => expect(sockets.length).toBeGreaterThan(1));
    c.stop();
  });

  it("stop 후에는 재연결하지 않는다", async () => {
    const sockets: ReturnType<typeof fakeSocket>[] = [];
    const connect = () => { const s = fakeSocket(); sockets.push(s); return s.sock; };
    const c = startWorkerClient({ connect, token: "t", userId: "owner", roots: ["/w"], executors, retryDelayMs: 5 });
    sockets[0].open();
    c.stop();
    sockets[0].drop();
    await new Promise((r) => setTimeout(r, 40));
    expect(sockets.length).toBe(1);
  });
});
```

- [ ] **Step 2: 실패 확인**

```bash
cd agent && npx vitest run tests/remoteWorkerClient.test.ts
```

기대: FAIL — `startWorkerClient` 없음.

- [ ] **Step 3: 구현**

`agent/src/remote/workerClient.ts` 를 새로 만든다.

```ts
import { encodeFrame, parseFrame } from "./protocol.js";
import type { Executors } from "./executors.js";

// 실제 WebSocket 을 감싸는 최소 인터페이스(허브의 HubSocket 과 대칭). onOpen 이 추가로 필요한 건
// 클라이언트가 연결 직후 hello 를 먼저 보내야 하기 때문이다.
export type ClientSocket = {
  send(data: string): void;
  close(): void;
  onMessage(cb: (raw: string) => void): void;
  onClose(cb: () => void): void;
  onOpen(cb: () => void): void;
};

export type WorkerClientOpts = {
  connect: () => ClientSocket;
  token: string;
  userId: string;
  roots: string[];
  executors: Executors;
  onStatus?: (s: string) => void;
  retryDelayMs?: number;
};

const DEFAULT_RETRY_MS = 3000;

export function startWorkerClient(opts: WorkerClientOpts): { stop(): void } {
  const retryDelayMs = opts.retryDelayMs ?? DEFAULT_RETRY_MS;
  const status = opts.onStatus ?? (() => {});
  let stopped = false;
  let denied = false;
  let current: ClientSocket | null = null;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;

  const open = () => {
    if (stopped || denied) return;
    const socket = opts.connect();
    current = socket;

    socket.onOpen(() => {
      status("연결됨 — 인증 중");
      socket.send(encodeFrame({ type: "hello", token: opts.token, userId: opts.userId, roots: opts.roots }));
    });

    socket.onMessage((raw) => {
      const frame = parseFrame(raw);
      if (!frame) return; // 형식이 깨진 프레임은 무시한다(허브와 달리 끊지 않는다 — 재연결 폭풍 방지)
      if (frame.type === "ready") { status("준비됨"); return; }
      if (frame.type === "denied") {
        // 인증 거부는 재시도해도 결과가 같다. 재연결을 멈추고 사람이 설정을 고치게 한다.
        denied = true;
        status(`거부됨: ${frame.reason}`);
        socket.close();
        return;
      }
      if (frame.type === "ping") { socket.send(encodeFrame({ type: "pong" })); return; }
      if (frame.type !== "call") return;

      const exec = opts.executors[frame.tool];
      const run = exec
        ? exec(frame.args).catch((err) => ({ ok: false, content: `실행 중 오류: ${String(err)}` }))
        : Promise.resolve({ ok: false, content: `모르는 도구예요: ${frame.tool}` });
      void run.then((r) => {
        socket.send(encodeFrame({ type: "result", id: frame.id, ok: r.ok, content: r.content }));
      });
    });

    socket.onClose(() => {
      if (current !== socket) return;
      current = null;
      if (stopped || denied) return;
      status("연결이 끊겨 재시도합니다");
      retryTimer = setTimeout(open, retryDelayMs);
    });
  };

  open();

  return {
    stop() {
      stopped = true;
      if (retryTimer) clearTimeout(retryTimer);
      current?.close();
      current = null;
    },
  };
}
```

- [ ] **Step 4: 통과 확인**

```bash
cd agent && npx vitest run tests/remoteWorkerClient.test.ts
```

기대: PASS (전부)

- [ ] **Step 5: 전체 테스트 + 타입 확인**

```bash
cd agent && npm test && npx tsc --noEmit
```

기대: 0 failed, 1 skipped. tsc 클린.

- [ ] **Step 6: 커밋**

```bash
git add agent/src/remote/workerClient.ts agent/tests/remoteWorkerClient.test.ts
git commit -m "feat(remote): 워커 WS 클라이언트(재연결·실행기 디스패치)"
```

---

### Task 6: 원격 MCP 도구 + 능력 계층

**Files:**
- Create: `agent/src/core/remoteTools.ts`
- Modify: `agent/src/core/tools.ts`
- Test: `agent/tests/remoteTools.test.ts`, `agent/tests/tools.test.ts`

**Interfaces:**
- Consumes: `WorkerHub.call/isConnected` (Task 4)
- Produces:
  - `REMOTE_TOOL_NAMES: readonly string[]` — `["fs_read","fs_write","fs_edit","fs_glob","fs_grep","sh_exec"]`
  - `remoteToolHandler(ctx: ToolCtx, tool: string, args: Record<string, unknown>): Promise<string>`
  - `ToolCtx` 에 `remote?: { call(tool: string, args: Record<string, unknown>): Promise<{ ok: boolean; content: string }> }` 추가
  - `allowedToolsFor(role, isPrivate, isOwner, deployTarget?, ownWorkstation?, workerConnected?)` — 마지막 인자 추가(기본 `false`)

- [ ] **Step 1: 실패하는 테스트 작성**

`agent/tests/remoteTools.test.ts` 를 새로 만든다.

```ts
import { describe, it, expect } from "vitest";
import { REMOTE_TOOL_NAMES, remoteToolHandler } from "../src/core/remoteTools.js";
import type { ToolCtx } from "../src/core/tools.js";

const ctxWith = (call: ToolCtx["remote"]): ToolCtx => ({ remote: call } as unknown as ToolCtx);

describe("원격 도구", () => {
  it("도구 이름 6개를 고정으로 노출한다", () => {
    expect([...REMOTE_TOOL_NAMES].sort()).toEqual(["fs_edit", "fs_glob", "fs_grep", "fs_read", "fs_write", "sh_exec"]);
  });

  it("허브 호출 결과를 그대로 문자열로 돌려준다", async () => {
    const ctx = ctxWith({ call: async () => ({ ok: true, content: "본문" }) });
    expect(await remoteToolHandler(ctx, "fs_read", { path: "/w/a" })).toBe("본문");
  });

  it("실패해도 예외를 던지지 않고 내용을 돌려준다(턴이 죽지 않게)", async () => {
    const ctx = ctxWith({ call: async () => ({ ok: false, content: "폴더 밖 경로예요" }) });
    await expect(remoteToolHandler(ctx, "fs_read", { path: "/x" })).resolves.toContain("폴더 밖");
  });

  it("워커 연결이 없으면 안내 문구를 돌려준다", async () => {
    const ctx = ctxWith(undefined);
    await expect(remoteToolHandler(ctx, "fs_read", {})).resolves.toContain("워커");
  });

  it("호출한 도구 이름과 인자를 그대로 허브에 전달한다", async () => {
    const seen: Array<{ tool: string; args: Record<string, unknown> }> = [];
    const ctx = ctxWith({ call: async (tool, args) => { seen.push({ tool, args }); return { ok: true, content: "" }; } });
    await remoteToolHandler(ctx, "sh_exec", { command: "ls" });
    expect(seen).toEqual([{ tool: "sh_exec", args: { command: "ls" } }]);
  });
});

describe("봇 쪽 1차 경로 필터", () => {
  const withDirs = (dirs: string[], call: ToolCtx["remote"]): ToolCtx =>
    ({ remote: call, userId: "owner", repos: { allowedDirs: { list: async () => dirs } } } as unknown as ToolCtx);

  it("allowed_dirs 밖 경로는 허브를 부르지 않고 거부한다", async () => {
    let called = false;
    const ctx = withDirs(["/w/proj"], { call: async () => { called = true; return { ok: true, content: "" }; } });
    const out = await remoteToolHandler(ctx, "fs_read", { path: "/etc/passwd" });
    expect(called).toBe(false);
    expect(out).toContain("허용");
  });

  it("allowed_dirs 안 경로는 통과시킨다", async () => {
    const ctx = withDirs(["/w/proj"], { call: async () => ({ ok: true, content: "본문" }) });
    await expect(remoteToolHandler(ctx, "fs_read", { path: "/w/proj/a.txt" })).resolves.toBe("본문");
  });

  it("allowed_dirs 가 비어 있으면 등록을 안내한다", async () => {
    const ctx = withDirs([], { call: async () => ({ ok: true, content: "" }) });
    await expect(remoteToolHandler(ctx, "fs_read", { path: "/w/a" })).resolves.toContain("allow_dir");
  });

  it("경로 인자가 없는 sh_exec 는 1차 필터를 건너뛴다(워커가 판정)", async () => {
    const ctx = withDirs(["/w/proj"], { call: async () => ({ ok: true, content: "출력" }) });
    await expect(remoteToolHandler(ctx, "sh_exec", { command: "ls" })).resolves.toBe("출력");
  });
});
```

`agent/tests/tools.test.ts` 끝에 능력 계층 테스트를 추가한다.

```ts
describe("allowedToolsFor — 원격 도구 노출", () => {
  const RT = "mcp__asahi__fs_read";
  const SH = "mcp__asahi__sh_exec";

  it("워커가 연결돼 있으면 소유자 DM 에 원격 도구를 연다(local·cloud 동일)", () => {
    for (const target of ["local", "cloud"] as const) {
      const tools = allowedToolsFor("owner", true, true, target, false, true);
      expect(tools).toContain(RT);
      expect(tools).toContain(SH);
    }
  });

  it("워커가 없으면 원격 도구를 노출하지 않는다", () => {
    for (const target of ["local", "cloud"] as const) {
      const tools = allowedToolsFor("owner", true, true, target, false, false);
      expect(tools).not.toContain(RT);
      expect(tools).not.toContain(SH);
    }
  });

  it("workerConnected 를 생략하면 노출하지 않는다(안전한 기본값)", () => {
    expect(allowedToolsFor("owner", true, true, "local")).not.toContain(RT);
  });

  it("손님 DM·서버 채널에는 워커가 연결돼 있어도 노출하지 않는다(1단계는 소유자 전용)", () => {
    expect(allowedToolsFor("allowed", true, false, "local", false, true)).not.toContain(RT);
    expect(allowedToolsFor("allowed", false, false, "local", false, true)).not.toContain(RT);
  });

  it("기억·접근관리 도구는 워커 연결 여부와 무관하다", () => {
    const off = allowedToolsFor("owner", true, true, "cloud", false, false);
    const on = allowedToolsFor("owner", true, true, "cloud", false, true);
    for (const t of ["mcp__asahi__remember", "mcp__asahi__recall", "mcp__asahi__manage_access"]) {
      expect(off).toContain(t);
      expect(on).toContain(t);
    }
  });
});
```

- [ ] **Step 2: 실패 확인**

```bash
cd agent && npx vitest run tests/remoteTools.test.ts tests/tools.test.ts
```

기대: FAIL — `remoteTools.js` 없음, `allowedToolsFor` 가 6번째 인자를 모름.

- [ ] **Step 3: 구현 — `agent/src/core/remoteTools.ts` 신규**

```ts
import { isPathWithinAny } from "./paths.js";
import type { ToolCtx } from "./tools.js";

// 워커에서 실행되는 원격 도구 이름. SDK 내장 Read/Write/Edit/Glob/Grep/Bash 를 대체한다.
// 이름을 달리 지은 이유: 내장 도구와 이름이 겹치면 어느 쪽이 도는지 알 수 없다.
export const REMOTE_TOOL_NAMES = ["fs_read", "fs_write", "fs_edit", "fs_glob", "fs_grep", "sh_exec"] as const;

// 인자에서 1차 필터를 걸 경로를 뽑는다. sh_exec 는 경로 인자가 없으므로 대상이 아니다
// (셸은 애초에 경로 판정이 성립하지 않는다 — 워커 루트가 유일한 방어선이다).
function pathArgOf(args: Record<string, unknown>): string | undefined {
  const p = args.path;
  return typeof p === "string" && p.length > 0 ? p : undefined;
}

// 원격 호출은 실패해도 예외를 던지지 않는다 — 도구 하나의 실패가 턴 전체를 죽이면
// 모델이 다른 방법을 시도하거나 사용자에게 알릴 기회 자체가 사라진다.
//
// 경로 검사는 두 겹이다. 여기(봇)는 사용자가 allow_dir 로 관리하는 목록에 대한 1차 필터로,
// 왕복 전에 빠르게 거르고 안내 문구를 낸다. 최종 판정은 워커(remote/roots.ts)가 한다 —
// realpath·심볼릭 링크·실제 존재 여부를 아는 건 파일시스템을 가진 그쪽뿐이다.
export async function remoteToolHandler(
  ctx: ToolCtx,
  tool: string,
  args: Record<string, unknown>,
): Promise<string> {
  if (!ctx.remote) return "지금은 워커가 연결돼 있지 않아 PC 작업을 할 수 없어요.";

  const target = pathArgOf(args);
  if (target !== undefined) {
    const allowed = await ctx.repos.allowedDirs.list(ctx.userId);
    if (allowed.length === 0) return "먼저 allow_dir 로 작업할 폴더를 허용해 주세요.";
    if (!isPathWithinAny(target, allowed)) return `허용된 폴더 밖 경로예요: ${target}`;
  }

  const r = await ctx.remote.call(tool, args);
  return r.content.length > 0 ? r.content : (r.ok ? "(완료)" : "(실패했지만 내용이 없어요)");
}
```

- [ ] **Step 4: 구현 — `agent/src/core/tools.ts` 수정**

`ToolCtx` 타입에 필드를 추가한다(`runtime` 아래).

```ts
  // 원격 워커 호출 통로. 워커가 연결돼 있을 때만 주입된다(index.ts 배선).
  remote?: { call(tool: string, args: Record<string, unknown>): Promise<{ ok: boolean; content: string }> };
```

`allowedToolsFor` 시그니처에 인자를 추가하고 소유자 DM 두 분기에 원격 도구를 넣는다. 나머지 분기는 그대로 둔다.

```ts
export function allowedToolsFor(
  role: Role,
  isPrivate: boolean,
  isOwner: boolean,
  deployTarget: "local" | "cloud" = "local",
  ownWorkstation = false,
  workerConnected = false,
): string[] {
  // 원격 도구는 워커 연결이 있을 때만 연다. 판정 축이 "어디서 실행 중인가"(deployTarget)가 아니라
  // "워커가 붙어 있는가"로 바뀐 것이 이 단계의 핵심이다 — cloud 에서도 워커만 붙으면 PC 작업이 된다.
  const remote = workerConnected ? REMOTE_TOOL_NAMES.map((n) => t(n)) : [];
  if (isOwner && isPrivate) {
    return [
      ...remote,
      t("remember"), t("recall"), t("character_fact"), t("manage_access"),
      t("allow_dir"), t("revoke_dir"), t("list_dirs"),
      t("db_schema"), t("db_query"), t("runtime_info"),
    ];
  }
  if (ownWorkstation && isPrivate && deployTarget !== "cloud") {
    return [
      t("remember"), t("recall"), t("character_fact"),
      t("allow_dir"), t("revoke_dir"), t("list_dirs"),
    ];
  }
  if (isPrivate && (role === "owner" || role === "allowed")) return [t("remember"), t("recall"), t("character_fact")];
  return [t("recall")];
}
```

파일 상단에 임포트를 추가한다.

```ts
import { REMOTE_TOOL_NAMES, remoteToolHandler } from "./remoteTools.js";
```

`buildTools` 의 `tools:` 배열 끝에 원격 도구 6개를 등록한다.

```ts
      tool(
        "fs_read",
        "워커 PC 의 파일을 읽습니다. offset(1부터)·limit 로 일부만 읽을 수 있습니다.",
        { path: z.string().describe("읽을 파일의 절대경로"), offset: z.number().optional().describe("시작 줄(1부터)"), limit: z.number().optional().describe("읽을 줄 수") },
        async (args) => textResult(await remoteToolHandler(ctx, "fs_read", args)),
      ),
      tool(
        "fs_write",
        "워커 PC 에 파일을 씁니다. 상위 폴더가 없으면 만듭니다. 기존 파일은 덮어씁니다.",
        { path: z.string().describe("쓸 파일의 절대경로"), content: z.string().describe("파일 전체 내용") },
        async (args) => textResult(await remoteToolHandler(ctx, "fs_write", args)),
      ),
      tool(
        "fs_edit",
        "워커 PC 의 파일에서 문자열을 치환합니다. 여러 번 등장하면 replaceAll 이 필요합니다.",
        { path: z.string().describe("고칠 파일의 절대경로"), oldString: z.string().describe("찾을 문자열"), newString: z.string().describe("바꿀 문자열"), replaceAll: z.boolean().optional().describe("전부 바꿀지 여부") },
        async (args) => textResult(await remoteToolHandler(ctx, "fs_edit", args)),
      ),
      tool(
        "fs_glob",
        "워커 PC 에서 glob 패턴으로 파일을 찾습니다.",
        { pattern: z.string().describe("예: **/*.ts"), path: z.string().optional().describe("기준 폴더의 절대경로") },
        async (args) => textResult(await remoteToolHandler(ctx, "fs_glob", args)),
      ),
      tool(
        "fs_grep",
        "워커 PC 의 파일 내용에서 정규식으로 검색합니다.",
        { pattern: z.string().describe("찾을 정규식"), path: z.string().optional().describe("기준 폴더의 절대경로"), glob: z.string().optional().describe("검색 대상 파일 패턴") },
        async (args) => textResult(await remoteToolHandler(ctx, "fs_grep", args)),
      ),
      tool(
        "sh_exec",
        "워커 PC 에서 셸 명령을 실행합니다. 강력한 도구이니 신중히 쓰세요.",
        { command: z.string().describe("실행할 셸 명령"), timeoutMs: z.number().optional().describe("타임아웃(밀리초)") },
        async (args) => textResult(await remoteToolHandler(ctx, "sh_exec", args)),
      ),
```

- [ ] **Step 5: 통과 확인**

```bash
cd agent && npx vitest run tests/remoteTools.test.ts tests/tools.test.ts
```

기대: PASS (전부). 기존 `allowedToolsFor` 테스트가 정확 배열 비교(`toEqual`)를 쓴다면 원격 도구가 추가된 소유자 DM 분기에서 깨진다 — 그 배열에 원격 도구 6개를 반영하되, **`workerConnected` 를 넘기지 않는 기존 호출은 기본값 `false` 라 배열이 그대로여야 한다.** 깨진다면 인자 기본값을 잘못 넣은 것이니 테스트가 아니라 구현을 고칠 것.

- [ ] **Step 6: 전체 테스트 + 타입 확인**

```bash
cd agent && npm test && npx tsc --noEmit
```

기대: 0 failed, 1 skipped. tsc 클린.

- [ ] **Step 7: 커밋**

```bash
git add agent/src/core/remoteTools.ts agent/src/core/tools.ts agent/tests/remoteTools.test.ts agent/tests/tools.test.ts
git commit -m "feat(core): 원격 MCP 도구 6종 + 워커 연결 기반 능력 계층"
```

---

### Task 7: 배선 — 설정 · Railway 서버 · 워커 재작성

**Files:**
- Modify: `agent/src/config.ts`
- Modify: `agent/src/index.ts`
- Rewrite: `agent/src/worker.ts`
- Modify: `agent/src/core/agent.ts`
- Modify: `.env.example`
- Test: `agent/tests/config.test.ts`

**Interfaces:**
- Consumes: `WorkerHub` (Task 4), `startWorkerClient`/`ClientSocket` (Task 5), `makeExecutors` (Task 3), `REMOTE_TOOL_NAMES` (Task 6)
- Produces:
  - `Config` 에 `workerToken: string`, `httpPort: number` 추가
  - `WorkerConfig` 에 `workerToken: string`, `hubUrl: string`, `roots: string[]` 추가 (`databaseUrl`·`model` 제거)

- [ ] **Step 1: 실패하는 테스트 작성**

`agent/tests/config.test.ts` 에 추가한다.

```ts
describe("얇은 워커 설정", () => {
  const base = { DATABASE_URL: "postgres://x", DISCORD_TOKEN: "d", DISCORD_OWNER_ID: "o" };

  it("봇 설정에 WORKER_TOKEN 과 PORT 가 실린다", () => {
    const c = loadConfig({ ...base, WORKER_TOKEN: "wt", PORT: "8080" } as NodeJS.ProcessEnv);
    expect(c.workerToken).toBe("wt");
    expect(c.httpPort).toBe(8080);
  });

  it("PORT 를 생략하면 기본값 3000", () => {
    expect(loadConfig({ ...base, WORKER_TOKEN: "wt" } as NodeJS.ProcessEnv).httpPort).toBe(3000);
  });

  it("워커 설정은 DATABASE_URL 이 아니라 HUB_URL·WORKER_TOKEN·WORKER_ROOTS 를 요구한다", () => {
    const w = loadWorkerConfig({
      DISCORD_OWNER_ID: "o", WORKER_USER_ID: "o",
      HUB_URL: "wss://h/worker", WORKER_TOKEN: "wt", WORKER_ROOTS: "/a,/b",
    } as NodeJS.ProcessEnv);
    expect(w.hubUrl).toBe("wss://h/worker");
    expect(w.workerToken).toBe("wt");
    expect(w.roots).toEqual(["/a", "/b"]);
    expect(w).not.toHaveProperty("databaseUrl");
  });

  it("워커 설정에서 필수값이 빠지면 시작 시점에 실패한다", () => {
    expect(() => loadWorkerConfig({ DISCORD_OWNER_ID: "o", WORKER_USER_ID: "o" } as NodeJS.ProcessEnv)).toThrow(/HUB_URL|WORKER_TOKEN|WORKER_ROOTS/);
  });
});
```

- [ ] **Step 2: 실패 확인**

```bash
cd agent && npx vitest run tests/config.test.ts
```

기대: FAIL — `workerToken`·`hubUrl` 없음.

- [ ] **Step 3: `agent/src/config.ts` 수정**

`Config` 타입에 두 필드를 추가하고 `loadConfig` 반환에 채운다.

```ts
  workerToken: string;   // 워커 인증 토큰(WORKER_TOKEN). 워커 쪽과 같은 값이어야 한다.
  httpPort: number;      // 워커 허브 WS 를 붙일 HTTP 포트. Railway 는 PORT 를 주입한다.
```

```ts
    workerToken: env.WORKER_TOKEN || "",
    httpPort: positiveNumberEnv(env, "PORT", 3000),
```

`WorkerConfig` 를 아래로 교체한다. **`databaseUrl`·`model`·`dataDir`·`memoryDir`·`sessionIdleMinutes` 를 전부 뺀다** — 워커는 DB도 모델도 세션도 다루지 않는다.

```ts
export type WorkerConfig = {
  ownerId: string;       // DISCORD_OWNER_ID — hello 로 보낼 신원
  workerUserId: string;  // WORKER_USER_ID — 이 워커가 담당하는 사용자
  workerToken: string;   // WORKER_TOKEN — 허브 인증
  hubUrl: string;        // HUB_URL — Railway 허브 WebSocket 주소(wss://.../worker)
  roots: string[];       // WORKER_ROOTS — 이 워커가 노출할 폴더(쉼표 구분). 최종 경로 관문의 기준
};

export function loadWorkerConfig(env: NodeJS.ProcessEnv = process.env): WorkerConfig {
  const missing = ["DISCORD_OWNER_ID", "WORKER_USER_ID", "WORKER_TOKEN", "HUB_URL", "WORKER_ROOTS"].filter((k) => !env[k]);
  if (missing.length > 0) {
    throw new Error(`환경변수 누락: ${missing.join(", ")} — .env 파일을 확인하세요 (.env.example 참고)`);
  }
  const roots = (env.WORKER_ROOTS as string).split(",").map((s) => s.trim()).filter((s) => s.length > 0);
  if (roots.length === 0) throw new Error("WORKER_ROOTS 에 폴더가 하나도 없습니다.");
  return {
    ownerId: env.DISCORD_OWNER_ID as string,
    workerUserId: env.WORKER_USER_ID as string,
    workerToken: env.WORKER_TOKEN as string,
    hubUrl: env.HUB_URL as string,
    roots,
  };
}
```

- [ ] **Step 4: `agent/src/index.ts` 수정 — 허브 기동**

임포트를 추가한다.

```ts
import http from "node:http";
import { WebSocketServer } from "ws";
import { WorkerHub, type HubSocket } from "./remote/hub.js";
```

`const bus = new EventBus();` 앞에 허브와 HTTP 서버를 세운다.

```ts
  // 워커 허브: 워커가 아웃바운드로 붙는 유일한 표면. 토큰 인증을 통과하지 못하면 즉시 끊는다.
  const hub = new WorkerHub({ token: config.workerToken, ownerId: config.ownerId });
  const httpServer = http.createServer((_req, res) => { res.writeHead(200); res.end("ok"); });
  const wss = new WebSocketServer({ server: httpServer, path: "/worker" });
  wss.on("connection", (ws) => {
    // ws → HubSocket 어댑터. 허브는 ws 를 직접 알지 못한다(테스트 가능성 유지).
    const socket: HubSocket = {
      send: (d) => ws.send(d),
      close: () => ws.close(),
      onMessage: (cb) => ws.on("message", (data) => cb(data.toString())),
      onClose: (cb) => ws.on("close", cb),
    };
    hub.handleConnection(socket);
  });
  httpServer.listen(config.httpPort, () => console.log(`워커 허브 대기 중: 포트 ${config.httpPort}`));
```

`runTurn` 생성 줄을 `hub` 를 넘기도록 바꾼다.

```ts
  const runTurn = makeRunAgentTurn({ memories: repos.memories, users: repos.users, allowedDirs: repos.allowedDirs, introspect: repos.introspect }, config.deployTarget, config.model, hub);
```

`shutdown` 에 정리를 추가한다(`await db.end();` 앞).

```ts
    hub.closeAll();
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
```

- [ ] **Step 5: `agent/src/core/agent.ts` 수정 — 허브 주입 · 내장 도구 제거**

`makeRunAgentTurn` 시그니처에 허브를 받는다.

```ts
export function makeRunAgentTurn(
  repos: ToolRepos,
  deployTarget: "local" | "cloud" = "local",
  model: string = DEFAULT_MODEL,
  hub?: { isConnected(userId: string): boolean; call(userId: string, tool: string, args: Record<string, unknown>): Promise<{ ok: boolean; content: string }> },
): TurnRunner {
```

`const ctx: ToolCtx = buildToolCtx(...)` 줄 다음에 원격 통로를 붙이고, `allowedTools` 계산에 연결 여부를 넘긴다.

```ts
    const workerConnected = hub?.isConnected(req.context.userId) === true;
    if (workerConnected && hub) {
      ctx.remote = { call: (tool, args) => hub.call(req.context.userId, tool, args) };
    }
    const allowedTools = allowedToolsFor(req.context.role, req.context.isPrivate, req.context.isOwner, deployTarget, req.context.ownWorkstation, workerConnected);
```

`preApprovedTools`·`builtinTools`·`canUseTool`·`additionalDirectories` 블록을 아래로 교체한다. 내장 파일·Bash 도구를 쓰지 않으므로 경로 게이팅 `canUseTool` 이 필요 없어진다 — 경로 판정은 워커가 한다.

```ts
    // 원격 도구는 전부 mcp__asahi__* 이므로 bare 사전승인으로 두고, 내장 파일/Bash 도구는 아예 열지 않는다.
    // 경로 검사는 워커(remote/roots.ts)가 최종 권한을 갖는다.
    const preApprovedTools = allowedTools;
    const builtinTools: string[] = [];
```

`query({ options })` 에서 `canUseTool`·`additionalDirectories` 를 제거하고 `tools: builtinTools` 는 그대로 둔다(빈 배열이 내장 도구를 전부 닫는다).

`canUseTool` 을 지우면 `decidePathPermission`·`isPathGatedTool`·`extractCandidatePaths`·
`resolveRealOrNearestAncestor` 임포트와 `CanUseTool` 타입 임포트가 전부 미사용이 된다. **임포트 줄을
지운다** — 남겨두면 `tsc` 설정에 따라 에러가 나고, 아니더라도 죽은 참조가 된다.

`pathPermission.ts` 자체는 지우지 마라. `resolveRealOrNearestAncestor` 를 `remote/roots.ts` 가
여전히 쓴다. 나머지 세 함수(`decidePathPermission`·`isPathGatedTool`·`extractCandidatePaths`)는
이 시점부터 프로덕션 코드에서 호출되지 않지만, 2단계에서 다시 쓸 여지가 있으므로 그대로 둔다 —
`pathPermission.test.ts` 도 유지한다.

- [ ] **Step 6: `agent/src/worker.ts` 전면 재작성**

파일 전체를 아래로 교체한다. DB·SDK·폴링·하트비트가 전부 사라진다.

```ts
import path from "node:path";
import dotenv from "dotenv";
import { loadWorkerConfig } from "./config.js";
import { makeExecutors } from "./remote/executors.js";
import { startWorkerClient, type ClientSocket } from "./remote/workerClient.js";

// 로컬 워커(1단계 얇은 워커): 디스코드에도 DB에도 붙지 않고, Railway 허브로 아웃바운드
// WebSocket 을 열어 도구 호출만 받아 실행한다. 판단·기억·세션은 전부 허브(봇) 쪽에 있다.
// 이 프로세스가 가진 자격증명은 WORKER_TOKEN 하나뿐이다.

dotenv.config({ path: path.resolve("..", ".env") });
dotenv.config();

function main() {
  const config = loadWorkerConfig();
  const executors = makeExecutors(config.roots);

  // 전역 WebSocket(Node 22 내장)을 ClientSocket 으로 감싼다 — 클라이언트 로직은 WebSocket 을 모른다.
  const connect = (): ClientSocket => {
    const ws = new WebSocket(config.hubUrl);
    return {
      send: (d) => ws.send(d),
      close: () => ws.close(),
      onMessage: (cb) => ws.addEventListener("message", (e) => cb(String((e as MessageEvent).data))),
      onClose: (cb) => ws.addEventListener("close", () => cb()),
      onOpen: (cb) => ws.addEventListener("open", () => cb()),
    };
  };

  const client = startWorkerClient({
    connect,
    token: config.workerToken,
    userId: config.workerUserId,
    roots: config.roots,
    executors,
    onStatus: (s) => console.log(`[worker] ${s}`),
  });

  const shutdown = () => {
    console.log("워커 종료 중...");
    client.stop();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  console.log(`로컬 워커가 시작되었습니다 (허브=${config.hubUrl}, 폴더=${config.roots.join(", ")}).`);
}

main();
```

- [ ] **Step 7: `.env.example` 갱신**

워커 항목을 아래로 교체하고 봇 항목에 두 줄을 추가한다.

```
# 워커 허브(봇) — 워커가 붙을 포트. Railway 가 PORT 를 주입하므로 보통 비워둔다.
PORT=3000
# 워커 인증 토큰. 봇과 워커 양쪽에 같은 값을 넣는다. 아무 긴 무작위 문자열이면 된다.
WORKER_TOKEN=

# ── 로컬 워커 전용 ──
# 허브 WebSocket 주소. Railway 도메인 뒤에 /worker 를 붙인다.
HUB_URL=wss://<your-app>.up.railway.app/worker
# 이 워커가 담당할 디스코드 사용자 ID(1단계는 소유자 본인)
WORKER_USER_ID=
# 이 워커가 노출할 폴더(쉼표 구분, 절대경로). 여기 밖은 워커가 거부한다.
WORKER_ROOTS=
```

`DATABASE_URL` 은 봇 항목에 그대로 둔다 — 워커는 더 이상 쓰지 않지만 봇은 여전히 필요하다.

- [ ] **Step 8: 통과 확인**

```bash
cd agent && npx vitest run tests/config.test.ts && npx tsc --noEmit
```

기대: config 테스트 PASS. tsc 클린.

`tsc` 가 `worker/jobRunner.ts` 나 `core.ts` 의 위임 코드에서 에러를 내면 그건 Task 8 에서 지운다 — 이 태스크에서는 `worker.ts`·`index.ts`·`agent.ts`·`config.ts` 만 클린하면 된다. 에러가 그 네 파일에 있으면 이 태스크의 문제다.

- [ ] **Step 9: 커밋**

```bash
git add agent/src/config.ts agent/src/index.ts agent/src/worker.ts agent/src/core/agent.ts agent/tests/config.test.ts .env.example
git commit -m "feat(remote): 허브 기동 배선 + 워커를 얇은 클라이언트로 재작성"
```

---

### Task 8: 위임 기계장치 삭제

**Files:**
- Delete: `agent/src/worker/jobRunner.ts`, `agent/tests/workerJobRunner.test.ts`
- Modify: `agent/src/core/core.ts`, `agent/src/index.ts`, `agent/src/store/jobsRepo.ts`, `agent/src/store/schema.ts`
- Test: `agent/tests/coreMulti.test.ts`, `agent/tests/progress.test.ts`, `agent/tests/discordProgress.test.ts`, `agent/tests/jobsRepo.test.ts`

**Interfaces:**
- Consumes: 없음
- Produces: 없음 (순수 삭제)

`worker_jobs` **테이블은 남긴다**(DDL 변경 금지). `schema.ts` 주석으로 미사용임을 밝힌다.

- [ ] **Step 1: `core.ts` 에서 위임 경로 제거**

- `delegateToWorker` 메서드 전체 삭제
- `deliverPendingJobResults` 메서드 전체 삭제
- `ingest` 안의 위임 분기(`if (images.length === 0 && isOwner && conv.isPrivate && await this.repos.jobs.isOnline(...))` 블록) 삭제 — 이제 모든 턴이 봇에서 실행된다
- `WORKER_ONLINE_CUTOFF_MS`, `WORKER_POLL_MS`, `WORKER_TIMEOUT_MS` 상수와 `workerPollMs`/`workerTimeoutMs` 필드·생성자 인자 삭제
- `AgentCore` 의 repos 타입에서 `jobs` 제거

- [ ] **Step 2: `index.ts` 에서 job 스윕 제거**

- `await core.deliverPendingJobResults().catch(...)` (부팅 시 1회) 삭제
- 유휴 타이머 안의 `void core.deliverPendingJobResults().catch(...)` 삭제
- `JobsRepo` 임포트와 `repos.jobs` 조립 삭제

- [ ] **Step 3: `jobsRepo.ts` 정리**

파일 전체를 삭제하지 말고, 쓰이지 않게 된 메서드를 지운다. 남는 게 없으면 파일을 삭제하고 `agent/tests/jobsRepo.test.ts` 도 함께 삭제한다.

`schema.ts` 의 `worker_jobs` 테이블 정의 위에 주석을 추가한다.

```sql
-- 미사용(2026-07 얇은 워커 전환). 워커가 비동기 2차 에이전트였을 때의 작업 큐다.
-- 테이블은 마이그레이션 위험을 피해 남겨두었으나 코드는 더 이상 읽고 쓰지 않는다.
```

- [ ] **Step 4: 파일 삭제**

```bash
cd agent && rm src/worker/jobRunner.ts tests/workerJobRunner.test.ts && rmdir src/worker 2>/dev/null; true
```

- [ ] **Step 5: 깨진 테스트 정리**

```bash
cd agent && npm test
```

위임을 검증하던 테스트가 깨진다. 각각을 확인해 **위임 자체를 검증하는 테스트는 삭제**하고, **위임과 무관한 검증은 남긴다.** 특히:

- `coreMulti.test.ts` — 위임 분기 테스트 삭제. 한도·프라이버시·직렬화 테스트는 유지
- `progress.test.ts` / `discordProgress.test.ts` — job 진행 폴링 기반 케이스 삭제. SDK `onProgress` 기반 케이스는 유지

테스트를 지울 때는 그 테스트가 지키던 불변식이 다른 곳에서도 검증되는지 확인할 것. 아니면 삭제 대신 새 구조에 맞게 고쳐 쓸 것.

- [ ] **Step 6: 전체 확인**

```bash
cd agent && npm test && npx tsc --noEmit
```

기대: 0 failed, 1 skipped. tsc 클린.

- [ ] **Step 7: 커밋**

```bash
git add -A agent
git commit -m "refactor: 위임 기계장치(worker_jobs) 제거 — 얇은 워커로 대체"
```

---

### Task 9: 문서 갱신

**Files:**
- Modify: `docs/security/capability-model.md`
- Modify: `docs/architecture/module-boundaries.md`
- Modify: `docs/architecture/overview.md`
- Modify: `deploy/worker-셋업.md`
- Modify: `deploy/smoke-test.md`
- Modify: `docs/status/STATUS.md`

- [ ] **Step 1: `capability-model.md`**

능력 계층표의 소유자 DM 두 행에서 파일 도구·Bash 를 원격 도구 이름(`fs_read` 등)으로 바꾸고,
"워커 연결이 있을 때만"이라는 조건을 명시한다. cloud 행이 이제 워커만 붙으면 PC 작업이 가능하다는
사실을 반영한다.

"경로 게이팅" 절을 다시 쓴다 — `canUseTool` 기반 설명을 두 겹 구조(봇 `allowed_dirs` 1차 필터 →
워커 `WORKER_ROOTS` 최종 판정)로 교체한다.

"보안-핵심 파일 목록"에 `agent/src/remote/roots.ts`(워커 최종 경로 관문)와
`agent/src/remote/hub.ts`(토큰 인증·연결 등록)를 추가한다.

- [ ] **Step 2: `module-boundaries.md`**

디렉토리 책임표에 `remote/` 행을 추가한다.

```
| `remote/` | 봇↔워커 WebSocket 전송 계층. `protocol.ts`(양쪽 공유 계약)·`hub.ts`(봇 쪽 서버)·`workerClient.ts`/`executors.ts`/`roots.ts`(워커 쪽). `core/` 의 순수 경로 헬퍼만 재사용하고 `discord.js`·`store/` 에는 의존하지 않는다 | `protocol.ts`, `hub.ts`, `workerClient.ts`, `executors.ts`, `roots.ts` |
```

`worker/` 행을 삭제한다(디렉토리가 사라졌다). 두 진입점 설명에서 워커가 `core`+`store` 를 조립한다는
서술을 "워커는 `remote/` 만 조립하며 `store`·`events`·`adapters` 에 의존하지 않는다"로 고친다.

- [ ] **Step 3: `overview.md`**

3-프로세스 토폴로지에서 워커가 Supabase 에 직접 붙는 화살표를 지우고, 워커↔봇 WebSocket 으로
바꾼다. "워커가 자기 SDK 로 턴을 실행한다"는 서술을 "워커는 도구 호출만 실행한다"로 고친다.

- [ ] **Step 4: `worker-셋업.md`**

`.env` 표를 새 변수(`WORKER_TOKEN`·`HUB_URL`·`WORKER_ROOTS`·`WORKER_USER_ID`)로 교체한다.
`DATABASE_URL` 요구를 삭제하고, **워커는 더 이상 DB 자격증명이 필요 없다**는 점을 명시한다.
"보안" 절의 `DATABASE_URL` 탈취 시나리오를 워커 토큰 기준으로 다시 쓴다 — 토큰이 유출되면
그 워커의 폴더 안에서 작업할 수 있을 뿐, DB·Claude 구독에는 접근하지 못한다.

- [ ] **Step 5: `smoke-test.md`**

배포 후 확인 항목을 추가한다.

```
- [ ] 워커 기동 시 콘솔에 `준비됨` 이 찍히는가(허브 인증 성공)
- [ ] 소유자 DM 에서 파일 읽기 요청 → 워커 PC 의 파일을 실제로 읽어 오는가
- [ ] 워커를 내린 뒤 같은 요청 → "워커가 연결돼 있지 않아요" 안내가 나오는가
- [ ] 워커를 다시 띄우면 재연결되어 PC 작업이 다시 되는가
- [ ] WORKER_ROOTS 밖 경로를 요청하면 거부되는가
- [ ] 잘못된 WORKER_TOKEN 으로 워커를 띄우면 거부되고 재연결을 멈추는가
```

- [ ] **Step 6: `STATUS.md`**

`## 라이브 인프라` 의 로컬 워커 설명을 새 구조로 고친다. `## 미완 / 미검증` 에 실 WS 왕복 검증을
추가한다. `## 테스트` 수치를 실제 출력으로 갱신한다.

```bash
cd agent && npm test
```

- [ ] **Step 7: 문서 검사**

```bash
node scripts/check-docs.mjs
```

기대: `문서 검사 통과`

- [ ] **Step 8: 커밋**

```bash
git add docs deploy
git commit -m "docs: 얇은 워커 구조 반영(능력 계층·모듈 경계·운영 런북)"
```

---

## 배포 후 확인

- [ ] Railway 환경변수에 `WORKER_TOKEN` 을 추가하고 재배포한다. `PORT` 는 Railway 가 주입한다.
- [ ] Railway 도메인이 발급돼 있는지 확인한다 — 없으면 워커가 붙을 주소가 없다. Settings → Networking → Generate Domain.
- [ ] 로컬 `.env` 에 `WORKER_TOKEN`(Railway 와 동일)·`HUB_URL`·`WORKER_ROOTS` 를 넣는다.
- [ ] `cd agent && npm run build && npm run worker:start` 로 워커를 띄우고 `준비됨` 로그를 확인한다.
- [ ] 디스코드에서 `/새세션` 후 소유자 DM 으로 PC 작업을 요청해 `deploy/smoke-test.md` 의 새 항목을 훑는다.
- [ ] PM2 로 상시 구동하려면 `npm run build` 후 `pm2 start deploy/ecosystem.config.cjs --only asahi-worker`.
