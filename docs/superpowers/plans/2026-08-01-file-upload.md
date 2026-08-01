# 파일 올리기(디스코드 → 워커) 구현 계획

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 부원이 디스코드에 올린 파일이 미니PC 워커의 자기 작업 폴더에 저장되고, 아사히가 그 경로를 알게 한다.

**Architecture:** 봇은 파일을 옮기지 않는다 — 디스코드 CDN URL 과 저장 위치를 워커에 넘기고 워커가 직접 받는다. 바이트가 허브를 통과하지 않으므로 프레임 상한과 무관하다. 모델은 이 경로에 관여하지 않는다: URL 은 봇이 실제 첨부 객체에서 꺼내므로 워커가 임의 주소를 받아오는 표면이 없다. 모델에게는 기존 이미지 마커와 같은 방식으로 "무엇이 어디에 저장됐는지"만 알린다.

**Tech Stack:** TypeScript (ESM/NodeNext), discord.js, vitest

## 범위

이 계획은 **올리기 방향만** 다룬다. 내려받기(워커 → 디스코드)는 HTTP 업로드 엔드포인트·일회용 id·디스코드 첨부 전송이 붙어 별도 계획으로 간다(스펙 §4.2 의 D 안). 올리기만으로도 완결된 기능이다 — 부원이 아사히에게 파일을 건네는 통로 자체가 지금 없다.

## Global Constraints

- TypeScript ESM/NodeNext — **상대 임포트는 반드시 `.js` 로 끝난다** (소스가 `.ts` 여도)
- 주석·커밋 메시지·사용자 노출 문자열은 전부 **한국어**. 이모지 금지
- 주석은 *왜* 를 설명한다. 코드를 옮겨 적는 주석은 쓰지 않는다
- TDD: 실패하는 테스트를 먼저 쓰고 **실패를 눈으로 확인한 뒤** 구현한다
- 커밋: Conventional Commits + 한국어 제목, 본문 끝에 `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`
- 모든 npm 명령의 작업 디렉터리는 `agent/` 다
- 태스크 완료 전 `npm test` 와 `npm run typecheck` 가 모두 통과해야 한다
- 문서를 건드린 태스크는 리포 루트에서 `node scripts/check-docs.mjs` 가 `문서 검사 통과` 를 내야 한다
- `agent/src/core/paths.ts` 와 `agent/src/remote/roots.ts` 는 읽기 전용 — 이 계획은 건드리지 않는다
- **확장자 차단은 넣지 않는다.** 스펙 §4.3 의 판단이다 — 이름만 바꾸면 그만이라 시늉하는 방어가 되고, 다음 사람이 그것을 진짜 경계로 착각한다

## 파일 구조

| 파일 | 역할 | 태스크 |
|---|---|---|
| `agent/src/core/attachments.ts` | **신규** — 파일 첨부 분류·파일명 안전화·마커(순수) | 1 |
| `agent/src/remote/executors.ts` | `file_fetch` 실행기 | 2 |
| `agent/src/adapters/discord.ts` | `Incoming.files`, 첨부 분류 호출 | 3 |
| `agent/src/events/bus.ts` | `UserMessageEvent.files` | 3 |
| `agent/src/core/core.ts` | 워커 해석 뒤 받아오기 + 마커 | 3 |
| `deploy/smoke-test.md`, `docs/status/STATUS.md`, `docs/security/capability-model.md` | 문서 | 4 |

---

### Task 1: 첨부 분류·파일명 안전화·마커 (순수)

**Files:**
- Create: `agent/src/core/attachments.ts`
- Create: `agent/tests/attachments.test.ts`

**Interfaces:**
- Consumes: 없음
- Produces:
  - `export type FileRef = { url: string; name: string; size: number }`
  - `export const FILE_LIMITS: { maxCount: number; maxBytes: number }`
  - `export function filterFileAttachments(atts: Array<{ url: string; contentType: string | null; name: string; size: number }>, limits?): { files: FileRef[]; skipped: string[] }`
  - `export function safeFileName(name: string): string | null`
  - `export function isDiscordCdnUrl(url: string): boolean`
  - `export function buildFileMarker(text: string, saved: string[], failed: string[]): string`
  - `export function uploadDirFor(o: { workspaceDirs?: string[]; workerRoots: string[] }): string | null`

**왜 `images.ts` 를 고치지 않고 새 파일인가:** `images.ts` 는 "모델에 직접 실어 보내는 멀티모달 입력"을 다루고 이 파일은 "워커 디스크에 내려놓는 파일"을 다룬다 — 목적지가 다르고 제약(크기·개수·검증)도 다르다. 한 파일에 섞으면 `IMAGE_LIMITS` 와 `FILE_LIMITS` 가 같은 것처럼 읽힌다.

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`agent/tests/attachments.test.ts` 를 새로 만든다.

