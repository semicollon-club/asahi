# 장기 실행 프로세스 관리(PM2 위임) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 부원이 개발서버 같은 장기 실행 프로세스를 띄우고, 무엇이 돌고 있는지 확인하고, 멈출 수 있게 한다 — 워커의 수명에 끌려다니지 않으면서.

**Architecture:** 감독자를 새로 만들지 않고 PM2 에 위임한다. 워커 실행기가 PM2 CLI 를 부르고, 프로세스 이름(`asahi-<디스코드 userId>`)과 작업 폴더는 **봇이 계산해 args 에 주입**한다(모델이 정하면 남의 프로세스를 죽일 수 있다). PM2 CLI 호출은 주입 가능한 이음매 뒤에 두어 테스트가 실제 PM2 를 요구하지 않게 한다.

**Tech Stack:** TypeScript(ESM, NodeNext) · vitest · PM2(외부 CLI) · zod · `@anthropic-ai/claude-agent-sdk`

**설계 정본:** `docs/superpowers/specs/2026-07-29-process-management-design.md`

## Global Constraints

- 작업 디렉토리는 `agent/` 다. 모든 명령은 거기서 실행한다.
- **TDD.** 실패하는 테스트를 먼저 쓰고, 실패를 눈으로 확인한 뒤 구현한다(`CONTRIBUTING.md`).
- 검증은 **두 개 다** 통과해야 한다: `npm test` 와 `npm run typecheck`.
- 주석·커밋 메시지·사용자 노출 문자열은 **한국어**. 기존 파일의 주석 밀도와 어투를 따른다.
- 커밋 메시지는 conventional commits + 한국어 제목. 끝에 `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>` 를 붙인다.
- **이모지를 사용자 노출 문자열에 넣지 않는다**(진행 표시의 `✓`/`✗` 만 기존 예외).
- **테스트는 실제 PM2 설치를 요구하면 안 된다.** CLI 호출은 항상 주입된 `runPm2` 를 거친다.
- `agent/src/core/paths.ts` 와 `agent/src/remote/roots.ts` 는 읽어 쓰되 **고치지 않는다** — 경로 판정은 보안 경계다.
- `actions` 테이블 스키마는 변경하지 않는다.

## File Structure

| 파일 | 책임 |
|---|---|
| `agent/src/remote/proc.ts` (신규) | 이름 규칙·`pm2 jlist` 파싱·표 렌더링. 파일시스템도 CLI 도 모른다 |
| `agent/src/remote/executors.ts` (수정) | `proc_*` 실행기 넷 + `runPm2` 이음매 |
| `agent/src/core/remoteTools.ts` (수정) | 이름·cwd 주입, 스코프 계산을 proc 도구까지 확장 |
| `agent/src/core/tools.ts` (수정) | 도구 선언 넷 |
| `agent/src/core/persona.ts` (수정) | 능력 안내에 도구 넷 추가 |
| `agent/src/core/commands.ts` (수정) | `/help` 한 줄 |

---

### Task 1: 순수 함수 — 이름 규칙·파싱·렌더링

**Files:**
- Create: `agent/src/remote/proc.ts`
- Test: `agent/tests/proc.test.ts`

**Interfaces:**
- Produces: `PROC_TOOL_NAMES`, `procNameFor(userId: string): string`, `parseProcName(name: string): string | null`, `parsePm2List(json: string): ProcInfo[]`, `renderProcList(procs: ProcInfo[], o: { labelOf(userId: string): string }): string`
- Produces: `export type ProcInfo = { name: string; userId: string | null; command: string; status: string; uptimeMs: number | null; memoryBytes: number | null; restarts: number }`
- Consumes: 없음

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`agent/tests/proc.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { PROC_TOOL_NAMES, procNameFor, parseProcName, parsePm2List, renderProcList, type ProcInfo } from "../src/remote/proc.js";

const jlist = (rows: unknown[]) => JSON.stringify(rows);
const row = (name: string, over: Record<string, unknown> = {}) => ({
  name,
  pid: 1234,
  pm2_env: { status: "online", pm_uptime: 1_000_000, restart_time: 0, args: ["run", "dev"], pm_exec_path: "C:\\Program Files\\nodejs\\npm.cmd", ...(over.pm2_env as object ?? {}) },
  monit: { memory: 184 * 1024 * 1024, cpu: 0, ...(over.monit as object ?? {}) },
});

describe("proc — 이름 규칙", () => {
  it("도구 이름 넷을 고정으로 노출한다", () => {
    expect([...PROC_TOOL_NAMES].sort()).toEqual(["proc_list", "proc_logs", "proc_start", "proc_stop"]);
  });

  it("사용자 id 로 프로세스 이름을 만든다", () => {
    expect(procNameFor("1517428698368704650")).toBe("asahi-1517428698368704650");
  });

  it("프로세스 이름에서 사용자 id 를 되찾는다", () => {
    expect(parseProcName("asahi-1517428698368704650")).toBe("1517428698368704650");
  });

  it("우리 규칙이 아닌 이름은 null 이다(봇·워커 자신의 프로세스를 사람 것으로 오해하지 않는다)", () => {
    expect(parseProcName("asahi-assistant")).toBeNull();
    expect(parseProcName("asahi-worker")).toBeNull();
    expect(parseProcName("something-else")).toBeNull();
  });
});

describe("proc — pm2 jlist 파싱", () => {
  it("필요한 필드만 뽑아 온다", () => {
    const [p] = parsePm2List(jlist([row("asahi-111")]));
    expect(p).toMatchObject({ name: "asahi-111", userId: "111", status: "online", restarts: 0 });
    expect(p!.memoryBytes).toBe(184 * 1024 * 1024);
    expect(p!.command).toContain("run dev");
  });

  it("우리 것이 아닌 프로세스도 목록에 담되 userId 는 null 이다", () => {
    const [p] = parsePm2List(jlist([row("asahi-worker")]));
    expect(p!.userId).toBeNull();
  });

  it("빈 목록을 견딘다", () => {
    expect(parsePm2List("[]")).toEqual([]);
  });

  it("깨진 JSON 이면 던지지 않고 빈 목록을 돌려준다(pm2 가 경고를 섞어 뱉는 경우가 있다)", () => {
    expect(parsePm2List("not json")).toEqual([]);
  });

  it("필드가 없어도 죽지 않는다", () => {
    const [p] = parsePm2List(jlist([{ name: "asahi-9" }]));
    expect(p).toMatchObject({ name: "asahi-9", status: "unknown", restarts: 0 });
    expect(p!.memoryBytes).toBeNull();
    expect(p!.uptimeMs).toBeNull();
  });
});

describe("proc — 표 렌더링", () => {
  const labelOf = (userId: string) => (userId === "111" ? "우성현" : userId);
  const one: ProcInfo = { name: "asahi-111", userId: "111", command: "npm run dev", status: "online", uptimeMs: 2 * 3600_000 + 12 * 60_000, memoryBytes: 184 * 1024 * 1024, restarts: 0 };

  it("사람 이름·명령·상태·업타임·메모리·재시작 횟수를 담는다", () => {
    const out = renderProcList([one], { labelOf });
    expect(out).toContain("우성현");
    expect(out).toContain("npm run dev");
    expect(out).toContain("online");
    expect(out).toContain("2시간 12분");
    expect(out).toContain("184MB");
    expect(out).toContain("재시작 0");
  });

  it("비어 있으면 비었다고 말한다(빈 문자열을 돌려주지 않는다)", () => {
    expect(renderProcList([], { labelOf })).toContain("도는 것이 없");
  });

  it("개수를 머리글에 넣는다", () => {
    const out = renderProcList([one, { ...one, name: "asahi-222", userId: "222" }], { labelOf });
    expect(out).toContain("2개");
  });
});
```

