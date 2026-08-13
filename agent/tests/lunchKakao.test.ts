import { describe, it, expect, vi } from "vitest";
import { mapKakaoDocument, searchNearby, KakaoUserError } from "../src/lunch/kakao.js";

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

  // Item 1(리뷰) — 401 은 "근처에 결과가 없다"는 뜻이 아니라 인증(키) 이 실패했다는 뜻이다.
  // 예전 문구("근처 식당을 찾지 못했어요(지도 API 오류 401)")는 원인을 동네 탓으로 돌려,
  // core/lunch.ts 의 failMessage 가 무조건 한 번 더 감싸면 "문제가 생겼어요: 근처 식당을
  // 찾지 못했어요…" 처럼 스스로 모순되는 문장이 됐다. 이제 kakao.ts 는 KakaoUserError 로
  // 던져 failMessage 가 감싸지 않게 하고, 문구도 인증 실패를 직접 가리킨다.
  it("401 은 근처 결과가 없다는 말이 아니라 인증 실패를 가리키는 KakaoUserError 를 던진다", async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ message: "bad" }), { status: 401 })) as unknown as typeof fetch;
    try {
      await searchNearby({ config, query: "점심", fetchImpl });
      expect.unreachable("401 이면 반드시 던져야 한다");
    } catch (e) {
      expect(e).toBeInstanceOf(KakaoUserError);
      expect((e as Error).message).toMatch(/인증/);
      expect((e as Error).message).not.toContain("찾지 못했");
    }
  });

  // Item 1(리뷰) — "Same shape for the timeout": 타임아웃 문구는 이미 한국어였지만 예전
  // KakaoUserError 구분이 없어 failMessage 가 401 과 마찬가지로 한 번 더 감쌌다. 타임아웃도
  // KakaoUserError 여야 한다. 실제로 10초를 기다리지 않도록 가짜 타이머로 시간을 밀어
  // AbortController 가 신호를 보내게 한다(remoteExecutors.test.ts 의 CDN 타임아웃 테스트와
  // 같은 패턴).
  it("타임아웃도 KakaoUserError 로 던진다", async () => {
    vi.useFakeTimers();
    try {
      const hangingFetch = ((_url: string, init?: { signal?: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(new DOMException("The operation was aborted.", "AbortError")),
          );
        })) as unknown as typeof fetch;
      const pending = searchNearby({ config, query: "점심", fetchImpl: hangingFetch });
      const assertion = expect(pending).rejects.toBeInstanceOf(KakaoUserError);
      await vi.advanceTimersByTimeAsync(10_000); // kakao.ts 의 FETCH_TIMEOUT_MS 와 같은 값
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });
});
