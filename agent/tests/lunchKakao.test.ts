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
