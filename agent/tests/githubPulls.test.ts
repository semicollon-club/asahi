import { describe, it, expect } from "vitest";
import {
  fetchPrFeedback, formatPrFeedback, PR_FEEDBACK_BODY_MAX, type PrFeedback,
  fetchPullRequestSnapshot, fetchWorkflowRuns, aggregateCi, failedRuns, CI_NONE_AFTER_MS, type WorkflowRun,
} from "../src/github/pulls.js";

const ORG = "semicollon-club";
const PR = {
  number: 7, title: "로그인 페이지", state: "open", merged: false,
  html_url: `https://github.com/${ORG}/homepage/pull/7`,
  head: { ref: "feat/login", sha: "abc1234def" }, base: { ref: "main" },
  user: { login: "asahi-publisher[bot]" },
};
const REVIEWS = [
  { user: { login: "wwoosshh" }, state: "CHANGES_REQUESTED", body: "에러 처리가 빠졌어요.", submitted_at: "2026-09-05T05:00:00Z" },
  { user: { login: "wwoosshh" }, state: "COMMENTED", body: "", submitted_at: "2026-09-05T05:01:00Z" },
];
const REVIEW_COMMENTS = [
  { id: 11, user: { login: "wwoosshh" }, path: "src/login.ts", line: 42, original_line: 42, body: "여기 null 체크가 필요합니다.", created_at: "2026-09-05T05:01:00Z", in_reply_to_id: null },
];
const ISSUE_COMMENTS = [
  { user: { login: "member" }, body: "테스트도 추가해 주세요.", created_at: "2026-09-05T05:05:00Z" },
];

// PR 관련 네 엔드포인트를 URL 꼬리로 갈라 흉내 낸다. 무엇을 어떤 헤더로 불렀는지 기록한다.
function fakeGithub(o: { prStatus?: number; issueCommentsStatus?: number } = {}) {
  const seen: Array<{ url: string; auth: string }> = [];
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  const fetchImpl = (async (url: string, init: RequestInit) => {
    const u = String(url);
    seen.push({ url: u, auth: String((init.headers as Record<string, string>).authorization) });
    if (u.endsWith("/pulls/7")) return o.prStatus && o.prStatus !== 200 ? json({ message: "Not Found" }, o.prStatus) : json(PR);
    if (u.endsWith("/pulls/7/reviews")) return json(REVIEWS);
    if (u.endsWith("/pulls/7/comments")) return json(REVIEW_COMMENTS);
    if (u.endsWith("/issues/7/comments")) {
      return o.issueCommentsStatus && o.issueCommentsStatus !== 200
        ? json({ message: "Resource not accessible by integration" }, o.issueCommentsStatus)
        : json(ISSUE_COMMENTS);
    }
    return json({ message: `unexpected ${u}` }, 500);
  }) as unknown as typeof fetch;
  return { seen, fetchImpl };
}

