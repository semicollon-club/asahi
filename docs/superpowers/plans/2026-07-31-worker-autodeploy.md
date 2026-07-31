# 미니PC 워커 배포 자동화 구현 계획

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 워커가 낡았는지 보이게 하고(조각 A), 미니PC 가 스스로 갱신하게 한다(조각 B).

**Architecture:** 워커가 `git rev-parse HEAD` 로 자기 커밋을 읽어 `hello` 프레임에 **선택 필드**로 싣는다. 허브가 그것을 보관하고 `runtime_info` 로 노출하며, 봇 커밋과 15분 넘게 어긋나면 소유자 DM 에 한 번 알린다. 갱신은 미니PC 의 폴링 작업이 센티넬 파일을 만들면 워커가 진행 중인 호출을 마치고 0 이 아닌 코드로 종료하고, 작업 스케줄러의 재시작 정책이 다시 띄우는 방식이다 — `Stop`/`Start-ScheduledTask` 를 부르지 않으므로 비관리자 권한만으로 돈다.

**Tech Stack:** TypeScript (ESM/NodeNext), Node.js, vitest, PowerShell 5.1, Windows 작업 스케줄러

## Global Constraints

- TypeScript ESM/NodeNext — **상대 임포트는 반드시 `.js` 로 끝난다** (소스가 `.ts` 여도)
- 주석·커밋 메시지·사용자 노출 문자열은 전부 **한국어**
- 사용자 노출 문자열에 **이모지 금지** (진행 표시의 `✓`/`✗` 만 기존 예외)
- 주석은 *왜* 를 설명한다. 코드를 옮겨 적는 주석은 쓰지 않는다
- `agent/src/core/paths.ts` 와 `agent/src/remote/roots.ts` 는 읽기 전용 — 이 계획은 건드리지 않는다
- TDD: 실패하는 테스트를 먼저 쓰고 **실패를 눈으로 확인한 뒤** 구현한다
- 커밋: Conventional Commits + 한국어 제목, 본문 끝에 `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`
- 모든 npm 명령의 작업 디렉터리는 `agent/` 다
- 태스크 완료 전 `npm test` 와 `npm run typecheck` 가 모두 통과해야 한다
- 문서를 건드린 태스크는 리포 루트에서 `node scripts/check-docs.mjs` 가 `문서 검사 통과` 를 내야 한다

## 파일 구조

| 파일 | 역할 | 태스크 |
|---|---|---|
| `src/remote/protocol.ts` | `WorkerHello` 에 선택적 `commit` | 1 |
| `src/remote/gitCommit.ts` | **신규** — `readCommit` (spawn 주입) | 2 |
| `src/remote/workerClient.ts` | `commit` 을 hello 에 실어 보냄 | 2 |
| `src/worker.ts` | 커밋 읽어 주입 + 센티넬 감시 + 종료 배선 | 2, 6 |
| `src/remote/workerShutdown.ts` | **신규** — 종료 순서와 종료 코드(순수) | 6 |
| `src/remote/hub.ts` | `Conn` 에 `commit`·`connectedAt`, `workersInfo()` | 3 |
| `src/core/tools.ts` | `runtime_info` 가 워커 정보 표시 | 4 |
| `src/core/staleWorker.ts` | **신규** — 알림 판정(순수 함수) | 5 |
| `src/store/conversationsRepo.ts` | `findDmFor(userId)` 신규 | 5 |
| `src/index.ts` | 알림 배선(주기 확인) | 5 |
| `deploy/update-worker.ps1` | **신규** — 폴링 업데이터 | 7 |
| `deploy/worker-셋업.md`, `docs/agent-onboarding.md`, `deploy/smoke-test.md`, `docs/status/STATUS.md` | 문서 | 7 |

---

### Task 1: 프로토콜 — `hello` 의 선택적 `commit`

**Files:**
- Modify: `agent/src/remote/protocol.ts`
- Test: `agent/tests/remoteProtocol.test.ts`

**Interfaces:**
- Consumes: 없음
- Produces: `WorkerHello` 타입이 `commit?: string` 을 갖는다. `parseFrame` 은 `commit` 이 없는 hello 도, 문자열 `commit` 이 있는 hello 도 받아들이고, `commit` 이 문자열이 아니면 그 필드만 버린다.

**배경:** 이 필드가 **선택적**인 것이 이 태스크의 전부다. 필수로 만들면 옛 워커가 새 봇에 붙었을 때 `parseFrame` 이 `null` 을 돌려주고 허브가 소켓만 끊는다 — 그 워커는 거부 사유를 못 받으므로 3초마다 영원히 재연결을 시도한다(파일 상단 FIX6 주석 참고). 배포 창을 좁히려고 만드는 기능이 그 창을 최악으로 만들면 안 된다.

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`agent/tests/remoteProtocol.test.ts` 에 추가한다.

```ts
  it("hello 는 commit 이 없어도 정상 파싱된다(옛 워커 호환)", () => {
    // 이 단정이 옛 워커 호환의 유일한 방어선이다. commit 을 필수로 만들면 옛 워커가 붙지 못하고
    // 거부 사유도 못 받아 3초마다 영원히 재연결한다.
    const f = parseFrame(JSON.stringify({ type: "hello", token: "t", workerId: "w", roots: ["/r"] }));
    expect(f).toEqual({ type: "hello", token: "t", workerId: "w", roots: ["/r"] });
  });

  it("hello 의 commit 이 문자열이면 싣는다", () => {
    const f = parseFrame(JSON.stringify({ type: "hello", token: "t", workerId: "w", roots: ["/r"], commit: "abc123" }));
    expect(f).toEqual({ type: "hello", token: "t", workerId: "w", roots: ["/r"], commit: "abc123" });
  });

  it("hello 의 commit 이 문자열이 아니면 그 필드만 버리고 연결은 살린다", () => {
    // 형태가 어긋난 부가 정보 때문에 인증 자체가 실패하면 안 된다 — 버전은 몰라도 되지만
    // 연결은 되어야 한다.
    const f = parseFrame(JSON.stringify({ type: "hello", token: "t", workerId: "w", roots: ["/r"], commit: 42 }));
    expect(f).toEqual({ type: "hello", token: "t", workerId: "w", roots: ["/r"] });
  });
```

- [ ] **Step 2: 테스트를 돌려 실패를 확인**

```bash
cd agent && npx vitest run tests/remoteProtocol.test.ts -t "commit"
```

기대: FAIL — 두 번째·세 번째 테스트가 `commit` 없는 객체를 받아 불일치.

- [ ] **Step 3: 타입과 파서를 고친다**

`agent/src/remote/protocol.ts` 의 타입 선언을 바꾼다.

```ts
export type WorkerHello = { type: "hello"; token: string; workerId: string; roots: string[]; commit?: string };
```

`parseFrame` 의 `case "hello"` 를 바꾼다.

```ts
    case "hello":
      // commit 은 선택 필드다 — 없어도, 형태가 어긋나도 hello 자체는 통과시킨다. 이 프레임이
      // null 이 되면 허브가 소켓만 끊고 워커는 사유를 못 받아 영원히 재연결한다(파일 상단
      // FIX6 주석). 버전을 모르는 것이 연결을 못 하는 것보다 낫다.
      return isStr(v.token) && isStr(v.workerId) && isStrArray(v.roots)
        ? isStr(v.commit)
          ? { type: "hello", token: v.token, workerId: v.workerId, roots: v.roots, commit: v.commit }
          : { type: "hello", token: v.token, workerId: v.workerId, roots: v.roots }
        : null;
```

- [ ] **Step 4: 테스트가 통과하는지 확인**

```bash
cd agent && npx vitest run tests/remoteProtocol.test.ts
```

기대: PASS.

- [ ] **Step 5: 역전 시험**

Step 3 의 파서에서 `isStr(v.commit) ?` 갈래를 지우고 항상 `commit: v.commit` 을 싣도록 바꾼 뒤 돌린다. 세 번째 테스트가 **FAIL** 해야 한다. 그 다음 `commit` 을 필수로 만들어(`isStr(v.commit) &&` 를 조건에 추가) 첫 번째 테스트가 **FAIL** 하는지 확인한다. 둘 다 확인한 뒤 Step 3 의 형태로 되돌린다.

- [ ] **Step 6: 전체 검증**

```bash
cd agent && npm test && npm run typecheck
```

- [ ] **Step 7: 커밋**