```ts
import { describe, it, expect } from "vitest";
import {
  filterFileAttachments, safeFileName, isDiscordCdnUrl, buildFileMarker, uploadDirFor, FILE_LIMITS,
} from "../src/core/attachments.js";

const att = (o: Partial<{ url: string; contentType: string | null; name: string; size: number }> = {}) => ({
  url: "https://cdn.discordapp.com/attachments/1/2/a.pdf",
  contentType: "application/pdf",
  name: "a.pdf",
  size: 1024,
  ...o,
});

describe("filterFileAttachments", () => {
  it("이미지가 아닌 첨부만 고른다", () => {
    // 이미지는 filterImageAttachments 가 이미 가져가 모델에 직접 실린다. 여기서 또 집으면
    // 같은 파일이 멀티모달 입력으로도 가고 워커 디스크에도 떨어져 두 번 처리된다.
    const r = filterFileAttachments([att(), att({ contentType: "image/png", name: "b.png" })]);
    expect(r.files.map((f) => f.name)).toEqual(["a.pdf"]);
  });

  it("contentType 이 없어도 이미지가 아니면 받는다", () => {
    // 디스코드가 형식을 못 알아본 첨부를 버리면 사용자는 이유를 알 수 없다.
    const r = filterFileAttachments([att({ contentType: null, name: "x.bin" })]);
    expect(r.files.map((f) => f.name)).toEqual(["x.bin"]);
  });

  it("크기 상한을 넘으면 이유와 함께 건너뛴다", () => {
    const r = filterFileAttachments([att({ size: FILE_LIMITS.maxBytes + 1, name: "big.pdf" })]);
    expect(r.files).toEqual([]);
    expect(r.skipped[0]).toContain("big.pdf");
  });

  it("개수 상한을 넘으면 나머지를 건너뛴다", () => {
    const many = Array.from({ length: FILE_LIMITS.maxCount + 2 }, (_, i) => att({ name: `f${i}.pdf` }));
    const r = filterFileAttachments(many);
    expect(r.files).toHaveLength(FILE_LIMITS.maxCount);
    expect(r.skipped).toHaveLength(2);
  });

  it("이름이 안전하지 않으면 건너뛴다", () => {
    const r = filterFileAttachments([att({ name: "../../evil.sh" })]);
    expect(r.files).toEqual([]);
    expect(r.skipped[0]).toContain("evil");
  });
});

describe("safeFileName — 폴더를 벗어나는 이름을 막는다", () => {
  it("평범한 이름은 그대로", () => {
    expect(safeFileName("보고서 v2.pdf")).toBe("보고서 v2.pdf");
  });

  it("경로 구분자가 들어가면 거절한다", () => {
    // 저장 위치는 봇이 정하는데, 이름에 구분자가 있으면 그 결정을 우회한다.
    expect(safeFileName("a/b.pdf")).toBeNull();
    expect(safeFileName("a\\b.pdf")).toBeNull();
  });

  it("상위 이동은 거절한다", () => {
    expect(safeFileName("..")).toBeNull();
    expect(safeFileName("../x")).toBeNull();
  });

  it("빈 이름·점만 있는 이름은 거절한다", () => {
    expect(safeFileName("")).toBeNull();
    expect(safeFileName("   ")).toBeNull();
    expect(safeFileName(".")).toBeNull();
  });

  it("널 바이트가 든 이름은 거절한다", () => {
    // 경로 문자열을 중간에서 끊어 검사를 통과시키는 고전적 수법이다.
    expect(safeFileName("a\u0000.pdf")).toBeNull();
  });
});

describe("isDiscordCdnUrl", () => {
  it("디스코드 CDN 호스트는 통과한다", () => {
    expect(isDiscordCdnUrl("https://cdn.discordapp.com/attachments/1/2/a.pdf")).toBe(true);
    expect(isDiscordCdnUrl("https://media.discordapp.net/attachments/1/2/a.png")).toBe(true);
  });

  it("비슷하게 생긴 호스트는 거절한다", () => {
    // 접두·접미 일치로 검사하면 전부 통과한다. 호스트 전체가 같아야 한다.
    expect(isDiscordCdnUrl("https://cdn.discordapp.com.evil.test/a.pdf")).toBe(false);
    expect(isDiscordCdnUrl("https://evil.test/cdn.discordapp.com/a.pdf")).toBe(false);
    expect(isDiscordCdnUrl("https://xcdn.discordapp.com/a.pdf")).toBe(false);
  });

  it("http 는 거절한다", () => {
    expect(isDiscordCdnUrl("http://cdn.discordapp.com/attachments/1/2/a.pdf")).toBe(false);
  });

  it("URL 이 아니면 거절한다", () => {
    expect(isDiscordCdnUrl("cdn.discordapp.com/a.pdf")).toBe(false);
    expect(isDiscordCdnUrl("")).toBe(false);
  });
});

describe("uploadDirFor — 저장 위치는 봇이 정한다", () => {
  it("손님은 자기 몫으로 좁혀진 폴더에 저장한다", () => {
    expect(uploadDirFor({ workspaceDirs: ["C:\\ws\\111"], workerRoots: ["C:\\ws"] })).toBe("C:\\ws\\111");
  });

  it("소유자는 워커 루트에 저장한다", () => {
    // resolveGuestWorkspaceDirs(core.ts)는 소유자에게 undefined 를 돌려준다 — scopeDirs 가
    // 소유자를 좁히지 않아 "그 사람의 폴더" 하나로 특정되지 않기 때문이다. 그래서 루트를 쓴다.
    expect(uploadDirFor({ workspaceDirs: undefined, workerRoots: ["C:\\ws"] })).toBe("C:\\ws");
  });

  it("둘 다 비면 null 이다(저장할 곳이 없다)", () => {
    expect(uploadDirFor({ workspaceDirs: [], workerRoots: [] })).toBeNull();
    expect(uploadDirFor({ workspaceDirs: undefined, workerRoots: [] })).toBeNull();
  });
});

describe("buildFileMarker", () => {
  it("저장된 경로를 본문 앞에 붙인다", () => {
    // 경로가 마커에 들어가는 것이 핵심이다 — 없으면 모델이 fs_read 로 열 방법을 모른다.
    const out = buildFileMarker("이거 봐줘", ["C:\\ws\\1\\a.pdf"], []);
    expect(out).toContain("C:\\ws\\1\\a.pdf");
    expect(out).toContain("이거 봐줘");
  });

  it("실패한 파일도 알린다", () => {
    // 조용히 버리는 것이 이 기능이 고치려는 문제다. 같은 침묵을 다른 자리에 다시 만들지 않는다.
    const out = buildFileMarker("", [], ["a.pdf(받아오지 못함)"]);
    expect(out).toContain("a.pdf");
  });

  it("아무것도 없으면 본문을 그대로 둔다", () => {
    expect(buildFileMarker("안녕", [], [])).toBe("안녕");
  });
});
```

