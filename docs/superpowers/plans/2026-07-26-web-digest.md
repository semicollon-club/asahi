# 웹 검색 + 정기 뉴스 게시 구현 계획

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 모든 대화에서 웹 검색을 쓸 수 있게 하고, 매일 KST 7시에 대회 소식과 개발 뉴스를 조사해 각 채널에 올린다. 예약어로 즉시 실행할 수도 있다.

**Architecture:** `WebSearch` 는 SDK 내장 도구라 `builtinTools` 에 넣고 `allowedToolsFor` 전 계층에 더하면 끝난다. 정기 게시는 `core/digest.ts` 의 `DigestRunner` 가 맡는다 — 실행 판정은 순수 함수로 분리하고, 실행 자체는 `isOwner:false, isPrivate:false` 컨텍스트로 새 세션 턴을 돌려 결과를 `assistant_message` 로 발행한다. 그 컨텍스트에서는 `allowedToolsFor` 가 `recall` + `WebSearch` 만 주므로 PC 도구가 구조적으로 열리지 않는다.

**Tech Stack:** TypeScript (ESM, Node 22), vitest, Claude Agent SDK(`WebSearch`), pg

**설계 문서:** [2026-07-26-web-digest-design.md](../specs/2026-07-26-web-digest-design.md)

## Global Constraints

- **한국어.** 코드 주석·프롬프트·테스트 설명 전부 한국어.
- **작업 디렉토리는 `agent/`.**
- **새 의존성 금지.** `WebSearch` 는 SDK 내장이다.
- **`WebFetch` 는 열지 않는다.** 이번 범위는 검색뿐이다.
- **주제 키 고정:** `contest` · `devnews`. 예약어는 `/대회` · `/개발뉴스`.
- **게시 시각 상수:** `DIGEST_HOUR_KST = 7`. 환경변수로 빼지 않는다.
- **KST 는 UTC+9 고정**(서머타임 없음). 산술로 변환한다.
- **게시 작업은 `isOwner:false, isPrivate:false` 컨텍스트로 돈다.** PC 도구를 "빼는" 게 아니라 그 계층에 애초에 없다.
- **예약어 실행은 스케줄의 `lastRun` 기록을 건드리지 않는다.**
- **어떤 실패에도 내용을 지어내지 않는다.**
- **`core/` 는 `discord.js` 를 임포트하지 않는다.**
- **테스트 없이 커밋 금지.** red → green → commit.

## 파일 구조

| 파일 | 책임 |
|---|---|
| `agent/src/core/digest.ts` (신규) | 주제 정의, 실행 판정 순수 함수, `DigestRunner` |
| `agent/src/core/commands.ts` | 주제 예약어 파싱 추가 |
| `agent/src/core/agent.ts` | `builtinTools` 에 `WebSearch` |
| `agent/src/core/tools.ts` | `allowedToolsFor` 전 계층에 `WebSearch` |
| `agent/src/core/core.ts` | 예약어 분기에서 `DigestRunner` 호출 |
| `agent/src/config.ts` · `agent/src/index.ts` | 채널 ID 설정, 기존 1분 타이머에 스케줄 확인 연결 |

---

### Task 1: 주제 정의 · 실행 판정 (순수 함수)

**Files:**
- Create: `agent/src/core/digest.ts`
- Test: `agent/tests/digest.test.ts`

**Interfaces:**
- Consumes: 없음
- Produces:
  - `type DigestTopic = "contest" | "devnews"`
  - `const DIGEST_HOUR_KST = 7`
  - `const DIGEST_TOPICS: Record<DigestTopic, { label: string; prompt: string }>`
  - `kstDateString(nowUtcMs: number): string` — `"YYYY-MM-DD"`
  - `shouldRunDigest(nowUtcMs: number, lastRunDate: string | null, hourKst?: number): boolean`

- [ ] **Step 1: 실패하는 테스트 작성**

`agent/tests/digest.test.ts` 를 새로 만든다.

```ts
import { describe, it, expect } from "vitest";
import { kstDateString, shouldRunDigest, DIGEST_TOPICS, DIGEST_HOUR_KST } from "../src/core/digest.js";

// KST = UTC+9. 아래 UTC 시각들의 KST 환산을 주석으로 적어 둔다.
const utc = (iso: string) => Date.parse(iso);

describe("kstDateString", () => {
  it("UTC 자정 직후는 KST 로 같은 날 오전 9시다", () => {
    expect(kstDateString(utc("2026-07-26T00:30:00Z"))).toBe("2026-07-26");
  });

  it("UTC 15:00 은 KST 로 다음 날 0시다(날짜가 넘어간다)", () => {
    expect(kstDateString(utc("2026-07-26T15:00:00Z"))).toBe("2026-07-27");
  });

  it("UTC 14:59 는 아직 KST 같은 날이다", () => {
    expect(kstDateString(utc("2026-07-26T14:59:00Z"))).toBe("2026-07-26");
  });

  it("월말·연말 경계를 넘긴다", () => {
    expect(kstDateString(utc("2026-07-31T15:00:00Z"))).toBe("2026-08-01");
    expect(kstDateString(utc("2026-12-31T15:00:00Z"))).toBe("2027-01-01");
  });
});

describe("shouldRunDigest", () => {
  // KST 7시 = UTC 22:00 (전날)
  const beforeSeven = utc("2026-07-26T21:00:00Z"); // KST 7/27 06:00
  const exactlySeven = utc("2026-07-26T22:00:00Z"); // KST 7/27 07:00
  const afterSeven = utc("2026-07-27T03:00:00Z"); // KST 7/27 12:00

  it("KST 7시 이전이면 실행하지 않는다", () => {
    expect(shouldRunDigest(beforeSeven, null)).toBe(false);
  });

  it("KST 7시 정각이면 실행한다(경계 포함)", () => {
    expect(shouldRunDigest(exactlySeven, null)).toBe(true);
  });

  it("7시가 지났고 기록이 없으면 실행한다", () => {
    expect(shouldRunDigest(afterSeven, null)).toBe(true);
  });

  it("오늘(KST) 이미 했으면 실행하지 않는다", () => {
    expect(shouldRunDigest(afterSeven, "2026-07-27")).toBe(false);
  });

  it("어제 기록이면 실행한다", () => {
    expect(shouldRunDigest(afterSeven, "2026-07-26")).toBe(true);
  });

  it("7시 이전이면 어제 기록이 있어도 실행하지 않는다", () => {
    expect(shouldRunDigest(beforeSeven, "2026-07-26")).toBe(false);
  });

  it("hourKst 를 바꾸면 그 기준을 따른다", () => {
    // KST 7/27 06:00 — 기준이 5시면 실행, 9시면 미실행
    expect(shouldRunDigest(beforeSeven, null, 5)).toBe(true);
    expect(shouldRunDigest(beforeSeven, null, 9)).toBe(false);
  });
});

describe("주제 정의", () => {
  it("주제는 정확히 contest·devnews 둘이다", () => {
    expect(Object.keys(DIGEST_TOPICS).sort()).toEqual(["contest", "devnews"]);
  });

  it("각 주제는 라벨과 조사 프롬프트를 갖는다", () => {
    for (const t of Object.values(DIGEST_TOPICS)) {
      expect(t.label.length).toBeGreaterThan(0);
      expect(t.prompt.length).toBeGreaterThan(20);
    }
  });

  it("기본 게시 시각은 7시다", () => {
    expect(DIGEST_HOUR_KST).toBe(7);
  });
});
```

