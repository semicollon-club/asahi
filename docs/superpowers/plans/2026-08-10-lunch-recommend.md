---
lastReviewed: 2026-08-10
---

# 점심 추천 구현 계획

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 소유자가 DM 에서 "점심 뭐 먹지" 라고 물으면, 캠퍼스 근처 식당 중 방문 기록과 선호를 반영해 골라 준다.

**Architecture:** 전부 봇(Railway) 안에서 끝난다 — 워커를 쓰지 않는다. 카카오 로컬 API 로 근처 식당을 조회해 `lunch_places` 에 쌓고, `lunch_visits` 의 방문 기록과 결합해 순수 함수가 점수를 매긴다. 도구는 소유자 DM 에서만 열린다.

**Tech Stack:** TypeScript / Node 22, vitest, pg-mem, 카카오 로컬 API(REST 키 헤더 하나).

정본 설계: [../specs/2026-08-10-lunch-recommend-design.md](../specs/2026-08-10-lunch-recommend-design.md)

## Global Constraints

- **소유자 DM 전용.** 게이팅은 `isOwner && isPrivate` 하나다. 워커 연결 여부와 무관하다 — 이 기능은 워커를 쓰지 않는다.
- **카카오 키가 없으면 도구를 아예 노출하지 않는다.** 노출해 두고 부를 때 실패시키면 모델이 매번 시도했다가 실패를 사용자에게 전달한다(`config.github` 이 null 일 때 발행 도구를 안 여는 것과 같은 원칙).
- **API 키를 오류 메시지·로그에 싣지 않는다.**
- **좌표는 `x`=경도, `y`=위도.** 뒤집혀도 카카오는 오류 없이 엉뚱한 동네를 돌려주므로, 파싱에서 한국 범위(위도 33~39, 경도 124~132)를 확인해 벗어나면 `null`.
- 카카오 제약: `radius` 0~20000(m), `size` 1~15, `page` 1~45.
- 외부 호출은 **10초 `AbortController` + 주입 가능한 `fetchImpl`**. 유닛 테스트는 네트워크를 타지 않는다.
- 주석·사용자 대면 문구는 **한국어 존댓말**. 도구 이름·코드 식별자는 영어.
- 각 태스크 끝에서 `npm run typecheck` 와 `npm test` 가 **둘 다** 통과해야 한다(`agent/` 에서 실행). CI 가 리눅스·윈도우 양쪽에서 같은 것을 돌린다.
- **커밋은 `CONTRIBUTING.md` "커밋 규약"** — 접두사 붙은 제목 + **한국어 본문("무엇을"이 아니라 "왜")** + 말미에 `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`. 아래 각 태스크의 커밋 단계는 **제목만 예시**다. 그 한 줄을 그대로 실행하지 말고 본문과 트레일러를 채워라.

## 파일 구조

| 파일 | 책임 |
|---|---|
| `agent/src/lunch/score.ts` (신규) | 가중치 순수 함수. 외부 의존 없음 |
| `agent/src/lunch/kakao.ts` (신규) | 카카오 로컬 API 클라이언트 + 응답 매핑 |
| `agent/src/store/lunchRepo.ts` (신규) | `lunch_places`·`lunch_visits` 접근 |
| `agent/src/store/schema.ts` (수정) | 테이블 둘 추가 |
| `agent/src/config.ts` (수정) | `LUNCH_*`·`KAKAO_REST_API_KEY` 로딩 + 좌표 검증 |
| `agent/src/core/lunch.ts` (신규) | 도구 핸들러 셋(조회·추천·기록) |
| `agent/src/core/tools.ts` (수정) | 도구 선언 + 게이팅 |
| `agent/src/core/persona.ts` (수정) | 능력 안내 |

---

### Task 1: 가중치 순수 함수

가장 먼저 만든다 — API 도 DB 도 없이 이 기능의 핵심 판단을 확정할 수 있는 유일한 부분이다.

**Files:**
- Create: `agent/src/lunch/score.ts`
- Test: `agent/tests/lunchScore.test.ts`

**Interfaces:**
- Consumes: 없음(순수 함수)
- Produces:
  - `type Candidate = { placeId: string; name: string; categoryGroup?: string; distanceM?: number }`
  - `type History = { placeId: string; visits: number; lastVisitTs?: number; liked?: boolean }`
  - `type Scored = { placeId: string; name: string; score: number; reasons: string[] }`
  - `function scoreCandidates(candidates: Candidate[], history: Map<string, History>, o: { nowMs: number; recentCategoryGroups?: string[] }): Scored[]`

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`agent/tests/lunchScore.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { scoreCandidates, type Candidate, type History } from "../src/lunch/score.js";

const NOW = 1_700_000_000_000;
const DAY = 24 * 60 * 60 * 1000;
const c = (placeId: string, extra: Partial<Candidate> = {}): Candidate =>
  ({ placeId, name: `가게${placeId}`, ...extra });
const hist = (rows: History[]) => new Map(rows.map((h) => [h.placeId, h]));

describe("scoreCandidates", () => {
  it("기록이 없으면 후보를 그대로 돌려주고 점수가 모두 같다", () => {
    const r = scoreCandidates([c("a"), c("b")], hist([]), { nowMs: NOW });
    expect(r.map((x) => x.placeId).sort()).toEqual(["a", "b"]);
    expect(r[0].score).toBe(r[1].score);
  });

  // 자주 간 곳 = 좋아하는 곳.
  it("방문이 많을수록 점수가 높다", () => {
    const r = scoreCandidates(
      [c("a"), c("b")],
      hist([{ placeId: "a", visits: 5 }, { placeId: "b", visits: 1 }]),
      { nowMs: NOW },
    );
    expect(r[0].placeId).toBe("a");
  });

  // 선형이면 한 곳이 목록을 독점한다 — 로그로 눌러 둔다.
  it("방문 가산은 로그라 횟수 차이만큼 벌어지지 않는다", () => {
    const [big] = scoreCandidates([c("a")], hist([{ placeId: "a", visits: 100 }]), { nowMs: NOW });
    const [small] = scoreCandidates([c("a")], hist([{ placeId: "a", visits: 10 }]), { nowMs: NOW });
    expect(big.score).toBeGreaterThan(small.score);
    expect(big.score).toBeLessThan(small.score * 2);
  });

  // 어제 간 데를 오늘 또 추천하면 이 기능이 쓸모없다.
  it("최근에 간 곳은 방문이 많아도 밀린다", () => {
    const r = scoreCandidates(
      [c("a"), c("b")],
      hist([
        { placeId: "a", visits: 5, lastVisitTs: NOW - DAY },
        { placeId: "b", visits: 2, lastVisitTs: NOW - 30 * DAY },
      ]),
      { nowMs: NOW },
    );
    expect(r[0].placeId).toBe("b");
  });

  it("liked=true 는 올리고 false 는 사실상 제외한다", () => {
    const r = scoreCandidates(
      [c("a"), c("b"), c("d")],
      hist([
        { placeId: "a", visits: 1, liked: true },
        { placeId: "b", visits: 1 },
        { placeId: "d", visits: 1, liked: false },
      ]),
      { nowMs: NOW },
    );
    expect(r.map((x) => x.placeId)).toEqual(["a", "b", "d"]);
    expect(r[2].score).toBeLessThan(0);
  });

  // 한식만 사흘 연속 나오는 것을 막는다.
  it("최근에 먹은 카테고리는 감점된다", () => {
    const r = scoreCandidates(
      [c("a", { categoryGroup: "한식" }), c("b", { categoryGroup: "일식" })],
      hist([]),
      { nowMs: NOW, recentCategoryGroups: ["한식", "한식"] },
    );
    expect(r[0].placeId).toBe("b");
  });

  // 모델이 추천 이유를 지어내지 않고 그대로 옮길 수 있어야 한다(설계 §5).
  it("점수를 움직인 축마다 reasons 에 한 줄이 남는다", () => {
    const [r] = scoreCandidates(
      [c("a", { categoryGroup: "한식" })],
      hist([{ placeId: "a", visits: 3, lastVisitTs: NOW - DAY, liked: true }]),
      { nowMs: NOW, recentCategoryGroups: ["한식"] },
    );
    expect(r.reasons.length).toBe(4);
    expect(r.reasons.join(" ")).toContain("3번");
  });

  it("점수 내림차순으로 정렬해 돌려준다", () => {
    const r = scoreCandidates(
      [c("a"), c("b"), c("d")],
      hist([{ placeId: "b", visits: 9 }, { placeId: "d", visits: 4 }]),
      { nowMs: NOW },
    );
    expect(r.map((x) => x.placeId)).toEqual(["b", "d", "a"]);
  });
});
```