- [ ] **Step 2: 실패를 확인한다**

Run: `npx vitest run tests/proc.test.ts`
Expected: FAIL — `../src/remote/proc.js` 모듈이 없다.

- [ ] **Step 3: `proc.ts` 를 만든다**

```ts
// 장기 실행 프로세스(개발서버 등)를 PM2 에 위임하면서 필요한 순수 로직만 모은다.
// 파일시스템도 CLI 도 모른다 — 실제 PM2 호출은 executors.ts 가, 신원 주입은 remoteTools.ts 가 한다.
// 이렇게 떼어 두는 이유는 fs_tree 의 tree.ts 와 같다: 외부 의존 없이 형식만 검증하기 위해서다.

export const PROC_TOOL_NAMES = ["proc_start", "proc_stop", "proc_list", "proc_logs"] as const;

// 프로세스 이름이 곧 소유권이자 "1인 1개" 상한이다 — PM2 안에서 이름이 유일하므로, 같은 사람이
// 두 번째를 띄우려 하면 이름이 충돌한다. 별도 상태 저장이 필요 없다.
const PREFIX = "asahi-";
// 디스코드 스노플레이크만 우리 것으로 인정한다. 이게 없으면 봇 자신의 PM2 앱(asahi-assistant,
// asahi-worker)까지 "누군가의 프로세스"로 오해한다.
const USER_ID = /^\d{5,}$/;

export function procNameFor(userId: string): string {
  return `${PREFIX}${userId}`;
}

export function parseProcName(name: string): string | null {
  if (!name.startsWith(PREFIX)) return null;
  const rest = name.slice(PREFIX.length);
  return USER_ID.test(rest) ? rest : null;
}

export type ProcInfo = {
  name: string;
  userId: string | null;
  command: string;
  status: string;
  uptimeMs: number | null;
  memoryBytes: number | null;
  restarts: number;
};

type RawEnv = { status?: unknown; pm_uptime?: unknown; restart_time?: unknown; args?: unknown; pm_exec_path?: unknown };
type RawProc = { name?: unknown; pm2_env?: RawEnv; monit?: { memory?: unknown } };

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

// pm2 가 실행 중인 명령을 하나의 문자열로 복원한다. pm_exec_path 는 절대경로라 그대로 보여주면
// 한 줄을 잡아먹으므로 마지막 조각만 쓴다(사람이 알아보는 데는 그것으로 충분하다).
function commandOf(env: RawEnv | undefined): string {
  const exec = typeof env?.pm_exec_path === "string" ? env.pm_exec_path.split(/[\\/]/).pop() ?? "" : "";
  const args = Array.isArray(env?.args) ? env.args.filter((a): a is string => typeof a === "string") : [];
  return [exec, ...args].filter((s) => s.length > 0).join(" ") || "(알 수 없음)";
}

// pm2 는 경고를 stdout 에 섞어 뱉는 경우가 있다. 파싱 실패로 도구 전체를 죽이지 않고 빈 목록으로
// 떨어뜨린다 — 호출측(executors.ts)이 "지금 도는 것이 없어요"로 안내하는 편이, 사용자에게
// JSON 파싱 오류를 보여주는 것보다 낫다.
export function parsePm2List(json: string): ProcInfo[] {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return [];
  }
  if (!Array.isArray(raw)) return [];
  return raw.map((r) => {
    const p = (r ?? {}) as RawProc;
    const name = typeof p.name === "string" ? p.name : "(이름 없음)";
    const started = num(p.pm2_env?.pm_uptime);
    return {
      name,
      userId: parseProcName(name),
      command: commandOf(p.pm2_env),
      status: typeof p.pm2_env?.status === "string" ? p.pm2_env.status : "unknown",
      // pm_uptime 은 "시작 시각(ms)"이지 경과 시간이 아니다. 경과로 바꾸는 것은 시계를 아는
      // 호출측의 몫이라, 여기서는 시작 시각을 그대로 담고 렌더러가 뺀다.
      uptimeMs: started,
      memoryBytes: num(p.monit?.memory),
      restarts: num(p.pm2_env?.restart_time) ?? 0,
    };
  });
}

function humanUptime(startedAtMs: number | null, now: number): string {
  if (startedAtMs === null) return "-";
  const ms = Math.max(0, now - startedAtMs);
  const min = Math.floor(ms / 60_000);
  const h = Math.floor(min / 60);
  return h > 0 ? `${h}시간 ${min % 60}분` : `${min}분`;
}

function humanMem(bytes: number | null): string {
  return bytes === null ? "-" : `${Math.round(bytes / (1024 * 1024))}MB`;
}

// labelOf: 디스코드 userId → 사람이 알아볼 이름. 봇 쪽에서만 알 수 있으므로 주입받는다.
// now: 업타임 계산 기준. 테스트가 고정할 수 있게 인자로 둔다.
export function renderProcList(
  procs: ProcInfo[],
  o: { labelOf: (userId: string) => string; now?: number },
): string {
  if (procs.length === 0) return "지금 도는 것이 없어요.";
  const now = o.now ?? Date.now();
  const lines = procs.map((p) => {
    const who = p.userId === null ? p.name : o.labelOf(p.userId);
    return `${who}  ${p.command}  ${p.status}  ${humanUptime(p.uptimeMs, now)}  ${humanMem(p.memoryBytes)}  재시작 ${p.restarts}`;
  });
  return [`지금 도는 것 (${procs.length}개)`, "", ...lines].join("\n");
}
```