- [ ] **Step 2: 실패 확인**

```bash
cd agent && npx vitest run tests/digest.test.ts
```

기대: FAIL — `../src/core/digest.js` 를 찾을 수 없음.

- [ ] **Step 3: 구현**

`agent/src/core/digest.ts` 를 새로 만든다(이 태스크에서는 아래 부분까지만).

```ts
// 정기 뉴스 게시. 실행 판정은 순수 함수로 떼어내 시각·기록만으로 결정하고,
// 실제 실행(DigestRunner)은 같은 파일 아래쪽에 둔다.

export type DigestTopic = "contest" | "devnews";

// KST 기준 게시 시각. 환경변수로 빼지 않는다 — 잘못 설정하면 조용히 안 도는 것보다
// 상수 한 줄을 고치고 재배포하는 편이 낫다.
export const DIGEST_HOUR_KST = 7;

// KST 는 UTC+9 고정이고 서머타임이 없다. 라이브러리 없이 산술로 정확하다.
const KST_OFFSET_MS = 9 * 60 * 60 * 1000;

export const DIGEST_TOPICS: Record<DigestTopic, { label: string; prompt: string }> = {
  contest: {
    label: "대회",
    prompt: `웹 검색으로 지금 참가 신청을 받고 있거나 곧 열리는 코딩 대회·CTF(해킹) 대회를 3~5개 찾아 정리해줘.
각 항목마다 대회 이름, 일정, 참가 대상, 출처 링크를 적어. 날짜가 이미 지난 대회는 빼.
찾지 못했으면 억지로 채우지 말고 못 찾았다고 해.`,
  },
  devnews: {
    label: "개발 뉴스",
    prompt: `웹 검색으로 최근 개발자에게 의미 있는 소식을 3~5개 찾아 정리해줘.
프레임워크·언어·개발 도구의 주요 릴리스나 화제가 된 이슈 위주로. 각 항목마다 무엇이 바뀌었고
왜 중요한지 한두 줄로 설명하고 출처 링크를 붙여. 찾지 못했으면 억지로 채우지 말고 못 찾았다고 해.`,
  },
};

// 그 시각의 KST 날짜를 "YYYY-MM-DD" 로. UTC 로 9시간 민 뒤 UTC 필드를 읽으면 그게 KST 다.
export function kstDateString(nowUtcMs: number): string {
  return new Date(nowUtcMs + KST_OFFSET_MS).toISOString().slice(0, 10);
}

// 지금 게시를 실행해야 하는가. "정각에 쏘기"가 아니라 "지났는데 오늘 아직 안 했으면 한다" —
// 재배포나 일시 장애로 정각을 놓쳐도 그날 안에 올라간다.
export function shouldRunDigest(
  nowUtcMs: number,
  lastRunDate: string | null,
  hourKst: number = DIGEST_HOUR_KST,
): boolean {
  const kst = new Date(nowUtcMs + KST_OFFSET_MS);
  if (kst.getUTCHours() < hourKst) return false;
  return lastRunDate !== kstDateString(nowUtcMs);
}
```

- [ ] **Step 4: 통과 확인**

```bash
cd agent && npx vitest run tests/digest.test.ts
```

기대: PASS (전부)

- [ ] **Step 5: 전체 테스트 + 타입 확인**

```bash
cd agent && npm test && npx tsc --noEmit
```

기대: 0 failed, 1 skipped. tsc 클린.

- [ ] **Step 6: 커밋**

```bash
git add agent/src/core/digest.ts agent/tests/digest.test.ts
git commit -m "feat(core): 정기 게시 주제 정의 + 실행 판정 순수 함수"
```

---

### Task 2: 주제 예약어

**Files:**
- Modify: `agent/src/core/commands.ts`
- Test: `agent/tests/commands.test.ts`

**Interfaces:**
- Consumes: `DigestTopic` (Task 1)
- Produces: `parseDigestCommand(text: string): DigestTopic | null`

기존 `parseSessionCommand` 는 **건드리지 않는다.**

- [ ] **Step 1: 실패하는 테스트 작성**

`agent/tests/commands.test.ts` 끝에 추가한다. 임포트에 `parseDigestCommand` 를 더한다.

```ts
describe("parseDigestCommand", () => {
  it("주제 예약어를 인식한다", () => {
    expect(parseDigestCommand("/대회")).toBe("contest");
    expect(parseDigestCommand("/개발뉴스")).toBe("devnews");
  });

  it("앞뒤 공백을 무시한다", () => {
    expect(parseDigestCommand("  /대회  ")).toBe("contest");
  });

  it("정확히 일치할 때만 인식한다(문장 안에 섞이면 아님)", () => {
    expect(parseDigestCommand("/대회 알려줘")).toBeNull();
    expect(parseDigestCommand("대회")).toBeNull();
    expect(parseDigestCommand("오늘 /대회 뭐 있어?")).toBeNull();
  });

  it("모르는 예약어는 null", () => {
    expect(parseDigestCommand("/뉴스")).toBeNull();
    expect(parseDigestCommand("/")).toBeNull();
    expect(parseDigestCommand("")).toBeNull();
  });

  it("기존 세션 예약어와 서로 간섭하지 않는다", () => {
    expect(parseDigestCommand("/새세션")).toBeNull();
    expect(parseSessionCommand("/대회")).toBeNull();
  });
});
```

