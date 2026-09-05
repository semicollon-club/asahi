import { githubGet, type FetchLike } from "./appToken.js";

// PR 하나에 달린 피드백 — 리뷰(승인·변경 요청)·코드 코멘트(diff 의 줄에 단 것)·대화 코멘트(PR
// 하단의 일반 코멘트) — 를 한 번에 읽는다(2026-09-05, 2단계). 부원이 "리뷰 반영해줘" 라고 하면
// 봇이 이걸로 내용을 읽고 같은 브랜치에 고쳐 push 한다(core/tools.ts 의 prReviewCommentsHandler,
// persona.ts 의 표준 절차 "리뷰 반영"). 이 도구가 생기기 전에는 운영자가 깃허브에 단 코멘트를
// 부원이 디스코드로 손으로 옮겨 적어야 했다.
//
// 토큰은 호출측이 그 리포 하나·pull_requests:read 로 발급한다. 대화 코멘트만 issues API 를 거치는데
// (깃허브는 PR 을 이슈의 일종으로 다룬다), 그 엔드포인트의 권한 요건이 App 설정에 따라 다를 수 있어
// 못 읽으면 null 로 표시하고 나머지는 그대로 준다 — 하나 때문에 리뷰 전체를 못 보여주면 안 된다.
export type PrFeedback = {
  pr: {
    number: number; title: string; state: "open" | "closed"; merged: boolean; url: string;
    head: string; base: string; headSha: string;
  };
  reviews: Array<{ author: string; state: string; body: string; submittedAt: string }>;
  reviewComments: Array<{ author: string; path: string; line: number | null; body: string; createdAt: string }>;
  // null = 못 읽었다(권한 등). 빈 배열과 구분해야 포맷터가 "없다"와 "못 봤다"를 다르게 말한다.
  issueComments: Array<{ author: string; body: string; createdAt: string }> | null;
};

type RawUser = { login: string } | null | undefined;
type RawPr = {
  number: number; title: string; state: string; merged: boolean; html_url: string;
  head: { ref: string; sha: string }; base: { ref: string };
};
type RawReview = { user: RawUser; state: string; body: string | null; submitted_at: string | null };
type RawReviewComment = {
  user: RawUser; path: string; line: number | null; original_line: number | null; body: string; created_at: string;
};
type RawIssueComment = { user: RawUser; body: string | null; created_at: string };

const login = (u: RawUser): string => u?.login ?? "(알 수 없음)";

export async function fetchPrFeedback(o: {
  org: string; repo: string; number: number; token: string; fetchImpl?: FetchLike;
}): Promise<PrFeedback> {
  const base = `https://api.github.com/repos/${o.org}/${o.repo}`;
  const get = <T>(path: string) => githubGet<T>({ token: o.token, url: `${base}${path}`, fetchImpl: o.fetchImpl });

  const pr = await get<RawPr>(`/pulls/${o.number}`);
  if (!pr.ok) throw new Error(`PR #${o.number} 을 읽지 못했어요: ${pr.message}`);
  const reviews = await get<RawReview[]>(`/pulls/${o.number}/reviews`);
  if (!reviews.ok) throw new Error(`PR #${o.number} 의 리뷰를 읽지 못했어요: ${reviews.message}`);
  const comments = await get<RawReviewComment[]>(`/pulls/${o.number}/comments`);
  if (!comments.ok) throw new Error(`PR #${o.number} 의 코드 코멘트를 읽지 못했어요: ${comments.message}`);
  const issue = await get<RawIssueComment[]>(`/issues/${o.number}/comments`);

  return {
    pr: {
      number: pr.body.number, title: pr.body.title, state: pr.body.state === "closed" ? "closed" : "open",
      merged: pr.body.merged === true, url: pr.body.html_url, head: pr.body.head.ref, base: pr.body.base.ref,
      headSha: pr.body.head.sha,
    },
    // 본문이 빈 COMMENTED 리뷰는 코드 코멘트만 단 리뷰의 껍데기라 잡음이다 — 코드 코멘트 자체는
    // 아래 reviewComments 로 따로 온다. 본문이 빈 승인·변경 요청은 그 자체가 결정이라 남긴다.
    reviews: reviews.body
      .filter((r) => !(r.state === "COMMENTED" && (r.body ?? "").trim().length === 0))
      .map((r) => ({ author: login(r.user), state: r.state, body: (r.body ?? "").trim(), submittedAt: r.submitted_at ?? "" })),
    reviewComments: comments.body.map((c) => ({
      author: login(c.user), path: c.path, line: c.line ?? c.original_line ?? null, body: c.body, createdAt: c.created_at,
    })),
    issueComments: issue.ok
      ? issue.body.map((c) => ({ author: login(c.user), body: c.body ?? "", createdAt: c.created_at }))
      : null,
  };
}