- [ ] **Step 4: 통과를 확인한다**

Run: `npx vitest run tests/proc.test.ts`
Expected: PASS. 업타임 테스트가 실패하면 `renderProcList` 호출에 `now` 를 넘겨 고정한다 — 테스트의 `uptimeMs` 는 "시작 시각"이므로 `now: 0 + 2시간12분` 형태로 맞춰야 한다. 테스트를 다음과 같이 고친다:

```ts
const one: ProcInfo = { name: "asahi-111", userId: "111", command: "npm run dev", status: "online", uptimeMs: 0, memoryBytes: 184 * 1024 * 1024, restarts: 0 };
// …
const out = renderProcList([one], { labelOf, now: 2 * 3600_000 + 12 * 60_000 });
```

- [ ] **Step 5: 전체 검증**

Run: `npm run typecheck && npm test`
Expected: typecheck exit 0, 전체 통과

- [ ] **Step 6: 커밋**

```bash
git add agent/src/remote/proc.ts agent/tests/proc.test.ts
git commit -m "feat(remote): 프로세스 이름 규칙·pm2 목록 파싱·표 렌더링"
```

---

### Task 2: 실행기 넷과 `runPm2` 이음매

**Files:**
- Modify: `agent/src/remote/executors.ts`
- Test: `agent/tests/remoteExecutors.test.ts`

**Interfaces:**
- Consumes: Task 1 의 `PROC_TOOL_NAMES`, `parsePm2List`, `renderProcList`, `ProcInfo`
- Produces: `makeExecutors(roots: string[], opts?: { runPm2?: RunPm2 }): Executors` 로 시그니처가 넓어진다. `export type RunPm2 = (args: string[]) => Promise<{ ok: boolean; stdout: string; stderr: string }>`
- Produces: 실행기 `proc_start({ command, name, cwd })`, `proc_stop({ name })`, `proc_list({})`, `proc_logs({ name, lines? })` — `name`·`cwd` 는 봇이 주입한다(Task 3)

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`agent/tests/remoteExecutors.test.ts` 끝에 추가한다.

```ts
describe("proc_* 실행기 — PM2 위임", () => {
  type Call = string[];
  const fakePm2 = (replies: Record<string, { ok: boolean; stdout: string; stderr?: string }>) => {
    const calls: Call[] = [];
    const runPm2 = async (args: string[]) => {
      calls.push(args);
      const key = args[0]!;
      const r = replies[key] ?? { ok: true, stdout: "" };
      return { ok: r.ok, stdout: r.stdout, stderr: r.stderr ?? "" };
    };
    return { calls, runPm2 };
  };

  it("proc_start 는 주입된 이름과 cwd 로 pm2 start 를 부른다", async () => {
    const { calls, runPm2 } = fakePm2({ jlist: { ok: true, stdout: "[]" } });
    const ex = makeExecutors(["C:\\ws"], { runPm2 });
    const r = await ex.proc_start!({ command: "npm run dev", name: "asahi-111", cwd: "C:\\ws\\111" });
    expect(r.ok).toBe(true);
    const start = calls.find((c) => c[0] === "start")!;
    expect(start).toContain("--name");
    expect(start).toContain("asahi-111");
    expect(start).toContain("--cwd");
    expect(start).toContain("C:\\ws\\111");
    expect(start.join(" ")).toContain("npm run dev");
  });

  it("proc_start 는 같은 이름이 이미 있으면 pm2 를 부르지 않고 거절한다(조용한 교체 금지)", async () => {
    const existing = JSON.stringify([{ name: "asahi-111", pm2_env: { status: "online", pm_uptime: 0, restart_time: 0, args: ["run", "dev"], pm_exec_path: "npm" }, monit: { memory: 1 } }]);
    const { calls, runPm2 } = fakePm2({ jlist: { ok: true, stdout: existing } });
    const ex = makeExecutors(["C:\\ws"], { runPm2 });
    const r = await ex.proc_start!({ command: "npm run dev", name: "asahi-111", cwd: "C:\\ws\\111" });
    expect(r.ok).toBe(false);
    expect(r.content).toContain("이미");
    expect(calls.some((c) => c[0] === "start")).toBe(false);
  });

  it("proc_start 성공 응답은 멈추는 법을 그 자리에서 알려준다", async () => {
    const { runPm2 } = fakePm2({ jlist: { ok: true, stdout: "[]" } });
    const ex = makeExecutors(["C:\\ws"], { runPm2 });
    const r = await ex.proc_start!({ command: "npm run dev", name: "asahi-111", cwd: "C:\\ws\\111" });
    expect(r.content).toContain("멈추");
  });

  it("proc_stop 은 pm2 delete 를 부른다", async () => {
    const { calls, runPm2 } = fakePm2({ delete: { ok: true, stdout: "" } });
    const ex = makeExecutors(["C:\\ws"], { runPm2 });
    const r = await ex.proc_stop!({ name: "asahi-111" });
    expect(r.ok).toBe(true);
    expect(calls).toContainEqual(["delete", "asahi-111"]);
  });

  it("proc_stop 은 없는 이름이면 실패로 돌려준다", async () => {
    const { runPm2 } = fakePm2({ delete: { ok: false, stdout: "", stderr: "Process not found" } });
    const ex = makeExecutors(["C:\\ws"], { runPm2 });
    const r = await ex.proc_stop!({ name: "asahi-111" });
    expect(r.ok).toBe(false);
  });

  it("proc_list 는 jlist 를 파싱해 표로 돌려준다", async () => {
    const stdout = JSON.stringify([{ name: "asahi-111", pm2_env: { status: "online", pm_uptime: 0, restart_time: 2, args: ["run", "dev"], pm_exec_path: "npm" }, monit: { memory: 5 * 1024 * 1024 } }]);
    const { runPm2 } = fakePm2({ jlist: { ok: true, stdout } });
    const ex = makeExecutors(["C:\\ws"], { runPm2 });
    const r = await ex.proc_list!({});
    expect(r.ok).toBe(true);
    expect(r.content).toContain("asahi-111");
    expect(r.content).toContain("재시작 2");
  });

  it("proc_logs 는 nostream 으로 부르고 줄 수를 넘긴다", async () => {
    const { calls, runPm2 } = fakePm2({ logs: { ok: true, stdout: "로그 본문" } });
    const ex = makeExecutors(["C:\\ws"], { runPm2 });
    const r = await ex.proc_logs!({ name: "asahi-111", lines: 30 });
    expect(r.ok).toBe(true);
    expect(r.content).toContain("로그 본문");
    const logs = calls.find((c) => c[0] === "logs")!;
    expect(logs).toContain("--nostream");
    expect(logs).toContain("30");
  });

  it("pm2 가 실패하면 stderr 를 사유로 돌려준다", async () => {
    const { runPm2 } = fakePm2({ jlist: { ok: false, stdout: "", stderr: "pm2 를 찾을 수 없습니다" } });
    const ex = makeExecutors(["C:\\ws"], { runPm2 });
    const r = await ex.proc_list!({});
    expect(r.ok).toBe(false);
    expect(r.content).toContain("pm2");
  });

  it("roots 가 비면 거절한다(sh_exec 와 같은 규칙)", async () => {
    const { runPm2 } = fakePm2({});
    const ex = makeExecutors([], { runPm2 });
    expect((await ex.proc_list!({})).ok).toBe(false);
  });
});
```