- [ ] **Step 2: 실패 확인**

```bash
cd agent && npx vitest run tests/commands.test.ts
```

기대: FAIL — `parseDigestCommand` 임포트 불가.

- [ ] **Step 3: 구현**

`agent/src/core/commands.ts` 에 추가한다.

```ts
import type { DigestTopic } from "./digest.js";

// 정기 게시를 즉시 실행하는 예약어. 세션 예약어와 같은 규칙 — 앞 슬래시를 요구하고
// 앞뒤 공백을 무시한 뒤 정확히 일치할 때만 인식한다(일반 대화와 확실히 구분).
const DIGEST_COMMANDS: Record<string, DigestTopic> = {
  "/대회": "contest",
  "/개발뉴스": "devnews",
};

export function parseDigestCommand(text: string): DigestTopic | null {
  return DIGEST_COMMANDS[text.trim().toLowerCase()] ?? null;
}
```

- [ ] **Step 4: 통과 확인**

```bash
cd agent && npx vitest run tests/commands.test.ts && npm test && npx tsc --noEmit
```

기대: 0 failed, 1 skipped. tsc 클린.

- [ ] **Step 5: 커밋**

```bash
git add agent/src/core/commands.ts agent/tests/commands.test.ts
git commit -m "feat(core): 주제 예약어(/대회·/개발뉴스) 파싱"
```

---

### Task 3: 웹 검색 개방

**Files:**
- Modify: `agent/src/core/agent.ts`
- Modify: `agent/src/core/tools.ts`
- Test: `agent/tests/tools.test.ts`

**Interfaces:**
- Consumes: 없음
- Produces: `WebSearch` 가 `allowedToolsFor` 의 **모든 계층**에 포함된다

`WebSearch` 는 SDK 내장이라 `mcp__asahi__` 접두어가 없다. 이름 그대로 쓴다.

- [ ] **Step 1: 실패하는 테스트 작성**

`agent/tests/tools.test.ts` 끝에 추가한다.

```ts
describe("allowedToolsFor — 웹 검색", () => {
  const WS = "WebSearch";

  it("모든 계층에 WebSearch 가 포함된다", () => {
    expect(allowedToolsFor("owner", true, true, "local", true)).toContain(WS);
    expect(allowedToolsFor("owner", true, true, "cloud", true)).toContain(WS);
    expect(allowedToolsFor("owner", true, true, "local", false)).toContain(WS);
    expect(allowedToolsFor("allowed", true, false, "local", false)).toContain(WS);
    expect(allowedToolsFor("allowed", false, false, "local", false)).toContain(WS);
  });

  it("게시 작업 컨텍스트(공개 채널 계층)는 recall 과 WebSearch 만 받는다", () => {
    const tools = allowedToolsFor("allowed", false, false, "cloud", false);
    expect(tools.sort()).toEqual(["WebSearch", "mcp__asahi__recall"]);
  });

  it("WebFetch 는 어느 계층에도 없다", () => {
    for (const t of [
      allowedToolsFor("owner", true, true, "local", true),
      allowedToolsFor("allowed", true, false, "local", false),
      allowedToolsFor("allowed", false, false, "local", false),
    ]) {
      expect(t).not.toContain("WebFetch");
    }
  });
});
```

- [ ] **Step 2: 실패 확인**

```bash
cd agent && npx vitest run tests/tools.test.ts
```

기대: FAIL — `WebSearch` 가 어느 계층에도 없음.

- [ ] **Step 3: `tools.ts` 수정**

파일 상단 `FILE_TOOLS` 근처에 상수를 추가한다.

```ts
// SDK 내장 웹 검색. MCP 도구가 아니라 이름 그대로 allowedTools 에 들어간다.
// WebFetch(임의 URL 페치)는 열지 않는다 — 지금 필요한 건 검색이고 노출 표면이 훨씬 넓다.
const WEB_TOOLS = ["WebSearch"];
```

`allowedToolsFor` 의 **모든 return 문**에 `...WEB_TOOLS` 를 더한다. 분기를 빠뜨리지 않도록
`grep -n "return \[" src/core/tools.ts` 로 전부 확인할 것 — 소유자 DM local, 소유자 DM cloud,
손님 DM, 공개 서버 네 곳이다.

- [ ] **Step 4: `agent.ts` 수정**

`const builtinTools: string[] = [];` 을 아래로 교체한다.

```ts
    // SDK 내장 도구는 웹 검색만 연다. 파일/Bash 는 원격 도구(fs_*·sh_exec)가 대신하므로
    // 내장 쪽은 계속 닫아 둔다 — 열면 봇 컨테이너의 파일시스템을 건드리게 된다.
    const builtinTools: string[] = ["WebSearch"];
```

- [ ] **Step 5: 통과 확인**

```bash
cd agent && npx vitest run tests/tools.test.ts && npm test && npx tsc --noEmit
```

기대: 0 failed, 1 skipped. tsc 클린. 기존 `allowedToolsFor` 테스트가 정확 배열 비교(`toEqual`)를
쓰는 곳이 있으면 `WebSearch` 가 추가돼 깨진다 — 그건 의도된 변경이므로 기대 배열에 `WebSearch` 를
더한다. 어느 테스트를 왜 고쳤는지 보고에 적을 것.

- [ ] **Step 6: 커밋**

```bash
git add agent/src/core/agent.ts agent/src/core/tools.ts agent/tests/tools.test.ts
git commit -m "feat(core): WebSearch 를 전 계층에 개방"
```

---

### Task 4: DigestRunner

**Files:**
- Modify: `agent/src/core/digest.ts`
- Test: `agent/tests/digestRunner.test.ts`