- [ ] **Step 2: 테스트를 돌려 실패를 확인**

```bash
cd agent && npx vitest run tests/attachments.test.ts
```

기대: FAIL — `Cannot find module '../src/core/attachments.js'`.

- [ ] **Step 3: `attachments.ts` 를 만든다**

`agent/src/core/attachments.ts`:

```ts
// 디스코드 첨부 중 "워커 디스크에 내려놓을" 파일을 다룬다. images.ts 와 나눠 둔 이유는 목적지가
// 다르기 때문이다 — 이미지는 모델에 멀티모달 입력으로 직접 실리고, 여기 파일은 미니PC 에
// 저장돼 fs_*·sh_exec 가 다루는 대상이 된다. 한 파일에 섞으면 두 상한이 같은 것처럼 읽힌다.
type RawAttachment = { url: string; contentType: string | null; name: string; size: number };

export type FileRef = { url: string; name: string; size: number };

// 8MB 인 이유(스펙 §4.2): 이 값은 내려받기 방향의 디스코드 첨부 한도와 짝을 맞춘 것이다. 그
// 한도는 서버 부스트 등급·시기에 따라 달라져 왔고 8MB 는 모든 등급에서 확실히 통과한다.
// 올리기만 놓고 보면 더 커도 되지만, 두 방향의 상한이 다르면 "올라갔는데 못 돌려받는" 파일이
// 생긴다.
export const FILE_LIMITS = Object.freeze({ maxCount: 3, maxBytes: 8 * 1024 * 1024 } as const);

// 디스코드가 첨부를 서빙하는 호스트. URL 파싱 후 hostname 전체와 비교한다 — 문자열 포함으로
// 검사하면 cdn.discordapp.com.evil.test 가 통과한다.
const CDN_HOSTS = Object.freeze(["cdn.discordapp.com", "media.discordapp.net"] as const);

export function isDiscordCdnUrl(url: string): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  // https 로 고정한다 — 평문으로 받아오면 첨부 내용이 그대로 노출된다.
  return u.protocol === "https:" && (CDN_HOSTS as readonly string[]).includes(u.hostname);
}

// 저장 위치는 봇이 정한다. 이름에 경로 구분자나 상위 이동이 있으면 그 결정을 우회하므로,
// 고쳐서 쓰지 않고 아예 거절한다 — 고치면 "무엇으로 고쳐졌는지"를 사람도 모델도 모른다.
export function safeFileName(name: string): string | null {
  const n = name.trim();
  if (n.length === 0) return null;
  if (n.includes("\u0000")) return null; // 경로 문자열을 중간에서 끊는 고전적 수법
  if (n.includes("/") || n.includes("\\")) return null;
  if (n === "." || n === "..") return null;
  return n;
}

export function filterFileAttachments(
  atts: RawAttachment[],
  limits: { maxCount: number; maxBytes: number } = FILE_LIMITS,
): { files: FileRef[]; skipped: string[] } {
  const files: FileRef[] = [];
  const skipped: string[] = [];
  for (const a of atts) {
    const mt = (a.contentType ?? "").split(";")[0].trim().toLowerCase();
    if (mt.startsWith("image/")) continue; // images.ts 가 가져간다 — 두 번 처리하지 않는다
    const name = safeFileName(a.name);
    if (name === null) { skipped.push(`${a.name}(이름을 쓸 수 없음)`); continue; }
    if (a.size > limits.maxBytes) { skipped.push(`${name}(너무 큼)`); continue; }
    if (files.length >= limits.maxCount) { skipped.push(`${name}(개수 초과)`); continue; }
    files.push({ url: a.url, name, size: a.size });
  }
  return { files, skipped };
}

// 첨부를 어디에 저장할지. 이 판정을 봇이 하는 것이 중요하다 — 모델이 정하면 폴더 격리를
// 우회할 수 있다.
//
// 손님은 workspaceDirs(이미 scopeDirs 로 그 사람 몫으로 좁혀진 값)의 첫 폴더다. 소유자는
// core.ts 의 resolveGuestWorkspaceDirs 가 undefined 를 돌려준다 — scopeDirs 가 소유자를 좁히지
// 않아 "그 사람의 폴더" 하나로 특정되지 않기 때문이다. 그래서 소유자는 워커 루트를 쓴다.
export function uploadDirFor(o: { workspaceDirs?: string[]; workerRoots: string[] }): string | null {
  return o.workspaceDirs?.[0] ?? o.workerRoots[0] ?? null;
}

// 모델에게 "무엇이 어디에 저장됐는지"를 알린다. buildImageMarker(images.ts)와 같은 자리·같은
// 방식이다. 경로가 들어가는 것이 핵심이다 — 경로가 없으면 모델이 fs_read 로 열 방법을 모른다.
//
// 실패도 함께 싣는다. 조용히 버리는 것이 이 기능이 고치려는 문제이므로(이미지가 아닌 첨부를
// 무시하던 종전 동작), 같은 침묵을 다른 자리에 다시 만들지 않는다.
export function buildFileMarker(text: string, saved: string[], failed: string[]): string {
  const parts: string[] = [];
  if (saved.length > 0) parts.push(`[파일 ${saved.length}개 저장됨: ${saved.join(", ")}]`);
  if (failed.length > 0) parts.push(`[파일 처리 실패: ${failed.join(", ")}]`);
  if (parts.length === 0) return text;
  const marker = parts.join(" ");
  return text.trim() ? `${marker} ${text}` : marker;
}
```

- [ ] **Step 4: 테스트가 통과하는지 확인**

```bash
cd agent && npx vitest run tests/attachments.test.ts
```

