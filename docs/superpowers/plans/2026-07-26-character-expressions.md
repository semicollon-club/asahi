# 상황별 캐릭터 표정 이미지 출력 구현 계획

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 모델이 답변에 `[표정:홍조]` 같은 마커를 섞어 쓰면, 봇이 해당 표정 이미지를 embed 로 함께 보낸다.

**Architecture:** 이미지는 Supabase Storage 에 올리고 카탈로그(감정 → URL)를 Postgres 테이블에 둔다. 마커 파싱은 `core/expressions.ts` 의 순수 함수가 맡고, 감정→URL 해석·빈도 제한·embed 전송은 전부 어댑터가 한다 — 마커는 표시 지시이므로 코어는 이미지를 아예 모른다. 봇에 새 런타임 의존성은 없다.

**Tech Stack:** TypeScript (ESM, Node 22), vitest, discord.js (`EmbedBuilder`), pg, Supabase Storage REST

**설계 문서:** [2026-07-26-character-expressions-design.md](../specs/2026-07-26-character-expressions-design.md)

## Global Constraints

- **한국어.** 코드 주석·프롬프트·테스트 설명 전부 한국어.
- **작업 디렉토리는 `agent/`** (동기화 스크립트만 리포 루트에서 실행).
- **봇에 새 런타임 의존성 금지.** 업로드는 스크립트가 `fetch`, 카탈로그는 기존 `pg`.
- **마커 문법 고정:** `[표정:<감정>]`. 감정 이름은 폴더명 그대로이며 공백을 포함할 수 있다(`기본 무표정`, `빤히 응시`).
- **감정 폴더 10종:** 기본 무표정 · 당황 · 멍함 · 빤히 응시 · 웃음 · 절망 · 졸림 · 혼란 · 홍조 · 화남. `임시` 는 감정이 아니므로 제외한다.
- **어댑터 하드 상한:** `EXPRESSION_MIN_INTERVAL_MS = 120_000`.
- **어떤 실패에도 텍스트 답변은 반드시 나간다.**
- **`core/` 는 `discord.js` 를 임포트하지 않는다.**
- **테스트 없이 커밋 금지.** red → green → commit.

## 파일 구조

| 파일 | 책임 |
|---|---|
| `agent/src/core/expressions.ts` (신규) | 마커 파싱·제거·공백 정리. 순수 함수만 |
| `agent/src/store/characterImagesRepo.ts` (신규) | 카탈로그 조회 + 전체 교체 |
| `agent/src/store/schema.ts` | `character_images` 테이블 추가 |
| `agent/src/adapters/discord.ts` | 마커 해석 → embed 전송 + 대화별 간격 상한 |
| `agent/src/core/persona.ts` | 감정 목록 주입 + 사용 지침 |
| `agent/src/core/core.ts` · `agent/src/index.ts` | 감정 목록 배선 |
| `scripts/sync-images.mjs` (신규) | 폴더 순회 → Storage 업로드 → 카탈로그 교체 |

---

### Task 1: 마커 파싱 (순수 함수)

**Files:**
- Create: `agent/src/core/expressions.ts`
- Test: `agent/tests/expressions.test.ts`

**Interfaces:**
- Consumes: 없음
- Produces:
  - `type ParsedExpression = { text: string; emotion: string | null }`
  - `parseExpression(raw: string): ParsedExpression`

- [ ] **Step 1: 실패하는 테스트 작성**

`agent/tests/expressions.test.ts` 를 새로 만든다.

```ts
import { describe, it, expect } from "vitest";
import { parseExpression } from "../src/core/expressions.js";

describe("parseExpression — 마커 추출", () => {
  it("문장 끝의 마커를 떼어내고 감정을 돌려준다", () => {
    const r = parseExpression("…딱히 널 위해서 한 건 아니야. [표정:홍조]");
    expect(r.emotion).toBe("홍조");
    expect(r.text).toBe("…딱히 널 위해서 한 건 아니야.");
  });

  it("문장 앞·중간의 마커도 처리한다", () => {
    expect(parseExpression("[표정:당황] 어, 그건…").text).toBe("어, 그건…");
    expect(parseExpression("어 [표정:당황] 그건…").text).toBe("어 그건…");
  });

  it("공백이 들어간 감정 이름을 그대로 인식한다", () => {
    expect(parseExpression("됐어. [표정:기본 무표정]").emotion).toBe("기본 무표정");
    expect(parseExpression("됐어. [표정:빤히 응시]").emotion).toBe("빤히 응시");
  });

  it("감정 이름 앞뒤 공백은 다듬는다", () => {
    expect(parseExpression("응. [표정: 졸림 ]").emotion).toBe("졸림");
  });
});

describe("parseExpression — 여러 개·없음·빈 값", () => {
  it("마커가 여러 개면 첫 번째만 채택하고 나머지도 전부 제거한다", () => {
    const r = parseExpression("[표정:웃음] 그래. [표정:화남] 아니 됐어.");
    expect(r.emotion).toBe("웃음");
    expect(r.text).toBe("그래. 아니 됐어.");
  });

  it("마커가 없으면 emotion 은 null 이고 본문은 그대로다", () => {
    const r = parseExpression("확인했어.");
    expect(r).toEqual({ text: "확인했어.", emotion: null });
  });

  it("빈 감정 이름은 제거만 하고 채택하지 않는다", () => {
    const r = parseExpression("음. [표정:]");
    expect(r.emotion).toBeNull();
    expect(r.text).toBe("음.");
  });

  it("콜론이 없는 유사 문자열은 마커가 아니다", () => {
    const r = parseExpression("[표정] 이건 그냥 텍스트야.");
    expect(r.emotion).toBeNull();
    expect(r.text).toBe("[표정] 이건 그냥 텍스트야.");
  });

  it("마커만 있고 본문이 없으면 text 는 빈 문자열이다", () => {
    const r = parseExpression("[표정:졸림]");
    expect(r.emotion).toBe("졸림");
    expect(r.text).toBe("");
  });
});

describe("parseExpression — 공백 정리", () => {
  it("마커를 뗀 자리에 생긴 연속 공백을 하나로 줄인다", () => {
    expect(parseExpression("그래  [표정:웃음]  알겠어").text).toBe("그래 알겠어");
  });

  it("줄 끝 공백과 앞뒤 공백을 없앤다", () => {
    expect(parseExpression("  됐어. [표정:홍조]  ").text).toBe("됐어.");
  });

  it("줄바꿈은 보존하되 3줄 이상 연속은 2줄로 줄인다", () => {
    expect(parseExpression("첫 줄\n둘째 줄 [표정:웃음]").text).toBe("첫 줄\n둘째 줄");
    expect(parseExpression("가\n\n\n\n나").text).toBe("가\n\n나");
  });
});
```

