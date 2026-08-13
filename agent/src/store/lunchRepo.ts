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

  async findPlacesByName(name: string): Promise<PlaceRow[]> {
    const r = await this.db.query(
      "SELECT * FROM lunch_places WHERE name LIKE $1 ORDER BY name",
      [`%${name}%`],
    );
    return (r.rows as RawPlace[]).map(toPlaceRow);
  }

  async recordVisit(o: { userId: string; placeId: string; ts: number; liked?: boolean }): Promise<void> {
    await this.db.query(
      "INSERT INTO lunch_visits (user_id, place_id, ts, liked) VALUES ($1, $2, $3, $4)",
      [o.userId, o.placeId, o.ts, o.liked ?? null],
    );
  }

  // 방문 횟수·마지막 방문·평가를 place_id 별로 모은다. liked 는 **가장 최근 방문의 값**을
  // 쓴다 — 예전에 별로였어도 최근에 좋았으면 그게 지금의 판단이다. 그래서 집계 대신 시간
  // 역순으로 훑으며 처음 만난 값을 취한다.
  async historyOf(userId: string): Promise<Map<string, History>> {
    const r = await this.db.query(
      "SELECT place_id, ts, liked FROM lunch_visits WHERE user_id = $1 ORDER BY ts DESC",
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