- [ ] **Step 2: 실패를 확인한다**

Run: `cd agent && npx vitest run tests/lunchScore.test.ts`
Expected: FAIL — `Cannot find module '../src/lunch/score.js'`

- [ ] **Step 3: 구현한다**

`agent/src/lunch/score.ts`:

```ts
// 추천 가중치. 이 파일에는 외부 의존이 하나도 없다 — API 응답도 DB 도 없이 이 기능의 핵심
// 판단을 테스트로 확정할 수 있는 유일한 부분이라 일부러 떼어 놓았다.
export type Candidate = { placeId: string; name: string; categoryGroup?: string; distanceM?: number };
export type History = { placeId: string; visits: number; lastVisitTs?: number; liked?: boolean };
export type Scored = { placeId: string; name: string; score: number; reasons: string[] };

const DAY_MS = 24 * 60 * 60 * 1000;

// 네 축을 곱셈이 아니라 **가산**으로 쌓는다(설계 §5). 곱셈은 한 축이 0 이면 나머지를 통째로
// 지워서 "왜 이게 추천됐나"를 설명할 수 없게 된다 — reasons 가 의미를 잃는다.
// 이 값들은 위 테스트의 기대값과 맞물려 있다(계획 작성 시 검산했다). 특히 visitLog 는
// "100회가 10회의 두 배를 넘지 않는다" 를 9.23 vs 9.59 로 아슬아슬하게 만족한다 — 이 값을
// 올리면 그 테스트가 깨진다. 깨지면 상수가 아니라 그 테스트의 의도(한 곳이 목록을 독점하지
// 않는다)를 먼저 보고 판단할 것.
const W = Object.freeze({
  visitLog: 2,        // 방문 횟수(로그)
  recentPenalty: -6,  // 3일 이내 재방문
  likedBonus: 4,
  dislikedPenalty: -10, // 사실상 제외 — 다른 축을 다 더해도 음수로 남는다
  categoryRepeat: -1.5, // 최근 먹은 카테고리 1회당
} as const);

export function scoreCandidates(
  candidates: Candidate[],
  history: Map<string, History>,
  o: { nowMs: number; recentCategoryGroups?: string[] },
): Scored[] {
  const recent = o.recentCategoryGroups ?? [];

  const scored = candidates.map((cand) => {
    const h = history.get(cand.placeId);
    const reasons: string[] = [];
    let score = 0;

    if (h && h.visits > 0) {
      const add = W.visitLog * Math.log1p(h.visits);
      score += add;
      reasons.push(`${h.visits}번 가보신 곳이에요.`);
    }

    // 어제 간 데를 오늘 또 추천하면 이 기능이 쓸모없다. 3일을 경계로 두고, 그 안이면
    // 가까울수록 크게 깎는다.
    if (h?.lastVisitTs !== undefined) {
      const days = (o.nowMs - h.lastVisitTs) / DAY_MS;
      if (days < 3) {
        score += W.recentPenalty * (1 - days / 3);
        reasons.push(days < 1 ? "오늘·어제 다녀오셨어요." : `${Math.floor(days)}일 전에 다녀오셨어요.`);
      }
    }

    // 명시적 평가는 추측(횟수)보다 세게 반영한다.
    if (h?.liked === true) {
      score += W.likedBonus;
      reasons.push("좋았다고 하신 곳이에요.");
    } else if (h?.liked === false) {
      score += W.dislikedPenalty;
      reasons.push("별로였다고 하신 곳이에요.");
    }

    if (cand.categoryGroup) {
      const n = recent.filter((g) => g === cand.categoryGroup).length;
      if (n > 0) {
        score += W.categoryRepeat * n;
        reasons.push(`최근에 ${cand.categoryGroup}을(를) ${n}번 드셨어요.`);
      }
    }

    return { placeId: cand.placeId, name: cand.name, score, reasons };
  });

  // 동점이면 입력 순서를 유지한다(카카오가 이미 거리·정확도로 정렬해 준다).
  return scored
    .map((s, i) => ({ s, i }))
    .sort((a, b) => b.s.score - a.s.score || a.i - b.i)
    .map(({ s }) => s);
}
```

- [ ] **Step 4: 통과를 확인한다**

Run: `cd agent && npx vitest run tests/lunchScore.test.ts && npm run typecheck`
Expected: 8 tests PASS

- [ ] **Step 5: 커밋**

제목 예시(본문·트레일러는 직접 채운다 — Global Constraints 참고):
`feat(lunch): 추천 가중치를 순수 함수로 만든다`

---

### Task 2: 설정 로딩 + 좌표 검증

**Files:**
- Modify: `agent/src/config.ts`
- Test: `agent/tests/config.test.ts` (describe 추가)

**Interfaces:**
- Produces:
  - `type LunchConfig = { kakaoKey: string; lat: number; lon: number; radiusM: number }`
  - `config.lunch: LunchConfig | null`
  - `function parseOrigin(raw: string | undefined): { lat: number; lon: number } | null` (export)

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`agent/tests/config.test.ts` 끝에 추가(`parseOrigin` 도 import 에 더한다):

```ts
describe("점심 추천 설정", () => {
  const base = {
    DISCORD_TOKEN: "t", DISCORD_OWNER_ID: "o", DATABASE_URL: "postgres://x",
    KAKAO_REST_API_KEY: "kk", LUNCH_ORIGIN: "37.4,126.6",
  };

  it("키와 좌표가 있으면 설정을 만든다(반경 기본 1000)", () => {
    const l = loadConfig(base as NodeJS.ProcessEnv).lunch;
    expect(l).not.toBeNull();
    expect(l!.kakaoKey).toBe("kk");
    expect(l!.lat).toBe(37.4);
    expect(l!.lon).toBe(126.6);
    expect(l!.radiusM).toBe(1000);
  });

  it("반경을 지정하면 그 값을 쓰고 카카오 상한(20000)을 넘지 않는다", () => {
    expect(loadConfig({ ...base, LUNCH_RADIUS_M: "500" } as NodeJS.ProcessEnv).lunch!.radiusM).toBe(500);
    expect(loadConfig({ ...base, LUNCH_RADIUS_M: "99999" } as NodeJS.ProcessEnv).lunch!.radiusM).toBe(20000);
  });

  // 부가 기능이 본 기능을 인질로 잡지 않는다 — 없으면 도구를 안 열 뿐 봇은 정상 기동한다.
  it("키나 좌표가 없으면 null 이고 기동을 막지 않는다", () => {
    for (const k of ["KAKAO_REST_API_KEY", "LUNCH_ORIGIN"]) {
      const without = { ...base } as Record<string, string>;
      delete without[k];
      expect(loadConfig(without as NodeJS.ProcessEnv).lunch).toBeNull();
    }
  });
});

// 카카오는 x=경도·y=위도 순서라 흔히 뒤집는데, 뒤집혀도 API 는 오류 없이 엉뚱한 동네 결과를
// 준다(설계 §3). 조용히 틀리느니 기능이 안 열리는 편이 낫다.
describe("parseOrigin", () => {
  it("한국 범위의 위도,경도를 읽는다", () => {
    expect(parseOrigin("37.4,126.6")).toEqual({ lat: 37.4, lon: 126.6 });
    expect(parseOrigin(" 35.1 , 129.0 ")).toEqual({ lat: 35.1, lon: 129.0 });
  });

  it("뒤집힌 좌표는 거절한다(경도가 위도 자리에 왔다)", () => {
    expect(parseOrigin("126.6,37.4")).toBeNull();
  });

  it("형식이 어긋나거나 숫자가 아니면 거절한다", () => {
    for (const bad of ["", "37.4", "37.4,126.6,1", "a,b", undefined]) {
      expect(parseOrigin(bad)).toBeNull();
    }
  });
});
```

- [ ] **Step 2: 실패를 확인한다**

Run: `cd agent && npx vitest run tests/config.test.ts -t "점심"`
Expected: FAIL — `lunch` 가 `undefined`

- [ ] **Step 3: 구현한다**