**Interfaces:**
- Consumes: `DIGEST_TOPICS`·`shouldRunDigest`·`kstDateString` (Task 1), `TurnRunner`(`core/agent.js`), `EventBus`(`events/bus.js`), `SettingsRepo`(`store/settingsRepo.js`), `buildSystemPrompt`(`core/persona.js`)
- Produces:
  - `type DigestChannels = Partial<Record<DigestTopic, string>>`
  - `class DigestRunner`
    - `constructor(deps: { runTurn: TurnRunner; bus: EventBus; settings: SettingsRepo; agentCwd: string; channels: DigestChannels; emotions?: string[]; now?: () => number })`
    - `run(topic: DigestTopic, channelRef: string): Promise<void>` — 즉시 실행. `lastRun` 을 **기록하지 않는다**
    - `checkAndRun(): Promise<void>` — 주제별로 판정해 실행하고 성공 시 `lastRun` 기록

- [ ] **Step 1: 실패하는 테스트 작성**

`agent/tests/digestRunner.test.ts` 를 새로 만든다.

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { openTestDb } from "../src/store/db.js";
import { SettingsRepo } from "../src/store/settingsRepo.js";
import { EventBus } from "../src/events/bus.js";
import { DigestRunner } from "../src/core/digest.js";
import type { AgentEvent } from "../src/events/bus.js";

const utc = (iso: string) => Date.parse(iso);
const AFTER_SEVEN = utc("2026-07-27T03:00:00Z"); // KST 7/27 12:00
const BEFORE_SEVEN = utc("2026-07-26T21:00:00Z"); // KST 7/27 06:00

async function make(over: Partial<{
  result: { text: string; ok: boolean };
  now: number;
  channels: Record<string, string>;
}> = {}) {
  const db = await openTestDb();
  const settings = new SettingsRepo(db);
  const bus = new EventBus();
  const sent: AgentEvent[] = [];
  bus.subscribe("assistant_message", (e) => sent.push(e));
  const prompts: string[] = [];
  const runner = new DigestRunner({
    runTurn: async (req) => {
      prompts.push(req.prompt);
      const r = over.result ?? { text: "오늘의 소식", ok: true };
      return { text: r.text, ok: r.ok, sessionId: "s" };
    },
    bus,
    settings,
    agentCwd: "/tmp",
    channels: (over.channels ?? { contest: "C1", devnews: "C2" }) as any,
    now: () => over.now ?? AFTER_SEVEN,
  });
  return { runner, settings, sent, prompts };
}

describe("DigestRunner.run — 즉시 실행", () => {
  it("결과를 지정한 채널로 발행한다", async () => {
    const { runner, sent } = await make();
    await runner.run("contest", "C99");
    expect(sent).toHaveLength(1);
    expect(sent[0].channelRef).toBe("C99");
    expect((sent[0] as any).text).toContain("오늘의 소식");
  });

  it("lastRun 기록을 남기지 않는다(스케줄에 영향 없음)", async () => {
    const { runner, settings } = await make();
    await runner.run("contest", "C99");
    expect(await settings.get("digest.lastRun.contest")).toBeNull();
  });

  it("조사 프롬프트에 그 주제의 지시가 들어간다", async () => {
    const { runner, prompts } = await make();
    await runner.run("contest", "C99");
    expect(prompts[0]).toContain("CTF");
  });

  it("턴이 실패하면 지어내지 않고 짧게 알린다", async () => {
    const { runner, sent } = await make({ result: { text: "", ok: false } });
    await runner.run("contest", "C99");
    expect(sent).toHaveLength(1);
    expect((sent[0] as any).text.length).toBeGreaterThan(0);
    expect((sent[0] as any).text).not.toContain("오늘의 소식");
  });

  it("응답이 비어 있어도 무언가는 보낸다", async () => {
    const { runner, sent } = await make({ result: { text: "   ", ok: true } });
    await runner.run("contest", "C99");
    expect(sent).toHaveLength(1);
    expect((sent[0] as any).text.trim().length).toBeGreaterThan(0);
  });
});

describe("DigestRunner.checkAndRun — 스케줄", () => {
  it("7시가 지났고 기록이 없으면 두 주제 모두 실행하고 기록한다", async () => {
    const { runner, settings, sent } = await make();
    await runner.checkAndRun();
    expect(sent.map((e) => e.channelRef).sort()).toEqual(["C1", "C2"]);
    expect(await settings.get("digest.lastRun.contest")).toBe("2026-07-27");
    expect(await settings.get("digest.lastRun.devnews")).toBe("2026-07-27");
  });

  it("7시 이전이면 아무것도 하지 않는다", async () => {
    const { runner, sent } = await make({ now: BEFORE_SEVEN });
    await runner.checkAndRun();
    expect(sent).toHaveLength(0);
  });

  it("이미 오늘 했으면 다시 하지 않는다", async () => {
    const { runner, settings, sent } = await make();
    await settings.set("digest.lastRun.contest", "2026-07-27");
    await settings.set("digest.lastRun.devnews", "2026-07-27");
    await runner.checkAndRun();
    expect(sent).toHaveLength(0);
  });

  it("채널이 설정되지 않은 주제는 건너뛴다", async () => {
    const { runner, settings, sent } = await make({ channels: { contest: "C1" } });
    await runner.checkAndRun();
    expect(sent.map((e) => e.channelRef)).toEqual(["C1"]);
    expect(await settings.get("digest.lastRun.devnews")).toBeNull();
  });

  it("턴이 실패하면 기록하지 않아 다음 확인에서 재시도한다", async () => {
    const { runner, settings } = await make({ result: { text: "", ok: false } });
    await runner.checkAndRun();
    expect(await settings.get("digest.lastRun.contest")).toBeNull();
  });
});
```

- [ ] **Step 2: 실패 확인**

```bash
cd agent && npx vitest run tests/digestRunner.test.ts
```

기대: FAIL — `DigestRunner` 없음.

- [ ] **Step 3: 구현**

`agent/src/core/digest.ts` 끝에 추가한다. 파일 상단 임포트도 함께 넣는다.

```ts
import type { TurnRunner } from "./agent.js";
import type { EventBus } from "../events/bus.js";
import type { SettingsRepo } from "../store/settingsRepo.js";
import { buildSystemPrompt } from "./persona.js";
```

```ts
export type DigestChannels = Partial<Record<DigestTopic, string>>;

const LAST_RUN_KEY = (topic: DigestTopic) => `digest.lastRun.${topic}`;
const FAILED_TEXT = "…오늘은 못 찾았어. 나중에 다시 볼게.";

export class DigestRunner {
  private runTurn: TurnRunner;
  private bus: EventBus;
  private settings: SettingsRepo;
  private agentCwd: string;
  private channels: DigestChannels;
  private emotions: string[];
  private now: () => number;