```bash
git add agent/src/remote/protocol.ts agent/tests/remoteProtocol.test.ts
git commit -F - <<'EOF'
feat(remote): hello 프레임에 선택적 commit 필드를 더한다

워커가 어떤 커밋으로 도는지 봇이 알 수 있게 하는 첫 조각이다. 2026-07-31 에 워커가 4시간
뒤진 코드로 돌고 있다는 것을 아무도 몰라 실사용 결과를 전부 새 코드의 결함으로 오진했다.

선택 필드인 것이 핵심이다. 필수로 만들면 옛 워커의 hello 가 parseFrame 에서 null 이 되고,
허브는 사유 없이 소켓만 끊으며, 그 워커는 거부를 받지 못해 3초마다 영원히 재연결한다.
형태가 어긋난 commit 도 필드만 버리고 연결은 살린다 — 버전을 모르는 것이 연결을 못 하는
것보다 낫다.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
```

---

### Task 2: 워커가 자기 커밋을 읽어 hello 에 싣는다

**Files:**
- Create: `agent/src/remote/gitCommit.ts`
- Modify: `agent/src/remote/workerClient.ts`, `agent/src/worker.ts`
- Test: `agent/tests/gitCommit.test.ts` (신규), `agent/tests/remoteWorkerClient.test.ts`

**Interfaces:**
- Consumes: Task 1 의 `WorkerHello.commit?: string`
- Produces:
  - `export type RunGit = (args: string[]) => Promise<{ ok: boolean; stdout: string }>`
  - `export async function readCommit(runGit: RunGit): Promise<string | undefined>`
  - `WorkerClientOpts` 가 `commit?: string` 을 받는다

**배경:** `.git/HEAD` 를 직접 읽는 방법도 있으나 packed-refs 를 따로 다뤄야 한다. 이 워커는 `git pull` 로 갱신되므로 git 이 반드시 있고 이미 `spawn` 을 쓰는 프로세스다 — 명령 하나가 더 단순하고 정확하다.

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`agent/tests/gitCommit.test.ts` 를 새로 만든다.

```ts
import { describe, it, expect } from "vitest";
import { readCommit } from "../src/remote/gitCommit.js";

describe("readCommit", () => {
  it("git 이 성공하면 SHA 를 다듬어 돌려준다", async () => {
    const runGit = async (args: string[]) => {
      expect(args).toEqual(["rev-parse", "HEAD"]);
      return { ok: true, stdout: "abc1234def5678\n" };
    };
    expect(await readCommit(runGit)).toBe("abc1234def5678");
  });

  it("git 이 실패하면 undefined 를 돌려준다(연결은 계속한다)", async () => {
    const runGit = async () => ({ ok: false, stdout: "" });
    expect(await readCommit(runGit)).toBeUndefined();
  });

  it("git 이 던져도 undefined 를 돌려준다", async () => {
    // 리포가 아닌 곳에서 실행하거나 git 이 없을 때다. 여기서 던지면 워커가 아예 못 뜬다.
    const runGit = async () => { throw new Error("ENOENT"); };
    expect(await readCommit(runGit)).toBeUndefined();
  });

  it("출력이 비면 undefined 를 돌려준다", async () => {
    const runGit = async () => ({ ok: true, stdout: "  \n" });
    expect(await readCommit(runGit)).toBeUndefined();
  });
});
```

- [ ] **Step 2: 테스트를 돌려 실패를 확인**

```bash
cd agent && npx vitest run tests/gitCommit.test.ts
```

기대: FAIL — `Cannot find module '../src/remote/gitCommit.js'`.

- [ ] **Step 3: `gitCommit.ts` 를 만든다**

`agent/src/remote/gitCommit.ts`:

```ts
import { spawn } from "node:child_process";

// git 호출을 주입 가능한 이음매로 둔다 — 실제 git 없이 성패 양쪽을 테스트하기 위해서다
// (executors.ts 의 runPm2 와 같은 이유).
export type RunGit = (args: string[]) => Promise<{ ok: boolean; stdout: string }>;

export const defaultRunGit: RunGit = (args) =>
  new Promise((resolve) => {
    const child = spawn("git", args);
    let stdout = "";
    child.stdout.on("data", (c: Buffer) => { stdout += c.toString(); });
    child.on("error", () => resolve({ ok: false, stdout: "" }));
    child.on("close", (code) => resolve({ ok: code === 0, stdout }));
  });

// 워커가 지금 어떤 커밋으로 도는지. 실패하면 undefined 를 돌려주고 호출측은 그대로 진행한다 —
// 버전을 모르는 것이 워커가 아예 못 뜨는 것보다 낫다. 이 값은 부가 정보이지 동작 조건이 아니다.
export async function readCommit(runGit: RunGit): Promise<string | undefined> {
  try {
    const r = await runGit(["rev-parse", "HEAD"]);
    if (!r.ok) return undefined;
    const sha = r.stdout.trim();
    return sha.length > 0 ? sha : undefined;
  } catch {
    return undefined;
  }
}
```

- [ ] **Step 4: 테스트가 통과하는지 확인**

```bash
cd agent && npx vitest run tests/gitCommit.test.ts
```

기대: PASS (4건).

- [ ] **Step 5: `workerClient` 가 commit 을 실어 보내게 한다**

`agent/src/remote/workerClient.ts` 의 `WorkerClientOpts` 에 필드를 더한다.

```ts
export type WorkerClientOpts = {
  connect: () => ClientSocket;
  token: string;
  workerId: string;
  roots: string[];
  commit?: string;
  executors: Executors;
  onStatus?: (s: string) => void;
  retryDelayMs?: number;
};
```

hello 를 보내는 줄을 바꾼다.

```ts
        socket.send(encodeFrame({ type: "hello", token: opts.token, workerId: opts.workerId, roots: opts.roots, commit: opts.commit }));
```

- [ ] **Step 6: hello 전송 테스트를 더한다**

`agent/tests/remoteWorkerClient.test.ts` 의 `describe("워커 클라이언트", ...)` 안에 추가한다. 이 파일의 기존 `fakeSocket()`/`executors` 를 그대로 쓴다.

```ts
  it("commit 을 주면 hello 에 실어 보낸다", () => {
    const s = fakeSocket();
    const c = startWorkerClient({ connect: () => s.sock, token: "t", workerId: "owner", roots: ["/w"], commit: "abc123", executors });
    s.open();
    expect(s.sent[0]).toEqual({ type: "hello", token: "t", workerId: "owner", roots: ["/w"], commit: "abc123" });
    c.stop();
  });

  it("commit 이 없으면 hello 에 그 키가 실리지 않는다", () => {
    // commit: undefined 를 그대로 넘겨도 JSON.stringify 가 그 키를 통째로 생략하므로 옛 봇에는
    // 옛 형태 그대로 도착한다. 이 단정이 그것을 고정한다.
    const s = fakeSocket();
    const c = startWorkerClient({ connect: () => s.sock, token: "t", workerId: "owner", roots: ["/w"], executors });
    s.open();
    expect(s.sent[0]).toEqual({ type: "hello", token: "t", workerId: "owner", roots: ["/w"] });
    c.stop();
  });
```

주의: `fakeSocket` 의 `send` 는 `parseFrame` 을 통과시킨 결과를 담으므로, 첫 번째 테스트는 **Task 1 이 끝나야** 통과한다(파서가 `commit` 을 버리면 단정이 깨진다). 순서대로 진행하면 문제없다.

- [ ] **Step 7: `worker.ts` 가 커밋을 읽어 넘긴다**

`agent/src/worker.ts` 의 import 에 더한다.

```ts
import { readCommit, defaultRunGit } from "./remote/gitCommit.js";
```

`main()` 을 `async` 로 바꾸고, `startWorkerClient` 호출 전에 커밋을 읽어 넘긴다.

```ts
async function main() {
  try {
    const config = loadWorkerConfig();
    const { wrapped: executors, idle } = trackInFlight(makeExecutors(config.roots));
    // 기동 시 한 번만 읽는다 — 워커는 갱신될 때 재시작되므로 도는 동안 커밋이 바뀌지 않는다.
    const commit = await readCommit(defaultRunGit);
```

`startWorkerClient` 호출에 `commit` 을 더한다.

```ts
    const client = startWorkerClient({
      connect,
      token: config.workerToken,
      workerId: config.workerId,
      roots: config.roots,
      commit,
      executors,
      onStatus: (s) => console.log(`[worker] ${s}`),
    });
```

파일 맨 끝의 `main();` 을 바꾼다 — `main` 이 async 가 되었으므로 거부를 잡아야 한다.

```ts
void main();
```