기대: PASS (21건).

- [ ] **Step 5: 역전 시험**

셋을 차례로 확인하고 각각 되돌린다.

1. `isDiscordCdnUrl` 의 `u.hostname` 비교를 `url.includes("cdn.discordapp.com")` 로 → "비슷하게 생긴 호스트" 가 **FAIL**
2. `safeFileName` 의 구분자 검사를 지움 → "경로 구분자" 가 **FAIL**
3. `filterFileAttachments` 의 `if (mt.startsWith("image/")) continue;` 를 지움 → "이미지가 아닌 첨부만 고른다" 가 **FAIL**

- [ ] **Step 6: 전체 검증**

```bash
cd agent && npm test && npm run typecheck
```

- [ ] **Step 7: 커밋**

```bash
git add agent/src/core/attachments.ts agent/tests/attachments.test.ts
git commit -F - <<'EOF'
feat(core): 파일 첨부 분류와 이름·주소 검증을 더한다

지금은 이미지가 아닌 첨부가 조용히 무시된다(images.ts:21). 부원이 PDF 를 올려도 봇은 그런
것이 있었다는 사실조차 모른다. 그것을 고치는 첫 조각으로, 순수 판정부터 만든다.

images.ts 에 섞지 않고 새 파일로 둔 이유는 목적지가 다르기 때문이다 — 이미지는 모델에
멀티모달 입력으로 직접 실리고, 여기 파일은 미니PC 디스크에 저장돼 fs_*·sh_exec 의 대상이
된다. 한 파일에 섞으면 두 상한이 같은 것처럼 읽힌다.

호스트 검증은 문자열 포함이 아니라 URL 파싱 후 hostname 전체 비교다 — 포함으로 검사하면
cdn.discordapp.com.evil.test 가 통과한다. 파일명은 고쳐 쓰지 않고 거절한다: 고치면 무엇으로
고쳐졌는지 사람도 모델도 모른다.

확장자 차단은 넣지 않는다(스펙 §4.3) — 이름만 바꾸면 그만이라 시늉하는 방어가 되고, 다음
사람이 그것을 진짜 경계로 착각한다.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
```

---

### Task 2: 워커 실행기 `file_fetch`

**Files:**
- Modify: `agent/src/remote/executors.ts`
- Test: `agent/tests/remoteExecutors.test.ts`

**Interfaces:**
- Consumes: Task 1 의 `isDiscordCdnUrl`
- Produces: 워커 실행기에 `file_fetch(args: { url: unknown; dir: unknown; name: unknown }): Promise<ExecResult>` 가 생긴다. 성공하면 `content` 에 저장된 실경로가 담긴다.

**경로가 아니라 폴더+이름을 받는 이유:** 봇은 리눅스 컨테이너, 워커는 윈도우다. 봇에서 `path.join` 하면 `/` 로 이어붙어 워커의 경로와 어긋난다(`paths.ts` 가 같은 이유로 플랫폼별 처리를 따로 두고 있다). 조립은 **파일이 실제로 놓일 기계**가 한다.

**모델 도구가 아니다.** `REMOTE_TOOL_NAMES`(`agent/src/core/remoteTools.ts:11`)에 **넣지 않는다.** 그 목록에 있는 것만 `mcp__asahi__*` MCP 도구로 노출되므로, 넣지 않으면 모델이 부를 방법 자체가 없다. 봇이 `hub.call(...)` 로 직접 부른다(Task 3).

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`agent/tests/remoteExecutors.test.ts` 에 추가한다. 이 파일이 이미 쓰는 `makeExecutors(roots, opts)` 호출 방식과 임시 루트 생성 방식을 먼저 읽고 그대로 따른다.

```ts
describe("file_fetch — 봇이 부르는 첨부 저장(모델 도구가 아니다)", () => {
  it("허용 폴더 밖은 거부한다", async () => {
    const ex = makeExecutors([root]);
    const r = await ex.file_fetch({ url: "https://cdn.discordapp.com/attachments/1/2/a.pdf", dir: path.join(root, ".."), name: "escape.pdf" });
    expect(r.ok).toBe(false);
    expect(r.content).toContain("허용");
  });

  it("이름으로 폴더를 벗어나려 해도 거부한다", async () => {
    // 봇이 safeFileName 으로 이미 걸렀지만 워커가 다시 막는다 — 봇을 신뢰하지 않는다.
    const ex = makeExecutors([root]);
    const r = await ex.file_fetch({ url: "https://cdn.discordapp.com/attachments/1/2/a.pdf", dir: root, name: "../escape.pdf" });
    expect(r.ok).toBe(false);
  });

  it("디스코드 CDN 이 아닌 주소는 거부한다", async () => {
    // 봇이 이미 실제 첨부에서 URL 을 꺼내지만, 워커는 봇을 신뢰하지 않고 다시 판정한다 —
    // 이 리포의 이중 게이트 원칙(봇 1차 필터 + 워커 최종 판정) 그대로다.
    const ex = makeExecutors([root]);
    const r = await ex.file_fetch({ url: "https://evil.test/a.pdf", dir: root, name: "a.pdf" });
    expect(r.ok).toBe(false);
    expect(r.content).toContain("디스코드");
  });

  it("받아서 바이너리 그대로 파일로 쓴다", async () => {
    // utf8 로 쓰면 0x00·0x80 이상 바이트가 깨진다 — PDF·docx 는 전부 바이너리다.
    const bytes = new Uint8Array([0, 1, 2, 255, 128]);
    const ex = makeExecutors([root], {
      fetchImpl: (async () => new Response(bytes, { status: 200 })) as unknown as typeof fetch,
    });
    const r = await ex.file_fetch({ url: "https://cdn.discordapp.com/attachments/1/2/a.pdf", dir: root, name: "a.pdf" });
    expect(r.ok).toBe(true);
    expect(r.content).toBe(path.join(root, "a.pdf"));
    expect(await fsp.readFile(path.join(root, "a.pdf"))).toEqual(Buffer.from(bytes));
  });

  it("응답이 실패면 파일을 만들지 않는다", async () => {
    const ex = makeExecutors([root], {
      fetchImpl: (async () => new Response("nope", { status: 404 })) as unknown as typeof fetch,
    });
    const r = await ex.file_fetch({ url: "https://cdn.discordapp.com/attachments/1/2/a.pdf", dir: root, name: "missing.pdf" });
    expect(r.ok).toBe(false);
    expect(r.content).toContain("404");
    await expect(fsp.access(path.join(root, "missing.pdf"))).rejects.toThrow();
  });
});
```