`agent/src/config.ts` 의 `loadGithubConfig` 옆에 추가하고, `Config` 타입과 `loadConfig` 반환에 `lunch` 를 더한다:

```ts
export type LunchConfig = { kakaoKey: string; lat: number; lon: number; radiusM: number };

const KAKAO_MAX_RADIUS_M = 20000; // 카카오 제약(설계 §2.1)
const LUNCH_DEFAULT_RADIUS_M = 1000;

// "위도,경도" 를 읽는다. 카카오 요청은 x=경도·y=위도 순서라 사람이 흔히 뒤집어 넣는데,
// 뒤집혀도 API 는 오류 없이 **엉뚱한 동네 결과**를 돌려준다 — 조용히 틀리는 대신 여기서
// 거절한다. 한국 범위(위도 33~39, 경도 124~132)를 벗어나면 null 이다.
export function parseOrigin(raw: string | undefined): { lat: number; lon: number } | null {
  const parts = (raw ?? "").split(",");
  if (parts.length !== 2) return null;
  const lat = Number(parts[0].trim());
  const lon = Number(parts[1].trim());
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  if (lat < 33 || lat > 39) return null;
  if (lon < 124 || lon > 132) return null;
  return { lat, lon };
}

// 키와 좌표가 없으면 null 이다 — 던지지 않는다. 점심 추천은 부가 기능이므로 설정이 빠졌다고
// 봇이 못 뜨면 안 된다(github 설정과 같은 원칙). 호출측은 null 을 보고 도구를 아예 노출하지
// 않는다. 반경만 없을 때 기본값을 쓰는 것도 같은 이유다 — 없어서 못 도는 값과 기본값이 있는
// 값을 구분한다.
function loadLunchConfig(env: NodeJS.ProcessEnv): LunchConfig | null {
  const kakaoKey = env.KAKAO_REST_API_KEY?.trim();
  const origin = parseOrigin(env.LUNCH_ORIGIN?.trim());
  if (!kakaoKey || !origin) return null;

  const raw = Number(env.LUNCH_RADIUS_M);
  const radiusM = Number.isFinite(raw) && raw > 0 ? Math.min(raw, KAKAO_MAX_RADIUS_M) : LUNCH_DEFAULT_RADIUS_M;
  return { kakaoKey, lat: origin.lat, lon: origin.lon, radiusM };
}
```

`Config` 타입에:

```ts
  // 점심 추천 설정. 없으면 null 이고, 그때는 점심 도구가 아예 노출되지 않는다.
  lunch: LunchConfig | null;
```

`loadConfig` 반환 객체에 `lunch: loadLunchConfig(env),` 를 더한다.

- [ ] **Step 4: 타입체크가 잡는 가짜 객체를 채운다**

Run: `cd agent && npm run typecheck`

`Config` 에 필수 필드가 늘었으므로 테스트의 가짜 `Config` 들이 전부 실패한다. 각 파일에서
`github: null,` 바로 아래에 다음을 더한다:

```ts
    // 점심 추천 미설정 — 이 테스트들의 관심사가 아니다.
    lunch: null,
```

- [ ] **Step 5: 통과를 확인하고 커밋**

Run: `cd agent && npm run typecheck && npm test`

제목 예시: `feat(config): 점심 추천 설정을 읽고 좌표를 검증한다`

---

### Task 3: 카카오 로컬 API 클라이언트

**Files:**
- Create: `agent/src/lunch/kakao.ts`
- Test: `agent/tests/lunchKakao.test.ts`

**Interfaces:**
- Consumes: `Candidate`(Task 1), `LunchConfig`(Task 2)
- Produces:
  - `type KakaoPlace = { placeId: string; name: string; category?: string; categoryGroup?: string; address?: string; url?: string; distanceM?: number }`
  - `function mapKakaoDocument(doc: Record<string, unknown>): KakaoPlace | null`
  - `function searchNearby(o: { config: LunchConfig; query: string; size?: number; fetchImpl?: typeof fetch }): Promise<KakaoPlace[]>`

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`agent/tests/lunchKakao.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { mapKakaoDocument, searchNearby } from "../src/lunch/kakao.js";

const config = { kakaoKey: "kk", lat: 37.4, lon: 126.6, radiusM: 800 };

const doc = {
  id: "123", place_name: "국밥집", category_name: "음식점 > 한식 > 국밥",
  category_group_name: "음식점", address_name: "인천 어딘가", place_url: "http://place/123",
  distance: "250", x: "126.6", y: "37.4",
};

describe("mapKakaoDocument", () => {
  it("응답 문서를 내부 형태로 옮긴다", () => {
    expect(mapKakaoDocument(doc)).toEqual({
      placeId: "123", name: "국밥집", category: "음식점 > 한식 > 국밥",
      categoryGroup: "음식점", address: "인천 어딘가", url: "http://place/123", distanceM: 250,
    });
  });

  // id·이름은 이 기능의 뼈대다(설계 §2) — 없으면 방문 기록이 매달릴 곳이 없다.
  it("id 나 이름이 없으면 null 이다", () => {
    expect(mapKakaoDocument({ ...doc, id: undefined })).toBeNull();
    expect(mapKakaoDocument({ ...doc, place_name: "" })).toBeNull();
  });

  it("선택 필드가 없어도 깨지지 않는다", () => {
    const r = mapKakaoDocument({ id: "1", place_name: "가게" });
    expect(r).toEqual({ placeId: "1", name: "가게" });
  });
});

describe("searchNearby", () => {
  it("좌표·반경·키를 규약대로 보낸다", async () => {
    let seenUrl = "";
    let seenAuth = "";
    const fetchImpl = (async (url: string, init: RequestInit) => {
      seenUrl = String(url);
      seenAuth = String((init.headers as Record<string, string>).Authorization);
      return new Response(JSON.stringify({ documents: [doc] }), { status: 200 });
    }) as unknown as typeof fetch;

    const r = await searchNearby({ config, query: "점심", fetchImpl });

    expect(seenUrl).toContain("https://dapi.kakao.com/v2/local/search/keyword.json");
    expect(seenUrl).toContain("y=37.4");   // 위도
    expect(seenUrl).toContain("x=126.6");  // 경도
    expect(seenUrl).toContain("radius=800");
    expect(seenAuth).toBe("KakaoAK kk");
    expect(r[0].placeId).toBe("123");
  });

  it("size 는 카카오 상한(15)을 넘지 않는다", async () => {
    let seenUrl = "";
    const fetchImpl = (async (url: string) => {
      seenUrl = String(url);
      return new Response(JSON.stringify({ documents: [] }), { status: 200 });
    }) as unknown as typeof fetch;
    await searchNearby({ config, query: "점심", size: 99, fetchImpl });
    expect(seenUrl).toContain("size=15");
  });

  it("매핑 못 하는 문서는 조용히 버린다(전체를 실패시키지 않는다)", async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ documents: [doc, { place_name: "id 없음" }] }), { status: 200 })) as unknown as typeof fetch;
    const r = await searchNearby({ config, query: "점심", fetchImpl });
    expect(r.length).toBe(1);
  });

  // 키가 오류 메시지로 새면 로그가 곧 유출 경로가 된다.
  it("실패해도 오류 메시지에 키가 섞이지 않는다", async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ message: "bad" }), { status: 401 })) as unknown as typeof fetch;
    await expect(searchNearby({ config, query: "점심", fetchImpl })).rejects.toThrow(/^(?!.*kk).*$/s);
  });
});
```

- [ ] **Step 2: 실패를 확인한다**

Run: `cd agent && npx vitest run tests/lunchKakao.test.ts`
Expected: FAIL — `Cannot find module '../src/lunch/kakao.js'`

- [ ] **Step 3: 구현한다**

`agent/src/lunch/kakao.ts`:

```ts
import type { LunchConfig } from "../config.js";

export type KakaoPlace = {
  placeId: string; name: string; category?: string; categoryGroup?: string;
  address?: string; url?: string; distanceM?: number;
};

const KAKAO_SEARCH_URL = "https://dapi.kakao.com/v2/local/search/keyword.json";
const KAKAO_MAX_SIZE = 15;      // 카카오 제약(설계 §2.1)
const FETCH_TIMEOUT_MS = 10_000;

const str = (v: unknown): string | undefined =>
  typeof v === "string" && v.trim().length > 0 ? v.trim() : undefined;

// 카카오 문서 하나를 내부 형태로. id 와 이름이 없으면 null 이다 — 그 둘은 이 기능의 뼈대이고
// (설계 §2: 방문 기록이 매달릴 안정적 식별자), 없는 채로 흘려보내면 place_id 가 빈 방문
// 기록이 생겨 누적 자체가 무의미해진다. 나머지 필드는 없어도 된다.
export function mapKakaoDocument(doc: Record<string, unknown>): KakaoPlace | null {
  const placeId = str(doc.id);
  const name = str(doc.place_name);
  if (!placeId || !name) return null;

  const distance = Number(doc.distance);
  return {
    placeId,
    name,
    ...(str(doc.category_name) ? { category: str(doc.category_name) } : {}),
    ...(str(doc.category_group_name) ? { categoryGroup: str(doc.category_group_name) } : {}),
    ...(str(doc.address_name) ? { address: str(doc.address_name) } : {}),
    ...(str(doc.place_url) ? { url: str(doc.place_url) } : {}),
    ...(Number.isFinite(distance) ? { distanceM: distance } : {}),
  };
}

// appToken.ts 의 fetchWithTimeout 과 같은 모양이다 — 외부 호출이 무한정 붙잡히면 그 턴이
// 통째로 멈춘다.
async function fetchWithTimeout(fetchImpl: typeof fetch, url: string, init: RequestInit): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetchImpl(url, { ...init, signal: ctrl.signal });
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      throw new Error(`지도 API 응답이 ${FETCH_TIMEOUT_MS / 1000}초 안에 오지 않아 요청을 중단했어요.`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

export async function searchNearby(o: {
  config: LunchConfig;
  query: string;
  size?: number;
  fetchImpl?: typeof fetch;
}): Promise<KakaoPlace[]> {
  // x=경도, y=위도. 이 순서를 뒤집으면 오류 없이 엉뚱한 동네가 나온다(설계 §3) — config 의
  // parseOrigin 이 이미 한 번 걸렀고, 여기서는 그 검증된 값을 규약대로 싣기만 한다.
  const params = new URLSearchParams({
    query: o.query,
    x: String(o.config.lon),
    y: String(o.config.lat),
    radius: String(o.config.radiusM),
    sort: "distance",
    size: String(Math.min(o.size ?? KAKAO_MAX_SIZE, KAKAO_MAX_SIZE)),
  });

  const res = await fetchWithTimeout(o.fetchImpl ?? fetch, `${KAKAO_SEARCH_URL}?${params}`, {
    // 키는 헤더에만 싣는다. URL 에 넣으면 오류 로그·리다이렉트 기록에 그대로 남는다.
    headers: { Authorization: `KakaoAK ${o.config.kakaoKey}` },
  });

  if (!res.ok) {
    // 응답 본문도 상태 코드도 키를 담지 않는다 — 여기서 키를 문자열에 섞지 않는 것이 핵심이다.
    throw new Error(`근처 식당을 찾지 못했어요(지도 API 오류 ${res.status}).`);
  }

  const body = (await res.json()) as { documents?: unknown[] };
  const docs = Array.isArray(body.documents) ? body.documents : [];
  // 매핑 못 하는 문서 하나 때문에 전체를 실패시키지 않는다 — 목록 기능은 부분 성공이 정상이다.
  return docs
    .map((d) => mapKakaoDocument(d as Record<string, unknown>))
    .filter((p): p is KakaoPlace => p !== null);
}
```

- [ ] **Step 4: 통과를 확인하고 커밋**

Run: `cd agent && npx vitest run tests/lunchKakao.test.ts && npm run typecheck`
Expected: 7 tests PASS

제목 예시: `feat(lunch): 카카오 로컬 API 클라이언트`

---

### Task 4: 스키마 + 리포

**Files:**
- Modify: `agent/src/store/schema.ts` (`projects` 테이블 뒤)
- Create: `agent/src/store/lunchRepo.ts`
- Test: `agent/tests/lunchRepo.test.ts`

**Interfaces:**
- Consumes: `Db`, `openTestDb`, `KakaoPlace`(Task 3), `History`(Task 1)
- Produces:
  - `type PlaceRow = { placeId: string; name: string; category?: string; categoryGroup?: string; address?: string; url?: string }`
  - `class LunchRepo`:
    - `upsertPlaces(places: KakaoPlace[], ts: number): Promise<void>`
    - `findPlacesByName(name: string): Promise<PlaceRow[]>`
    - `recordVisit(o: { userId: string; placeId: string; ts: number; liked?: boolean }): Promise<void>`
    - `historyOf(userId: string): Promise<Map<string, History>>`
    - `recentCategoryGroups(userId: string, sinceTs: number): Promise<string[]>`

- [ ] **Step 1: 스키마를 더한다**

`agent/src/store/schema.ts` 의 `projects` 테이블 **뒤**에 붙인다:

```sql
-- 점심 추천(docs/superpowers/specs/2026-08-10-lunch-recommend-design.md).
-- lunch_places 는 캐시가 아니라 참조 대상이다 — 방문 기록이 place_id 만 들고 있으면 나중에
-- 그 가게가 카카오에서 사라졌을 때 이름조차 보여줄 수 없다.
CREATE TABLE IF NOT EXISTS lunch_places (
  place_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  category TEXT,
  category_group TEXT,
  address TEXT,
  url TEXT,
  updated_ts BIGINT NOT NULL
);

-- scope 컬럼을 두지 않는다: 지금은 소유자만 쓰므로 모든 행이 같은 값을 갖고, 값이 하나뿐인
-- 컬럼은 아무것도 구분하지 못하면서 그 축이 이미 동작한다는 인상만 준다(설계 §4).
CREATE TABLE IF NOT EXISTS lunch_visits (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id TEXT NOT NULL,
  place_id TEXT NOT NULL,
  ts BIGINT NOT NULL,
  liked BOOLEAN
);
CREATE INDEX IF NOT EXISTS idx_lunch_visits_user_ts ON lunch_visits(user_id, ts);
CREATE INDEX IF NOT EXISTS idx_lunch_visits_place ON lunch_visits(place_id);
```

- [ ] **Step 2: 실패하는 테스트를 쓴다**

`agent/tests/lunchRepo.test.ts`:

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { openTestDb } from "../src/store/db.js";
import { LunchRepo } from "../src/store/lunchRepo.js";

const place = (placeId: string, name: string, categoryGroup?: string) =>
  ({ placeId, name, ...(categoryGroup ? { categoryGroup } : {}) });