기동 로그에도 커밋을 실어 사람이 콘솔에서 바로 볼 수 있게 한다.

```ts
    console.log(`로컬 워커가 시작되었습니다 (허브=${config.hubUrl}, 커밋=${commit ?? "알 수 없음"}, 폴더=${config.roots.join(", ")}).`);
```

- [ ] **Step 8: 전체 검증**

```bash
cd agent && npm test && npm run typecheck
```

- [ ] **Step 9: 커밋**

```bash
git add agent/src/remote/gitCommit.ts agent/src/remote/workerClient.ts agent/src/worker.ts agent/tests/gitCommit.test.ts agent/tests/remoteWorkerClient.test.ts
git commit -F - <<'EOF'
feat(remote): 워커가 자기 커밋을 읽어 hello 에 싣는다

git rev-parse HEAD 로 기동 시 한 번 읽는다 — 워커는 갱신될 때 재시작되므로 도는 동안
커밋이 바뀌지 않는다. .git/HEAD 를 직접 읽는 대신 git 을 부르는 이유는 packed-refs 를
따로 다루지 않아도 되기 때문이다. 이 워커는 git pull 로 갱신되므로 git 은 반드시 있다.

실패하면 undefined 를 돌려주고 그대로 진행한다. 이 값은 부가 정보이지 동작 조건이 아니다 —
버전을 모르는 것이 워커가 아예 못 뜨는 것보다 낫다. commit: undefined 는 JSON.stringify 가
키째 생략하므로 옛 봇에도 옛 형태 그대로 도착한다.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
```

---

### Task 3: 허브가 워커 커밋을 보관하고 노출한다

**Files:**
- Modify: `agent/src/remote/hub.ts`
- Test: `agent/tests/remoteHub.test.ts`

**Interfaces:**
- Consumes: Task 1 의 `WorkerHello.commit`
- Produces: `WorkerHub.workersInfo(): Array<{ workerId: string; commit?: string; connectedAt: number }>` — 현재 연결된 워커들의 정보. Task 4·5 가 쓴다.

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`agent/tests/remoteHub.test.ts` 의 `describe("WorkerHub — 인증", ...)` 안에 추가한다. 그 describe 의 `beforeEach` 가 만드는 `hub` 와 파일의 `fakeSocket()`/`flush()` 를 그대로 쓴다.

```ts
  it("인증된 워커의 커밋과 연결 시각을 보관한다", async () => {
    const s = fakeSocket();
    hub.handleConnection(s.sock);
    s.recv({ type: "hello", token: "good", workerId: "owner", roots: ["/w"], commit: "abc123" });
    await flush();
    const info = hub.workersInfo();
    expect(info).toHaveLength(1);
    expect(info[0]).toMatchObject({ workerId: "owner", commit: "abc123" });
    expect(typeof info[0].connectedAt).toBe("number");
  });

  it("커밋 없이 붙은 워커도 목록에 나온다(옛 워커)", async () => {
    const s = fakeSocket();
    hub.handleConnection(s.sock);
    s.recv({ type: "hello", token: "good", workerId: "owner", roots: ["/w"] });
    await flush();
    expect(hub.workersInfo()).toEqual([expect.objectContaining({ workerId: "owner", commit: undefined })]);
  });

  it("거부된 워커는 목록에 없다", async () => {
    const s = fakeSocket();
    hub.handleConnection(s.sock);
    s.recv({ type: "hello", token: "bad", workerId: "owner", roots: ["/w"], commit: "abc123" });
    await flush();
    expect(hub.workersInfo()).toEqual([]);
  });
```

- [ ] **Step 1b: `now` 주입 여부를 먼저 확인한다**

Step 3 의 `connectedAt: this.now()` 는 `WorkerHub` 에 이미 주입된 시계가 있다는 전제다. 생성자 옵션에 `now` 가 **없으면** 새로 만들지 말고 `Date.now()` 를 그대로 쓴다 — 이 값은 알림 판정에 쓰이지 않고(그 판정은 Task 5 가 자체 시계로 한다) 표시용이므로 주입할 이유가 없다. 위 테스트도 `typeof … === "number"` 만 단정하므로 어느 쪽이든 통과한다.

- [ ] **Step 2: 테스트를 돌려 실패를 확인**

```bash
cd agent && npx vitest run tests/remoteHub.test.ts -t "커밋"
```

기대: FAIL — `hub.workersInfo is not a function`.

- [ ] **Step 3: `Conn` 에 필드를 더한다**

`agent/src/remote/hub.ts` 의 `Conn` 타입을 바꾼다.

```ts
type Conn = { socket: HubSocket; roots: string[]; pending: Map<string, Pending>; pingTimer: ReturnType<typeof setInterval>; commit?: string; connectedAt: number };
```

`conns.set` 호출을 바꾼다.

```ts
            this.conns.set(id, { socket, roots, pending: new Map(), pingTimer: this.startPing(socket), commit: frame.commit, connectedAt: this.now() });
```

- [ ] **Step 4: 접근자를 더한다**

`isConnected` 옆에 넣는다.

```ts
  // 연결된 워커들의 버전 정보. DB 를 쓰지 않는 이유는 이것을 읽는 쪽(runtime_info)과 알림을
  // 내는 쪽이 모두 이 프로세스 안에 있기 때문이다. 봇이 재배포되면 초기화되지만 그때는
  // 어차피 새로운 비교가 시작되므로 무해하다.
  workersInfo(): Array<{ workerId: string; commit?: string; connectedAt: number }> {
    return [...this.conns.entries()].map(([workerId, c]) => ({ workerId, commit: c.commit, connectedAt: c.connectedAt }));
  }
```

- [ ] **Step 5: 테스트가 통과하는지 확인**

```bash
cd agent && npx vitest run tests/remoteHub.test.ts
```

기대: PASS.

- [ ] **Step 6: 역전 시험**

Step 3 의 `commit: frame.commit` 을 `commit: undefined` 로 바꾸고 돌린다. 첫 번째 테스트가 **FAIL** 해야 한다. 확인 후 되돌린다.

- [ ] **Step 7: 전체 검증**

```bash
cd agent && npm test && npm run typecheck
```

- [ ] **Step 8: 커밋**

```bash
git add agent/src/remote/hub.ts agent/tests/remoteHub.test.ts
git commit -F - <<'EOF'
feat(remote): 허브가 워커의 커밋과 연결 시각을 보관한다

workersInfo() 로 노출한다. DB 를 쓰지 않는 이유는 이 값을 읽는 쪽(runtime_info)과 알림을
내는 쪽이 모두 같은 프로세스 안에 있기 때문이다. 봇이 재배포되면 초기화되지만 그때는
어차피 새로운 비교가 시작되므로 무해하다.

커밋 없이 붙은 옛 워커도 목록에 나온다 — 그 경우 commit 이 undefined 일 뿐이다.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
```

---

### Task 4: `runtime_info` 가 워커 버전을 보여준다

**Files:**
- Modify: `agent/src/core/tools.ts`
- Test: `agent/tests/tools.test.ts`

**Interfaces:**
- Consumes: Task 3 의 `WorkerHub.workersInfo()`
- Produces: `RuntimeInfo` 에 `botCommit?: string` 과 `workers: Array<{ workerId: string; commit?: string; connectedAt: number }>` 가 있다.

**배경:** 봇 자신의 SHA 는 `process.env.RAILWAY_GIT_COMMIT_SHA` 다. 로컬 PM2 폴백에는 없으므로 **없으면 비교를 생략하고 워커 커밋만 보여준다.** 비교할 기준이 없는 것과 불일치는 다른 상태이고, 전자를 후자로 보고하면 거짓 경보가 된다.

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`agent/tests/tools.test.ts` 에 추가한다. 이 파일의 `ctx()` 헬퍼를 그대로 쓴다.

