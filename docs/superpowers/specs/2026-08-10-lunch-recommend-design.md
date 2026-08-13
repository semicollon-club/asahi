---
lastReviewed: 2026-08-10
---

# 점심 추천 — 설계

## 1. 무엇을 만드는가

소유자가 DM 에서 "점심 뭐 먹지" 라고 물으면, 캠퍼스 근처 식당 중에서 **지금까지의 방문 기록과
선호를 반영해** 몇 곳을 골라 준다. 방문한 곳을 기록해 두면 그 기록이 다음 추천을 바꾼다.

### 1.1 지금은 소유자 DM 전용이다

부원에게 열지 않는다(2026-08-10 확정). 그래서 이 문서에는 **공용/개인 스코프 분기가 없다** —
모든 기록은 소유자의 것이고, 도구는 `db_query`·`manage_access` 와 같은 자리
(`isOwner && isPrivate`)에서만 열린다.

이 결정이 설계를 크게 줄인다. 부원에게 열면 "서버 채널에서 추천받으면 내 식사 이력이 공개
대화에 드러난다" 는 프라이버시 문제와, 기억의 `memoryScopeFor`(DM=개인/서버=공용)를 따를지
말지의 판단이 따라온다 — **지금은 둘 다 없다.** 나중에 열 때 그때 다룬다(§10).

## 2. 왜 지도 API 인가 — WebSearch 로는 안 되는 이유

봇은 이미 `WebSearch` 를 갖고 있고, "청운대 인천캠퍼스 근처 맛집" 정도는 그것만으로 답한다.
그런데 이 기능의 핵심은 검색이 아니라 **누적**이다.

방문 횟수를 세려면 "같은 가게인가" 를 판정할 수 있어야 한다. 검색 결과 텍스트는 매번 표현이
달라("○○식당", "○○식당 인천점", "○○식당(본점)") 같은 가게인지 알 수 없고, 그러면 방문
기록이 같은 가게를 여러 행으로 쪼개 놓아 가중치가 무의미해진다. **지도 API 가 필요한 이유는
거리 계산이 아니라 안정적인 `place_id` 다.**

### 2.1 카카오 로컬 API 를 쓴다

2026-08-10 문서 확인:

```
GET https://dapi.kakao.com/v2/local/search/keyword.json
Authorization: KakaoAK <REST_API_KEY>
  query(필수) · x · y · radius(0~20000m) · category_group_code · sort(distance|accuracy)
  · size(1~15) · page(1~45)
```

응답 문서 필드: `id` · `place_name` · `category_name` · `category_group_code` ·
`category_group_name` · `phone` · `address_name` · `road_address_name` · `x` · `y` ·
`place_url` · `distance`(좌표를 준 경우).

네이버 대신 카카오를 고른 이유는 **인증이 헤더 하나**이기 때문이다(네이버는 client id +
secret 두 개). 키가 적을수록 잘못 넣을 자리도 적다. 응답의 `id` 가 §2 가 요구하는 안정적
식별자다.

## 3. 위치 — 좌표는 설정값으로 고정한다

봇은 자기 위치를 모르고 디스코드에도 위치 정보가 없다. 사람마다 다른 위치를 저장하는 구조는
지금 필요 없다 — 쓰는 사람이 하나뿐이고, 그 사람의 점심 반경은 캠퍼스 주변으로 고정이다.

`LUNCH_ORIGIN`(`"위도,경도"`)과 `LUNCH_RADIUS_M`(기본 1000)을 설정으로 받는다. 카카오는
`x`=경도·`y`=위도 순서라 흔히 뒤집어 넣는데, 뒤집혀도 API 는 오류 없이 **엉뚱한 동네 결과**를
돌려준다. 설정 파싱에서 위도(33~39)·경도(124~132) 범위를 확인해 한국 밖이면 설정을 무시하고
`null` 을 돌려준다(§7).

## 4. 데이터 모델

