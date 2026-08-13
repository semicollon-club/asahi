import type { LunchConfig } from "../config.js";
import type { LunchRepo, PlaceRow } from "../store/lunchRepo.js";
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

// 개행을 공백으로 바꾼다. 카카오가 주는 이름·주소는 우리가 형식을 정하지 못하는 제3자
// 데이터다(tools.ts 의 singleLine, forget 목록과 같은 이유) — 개행이 섞이면 후보 하나가
// 목록에서 줄 두 개로 보여 "줄 수 = 실제 후보 수" 라는 전제가 깨진다. 카카오 상호명·주소에
// 개행이 실제로 나온 적은 없지만, 막는 비용이 0 이라 막아 둔다.
const singleLine = (s: string): string => s.replace(/[\r\n]+/g, " ");

// 검색은 항상 저장을 동반한다 — 저장하지 않으면 방문 기록이 참조할 대상이 없다(설계 §4).
async function searchAndStore(ctx: LunchCtx, query: string): Promise<KakaoPlace[]> {
  const places = await searchNearby({ config: ctx.config, query, fetchImpl: ctx.fetchImpl });
  // places 가 비어 있으면 리포가 루프를 그냥 안 돈다 — 여기서 다시 길이를 확인할 이유가 없다.
  await ctx.repo.upsertPlaces(places, ctx.now());
  return places;
}