- [ ] **Step 2: 실패를 확인한다**

Run: `npx vitest run tests/remoteExecutors.test.ts -t "proc_"`
Expected: FAIL — `ex.proc_start` 등이 없다.

- [ ] **Step 3: `executors.ts` 를 고친다**

파일 상단 import 에 추가한다.

```ts
import { pathFlavorOf } from "../core/paths.js";
import { parsePm2List, renderProcList } from "./proc.js";
```

`OUTPUT_MAX` 아래에 상수와 타입을 둔다.

```ts
// PM2 CLI 호출을 이음매 뒤로 뺀다. 테스트가 실제 PM2 설치를 요구하면 그 경로는 CI 에서도
// 개발자 기계에서도 한 번도 지나가지 않는다 — 2026-07-28 최종 리뷰가 잡은 Critical(실패 신호
// 소실)이 정확히 그렇게 다섯 번의 리뷰를 통과했다.
export type RunPm2 = (args: string[]) => Promise<{ ok: boolean; stdout: string; stderr: string }>;

const PROC_LOG_DEFAULT_LINES = 50;
```

`makeExecutors` 시그니처를 넓히고 기본 `runPm2` 를 만든다. `opts` 는 선택 인자이므로 기존 호출
네 곳(`src/worker.ts:49`, `tests/failureSeam.test.ts`, `tests/remoteExecutors.test.ts`,
`tests/remoteTools.test.ts`)은 **한 줄도 고치지 않는다.**

```ts
export function makeExecutors(roots: string[], opts: { runPm2?: RunPm2 } = {}): Executors {
  const runPm2: RunPm2 =
    opts.runPm2 ??
    ((args) =>
      new Promise((resolve) => {
        // shell:true 로 부르는 이유는 sh_exec 와 같다 — 윈도우에서 pm2 는 pm2.cmd 셰임이라
        // 셸을 거치지 않으면 실행 파일을 찾지 못한다.
        const child = spawn("pm2", args, { shell: true });
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (c: Buffer) => { stdout += c.toString(); });
        child.stderr.on("data", (c: Buffer) => { stderr += c.toString(); });
        child.on("error", (e) => resolve({ ok: false, stdout, stderr: String(e) }));
        child.on("close", (code) => resolve({ ok: code === 0, stdout, stderr }));
      }));
```

기존 `gate` 정의 아래에 proc 전용 헬퍼를 둔다.

```ts
  // pm2 에 임의 명령을 넘기는 안전한 형태. pm2 는 "스크립트 파일"을 기대하므로, 셸 명령은
  // 인터프리터를 명시해 넘겨야 한다. 어느 셸인지는 워커 루트의 플레이버로 정한다 — 봇은
  // 리눅스, 워커는 윈도우일 수 있어 호스트 플랫폼으로 정하면 어긋난다(paths.ts 와 같은 이유).
  const shellFor = (): { bin: string; flag: string } =>
    pathFlavorOf(roots[0] ?? "/") === path.win32 ? { bin: "cmd.exe", flag: "/c" } : { bin: "sh", flag: "-c" };

  const procGate = (): { ok: true } | { ok: false; res: ExecResult } =>
    roots.length === 0
      ? { ok: false, res: { ok: false, content: "워커에 열린 작업 폴더가 없어요." } }
      : { ok: true };

  const listProcs = async () => {
    const r = await runPm2(["jlist"]);
    return r.ok
      ? { ok: true as const, procs: parsePm2List(r.stdout) }
      : { ok: false as const, message: `pm2 목록을 가져오지 못했어요: ${r.stderr.trim() || "알 수 없는 오류"}` };
  };
```

반환 객체에 실행기 넷을 추가한다.