```sql
CREATE TABLE IF NOT EXISTS lunch_places (
  place_id TEXT PRIMARY KEY,        -- 카카오 문서의 id. 이 표 전체가 그것에 매달린다
  name TEXT NOT NULL,
  category TEXT,                    -- category_name (예: "음식점 > 한식 > 국밥")
  category_group TEXT,              -- category_group_name (예: "음식점")
  address TEXT,
  url TEXT,
  updated_ts BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS lunch_visits (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id TEXT NOT NULL,
  place_id TEXT NOT NULL,
  ts BIGINT NOT NULL,
  liked BOOLEAN                     -- NULL = 평가 안 함
);
CREATE INDEX IF NOT EXISTS idx_lunch_visits_user_ts ON lunch_visits(user_id, ts);
CREATE INDEX IF NOT EXISTS idx_lunch_visits_place ON lunch_visits(place_id);
```

**`lunch_places` 는 캐시가 아니라 참조 대상이다.** 방문 기록이 `place_id` 만 들고 있으면 나중에
그 가게가 카카오에서 사라졌을 때 이름조차 못 보여준다. 검색 결과를 볼 때마다 upsert 해 둔다.

**`scope` 컬럼을 두지 않는다.** 지금은 소유자만 쓰므로 모든 행이 같은 값을 갖는다 — 값이 하나뿐인
컬럼은 아무것도 구분하지 못하면서 "이 축이 이미 동작한다"는 인상만 준다. 부원에게 열 때
그 축을 실제로 쓰는 코드와 함께 더한다.

**`user_id` 는 둔다.** `scope` 와 달리 이건 행을 스스로 설명하게 만든다 — 한 컬럼이고, 없으면
나중에 "이 행들이 누구 것인가" 를 코드 밖 기억에 의존해 알아내야 한다.

## 5. 가중치 — 순수 함수

이 기능에서 정확성을 확보할 수 있는 유일한 부분이다(API 응답도 DB 도 없이 테스트한다).

```ts
type Candidate = { placeId: string; name: string; categoryGroup?: string; distanceM?: number };
type History = { placeId: string; visits: number; lastVisitTs?: number; liked?: boolean };
function scoreCandidates(
  candidates: Candidate[],
  history: Map<string, History>,
  o: { nowMs: number; recentCategoryGroups: string[] },
): Array<{ placeId: string; score: number; reasons: string[] }>;
```

네 축을 곱셈이 아니라 **가산**으로 쌓는다 — 곱셈은 한 축이 0 이면 나머지를 통째로 지워서,
"왜 이게 추천됐나" 를 설명할 수 없게 된다.

| 축 | 방향 | 이유 |
|---|---|---|
| 방문 횟수 | + (로그) | 자주 간 곳 = 좋아하는 곳. 선형이면 한 곳이 목록을 독점한다 |
| 최근 방문 | **−** | 어제 간 데를 오늘 또 추천하면 쓸모가 없다. 3일 이내는 크게 깎는다 |
| `liked` | + / −− | 명시적 평가는 추측(횟수)보다 세게 반영한다. `false` 는 사실상 제외 |
| 최근 카테고리 반복 | − | 한식만 사흘 연속 나오는 것을 막는다 |

**`reasons` 를 함께 돌려준다.** 모델이 "왜 이걸 추천했는지" 를 지어내지 않고 그대로 옮길 수
있어야 한다 — 이 저장소는 작업 사실 조작을 금지하고 있고(persona 의 IDENTITY), 추천 이유도
같은 범주다.

## 6. 도구 셋

| 도구 | 하는 일 |
|---|---|
| `lunch_search(query?, category?)` | 근처 조회. 결과를 `lunch_places` 에 upsert 하고 목록을 돌려준다 |
| `lunch_recommend(count?)` | 조회 + 기록 결합 → 점수순 상위 몇 곳을 이유와 함께 |
| `lunch_visit(place, liked?)` | 방문 기록. 이름으로 찾아 `place_id` 로 저장한다 |

