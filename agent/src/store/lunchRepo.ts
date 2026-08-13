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

// 빈 문자열도 undefined 로 접는다. kakao.ts 의 str() 가 이미 trim 후 length>0 만 통과시켜
// 정상 경로(검색 결과 upsert)에서는 빈 문자열이 애초에 안 들어오지만, DB 에 직접 빈 문자열이
// 있는 행이 있어도 PlaceRow 의 모든 소비자가 어차피 truthy 검사(`p.categoryGroup ? … : …`)로
// 읽으므로 ""·undefined 를 구분할 필요가 없다 — 있음/없음 경계를 여기서 하나로 합쳐 둔다.
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
  // 한 번에 여러 행을 묶는 다중 VALUES + ON CONFLICT DO UPDATE 로 합치지 않는다 — 카카오가
  // 같은 id 를 한 응답 안에 중복으로 주는 순간 "ON CONFLICT DO UPDATE command cannot affect
  // row a second time" 로 그 검색 자체가 실패한다. 행마다 따로 실행하면 같은 place_id 가
  // 여러 번 와도 마지막 값으로 순서대로 덮어쓸 뿐 깨지지 않는다.
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
