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
