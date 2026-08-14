import type { LunchConfig } from "../config.js";
import type { LunchRepo, PlaceRow } from "../store/lunchRepo.js";
import { searchNearby, KakaoUserError, type KakaoPlace } from "../lunch/kakao.js";
import { scoreCandidates, type Candidate, type History } from "../lunch/score.js";
import { deriveCuisine } from "../lunch/cuisine.js";

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

// M2(최종 리뷰) — upsertPlaces 실패를 searchNearby(카카오 호출) 실패와 구분해서 던지는 표시.
// 예전엔 upsertPlaces 가 searchNearby 와 같은 try 안에 있어서, Postgres 오류(연결 끊김 등)가
// failMessage 를 거쳐 "지도 API 를 부르는 중 문제가 생겼어요"로 나가고 콘솔에도 "카카오 검색
// 실패"로 남았다 — 카카오는 멀쩡한데 DB 가 잠깐 흔들린 것뿐인데 소유자가 애먼 카카오 키를
// 의심하게 된다(deploy/smoke-test.md 의 "키가 틀리면 인증 문제라고 알려주는가" 항목이 바로
// 이 오인 유형을 겨냥한다). cause 는 콘솔에만 남기고 사용자에게는 절대 노출하지 않는다 —
// Postgres 오류 원문이 그대로 실릴 수 있어서다(KakaoUserError 를 따로 둔 것과 같은 이유).
class LunchDbError extends Error {
  constructor(public readonly cause: unknown) { super("lunch db error"); }
}

// 검색은 항상 저장을 동반한다 — 저장하지 않으면 방문 기록이 참조할 대상이 없다(설계 §4).
async function searchAndStore(ctx: LunchCtx, query: string): Promise<KakaoPlace[]> {
  const places = await searchNearby({ config: ctx.config, query, fetchImpl: ctx.fetchImpl });
  // places 가 비어 있으면 리포가 루프를 그냥 안 돈다 — 여기서 다시 길이를 확인할 이유가 없다.
  // M2: 이 호출만 따로 감싸 실패를 LunchDbError 로 다시 던진다 — 위 searchNearby 가 던지는
  // 오류(KakaoUserError·fetch 실패)와 절대 같은 갈래로 섞이면 안 된다.
  try {
    await ctx.repo.upsertPlaces(places, ctx.now());
  } catch (err) {
    throw new LunchDbError(err);
  }
  return places;
}

// kakao.ts 가 스스로 던지는 오류(KakaoUserError — 401/403 안내, 타임아웃)는 이미 한국어
// 존댓말로 다듬어져 있어 그대로 보여줘도 된다는 표시다 — 그 타입만 감싸지 않고 그대로
// 통과시킨다. 예전엔 이 구분 없이 모든 오류를 "카카오 지도 API 호출 중 문제가 생겼어요:
// ${detail}" 로 한 번 더 감쌌는데, 그러면 KakaoUserError 의 이미 한국어인 문장 앞에 "문제가
// 생겼어요" 가 덧붙어 스스로 모순되는 문장이 되고(예: "문제가 생겼어요: …인증에
// 실패했어요"), 그 밖의 오류(fetch 자체 실패 — DNS·ECONNREFUSED·Railway 네트워크 순단, 또는
// 카카오나 그 앞단 프록시가 200 과 함께 HTML 을 돌려줘 res.json() 파싱이 깨지는 경우)는
// 영어 원문이나 제3자 응답 본문 조각이 ${detail} 로 그대로 사용자에게 노출됐다(Item 1,
// 리뷰: "<html>Acce" 같은 카카오/프록시 응답 조각이 실제로 샜다). 이제 그 경우엔 detail 을
// 아예 쓰지 않고 고정 문구 하나로 감싼다 — 상태 코드·타임아웃처럼 사람이 실제로 쓸 수 있는
// 정보는 KakaoUserError 의 메시지 안에만 있고, 그 밖의 원문은 사용자에게 줄 유용한 정보가
// 없으므로 버려도 손해가 없다. 진단용 원문은 여전히 콘솔에 남긴다 — tools.ts 의 이웃
// 핸들러들(allowDirHandler 등, :224·:244·:259·:284)과 recallHandler(tools.ts:130)의 선례와
// 같은 방식이다. 카카오 키는 이 경로 어디에도 섞이지 않는다 — KakaoUserError 의 메시지는
// kakao.ts 가 직접 조립해 키를 담지 않고(lunchKakao.test.ts), 그 밖의 오류는 detail 자체를
// 쓰지 않으므로 응답 본문에 키가 섞여 왔다 해도 사용자에게는 전달될 길이 없다.
function failMessage(err: unknown): string {
  // M2: LunchDbError 는 searchNearby(카카오 호출)가 아니라 그 뒤의 upsertPlaces(DB 저장)가
  // 던진 것이다 — 아래 "카카오 검색 실패" 로그·문구로 섞이면 정확히 M2 가 잡은 오인이
  // 재발한다. dbFailMessage 로 위임해 이 파일의 모든 DB 실패가 한 곳(그 함수)에서만 문구·
  // 로그 태그를 관리하게 한다(M3, 아래).
  if (err instanceof LunchDbError) return dbFailMessage(err.cause);
  console.error("[lunch] 카카오 검색 실패:", err);
  if (err instanceof KakaoUserError) return err.message; // 이미 안전한 한국어 문장 — 감싸지 않는다.
  return "지도 API 를 부르는 중 문제가 생겼어요. 잠시 뒤에 다시 시도해 주세요.";
}