// kakao.ts 가 스스로 던지는 오류(401 안내, 타임아웃)는 이미 한국어 문장이지만, 그 밖의
// 오류는 아니다 — fetch 자체가 실패하면(DNS·ECONNREFUSED·Railway 네트워크 순단) 영어 원문이
// 그대로 오고, 카카오나 그 앞단 프록시가 200 과 함께 HTML 을 돌려주면 res.json() 파싱이
// 깨지면서 그 응답 본문 일부가 오류 메시지에 그대로 실린다. 어느 쪽이든 원문을 그대로
// 사용자에게 보내지 않는다 — tools.ts 의 이웃 핸들러들(allowDirHandler 등, :224·:244·:259·
// :284)과 같은 방식으로 한국어 문장 안에 감싸고, 진단용 원문은 콘솔에 남긴다(recallHandler,
// tools.ts:130 의 선례). 카카오 키는 이 원문에 섞이지 않는다 — kakao.ts 가 응답 본문·상태
// 코드 어디에도 키를 싣지 않음을 이미 보장한다(lunchKakao.test.ts).
function failMessage(err: unknown): string {
  console.error("[lunch] 카카오 검색 실패:", err);
  const detail = err instanceof Error ? err.message : String(err);
  return `카카오 지도 API 호출 중 문제가 생겼어요: ${detail}`;
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
    return `- ${singleLine(p.name)}${d}${p.categoryGroup ? ` · ${p.categoryGroup}` : ""}`;
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

// 방문을 실제로 기록하고 응답 문구를 만든다. placeId 로 곧장 들어온 경우와 이름이 정확히
// 하나로 좁혀진 경우가 이 지점에서 합류한다 — 저장 로직 자체는 "그 place 를 어떻게
// 찾았는가"와 무관해야 한다.
async function recordAndReport(
  ctx: LunchCtx,
  place: PlaceRow,
  liked: boolean | undefined,
): Promise<{ ok: boolean; content: string }> {
  await ctx.repo.recordVisit({
    userId: ctx.userId, placeId: place.placeId, ts: ctx.now(),
    ...(liked === undefined ? {} : { liked }),
  });
  const note = liked === true ? " 좋으셨다니 다음에 더 자주 추천할게요." : liked === false ? " 다음엔 덜 추천할게요." : "";
  return { ok: true, content: `${place.name} 방문을 기록했어요.${note}` };
}

// Important 1(리뷰) — 예전엔 "여러 개 걸림" 목록이 forget 의 시각 형식(- (번호 N) 이름)만
// 베끼고 정작 forget 의 핵심인 "번호로 되짚어 하나를 지정하는" 메커니즘은 없었다(인자가
// place 하나뿐이라 번호를 되짚을 자리가 없었다). 그 결과 이름이 완전히 같은 두 후보(체인
// 지점처럼 흔하다)가 걸리면 사용자가 뭐라고 다시 말해도 같은 목록이 영원히 반복되고, 모델이
// 임의로 "2번" 같은 텍스트를 place 인자에 넣으면 부분 문자열 일치로 엉뚱한 가게(예: "GS25
// 학교점")에 방문이 기록되는 사고까지 났다. placeId 를 실제 되짚기 인자로 추가해 forget 과
// 같은 구조(title?/id? → place?/placeId?)를 완성한다.
export async function lunchVisitHandler(
  ctx: LunchCtx,
  args: { place?: string; placeId?: string; liked?: boolean },
): Promise<{ ok: boolean; content: string }> {
  // placeId 가 오면 이름 해석을 완전히 건너뛴다 — forget 의 id 인자와 같은 자리다(설계
  // §6.1): 직전에 이 도구가 내놓은 "여러 개 걸림" 목록에서 이미 하나를 정확히 골랐다는
  // 뜻이라, 다시 이름으로 찾으면 같은 모호함을 되풀이할 뿐이다. lunch_places 에 없는 id 는
  // 새로 만들지 않는다 — §2 의 안정적 식별자는 "카카오가 실제로 준 place_id" 만을 뜻하므로,
  // 모르는 id 는 그냥 실패다.
  const placeId = args.placeId?.trim();
  if (placeId) {
    const place = await ctx.repo.findPlaceById(placeId);
    if (!place) {
      return { ok: false, content: `ID ${placeId} 에 해당하는 가게를 찾지 못했어요. 다시 검색해서 확인해 주세요.` };
    }
    return recordAndReport(ctx, place, args.liked);
  }

  const name = args.place?.trim();
  if (!name) return { ok: false, content: "어느 가게인지 알려주세요." };

  // findPlacesByName 이 트림·대소문자 무시·상한을 이미 다 한다(store/lunchRepo.ts) — 그
  // 위에 같은 일을 다시 하지 않는다.
  const found = await ctx.repo.findPlacesByName(name);

  // 없는 가게를 새로 만들지 않는다. place_id 없는 행이 생기면 이 기능의 뼈대(안정적 식별자,
  // 설계 §2)가 그 순간 깨지고, 그 뒤의 방문 기록은 같은 가게를 못 알아본다.
  if (found.length === 0) {
    return { ok: false, content: `「${name}」 을 찾지 못했어요. 먼저 검색해서 목록에 올린 뒤에 기록할 수 있어요.` };
  }
  // 여러 개면 추측으로 하나를 고르지 않고 고르게 한다 — forget 이 같은 제목 여러 건에 대해
  // 하는 것과 같은 방식이다(설계 §6.1). forget 은 목록에 실제 id 를 보여주고 그 id 를 그대로
  // 되짚어 받는데, lunch_visit 도 이제 같은 구조다 — 목록에 실제 place_id 를 싣고, 다음
  // 호출의 placeId 인자로 그 값을 그대로 돌려주면 이름 재해석 없이 하나를 정확히 지정한다.
  // address 도 함께 보여준다: findPlacesByName 이 이미 돌려주는 필드라 비용이 없고, 체인
  // 지점처럼 이름이 완전히 같은 두 곳을 실제로 구분해 주는 것은 이름이 아니라 주소다.
  if (found.length > 1) {
    const list = found
      .map((p) => `- (ID ${p.placeId}) ${singleLine(p.name)}${p.address ? ` · ${singleLine(p.address)}` : ""}`)
      .join("\n");
    // 이름이 전부 같으면 "정확한 상호명으로 다시 말씀해 주세요" 라는 안내가 거짓말이 된다 —
    // 무엇을 다시 말해도 이름이 같은 한 결과가 똑같아서, 사용자가 같은 응답을 무한히 받는다
    // (Important 1). 그 경우에만 이름이 같다는 사실 자체를 밝히고 ID·주소로 안내를 좁힌다.
    const allSameName = found.every((p) => p.name === found[0].name);
    const lead = allSameName
      ? `「${name}」 이라는 이름의 가게가 ${found.length}곳이라 이름만으로는 구분할 수 없어요. ID나 주소로 다시 말씀해 주세요:`
      : `여러 곳이 걸려서 기록하지 않았어요. 정확한 상호명이나 ID로 다시 말씀해 주세요:`;
    return { ok: false, content: `${lead}\n${list}` };
  }

  return recordAndReport(ctx, found[0], args.liked);
}