```ts
  it("runtime_info 는 워커의 커밋과 일치 여부를 보여준다", async () => {
    const c = await ctx({
      isOwner: true,
      isPrivate: true,
      runtime: {
        model: "m", sdkVersion: "s", deployTarget: "cloud", maxTurns: 30,
        botCommit: "abc1234",
        workers: [{ workerId: "semicolon-shared", commit: "abc1234", connectedAt: 1 }],
      },
    });
    const out = await runtimeInfoHandler(c);
    expect(out).toContain("semicolon-shared");
    expect(out).toContain("abc1234");
    expect(out).toContain("일치");
  });

  it("runtime_info 는 워커가 낡았으면 그렇게 말한다", async () => {
    const c = await ctx({
      isOwner: true,
      isPrivate: true,
      runtime: {
        model: "m", sdkVersion: "s", deployTarget: "cloud", maxTurns: 30,
        botCommit: "abc1234",
        workers: [{ workerId: "semicolon-shared", commit: "999zzzz", connectedAt: 1 }],
      },
    });
    expect(await runtimeInfoHandler(c)).toContain("다름");
  });

  it("봇 커밋을 모르면 비교하지 않는다(로컬 PM2)", async () => {
    // 비교할 기준이 없는 것과 불일치는 다른 상태다. 전자를 후자로 보고하면 거짓 경보가 된다.
    const c = await ctx({
      isOwner: true,
      isPrivate: true,
      runtime: {
        model: "m", sdkVersion: "s", deployTarget: "local", maxTurns: 30,
        workers: [{ workerId: "owner-laptop", commit: "abc1234", connectedAt: 1 }],
      },
    });
    const out = await runtimeInfoHandler(c);
    expect(out).toContain("abc1234");
    expect(out).not.toContain("다름");
    expect(out).not.toContain("일치");
  });
```

- [ ] **Step 2: 테스트를 돌려 실패를 확인**

```bash
cd agent && npx vitest run tests/tools.test.ts -t "runtime_info 는 워커"
```

기대: FAIL — 타입 오류 또는 출력에 워커 정보 없음.

- [ ] **Step 3: `RuntimeInfo` 타입을 넓힌다**

`agent/src/core/tools.ts`:

```ts
export type RuntimeInfo = {
  model: string;
  sdkVersion: string;
  deployTarget: "local" | "cloud";
  maxTurns: number;
  // Railway 가 주입하는 git 변수. 로컬 PM2 에는 없으므로 선택적이다 — 없으면 비교를 생략한다.
  botCommit?: string;
  workers: Array<{ workerId: string; commit?: string; connectedAt: number }>;
};
```

- [ ] **Step 4: 핸들러가 워커 줄을 낸다**

`runtimeInfoHandler` 를 바꾼다.

```ts
export async function runtimeInfoHandler(ctx: ToolCtx): Promise<string> {
  if (!isOwnerDm(ctx)) return OWNER_DM_ONLY;
  const r = ctx.runtime;
  const short = (sha: string) => sha.slice(0, 7);
  // botCommit 이 없으면(로컬 PM2) 판정 자체를 내지 않는다. "비교할 수 없음"을 "다름"으로
  // 보고하면 거짓 경보가 되고, 그 경보를 몇 번 보면 진짜 불일치도 무시하게 된다.
  const verdict = (workerCommit?: string): string => {
    if (r.botCommit === undefined || workerCommit === undefined) return "";
    return r.botCommit === workerCommit ? " (봇과 일치)" : " (봇과 다름 — 워커 갱신 필요)";
  };
  const workerLines =
    r.workers.length === 0
      ? ["워커: 붙어 있는 워커가 없어요."]
      : r.workers.map((w) => `워커 ${w.workerId}: 커밋 ${w.commit ? short(w.commit) : "알 수 없음"}${verdict(w.commit)}`);
  return [
    `모델(설정): ${r.model}`,
    `SDK: @anthropic-ai/claude-agent-sdk@${r.sdkVersion}`,
    `배포 대상: ${r.deployTarget}`,
    `봇 커밋: ${r.botCommit ? short(r.botCommit) : "알 수 없음"}`,
    ...workerLines,
    `한 응답 내 도구 반복 상한(maxTurns): ${r.maxTurns}`,
    `한도: 소유자는 무제한, 손님은 시간당 제한(유저별/전역).`,
  ].join("\n");
}
```

- [ ] **Step 5: 배선한다**

`agent/src/core/agent.ts` 의 `makeRunAgentTurn` 이 받는 `hub` 는 **구조적 타입**이라 쓰려는 메서드를 직접 적어야 한다(`agent.ts:264-268`). 거기에 한 줄을 더한다.

```ts
  hub?: {
    isConnected(workerId: string): boolean;
    call(workerId: string, tool: string, args: Record<string, unknown>): Promise<{ ok: boolean; content: string }>;
    rootsOf(workerId: string): string[];
    workersInfo(): Array<{ workerId: string; commit?: string; connectedAt: number }>;
  },
```

`agent.ts:271` 을 바꾼다.

```ts
    const runtime: RuntimeInfo = { model, sdkVersion: SDK_VERSION, deployTarget, maxTurns: 30, botCommit: process.env.RAILWAY_GIT_COMMIT_SHA, workers: hub?.workersInfo() ?? [] };
```

`hub` 는 선택적 인자다 — 허브 없이 도는 경로(테스트, 유휴 요약 턴)에서는 빈 배열이 맞다. 실제 배선은 `index.ts:123` 이 이미 `makeRunAgentTurn(..., repos.workers, hub)` 로 허브를 넘기고 있어 더 손댈 곳이 없다.

- [ ] **Step 5b: 기존 `RuntimeInfo` 리터럴을 고친다**

`workers` 를 **필수** 필드로 두었으므로 기존 리터럴이 전부 타입 오류가 난다. 선택적으로 만들지 않는 이유는, 빠뜨린 자리가 조용히 빈 목록이 되는 대신 컴파일 때 드러나는 편이 낫기 때문이다. `npm run typecheck` 가 짚어주는 곳을 전부 고친다 — `agent/tests/tools.test.ts` 의 `runtime:` 리터럴들(32·51·267행 부근)이 알려진 대상이며, 각각 `workers: []` 를 더하면 된다. typecheck 가 그 밖의 자리를 더 짚으면 같은 방식으로 처리한다.

- [ ] **Step 6: 테스트가 통과하는지 확인**

```bash
cd agent && npx vitest run tests/tools.test.ts
```

기대: PASS.

- [ ] **Step 7: 역전 시험**

Step 4 의 `if (r.botCommit === undefined ...) return "";` 을 지우고 돌린다. 세 번째 테스트("봇 커밋을 모르면 비교하지 않는다")가 **FAIL** 해야 한다. 확인 후 되돌린다.

- [ ] **Step 8: 전체 검증**

```bash
cd agent && npm test && npm run typecheck
```

- [ ] **Step 9: 커밋**

```bash
git add agent/src/core/tools.ts agent/src/core/agent.ts agent/tests/tools.test.ts
git commit -F - <<'EOF'
feat(core): runtime_info 가 워커 커밋과 일치 여부를 보여준다

소유자가 언제든 "지금 워커가 어떤 코드로 돌고 있나"를 물어볼 수 있게 한다. 2026-07-31 에
그것을 알 방법이 없어 4시간을 태웠다.

봇 커밋은 Railway 가 주입하는 RAILWAY_GIT_COMMIT_SHA 다. 로컬 PM2 에는 없으므로 없으면
비교 자체를 생략한다 — "비교할 수 없음"을 "다름"으로 보고하면 거짓 경보가 되고, 그 경보를
몇 번 보면 진짜 불일치도 무시하게 된다.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
```

---

### Task 5: 불일치 알림 — 15분 게이트와 중복 방지

**Files:**
- Create: `agent/src/core/staleWorker.ts`
- Modify: `agent/src/store/conversationsRepo.ts`, `agent/src/index.ts`
- Test: `agent/tests/staleWorker.test.ts` (신규), `agent/tests/identityRepos.test.ts`

**Interfaces:**
- Consumes: Task 3 의 `workersInfo()`
- Produces:
  - `export type StaleState = Map<string, number>` — 키는 `${workerId}:${workerCommit}:${botCommit}`, 값은 처음 어긋난 시각(ms)
  - `export function decideStaleAlerts(o: { workers: Array<{ workerId: string; commit?: string }>; botCommit?: string; now: number; state: StaleState; thresholdMs: number }): string[]` — 이번에 알려야 할 문구들. 부작용으로 `state` 를 갱신한다
  - `ConversationsRepo.findDmFor(userId: string): Promise<Conversation | null>`

**배경 — 이 태스크의 핵심 판단:** 불일치는 **정상 상태이기도 하다.** 봇이 배포되고 워커가 갱신되기까지 반드시 어긋난다. "다르면 즉시 경고"는 배포마다 울려 금방 무시당하고, 그러면 정작 필요한 날 보지 않게 된다. 조각 B 가 5분 주기이므로 **15분을 넘겼다는 것은 자동 갱신이 실제로 막혔다**는 뜻이다.

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`agent/tests/staleWorker.test.ts` 를 새로 만든다.