```ts
    async proc_start(args) {
      const g = procGate();
      if (!g.ok) return g.res;
      const command = str(args.command);
      const name = str(args.name);
      const cwd = str(args.cwd);
      if (!command) return { ok: false, content: "실행할 명령이 필요해요." };
      // name·cwd 는 봇이 주입한다(remoteTools.ts). 없으면 배선이 깨진 것이므로 실행하지 않는다 —
      // 이름 없이 띄우면 소유권도 1인 1개 상한도 성립하지 않는다.
      if (!name || !cwd) return { ok: false, content: "프로세스 이름·작업 폴더가 지정되지 않았어요." };

      const before = await listProcs();
      if (!before.ok) return { ok: false, content: before.message };
      const dup = before.procs.find((p) => p.name === name);
      // 조용히 교체하지 않는다 — 부원이 자기도 모르게 돌던 서버를 잃는다. 바꾸려면 멈추고 다시 띄운다.
      if (dup) return { ok: false, content: `이미 돌고 있는 게 있어요: ${dup.command} (${dup.status}). 먼저 멈춰야 새로 띄울 수 있어요.` };

      const sh = shellFor();
      const r = await runPm2(["start", sh.bin, "--name", name, "--cwd", cwd, "--", sh.flag, command]);
      if (!r.ok) return { ok: false, content: `띄우지 못했어요: ${r.stderr.trim() || r.stdout.trim() || "알 수 없는 오류"}` };
      // 발견성: 시작한 그 순간이 멈추는 법을 알려주기 가장 좋은 시점이다(설계 §6).
      return { ok: true, content: `띄웠어요: ${command}\n멈추려면 "돌고 있는 거 꺼줘" 라고 말하면 돼요. "뭐 돌고 있어?" 로 확인할 수 있어요.` };
    },

    async proc_stop(args) {
      const g = procGate();
      if (!g.ok) return g.res;
      const name = str(args.name);
      if (!name) return { ok: false, content: "멈출 프로세스가 지정되지 않았어요." };
      const r = await runPm2(["delete", name]);
      return r.ok
        ? { ok: true, content: `멈췄어요: ${name}` }
        : { ok: false, content: `멈추지 못했어요: ${r.stderr.trim() || "그런 프로세스가 없어요"}` };
    },

    async proc_list(args) {
      const g = procGate();
      if (!g.ok) return g.res;
      const r = await listProcs();
      if (!r.ok) return { ok: false, content: r.message };
      // 필터는 봇이 하지 않고 여기서 한다 — onlyUserId 는 remoteTools.ts 가 주입한다(손님이면
      // 자기 것만, 소유자면 생략해 전원).
      const only = str(args.onlyUserId);
      const procs = only === undefined ? r.procs : r.procs.filter((p) => p.userId === only);
      return { ok: true, content: truncate(renderProcList(procs, { labelOf: (id) => id })) };
    },

    async proc_logs(args) {
      const g = procGate();
      if (!g.ok) return g.res;
      const name = str(args.name);
      if (!name) return { ok: false, content: "로그를 볼 프로세스가 지정되지 않았어요." };
      const lines = Math.max(1, Math.min(num(args.lines) ?? PROC_LOG_DEFAULT_LINES, 200));
      const r = await runPm2(["logs", name, "--nostream", "--lines", String(lines)]);
      if (!r.ok) return { ok: false, content: `로그를 가져오지 못했어요: ${r.stderr.trim() || "그런 프로세스가 없어요"}` };
      const body = r.stdout.trim();
      return { ok: true, content: truncate(body.length > 0 ? body : "(로그가 비어 있어요)") };
    },
```

- [ ] **Step 4: 통과를 확인한다**

Run: `npm run typecheck && npm test`
Expected: typecheck exit 0, 전체 통과

- [ ] **Step 5: 커밋**

```bash
git add agent/src/remote/executors.ts agent/tests/remoteExecutors.test.ts
git commit -m "feat(remote): proc_* 실행기와 runPm2 이음매"
```

---

### Task 3: 봇 쪽 주입과 게이팅

**Files:**
- Modify: `agent/src/core/remoteTools.ts`
- Modify: `agent/src/core/tools.ts`
- Test: `agent/tests/remoteTools.test.ts`

**Interfaces:**
- Consumes: Task 1 의 `PROC_TOOL_NAMES`, `procNameFor`; Task 2 의 실행기 인자 모양
- Produces: `REMOTE_TOOL_NAMES` 에 `proc_start`·`proc_stop`·`proc_list`·`proc_logs` 가 추가된다

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`agent/tests/remoteTools.test.ts` 끝에 추가한다.