describe("LunchRepo", () => {
  let repo: LunchRepo;
  beforeEach(async () => { repo = new LunchRepo(await openTestDb()); });

  it("장소를 저장하고 이름으로 찾는다", async () => {
    await repo.upsertPlaces([place("1", "국밥집", "음식점")], 1000);
    const found = await repo.findPlacesByName("국밥");
    expect(found.length).toBe(1);
    expect(found[0].placeId).toBe("1");
    expect(found[0].categoryGroup).toBe("음식점");
  });

  // 같은 가게를 다시 검색해도 행이 늘면 안 된다 — place_id 가 이 표의 뼈대다.
  it("같은 place_id 를 다시 넣으면 갱신될 뿐 늘지 않는다", async () => {
    await repo.upsertPlaces([place("1", "국밥집")], 1000);
    await repo.upsertPlaces([place("1", "국밥집 본점")], 2000);
    const found = await repo.findPlacesByName("국밥");
    expect(found.length).toBe(1);
    expect(found[0].name).toBe("국밥집 본점");
  });

  it("이름 일부로 여러 개가 걸릴 수 있다", async () => {
    await repo.upsertPlaces([place("1", "김밥천국"), place("2", "김밥나라")], 1000);
    expect((await repo.findPlacesByName("김밥")).length).toBe(2);
  });

  it("방문을 기록하고 집계한다", async () => {
    await repo.upsertPlaces([place("1", "국밥집")], 1000);
    await repo.recordVisit({ userId: "u1", placeId: "1", ts: 1000 });
    await repo.recordVisit({ userId: "u1", placeId: "1", ts: 5000, liked: true });

    const h = await repo.historyOf("u1");
    expect(h.get("1")!.visits).toBe(2);
    expect(h.get("1")!.lastVisitTs).toBe(5000);
    expect(h.get("1")!.liked).toBe(true);
  });

  // 다른 사람 기록이 섞이면 추천이 통째로 틀어진다.
  it("다른 사용자의 기록은 섞이지 않는다", async () => {
    await repo.upsertPlaces([place("1", "국밥집")], 1000);
    await repo.recordVisit({ userId: "u1", placeId: "1", ts: 1000 });
    await repo.recordVisit({ userId: "u2", placeId: "1", ts: 1000 });
    expect((await repo.historyOf("u1")).get("1")!.visits).toBe(1);
  });

  // 가장 최근 평가가 이긴다 — 예전에 별로였어도 최근에 좋았으면 그게 지금의 판단이다.
  it("liked 는 가장 최근 방문의 값을 쓴다", async () => {
    await repo.upsertPlaces([place("1", "국밥집")], 1000);
    await repo.recordVisit({ userId: "u1", placeId: "1", ts: 1000, liked: false });
    await repo.recordVisit({ userId: "u1", placeId: "1", ts: 9000, liked: true });
    expect((await repo.historyOf("u1")).get("1")!.liked).toBe(true);
  });

  it("최근 카테고리를 최신순으로 돌려준다", async () => {
    await repo.upsertPlaces([place("1", "국밥집", "한식"), place("2", "스시집", "일식")], 1000);
    await repo.recordVisit({ userId: "u1", placeId: "1", ts: 1000 });
    await repo.recordVisit({ userId: "u1", placeId: "2", ts: 2000 });
    expect(await repo.recentCategoryGroups("u1", 0)).toEqual(["일식", "한식"]);
  });

  it("sinceTs 이전 방문은 최근 카테고리에서 빠진다", async () => {
    await repo.upsertPlaces([place("1", "국밥집", "한식")], 1000);
    await repo.recordVisit({ userId: "u1", placeId: "1", ts: 1000 });
    expect(await repo.recentCategoryGroups("u1", 5000)).toEqual([]);
  });
});
```

- [ ] **Step 3: 실패를 확인한다**

Run: `cd agent && npx vitest run tests/lunchRepo.test.ts`
Expected: FAIL — `Cannot find module '../src/store/lunchRepo.js'`

- [ ] **Step 4: 리포를 구현한다**

`agent/src/store/lunchRepo.ts`:

```ts
import type { Db } from "./db.js";
import type { KakaoPlace } from "../lunch/kakao.js";
import type { History } from "../lunch/score.js";

export type PlaceRow = {
  placeId: string; name: string; category?: string; categoryGroup?: string;
  address?: string; url?: string;
};

type RawPlace = {
  place_id: string; name: string; category: string | null;
  category_group: string | null; address: string | null; url: string | null;
};

const opt = (v: string | null): string | undefined => (v === null || v === "" ? undefined : v);

// 이름 검색 결과 상한. lunch_places 는 검색할 때마다 쌓이는 표라 무제한으로 늘어나고(설계
// §4), findPlacesByName 의 결과는 §6.1 "여러 개" 분기에서 디스코드 메시지 하나(2000자 한도)로
// 그대로 나열된다 — messagesRepo.search 처럼 상한을 둔다.
const MAX_NAME_MATCHES = 50;

function toPlaceRow(r: RawPlace): PlaceRow {
  return {
    placeId: r.place_id,
    name: r.name,
    ...(opt(r.category) ? { category: opt(r.category) } : {}),
    ...(opt(r.category_group) ? { categoryGroup: opt(r.category_group) } : {}),
    ...(opt(r.address) ? { address: opt(r.address) } : {}),
    ...(opt(r.url) ? { url: opt(r.url) } : {}),
  };
}

export class LunchRepo {
  constructor(private db: Db) {}

  // 검색 결과를 볼 때마다 갱신한다. ON CONFLICT 로 덮어쓰는 이유는 가게 정보(이름·주소)가
  // 바뀔 수 있기 때문이고, 행이 늘지 않는 것이 핵심이다 — place_id 가 이 표의 뼈대다.
  async upsertPlaces(places: KakaoPlace[], ts: number): Promise<void> {
    for (const p of places) {
      await this.db.query(
        `INSERT INTO lunch_places (place_id, name, category, category_group, address, url, updated_ts)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (place_id) DO UPDATE SET
           name = EXCLUDED.name, category = EXCLUDED.category,
           category_group = EXCLUDED.category_group, address = EXCLUDED.address,
           url = EXCLUDED.url, updated_ts = EXCLUDED.updated_ts`,
        [p.placeId, p.name, p.category ?? null, p.categoryGroup ?? null, p.address ?? null, p.url ?? null, ts],
      );
    }
  }

  // FTS5 대체: 대소문자 무시 부분 문자열 검색. messagesRepo/memoriesRepo 와 같은 이유로 LIKE
  // 대신 strpos(lower(x), lower(y)) > 0 을 쓴다 — ILIKE 는 검색어의 %,_ 를 이스케이프하지
  // 않으면 와일드카드로 오해하는데, LIKE ... ESCAPE 는 pg-mem 이 파싱하지 못한다(db.ts
  // 46~47행). 대소문자 무시는 forget 의 선례를 그대로 따른다(설계 §6.1) — 카카오 장소명은
  // CU·GS25·Starbucks 처럼 라틴 문자를 흔히 섞어 쓴다. trim + 빈 문자열 차단과 LIMIT 은
  // lunch_places 가 무제한으로 쌓이는 표라서다(설계 §4) — 안 막으면 빈 검색어가 테이블
  // 전체를 디스코드 2000자 한도로 밀어넣는다.
  async findPlacesByName(name: string): Promise<PlaceRow[]> {
    const trimmed = name.trim();
    if (trimmed.length === 0) return [];
    const r = await this.db.query(
      "SELECT * FROM lunch_places WHERE strpos(lower(name), lower($1)) > 0 ORDER BY name LIMIT $2",
      [trimmed, MAX_NAME_MATCHES],
    );
    return (r.rows as RawPlace[]).map(toPlaceRow);
  }

  async recordVisit(o: { userId: string; placeId: string; ts: number; liked?: boolean }): Promise<void> {
    await this.db.query(
      "INSERT INTO lunch_visits (user_id, place_id, ts, liked) VALUES ($1, $2, $3, $4)",
      [o.userId, o.placeId, o.ts, o.liked ?? null],
    );
  }

  // 방문 횟수·마지막 방문은 place_id 별로 시간 역순(ts DESC, 동률은 id DESC 로 전순서를
  // 만든다)으로 훑으며 처음 만난 값을 취한다. liked 는 그 둘과 **따로** 접는다 — NULL 은
  // "평가 안 함"이지 새 판단이 아니라서(설계 §4), 가장 최근 행의 liked 가 아니라 가장 최근의
  // non-NULL liked 가 이겨야 한다. 둘을 같이 접으면 별로였던 곳을 평가 없이 재방문했을 때
  // liked 가 통째로 사라지고, score.ts 의 liked!==false 게이트가 안 걸려서 dislikedPenalty
  // 도 빠지고 방문 보너스가 되살아난다(score.ts 44~48행).
  async historyOf(userId: string): Promise<Map<string, History>> {
    const r = await this.db.query(
      "SELECT place_id, ts, liked FROM lunch_visits WHERE user_id = $1 ORDER BY ts DESC, id DESC",
      [userId],
    );
    const out = new Map<string, History>();
    for (const raw of r.rows as Array<{ place_id: string; ts: number | string; liked: boolean | null }>) {
      const ts = Number(raw.ts);
      const cur = out.get(raw.place_id);
      if (!cur) {
        out.set(raw.place_id, {
          placeId: raw.place_id,
          visits: 1,
          lastVisitTs: ts,
          ...(raw.liked === null ? {} : { liked: raw.liked }),
        });
      } else {
        cur.visits += 1;
        if (cur.liked === undefined && raw.liked !== null) cur.liked = raw.liked;
      }
    }
    return out;
  }