```ts
import { describe, it, expect } from "vitest";
import { decideStaleAlerts, type StaleState } from "../src/core/staleWorker.js";

const MIN = 60_000;
const T = 15 * MIN;

describe("decideStaleAlerts", () => {
  it("불일치가 임계 미만이면 알리지 않는다(정상 배포 창)", () => {
    const state: StaleState = new Map();
    const args = { workers: [{ workerId: "w", commit: "old" }], botCommit: "new", now: 0, state, thresholdMs: T };
    expect(decideStaleAlerts(args)).toEqual([]);
    expect(decideStaleAlerts({ ...args, now: 14 * MIN })).toEqual([]);
  });

  it("임계를 넘기면 한 번 알린다", () => {
    const state: StaleState = new Map();
    const args = { workers: [{ workerId: "w", commit: "old" }], botCommit: "new", state, thresholdMs: T };
    decideStaleAlerts({ ...args, now: 0 });
    const out = decideStaleAlerts({ ...args, now: 16 * MIN });
    expect(out).toHaveLength(1);
    expect(out[0]).toContain("w");
  });

  it("같은 조합으로 두 번 알리지 않는다", () => {
    const state: StaleState = new Map();
    const args = { workers: [{ workerId: "w", commit: "old" }], botCommit: "new", state, thresholdMs: T };
    decideStaleAlerts({ ...args, now: 0 });
    decideStaleAlerts({ ...args, now: 16 * MIN });
    expect(decideStaleAlerts({ ...args, now: 30 * MIN })).toEqual([]);
  });

  it("일치하면 알리지 않고 그 조합의 기록을 지운다", () => {
    const state: StaleState = new Map();
    decideStaleAlerts({ workers: [{ workerId: "w", commit: "old" }], botCommit: "new", now: 0, state, thresholdMs: T });
    expect(state.size).toBe(1);
    decideStaleAlerts({ workers: [{ workerId: "w", commit: "new" }], botCommit: "new", now: MIN, state, thresholdMs: T });
    expect(state.size).toBe(0);
  });

  it("봇 커밋을 모르면 아무 판정도 하지 않는다", () => {
    const state: StaleState = new Map();
    const out = decideStaleAlerts({ workers: [{ workerId: "w", commit: "old" }], botCommit: undefined, now: 99 * MIN, state, thresholdMs: T });
    expect(out).toEqual([]);
    expect(state.size).toBe(0);
  });

  it("워커 커밋을 모르면 판정하지 않는다(옛 워커)", () => {
    const state: StaleState = new Map();
    const out = decideStaleAlerts({ workers: [{ workerId: "w", commit: undefined }], botCommit: "new", now: 99 * MIN, state, thresholdMs: T });
    expect(out).toEqual([]);
  });
});
```

- [ ] **Step 2: 테스트를 돌려 실패를 확인**

```bash
cd agent && npx vitest run tests/staleWorker.test.ts
```

기대: FAIL — `Cannot find module '../src/core/staleWorker.js'`.

- [ ] **Step 3: `staleWorker.ts` 를 만든다**

`agent/src/core/staleWorker.ts`:

```ts
// 워커가 봇보다 낡았는지 판정하고, 언제 알릴지 정한다.
//
// 불일치 자체는 정상 상태이기도 하다 — 봇이 배포되고 워커가 갱신되기까지 반드시 어긋난다.
// 그래서 "다르면 즉시 알림"은 배포마다 울려 금방 무시당하고, 그러면 정작 갱신이 진짜로 막힌
// 날에도 보지 않게 된다. 자동 갱신이 5분 주기이므로 임계(기본 15분)를 넘겼다는 것은 그
// 자동화가 실제로 막혔다는 뜻이다 — 그때만 울린다.
//
// 키에 두 커밋을 모두 넣는 이유: 봇이 다시 배포되면 "새로운 불일치"이므로 다시 셈을 시작해야
// 한다. workerId 만으로 키를 잡으면 한 번 알린 뒤로는 어떤 새 불일치도 알리지 못한다.
export type StaleState = Map<string, number>;

export function decideStaleAlerts(o: {
  workers: Array<{ workerId: string; commit?: string }>;
  botCommit?: string;
  now: number;
  state: StaleState;
  thresholdMs: number;
}): string[] {
  // 비교할 기준이 없으면 아무 판정도 하지 않는다. "모른다"를 "낡았다"로 보고하면 거짓 경보다.
  if (o.botCommit === undefined) return [];
  const alerts: string[] = [];
  const live = new Set<string>();
  for (const w of o.workers) {
    if (w.commit === undefined) continue; // 옛 워커 — 판정할 근거가 없다
    const key = `${w.workerId}:${w.commit}:${o.botCommit}`;
    if (w.commit === o.botCommit) {
      o.state.delete(key);
      continue;
    }
    live.add(key);
    const since = o.state.get(key);
    if (since === undefined) {
      o.state.set(key, o.now);
      continue;
    }
    // -1 은 "이미 알렸다"는 표식이다. 같은 조합으로 다시 울리지 않는다.
    if (since === -1) continue;
    if (o.now - since >= o.thresholdMs) {
      o.state.set(key, -1);
      alerts.push(
        `워커 ${w.workerId} 가 ${Math.round((o.now - since) / 60_000)}분째 낡은 코드로 돌고 있어요 ` +
          `(워커 ${w.commit.slice(0, 7)} / 봇 ${o.botCommit.slice(0, 7)}). 자동 갱신이 막혔을 수 있어요 — ` +
          `미니PC 의 갱신 작업을 확인해 주세요.`,
      );
    }
  }
  return alerts;
}
```

- [ ] **Step 4: 테스트가 통과하는지 확인**

```bash
cd agent && npx vitest run tests/staleWorker.test.ts
```

기대: PASS (6건).

- [ ] **Step 5: `findDmFor` 를 더한다**

`agent/src/store/conversationsRepo.ts` 에 메서드를 더한다. 이 파일의 다른 메서드가 행을 `Conversation` 으로 바꾸는 방식을 그대로 따른다.

```ts
  // 소유자에게 능동적으로 알리려면 보낼 채널이 필요한데, 지금까지 이 리포에는 "이 사람의 DM
  // 대화" 를 찾는 경로가 없었다(전부 채널 id 나 대화 id 로 찾는다). 알림은 대화가 이미 있을
  // 때만 나간다 — 없으면 호출측이 로그로만 남긴다.
  async findDmFor(userId: string): Promise<Conversation | null> {
    const r = await this.db.query(
      "SELECT * FROM conversations WHERE kind = 'dm' AND primary_user_id = $1 ORDER BY last_active_ts DESC NULLS LAST LIMIT 1",
      [userId],
    );
    // 행→Conversation 변환은 getByChannelId 가 쓰는 것을 그대로 쓴다.
    return r.rows.length > 0 ? toConversation(r.rows[0]) : null;
  }
```

**구현 전에 `getByChannelId` 를 읽는다.** 그 메서드가 행을 `Conversation` 으로 바꾸는 방식(공유 헬퍼든 인라인 매핑이든)을 그대로 복사한다 — `toConversation` 이라는 이름의 헬퍼가 없으면 **새로 만들지 않는다.** 컬럼명(`kind`, `primary_user_id`, `last_active_ts`)도 그 메서드의 SQL 에서 실제 이름을 확인하고 맞춘다. 위 SQL 은 마이그레이션 기준의 이름이지만, 어긋나면 그 메서드가 정답이다.

- [ ] **Step 6: `findDmFor` 테스트를 더한다**

`agent/tests/identityRepos.test.ts` 의 `ConversationsRepo` describe 안에 추가한다.

```ts
  it("findDmFor 는 그 사용자의 DM 대화를 찾는다", async () => {
    const db = await openTestDb();
    const repo = new ConversationsRepo(db);
    await repo.create({ kind: "dm", discordChannelId: "dm-1", primaryUserId: "owner", isPrivate: true, lastActiveTs: 10 });
    await repo.create({ kind: "thread", discordChannelId: "th-1", primaryUserId: "owner", isPrivate: false, lastActiveTs: 20 });

    const found = await repo.findDmFor("owner");
    expect(found?.discordChannelId).toBe("dm-1"); // 스레드가 더 최근이어도 DM 을 고른다
    expect(await repo.findDmFor("nobody")).toBeNull();
  });
```

- [ ] **Step 7: `index.ts` 에 배선한다**