`root`·`fsp`·`path` 는 이 파일이 이미 쓰는 것을 그대로 쓴다. `makeExecutors` 의 두 번째 인자에 `fetchImpl` 이 없으면 Step 3 에서 더한다.

- [ ] **Step 2: 테스트를 돌려 실패를 확인**

```bash
cd agent && npx vitest run tests/remoteExecutors.test.ts -t "file_fetch"
```

기대: FAIL — `ex.file_fetch is not a function`.

- [ ] **Step 3: 실행기를 더한다**

`agent/src/remote/executors.ts` 의 import 에 더한다.

```ts
import { isDiscordCdnUrl } from "../core/attachments.js";
```

`makeExecutors` 의 옵션 타입에 `fetchImpl?: typeof fetch` 를 더한다(이 파일이 `runPm2` 를 주입 가능하게 둔 것과 같은 이유 — 실제 네트워크 없이 성패 양쪽을 테스트하기 위해서다).

실행기 맵(`return {` 아래)에 더한다.

```ts
    // 봇이 직접 부른다 — REMOTE_TOOL_NAMES 에 없으므로 모델에게 도구로 노출되지 않는다.
    // 모델이 URL 을 정하게 하면 워커가 임의 주소를 받아오는 표면이 열리는데, 그 표면 자체가 없다.
    async file_fetch(args) {
      const dir = str(args.dir);
      const name = str(args.name);
      if (!dir || !name) return { ok: false, content: "dir·name 인자가 필요해요." };
      // 조립은 파일이 실제로 놓일 이 기계가 한다 — 봇은 리눅스, 워커는 윈도우라 봇에서
      // 이어붙이면 구분자가 어긋난다. gate 가 그 결과를 허용 폴더 기준으로 최종 판정하므로
      // 이름으로 폴더를 벗어나려는 시도도 여기서 막힌다(봇의 safeFileName 과 이중 게이트).
      const g = gate(path.join(dir, name));
      if (!g.ok) return g.res;
      const url = str(args.url);
      // 봇이 이미 실제 첨부 객체에서 꺼낸 URL 이지만 여기서 다시 판정한다 — 봇 1차 필터와
      // 워커 최종 판정 두 겹은 이 리포의 원칙이고(remoteTools.ts 주석), 이 경로만 예외로 둘
      // 이유가 없다.
      if (!url || !isDiscordCdnUrl(url)) {
        return { ok: false, content: "디스코드 첨부 주소가 아니라 받아오지 않았어요." };
      }
      try {
        const res = await (opts.fetchImpl ?? fetch)(url);
        if (!res.ok) return { ok: false, content: `받아오지 못했어요(HTTP ${res.status}).` };
        const buf = Buffer.from(await res.arrayBuffer());
        await fs.mkdir(path.dirname(g.path), { recursive: true });
        await fs.writeFile(g.path, buf);
        return { ok: true, content: g.path };
      } catch (err) {
        return { ok: false, content: `받아오지 못했어요: ${String(err)}` };
      }
    },
```

`fs.writeFile(g.path, buf)` 에 인코딩을 주지 않는 것이 핵심이다 — `fs_write` 는 `"utf8"` 을 줘서 텍스트만 쓰는데, 여기는 바이너리를 그대로 써야 한다.

- [ ] **Step 4: 테스트가 통과하는지 확인**

```bash
cd agent && npx vitest run tests/remoteExecutors.test.ts -t "file_fetch"
```

기대: PASS (5건).

- [ ] **Step 5: 모델에게 노출되지 않는 것을 확인한다**

```bash
cd agent && grep -n "file_fetch" src/core/remoteTools.ts src/core/tools.ts
```

기대: **출력 없음.** 한 줄이라도 나오면 모델 도구가 된 것이므로 되돌린다.

- [ ] **Step 6: 역전 시험**

`isDiscordCdnUrl` 검사 줄을 지우고 돌린다. "디스코드 CDN 이 아닌 주소는 거부한다" 가 **FAIL** 해야 한다. 확인 후 되돌린다.

- [ ] **Step 7: 전체 검증**

```bash
cd agent && npm test && npm run typecheck
```

- [ ] **Step 8: 커밋**

```bash
git add agent/src/remote/executors.ts agent/tests/remoteExecutors.test.ts
git commit -F - <<'EOF'
feat(remote): 워커가 디스코드 첨부를 직접 받아 저장한다

봇은 파일을 옮기지 않는다 — URL 과 저장 위치만 넘기고 워커가 CDN 에서 직접 받는다. 바이트가
허브를 통과하지 않으므로 MAX_FRAME_CHARS(1,000,000, 초과 시 연결 종료)와 무관하고 봇 메모리도
쓰지 않는다.

모델 도구가 아니다. REMOTE_TOOL_NAMES 에 넣지 않으므로 mcp__asahi__* 로 노출되지 않고 모델이
부를 방법 자체가 없다 — 모델이 URL 을 정하게 하면 워커가 임의 주소를 받아오는 표면이 열리는데
그 표면을 아예 만들지 않는다.

봇이 이미 실제 첨부 객체에서 URL 을 꺼내지만 워커가 다시 판정한다. 봇 1차 필터 + 워커 최종
판정 두 겹은 이 리포의 원칙이고 이 경로만 예외로 둘 이유가 없다.

fs.writeFile 에 인코딩을 주지 않는다 — fs_write 는 "utf8" 이라 텍스트만 쓰는데 여기는
바이너리를 그대로 써야 한다.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
```