```ts
describe("proc_* — 이름과 작업 폴더는 봇이 주입한다", () => {
  const withDirs = (dirs: string[], remote: Partial<NonNullable<ToolCtx["remote"]>>, over: Record<string, unknown> = {}): ToolCtx =>
    ({
      remote: { roots: ["/w"], workerId: "shared", workerKind: "shared", ...remote },
      isOwner: false, isPrivate: false, userId: "111",
      repos: { allowedDirs: { list: async () => dirs } },
      ...over,
    } as unknown as ToolCtx);

  it("도구 이름 11개를 고정으로 노출한다", () => {
    expect([...REMOTE_TOOL_NAMES].sort()).toEqual([
      "fs_edit", "fs_glob", "fs_grep", "fs_read", "fs_tree", "fs_write",
      "proc_list", "proc_logs", "proc_start", "proc_stop", "sh_exec",
    ]);
  });

  it("손님의 proc_start 는 모델이 준 name·cwd 를 무시하고 덮어쓴다", async () => {
    const seen: Array<Record<string, unknown>> = [];
    const ctx = withDirs(["/w"], { call: async (_t, a) => { seen.push(a); return { ok: true, content: "" }; } });
    await remoteToolHandler(ctx, "proc_start", { command: "npm run dev", name: "asahi-999", cwd: "/etc" });
    expect(seen[0]!.name).toBe("asahi-111");
    expect(seen[0]!.cwd).toBe("/w/111");
  });

  it("손님의 proc_stop 도 자기 이름으로 덮어쓴다(남의 것을 못 죽인다)", async () => {
    const seen: Array<Record<string, unknown>> = [];
    const ctx = withDirs(["/w"], { call: async (_t, a) => { seen.push(a); return { ok: true, content: "" }; } });
    await remoteToolHandler(ctx, "proc_stop", { name: "asahi-999" });
    expect(seen[0]!.name).toBe("asahi-111");
  });

  it("손님의 proc_list 는 자기 것만 보도록 필터가 주입된다", async () => {
    const seen: Array<Record<string, unknown>> = [];
    const ctx = withDirs(["/w"], { call: async (_t, a) => { seen.push(a); return { ok: true, content: "" }; } });
    await remoteToolHandler(ctx, "proc_list", {});
    expect(seen[0]!.onlyUserId).toBe("111");
  });

  it("소유자의 proc_list 는 필터 없이 전원을 본다", async () => {
    const seen: Array<Record<string, unknown>> = [];
    const ctx = withDirs(["/w"], { call: async (_t, a) => { seen.push(a); return { ok: true, content: "" }; } }, { isOwner: true });
    await remoteToolHandler(ctx, "proc_list", {});
    expect(seen[0]!.onlyUserId).toBeUndefined();
  });

  it("소유자의 proc_stop 은 지정한 이름을 존중한다(관리자)", async () => {
    const seen: Array<Record<string, unknown>> = [];
    const ctx = withDirs(["/w"], { call: async (_t, a) => { seen.push(a); return { ok: true, content: "" }; } }, { isOwner: true });
    await remoteToolHandler(ctx, "proc_stop", { name: "asahi-999" });
    expect(seen[0]!.name).toBe("asahi-999");
  });

  it("허용 폴더가 없으면 proc_start 는 허브를 부르지 않고 거절한다", async () => {
    let called = false;
    const ctx = withDirs([], { call: async () => { called = true; return { ok: true, content: "" }; } });
    const out = await remoteToolHandler(ctx, "proc_start", { command: "npm run dev" });
    expect(called).toBe(false);
    expect(out.ok).toBe(false);
    expect(out.content).toContain("allow_dir");
  });
});
```

- [ ] **Step 2: 실패를 확인한다**

Run: `npx vitest run tests/remoteTools.test.ts -t "proc_"`
Expected: FAIL — `REMOTE_TOOL_NAMES` 에 proc 도구가 없고, 주입도 없다.

- [ ] **Step 3: `remoteTools.ts` 를 고친다**

import 와 도구 목록:

```ts
import { PROC_TOOL_NAMES, procNameFor } from "../remote/proc.js";
```

```ts
export const REMOTE_TOOL_NAMES = [
  "fs_read", "fs_write", "fs_edit", "fs_glob", "fs_grep", "fs_tree", "sh_exec",
  ...PROC_TOOL_NAMES,
] as const;
```

핸들러 안에서 스코프 계산을 proc 도구까지 넓힌다. 지금 `allowed` 는 `if (needsPathCheck)` 블록
안에서만 계산되는데, proc 도구는 경로 인자가 없으면서도 **작업 폴더를 알아야** 한다. 아래처럼
계산 블록을 바깥으로 끌어올린다.

```ts
  const isProcTool = (PROC_TOOL_NAMES as readonly string[]).includes(tool);
  // proc 도구는 경로 인자가 없지만 cwd 를 알아야 하므로 같은 스코프 계산이 필요하다.
  const needsScope = needsPathCheck || isProcTool;

  let allowed: string[] = [];
  if (needsScope) {
    if (singlePathArg !== undefined && singlePathArg.trim().length === 0) {
      return deny("경로가 비어 있어요. 올바른 절대경로를 지정해 주세요.");
    }
    if (!ctx.repos?.allowedDirs) return deny("허용 폴더 목록을 확인할 수 없어 요청을 거부했어요.");
    try {
      const dirs = await ctx.repos.allowedDirs.list(remote.workerId);
      allowed = scopeDirs(dirs, { workerKind: remote.workerKind, isOwner: ctx.isOwner, userId: ctx.userId });
    } catch (e) {
      return deny(`허용 폴더 확인 중 오류가 발생했어요: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (allowed.length === 0) return deny("먼저 allow_dir 로 작업할 폴더를 허용해 주세요.");
    // 손님의 개인 폴더는 첫 접근 때 만든다 — proc_start 의 cwd 로도 쓰이므로 경로 검사 유무와
    // 무관하게 필요하다.
    if (remote.workerKind === "shared" && !ctx.isOwner) {
      await remote.call("fs_mkdir", { path: allowed[0] }).catch(() => {});
    }
  }

  if (needsPathCheck) {
    // (기존 candidates 검사와 FIX1 주입은 그대로 둔다)
  }

  // 이름·작업 폴더·목록 필터는 주입이지 검증이 아니다. 모델이 name 을 넘길 수 있게 두면 부원 A 가
  // 부원 B 의 프로세스를 죽이라고 시킬 수 있다 — fs_glob 의 FIX1 과 같은 구조다(검사한 값과 실제로
  // 쓰이는 값이 다르면 검사가 무의미해진다). 소유자는 그 기계의 관리자이므로 이름을 지정할 수
  // 있고, 목록도 좁히지 않는다(scopeDirs 가 소유자를 좁히지 않는 것과 같은 규칙).
  if (isProcTool) {
    const mine = procNameFor(ctx.userId);
    if (tool === "proc_start") args = { ...args, name: mine, cwd: allowed[0] };
    if (tool === "proc_stop" || tool === "proc_logs") {
      args = ctx.isOwner && typeof args.name === "string" && args.name.length > 0 ? args : { ...args, name: mine };
    }
    if (tool === "proc_list") {
      args = ctx.isOwner ? { ...args, onlyUserId: undefined } : { ...args, onlyUserId: ctx.userId };
    }
  }