`index.ts` 에는 필요한 것이 전부 이미 있다: `conversations`(46행), `hub`(67행), `bus`(119행), `config.ownerId`. 기존 `idleTimer`(175행) 옆에 같은 방식으로 타이머를 하나 더 둔다. 결과가 있으면 소유자 DM 으로 `system_notice` 를 발행하고, 대화가 없으면 `console.error` 로만 남긴다.

```ts
  // 워커가 낡은 채로 오래 있으면 소유자에게 알린다. 주기는 조각 B 의 폴링(5분)과 맞춘다 —
  // 그보다 자주 봐야 할 이유가 없다.
  const staleState: StaleState = new Map();
  setInterval(() => {
    const alerts = decideStaleAlerts({
      workers: hub.workersInfo(),
      botCommit: process.env.RAILWAY_GIT_COMMIT_SHA,
      now: Date.now(),
      state: staleState,
      thresholdMs: 15 * 60_000,
    });
    if (alerts.length === 0) return;
    void conversations.findDmFor(config.ownerId).then((conv) => {
      for (const text of alerts) {
        if (conv === null) { console.error("[stale]", text); continue; }
        bus.publish({ type: "system_notice", channel: "discord", channelRef: conv.discordChannelId, text, ts: Date.now() });
      }
    });
  }, 5 * 60_000);
```

`hub`·`conversations`·`bus`·`config` 는 `index.ts` 가 이미 만들어 둔 것을 쓴다. import 를 더한다.

```ts
import { decideStaleAlerts, type StaleState } from "./core/staleWorker.js";
```

- [ ] **Step 8: 역전 시험**

Step 3 의 `if (since === -1) continue;` 를 지우고 돌린다. "같은 조합으로 두 번 알리지 않는다" 가 **FAIL** 해야 한다. 그 다음 `if (o.botCommit === undefined) return [];` 을 지워 "봇 커밋을 모르면" 테스트가 **FAIL** 하는지 확인한다. 둘 다 확인 후 되돌린다.

- [ ] **Step 9: 전체 검증**

```bash
cd agent && npm test && npm run typecheck
```

- [ ] **Step 10: 커밋**

```bash
git add agent/src/core/staleWorker.ts agent/src/store/conversationsRepo.ts agent/src/index.ts agent/tests/staleWorker.test.ts agent/tests/identityRepos.test.ts
git commit -F - <<'EOF'
feat(core): 워커가 오래 낡아 있으면 소유자에게 한 번 알린다

불일치 자체는 정상 상태이기도 하다 — 봇이 배포되고 워커가 갱신되기까지 반드시 어긋난다.
그래서 즉시 알리면 배포마다 울려 금방 무시당하고, 정작 갱신이 진짜로 막힌 날에도 보지
않게 된다. 자동 갱신이 5분 주기이므로 15분 초과는 그 자동화가 실제로 막혔다는 뜻이다.

상태 키에 두 커밋을 모두 넣는다 — 봇이 다시 배포되면 새로운 불일치이므로 셈을 다시
시작해야 한다. workerId 만으로 키를 잡으면 한 번 알린 뒤 어떤 새 불일치도 못 알린다.

알림을 보내려면 채널이 필요한데 ConversationsRepo 에 "이 사람의 DM" 을 찾는 경로가
없어 findDmFor 를 더했다. 대화가 없으면 로그로만 남긴다.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
```

---

### Task 6: 센티넬 — 워커가 한가할 때 스스로 종료한다

**Files:**
- Create: `agent/src/remote/workerShutdown.ts`
- Modify: `agent/src/worker.ts`, `agent/src/config.ts`
- Test: `agent/tests/workerShutdown.test.ts` (신규)

**Interfaces:**
- Consumes: 없음
- Produces:
  - `export const EXIT_CODE_UPDATE = 10`
  - `export async function planShutdown(o: { reason: "signal" | "update"; stopSocket: () => void; idle: () => Promise<void>; idleTimeoutMs: number }): Promise<number>`
  - 워커가 `WORKER_SENTINEL` 경로의 파일을 감지하면 진행 중인 호출을 마치고 `EXIT_CODE_UPDATE` 로 종료한다. Task 7 의 스크립트가 그 파일을 만든다.

**왜 별도 파일인가:** `worker.ts` 는 맨 아래에서 `main()` 을 실행한다 — 테스트가 그 모듈을 import 하면 **워커가 실제로 뜬다.** 종료 순서는 이 기능의 핵심이라 반드시 테스트해야 하므로, 그 로직은 부작용 없는 모듈에 있어야 한다.

**배경 — 이 태스크의 두 결정:**

**① 순서를 뒤집는다.** 오늘의 `shutdown()` 은 `client.stop()` 으로 소켓을 먼저 닫고 그 다음 `idle()` 을 기다린다 — 그래서 진행 중이던 호출의 결과 프레임이 허브까지 돌아가지 못한다(그 파일의 FIX8 주석이 이 한계를 명시한다). 사람이 일부러 멈출 때는 그것으로 충분했지만, 자동 갱신에서는 **부원이 시킨 작업이 조용히 실패**하는 것을 뜻한다. 센티넬 경로는 `idle()` 을 먼저 기다리고 그 다음 소켓을 닫는다.

**② 종료 코드가 "돌아올지"를 정한다.** 작업 스케줄러의 "실패 시 다시 시작" 정책은 0 이 아닌 종료에만 반응한다. SIGTERM(사람이 멈춤)은 `0` 으로 남겨 **머물고**, 센티넬은 0 이 아닌 값으로 끝나 **돌아온다**. 이 구분이 없으면 사람이 일부러 내린 워커를 스케줄러가 도로 띄운다.

**센티넬 파일은 `WORKER_ROOTS` 밖에 둔다** — 안에 두면 `fs_write` 로 회원이 만들어 워커를 계속 재시작시킬 수 있다. 다만 이것을 보안 경계로 착각하면 안 된다: `sh_exec` 는 경로 스코프의 대상이 아니라 회원은 셸로 어디든 파일을 만들 수 있고 애초에 워커 프로세스를 직접 죽일 수도 있다. 새 능력을 열지 않는다.

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`agent/tests/workerShutdown.test.ts` 를 새로 만든다. 순수 로직만 검증하므로 실제 파일 감시나 프로세스 종료는 쓰지 않는다.

```ts
import { describe, it, expect } from "vitest";
import { planShutdown, EXIT_CODE_UPDATE } from "../src/remote/workerShutdown.js";

describe("planShutdown — 종료 경로", () => {
  it("사람이 멈추면 소켓을 먼저 닫고 0 으로 끝낸다", async () => {
    const order: string[] = [];
    const code = await planShutdown({
      reason: "signal",
      stopSocket: () => { order.push("stop"); },
      idle: async () => { order.push("idle"); },
      idleTimeoutMs: 1000,
    });
    expect(order).toEqual(["stop", "idle"]);
    expect(code).toBe(0);
  });

  it("갱신이면 한가해질 때까지 기다린 뒤 소켓을 닫고 0 이 아닌 코드로 끝낸다", async () => {
    // 순서가 뒤집히면 진행 중이던 호출의 결과가 허브에 못 돌아간다 — 부원이 시킨 작업이
    // 조용히 실패한다. "한가할 때 갱신한다"가 참이 되려면 idle 이 먼저다.
    const order: string[] = [];
    const code = await planShutdown({
      reason: "update",
      stopSocket: () => { order.push("stop"); },
      idle: async () => { order.push("idle"); },
      idleTimeoutMs: 1000,
    });
    expect(order).toEqual(["idle", "stop"]);
    expect(code).toBe(EXIT_CODE_UPDATE);
    expect(EXIT_CODE_UPDATE).not.toBe(0);
  });

  it("갱신인데 오래 안 한가해지면 기다림을 포기하고 그래도 끝낸다", async () => {
    // 상한이 없으면 120초짜리 sh_exec 하나가 갱신을 영원히 막는다.
    const order: string[] = [];
    const code = await planShutdown({
      reason: "update",
      stopSocket: () => { order.push("stop"); },
      idle: () => new Promise<void>(() => {}), // 영원히 안 끝난다
      idleTimeoutMs: 10,
    });
    expect(order).toEqual(["stop"]);
    expect(code).toBe(EXIT_CODE_UPDATE);
  });
});
```

- [ ] **Step 2: 테스트를 돌려 실패를 확인**

```bash
cd agent && npx vitest run tests/workerShutdown.test.ts
```

기대: FAIL — `Cannot find module '../src/remote/workerShutdown.js'`.

- [ ] **Step 3: `workerShutdown.ts` 를 만든다**

`agent/src/remote/workerShutdown.ts` 를 새로 만든다.