  constructor(deps: {
    runTurn: TurnRunner; bus: EventBus; settings: SettingsRepo; agentCwd: string;
    channels: DigestChannels; emotions?: string[]; now?: () => number;
  }) {
    this.runTurn = deps.runTurn;
    this.bus = deps.bus;
    this.settings = deps.settings;
    this.agentCwd = deps.agentCwd;
    this.channels = deps.channels;
    this.emotions = deps.emotions ?? [];
    this.now = deps.now ?? Date.now;
  }

  // 한 주제를 조사해 지정한 채널로 발행한다. 성공 여부를 돌려준다 —
  // checkAndRun 이 이 값으로 기록 여부를 정한다. 예약어 경로는 값을 무시한다.
  private async execute(topic: DigestTopic, channelRef: string): Promise<boolean> {
    const spec = DIGEST_TOPICS[topic];
    // 게시는 사용자 대화가 아니다. 공개 채널 계층(isOwner:false, isPrivate:false)으로 돌려
    // PC 도구가 구조적으로 열리지 않게 한다 — 플래그로 빼는 게 아니라 그 계층에 애초에 없다.
    const context = { role: "allowed" as const, isPrivate: false, isOwner: false, userId: "digest", conversationId: 0 };
    let text = "";
    let ok = false;
    try {
      const result = await this.runTurn({
        prompt: spec.prompt,
        systemPrompt: buildSystemPrompt({ role: "allowed", isPrivate: false, isOwner: false, emotions: this.emotions }),
        cwd: this.agentCwd,
        context,
      });
      text = result.text.trim();
      ok = result.ok && text.length > 0;
    } catch (err) {
      console.error(`[digest] ${topic} 조사 실패:`, err);
    }
    this.bus.publish({
      type: "assistant_message", channel: "discord", channelRef,
      text: ok ? text : FAILED_TEXT, ts: this.now(),
    });
    return ok;
  }

  // 예약어 경로: 명령을 친 채널에 즉시 답한다. lastRun 을 건드리지 않는다 —
  // 수동으로 한 번 봤다고 다음 날 아침 게시가 걸러지면 안 된다.
  async run(topic: DigestTopic, channelRef: string): Promise<void> {
    await this.execute(topic, channelRef);
  }

  // 스케줄 경로: 주제별로 판정해 실행하고, 성공한 것만 기록한다.
  async checkAndRun(): Promise<void> {
    for (const topic of Object.keys(DIGEST_TOPICS) as DigestTopic[]) {
      const channelRef = this.channels[topic];
      if (!channelRef) continue; // 채널 미설정 주제는 조용히 건너뛴다(부팅 시 한 번 안내한다)
      const nowMs = this.now();
      const last = await this.settings.get(LAST_RUN_KEY(topic));
      if (!shouldRunDigest(nowMs, last)) continue;
      const ok = await this.execute(topic, channelRef);
      // 실패한 날은 기록하지 않아 다음 확인(1분 뒤)에서 다시 시도한다.
      if (ok) await this.settings.set(LAST_RUN_KEY(topic), kstDateString(nowMs));
    }
  }
}
```

- [ ] **Step 4: 통과 확인**

```bash
cd agent && npx vitest run tests/digestRunner.test.ts && npm test && npx tsc --noEmit
```

기대: 0 failed, 1 skipped. tsc 클린.

- [ ] **Step 5: 커밋**

```bash
git add agent/src/core/digest.ts agent/tests/digestRunner.test.ts
git commit -m "feat(core): DigestRunner — 즉시 실행·스케줄 실행"
```

---

### Task 5: 배선 — 설정 · 예약어 분기 · 타이머

**Files:**
- Modify: `agent/src/config.ts`
- Modify: `agent/src/core/core.ts`
- Modify: `agent/src/index.ts`
- Modify: `.env.example`
- Test: `agent/tests/config.test.ts`, `agent/tests/coreMulti.test.ts`

**Interfaces:**
- Consumes: `DigestRunner`·`DigestChannels` (Task 4), `parseDigestCommand` (Task 2)
- Produces: `Config` 에 `digestChannels: DigestChannels`

- [ ] **Step 1: 실패하는 테스트 작성**

`agent/tests/config.test.ts` 에 추가한다.

```ts
describe("정기 게시 채널 설정", () => {
  const base = { DATABASE_URL: "postgres://x", DISCORD_TOKEN: "d", DISCORD_OWNER_ID: "o", WORKER_TOKEN: "w".repeat(32) };

  it("두 채널 ID 를 읽는다", () => {
    const c = loadConfig({ ...base, DIGEST_CONTEST_CHANNEL_ID: "C1", DIGEST_DEVNEWS_CHANNEL_ID: "C2" } as NodeJS.ProcessEnv);
    expect(c.digestChannels).toEqual({ contest: "C1", devnews: "C2" });
  });

  it("설정되지 않은 주제는 키 자체가 없다", () => {
    const c = loadConfig({ ...base, DIGEST_CONTEST_CHANNEL_ID: "C1" } as NodeJS.ProcessEnv);
    expect(c.digestChannels.contest).toBe("C1");
    expect(c.digestChannels.devnews).toBeUndefined();
  });

  it("둘 다 없어도 기동에는 지장이 없다(빈 객체)", () => {
    expect(loadConfig(base as NodeJS.ProcessEnv).digestChannels).toEqual({});
  });
});
```

- [ ] **Step 2: 실패 확인**

```bash
cd agent && npx vitest run tests/config.test.ts
```

기대: FAIL — `digestChannels` 없음.

- [ ] **Step 3: `config.ts` 수정**

`Config` 타입에 추가한다.

```ts
  // 정기 게시 목적지. 주제별로 설정하며, 없는 주제는 스케줄에서 건너뛴다(예약어로는 실행 가능).
  digestChannels: DigestChannels;
```

임포트를 추가하고 `loadConfig` 반환에 채운다.

```ts
import type { DigestChannels } from "./core/digest.js";
```

```ts
    digestChannels: {
      ...(env.DIGEST_CONTEST_CHANNEL_ID ? { contest: env.DIGEST_CONTEST_CHANNEL_ID } : {}),
      ...(env.DIGEST_DEVNEWS_CHANNEL_ID ? { devnews: env.DIGEST_DEVNEWS_CHANNEL_ID } : {}),
    },
