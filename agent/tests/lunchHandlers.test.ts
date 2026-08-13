import { describe, it, expect, beforeEach, vi } from "vitest";
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

  // Minor(리뷰) — 카카오 상호명은 우리가 형식을 정하지 못하는 제3자 데이터다. 이름에 개행이
  // 섞이면 목록 한 줄이 두 줄로 쪼개져 "줄 수 = 실제 장소 수" 라는 전제가 깨진다.
  it("이름에 개행이 섞여도 검색 목록에서 줄 수가 늘지 않는다", async () => {
    const r = await lunchSearchHandler(
      { ...ctx(), fetchImpl: fakeFetch([kakaoDoc("1", "국밥집\n가짜행"), kakaoDoc("2", "스시집")]) },
      {},
    );
    // 헤더 한 줄 + 장소 2개 = 3줄. 이름의 개행이 그대로 남으면 4줄이 된다.
    expect(r.content.split("\n").length).toBe(3);
  });

  // 뮤테이션 커버리지: 검색어를 실제로 카카오에 보내지 않고 항상 "" 를 보내도 가짜 fetch 가
  // 인자를 무시하면 기존 테스트는 통과했다 — 핸들러가 실제로 보낸 값을 직접 확인한다.
  it("검색어를 실제로 카카오에 보낸다", async () => {
    let seenUrl = "";
    const capture = (async (url: string) => {
      seenUrl = String(url);
      return new Response(JSON.stringify({ documents: [] }), { status: 200 });
    }) as unknown as typeof fetch;
    await lunchSearchHandler({ ...ctx(), fetchImpl: capture }, { query: "파스타" });
    expect(new URL(seenUrl).searchParams.get("query")).toBe("파스타");
  });

  it("추천은 기록을 반영하고 이유를 함께 준다", async () => {
    await repo.upsertPlaces([{ placeId: "1", name: "국밥집" }], NOW);
    await repo.recordVisit({ userId: "u1", placeId: "1", ts: NOW - 90 * 24 * 3600_000, liked: true });

    const r = await lunchRecommendHandler(ctx(), { count: 2 });
    expect(r.ok).toBe(true);
    // reasons 는 score.ts 가 만든 문장 그대로 나가야 한다(설계 §5) — 모델이 추천 근거를
    // 지어내지 않고 그대로 옮기게 하려면, 핸들러가 감탄사 등을 덧붙이지 않는지 정확한 한
    // 줄 전체를 고정해서 확인해야 한다(toContain 은 뒤에 붙는 말을 못 잡는다).
    const line = r.content.split("\n").find((l) => l.includes("국밥집"));
    expect(line).toBe("- 국밥집 — 1번 가보신 곳이에요. 좋았다고 하신 곳이에요.");
  });

  // 뮤테이션 커버리지: 픽스처가 장소를 2개만 주므로 count:2 는 "count 를 아예 무시한다" 는
  // 결함과 구분되지 않는다 — 픽스처 크기와 다른 값으로 실제로 개수를 줄이는지 본다.
  it("count 인자로 추천 개수를 실제로 제한한다", async () => {
    const r = await lunchRecommendHandler(ctx(), { count: 1 });
    expect(r.ok).toBe(true);
    const bulletLines = r.content.split("\n").filter((l) => l.startsWith("- "));
    expect(bulletLines.length).toBe(1);
  });

  // Item 3(리뷰) — lunch_search 의 upsert 는 위 "검색은 결과를 돌려주고 장소를 저장한다" 가
  // 이미 고정하지만, lunch_recommend 는 아직 아무 테스트도 저장 여부를 보지 않는다.
  // lunchRecommendHandler 가 searchAndStore 대신 searchNearby 를 직접 불러 캐시(upsert)를
  // 건너뛰어도 다른 모든 테스트는 통과한다 — "추천 → '거기 갔다왔어' → lunch_visit(placeId)"
  // 흐름은 lunch_places 에 그 행이 실제로 있어야 성립한다(설계 §4, "캐시가 아니라 참조
  // 대상"). findPlaceById 로 직접 확인해 이 upsert 를 못으로 박는다.
  it("추천도 검색한 장소를 실제로 저장한다", async () => {
    const r = await lunchRecommendHandler(ctx(), {});
    expect(r.ok).toBe(true);
    // 픽스처의 두 장소("국밥집" placeId 1, "스시집" placeId 2) 모두 저장돼야, 그 뒤에
    // lunch_visit 을 placeId 로 불러도 찾을 수 있다.
    expect(await repo.findPlaceById("1")).not.toBeNull();
    expect(await repo.findPlaceById("2")).not.toBeNull();
  });

  it("방문 기록은 이름으로 찾아 저장한다", async () => {
    await repo.upsertPlaces([{ placeId: "1", name: "국밥집" }], NOW);
    const r = await lunchVisitHandler(ctx(), { place: "국밥집", liked: true });
    expect(r.ok).toBe(true);
    expect((await repo.historyOf("u1")).get("1")!.liked).toBe(true);
  });

  // 뮤테이션 커버리지: `liked: args.liked ?? false` 처럼 핸들러가 "생략" 을 "false" 로
  // 바꿔버리면, historyOf 의 "가장 최근 non-NULL liked 가 이긴다" 는 리포의 보장이
  // 핸들러 선에서 미리 망가진다(설계 §4) — 평가 없는 재방문이 이전의 명시적 liked:true 를
  // 지우면 안 된다.
  it("liked 를 생략한 재방문이 이전의 liked:true 를 지우지 않는다", async () => {
    await repo.upsertPlaces([{ placeId: "1", name: "국밥집" }], NOW);
    await lunchVisitHandler(ctx(), { place: "국밥집", liked: true });
    const r2 = await lunchVisitHandler(ctx(), { place: "국밥집" }); // liked 생략
    expect(r2.ok).toBe(true);
    expect((await repo.historyOf("u1")).get("1")!.liked).toBe(true);
  });

  // 뮤테이션 커버리지: 핸들러가 findPlacesByName 위에 대소문자 구분 필터를 다시 얹어도,
  // 대소문자가 같은 테스트만 있으면 안 걸린다 — 대소문자 무시는 리포의 책임이다(설계 §6.1).
  it("가게 이름 대소문자를 리포에 맡기고 핸들러가 다시 거르지 않는다", async () => {
    await repo.upsertPlaces([{ placeId: "1", name: "Starbucks 청운대점" }], NOW);
    const r = await lunchVisitHandler(ctx(), { place: "starbucks" });
    expect(r.ok).toBe(true);
  });

  // Important 1(리뷰) — 이름이 서로 다르게 여러 개 걸리면, 후보에 실제 place_id 와 주소를
  // 함께 보여준다. place_id 는 다음 호출의 placeId 인자로 그대로 되짚을 수 있는 값이라
  // (forget 의 id 와 같은 자리) "번호" 처럼 순번을 붙이는 것과 달리 실제로 쓸모가 있다.
  it("이름이 여러 개 걸리면 저장하지 않고 ID·주소와 함께 후보를 보여준다(개행이 섞여도 줄 수가 늘지 않는다)", async () => {
    await repo.upsertPlaces([
      { placeId: "1001", name: "김밥천국\n가짜행" },
      { placeId: "1002", name: "김밥나라", address: "인천 어딘가" },
    ], NOW);
    const r = await lunchVisitHandler(ctx(), { place: "김밥" });
    expect(r.ok).toBe(false);
    expect(r.content).toContain("1001");
    expect(r.content).toContain("1002");
    expect(r.content).toContain("인천 어딘가");
    // 리드 문장 한 줄 + 후보 2개 = 3줄. 이름의 개행이 그대로 남으면 줄이 하나 더 늘어난다.
    expect(r.content.split("\n").length).toBe(3);
    expect((await repo.historyOf("u1")).size).toBe(0);
    // Item 4(리뷰) — "김밥천국"과 "김밥나라"는 서로의 부분 문자열이 아니라 실제로 다시 말하면
    // 하나로 좁힐 수 있다. 이 경우엔 "구분할 수 없어요" 분기가 아니라 "정확한 상호명이나
    // ID로" 분기를 써야 한다. 이 assertion 이 없으면 판정 로직을 아예 true 로 고정해도
    // (모든 경우에 "구분할 수 없어요" 로 답해도) 위의 다른 assertion 들은 그대로 통과한다 —
    // 리뷰가 지적한 "non-identical 분기가 테스트되지 않는다" 는 구멍이 바로 이것이다.
    expect(r.content).toContain("정확한 상호명이나 ID로 다시 말씀해 주세요");
    expect(r.content).not.toContain("구분할 수 없어요");
  });

  // Important 1(리뷰) 핵심 결함 — 같은 체인의 두 지점처럼 이름이 완전히 같은 후보가 걸리면
  // "정확한 상호명으로 다시 말씀해 주세요" 라는 안내는 사용자를 무한 반복에 빠뜨린다(무엇을
  // 다시 말해도 이름이 같은 한 결과가 똑같다). 이름이 같다는 사실 자체를 밝히고 ID·주소로
  // 안내를 좁혀야 한다.
  it("이름이 완전히 같은 후보가 여러 개면 이름이 같다는 사실을 밝히고 기록하지 않는다", async () => {
    await repo.upsertPlaces([
      { placeId: "2001", name: "GS25 학교점", address: "인천 A" },
      { placeId: "2002", name: "GS25 학교점", address: "인천 B" },
    ], NOW);
    const r = await lunchVisitHandler(ctx(), { place: "GS25 학교점" });
    expect(r.ok).toBe(false);
    // Item 4(리뷰) 이후 문구가 "「N」 이라는 이름만으로는 M곳을 구분할 수 없어요" 로
    // 바뀌어 두 낱말 사이에 개수가 끼어든다 — 연속 문자열 대신 두 조각을 따로 확인한다.
    expect(r.content).toContain("이름만으로는");
    expect(r.content).toContain("구분할 수 없어요");
    expect(r.content).toContain("2001");
    expect(r.content).toContain("2002");
    expect(r.content).toContain("인천 A");
    expect(r.content).toContain("인천 B");
    expect((await repo.historyOf("u1")).size).toBe(0);
    // 목록만 보여줬을 뿐 그 무엇도 새로 만들거나 지우지 않았다.
    expect(await repo.findPlaceById("2001")).not.toBeNull();
    expect(await repo.findPlaceById("2002")).not.toBeNull();
  });

  // Item 4(리뷰) — "김밥천국"/"김밥천국 인천점"처럼 한 후보의 이름이 다른 후보 이름의 부분
  // 문자열이면, 이름을 다시 말해도(검색 자체가 부분 문자열 일치라서, store/lunchRepo.ts 의
  // findPlacesByName) 짧은 쪽을 매칭시키는 어떤 검색어든 반드시 긴 쪽도 함께 매칭시킨다 —
  // "정확한 상호명으로 다시 말씀해 주세요" 는 실행 불가능한 안내다. 카카오 체인 데이터는
  // "본점"/"인천점" 처럼 이 모양이 흔하다. 예전 판정("이름이 전부 완전히 같다")은 이 쌍을
  // 못 잡는다 — 두 이름이 완전히 같지 않기 때문이다.
  it("한 후보의 이름이 다른 후보 이름의 부분 문자열이면 이름만으로 구분할 수 없다고 밝힌다", async () => {
    await repo.upsertPlaces([
      { placeId: "3001", name: "김밥천국" },
      { placeId: "3002", name: "김밥천국 인천점" },
    ], NOW);
    const r = await lunchVisitHandler(ctx(), { place: "김밥천국" });
    expect(r.ok).toBe(false);
    expect(r.content).toContain("이름만으로는");
    expect(r.content).toContain("구분할 수 없어요");
    expect(r.content).not.toContain("정확한 상호명이나 ID로 다시 말씀해 주세요");
    expect(r.content).toContain("3001");
    expect(r.content).toContain("3002");
  });

  // Item 4(리뷰) — 검색 자체가 대소문자를 가리지 않으므로(findPlacesByName 의
  // strpos(lower(name), lower($1))) "구분할 수 없다" 판정도 대소문자를 접어야 한다. 안
  // 접으면 "CU 학교점"/"cu 학교점"처럼 검색으로는 절대 못 가르는 쌍인데도 "정확한 상호명으로
  // 다시 말씀해 주세요" 라고 실행 불가능한 안내를 하게 된다.
  it("대소문자만 다른 이름도 이름만으로는 구분할 수 없다고 밝힌다", async () => {
    await repo.upsertPlaces([
      { placeId: "4001", name: "CU 학교점" },
      { placeId: "4002", name: "cu 학교점" },
    ], NOW);
    const r = await lunchVisitHandler(ctx(), { place: "cu 학교점" });
    expect(r.ok).toBe(false);
    expect(r.content).toContain("이름만으로는");
    expect(r.content).toContain("구분할 수 없어요");
  });

  // Item 5(리뷰) — placeId 도 name 과 같은 제3자 데이터(카카오 문서의 id)다. kakao.ts 의
  // str() 는 끝만 trim 하고 안쪽 개행은 그대로 둔다 — "여러 개 걸림" 목록에서 placeId 에
  // 개행이 섞이면 후보 하나가 두 줄로 보여 singleLine 이 지키려는 "줄 수 = 후보 수" 전제가
  // 깨진다(위 개행 테스트들과 같은 종류지만, 그동안 name/address 만 감싸고 placeId 는
  // 빠져 있었다).
  it("placeId 에 개행이 섞여도 후보 목록의 줄 수가 늘지 않는다", async () => {
    await repo.upsertPlaces([
      { placeId: "300\n가짜행", name: "김밥천국" },
      { placeId: "301", name: "김밥나라" },
    ], NOW);
    const r = await lunchVisitHandler(ctx(), { place: "김밥" });
    expect(r.ok).toBe(false);
    // 리드 문장 한 줄 + 후보 2개 = 3줄. placeId 의 개행이 그대로 남으면 4줄이 된다.
    expect(r.content.split("\n").length).toBe(3);
  });

  // Important 1(리뷰) — placeId 가 오면 이름 해석을 완전히 건너뛰고 그 place 로 정확히
  // 기록한다. forget 의 id 인자와 같은 자리(설계 §6.1) — 직전의 "여러 개 걸림" 목록에서
  // 이미 하나를 골랐다는 뜻이다.
  it("placeId 를 주면 이름 해석 없이 그 place 로 정확히 기록한다", async () => {
    await repo.upsertPlaces([
      { placeId: "2001", name: "GS25 학교점", address: "인천 A" },
      { placeId: "2002", name: "GS25 학교점", address: "인천 B" },
    ], NOW);
    const r = await lunchVisitHandler(ctx(), { placeId: "2002", liked: true });
    expect(r.ok).toBe(true);
    const h = await repo.historyOf("u1");
    expect(h.get("2002")!.liked).toBe(true);
    expect(h.has("2001")).toBe(false); // 다른 지점은 건드리지 않는다
  });

  // Important 1(리뷰) — 모르는 placeId 는 그냥 실패다. §2 의 안정적 식별자는 "카카오가 실제로
  // 준 place_id" 만을 뜻하므로, 모르는 id 로 새 lunch_places 행을 만들면 안 된다.
  it("placeId 에 해당하는 가게가 없으면 아무것도 만들지 않고 한국어로 안내한다", async () => {
    const r = await lunchVisitHandler(ctx(), { placeId: "없는id" });
    expect(r.ok).toBe(false);
    expect(r.content).toContain("찾지 못했어요");
    expect((await repo.historyOf("u1")).size).toBe(0);
    expect(await repo.findPlaceById("없는id")).toBeNull();
  });

  // Item 6(리뷰) — placeId 가 공백뿐이면 "어느 가게인지 알려주세요" 라고 답하면 안 된다 —
  // 그 문구는 인자를 아예 안 보낸 것처럼 들리지만, 실제로는 placeId 를 보냈다는 사실 자체가
  // 있다. 인자가 왔다는 사실을 알려주는 별도 안내가 필요하다.
  it("placeId 가 공백뿐이면 인자를 아예 안 보낸 것과 다르게 안내한다", async () => {
    const r = await lunchVisitHandler(ctx(), { placeId: "   " });
    expect(r.ok).toBe(false);
    expect(r.content).not.toBe("어느 가게인지 알려주세요.");
    expect(r.content).toContain("ID");
  });

  // Item 6(리뷰) — placeId 의 trim 이 지금까지 테스트로 고정돼 있지 않았다(지워도 기존
  // 스위트가 안 걸린다). forget 의 id 인자처럼, 모델이 앞뒤에 공백을 붙여 보내도 정확히
  // 찾아야 한다.
  it("placeId 앞뒤 공백을 트림해서 찾는다", async () => {
    await repo.upsertPlaces([{ placeId: "2001", name: "국밥집" }], NOW);
    const r = await lunchVisitHandler(ctx(), { placeId: "  2001  " });
    expect(r.ok).toBe(true);
  });

  // place_id 없는 행이 생기면 누적의 뼈대가 그 순간 깨진다(설계 §6.1) — 검색 없이 방문만
  // 부른 이름은 절대 새 lunch_places 행을 만들지 않는다.
  it("없는 가게는 새로 만들지 않고 먼저 검색하라고 한다", async () => {
    const r = await lunchVisitHandler(ctx(), { place: "없는집" });
    expect(r.ok).toBe(false);
    expect(r.content).toContain("검색");
    expect((await repo.historyOf("u1")).size).toBe(0);
    expect((await repo.findPlacesByName("없는집")).length).toBe(0);
  });

  it("지도 API 가 실패하면 실패로 돌려주고 키를 노출하지 않는다", async () => {
    const failing = (async () => new Response("{}", { status: 401 })) as unknown as typeof fetch;
    const r = await lunchSearchHandler({ ...ctx(), fetchImpl: failing }, {});
    expect(r.ok).toBe(false);
    expect(r.content).not.toContain("kk");
    // Item 1(리뷰) — KakaoUserError 는 failMessage 가 다시 감싸지 않는다. 감쌌다면
    // "카카오 지도 API 호출 중 문제가 생겼어요: 지도 API 인증에 실패했어요…" 처럼 두 문장이
    // 겹쳤을 것이다. 겹치지 않는지, 그리고 "근처에 없다"는 그릇된 원인으로 안내하지 않는지
    // 함께 고정한다.
    expect(r.content).not.toContain("문제가 생겼어요");
    expect(r.content).not.toContain("찾지 못했어요");
    expect(r.content).toContain("인증");
  });

  // 뮤테이션 커버리지: 지도 API 가 실패했을 때 키를 노출하지 않는지는 지금까지 lunch_search
  // 만 검증했다 — lunch_recommend 도 같은 failMessage 를 쓰므로 따로 고정해야 한다.
  it("추천에서도 지도 API 가 실패하면 키를 노출하지 않는다", async () => {
    const failing = (async () => new Response("{}", { status: 401 })) as unknown as typeof fetch;
    const r = await lunchRecommendHandler({ ...ctx(), fetchImpl: failing }, {});
    expect(r.ok).toBe(false);
    expect(r.content).not.toContain("kk");
    // Item 1(리뷰) — lunch_search 테스트와 같은 이유로, recommend 경로도 이중 감싸기가
    // 없어야 한다.
    expect(r.content).not.toContain("문제가 생겼어요");
    expect(r.content).not.toContain("찾지 못했어요");
    expect(r.content).toContain("인증");
  });

  // Important 2(리뷰) — fetch 자체가 실패하면(DNS·ECONNREFUSED·네트워크 순단) 영어 원문
  // ("fetch failed" 등)이 그대로 온다. kakao.ts 의 의도된 오류와 달리 한국어가 아니므로,
  // 한국어 문장으로 감싸 보내고 원문은 진단용으로 콘솔에만 남겨야 한다(recallHandler,
  // tools.ts:130 의 선례).
  it("지도 API 호출 자체가 실패해도 한국어 문장으로 감싸 안내하고 원문은 콘솔에 남긴다", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const netFail = (async () => { throw new Error("fetch failed"); }) as unknown as typeof fetch;
    const r = await lunchSearchHandler({ ...ctx(), fetchImpl: netFail }, {});
    expect(r.ok).toBe(false);
    expect(r.content).toContain("문제가 생겼어요");
    expect(r.content).not.toBe("fetch failed");
    // Item 1(리뷰) — "not.toBe('fetch failed')" 만으로는 "감싸긴 했지만 원문을 이어붙였다"
    // (예: "…문제가 생겼어요: fetch failed")는 여전히 통과한다 — 실제로 리뷰 시점의 코드가
    // 그랬다. 원문이 부분 문자열로도 전혀 남지 않아야 한다.
    expect(r.content).not.toContain("fetch failed");
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  // Important 2(리뷰) — 카카오나 그 앞단 프록시가 200 과 함께 HTML 을 돌려주면 res.json() 이
  // 파싱에 실패하며 응답 본문 일부를 오류 메시지에 그대로 담는다. 그 원문을 사용자에게
  // 그대로 돌려주지 않는다.
  it("JSON 이 아닌 응답(HTML 등)을 받아도 한국어 문장으로 감싸 안내한다", async () => {
    const htmlBody = (async () => new Response("<html>Access Denied</html>", { status: 200 })) as unknown as typeof fetch;
    const r = await lunchRecommendHandler({ ...ctx(), fetchImpl: htmlBody }, {});
    expect(r.ok).toBe(false);
    expect(r.content).toContain("문제가 생겼어요");
    // Item 1(리뷰) — 측정된 실제 누출 사례: "Unexpected token '<', \"<html>Acce\"…" 처럼
    // JSON.parse 실패 메시지가 응답 본문 조각을 그대로 담아 새어 나갔다. 본문 조각도,
    // 파싱 오류의 진단 문구도 사용자 응답에 남지 않아야 한다.
    expect(r.content).not.toContain("<html");
    expect(r.content).not.toContain("Access Denied");
    expect(r.content).not.toContain("Unexpected token");
  });
});