```ts
// 갱신으로 인한 종료는 0 이 아닌 코드로 끝낸다. 작업 스케줄러의 "실패 시 다시 시작" 정책이
// 0 이 아닌 종료에만 반응하므로, 이 값이 곧 "돌아온다"는 뜻이다 — 반대로 사람이 SIGTERM 으로
// 내린 워커는 0 으로 끝나 스케줄러가 도로 띄우지 않는다. 구체적인 숫자에는 의미가 없다.
export const EXIT_CODE_UPDATE = 10;

// 종료 순서를 정한다. 순수 함수로 뺀 이유는 실제 소켓·프로세스 없이 순서와 코드를 고정하기
// 위해서다 — 이 순서가 이 기능의 전부이기 때문이다.
//
// signal(사람이 멈춤): 소켓을 먼저 닫는다. 예전부터의 동작이고, 사람이 지켜보는 상황이라
// 진행 중 호출 하나가 결과를 못 돌려줘도 무방하다.
// update(갱신): idle 을 먼저 기다린다. 소켓을 먼저 닫으면 진행 중이던 호출의 결과 프레임이
// 허브까지 못 가고, 부원이 시킨 작업이 조용히 실패한다 — "한가할 때 갱신한다"가 거짓이 된다.
// 다만 무한정 기다리지 않는다: sh_exec 는 기본 120초까지 갈 수 있어 상한이 없으면 갱신이
// 영원히 막힌다. 상한을 넘기면 signal 과 같은 순서로 떨어진다.
export async function planShutdown(o: {
  reason: "signal" | "update";
  stopSocket: () => void;
  idle: () => Promise<void>;
  idleTimeoutMs: number;
}): Promise<number> {
  if (o.reason === "signal") {
    o.stopSocket();
    await o.idle();
    return 0;
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    o.idle(),
    new Promise<void>((resolve) => { timer = setTimeout(resolve, o.idleTimeoutMs); }),
  ]);
  if (timer !== undefined) clearTimeout(timer);
  o.stopSocket();
  return EXIT_CODE_UPDATE;
}
```

- [ ] **Step 4: 테스트가 통과하는지 확인**

```bash
cd agent && npx vitest run tests/workerShutdown.test.ts
```

기대: PASS (3건).

- [ ] **Step 5: `worker.ts` 가 그것을 쓰게 한다**

import 를 더한다.

```ts
import { planShutdown } from "./remote/workerShutdown.js";
```

기존 `shutdown` 을 바꾼다.

```ts
    const IDLE_TIMEOUT_MS = 130_000; // sh_exec 기본 상한(120초)보다 조금 길게

    const finish = (reason: "signal" | "update") => {
      console.log(reason === "update" ? "갱신을 위해 워커를 종료합니다..." : "워커 종료 중...");
      void planShutdown({
        reason,
        stopSocket: () => client.stop(),
        idle,
        idleTimeoutMs: IDLE_TIMEOUT_MS,
      }).then((code) => process.exit(code));
    };
    process.on("SIGINT", () => finish("signal"));
    process.on("SIGTERM", () => finish("signal"));
```

- [ ] **Step 6: 센티넬 감시를 더한다**

`config.ts` 의 `loadWorkerConfig` 에 `sentinelPath` 를 더한다 — `process.env.WORKER_SENTINEL` 이 없으면 감시하지 않는다(옵트인).

`worker.ts` 의 `main` 안, `finish` 정의 뒤에 넣는다.

```ts
    // 센티넬 파일이 생기면 갱신 요청이다. fs.watch 대신 주기 확인을 쓰는 이유는 윈도우에서
    // watch 가 파일 생성에 대해 플랫폼마다 다르게 동작해 왔기 때문이다 — 15초 지연은 5분
    // 주기의 업데이터에게 아무 문제가 되지 않는다.
    if (config.sentinelPath !== undefined) {
      const sentinel = config.sentinelPath;
      const timer = setInterval(() => {
        if (!fs.existsSync(sentinel)) return;
        clearInterval(timer);
        finish("update");
      }, 15_000);
    }
```

`import fs from "node:fs";` 를 파일 상단에 더한다.

- [ ] **Step 7: 전체 검증**

```bash
cd agent && npm test && npm run typecheck
```

- [ ] **Step 8: 커밋**

```bash
git add agent/src/remote/workerShutdown.ts agent/src/worker.ts agent/src/config.ts agent/tests/workerShutdown.test.ts
git commit -F - <<'EOF'
feat(worker): 센티넬 파일을 보면 한가해진 뒤 스스로 종료한다

미니PC 자동 갱신의 절반이다. 업데이터는 센티넬 파일만 만들고 워커가 바쁜지 전혀 모른다 —
"한가한가"를 실제로 아는 쪽이 판단한다.

두 가지를 정한다.

종료 순서: 갱신 경로는 idle 을 먼저 기다리고 그 다음 소켓을 닫는다. 기존 순서(소켓 먼저)는
진행 중이던 호출의 결과 프레임이 허브에 못 가게 하는데(FIX8 주석), 사람이 지켜보는 종료에서는
무방해도 자동 갱신에서는 부원이 시킨 작업이 조용히 실패하는 것을 뜻한다. 다만 상한을 둔다 —
120초짜리 sh_exec 하나가 갱신을 영원히 막으면 안 된다.

종료 코드: 갱신은 0 이 아닌 값으로 끝나 작업 스케줄러의 재시작 정책이 띄운다. SIGTERM 은
0 으로 남겨 사람이 일부러 내린 워커를 스케줄러가 도로 띄우지 않게 한다. 이 덕분에 Stop/
Start-ScheduledTask 를 아예 부르지 않아도 되고, 비관리자 계정 권한만으로 갱신이 돈다.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
```

---

### Task 7: 업데이터 스크립트와 문서

**Files:**
- Create: `deploy/update-worker.ps1`
- Modify: `deploy/worker-셋업.md`, `docs/agent-onboarding.md`, `deploy/smoke-test.md`, `docs/status/STATUS.md`

**Interfaces:**
- Consumes: Task 6 의 센티넬 규약과 종료 코드
- Produces: 없음

**배경:** 이 스크립트와 작업 스케줄러 설정은 **유닛 테스트가 닿지 않는다** — `runPm2` 같은 주입 지점 너머와 같은 성격이다. 계획 단계에서 그 사실을 의식하고, 스모크 항목으로 옮긴다. 첫 배포는 사람이 지켜본다.

- [ ] **Step 1: 업데이터 스크립트를 쓴다**

`deploy/update-worker.ps1` 을 만든다. 리포 안에 두므로 스크립트 자신도 `git pull` 로 갱신된다.

```powershell
# 미니PC 워커 자동 갱신. asahi 계정의 작업 스케줄러 작업이 5분마다 부른다.
#
# Stop/Start-ScheduledTask 를 부르지 않는다 — asahi 는 표준 계정이라 그 권한이 없다. 대신
# 센티넬 파일을 만들면 워커가 진행 중인 호출을 마치고 0 이 아닌 코드로 스스로 종료하고,
# 작업 스케줄러의 "실패 시 다시 시작" 정책이 다시 띄운다.
param(
  [string]$RepoPath = "C:\asahi-worker",
  [string]$Sentinel = "C:\asahi-worker-update.flag",
  [int]$WaitSeconds = 300
)

Set-Location $RepoPath

git fetch origin main 2>&1 | Out-Null
$local = (git rev-parse HEAD).Trim()
$remote = (git rev-parse origin/main).Trim()
if ($local -eq $remote) { exit 0 }

Write-Output "새 커밋 발견: $($local.Substring(0,7)) -> $($remote.Substring(0,7))"

# 워커에게 "끝나면 나가라"고 알린다. 언제 나갈지는 워커가 정한다.
New-Item -ItemType File -Path $Sentinel -Force | Out-Null

# 워커가 사라지기를 기다린다. 강제 종료하지 않는다 — 안 죽는 워커는 그 자체로 조사할 일이고,
# 자동화가 그것을 덮으면 안 된다. 못 기다리면 이번 회차를 포기하고 다음 5분에 다시 시도한다.
$deadline = (Get-Date).AddSeconds($WaitSeconds)
while ((Get-Date) -lt $deadline) {
  $running = Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
    Where-Object { $_.CommandLine -like "*$RepoPath*" }
  if (-not $running) { break }
  Start-Sleep -Seconds 5
}

$still = Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
  Where-Object { $_.CommandLine -like "*$RepoPath*" }
if ($still) {
  Remove-Item $Sentinel -Force -ErrorAction SilentlyContinue
  Write-Output "워커가 시간 안에 종료되지 않아 이번 회차를 건너뜁니다."
  exit 0
}

$lockBefore = (Get-FileHash "$RepoPath\agent\package-lock.json").Hash
git pull --ff-only
$lockAfter = (Get-FileHash "$RepoPath\agent\package-lock.json").Hash

# npm ci 는 잠금 파일이 바뀐 커밋에만 돌린다. 대부분의 커밋은 의존성을 건드리지 않는데,
# 19초 걸리는 그 명령이 바로 esbuild.exe 잠금 때문에 워커 정지를 강제하는 원인이다.
if ($lockBefore -ne $lockAfter) {
  Write-Output "package-lock.json 이 바뀌어 npm ci 를 실행합니다."
  Set-Location "$RepoPath\agent"
  npm ci
  Set-Location $RepoPath
}

Remove-Item $Sentinel -Force -ErrorAction SilentlyContinue
Write-Output "갱신 완료: $((git rev-parse HEAD).Substring(0,7)). 작업 스케줄러가 워커를 다시 띄웁니다."
```