---

### Task 3: 봇 배선 — 어댑터에서 워커까지

**Files:**
- Modify: `agent/src/adapters/discord.ts`, `agent/src/events/bus.ts`, `agent/src/core/core.ts`
- Test: `agent/tests/core.test.ts` 또는 이 리포에서 `AgentCore` 를 검증하는 파일(먼저 확인한다)

**Interfaces:**
- Consumes: Task 1 의 `filterFileAttachments`/`buildFileMarker`/`FileRef`, Task 2 의 `file_fetch`
- Produces: 없음(이 계획의 마지막 코드 태스크)

- [ ] **Step 1: 어댑터가 파일을 분류해 싣는다**

`agent/src/adapters/discord.ts` 의 import 에 더한다.

```ts
import { filterFileAttachments, type FileRef } from "../core/attachments.js";
```

`Incoming` 타입에 더한다.

```ts
export type Incoming = {
  userId: string; channelId: string; isDM: boolean; isThread: boolean; mentionsBot: boolean;
  guildId?: string; parentChannelId?: string; content: string; messageId: string;
  images: ImageRef[];
  files: FileRef[];
};
```

`onMessage` 에서 이미지 분류 바로 아래에 더한다.

```ts
    const { images } = filterImageAttachments(
      [...message.attachments.values()].map((a) => ({ url: a.url, contentType: a.contentType, name: a.name, size: a.size })),
    );
    const { files } = filterFileAttachments(
      [...message.attachments.values()].map((a) => ({ url: a.url, contentType: a.contentType, name: a.name, size: a.size })),
    );
```

`incoming` 리터럴에 `files,` 를 더한다.

**주의:** 이 분류는 `decideRoute` 의 무시 판정보다 **앞에서** 계산되지만, 실제로 받아오는 것은 core 다 — 무시된 메시지는 core 까지 가지 않으므로 파일도 받아오지 않는다. 분류 자체는 부작용이 없으므로 이 위치가 안전하다.

- [ ] **Step 2: 버스 이벤트에 싣는다**

`agent/src/events/bus.ts` 의 import 에 더한다.

```ts
import type { FileRef } from "../core/attachments.js";
```

`UserMessageEvent` 에 더한다.

```ts
export type UserMessageEvent = { type: "user_message"; channel: ChannelKind; channelRef: string; text: string; ts: number; hint?: ConversationHint; images?: ImageRef[]; files?: FileRef[] };
```

어댑터가 이 이벤트를 발행하는 자리를 찾아(`images` 를 싣는 곳) `files` 도 함께 싣는다.

- [ ] **Step 3: core 가 워커를 정한 뒤 받아온다**

**먼저 `core.ts` 의 `hub` 타입을 넓혀야 한다.** 지금은 `{ isConnected(workerId: string): boolean }` 하나뿐이라(`core.ts:176`, `:195`) 워커를 부를 수 없다. `agent.ts` 의 `makeRunAgentTurn` 이 받는 구조적 타입과 같은 방식으로 두 메서드를 더한다.

`core.ts:176` 의 필드 선언:

```ts
  private hub?: {
    isConnected(workerId: string): boolean;
    call(workerId: string, tool: string, args: Record<string, unknown>): Promise<{ ok: boolean; content: string }>;
    rootsOf(workerId: string): string[];
  };
```

`core.ts:195` 의 생성자 옵션에도 **같은 타입**을 적는다(두 곳이 갈리면 컴파일이 막힌다). `index.ts` 는 이미 실제 `hub` 인스턴스를 넘기고 있어 호출측은 손댈 것이 없다.

import 에 더한다.

```ts
import { buildFileMarker, uploadDirFor, type FileRef } from "./attachments.js";
```

`ingest` 와 `runConversationTurn` 이 `images` 를 나르는 방식과 **같은 모양**으로 `files` 를 함께 나른다 — `ingest(hint, ts, text, images)` → `ingest(hint, ts, text, images, files)`, `runConversationTurn(..., images)` → `(..., images, files)`, 그리고 `handleUserMessage` 의 `this.ingest(...)` 호출에 `e.files ?? []` 를 더한다.

`runConversationTurn` 안, `workspaceDirs` 를 구하는 줄 **뒤에** 넣는다.

```ts
      const workspaceDirs = await this.resolveGuestWorkspaceDirs(worker, isOwner, userId);

      // 첨부 파일을 워커에 내려놓는다. 저장 위치는 봇이 정한다 — 모델이 정하면 폴더 격리를
      // 우회할 수 있다(uploadDirFor: 손님은 이미 좁혀진 폴더, 소유자는 워커 루트).
      //
      // 경로 조립은 워커가 한다. 봇은 리눅스 컨테이너고 워커는 윈도우라 여기서 이어붙이면
      // 구분자가 어긋난다 — 폴더와 이름을 따로 넘긴다.
      const savedFiles: string[] = [];
      const failedFiles: string[] = [];
      if (files.length > 0) {
        const hub = this.hub;
        const dir = worker === null || hub === undefined
          ? null
          : uploadDirFor({ workspaceDirs, workerRoots: hub.rootsOf(worker.workerId) });
        if (worker === null || hub === undefined || dir === null) {
          // 조용히 버리지 않는다 — 이미지가 아닌 첨부를 무시하던 것이 이 기능이 고치려는 문제다.
          // 같은 침묵을 다른 자리에 다시 만들지 않는다.
          for (const f of files) failedFiles.push(`${f.name}(워커가 연결돼 있지 않아 저장 못 함)`);
        } else {
          for (const f of files) {
            try {
              const r = await hub.call(worker.workerId, "file_fetch", { url: f.url, dir, name: f.name });
              if (r.ok) savedFiles.push(r.content);
              else failedFiles.push(`${f.name}(${r.content})`);
            } catch (err) {
              // 받아오기 실패가 대화를 막지 않는다 — 이미지 다운로드 실패와 같은 원칙이다.
              failedFiles.push(`${f.name}(${err instanceof Error ? err.message : String(err)})`);
            }
          }
        }
      }
```