```

- [ ] **Step 4: `core.ts` 예약어 분기**

임포트를 추가한다.

```ts
import { parseSessionCommand, parseDigestCommand } from "./commands.js";
import type { DigestRunner } from "./digest.js";
```

`AgentCore` 의 deps 타입과 필드에 추가한다(다른 옵셔널 의존성과 같은 방식).

```ts
  digest?: DigestRunner;
```

`ingest` 의 `parseSessionCommand` 분기 **바로 다음**에 넣는다. 예약어는 LLM 턴을 거치지 않으므로
손님 한도에도 걸리지 않는다.

```ts
    // 정기 게시 예약어: 명령을 친 그 채널에 즉시 답한다. 스케줄의 lastRun 은 건드리지 않는다.
    const digestTopic = parseDigestCommand(text);
    if (digestTopic) {
      if (!this.digest) {
        this.bus.publish({ type: "system_notice", channel: "discord", channelRef: conv.discordChannelId, text: "지금은 조사 기능이 꺼져 있어요.", ts: this.now() });
        return;
      }
      void this.digest.run(digestTopic, conv.discordChannelId).catch((err) => console.error("[core] 조사 실행 오류:", err));
      return;
    }
```

- [ ] **Step 5: `index.ts` 배선**

임포트를 추가하고 `DigestRunner` 를 만든다(`SettingsRepo` 는 이미 임포트돼 있다 —
`backfillLegacyAllowedDirs` 가 쓴다).

```ts
import { DigestRunner, DIGEST_TOPICS } from "./core/digest.js";
```

`AgentCore` 생성 **앞**에 둔다.

```ts
  const digest = new DigestRunner({
    runTurn, bus, settings: new SettingsRepo(db), agentCwd,
    channels: config.digestChannels, emotions,
  });
  for (const topic of Object.keys(DIGEST_TOPICS)) {
    const set = config.digestChannels[topic as keyof typeof config.digestChannels];
    console.log(`[index] 정기 게시 ${topic}: ${set ? `채널 ${set}` : "채널 미설정 — 스케줄 건너뜀"}`);
  }
```

`AgentCore` 생성에 `digest` 를 넘긴다. 그리고 기존 1분 타이머에 확인을 얹는다 —
**새 타이머를 만들지 않는다.**

```ts
  const idleTimer = setInterval(() => {
    void core.closeIdleConversations().catch((err) => console.error("[core] 유휴 정리 오류:", err));
    void digest.checkAndRun().catch((err) => console.error("[digest] 스케줄 확인 오류:", err));
  }, 60 * 1000);
```

- [ ] **Step 6: `.env.example` 갱신**

추가한다.

```
# ── 정기 뉴스 게시 ──
# 매일 KST 7시에 조사 결과를 올릴 채널. 설정하지 않은 주제는 스케줄에서 건너뛴다
# (예약어 /대회·/개발뉴스 로는 어느 채널에서든 실행할 수 있다).
DIGEST_CONTEST_CHANNEL_ID=
DIGEST_DEVNEWS_CHANNEL_ID=
```

기존 `DISCORD_CHANNEL_ID` 줄 옆에 "(현재 미사용)" 주석을 단다.

- [ ] **Step 7: 예약어 분기 테스트**

`agent/tests/coreMulti.test.ts` 에 추가한다. 이 파일에는 이미 `AgentCore` 를 세우는 `setup()`
헬퍼가 있다 — **그것을 재사용하고 새 헬퍼를 만들지 마라.** `digest` 를 주입할 수 있도록
`setup()` 에 옵셔널 인자를 더하는 방식이 가장 작은 변경이다.

```ts
describe("AgentCore — 정기 게시 예약어", () => {
  it("예약어를 받으면 LLM 턴을 돌리지 않고 DigestRunner 에 넘긴다", async () => {
    const calls: Array<{ topic: string; channelRef: string }> = [];
    const digest = { run: async (topic: string, channelRef: string) => { calls.push({ topic, channelRef }); } };
    const { core, runTurnCalls, send } = await setup({ digest } as any);

    await send("/대회");
    await vi.waitFor(() => expect(calls).toHaveLength(1));

    expect(calls[0].topic).toBe("contest");
    expect(runTurnCalls).toHaveLength(0); // 모델을 부르지 않는다
  });

  it("예약어를 친 그 채널로 답한다", async () => {
    const calls: Array<{ topic: string; channelRef: string }> = [];
    const digest = { run: async (topic: string, channelRef: string) => { calls.push({ topic, channelRef }); } };
    const { send, channelRef } = await setup({ digest } as any);

    await send("/개발뉴스");
    await vi.waitFor(() => expect(calls).toHaveLength(1));

    expect(calls[0].channelRef).toBe(channelRef);
  });

  it("digest 가 주입되지 않았으면 안내만 하고 넘어간다", async () => {
    const { send, notices, runTurnCalls } = await setup();
    await send("/대회");
    await vi.waitFor(() => expect(notices.length).toBeGreaterThan(0));
    expect(runTurnCalls).toHaveLength(0);
  });
});
```

`setup()` 의 실제 반환 형태(`runTurnCalls`·`send`·`notices`·`channelRef` 등)는 파일마다 다르다.
**먼저 파일을 읽고 그 헬퍼가 실제로 제공하는 것에 맞춰 위 테스트를 조정하라** — 이름을 지어내지
말고, 없는 값이 필요하면 헬퍼에 최소한으로 덧붙여라. 검증할 내용은 셋이다: 모델을 부르지 않는다,
주제와 채널이 그대로 전달된다, 미주입 시 조용히 안내한다.

- [ ] **Step 8: 통과 확인**

```bash
cd agent && npm test && npx tsc --noEmit && npm run build
```

기대: 0 failed, 1 skipped. tsc 클린. 빌드 성공.

- [ ] **Step 9: 커밋**

```bash
git add agent/src/config.ts agent/src/core/core.ts agent/src/index.ts agent/tests/config.test.ts agent/tests/coreMulti.test.ts .env.example
git commit -m "feat: 정기 게시 배선 — 채널 설정·예약어 분기·스케줄 확인"
```

---

### Task 6: `/help` — 예약어 안내

**Files:**
- Modify: `agent/src/core/commands.ts`
- Modify: `agent/src/core/core.ts`
- Test: `agent/tests/commands.test.ts`, `agent/tests/coreMulti.test.ts`

**Interfaces:**
- Consumes: 기존 예약어 테이블(`RESET_COMMANDS`, `DIGEST_COMMANDS`)
- Produces:
  - `COMMAND_HELP: ReadonlyArray<{ commands: readonly string[]; description: string }>`
  - `parseHelpCommand(text: string): boolean`
  - `renderCommandHelp(): string`

예약어는 아무 표시가 없어 아는 사람만 쓴다. `/help` 로 목록을 보여준다.

**이 태스크의 핵심은 안내문이 예약어 테이블에서 파생되게 만드는 것이다.** 손으로 적으면
예약어를 추가하는 순간 조용히 어긋난다 — 그리고 그 어긋남은 아무도 눈치채지 못한다.
`COMMAND_HELP` 는 파싱에 쓰이는 바로 그 상수들을 참조해 만들고, 테스트가 "파싱되는 모든
예약어가 안내문에 등장하는가"를 검증한다.

- [ ] **Step 1: 실패하는 테스트 작성**

`agent/tests/commands.test.ts` 에 추가한다. 임포트에 `parseHelpCommand`·`renderCommandHelp`·`COMMAND_HELP` 를 더한다.

```ts
describe("parseHelpCommand", () => {
  it("도움말 예약어를 인식한다", () => {
    expect(parseHelpCommand("/help")).toBe(true);
    expect(parseHelpCommand("/도움말")).toBe(true);
    expect(parseHelpCommand("/명령어")).toBe(true);
  });

  it("앞뒤 공백과 대소문자를 무시한다", () => {
    expect(parseHelpCommand("  /HELP  ")).toBe(true);
  });

  it("정확히 일치할 때만 인식한다", () => {
    expect(parseHelpCommand("/help 알려줘")).toBe(false);
    expect(parseHelpCommand("help")).toBe(false);
    expect(parseHelpCommand("")).toBe(false);
  });

  it("다른 예약어와 서로 간섭하지 않는다", () => {
    expect(parseHelpCommand("/새세션")).toBe(false);
    expect(parseHelpCommand("/대회")).toBe(false);
    expect(parseSessionCommand("/help")).toBeNull();
    expect(parseDigestCommand("/help")).toBeNull();
  });
});