- [ ] **Step 2: 실패 확인**

```bash
cd agent && npx vitest run tests/expressions.test.ts
```

기대: FAIL — `../src/core/expressions.js` 를 찾을 수 없음.

- [ ] **Step 3: 구현**

`agent/src/core/expressions.ts` 를 새로 만든다.

```ts
// 모델이 답변에 섞어 쓰는 표정 마커를 떼어내는 순수 함수.
// 감정→URL 해석·빈도 제한·실제 전송은 어댑터의 몫이다 — 마커는 "표시 지시"이므로
// 코어는 이미지의 존재 자체를 모른다(향후 다른 채널이 같은 마커를 다르게 렌더링할 수 있다).

export type ParsedExpression = { text: string; emotion: string | null };

// [표정:<이름>] — 이름에는 공백이 들어갈 수 있다(기본 무표정, 빤히 응시).
// 콜론이 없는 [표정] 은 매칭되지 않는다(마커가 아니라 일반 텍스트로 본다).
const MARKER = /\[표정:([^\]]*)\]/g;

// 마커를 떼어낸 자리에 남는 공백을 정리한다. 줄바꿈은 의미가 있으므로 보존하되,
// 줄 안의 연속 공백·줄 끝 공백·과도한 빈 줄만 정리한다.
function tidy(s: string): string {
  return s
    .split("\n")
    .map((line) => line.replace(/[ \t]{2,}/g, " ").trimEnd())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function parseExpression(raw: string): ParsedExpression {
  let emotion: string | null = null;
  const stripped = raw.replace(MARKER, (_match, name: string) => {
    const trimmed = name.trim();
    // 첫 번째로 나온 유효한 이름만 채택한다. 나머지 마커도 전부 제거한다 —
    // 하나라도 남으면 사용자에게 그대로 보인다.
    if (emotion === null && trimmed.length > 0) emotion = trimmed;
    return "";
  });
  return { text: tidy(stripped), emotion };
}
```

- [ ] **Step 4: 통과 확인**

```bash
cd agent && npx vitest run tests/expressions.test.ts
```

기대: PASS (전부)

- [ ] **Step 5: 전체 테스트 + 타입 확인**

```bash
cd agent && npm test && npx tsc --noEmit
```

기대: 0 failed, 1 skipped. tsc 클린.

- [ ] **Step 6: 커밋**

```bash
git add agent/src/core/expressions.ts agent/tests/expressions.test.ts
git commit -m "feat(core): 표정 마커 파싱 순수 함수"
```

---

### Task 2: 카탈로그 테이블 · 레포

**Files:**
- Modify: `agent/src/store/schema.ts`
- Create: `agent/src/store/characterImagesRepo.ts`
- Test: `agent/tests/characterImagesRepo.test.ts`

**Interfaces:**
- Consumes: 없음
- Produces:
  - `type CharacterImage = { id: number; emotion: string; url: string }`
  - `class CharacterImagesRepo`
    - `constructor(db: Db)`
    - `emotions(): Promise<string[]>` — 카탈로그에 있는 감정 이름을 중복 없이 가나다순으로
    - `urlsFor(emotion: string): Promise<string[]>` — 그 감정의 URL 전부. 없으면 빈 배열
    - `replaceAll(rows: Array<{ emotion: string; url: string }>, ts: number): Promise<void>` — 전체 교체(동기화 스크립트용)

**이 태스크는 이 프로젝트에서 처음으로 DDL 을 추가한다.** `schema.ts` 가 부팅 시 `CREATE TABLE IF NOT EXISTS` 를 실행하므로 배포하면 자동 생성된다.

- [ ] **Step 1: 실패하는 테스트 작성**

`agent/tests/characterImagesRepo.test.ts` 를 새로 만든다.

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { openTestDb } from "../src/store/db.js";
import { CharacterImagesRepo } from "../src/store/characterImagesRepo.js";