  // 최신순. score.ts 의 카테고리 감점이 "최근에 몇 번 먹었나"만 세므로 순서 자체는 쓰이지
  // 않지만, 최신순으로 주는 편이 호출측이 상위 N 개만 잘라 쓰기 쉽다.
  async recentCategoryGroups(userId: string, sinceTs: number): Promise<string[]> {
    const r = await this.db.query(
      `SELECT p.category_group AS g FROM lunch_visits v
         JOIN lunch_places p ON p.place_id = v.place_id
        WHERE v.user_id = $1 AND v.ts >= $2 AND p.category_group IS NOT NULL
        ORDER BY v.ts DESC`,
      [userId, sinceTs],
    );
    return (r.rows as Array<{ g: string }>).map((x) => x.g);
  }
}
```

- [ ] **Step 5: 통과를 확인하고 커밋**

Run: `cd agent && npx vitest run tests/lunchRepo.test.ts && npm run typecheck`
Expected: 8 tests PASS

제목 예시: `feat(store): 점심 장소·방문 테이블과 리포`

---

### Task 5: 도구 핸들러 셋

**Files:**
- Create: `agent/src/core/lunch.ts`
- Test: `agent/tests/lunchHandlers.test.ts`

**Interfaces:**
- Consumes: Task 1~4 전부
- Produces:
  - `type LunchCtx = { config: LunchConfig; repo: LunchRepo; userId: string; now: () => number; fetchImpl?: typeof fetch }`
  - `function lunchSearchHandler(ctx: LunchCtx, args: { query?: string }): Promise<{ ok: boolean; content: string }>`
  - `function lunchRecommendHandler(ctx: LunchCtx, args: { count?: number }): Promise<{ ok: boolean; content: string }>`
  - `function lunchVisitHandler(ctx: LunchCtx, args: { place: string; liked?: boolean }): Promise<{ ok: boolean; content: string }>`

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`agent/tests/lunchHandlers.test.ts`:

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { openTestDb } from "../src/store/db.js";
import { LunchRepo } from "../src/store/lunchRepo.js";
import { lunchSearchHandler, lunchRecommendHandler, lunchVisitHandler } from "../src/core/lunch.js";

const config = { kakaoKey: "kk", lat: 37.4, lon: 126.6, radiusM: 800 };
const NOW = 1_700_000_000_000;

const kakaoDoc = (id: string, name: string, group = "음식점") => ({
  id, place_name: name, category_group_name: group, place_url: `http://p/${id}`, distance: "100",
});
const fakeFetch = (docs: unknown[]) =>
  (async () => new Response(JSON.stringify({ documents: docs }), { status: 200 })) as unknown as typeof fetch;

describe("점심 도구 핸들러", () => {
  let repo: LunchRepo;
  const ctx = () => ({ config, repo, userId: "u1", now: () => NOW, fetchImpl: fakeFetch([kakaoDoc("1", "국밥집"), kakaoDoc("2", "스시집")]) });
  beforeEach(async () => { repo = new LunchRepo(await openTestDb()); });

  it("검색은 결과를 돌려주고 장소를 저장한다", async () => {
    const r = await lunchSearchHandler(ctx(), {});
    expect(r.ok).toBe(true);
    expect(r.content).toContain("국밥집");
    expect((await repo.findPlacesByName("국밥")).length).toBe(1);
  });

  it("결과가 없으면 그 사실을 말한다", async () => {
    const r = await lunchSearchHandler({ ...ctx(), fetchImpl: fakeFetch([]) }, {});
    expect(r.ok).toBe(true);
    expect(r.content).toContain("찾지 못했");
  });

  it("추천은 기록을 반영하고 이유를 함께 준다", async () => {
    await repo.upsertPlaces([{ placeId: "1", name: "국밥집" }], NOW);
    await repo.recordVisit({ userId: "u1", placeId: "1", ts: NOW - 90 * 24 * 3600_000, liked: true });

    const r = await lunchRecommendHandler(ctx(), { count: 2 });
    expect(r.ok).toBe(true);
    expect(r.content).toContain("국밥집");
    expect(r.content).toContain("좋았다고");
  });

  it("방문 기록은 이름으로 찾아 저장한다", async () => {
    await repo.upsertPlaces([{ placeId: "1", name: "국밥집" }], NOW);
    const r = await lunchVisitHandler(ctx(), { place: "국밥집", liked: true });
    expect(r.ok).toBe(true);
    expect((await repo.historyOf("u1")).get("1")!.liked).toBe(true);
  });

  // forget 이 같은 제목 여러 건에 대해 하는 것과 같은 방식이다(설계 §6.1).
  it("이름이 여러 개 걸리면 저장하지 않고 후보를 보여준다", async () => {
    await repo.upsertPlaces([{ placeId: "1", name: "김밥천국" }, { placeId: "2", name: "김밥나라" }], NOW);
    const r = await lunchVisitHandler(ctx(), { place: "김밥" });
    expect(r.ok).toBe(false);
    expect(r.content).toContain("김밥천국");
    expect(r.content).toContain("김밥나라");
    expect((await repo.historyOf("u1")).size).toBe(0);
  });

  // place_id 없는 행이 생기면 누적의 뼈대가 그 순간 깨진다(설계 §6.1).
  it("없는 가게는 새로 만들지 않고 먼저 검색하라고 한다", async () => {
    const r = await lunchVisitHandler(ctx(), { place: "없는집" });
    expect(r.ok).toBe(false);
    expect(r.content).toContain("검색");
    expect((await repo.historyOf("u1")).size).toBe(0);
  });

  it("지도 API 가 실패하면 실패로 돌려주고 키를 노출하지 않는다", async () => {
    const failing = (async () => new Response("{}", { status: 401 })) as unknown as typeof fetch;
    const r = await lunchSearchHandler({ ...ctx(), fetchImpl: failing }, {});
    expect(r.ok).toBe(false);
    expect(r.content).not.toContain("kk");
  });
});
```

- [ ] **Step 2: 실패를 확인한다**

Run: `cd agent && npx vitest run tests/lunchHandlers.test.ts`
Expected: FAIL — `Cannot find module '../src/core/lunch.js'`

- [ ] **Step 3: 구현한다**

`agent/src/core/lunch.ts`:

```ts
import type { LunchConfig } from "../config.js";
import type { LunchRepo } from "../store/lunchRepo.js";
import { searchNearby, type KakaoPlace } from "../lunch/kakao.js";
import { scoreCandidates, type Candidate } from "../lunch/score.js";

export type LunchCtx = {
  config: LunchConfig;
  repo: LunchRepo;
  userId: string;
  now: () => number;
  fetchImpl?: typeof fetch;
};

const DEFAULT_QUERY = "맛집";
const DEFAULT_COUNT = 3;
// 카테고리 감점이 보는 기간. 2주면 "요즘 뭘 자주 먹었나"를 담기에 충분하고, 그보다 길면
// 오래전 취향이 오늘의 추천을 계속 누른다.
const RECENT_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;

// 검색은 항상 저장을 동반한다 — 저장하지 않으면 방문 기록이 참조할 대상이 없다(설계 §4).
async function searchAndStore(ctx: LunchCtx, query: string): Promise<KakaoPlace[]> {
  const places = await searchNearby({
    config: ctx.config, query, ...(ctx.fetchImpl ? { fetchImpl: ctx.fetchImpl } : {}),
  });
  if (places.length > 0) await ctx.repo.upsertPlaces(places, ctx.now());
  return places;
}

function failMessage(err: unknown): string {
  return err instanceof Error ? err.message : "근처 식당을 찾지 못했어요.";
}

export async function lunchSearchHandler(ctx: LunchCtx, args: { query?: string }): Promise<{ ok: boolean; content: string }> {
  let places: KakaoPlace[];
  try {
    places = await searchAndStore(ctx, args.query?.trim() || DEFAULT_QUERY);
  } catch (err) {
    return { ok: false, content: failMessage(err) };
  }
  if (places.length === 0) return { ok: true, content: "근처에서 찾지 못했어요. 다른 말로 검색해 볼까요?" };

  const lines = places.map((p) => {
    const d = p.distanceM === undefined ? "" : ` (${p.distanceM}m)`;
    return `- ${p.name}${d}${p.categoryGroup ? ` · ${p.categoryGroup}` : ""}`;
  });
  return { ok: true, content: `근처 ${places.length}곳이에요.\n${lines.join("\n")}` };
}