// M3(최종 리뷰) — historyOf·recentCuisines·recordVisit·findPlaceById·findPlacesByName 은
// 이 파일에서 어떤 try 로도 감싸지 않은 채 호출되고 있었다. MCP SDK 는 핸들러가 밖으로 던진
// 오류를 그대로 {isError:true, text: err.message} 로 사용자에게 돌려주므로(tools.ts 의
// recallHandler·forgetHandler 와 같은 경로), 감싸지 않으면 raw Postgres 오류 문자열(예:
// "getaddrinfo ENOTFOUND db.<ref>.supabase.co")이 그대로 소유자에게 간다. recall·forget 이
// 이미 그렇게 동작하고 있어 이것 자체는 새 회귀가 아니지만, 이 파일은 M2 로 검색 경로의 DB
// 오류를 이미 안전하게 감쌌다 — 같은 파일 안에서 어떤 DB 호출은 안전하고 어떤 것은 아닌
// 비대칭을 남기지 않는다. 아래 모든 repo 호출이 이 함수 하나로 실패를 안전한 문구로 바꾼다 —
// LunchDbError 의 cause 로깅과 문구를 여기 한 곳에만 둬서, 나중에 문구를 바꿀 때 두 곳을
// 따로 고치다 어긋나는 일이 없게 한다.
function dbFailMessage(err: unknown): string {
  console.error("[lunch] DB 처리 실패:", err);
  return "저장된 정보를 처리하는 중 문제가 생겼어요. 잠시 뒤에 다시 시도해 주세요.";
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

  // M3: historyOf·recentCuisines 는 둘 다 repo(DB) 호출이다 — 위 searchAndStore 의 카카오
  // 실패와 다시 섞이지 않도록 별도 try 로 감싸 dbFailMessage 로 안내한다.
  let history: Map<string, History>;
  let recentCuisines: string[];
  try {
    history = await ctx.repo.historyOf(ctx.userId);
    recentCuisines = await ctx.repo.recentCuisines(ctx.userId, ctx.now() - RECENT_WINDOW_MS);
  } catch (err) {
    return { ok: false, content: dbFailMessage(err) };
  }

  // 최종 리뷰 Critical — cuisine 은 category_name 에서 뽑은 세부 분류다(cuisine.ts 의
  // deriveCuisine). categoryGroup(category_group_name)은 "음식점" 같은 18개 고정 라벨 중
  // 하나라 검색 결과 전부가 같은 값을 가지므로 다시는 여기에 싣지 않는다 — recentCuisines
  // (위, store/lunchRepo.ts)도 반드시 같은 deriveCuisine 을 거쳐야 두 값이 비교 가능하다.
  const candidates: Candidate[] = places.map((p) => {
    const cuisine = deriveCuisine(p);
    return {
      placeId: p.placeId,
      name: p.name,
      ...(cuisine ? { cuisine } : {}),
      ...(p.distanceM === undefined ? {} : { distanceM: p.distanceM }),
    };
  });

  const top = scoreCandidates(candidates, history, { nowMs: ctx.now(), recentCuisines })
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
  // M3: recordVisit 은 이 파일에서 어떤 try 로도 감싸지 않던 다섯 repo 호출 중 하나였다 —
  // 감싸지 않으면 raw Postgres 오류가 MCP 결과에 그대로 실려 나간다.
  try {
    await ctx.repo.recordVisit({
      userId: ctx.userId, placeId: place.placeId, ts: ctx.now(),
      ...(liked === undefined ? {} : { liked }),
    });
  } catch (err) {
    return { ok: false, content: dbFailMessage(err) };
  }
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
  // placeId 인자가 왔는지(정의됐는지)와 그 값이 공백뿐인지를 구분한다 — 공백뿐인 placeId 를
  // "인자를 아예 안 줬다"는 뜻의 "어느 가게인지 알려주세요" 로 답하면, 실제로는 placeId 를
  // 보냈다는 사실 자체가 사라진다(Item 6, 리뷰). 아래에서 place 로도 넘어가지 않도록 여기서
  // 바로 끝낸다.
  if (args.placeId !== undefined) {
    const placeId = args.placeId.trim();
    if (!placeId) return { ok: false, content: "ID가 비어 있어요. 정확한 place ID를 다시 알려주세요." };
    // M3: findPlaceById 도 감싸지 않은 다섯 repo 호출 중 하나였다.
    let place: PlaceRow | null;
    try {
      place = await ctx.repo.findPlaceById(placeId);
    } catch (err) {
      return { ok: false, content: dbFailMessage(err) };
    }
    if (!place) {
      return { ok: false, content: `ID ${placeId} 에 해당하는 가게를 찾지 못했어요. 다시 검색해서 확인해 주세요.` };
    }
    return recordAndReport(ctx, place, args.liked);
  }

  const name = args.place?.trim();
  if (!name) return { ok: false, content: "어느 가게인지 알려주세요." };

  // findPlacesByName 이 트림·대소문자 무시·상한을 이미 다 한다(store/lunchRepo.ts) — 그
  // 위에 같은 일을 다시 하지 않는다. M3: 이 호출도 감싸지 않은 다섯 repo 호출 중 하나였다.
  let found: PlaceRow[];
  try {
    found = await ctx.repo.findPlacesByName(name);
  } catch (err) {
    return { ok: false, content: dbFailMessage(err) };
  }

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
    // placeId 도 name 과 같은 제3자 데이터(카카오 문서의 id)다 — kakao.ts 의 str() 는 끝만
    // trim 하고 안쪽 개행은 그대로 둔다(Item 5, 리뷰). 여기를 안 감싸면 후보 하나가 두 줄로
    // 보여 "줄 수 = 후보 수" 전제가 깨진다. 막는 비용이 0 이라는 위 singleLine 주석의 논리가
    // placeId 에도 그대로 적용된다.
    const list = found
      .map((p) => `- (ID ${singleLine(p.placeId)}) ${singleLine(p.name)}${p.address ? ` · ${singleLine(p.address)}` : ""}`)
      .join("\n");
    // "정확한 상호명으로 다시 말씀해 주세요" 가 실행 가능하려면, 그 이름을 다시 말했을 때
    // 결과가 지금과 달라질 수 있어야 한다. 그런데 검색 자체가 부분 문자열 일치라서
    // (store/lunchRepo.ts 의 findPlacesByName), 한 후보의 이름이 다른 후보 이름의 부분
    // 문자열이면(예: "김밥천국"/"김밥천국 인천점") 짧은 쪽을 매칭시키는 어떤 검색어도 반드시
    // 긴 쪽까지 함께 매칭시킨다 — 무엇을 다시 말해도 같은 목록이 반복된다(Item 4, 리뷰).
    // 완전히 같은 이름(체인 지점처럼)은 이 조건의 특수한 경우다 — 문자열은 언제나 자기
    // 자신의 부분 문자열이다. 그래서 "전부 같다"보다 넓은 "부분 문자열 관계인 쌍이 있다"
    // 하나로 두 경우를 함께 잡는다. 대소문자는 검색 자체가 가리지 않으므로(strpos(lower(...)))
    // 여기서도 접어야 한다 — 안 그러면 "CU 학교점"/"cu 학교점"처럼 검색으로는 절대 못 가르는
    // 쌍을 두고 "다시 말씀해 주세요" 라는 같은 거짓 안내를 하게 된다.
    const nameCannotDisambiguate = found.some((p, i) =>
      found.some((q, j) => i !== j && q.name.toLowerCase().includes(p.name.toLowerCase())),
    );
    const lead = nameCannotDisambiguate
      ? `「${name}」 이라는 이름만으로는 ${found.length}곳을 구분할 수 없어요. ID나 주소로 다시 말씀해 주세요:`
      : `여러 곳이 걸려서 기록하지 않았어요. 정확한 상호명이나 ID로 다시 말씀해 주세요:`;
    return { ok: false, content: `${lead}\n${list}` };
  }

  return recordAndReport(ctx, found[0], args.liked);
}