`resolveGuestWorkspaceDirs` 가 소유자에게 `undefined` 를 돌려준다는 것(`core.ts:593` — `if (worker === null || worker.kind !== "shared" || isOwner) return undefined;`)이 `uploadDirFor` 가 워커 루트로 떨어지는 이유다. Task 1 의 테스트가 그 갈래를 고정한다.

- [ ] **Step 4: 마커를 프롬프트에 붙인다**

**이미지 마커와 붙이는 자리가 다르다.** `buildImageMarker` 는 DB 기록에만 쓰인다(`core.ts:283`) — 이미지는 모델에게 멀티모달 입력으로 직접 실리므로 프롬프트에 따로 적을 필요가 없고, 그 마커는 **나중 턴이 볼 이력**을 위한 것이다.

파일은 반대다. 모델에게 실리는 것이 없으므로 **저장 경로를 이번 턴 프롬프트에 넣지 않으면 모델이 그 파일의 존재도 위치도 모른다.**

`prompt` 는 `core.ts:443` 에서 `let prompt = text;` 로 시작해 컨텍스트 블록이 있으면 `:447` 에서 다시 조립되는데, 그 시점은 워커를 정하기 **전**이라 아직 저장 경로가 없다. 그래서 Step 3 의 받아오기 **직후**, `runTurn` 호출 전에 덮어쓴다.

```ts
      // 저장 경로를 이번 턴 프롬프트에 싣는다. 이미지와 달리 파일은 모델에게 실리는 것이 없어,
      // 여기서 알리지 않으면 모델이 그 파일의 존재도 위치도 모른다. prompt 는 :443/:447 에서
      // 이미 조립됐지만 그때는 워커를 정하기 전이라 경로가 없었다.
      prompt = buildFileMarker(prompt, savedFiles, failedFiles);
```

**`core.ts:283` 의 DB 기록은 건드리지 않는다.** 그 자리(`ingest`)는 파일을 받아오기 전이라 저장 경로가 아직 없고, 파일명만 적으면 사실이 아닌 것을 기록하게 된다. 경로는 SDK 세션에 남아 `resume` 로 이어지는 턴에서 그대로 보인다.

- [ ] **Step 4b: 두 마커가 함께 있을 때 본문이 남는지 확인**

이미지와 파일을 함께 올린 경우 `prompt` 는 마커 + 본문 형태가 되고, DB 에는 이미지 마커 + 본문이 저장된다. 본문이 사라지지 않는지 Task 1 의 `buildFileMarker` 테스트("아무것도 없으면 본문을 그대로 둔다")와 실제 프롬프트 조립 양쪽으로 확인한다.

- [ ] **Step 5: 배선 테스트를 더한다**

`agent/tests/coreMulti.test.ts` 가 `AgentCore` 를 검증하는 파일이다. 그 파일이 `AgentCore` 를 세우는 방식(가짜 `runTurn`·`bus`·리포)을 먼저 읽고 그대로 따른다.

최소한 이 둘을 고정한다.

- 워커가 연결돼 있지 않은 상태에서 파일이 붙은 메시지가 오면, **`hub.call` 이 한 번도 불리지 않고** 실패 안내가 프롬프트에 붙으며 턴은 정상 진행된다
- 워커가 연결된 상태에서 `hub.call` 이 `"file_fetch"` 라는 도구 이름과 `{ url, dir, name }` 으로 불리고, 성공하면 **그 반환 경로가 `runTurn` 이 받은 `prompt` 에 들어 있다**

두 번째가 이 태스크의 핵심 단정이다 — 경로가 프롬프트에 없으면 모델이 파일을 열 수 없고, 그 실패는 "아사히가 파일 얘기를 안 함"으로만 나타나 원인을 찾기 어렵다. 가짜 `runTurn` 이 받은 `prompt` 를 붙잡아 직접 확인한다.

가짜 허브는 최소한만 만든다.

```ts
const calls: Array<{ tool: string; args: Record<string, unknown> }> = [];
const fakeHub = {
  isConnected: () => true,
  rootsOf: () => ["C:\\ws"],
  call: async (_w: string, tool: string, args: Record<string, unknown>) => {
    calls.push({ tool, args });
    return { ok: true, content: "C:\\ws\\111\\a.pdf" };
  },
};
```

워커가 실제로 연결된 것으로 보이게 하려면 `registry` 도 함께 채워야 한다(`resolveTurnWorker` 가 `registry` 와 `hub` 둘 다 있어야 워커를 돌려준다 — `agent.ts:206`). `coreMulti.test.ts` 가 워커 연결 상황을 이미 세우고 있으면 그 방식을 그대로 쓴다.

- [ ] **Step 6: 전체 검증**

```bash
cd agent && npm test && npm run typecheck
```

- [ ] **Step 7: 커밋**