export async function lunchRecommendHandler(ctx: LunchCtx, args: { count?: number }): Promise<{ ok: boolean; content: string }> {
  let places: KakaoPlace[];
  try {
    places = await searchAndStore(ctx, DEFAULT_QUERY);
  } catch (err) {
    return { ok: false, content: failMessage(err) };
  }
  if (places.length === 0) return { ok: true, content: "근처에서 찾지 못했어요." };

  const history = await ctx.repo.historyOf(ctx.userId);
  const recentCategoryGroups = await ctx.repo.recentCategoryGroups(ctx.userId, ctx.now() - RECENT_WINDOW_MS);

  const candidates: Candidate[] = places.map((p) => ({
    placeId: p.placeId,
    name: p.name,
    ...(p.categoryGroup ? { categoryGroup: p.categoryGroup } : {}),
    ...(p.distanceM === undefined ? {} : { distanceM: p.distanceM }),
  }));

  const top = scoreCandidates(candidates, history, { nowMs: ctx.now(), recentCategoryGroups })
    .slice(0, Math.max(1, args.count ?? DEFAULT_COUNT));

  // 이유를 그대로 싣는다 — 모델이 추천 근거를 지어내지 않고 옮길 수 있어야 한다(설계 §5).
  const lines = top.map((t) => (t.reasons.length > 0 ? `- ${t.name} — ${t.reasons.join(" ")}` : `- ${t.name}`));
  return { ok: true, content: `오늘 점심 추천이에요.\n${lines.join("\n")}` };
}

export async function lunchVisitHandler(ctx: LunchCtx, args: { place: string; liked?: boolean }): Promise<{ ok: boolean; content: string }> {
  const name = args.place?.trim();
  if (!name) return { ok: false, content: "어느 가게인지 알려주세요." };

  const found = await ctx.repo.findPlacesByName(name);

  // 없는 가게를 새로 만들지 않는다. place_id 없는 행이 생기면 이 기능의 뼈대(안정적 식별자,
  // 설계 §2)가 그 순간 깨지고, 그 뒤의 방문 기록은 같은 가게를 못 알아본다.
  if (found.length === 0) {
    return { ok: false, content: `「${name}」 을 찾지 못했어요. 먼저 검색해서 목록에 올린 뒤에 기록할 수 있어요.` };
  }
  // 여러 개면 고르게 한다 — forget 이 같은 제목 여러 건에 대해 하는 것과 같은 방식이다.
  if (found.length > 1) {
    const list = found.map((p) => `- ${p.name}`).join("\n");
    return { ok: false, content: `여러 곳이 걸렸어요. 어느 곳인지 정확한 이름으로 알려주세요.\n${list}` };
  }

  const place = found[0];
  await ctx.repo.recordVisit({
    userId: ctx.userId, placeId: place.placeId, ts: ctx.now(),
    ...(args.liked === undefined ? {} : { liked: args.liked }),
  });
  const note = args.liked === true ? " 좋으셨다니 다음에 더 자주 추천할게요." : args.liked === false ? " 다음엔 덜 추천할게요." : "";
  return { ok: true, content: `${place.name} 방문을 기록했어요.${note}` };
}
```

- [ ] **Step 4: 통과를 확인하고 커밋**

Run: `cd agent && npx vitest run tests/lunchHandlers.test.ts && npm run typecheck`
Expected: 7 tests PASS

제목 예시: `feat(core): 점심 조회·추천·방문기록 핸들러`

---

### Task 6: 도구 배선 + 게이팅 + 능력 안내

**Files:**
- Modify: `agent/src/core/tools.ts`
- Modify: `agent/src/core/agent.ts` (`ToolRepos`·`buildToolCtx`)
- Modify: `agent/src/index.ts`
- Modify: `agent/src/core/core.ts` (`CoreRepos`)
- Modify: `agent/src/core/persona.ts`
- Test: `agent/tests/tools.test.ts`, `agent/tests/persona.test.ts`

**Interfaces:**
- Consumes: Task 1~5 전부
- Produces: 모델에 노출되는 도구 셋(`lunch_search`·`lunch_recommend`·`lunch_visit`)

**주의 — 2026-08-07 에 실제로 났던 결함:** 능력 안내와 도구 노출을 **서로 다른 곳에서 계산하면**
"안내는 실렸는데 도구가 없는" 상태가 된다. `githubReady` 가 `persona` 에는 전달되고
`allowedToolsFor` 에는 안 전달돼 첫 실사용이 통째로 막혔다. 이 태스크는 `lunchReady` 를
**양쪽 모두에** 넘기고, 그것을 고정하는 테스트를 함께 쓴다.

- [ ] **Step 1: 게이팅 테스트를 쓴다**

`agent/tests/tools.test.ts` 끝에 추가:

```ts
describe("점심 도구 게이팅", () => {
  const has = (tools: string[]) => tools.includes("mcp__asahi__lunch_recommend");

  it("소유자 DM 에서 설정이 있으면 열린다", () => {
    expect(has(allowedToolsFor("owner", true, true, "local", { lunchReady: true }))).toBe(true);
  });

  // 설정이 없으면 노출하지 않는다 — 노출해 두고 부를 때 실패시키면 모델이 매번 시도한다.
  it("설정이 없으면 안 열린다", () => {
    expect(has(allowedToolsFor("owner", true, true, "local", { lunchReady: false }))).toBe(false);
  });

  // 소유자 DM 전용이다(설계 §1.1). db_query 와 같은 자리.
  it("소유자 서버·손님에게는 안 열린다", () => {
    expect(has(allowedToolsFor("owner", false, true, "local", { lunchReady: true }))).toBe(false);
    expect(has(allowedToolsFor("allowed", true, false, "local", { lunchReady: true }))).toBe(false);
    expect(has(allowedToolsFor("allowed", false, false, "local", { lunchReady: true }))).toBe(false);
  });

  it("워커 연결과 무관하다(이 기능은 워커를 쓰지 않는다)", () => {
    expect(has(allowedToolsFor("owner", true, true, "local", { lunchReady: true, workerConnected: false }))).toBe(true);
  });
});
```

- [ ] **Step 2: `allowedToolsFor` 에 축을 더한다**

`AllowedToolsOptions` 에:

```ts
  // 점심 추천 설정(config.lunch)이 갖춰졌는지. 없으면 도구를 아예 노출하지 않는다.
  lunchReady?: boolean;
```

구조 분해에 `lunchReady = false,` 를 더하고, 소유자 DM 분기(`isOwner && isPrivate`)에만
스플라이스한다:

```ts
  // 소유자 DM 전용이다(설계 §1.1). 워커 연결과 무관하다 — 이 기능은 워커를 쓰지 않는다.
  const lunchTools = lunchReady ? [t("lunch_search"), t("lunch_recommend"), t("lunch_visit")] : [];
```

`isOwner && isPrivate` 분기의 반환 배열에 `...lunchTools,` 를 더한다.

- [ ] **Step 3: 도구 선언과 ToolCtx 를 더한다**

`ToolCtx` 에:

```ts
  // 점심 추천 설정과 리포. config.lunch 가 null 이면 도구가 노출되지 않지만, 핸들러도 다시
  // 확인한다 — 노출 판정과 실행 판정이 갈리면 조용히 새는 자리다.
  lunch: LunchConfig | null;
```

`ToolCtx["repos"]` 에 `lunch: LunchRepo;` 를 더하고, `buildToolDefinitions` 에 셋을 더한다:

```ts
    tool(
      "lunch_search",
      "근처 식당을 찾습니다. 검색어를 생략하면 일반적인 맛집을 찾습니다.",
      { query: z.string().optional().describe("검색어(예: 국밥, 파스타)") },
      async (args) => {
        const r = await lunchSearchHandler(lunchCtxOf(ctx), args);
        return textResult(r.content, !r.ok);
      },
    ),
    tool(
      "lunch_recommend",
      "지금까지의 방문 기록과 선호를 반영해 점심을 추천합니다. 추천 이유가 함께 오니 그대로 전하세요 — 이유를 지어내지 마세요.",
      { count: z.number().optional().describe("추천 개수(기본 3)") },
      async (args) => {
        const r = await lunchRecommendHandler(lunchCtxOf(ctx), args);
        return textResult(r.content, !r.ok);
      },
    ),
    tool(
      "lunch_visit",
      "식당 방문을 기록합니다. 좋았는지 여부를 함께 남기면 다음 추천에 반영됩니다.",
      {
        place: z.string().describe("가게 이름"),
        liked: z.boolean().optional().describe("좋았으면 true, 별로였으면 false"),
      },
      async (args) => {
        const r = await lunchVisitHandler(lunchCtxOf(ctx), args);
        return textResult(r.content, !r.ok);
      },
    ),