```

`tools.ts` 의 `buildToolDefinitions` 배열 끝(`sh_exec` 선언 뒤)에 선언 넷을 추가한다. 기존
원격 도구와 **똑같이** `remoteResult(ctx, "<도구>", args)` 형태를 쓴다 — 이 함수가 `{ content, ok }`
의 `ok` 를 `isError` 로 뒤집어 싣는 유일한 이음매이므로 우회하면 실패 신호가 다시 사라진다.

```ts
    tool(
      "proc_start",
      "개발서버처럼 오래 도는 프로세스를 띄웁니다. 한 사람당 하나만 띄울 수 있습니다.",
      { command: z.string().describe("실행할 명령. 예: npm run dev") },
      async (args) => remoteResult(ctx, "proc_start", args),
    ),
    tool(
      "proc_stop",
      "돌고 있는 프로세스를 멈춥니다.",
      { name: z.string().optional().describe("(소유자 전용) 멈출 프로세스 이름. 생략하면 본인 것") },
      async (args) => remoteResult(ctx, "proc_stop", args),
    ),
    tool(
      "proc_list",
      "지금 돌고 있는 프로세스를 보여줍니다. 무엇이 도는지 기억으로 답하지 말고 이 도구를 부르세요.",
      {},
      async (args) => remoteResult(ctx, "proc_list", args),
    ),
    tool(
      "proc_logs",
      "돌고 있는 프로세스의 최근 로그를 봅니다.",
      {
        lines: z.number().min(1).optional().describe("가져올 줄 수(기본 50, 최대 200)"),
        name: z.string().optional().describe("(소유자 전용) 대상 프로세스 이름. 생략하면 본인 것"),
      },
      async (args) => remoteResult(ctx, "proc_logs", args),
    ),
```

`tools.ts` 주석의 "원격 도구 7개" 를 11개로 고친다.

- [ ] **Step 4: 통과를 확인한다**

Run: `npm run typecheck && npm test`
Expected: typecheck exit 0, 전체 통과. `REMOTE_TOOL_NAMES` 개수를 단정하던 기존 테스트가
7 → 11 로 바뀌므로 함께 고친다(의도된 변경이다).

- [ ] **Step 5: 커밋**

```bash
git add agent/src/core/remoteTools.ts agent/src/core/tools.ts agent/tests/remoteTools.test.ts
git commit -m "feat(core): proc_* 의 이름·작업폴더 주입과 게이팅"
```

---

### Task 4: 능력 안내와 도움말

**Files:**
- Modify: `agent/src/core/persona.ts`
- Modify: `agent/src/core/commands.ts`
- Test: `agent/tests/persona.test.ts`, `agent/tests/commands.test.ts`

**Interfaces:**
- Consumes: Task 3 의 도구 이름
- Produces: 없음

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`agent/tests/persona.test.ts` 끝에 추가한다.

```ts
describe("buildSystemPrompt — 장기 실행 프로세스 도구를 안내한다", () => {
  it("워커가 연결된 네 분기 모두 proc_start 를 언급한다", () => {
    const branches = [
      { isOwner: true, isPrivate: true }, { isOwner: true, isPrivate: false },
      { isOwner: false, isPrivate: true }, { isOwner: false, isPrivate: false },
    ];
    for (const b of branches) {
      const p = buildSystemPrompt({ role: b.isOwner ? "owner" : "allowed", ...b, workerConnected: true });
      expect(capabilitySection(p)).toMatch(/proc_start/);
    }
  });

  it("워커 미연결이면 언급하지 않는다", () => {
    const cap = capabilitySection(buildSystemPrompt({ role: "allowed", isPrivate: false, isOwner: false }));
    expect(cap).not.toMatch(/proc_start/);
  });
});
```

`agent/tests/commands.test.ts` 끝에 추가한다.

```ts
// renderCommandHelp 는 workerConnected 를 위치 인자(boolean)로 받는다 — 객체가 아니다.
describe("renderCommandHelp — 오래 도는 프로세스를 안내한다", () => {
  it("워커가 연결돼 있으면 개발서버 안내가 있다", () => {
    expect(renderCommandHelp(true)).toMatch(/개발서버|오래 도는/);
  });

  it("워커가 연결돼 있지 않으면 안내하지 않는다", () => {
    expect(renderCommandHelp(false)).not.toMatch(/개발서버/);
  });
});
```

- [ ] **Step 2: 실패를 확인한다**

Run: `npx vitest run tests/persona.test.ts tests/commands.test.ts -t "프로세스"`
Expected: FAIL — 안내 문구에 proc 도구가 없다.

- [ ] **Step 3: 문구를 추가한다**

`persona.ts` 의 워커 연결 분기 네 곳(소유자 DM·소유자 서버·손님 공통 `guestPcLine`)에서 도구를
나열하는 문장에 `proc_start`·`proc_stop`·`proc_list`·`proc_logs` 를 더한다. 새 문장을 지어내지
말고 기존 나열에 이름을 붙이되, 손님 분기에는 다음 한 줄을 더한다.

```
- 오래 도는 프로세스(개발서버 등)는 proc_start 로 띄우고 proc_list 로 확인, proc_stop 으로 멈춥니다. 한 사람당 하나만 띄울 수 있고, 미니PC 가 재부팅되면 전부 사라집니다.
```

`commands.ts` 의 `GUEST_TIPS` 에 한 줄을 더한다(워커 연결 조건부 블록 안).

```
- 개발서버 띄워줘 / 뭐 돌고 있어? / 그거 꺼줘 — 오래 도는 프로세스는 한 사람당 하나까지
```

- [ ] **Step 4: 통과를 확인한다**

Run: `npm run typecheck && npm test`
Expected: typecheck exit 0, 전체 통과

- [ ] **Step 5: 커밋**

```bash
git add agent/src/core/persona.ts agent/src/core/commands.ts agent/tests/persona.test.ts agent/tests/commands.test.ts
git commit -m "docs(persona): 장기 실행 프로세스 도구를 능력 안내와 도움말에 넣는다"
```

---

### Task 5: 문서·설치·스모크

**Files:**
- Modify: `docs/security/capability-model.md`
- Modify: `deploy/smoke-test.md`
- Modify: `C:\ProgramData\asahi-maintenance\rotate-worker-log.ps1` (미니PC, 리포 밖)

**Interfaces:** 없음(문서와 운영 절차)

- [ ] **Step 1: 보안 문서를 갱신한다**

`docs/security/capability-model.md` 의 능력 계층표에 proc 도구 넷을 추가하고, 아래 문단을 새로 넣는다.

```markdown
### 장기 실행 프로세스의 한계