```bash
git add agent/src/adapters/discord.ts agent/src/events/bus.ts agent/src/core/core.ts agent/tests
git commit -F - <<'EOF'
feat(core): 디스코드 첨부를 워커에 저장하고 모델에게 경로를 알린다

어댑터는 첨부를 분류만 하고, 실제 받아오기는 core 의 턴 처리에서 한다 — 그 자리가
resolveTurnWorker 로 "이 턴이 어느 기계를 쓰는가"를 이미 정하는 곳이고 어댑터에는 허브가 없다.

저장 위치는 봇이 정한다. 모델이 정하면 폴더 격리를 우회할 수 있다 — 손님은 이미 그 사람 몫으로
좁혀진 폴더, 소유자는 워커 루트다.

워커가 없을 때 조용히 버리지 않고 실패를 마커로 알린다. 이미지가 아닌 첨부를 조용히 무시하던
것이 이 기능이 고치려는 문제이므로, 같은 침묵을 다른 자리에 다시 만들지 않는다.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
```

---

### Task 4: 문서와 스모크

**Files:**
- Modify: `deploy/smoke-test.md`, `docs/status/STATUS.md`, `docs/security/capability-model.md`

**Interfaces:**
- Consumes: Task 1~3
- Produces: 없음

- [ ] **Step 1: `capability-model.md` 에 이 능력을 적는다**

능력 계층표가 있는 문서다. 파일 올리기는 **신원으로 가르지 않는다**(전원이 자기 폴더에 올린다)는 것과, 저장 위치가 `scopeDirs` 와 같은 규칙이라는 것을 적는다. 그리고 스펙 §4.3 의 판단을 그대로 옮긴다:

- **새 능력이 아니다** — `sh_exec` 가 이미 경로 게이트 밖이라 지금도 셸로 파일을 만들 수 있다. 진짜 경계는 그대로 미니PC 의 비관리자 계정이다
- **다만 난이도는 낮아진다** — 그 사실을 인정하고 상한(8MB·3개)·위치 강제·CDN 제한으로 좁혔다
- **확장자 차단은 하지 않는다** — 이름만 바꾸면 그만이라 시늉하는 방어가 되고, 다음 사람이 그것을 진짜 경계로 착각한다. 이 리포가 폴더 격리에 대해 이미 명시적으로 피해 온 실수다

- [ ] **Step 2: `deploy/smoke-test.md` 에 항목 셋을 더한다**

```markdown
- [ ] **첨부한 파일이 미니PC 에 저장되는가** — 서버 채널에서 PDF 를 하나 첨부해 "이 파일 확인해줘"
  라고 보낸다.
  기대 결과: 아사히가 저장된 **절대경로**를 말하고, `fs_read` 나 `sh_exec` 로 그 파일을 실제로
  열 수 있다. 경로를 말하지 않으면 마커에 경로가 안 들어간 것이다(`buildFileMarker`).

- [ ] **저장 위치가 그 사람의 폴더인가** — 손님 계정으로 같은 일을 한다.
  기대 결과: `<루트>/<그 손님의 디스코드 id>/` 안에 저장된다. 다른 사람 폴더나 루트에 저장되면
  위치 강제가 깨진 것이다(`core.ts` 의 저장 위치 계산).

- [ ] **워커가 없을 때 조용히 버리지 않는가** — 미니PC 워커를 내린 상태에서 파일을 첨부한다.
  기대 결과: 아사히가 **워커가 연결돼 있지 않아 파일을 받지 못했다고 말한다.** 파일 얘기를
  아예 안 하면 조용한 무시로 되돌아간 것이다 — 이 기능이 고치려던 바로 그 동작이다.
```

- [ ] **Step 3: `docs/status/STATUS.md` 를 갱신한다**

"병합된 주요 기능" 절에 한 항목을 더한다. 담을 것: 디스코드 첨부가 워커의 그 사람 폴더에 저장된다는 것, 봇이 파일을 옮기지 않고 워커가 CDN 에서 직접 받는다는 것, 상한(8MB·3개), **내려받기는 아직 없다는 것**(별도 계획).

- [ ] **Step 4: 문서 검사**

```bash
node scripts/check-docs.mjs
```

기대: `문서 검사 통과`.

- [ ] **Step 5: 전체 검증**

```bash
cd agent && npm test && npm run typecheck
```

- [ ] **Step 6: 커밋**

```bash
git add deploy/smoke-test.md docs/status/STATUS.md docs/security/capability-model.md
git commit -F - <<'EOF'
docs(files): 파일 올리기를 능력 모델·스모크·현황에 적는다

능력 계층표에 이 능력이 신원으로 갈리지 않는다는 것과 저장 위치가 scopeDirs 와 같은 규칙이라는
것을 적었다. 보안 판단도 스펙 그대로 옮겼다 — 새 능력이 아니지만(sh_exec 가 이미 경로 게이트
밖이다) 난이도는 낮아지므로 상한·위치 강제·CDN 제한으로 좁혔고, 확장자 차단은 시늉하는 방어가
되므로 넣지 않았다.

스모크 세 번째 항목이 중요하다: 워커가 없을 때 아사히가 그 사실을 말하는지 본다. 파일 얘기를
아예 안 하면 조용한 무시로 되돌아간 것이고, 그것이 이 기능이 고치려던 동작이다.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
```

---

## 배포 후 확인

이 계획의 변경은 **봇과 워커 양쪽**에 걸쳐 있다. `file_fetch` 실행기는 워커에서 돌고 나머지는 봇이다. main 에 머지하면 Railway 가 봇을 배포하고 미니PC 는 `update-worker.ps1` 이 5분 안에 받아 워커를 다시 띄운다.

**워커가 갱신되기 전에는 첨부가 실패한다** — 옛 워커에는 `file_fetch` 실행기가 없어 `hub.call` 이 "알 수 없는 도구" 로 돌아온다. 그 경우 실패 마커가 붙으므로 조용히 사라지지는 않는다. 스모크는 `runtime_info` 로 워커 커밋이 봇과 일치하는 것을 확인한 뒤에 시작한다.