// 코멘트 본문 하나의 표시 상한과 전체 상한. 모델 컨텍스트와 디스코드 메시지 양쪽을 위한 값이다 —
// 리뷰 하나에 파일 전체를 붙여 넣는 사람이 있으면 그 한 건이 나머지를 밀어낸다.
export const PR_FEEDBACK_BODY_MAX = 500;
export const PR_FEEDBACK_TOTAL_MAX = 6000;

// KST 는 UTC+9 고정이고 서머타임이 없다(core/digest.ts 와 같은 산술).
const KST_OFFSET_MS = 9 * 60 * 60 * 1000;
function kst(iso: string): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "시각 모름";
  const s = new Date(t + KST_OFFSET_MS).toISOString();
  return `${s.slice(0, 10)} ${s.slice(11, 16)}`;
}

const REVIEW_STATE_KO: Record<string, string> = {
  APPROVED: "승인", CHANGES_REQUESTED: "변경 요청", COMMENTED: "코멘트", DISMISSED: "철회됨", PENDING: "작성 중",
};

// 코드포인트로 자른다(slice 는 UTF-16 코드유닛 기준이라 이모지가 경계에 걸리면 쪼개진다).
// 여러 줄 본문은 둘째 줄부터 들여 써서 항목 경계가 보이게 한다.
function clip(body: string): string {
  const chars = [...body.trim()];
  const cut = chars.length > PR_FEEDBACK_BODY_MAX ? `${chars.slice(0, PR_FEEDBACK_BODY_MAX).join("")}…` : chars.join("");
  return cut.replace(/\r?\n/g, "\n  ");
}

export function formatPrFeedback(f: PrFeedback): string {
  const status = f.pr.state === "open" ? "열림" : f.pr.merged ? "병합됨" : "닫힘";
  const head = [`PR #${f.pr.number} 「${f.pr.title}」 — ${status} (${f.pr.head} → ${f.pr.base})`, f.pr.url];
  const notes = f.issueComments === null
    ? ["※ 대화 코멘트는 App 권한이 없어 못 읽었어요 — 깃허브에서 직접 확인해 주세요."]
    : [];

  const items: Array<{ ts: number; text: string }> = [];
  const at = (iso: string) => Date.parse(iso) || 0;
  for (const r of f.reviews) {
    const body = r.body.length > 0 ? `\n  ${clip(r.body)}` : "";
    items.push({ ts: at(r.submittedAt), text: `[리뷰] ${r.author} — ${REVIEW_STATE_KO[r.state] ?? r.state} (${kst(r.submittedAt)})${body}` });
  }
  for (const c of f.reviewComments) {
    const where = c.line === null ? c.path : `${c.path}:${c.line}`;
    items.push({ ts: at(c.createdAt), text: `[코드] ${c.author} — ${where} (${kst(c.createdAt)})\n  ${clip(c.body)}` });
  }
  for (const c of f.issueComments ?? []) {
    items.push({ ts: at(c.createdAt), text: `[대화] ${c.author} (${kst(c.createdAt)})\n  ${clip(c.body)}` });
  }
  if (items.length === 0) return [...head, "아직 리뷰나 코멘트가 없어요.", ...notes].join("\n");

  items.sort((a, b) => a.ts - b.ts);
  const approved = f.reviews.filter((r) => r.state === "APPROVED").length;
  const changes = f.reviews.filter((r) => r.state === "CHANGES_REQUESTED").length;
  const summary = `리뷰: 변경 요청 ${changes} · 승인 ${approved} · 코멘트 ${f.reviewComments.length + (f.issueComments?.length ?? 0)}`;

  // 전체 상한은 항목 단위로 지킨다 — 문자열 중간을 자르면 어느 코멘트가 잘렸는지 알 수 없다.
  const out = [...head, summary, "", ...notes];
  let used = out.join("\n").length;
  let dropped = 0;
  for (const item of items) {
    if (used + item.text.length + 1 > PR_FEEDBACK_TOTAL_MAX) { dropped++; continue; }
    out.push(item.text);
    used += item.text.length + 1;
  }
  if (dropped > 0) out.push(`(코멘트 ${dropped}개는 길어서 생략했어요 — 깃허브에서 전체를 보세요)`);
  return out.join("\n");
}