describe("fetchPrFeedback", () => {
  it("PR·리뷰·코드 코멘트·대화 코멘트를 그 리포·번호로 읽어 하나로 묶는다", async () => {
    const { seen, fetchImpl } = fakeGithub();
    const f = await fetchPrFeedback({ org: ORG, repo: "homepage", number: 7, token: "ghs_read", fetchImpl });
    expect(seen.map((s) => s.url)).toEqual([
      `https://api.github.com/repos/${ORG}/homepage/pulls/7`,
      `https://api.github.com/repos/${ORG}/homepage/pulls/7/reviews`,
      `https://api.github.com/repos/${ORG}/homepage/pulls/7/comments`,
      `https://api.github.com/repos/${ORG}/homepage/issues/7/comments`,
    ]);
    expect(seen.every((s) => s.auth === "Bearer ghs_read")).toBe(true);
    expect(f.pr).toEqual({
      number: 7, title: "로그인 페이지", state: "open", merged: false, url: PR.html_url,
      head: "feat/login", base: "main", headSha: "abc1234def",
    });
    // 본문이 빈 리뷰(코드 코멘트만 단 리뷰의 껍데기)는 이벤트가 아니라 잡음이라 뺀다.
    expect(f.reviews).toEqual([
      { author: "wwoosshh", state: "CHANGES_REQUESTED", body: "에러 처리가 빠졌어요.", submittedAt: "2026-09-05T05:00:00Z" },
    ]);
    expect(f.reviewComments).toEqual([
      { author: "wwoosshh", path: "src/login.ts", line: 42, body: "여기 null 체크가 필요합니다.", createdAt: "2026-09-05T05:01:00Z" },
    ]);
    expect(f.issueComments).toEqual([
      { author: "member", body: "테스트도 추가해 주세요.", createdAt: "2026-09-05T05:05:00Z" },
    ]);
  });

  it("PR 자체를 못 읽으면 번호를 담아 던진다", async () => {
    const { fetchImpl } = fakeGithub({ prStatus: 404 });
    await expect(fetchPrFeedback({ org: ORG, repo: "homepage", number: 7, token: "t", fetchImpl })).rejects.toThrow(/#7/);
  });

  // 대화 코멘트(issues API)는 App 권한(Issues 또는 Pull requests 읽기)에 따라 막힐 수 있다 — 그
  // 하나 때문에 리뷰 전체를 못 보여주면 안 된다. null 로 표시해 포맷터가 "못 읽었다"고 말하게 한다.
  it("대화 코멘트를 권한 때문에 못 읽으면 null 로 표시하고 나머지는 그대로 준다", async () => {
    const { fetchImpl } = fakeGithub({ issueCommentsStatus: 403 });
    const f = await fetchPrFeedback({ org: ORG, repo: "homepage", number: 7, token: "t", fetchImpl });
    expect(f.issueComments).toBeNull();
    expect(f.reviews).toHaveLength(1);
    expect(f.reviewComments).toHaveLength(1);
  });
});

describe("formatPrFeedback", () => {
  const base: PrFeedback = {
    pr: { number: 7, title: "로그인 페이지", state: "open", merged: false, url: PR.html_url, head: "feat/login", base: "main", headSha: "abc1234def" },
    reviews: [], reviewComments: [], issueComments: [],
  };

  it("리뷰가 하나도 없으면 그렇다고 말한다", () => {
    const out = formatPrFeedback(base);
    expect(out).toContain("#7");
    expect(out).toContain("feat/login");
    expect(out).toContain("아직 리뷰나 코멘트가 없어요");
  });

  it("리뷰 상태·경로:줄·작성자·본문을 시간순으로 적는다", () => {
    const out = formatPrFeedback({
      ...base,
      reviews: [{ author: "wwoosshh", state: "CHANGES_REQUESTED", body: "에러 처리가 빠졌어요.", submittedAt: "2026-09-05T05:00:00Z" }],
      reviewComments: [{ author: "wwoosshh", path: "src/login.ts", line: 42, body: "여기 null 체크가 필요합니다.", createdAt: "2026-09-05T05:01:00Z" }],
      issueComments: [{ author: "member", body: "테스트도 추가해 주세요.", createdAt: "2026-09-05T04:59:00Z" }],
    });
    expect(out).toContain("변경 요청");
    expect(out).toContain("src/login.ts:42");
    expect(out).toContain("wwoosshh");
    expect(out).toContain("여기 null 체크가 필요합니다.");
    // 시간순 — 대화 코멘트(04:59)가 리뷰(05:00)보다 먼저 나온다.
    expect(out.indexOf("테스트도 추가해 주세요.")).toBeLessThan(out.indexOf("에러 처리가 빠졌어요."));
    // 시각은 KST 로 적는다 — 05:00Z 는 14:00 KST.
    expect(out).toContain("14:00");
  });

  it("병합·닫힘 상태를 그대로 말한다", () => {
    expect(formatPrFeedback({ ...base, pr: { ...base.pr, state: "closed", merged: true } })).toContain("병합됨");
    expect(formatPrFeedback({ ...base, pr: { ...base.pr, state: "closed", merged: false } })).toContain("닫힘");
  });

  it("긴 본문은 잘라 표시하고 잘렸음을 남긴다", () => {
    const long = "가".repeat(PR_FEEDBACK_BODY_MAX + 50);
    const out = formatPrFeedback({
      ...base,
      issueComments: [{ author: "member", body: long, createdAt: "2026-09-05T05:05:00Z" }],
    });
    expect(out).not.toContain(long);
    expect(out).toContain("…");
  });

  it("대화 코멘트를 못 읽었으면 그 사실을 한 줄로 남긴다", () => {
    const out = formatPrFeedback({ ...base, issueComments: null });
    expect(out).toContain("대화 코멘트");
    expect(out).toMatch(/못 읽|권한/);
  });
});

// ── PR 추적(B2) 이 쓰는 조각들 ──────────────────────────────────────────────
describe("fetchPullRequestSnapshot", () => {
  it("PR 하나의 상태·커밋만 읽는다(리뷰·코멘트는 부르지 않는다)", async () => {
    const { seen, fetchImpl } = fakeGithub();
    const s = await fetchPullRequestSnapshot({ org: ORG, repo: "homepage", number: 7, token: "t", fetchImpl });
    expect(seen.map((x) => x.url)).toEqual([`https://api.github.com/repos/${ORG}/homepage/pulls/7`]);
    expect(s).toEqual({
      number: 7, title: "로그인 페이지", state: "open", merged: false, url: PR.html_url,
      head: "feat/login", base: "main", headSha: "abc1234def",
    });
  });

  it("못 읽으면 번호를 담아 던진다", async () => {
    const { fetchImpl } = fakeGithub({ prStatus: 404 });
    await expect(fetchPullRequestSnapshot({ org: ORG, repo: "homepage", number: 7, token: "t", fetchImpl })).rejects.toThrow(/#7/);
  });
});

describe("fetchWorkflowRuns", () => {
  it("그 커밋(head_sha)의 워크플로 실행만 묻고 이름·상태·결론·링크로 좁힌다", async () => {
    let seenUrl = "";
    const fetchImpl = (async (url: string) => {
      seenUrl = String(url);
      return new Response(JSON.stringify({
        total_count: 1,
        workflow_runs: [{ name: "agent", status: "completed", conclusion: "success", html_url: "https://github.com/x/actions/runs/1", id: 1 }],
      }), { status: 200 });
    }) as unknown as typeof fetch;
    const runs = await fetchWorkflowRuns({ org: ORG, repo: "homepage", headSha: "abc1234def", token: "t", fetchImpl });
    expect(seenUrl.startsWith(`https://api.github.com/repos/${ORG}/homepage/actions/runs?`)).toBe(true);
    expect(seenUrl).toContain("head_sha=abc1234def");
    expect(runs).toEqual([{ name: "agent", status: "completed", conclusion: "success", url: "https://github.com/x/actions/runs/1" }]);
  });

  it("못 읽으면 던진다", async () => {
    const fetchImpl = (async () => new Response(JSON.stringify({ message: "Resource not accessible by integration" }), { status: 403 })) as unknown as typeof fetch;
    await expect(fetchWorkflowRuns({ org: ORG, repo: "homepage", headSha: "abc", token: "t", fetchImpl })).rejects.toThrow(/Resource not accessible/);
  });
});

describe("aggregateCi — 워크플로 실행 여러 개를 상태 하나로", () => {
  const run = (status: string, conclusion: string | null, name = "w"): WorkflowRun => ({ name, status, conclusion, url: "u" });

  it("실행이 아직 없으면 잠시는 대기, 시간이 지나면 CI 없음", () => {
    expect(aggregateCi([], { ageMs: 1_000 })).toBe("pending");
    expect(aggregateCi([], { ageMs: CI_NONE_AFTER_MS })).toBe("none");
  });

  it("하나라도 돌고 있으면 대기", () => {
    expect(aggregateCi([run("completed", "success"), run("in_progress", null)], { ageMs: 0 })).toBe("pending");
    expect(aggregateCi([run("queued", null)], { ageMs: 0 })).toBe("pending");
  });

  it("전부 끝났고 실패·취소·시간 초과가 하나라도 있으면 실패", () => {
    expect(aggregateCi([run("completed", "success"), run("completed", "failure")], { ageMs: 0 })).toBe("failure");
    expect(aggregateCi([run("completed", "cancelled")], { ageMs: 0 })).toBe("failure");
    expect(aggregateCi([run("completed", "timed_out")], { ageMs: 0 })).toBe("failure");
  });

  it("전부 성공·건너뜀·중립이면 성공", () => {
    expect(aggregateCi([run("completed", "success"), run("completed", "skipped"), run("completed", "neutral")], { ageMs: 0 })).toBe("success");
  });

  it("failedRuns 는 실패로 친 실행만 고른다", () => {
    const ok = run("completed", "success", "docs");
    const bad = run("completed", "failure", "agent");
    expect(failedRuns([ok, bad, run("in_progress", null, "x")])).toEqual([bad]);
  });
});