```

`buildToolDefinitions` 위에 헬퍼를 둔다:

```ts
// 도구가 노출되는 조건(lunchReady)과 실행 조건이 갈리지 않게, 핸들러로 넘기기 직전에 한 번 더
// 확인한다. 노출 판정과 실행 판정이 다른 곳에 있으면 한쪽만 바뀌어도 조용히 어긋난다.
function lunchCtxOf(ctx: ToolCtx): LunchCtx {
  if (!ctx.lunch) throw new Error("점심 추천이 설정되지 않았어요.");
  return { config: ctx.lunch, repo: ctx.repos.lunch, userId: ctx.userId, now: ctx.now };
}
```

- [ ] **Step 4: 양쪽에 같은 값을 넘긴다**

`agent/src/core/agent.ts`:
- `ToolRepos` 에 `lunch: LunchRepo;`
- `buildToolCtx` 시그니처에 `lunch: LunchConfig | null = null` 를 더하고 반환에 싣는다
- `makeRunAgentTurn` 시그니처에 `lunch: LunchConfig | null = null` 를 더해 `buildToolCtx` 로 넘긴다
- **`allowedToolsFor` 호출에 `lunchReady: lunch !== null` 을 더한다** ← 이 줄이 이 태스크의 핵심이다

`agent/src/index.ts`:
- `repos` 조립에 `lunch: new LunchRepo(db),`
- `makeRunAgentTurn(...)` 호출에 `config.lunch` 를 넘긴다

`agent/src/core/core.ts`:
- `CoreRepos` 에 `lunch: LunchRepo;`
- `buildSystemPrompt(...)` 호출에 `lunchReady: this.config.lunch !== null` 을 더한다

`npm run typecheck` 가 테스트의 가짜 객체 누락을 전부 잡아 준다 — 나오는 대로 채운다.

- [ ] **Step 5: 능력 안내와 일관성 테스트**

`agent/src/core/persona.ts` 의 `PersonaContext` 에 `lunchReady?: boolean;` 를 더하고,
소유자 DM 두 분기(워커 연결/미연결) 모두에 아래 한 줄을 조건부로 얹는다:

```ts
const LUNCH_LINE =
  "\n- 점심 추천을 할 수 있습니다(lunch_search·lunch_recommend·lunch_visit). 추천에는 이유가 함께 오니 **그대로 전하고 지어내지 마세요.** 다녀오신 곳은 lunch_visit 으로 기록해 두면 다음 추천이 좋아집니다.";
```

`agent/tests/persona.test.ts` 에:

```ts
// 2026-08-07 에 githubReady 로 실제로 났던 결함의 재발 방지 — 안내가 나오는 조건과 도구가
// 열리는 조건이 어긋나면 "네, 할 수 있습니다" 라고 해놓고 도구가 없는 상태가 된다.
describe("점심 안내와 도구 노출이 일치하는가", () => {
  it("네 신원 × 설정 유무에서 일치한다", () => {
    for (const [isPrivate, isOwner] of [[true, true], [false, true], [true, false], [false, false]] as const) {
      for (const lunchReady of [true, false]) {
        const prompt = buildSystemPrompt({ role: "allowed", isPrivate, isOwner, workerConnected: true, lunchReady });
        const tools = allowedToolsFor("allowed", isPrivate, isOwner, "local", { workerConnected: true, lunchReady });
        expect(prompt.includes("lunch_recommend")).toBe(tools.includes("mcp__asahi__lunch_recommend"));
      }
    }
  });
});
```

**주의:** 위 루프는 `role: "allowed"` 로 도는데 `allowedToolsFor` 의 소유자 분기는 `isOwner` 만
본다. `buildSystemPrompt` 도 같은 축으로 갈리는지 확인하고, 안 맞으면 **구현을 고쳐** 두 함수가
같은 조건에서 갈리게 한다(테스트를 느슨하게 고치지 말 것).

- [ ] **Step 6: 전체 통과를 확인하고 커밋**

Run: `cd agent && npm run typecheck && npm test`

제목 예시: `feat(tools): 점심 도구를 소유자 DM 에 연다`

---

### Task 7: 문서 — 설정 안내와 스모크

**Files:**
- Modify: `.env.example`
- Modify: `deploy/smoke-test.md`
- Modify: `docs/status/STATUS.md`

- [ ] **Step 1: `.env.example` 에 항목을 더한다**

`GITHUB_*` 블록 뒤에:

```bash
# ── 점심 추천 (봇 전용) ──
# 소유자 DM 에서만 열리는 기능이다(docs/superpowers/specs/2026-08-10-lunch-recommend-design.md).
# 키나 좌표가 없으면 도구를 아예 노출하지 않는다 — 봇은 정상 기동한다.
#
# 카카오 REST API 키. developers.kakao.com 에서 앱을 만들고 "REST API 키" 를 쓴다.
# JavaScript 키·네이티브 키가 아니다 — 다른 키를 넣으면 401 로만 드러난다.
KAKAO_REST_API_KEY=
# 검색 기준 좌표 "위도,경도". 순서 주의: 카카오 요청은 x=경도·y=위도 라 뒤집기 쉬운데,
# 뒤집혀도 API 는 오류 없이 엉뚱한 동네를 돌려준다. 그래서 봇이 한국 범위(위도 33~39,
# 경도 124~132)를 확인하고 벗어나면 기능을 아예 열지 않는다.
LUNCH_ORIGIN=
# 검색 반경(미터). 기본 1000, 카카오 상한 20000.
LUNCH_RADIUS_M=
```

- [ ] **Step 2: 스모크 항목을 더한다**

`deploy/smoke-test.md` 의 "미완 항목 추적" 앞에:

```markdown
## 점심 추천

- [ ] **소유자 DM 에서만 열리는가** — 서버 채널에서 "점심 추천해줘" 라고 한다.
  기대 결과: 도구가 없어 할 수 없다고 한다. 이어서 소유자 DM 에서 같은 요청을 하면 추천이 온다.

- [ ] **좌표가 실제로 그 동네인가** — DM 에서 "근처 식당 찾아줘" 라고 한다.
  기대 결과: **캠퍼스 주변 가게**가 나온다. 엉뚱한 동네가 나오면 LUNCH_ORIGIN 의 위도·경도가
  뒤집힌 것이다(범위 검증을 통과하는 뒤집힘도 있다 — 예: 37.4,126.6 을 36.6,127.4 로 잘못 적은 경우).

- [ ] **방문 기록이 다음 추천을 바꾸는가** — 추천받은 곳 하나를 "오늘 거기 갔어, 좋았어" 로
  기록하고 바로 다시 추천받는다.
  기대 결과: 그 가게가 **밀린다**(최근 방문 감점). 며칠 뒤 다시 물으면 올라온다.

- [ ] **추천 이유가 사실인가** — 추천 결과의 이유를 db_query 로 대조한다.
  기대 결과: "3번 가보신 곳" 이면 lunch_visits 에 실제로 3행이 있다. 모델이 이유를 지어내면
  이 기능의 신뢰가 통째로 무너진다.

- [ ] **없는 가게를 기록하지 않는가** — 검색한 적 없는 이름으로 "거기 갔어" 라고 한다.
  기대 결과: 먼저 검색하라고 안내하고 기록하지 않는다.

- [ ] **설정이 없으면 조용히 없는가** — KAKAO_REST_API_KEY 를 지우고 재배포한다.
  기대 결과: 봇이 정상 기동하고 점심 도구만 사라진다.
```

- [ ] **Step 3: STATUS 를 갱신하고 커밋**

`docs/status/STATUS.md` "병합된 주요 기능" 에 항목을 더하되 **미검증**으로 적는다 — 스모크가
아직 안 눌렸다.

Run: `cd .. && node scripts/check-docs.mjs`

제목 예시: `docs: 점심 추천 설정 안내와 스모크 체크리스트`

---

## 이 계획이 다루지 않는 것

- **부원에게 열기** — 스코프·프라이버시·한도가 함께 따라온다(설계 §1.1, §10)
- **사람마다 다른 위치** — 쓰는 사람이 하나다(설계 §3)
- **메뉴 단위 추천·영업시간·평점** — 카카오 기본 응답에 없다(설계 §10)
- **자동 점심 알림** — `digest.ts` 와 같은 축이지만 별개 기능이다