`proc_*` 는 PM2 에 위임한다. 프로세스 이름(`asahi-<디스코드 userId>`)과 작업 폴더는 봇이 주입하며,
그 이름이 곧 소유권이자 "1인 1개" 상한이다.

**이 상한은 강제가 아니다.** 손님은 이미 `sh_exec` 로 임의 셸을 돌릴 수 있으므로
`pm2 start --name asahi-<남의id>` 를 직접 칠 수 있고, `pm2 delete` 로 남의 것을 죽일 수도 있다.
폴더 격리와 정확히 같은 성격이다 — 실수 방지선이지 작정한 접근의 경계가 아니며, 실제 경계는
워커를 돌리는 `asahi` OS 계정 하나다.

**자원 상한이 없다.** 윈도우에는 리눅스 cgroup 같은 수단이 없어 한 프로세스가 미니PC 의 메모리를
전부 먹을 수 있다. 1인 1개 상한은 "여러 개가 쌓이는 것"만 막는다.

**재부팅하면 전부 사라진다.** `pm2 save`/`resurrect` 를 일부러 쓰지 않는다 — 잊고 켜둔 것이
재부팅 후에도 되살아나는 것은 놀라운 동작이고 방치를 늘린다.
```

- [ ] **Step 2: 스모크 항목을 추가한다**

`deploy/smoke-test.md` 체크리스트에 추가한다.

```markdown
- [ ] **개발서버를 띄우고 확인한다** — 손님 계정으로 "개발서버 띄워줘" 라고 한 뒤 "뭐 돌고 있어?"
  라고 묻는다.
  기대 결과: 표에 그 프로세스가 `online` 으로 보이고, 업타임·메모리가 채워져 있다. 진행 표시에
  `✓ proc_start — …` 가 보인다.

- [ ] **1인 1개 상한** — 같은 손님이 하나 더 띄우려 한다.
  기대 결과: `이미 돌고 있는 게 있어요: …` 로 거절되고, 기존 프로세스가 **그대로 살아 있다**
  (조용히 교체되지 않는다).

- [ ] **워커를 재시작해도 프로세스가 살아 있는가** — 관리자 계정에서
  `Stop-ScheduledTask -TaskName asahi-worker; Start-ScheduledTask -TaskName asahi-worker` 후
  다시 "뭐 돌고 있어?" 라고 묻는다.
  기대 결과: **그대로 돌고 있다.** 이것이 PM2 위임의 핵심 주장이므로 반드시 눈으로 확인한다.
  죽어 있으면 프로세스가 워커의 자식으로 붙어 있다는 뜻이다.

- [ ] **`pm2 jlist` 형식 의존** — 위 항목들이 통과하면 파싱이 현재 PM2 버전과 맞는다는 뜻이다.
  단위 테스트는 가짜 `runPm2` 를 쓰므로 이 검증은 여기서만 가능하다. PM2 를 올린 뒤에는 다시 훑는다.
```

- [ ] **Step 3: 문서 검사와 커밋**

Run: `node scripts/check-docs.mjs`
Expected: `문서 검사 통과`

```bash
git add docs/security/capability-model.md deploy/smoke-test.md
git commit -m "docs: 장기 실행 프로세스의 한계와 스모크 항목"
```

- [ ] **Step 4: 미니PC 에 PM2 를 설치한다 (`asahi` 계정)**

```powershell
npm i -g pm2; pm2 --version
```

버전이 찍히면 성공이다. 안 찍히면 `asahi` 의 PATH 에 npm 전역 bin 이 없는 것이므로
`npm config get prefix` 로 경로를 확인해 PATH 에 넣는다.

- [ ] **Step 5: 주 1회 로테이션에 `pm2 flush` 를 더한다 (관리자 계정)**

`C:\ProgramData\asahi-maintenance\rotate-worker-log.ps1` 의 `Start-ScheduledTask` 앞에 한 줄을
넣는다. PM2 로그도 무한히 커지므로 같은 주기로 비운다.

```powershell
pm2 flush 2>$null
```

- [ ] **Step 6: 배포와 스모크**

브랜치를 머지하고, 미니PC 를 갱신한다. **워커 코드가 바뀌었으므로 갱신하지 않으면 proc 도구
넷만 조용히 실패한다.**

`asahi` 계정:
```powershell
cd C:\asahi-worker; git pull; cd agent; npm ci
```

관리자 계정:
```powershell
Stop-ScheduledTask -TaskName asahi-worker; Start-Sleep -Seconds 3; Start-ScheduledTask -TaskName asahi-worker
```

그 뒤 Step 2 의 스모크 항목을 순서대로 확인한다.

---

## Self-Review

**스펙 커버리지**

| 스펙 절 | 태스크 |
|---|---|
| §3 도구 넷과 신원 주입 | Task 2(실행기) · Task 3(주입) |
| §4 1인 1프로세스 | Task 2 Step 3 의 중복 거절 · Task 3 의 이름 주입 |
| §5 작업 폴더·데몬 수명 | Task 3(cwd 주입) · Task 5 Step 4·5(설치·flush) |
| §6 상태 조회·발견성 | Task 1(렌더링) · Task 2(`proc_start` 안내 문구) · Task 4(`/help`·페르소나) |
| §7 테스트 이음매 | Task 2 의 `runPm2` · Task 3 의 주입 테스트 |
| §8 설치와 문서 | Task 4 · Task 5 |
| §9 위험·한계 | Task 5 Step 1 |

**빠진 것 없음.** §2 "밖" 항목(상시 표시·트리 박스 문자·자원 상한·재부팅 복원)은 의도적으로
태스크가 없다.

**타입 일관성:** `ProcInfo.uptimeMs` 는 "시작 시각(ms)"이지 경과 시간이 아니다 — 이름이
오해를 부를 수 있어 Task 1 의 주석과 Task 1 Step 4 에서 명시했다. `renderProcList` 가 `now` 를
받아 경과로 바꾼다. `RunPm2` 의 반환은 `{ ok, stdout, stderr }` 로 Task 2 전체에서 동일하다.
