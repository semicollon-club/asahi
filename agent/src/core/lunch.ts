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
  const places = await searchNearby({ config: ctx.config, query, fetchImpl: ctx.fetchImpl });
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

  // findPlacesByName 이 트림·대소문자 무시·상한을 이미 다 한다(store/lunchRepo.ts) — 그
  // 위에 같은 일을 다시 하지 않는다.
  const found = await ctx.repo.findPlacesByName(name);

  // 없는 가게를 새로 만들지 않는다. place_id 없는 행이 생기면 이 기능의 뼈대(안정적 식별자,
  // 설계 §2)가 그 순간 깨지고, 그 뒤의 방문 기록은 같은 가게를 못 알아본다.
  if (found.length === 0) {
    return { ok: false, content: `「${name}」 을 찾지 못했어요. 먼저 검색해서 목록에 올린 뒤에 기록할 수 있어요.` };
  }
  // 여러 개면 추측으로 하나를 고르지 않고 고르게 한다 — forget 이 같은 제목 여러 건에 대해
  // 하는 것과 같은 방식이다(설계 §6.1): 목록을 번호로 또렷하게 보여준다. 다만 forget 의
  // id 와 달리 이 번호는 되짚어 부를 인자가 없다(lunch_visit 은 이름만 받는다) — 그래서
  // "번호로 다시 지정하라"고 하지 않고 "정확한 상호명으로 다시 말해 달라"고 안내한다.
  if (found.length > 1) {
    const list = found.map((p, i) => `- (번호 ${i + 1}) ${p.name}`).join("\n");
    return { ok: false, content: `여러 곳이 걸려서 기록하지 않았어요. 정확한 상호명으로 다시 말씀해 주세요.\n${list}` };
  }

  const place = found[0];
  await ctx.repo.recordVisit({
    userId: ctx.userId, placeId: place.placeId, ts: ctx.now(),
    ...(args.liked === undefined ? {} : { liked: args.liked }),
  });
  const note = args.liked === true ? " 좋으셨다니 다음에 더 자주 추천할게요." : args.liked === false ? " 다음엔 덜 추천할게요." : "";
  return { ok: true, content: `${place.name} 방문을 기록했어요.${note}` };
}