describe("renderCommandHelp — 안내문이 실제 예약어와 어긋나지 않는다", () => {
  it("파싱되는 모든 예약어가 안내문에 나온다", () => {
    const help = renderCommandHelp();
    // 안내문에 적힌 예약어를 전부 모아, 하나도 빠짐없이 실제로 파싱되는지 확인한다.
    const listed = COMMAND_HELP.flatMap((g) => g.commands);
    expect(listed.length).toBeGreaterThan(0);
    for (const cmd of listed) {
      expect(help).toContain(cmd);
      const parsed = parseSessionCommand(cmd) !== null || parseDigestCommand(cmd) !== null || parseHelpCommand(cmd);
      expect(parsed, `${cmd} 는 안내문에 있지만 파싱되지 않는다`).toBe(true);
    }
  });

  it("세션·조사·도움말 예약어가 모두 안내문에 포함된다", () => {
    const help = renderCommandHelp();
    for (const cmd of ["/새세션", "/대회", "/개발뉴스", "/help"]) {
      expect(help).toContain(cmd);
    }
  });

  it("각 그룹에 설명이 붙어 있다", () => {
    for (const g of COMMAND_HELP) {
      expect(g.commands.length).toBeGreaterThan(0);
      expect(g.description.length).toBeGreaterThan(5);
    }
  });
});
```

- [ ] **Step 2: 실패 확인**

```bash
cd agent && npx vitest run tests/commands.test.ts
```

기대: FAIL — `parseHelpCommand` 등 임포트 불가.

- [ ] **Step 3: `commands.ts` 구현**

기존 `RESET_COMMANDS`·`DIGEST_COMMANDS` 는 건드리지 않는다. 아래를 파일 끝에 추가한다.

```ts
const HELP_COMMANDS = new Set(["/help", "/도움말", "/명령어"]);

export function parseHelpCommand(text: string): boolean {
  return HELP_COMMANDS.has(text.trim().toLowerCase());
}

// 안내문은 위 예약어 테이블에서 파생시킨다. 손으로 적으면 예약어를 추가하는 순간
// 조용히 어긋나고, 그 어긋남은 아무도 눈치채지 못한다(테스트가 이 일치를 검증한다).
export const COMMAND_HELP: ReadonlyArray<{ commands: readonly string[]; description: string }> = [
  { commands: [...RESET_COMMANDS], description: "대화를 새 세션으로 시작한다. 성격이나 설정이 바뀐 뒤에 쓴다" },
  { commands: ["/대회"], description: "코딩·CTF 대회 소식을 지금 조사해서 이 채널에 알려준다" },
  { commands: ["/개발뉴스"], description: "개발 관련 소식을 지금 조사해서 이 채널에 알려준다" },
  { commands: [...HELP_COMMANDS], description: "이 목록을 보여준다" },
];

export function renderCommandHelp(): string {
  const lines = COMMAND_HELP.map((g) => `- ${g.commands.join(" · ")} — ${g.description}`);
  return `쓸 수 있는 명령어야.\n\n${lines.join("\n")}\n\n그 외에는 그냥 말 걸면 돼.`;
}
```

`DIGEST_COMMANDS` 의 키를 직접 펼치지 않고 `/대회`·`/개발뉴스` 를 나열하는 이유는 주제별로
설명이 다르기 때문이다. 테스트가 "안내문의 모든 예약어가 실제로 파싱되는가"를 검증하므로,
주제를 추가하고 안내문에 빠뜨리면 그 테스트가 잡지 못한다 — 반대 방향(파싱되는데 안내문에
없음)은 §Step 1 의 두 번째 테스트가 주요 예약어에 한해 막는다. 주제가 늘면 그 목록도 함께 늘린다.

- [ ] **Step 4: `core.ts` 분기 추가**

임포트에 `parseHelpCommand`·`renderCommandHelp` 를 더하고, `parseDigestCommand` 분기 **바로 앞**에
넣는다. 도움말은 모델을 부르지 않으므로 한도와 무관하다.

```ts
    // 도움말: 예약어 목록만 보여준다. 모델을 부르지 않는다.
    if (parseHelpCommand(text)) {
      this.bus.publish({ type: "assistant_message", channel: "discord", channelRef: conv.discordChannelId, text: renderCommandHelp(), ts: this.now() });
      return;
    }