**게이팅은 `isOwner && isPrivate` 하나다.** 워커 연결과 무관하다(워커를 안 쓴다). 카카오 키가
없으면 셋 다 노출하지 않는다 — 깃허브 발행과 같은 원칙이고, 노출해 두고 부를 때 실패시키면
모델이 매번 시도했다가 실패를 사용자에게 전달한다.

**사람이 지켜보지 않는 턴은 자동으로 닫힌다** — 유휴 요약·정기 게시는 소유자 DM 이 아니다.

### 6.1 `lunch_visit` 의 이름 해석

모델은 "○○식당 갔었어" 처럼 이름으로 말한다. 그 이름을 `lunch_places` 에서 찾는다.

- **정확히 하나** 걸리면 기록한다
- **여러 개** 걸리면 기록하지 않고 후보를 번호와 함께 보여준다 — `forget` 이 같은 제목 여러 건에
  대해 하는 것과 같은 방식이다(그 선례를 그대로 따른다)
- **없으면** 기록하지 않고 "먼저 검색해 주세요" 라고 한다. 없는 가게를 새로 만들지 않는다 —
  `place_id` 없는 행이 생기면 §2 가 요구한 안정적 식별자가 그 순간 깨진다

## 7. 설정

| 변수 | 값 |
|---|---|
| `KAKAO_REST_API_KEY` | 카카오 REST API 키 |
| `LUNCH_ORIGIN` | `"위도,경도"` (예: `37.4,126.6`) |
| `LUNCH_RADIUS_M` | 검색 반경(미터). 기본 1000, 상한 20000(카카오 제약) |

셋 중 키와 좌표가 없으면 `config.lunch = null` 이고 도구가 안 열린다. 반경만 없으면 기본값을
쓴다 — 없어서 못 도는 값과 기본값이 있는 값을 구분한다.

좌표는 **파싱 시 한국 범위인지 확인한다**(§3). 범위를 벗어나면 `null` — 뒤집힌 좌표로 엉뚱한
동네를 추천하느니 기능이 안 열리는 편이 낫다.

## 8. 외부 호출

`appToken.ts` 의 `fetchWithTimeout` 과 같은 모양이다 — 10초 `AbortController`, 주입 가능한
`fetchImpl`, 타임아웃은 한국어 존댓말로. 유닛 테스트는 네트워크를 타지 않는다.

**키를 오류 메시지에 싣지 않는다.** 카카오가 401 을 주면 그 사실만 전하고 키는 언급하지 않는다.

## 9. 테스트 전략

**유닛으로 고정할 것**

| 대상 | 무엇을 |
|---|---|
| `scoreCandidates` | 네 축이 각각 순위를 바꾸는가, `reasons` 가 그 축을 설명하는가 |
| 좌표 파싱 | 뒤집힌 좌표·범위 밖·형식 오류를 전부 `null` 로 |
| 설정 로딩 | 키·좌표 없으면 `null`, 반경만 없으면 기본값 |
| 카카오 응답 매핑 | 주입한 가짜 응답 → `Candidate`. 필드 누락에도 안 깨지는가 |
| `lunch_visit` 이름 해석 | 하나·여럿·없음 세 갈래 |
| 도구 게이팅 | 소유자 DM 에서만, 키 없으면 안 열림 |
| 리포 | pg-mem — upsert·방문 집계 |

**유닛이 못 잡는 것 → 스모크**

실제 카카오 응답 형태, 좌표가 실제로 그 동네를 가리키는가, 키가 유효한가.
`deploy/smoke-test.md` 에 항목을 더한다.

## 10. 이 문서가 다루지 않는 것

- **부원에게 열기** — 그때 스코프(개인/공용)·프라이버시·한도를 함께 다룬다(§1.1)
- **사람마다 다른 위치** — 쓰는 사람이 하나라 필요 없다(§3)
- **메뉴 단위 추천** — 카카오는 가게까지만 준다. 메뉴를 다루려면 별도 데이터가 필요하다
- **자동 점심 알림** — 정기 게시(`digest.ts`)와 같은 축이지만 별개 기능이다
- **예산·영업시간·평점** — 카카오 기본 응답에 없다. 필요해지면 그때 본다