describe("CharacterImagesRepo", () => {
  let repo: CharacterImagesRepo;
  beforeEach(async () => {
    repo = new CharacterImagesRepo(await openTestDb());
  });

  it("비어 있으면 감정 목록도 URL 도 빈 배열이다", async () => {
    expect(await repo.emotions()).toEqual([]);
    expect(await repo.urlsFor("홍조")).toEqual([]);
  });

  it("replaceAll 로 넣으면 감정이 중복 없이 가나다순으로 나온다", async () => {
    await repo.replaceAll([
      { emotion: "홍조", url: "https://x/홍조/1.png" },
      { emotion: "당황", url: "https://x/당황/1.png" },
      { emotion: "홍조", url: "https://x/홍조/2.png" },
    ], 1);
    expect(await repo.emotions()).toEqual(["당황", "홍조"]);
  });

  it("urlsFor 는 그 감정의 URL 만 준다", async () => {
    await repo.replaceAll([
      { emotion: "홍조", url: "https://x/홍조/1.png" },
      { emotion: "홍조", url: "https://x/홍조/2.png" },
      { emotion: "당황", url: "https://x/당황/1.png" },
    ], 1);
    expect((await repo.urlsFor("홍조")).sort()).toEqual(["https://x/홍조/1.png", "https://x/홍조/2.png"]);
    expect(await repo.urlsFor("없는감정")).toEqual([]);
  });

  it("replaceAll 은 이전 내용을 완전히 대체한다(삭제된 이미지가 남지 않는다)", async () => {
    await repo.replaceAll([{ emotion: "홍조", url: "https://x/old.png" }], 1);
    await repo.replaceAll([{ emotion: "웃음", url: "https://x/new.png" }], 2);
    expect(await repo.emotions()).toEqual(["웃음"]);
    expect(await repo.urlsFor("홍조")).toEqual([]);
  });

  it("빈 배열로 replaceAll 하면 카탈로그가 비워진다", async () => {
    await repo.replaceAll([{ emotion: "홍조", url: "https://x/1.png" }], 1);
    await repo.replaceAll([], 2);
    expect(await repo.emotions()).toEqual([]);
  });

  it("공백이 들어간 감정 이름도 그대로 다룬다", async () => {
    await repo.replaceAll([{ emotion: "기본 무표정", url: "https://x/1.png" }], 1);
    expect(await repo.emotions()).toEqual(["기본 무표정"]);
    expect(await repo.urlsFor("기본 무표정")).toHaveLength(1);
  });
});
```

- [ ] **Step 2: 실패 확인**

```bash
cd agent && npx vitest run tests/characterImagesRepo.test.ts
```

기대: FAIL — `characterImagesRepo.js` 없음.

- [ ] **Step 3: `schema.ts` 에 테이블 추가**

파일 끝의 다른 `CREATE TABLE` 들과 같은 위치에 추가한다.

```sql
-- 캐릭터 표정 이미지 카탈로그. 실제 파일은 Supabase Storage 에 있고 여기엔 URL 만 둔다.
-- scripts/sync-images.mjs 가 image/ 를 훑어 전체를 교체한다(부분 갱신 없음).
CREATE TABLE IF NOT EXISTS character_images (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  emotion TEXT NOT NULL,
  url TEXT NOT NULL,
  created_ts BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_character_images_emotion ON character_images(emotion);
```

- [ ] **Step 4: 레포 구현**

`agent/src/store/characterImagesRepo.ts` 를 새로 만든다.

```ts
import type { Db } from "./db.js";

export type CharacterImage = { id: number; emotion: string; url: string };
type Row = { id: number | string; emotion: string; url: string };

// 캐릭터 표정 이미지 카탈로그. 파일 자체는 Supabase Storage 에 있고 여기엔 URL 만 있다.
export class CharacterImagesRepo {
  constructor(private db: Db) {}

  // 카탈로그에 실제로 이미지가 있는 감정만 돌려준다 — 빈 폴더가 프롬프트에 새어들어
  // 모델이 없는 표정을 부르는 걸 막는다.
  async emotions(): Promise<string[]> {
    const r = await this.db.query("SELECT DISTINCT emotion FROM character_images ORDER BY emotion");
    return (r.rows as { emotion: string }[]).map((x) => x.emotion);
  }

  async urlsFor(emotion: string): Promise<string[]> {
    const r = await this.db.query("SELECT url FROM character_images WHERE emotion = $1 ORDER BY id", [emotion]);
    return (r.rows as { url: string }[]).map((x) => x.url);
  }

  // 동기화 스크립트 전용: 카탈로그를 통째로 갈아끼운다. 부분 갱신을 두지 않는 이유는
  // 폴더에서 지운 이미지가 카탈로그에 남는 걸 막기 위해서다.
  async replaceAll(rows: Array<{ emotion: string; url: string }>, ts: number): Promise<void> {
    await this.db.query("DELETE FROM character_images");
    for (const row of rows) {
      await this.db.query(
        "INSERT INTO character_images (emotion, url, created_ts) VALUES ($1, $2, $3)",
        [row.emotion, row.url, ts],
      );
    }
  }
}
```

- [ ] **Step 5: 통과 확인**

```bash
cd agent && npx vitest run tests/characterImagesRepo.test.ts tests/schema.test.ts
```

기대: PASS (전부)

- [ ] **Step 6: 전체 테스트 + 타입 확인**

```bash
cd agent && npm test && npx tsc --noEmit
```

기대: 0 failed, 1 skipped. tsc 클린.

- [ ] **Step 7: 커밋**

```bash
git add agent/src/store/schema.ts agent/src/store/characterImagesRepo.ts agent/tests/characterImagesRepo.test.ts
git commit -m "feat(store): character_images 카탈로그 테이블·레포"
```

---

### Task 3: 어댑터 — 표정 해석 · embed 전송 · 간격 상한

**Files:**
- Modify: `agent/src/adapters/discord.ts`
- Test: `agent/tests/expressionSend.test.ts` (신규)

**Interfaces:**
- Consumes: `parseExpression` (Task 1), `CharacterImagesRepo.urlsFor` (Task 2)
- Produces:
  - `export const EXPRESSION_MIN_INTERVAL_MS = 120_000`
  - `pickExpressionUrl(urls: string[], lastUrl: string | undefined, rand?: () => number): string | undefined` — 직전 URL 을 피해 하나 고른다
  - `withinExpressionInterval(lastTs: number | undefined, now: number, minMs?: number): boolean` — 아직 상한 안이면 `true`(= 보내지 않는다)
  - `planSend(text: string, hasImage: boolean): { chunks: string[]; embedOnLast: boolean; embedOnly: boolean }` — 전송 형태 결정
  - `DiscordAdapter` 생성자 옵션에 `characterImages?: CharacterImagesRepo` 추가(주입되지 않으면 기능 자체가 꺼진다)

**전송 형태·간격 판정을 순수 함수로 떼어내는 이유:** 디스코드 채널 없이 테스트하기 위해서다.
`send` 는 이 함수들의 결과를 그대로 실행하기만 하므로, 실제로 틀릴 수 있는 판단은 전부 테스트로 덮인다.

- [ ] **Step 1: 실패하는 테스트 작성**

`agent/tests/expressionSend.test.ts` 를 새로 만든다. 순수 함수만 검증한다 — 실제 디스코드 전송은 유닛 테스트 대상이 아니다.

```ts
import { describe, it, expect } from "vitest";
import { pickExpressionUrl, EXPRESSION_MIN_INTERVAL_MS } from "../src/adapters/discord.js";

describe("pickExpressionUrl", () => {
  it("URL 이 없으면 undefined", () => {
    expect(pickExpressionUrl([], undefined, () => 0)).toBeUndefined();
  });

  it("한 장뿐이면 직전과 같아도 그걸 쓴다", () => {
    expect(pickExpressionUrl(["a"], "a", () => 0)).toBe("a");
  });

  it("여러 장이면 직전에 쓴 것을 피한다", () => {
    // rand 가 0 이면 후보 목록의 첫 번째를 고른다. "a" 가 제외되므로 "b" 가 나와야 한다.
    expect(pickExpressionUrl(["a", "b", "c"], "a", () => 0)).toBe("b");
  });

  it("직전 URL 이 목록에 없으면 전부가 후보다", () => {
    expect(pickExpressionUrl(["a", "b"], "z", () => 0)).toBe("a");
  });

  it("rand 값에 따라 다른 장을 고른다", () => {
    expect(pickExpressionUrl(["a", "b", "c"], undefined, () => 0)).toBe("a");
    expect(pickExpressionUrl(["a", "b", "c"], undefined, () => 0.99)).toBe("c");
  });
});

describe("간격 상한 상수", () => {
  it("120초다", () => {
    expect(EXPRESSION_MIN_INTERVAL_MS).toBe(120_000);
  });
});

describe("withinExpressionInterval", () => {
  it("이전 발송 기록이 없으면 상한에 걸리지 않는다", () => {
    expect(withinExpressionInterval(undefined, 1_000_000)).toBe(false);
  });

  it("상한 안이면 true(= 보내지 않는다)", () => {
    expect(withinExpressionInterval(1_000_000, 1_000_000 + 1)).toBe(true);
    expect(withinExpressionInterval(1_000_000, 1_000_000 + 119_999)).toBe(true);
  });

  it("정확히 상한만큼 지났으면 보낸다(경계 포함)", () => {
    expect(withinExpressionInterval(1_000_000, 1_000_000 + 120_000)).toBe(false);
  });

  it("상한을 넘었으면 보낸다", () => {
    expect(withinExpressionInterval(1_000_000, 1_000_000 + 500_000)).toBe(false);
  });
});

describe("planSend — 전송 형태", () => {
  it("이미지가 없으면 청크만, embed 없음", () => {
    const p = planSend("안녕", false);
    expect(p).toEqual({ chunks: ["안녕"], embedOnLast: false, embedOnly: false });
  });

  it("이미지가 있으면 마지막 청크에 붙인다", () => {
    const p = planSend("안녕", true);
    expect(p.chunks).toEqual(["안녕"]);
    expect(p.embedOnLast).toBe(true);
    expect(p.embedOnly).toBe(false);
  });

  it("본문이 비고 이미지만 있으면 embed 만 보낸다", () => {
    const p = planSend("", true);
    expect(p.chunks).toEqual([]);
    expect(p.embedOnly).toBe(true);
  });

  it("본문도 이미지도 없으면 아무것도 보내지 않는다", () => {
    const p = planSend("", false);
    expect(p.chunks).toEqual([]);
    expect(p.embedOnly).toBe(false);
    expect(p.embedOnLast).toBe(false);
  });

  it("긴 본문은 여러 청크로 나뉘고 embed 는 마지막에만 붙는다", () => {
    const p = planSend("가".repeat(4500), true);
    expect(p.chunks.length).toBeGreaterThan(1);
    expect(p.embedOnLast).toBe(true);
    expect(p.embedOnly).toBe(false);
  });
});
```

임포트 줄에 `withinExpressionInterval`, `planSend` 를 추가한다.

- [ ] **Step 2: 실패 확인**

```bash
cd agent && npx vitest run tests/expressionSend.test.ts
```

기대: FAIL — `pickExpressionUrl` 없음.

- [ ] **Step 3: 순수 함수와 상수 추가**

`agent/src/adapters/discord.ts` 상단(파일 앞부분의 `chunkMessage` 근처)에 추가한다.

```ts
// 같은 대화에서 표정 이미지를 연달아 보내지 않도록 하는 하한. 프롬프트 지침은 반드시 새므로
// 어댑터가 최종 방어선이 된다 — 모델이 매 답변마다 마커를 붙여도 실제로는 이 간격으로 걸러진다.
// 지침대로 쓰면 애초에 이보다 드물게 나오므로 정상 동작을 막지 않는다.
export const EXPRESSION_MIN_INTERVAL_MS = 120_000;

// 그 감정의 URL 중 하나를 고른다. 직전에 보낸 것과 겹치지 않게 하되, 후보가 하나뿐이면
// 그대로 쓴다(웃음 폴더처럼 이미지가 한 장인 경우).
export function pickExpressionUrl(
  urls: string[],
  lastUrl: string | undefined,
  rand: () => number = Math.random,
): string | undefined {
  if (urls.length === 0) return undefined;
  const pool = urls.length > 1 ? urls.filter((u) => u !== lastUrl) : urls;
  const candidates = pool.length > 0 ? pool : urls;
  return candidates[Math.min(candidates.length - 1, Math.floor(rand() * candidates.length))];
}

// 아직 상한 안이면 true — 즉 "이번엔 보내지 않는다". 경계(정확히 상한만큼 지남)는 보내는 쪽이다.
export function withinExpressionInterval(
  lastTs: number | undefined,
  now: number,
  minMs: number = EXPRESSION_MIN_INTERVAL_MS,
): boolean {
  if (lastTs === undefined) return false;
  return now - lastTs < minMs;
}

// 텍스트와 이미지 유무로 전송 형태를 정한다. send() 는 이 결과를 그대로 실행만 한다 —
// 판단을 여기로 몰아야 디스코드 채널 없이 테스트할 수 있다.
export function planSend(text: string, hasImage: boolean): {
  chunks: string[];
  embedOnLast: boolean;
  embedOnly: boolean;
} {
  const chunks = text.length > 0 ? chunkMessage(text) : [];
  if (chunks.length === 0) return { chunks: [], embedOnLast: false, embedOnly: hasImage };
  return { chunks, embedOnLast: hasImage, embedOnly: false };
}
```

- [ ] **Step 4: 어댑터 배선**

`DiscordAdapter` 클래스에 상태와 옵션을 추가한다.

생성자 옵션 타입에 추가:

```ts
  characterImages?: CharacterImagesRepo;
```

임포트 추가:

```ts
import { EmbedBuilder } from "discord.js";
import { parseExpression } from "../core/expressions.js";
import type { CharacterImagesRepo } from "../store/characterImagesRepo.js";
```

필드 추가(다른 `private` 필드들과 같은 위치):

```ts
  // 대화별 표정 전송 상태(메모리). 재배포로 초기화돼도 무해하다 — 최악이 이미지 한 장 더 나가는 것이다.
  private expressionState = new Map<string, { lastTs: number; lastUrl?: string }>();
```

`assistant_message` 구독을 아래로 교체한다. `system_notice` 는 건드리지 않는다 — 오류 안내에 표정을 붙이지 않는다.

```ts
    this.bus.subscribe("assistant_message", (e) => {
      const statusDone = this.enqueueStatus(e.channelRef, () => this.finishStatus(e.channelRef));
      const { text, emotion } = parseExpression(e.text);
      void this.resolveExpression(e.channelRef, emotion).then((imageUrl) => {
        this.enqueueSendAfter(e.channelRef, statusDone, text, imageUrl);
      });
    });
```

표정 해석 메서드를 추가한다.

```ts
  // 감정 이름을 실제 이미지 URL 로 바꾼다. 어떤 이유로든 실패하면 undefined 를 돌려주고,
  // 호출측은 이미지 없이 텍스트만 보낸다 — 이미지 때문에 답변이 막히면 안 된다.
  private async resolveExpression(channelRef: string, emotion: string | null): Promise<string | undefined> {
    if (!emotion || !this.characterImages) return undefined;
    const now = Date.now();
    const state = this.expressionState.get(channelRef);
    if (withinExpressionInterval(state?.lastTs, now)) return undefined;
    try {
      const urls = await this.characterImages.urlsFor(emotion);
      const url = pickExpressionUrl(urls, state?.lastUrl);
      if (!url) return undefined;
      this.expressionState.set(channelRef, { lastTs: now, lastUrl: url });
      return url;
    } catch (err) {
      console.error("[discord] 표정 이미지 조회 실패:", err);
      return undefined;
    }
  }
```

`enqueueSendAfter` 와 `send` 에 `imageUrl` 을 통과시킨다. `enqueueSendAfter` 의 시그니처 끝에 `imageUrl?: string` 을 추가하고 `this.send(channelRef, text, imageUrl)` 로 넘긴다.

`send` 를 아래로 교체한다.

```ts
  private async send(channelRef: string, text: string, imageUrl?: string): Promise<void> {
    try {
      const channel = await this.client.channels.fetch(channelRef);
      if (!channel || !channel.isSendable()) return;
      const plan = planSend(text, imageUrl !== undefined);
      const embeds = imageUrl ? [new EmbedBuilder().setImage(imageUrl)] : [];
      if (plan.embedOnly) {
        // 마커만 있고 본문이 없는 경우 — 이미지만 보낸다.
        await channel.send({ embeds });
        return;
      }
      for (let i = 0; i < plan.chunks.length; i++) {
        // 이미지는 마지막 청크와 함께 보낸다. 따로 보내면 메시지가 둘로 갈라져 어색하다.
        const isLast = i === plan.chunks.length - 1;
        await channel.send(isLast && plan.embedOnLast ? { content: plan.chunks[i], embeds } : plan.chunks[i]);
      }
```

`try` 이후의 기존 `catch` 블록은 그대로 둔다.

- [ ] **Step 5: 통과 확인**

```bash
cd agent && npx vitest run tests/expressionSend.test.ts tests/discord.test.ts tests/discordProgress.test.ts
```

기대: PASS (전부). 기존 디스코드 테스트가 깨지면 `send`/`enqueueSendAfter` 시그니처 변경이 원인이니, 새 인자를 **선택적**으로 두었는지 확인할 것 — 기존 호출부는 인자 없이도 그대로 동작해야 한다.

- [ ] **Step 6: 전체 테스트 + 타입 확인**

```bash
cd agent && npm test && npx tsc --noEmit
```

기대: 0 failed, 1 skipped. tsc 클린.

- [ ] **Step 7: 커밋**

```bash
git add agent/src/adapters/discord.ts agent/tests/expressionSend.test.ts
git commit -m "feat(discord): 표정 마커 해석 + embed 전송 + 대화별 간격 상한"
```

---

### Task 4: 페르소나 — 감정 목록 주입 · 사용 지침

**Files:**
- Modify: `agent/src/core/persona.ts`
- Modify: `agent/src/core/core.ts`
- Modify: `agent/src/index.ts`
- Test: `agent/tests/persona.test.ts`

**Interfaces:**
- Consumes: `CharacterImagesRepo.emotions()` (Task 2)
- Produces: `PersonaContext` 에 `emotions?: string[]` 추가

- [ ] **Step 1: 실패하는 테스트 작성**

`agent/tests/persona.test.ts` 끝에 추가한다.

```ts
describe("buildSystemPrompt — 표정 이미지", () => {
  const OWNER = { role: "owner", isPrivate: true, isOwner: true } as const;
  const GUEST = { role: "allowed", isPrivate: true, isOwner: false } as const;
  const SERVER = { role: "allowed", isPrivate: false, isOwner: false } as const;
  const EMOTIONS = ["기본 무표정", "당황", "홍조"];

  it("감정 목록이 있으면 마커 문법과 감정 이름이 프롬프트에 들어간다", () => {
    const p = buildSystemPrompt({ ...OWNER, emotions: EMOTIONS });
    expect(p).toMatch(/\[표정:/);
    for (const e of EMOTIONS) expect(p).toContain(e);
  });

  it("전 채널에서 동일하게 제공된다", () => {
    for (const ctx of [OWNER, GUEST, SERVER]) {
      expect(buildSystemPrompt({ ...ctx, emotions: EMOTIONS })).toMatch(/\[표정:/);
    }
  });

  it("감정 목록이 비었거나 없으면 표정 지침 자체가 빠진다", () => {
    expect(buildSystemPrompt({ ...OWNER, emotions: [] })).not.toMatch(/\[표정:/);
    expect(buildSystemPrompt(OWNER)).not.toMatch(/\[표정:/);
  });

  it("남발 금지 지침을 포함한다", () => {
    const p = buildSystemPrompt({ ...OWNER, emotions: EMOTIONS });
    expect(p).toMatch(/매 답변마다/);
    expect(p).toMatch(/감정이 실제로/);
  });

  it("이모지 금지 규칙은 그대로 유지된다", () => {
    expect(buildSystemPrompt({ ...OWNER, emotions: EMOTIONS })).toMatch(/이모지/);
  });
});
```

- [ ] **Step 2: 실패 확인**

```bash
cd agent && npx vitest run tests/persona.test.ts
```

기대: FAIL — 표정 관련 테스트가 전부 실패.

- [ ] **Step 3: `persona.ts` 수정**

`PersonaContext` 타입에 필드를 추가한다.

```ts
  // 카탈로그에 이미지가 있는 감정 이름들. 비었거나 생략되면 표정 지침 자체를 넣지 않는다.
  emotions?: string[];
```

블록 빌더를 추가한다(다른 `build*Block` 함수들과 같은 위치).

```ts
// ── 블록 ⑥ 표정 이미지 ───────────────────────────────────────────────────────
// 이모지 금지 규칙 때문에 감정 표현 수단이 '…'과 뜸뿐이었다. 표정 이미지가 그 자리를 대신한다.
function buildExpressionBlock(ctx: PersonaContext): string {
  const emotions = ctx.emotions ?? [];
  if (emotions.length === 0) return "";
  return `## 표정
- 답변에 \`[표정:이름]\` 을 섞어 쓰면 그 표정 이미지가 함께 나간다. 쓸 수 있는 이름: ${emotions.join(" · ")}
- **감정이 실제로 움직일 때만** 쓴다 — 놀랐을 때, 부끄러울 때, 어이없을 때, 졸릴 때처럼.
- 평범한 답변·작업 보고·정보 전달에는 붙이지 않는다. **안 붙이는 게 기본이다.**
- 매 답변마다 붙이지 않는다. 남발하면 아무 의미가 없어진다.
- 목록에 없는 이름은 쓰지 않는다. 한 답변에 하나만 쓴다.`;
}
```

`buildSystemPrompt` 의 배열에 넣는다. 빈 문자열이 섞이면 빈 줄이 생기므로 걸러낸다.

```ts
export function buildSystemPrompt(ctx: PersonaContext): string {
  return [
    IDENTITY,
    buildSelfNarrative(ctx),
    QUALITY,
    buildMemoryBlock(ctx),
    buildCapabilityBlock(ctx),
    buildRelationshipBlock(ctx),
    buildExpressionBlock(ctx),
  ].filter((block) => block.length > 0).join("\n\n");
}
```

- [ ] **Step 4: `core.ts` 배선**

`AgentCore` 생성자 의존성에 `emotions: string[]` 을 추가하고 필드로 보관한다. `buildSystemPrompt` 를 호출하는 **모든 자리**(일반 턴과 요약 턴)에 `emotions: this.emotions` 를 넘긴다. 호출 지점은 `grep -n "buildSystemPrompt" src/core/core.ts` 로 확인할 것.

- [ ] **Step 5: `index.ts` 배선**

`CharacterImagesRepo` 를 임포트해 인스턴스를 만들고, 기동 시 감정 목록을 한 번 읽어 `AgentCore` 에 넘긴다. 어댑터에도 같은 레포를 넘긴다.

```ts
  const characterImages = new CharacterImagesRepo(db);
  // 감정 목록은 기동 시 한 번 읽는다. 이미지를 추가하고 동기화 스크립트를 돌려도
  // 새 감정은 봇 재시작 후에 프롬프트에 반영된다(기존 감정의 이미지 교체는 즉시 반영).
  const emotions = await characterImages.emotions().catch((err) => {
    console.error("[index] 표정 카탈로그 조회 실패 — 표정 기능 없이 계속합니다:", err);
    return [] as string[];
  });
  console.log(`[index] 표정 카탈로그: ${emotions.length}종`);
```

`AgentCore` 생성에 `emotions` 를, `DiscordAdapter` 생성에 `characterImages` 를 추가한다.

- [ ] **Step 6: 통과 확인**

```bash
cd agent && npx vitest run tests/persona.test.ts && npm test && npx tsc --noEmit
```

기대: 0 failed, 1 skipped. tsc 클린.

- [ ] **Step 7: 커밋**

```bash
git add agent/src/core/persona.ts agent/src/core/core.ts agent/src/index.ts agent/tests/persona.test.ts
git commit -m "feat(persona): 표정 목록 주입 + 사용 지침"
```

---

### Task 5: 동기화 스크립트

**Files:**
- Create: `scripts/sync-images.mjs`
- Modify: `.env.example`

**Interfaces:**
- Consumes: `character_images` 테이블 스키마 (Task 2). **레포 클래스는 쓰지 않는다** — 스크립트는 빌드 없이 `node scripts/sync-images.mjs` 로 바로 돌아가야 하므로 `pg` 로 직접 SQL 을 실행한다. `replaceAll` 과 같은 의미(DELETE 후 INSERT)를 트랜잭션 안에서 재현하되, 레포 쪽이 바뀌면 이쪽도 같이 봐야 한다는 점을 주석에 남긴다.
- Produces: 없음

리포 루트에서 실행한다. 유닛 테스트하지 않는다 — 실제 Storage 왕복이 본체이므로 수동 확인(Task 6 배포 후 확인)으로 검증한다.

- [ ] **Step 1: `.env.example` 갱신**

파일 끝에 추가한다.

```
# ── 표정 이미지 동기화(scripts/sync-images.mjs) 전용 ──
# Supabase 프로젝트 URL. 예: https://xxxxx.supabase.co
SUPABASE_URL=
# Supabase service_role 키. Storage 업로드 권한이 필요하다. 절대 공개하지 않는다.
SUPABASE_SERVICE_KEY=
```

- [ ] **Step 2: 스크립트 작성**

`scripts/sync-images.mjs` 를 새로 만든다.

```js
#!/usr/bin/env node
// 표정 이미지 동기화: image/<감정>/*.png 를 Supabase Storage 에 올리고
// character_images 카탈로그를 통째로 갈아끼운다.
//
// 리포 루트에서 실행: node scripts/sync-images.mjs
// 필요 환경변수: DATABASE_URL, SUPABASE_URL, SUPABASE_SERVICE_KEY
//
// 이미지를 추가·교체·삭제한 뒤 이 스크립트만 다시 돌리면 된다. 재배포는 필요 없다.
// 다만 "새로운 감정 폴더"를 추가한 경우, 봇이 기동 시 감정 목록을 읽으므로
// 봇을 재시작해야 모델이 그 표정을 알게 된다.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import dotenv from "dotenv";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
dotenv.config({ path: path.join(ROOT, ".env") });

const BUCKET = "character-images";
// 감정이 아닌 폴더. 새로 생기면 여기에 추가한다.
const IGNORED_DIRS = new Set(["임시"]);
const IMAGE_EXT = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp"]);
const CONTENT_TYPE = {
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
  ".gif": "image/gif", ".webp": "image/webp",
};

function requireEnv(key) {
  const v = process.env[key];
  if (!v) {
    console.error(`환경변수 누락: ${key} — .env 를 확인하세요 (.env.example 참고)`);
    process.exit(1);
  }
  return v;
}

const DATABASE_URL = requireEnv("DATABASE_URL");
const SUPABASE_URL = requireEnv("SUPABASE_URL").replace(/\/+$/, "");
const SERVICE_KEY = requireEnv("SUPABASE_SERVICE_KEY");

// image/ 아래에서 감정 폴더와 그 안의 이미지 파일을 모은다. 빈 폴더는 아예 제외한다 —
// 이미지가 없는 감정이 카탈로그에 들어가면 모델이 부를 수 없는 표정을 알게 된다.
function collect() {
  const imageDir = path.join(ROOT, "image");
  const out = [];
  for (const entry of fs.readdirSync(imageDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || IGNORED_DIRS.has(entry.name)) continue;
    const files = fs.readdirSync(path.join(imageDir, entry.name))
      .filter((f) => IMAGE_EXT.has(path.extname(f).toLowerCase()));
    if (files.length === 0) {
      console.log(`  건너뜀: ${entry.name} (이미지 없음)`);
      continue;
    }
    for (const file of files) {
      out.push({ emotion: entry.name, file, abs: path.join(imageDir, entry.name, file) });
    }
  }
  return out;
}

// Storage 는 경로에 한글이 들어가도 되지만 URL 인코딩이 필요하다.
const objectPath = (emotion, file) => `${encodeURIComponent(emotion)}/${encodeURIComponent(file)}`;

async function upload(item) {
  const p = objectPath(item.emotion, item.file);
  const body = fs.readFileSync(item.abs);
  const res = await fetch(`${SUPABASE_URL}/storage/v1/object/${BUCKET}/${p}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${SERVICE_KEY}`,
      "Content-Type": CONTENT_TYPE[path.extname(item.file).toLowerCase()] ?? "application/octet-stream",
      "x-upsert": "true",
    },
    body,
  });
  if (!res.ok) throw new Error(`업로드 실패 ${item.emotion}/${item.file}: ${res.status} ${await res.text()}`);
  return `${SUPABASE_URL}/storage/v1/object/public/${BUCKET}/${p}`;
}

async function main() {
  const items = collect();
  if (items.length === 0) {
    console.error("올릴 이미지가 없습니다. image/ 아래 감정 폴더를 확인하세요.");
    process.exit(1);
  }
  console.log(`이미지 ${items.length}장 업로드 시작…`);

  const rows = [];
  for (const item of items) {
    rows.push({ emotion: item.emotion, url: await upload(item) });
    process.stdout.write(".");
  }
  console.log("\n업로드 완료. 카탈로그 갱신 중…");

  const client = new pg.Client({ connectionString: DATABASE_URL });
  await client.connect();
  try {
    await client.query("BEGIN");
    await client.query("DELETE FROM character_images");
    const ts = Date.now();
    for (const row of rows) {
      await client.query(
        "INSERT INTO character_images (emotion, url, created_ts) VALUES ($1, $2, $3)",
        [row.emotion, row.url, ts],
      );
    }
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    await client.end();
  }

  const byEmotion = rows.reduce((acc, r) => ({ ...acc, [r.emotion]: (acc[r.emotion] ?? 0) + 1 }), {});
  console.log("완료:");
  for (const [emotion, count] of Object.entries(byEmotion)) console.log(`  ${emotion}: ${count}장`);
  console.log("\n새 감정 폴더를 추가했다면 봇을 재시작해야 모델이 그 표정을 알게 됩니다.");
}

main().catch((err) => {
  console.error("동기화 실패:", err);
  process.exit(1);
});
```

- [ ] **Step 3: 문법 확인**

```bash
node --check scripts/sync-images.mjs
```

기대: 출력 없음(문법 오류 없음). 실제 실행은 Supabase 버킷 생성 후 Task 6 에서 한다.

- [ ] **Step 4: 커밋**

```bash
git add scripts/sync-images.mjs .env.example
git commit -m "feat(scripts): 표정 이미지 Supabase Storage 동기화"
```

---

### Task 6: 문서

**Files:**
- Modify: `docs/architecture/module-boundaries.md`
- Modify: `docs/status/STATUS.md`
- Modify: `image/README.md`
- Modify: `deploy/smoke-test.md`

- [ ] **Step 1: `module-boundaries.md`**

`core/` 행의 주요 파일 목록에 `expressions.ts` 를, `store/` 행에 `characterImagesRepo.ts` 를 추가한다.
`adapters/` 행의 책임 설명에 "표정 마커를 해석해 embed 로 함께 전송한다"를 덧붙인다.

표정 마커가 **표시 지시**라는 점을 한 줄로 명시한다 — 코어는 이미지의 존재를 모르고, 마커 해석은
어댑터의 몫이며, 향후 다른 채널이 같은 마커를 다르게 렌더링할 수 있다.

- [ ] **Step 2: `STATUS.md`**

`## 병합된 주요 기능 (main)` 에 항목을 추가한다.

```markdown
- **표정 이미지** — 모델이 답변에 `[표정:이름]` 마커를 쓰면 해당 표정 이미지를 embed 로 함께 보낸다.
  이미지는 Supabase Storage 에, 카탈로그는 `character_images` 테이블에 있고 `scripts/sync-images.mjs`
  로 갱신한다(재배포 불필요). 감정이 움직일 때만 쓰도록 프롬프트로 유도하고, 어댑터가 대화별
  120초 하한으로 남발을 막는다. 이모지 금지 규칙의 감정 표현 수단을 대신한다.
```

`## 테스트` 수치를 실제 출력으로 갱신한다.

```bash
cd agent && npm test
```

- [ ] **Step 3: `image/README.md`**

기존 내용(캐릭터 시트의 시각 근거)은 유지하고 아래 절을 덧붙인다. 경로는 마크다운 링크가 아니라
백틱 인라인 코드로 쓴다 — `scripts/check-docs.mjs` 의 링크 검사가 코드 펜스 안까지 훑기 때문이다.

```markdown
## 표정 이미지

감정별 폴더 하나가 마커 하나에 대응한다. **폴더 이름이 그대로 `[표정:이름]` 의 이름이 된다** —
공백이 들어간 이름(`기본 무표정`, `빤히 응시`)도 그대로 쓴다.

- `임시/` 는 감정이 아니라 보관소다. 동기화에서 제외된다(`scripts/sync-images.mjs` 의 무시 목록).
- 이미지가 하나도 없는 폴더는 카탈로그에 들어가지 않는다 — 모델이 부를 수 없는 표정을 알게 되는 걸 막는다.
- 한 폴더에 여러 장을 두면 매번 무작위로 하나를 고르고, 직전에 쓴 장은 피한다.

이미지를 추가·교체·삭제한 뒤에는 리포 루트에서 동기화를 돌린다. 재배포는 필요 없다.

    node scripts/sync-images.mjs

다만 **새로운 감정 폴더를 추가한 경우에는 봇을 재시작**해야 한다. 감정 목록은 기동 시 한 번만
읽는다(기존 감정의 이미지 교체는 재시작 없이 즉시 반영된다).
```

- [ ] **Step 4: `deploy/smoke-test.md`**

배포 후 확인 항목을 추가한다.

```markdown
- [ ] `node scripts/sync-images.mjs` 실행 → 업로드 장수와 감정별 집계가 실제 폴더와 맞는가
- [ ] 디스코드에서 `/새세션` 후, 감정이 움직일 만한 말을 걸어 표정이 붙는가
- [ ] 연달아 대화해도 매번 이미지가 나오지는 않는가(120초 하한)
- [ ] `[표정:...]` 마커가 텍스트에 그대로 보이는 경우가 없는가
- [ ] 공개 서버 채널에서도 표정이 나오는가
- [ ] 카탈로그를 비운 상태(테이블 비움)에서도 답변이 정상 발송되는가
```

- [ ] **Step 5: 문서 검사**

```bash
node scripts/check-docs.mjs
```

기대: `문서 검사 통과`

- [ ] **Step 6: 커밋**

```bash
git add docs image/README.md deploy/smoke-test.md
git commit -m "docs: 표정 이미지 기능 반영"
```

---

## 배포 후 확인

- [ ] Supabase 대시보드에서 **`character-images` 버킷을 만들고 public 으로 설정**한다. 서명 URL 은 만료가 있어 카탈로그에 담을 수 없다.
- [ ] `.env` 에 `SUPABASE_URL`·`SUPABASE_SERVICE_KEY` 를 채운다.
- [ ] 리포 루트에서 `node scripts/sync-images.mjs` 를 실행한다.
- [ ] Railway 재배포(또는 `pm2 restart`)로 봇을 재시작해 감정 목록을 읽게 한다. `[index] 표정 카탈로그: N종` 로그를 확인한다.
- [ ] 디스코드에서 `/새세션` 후 `deploy/smoke-test.md` 의 새 항목을 훑는다.