- [ ] **Step 2: 스크립트가 문법적으로 유효한지 확인**

```bash
powershell -NoProfile -Command "[void][System.Management.Automation.PSParser]::Tokenize((Get-Content -Raw 'deploy/update-worker.ps1'), [ref]$null); Write-Output 'OK'"
```

기대: `OK`. 실행하지는 않는다 — 실제 동작은 미니PC 에서만 검증된다.

- [ ] **Step 3: `worker-셋업.md` 에 등록 절차를 더한다**

"자동 갱신" 절을 새로 만들어 다음을 적는다. 문서의 기존 목소리(왜를 설명하는 밀도)에 맞춘다.

- `asahi-worker` 작업에 **"작업이 실패하면 다시 시작"** 정책을 켜야 한다는 것과, 그것이 이 설계의 전제라는 것(워커가 0 이 아닌 코드로 스스로 나가면 그 정책이 띄운다)
- `asahi-worker-update` 작업 등록: `asahi` 계정, 5분 주기, `powershell.exe -NoProfile -ExecutionPolicy Bypass -File C:\asahi-worker\deploy\update-worker.ps1`
- **반드시 별개의 작업이어야 한다** — 업데이터를 워커 프로세스의 자식으로 띄우면 작업 스케줄러의 잡 오브젝트가 워커를 정리할 때 업데이터도 함께 죽는다. 자기를 죽인 뒤 나머지 절차를 밟아야 하는 프로세스는 그 절차를 끝낼 수 없다. 이 문서가 이미 기록한 PM2 데몬 부모 문제와 같은 함정이다
- 워커 `.env` 에 `WORKER_SENTINEL=C:\asahi-worker-update.flag` 를 넣어야 감시가 켜진다는 것(옵트인)
- 센티넬을 `WORKER_ROOTS` 밖에 두는 이유, 그리고 그것이 방어선이 아니라 실수 방지선이라는 것(`sh_exec` 는 경로 스코프의 대상이 아니므로 새 능력을 열지 않는다)

- [ ] **Step 4: `agent-onboarding.md` 3절을 개정한다**

"봇 배포와 워커 갱신은 별개다" 절에 자동 갱신이 생겼음을 반영하되, **수동 절차를 지우지 않는다** — 자동화가 막혔을 때 쓰는 경로이고, 그때가 바로 이 문서를 찾는 순간이다. 다음을 더한다.

- 이제 5분마다 자동 갱신되며, `runtime_info` 로 워커 커밋을 언제든 물어볼 수 있다는 것
- 15분 넘게 어긋나면 소유자 DM 으로 알림이 온다는 것
- **그래도 확인 없이 원격 도구 검증을 시작하지 말라**는 기존 규칙은 그대로다 — 자동화도 막힐 수 있고, 막혔을 때가 정확히 오진이 나는 순간이다

- [ ] **Step 5: `smoke-test.md` 에 항목 셋을 더한다**

```markdown
- [ ] **새 커밋이 5분 안에 워커에 들어가는가** — main 에 아무 커밋이나 머지한 뒤 5분을 기다리고,
  소유자 DM 에서 `runtime_info` 를 부른다.
  기대 결과: 워커 커밋이 봇 커밋과 같고 "봇과 일치" 로 표시된다. 다르면 미니PC 의
  `asahi-worker-update` 작업 실행 기록부터 본다(작업 스케줄러 → 기록 탭).

- [ ] **갱신이 진행 중인 작업을 죽이지 않는가** — 부원 계정으로 오래 걸리는 셸 명령을 시키고
  (예: 30초짜리), 그동안 미니PC 에서 센티넬 파일을 손으로 만든다.
  기대 결과: 그 명령이 정상적으로 결과를 돌려준 **뒤에** 워커가 종료되고 다시 뜬다. 명령이
  실패로 끝나면 종료 순서가 뒤집힌 것이다(worker.ts 의 planShutdown).

- [ ] **갱신이 막히면 알림이 오는가** — `asahi-worker-update` 작업을 사용 안 함으로 바꾸고
  main 에 커밋을 하나 머지한 뒤 15분 이상 기다린다.
  기대 결과: 소유자 DM 에 워커가 낡았다는 안내가 **한 번** 온다. 계속 반복되면 중복 방지가
  깨진 것이다. 확인 뒤 작업을 다시 사용함으로 되돌린다.
```

- [ ] **Step 6: `STATUS.md` 를 갱신한다**

"라이브 인프라" 절의 워커 항목에 자동 갱신(5분 폴링, 센티넬, 재시작 정책)과 버전 가시성(`runtime_info`, 15분 알림)을 한 문단으로 더한다.

- [ ] **Step 7: 문서 검사**

```bash
node scripts/check-docs.mjs
```

기대: `문서 검사 통과`.

- [ ] **Step 8: 커밋**

```bash
git add deploy/update-worker.ps1 deploy/worker-셋업.md docs/agent-onboarding.md deploy/smoke-test.md docs/status/STATUS.md
git commit -F - <<'EOF'
feat(deploy): 미니PC 워커 폴링 업데이터와 등록 절차를 더한다

5분마다 origin/main 을 확인해 새 커밋이 있으면 센티넬 파일을 만들고, 워커가 스스로 나가면
pull 하고, package-lock.json 이 바뀐 경우에만 npm ci 를 돌린다. 재기동은 하지 않는다 —
워커가 0 이 아닌 코드로 끝나므로 작업 스케줄러의 재시작 정책이 띄운다.

Stop/Start-ScheduledTask 를 부르지 않는 것이 핵심이다. asahi 는 표준 계정이라 그 권한이
없고, 관리자 창에는 npm 이 없어 어느 한 계정도 전체 순서를 수행할 수 없었다. 워커가 스스로
나가게 하면 그 매듭이 권한을 건드리지 않고 풀린다 — 워커가 비관리자로 도는 것은 손님 셸을
실행하는 계정이라는 의도된 보안 경계이므로 그것을 팔아 자동화를 사서는 안 된다.

워커가 시간 안에 안 죽으면 강제 종료하지 않고 이번 회차를 건너뛴다. 안 죽는 워커는 그 자체로
조사할 일이고, 자동화가 그것을 덮으면 안 된다 — 15분 알림이 그 경우를 잡는다.

수동 갱신 절차는 온보딩에 그대로 남긴다. 자동화가 막혔을 때 쓰는 경로이고, 그때가 바로 그
문서를 찾는 순간이다.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
```

---

## 배포 후 확인

이 계획의 변경은 **봇과 워커 양쪽**에 걸쳐 있다.

| 태스크 | 어디서 도는가 |
|---|---|
| 1(프로토콜) | 양쪽 — 봇이 먼저 배포돼도 옛 워커가 붙는 것이 Task 1 의 요구사항이다 |
| 2, 6 | **워커** |
| 3, 4, 5 | **봇** |
| 7 | 미니PC 설정 |

**닭과 달걀에 주의한다.** 이 기능이 자동 갱신을 만들지만, **이 기능 자체는 마지막으로 손으로 갱신해야** 미니PC 에 들어간다. 머지 후 한 번은 `docs/agent-onboarding.md` 3절의 수동 절차를 그대로 밟고, 그 뒤부터 자동이 된다.

첫 자동 갱신은 사람이 지켜본다 — 스크립트와 작업 스케줄러 설정은 유닛 테스트가 닿지 않는 이음매 너머다.