```

- [ ] **Step 5: `coreMulti.test.ts` 에 분기 테스트 추가**

이 파일의 기존 `setup()` 헬퍼를 재사용한다. 반환 필드 이름은 파일을 읽고 맞춘다.

```ts
describe("AgentCore — /help", () => {
  it("예약어 목록을 보내고 모델을 부르지 않는다", async () => {
    const t = await setup();
    await t.pub(/* 이 파일의 기존 방식대로 "/help" 를 보낸다 */);
    // 발행된 assistant_message 에 주요 예약어가 들어 있는지 확인
    // 그리고 runTurn 호출 수가 0 인지 확인
  });
});
```

위 골격의 주석 자리는 **파일의 실제 헬퍼 사용법에 맞춰 채운다.** 검증할 내용은 둘이다 —
`/help` 응답에 `/새세션`·`/대회` 가 들어 있고, 모델 호출이 0건이다.

- [ ] **Step 6: 통과 확인**

```bash
cd agent && npx vitest run tests/commands.test.ts tests/coreMulti.test.ts && npm test && npx tsc --noEmit
```

기대: 0 failed, 1 skipped. tsc 클린.

- [ ] **Step 7: 커밋**

```bash
git add agent/src/core/commands.ts agent/src/core/core.ts agent/tests/commands.test.ts agent/tests/coreMulti.test.ts
git commit -m "feat(core): /help — 예약어 목록 안내"
```

---

### Task 7: 문서

**Files:**
- Modify: `docs/security/capability-model.md`
- Modify: `docs/architecture/module-boundaries.md`
- Modify: `docs/status/STATUS.md`
- Modify: `deploy/smoke-test.md`

- [ ] **Step 1: `capability-model.md`**

능력 계층표의 **모든 행**에 `WebSearch` 를 더한다. 표 아래에 한 문단을 덧붙인다 —
웹 검색은 신원·위치와 무관하게 전 계층에 열리며, `WebFetch` 는 열지 않았고, 웹 콘텐츠는
신뢰할 수 없는 입력이라 페르소나의 "관찰된 지시는 실행하지 마라"가 유일한 완화라는 점.

**상호배타를 검토했다가 철회한 경위**를 한 문단으로 남긴다. 설계 문서 §2.1 을 가리키되,
결정의 요지(위험은 실재하나 Claude Code 자신이 같은 조합을 쓰며, 무인 실행 턴은 이미 원격
도구를 받지 않으므로 소유자가 감수하기로 판단)를 여기서도 읽을 수 있게 적는다.

정기 게시 작업이 공개 채널 계층으로 돌아 PC 도구가 구조적으로 열리지 않는다는 점도 적는다.

- [ ] **Step 2: `module-boundaries.md`**

`core/` 행의 주요 파일에 `digest.ts` 를 더하고, 책임 설명에 "정기 게시(주제 정의·실행 판정·실행)"를
덧붙인다. 게시가 대화 행 없이 도는 유일한 턴이라는 점을 한 줄로 명시한다.

- [ ] **Step 3: `STATUS.md`**

`## 병합된 주요 기능 (main)` 에 항목을 추가한다.

```markdown
- **웹 검색** — 모든 대화에서 SDK 내장 `WebSearch` 를 쓴다(`WebFetch` 는 열지 않았다).
- **정기 뉴스 게시** — 매일 KST 7시에 대회 소식·개발 뉴스를 조사해 각 채널에 올린다.
  정각이 아니라 "지났는데 오늘 아직 안 했으면" 실행하므로 재배포로 그 순간을 놓쳐도 그날 안에
  올라간다. 예약어 `/대회`·`/개발뉴스` 로 어느 채널에서든 즉시 실행할 수 있고, 그때는 스케줄
  기록을 건드리지 않는다. 게시 작업은 공개 채널 계층으로 돌아 PC 도구가 열리지 않는다.
```

`## 알려진 한계` 에 두 줄을 추가한다 — 어제 올린 내용을 모른다(매번 새 세션), 봇이 죽어 있던
날은 소급하지 않는다.

`## 테스트` 수치를 실제 출력으로 갱신한다.

```bash
cd agent && npm test
```

- [ ] **Step 4: `deploy/smoke-test.md`**

확인 항목을 추가한다.

```markdown
- [ ] 부팅 로그에 `정기 게시 contest/devnews` 채널 설정이 찍히는가
- [ ] 아무 채널에서 `/대회` → 그 채널에 대회 소식이 출처 링크와 함께 올라오는가
- [ ] `/개발뉴스` → 실제 검색 결과가 나오는가(지어낸 내용이 아닌지 링크로 확인)
- [ ] 예약어 실행 뒤에도 다음 날 아침 스케줄 게시가 정상 동작하는가
- [ ] 소유자 DM 에서 "검색해줘" 요청 시 WebSearch 가 실제로 호출되는가
- [ ] 채널 ID 를 비워둔 주제가 스케줄에서 조용히 건너뛰어지는가
```

- [ ] **Step 5: 문서 검사**

```bash
node scripts/check-docs.mjs
```

기대: `문서 검사 통과`

- [ ] **Step 6: 커밋**

```bash
git add docs deploy
git commit -m "docs: 웹 검색·정기 뉴스 게시 반영"
```

---

## 배포 후 확인

- [ ] Railway Variables 에 `DIGEST_CONTEST_CHANNEL_ID`·`DIGEST_DEVNEWS_CHANNEL_ID` 추가.
  디스코드에서 채널 우클릭 → ID 복사(개발자 모드가 켜져 있어야 보인다).
- [ ] 배포 후 로그에서 두 채널이 모두 설정됐는지 확인.
- [ ] 디스코드에서 `/새세션` (프롬프트가 바뀌었다).
- [ ] `deploy/smoke-test.md` 의 새 항목을 훑는다.
- [ ] 다음 날 아침 7시 이후 두 채널에 각각 올라왔는지 확인.
