import crypto from "node:crypto";

export type GithubAppConfig = {
  appId: string;
  installationId: string;
  org: string;
  privateKeyPem: string;
};

export type FetchLike = typeof fetch;

const b64url = (b: Buffer): string => b.toString("base64url");

// App JWT. iss 는 App ID, 서명은 RS256. iat 를 60초 앞당기는 것은 GitHub 권고다 — 이쪽 시계가
// 조금 빠르면 "미래에 발급된 토큰"으로 거부된다. exp 는 GitHub 상한이 10분이라 9분으로 둔다.
export function buildAppJwt(o: { appId: string; privateKeyPem: string; nowMs: number }): string {
  const now = Math.floor(o.nowMs / 1000);
  const header = b64url(Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })));
  const payload = b64url(Buffer.from(JSON.stringify({ iat: now - 60, exp: now + 540, iss: o.appId })));
  const sig = b64url(crypto.sign("RSA-SHA256", Buffer.from(`${header}.${payload}`), o.privateKeyPem));
  return `${header}.${payload}.${sig}`;
}

// 오류 메시지에 자격증명이 섞이지 않게 한다 — 진단 로그가 곧 유출 경로가 되면 안 된다.
// 응답 본문의 message 만 뽑고, 그것도 없으면 상태 코드만 남긴다.
async function messageOf(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as Record<string, unknown>;
    const m = body?.message;
    return typeof m === "string" ? m : `HTTP ${res.status}`;
  } catch {
    return `HTTP ${res.status}`;
  }
}

function headers(auth: string, hasBody: boolean): Record<string, string> {
  return {
    accept: "application/vnd.github+json",
    authorization: `Bearer ${auth}`,
    "x-github-api-version": "2022-11-28",
    ...(hasBody ? { "content-type": "application/json" } : {}),
  };
}

// 리뷰 지적(Important): mintInstallationToken·createOrgRepo 의 fetch 에 타임아웃이 없으면
// 깃허브 API 가 멈췄을 때(장애·레이트리밋 지연 등) 호출이 무한정 매달리고, 리포 발행 흐름
// 전체가 그 한 호출에 묶인다. executors.ts 의 file_fetch, core/images.ts 의 downloadImages 가
// 이미 같은 문제(외부 HTTP 호출 무제한 대기)를 10초 AbortController 로 풀어 뒀으므로 값과
// 방식을 그대로 맞춘다 — 세 곳이 다른 타임아웃을 쓰면 왜 다른지 설명할 이유가 없다.
const GITHUB_FETCH_TIMEOUT_MS = 10_000;

// mintInstallationToken·createOrgRepo 가 공유하는 "타임아웃 있는 fetch" 한 겹(headers·messageOf
// 와 같은 이유로 두 곳이 나눠 쓴다 — 로직이 갈라지면 한쪽만 고쳐질 위험이 생긴다). 타이머 해제를
// finally 로 강제하는 이유는 file_fetch·downloadImages 와 같다 — 응답이 타임아웃 전에 와도
// 타이머를 지우지 않으면 그 타이머가 이벤트 루프에 남아 프로세스 종료를 늦춘다.
//
// abort 로 인한 실패만 알아볼 수 있는 한국어 문장으로 바꾼다 — 그러지 않으면 AbortError 가
// (raw DOMException 그대로, 영문 이름으로) 호출자에게 던져지고 회원에게는 원인 모를 오류로
// 보인다. 그 외의 fetch 실패(DNS 실패·연결 거부 등)는 이 함수가 임의로 재해석하지 않고 원래
// 오류를 그대로 던진다 — 이 결함이 다루는 범위는 "타임아웃이 없다"이지 "모든 네트워크 오류
// 메시지를 통일한다"가 아니다.
async function fetchWithTimeout(fetchImpl: FetchLike, url: string, init: RequestInit): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), GITHUB_FETCH_TIMEOUT_MS);
  try {
    return await fetchImpl(url, { ...init, signal: ctrl.signal });
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      throw new Error(
        `깃허브 API 응답이 ${GITHUB_FETCH_TIMEOUT_MS / 1000}초 안에 오지 않아 요청을 중단했어요. 네트워크 상태를 확인한 뒤 다시 시도해 주세요.`,
      );
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

// 요청마다 새로 발급한다. 캐시하지 않는다 — 만료를 관리하는 상태가 생기는 순간 그 상태가
// 틀렸을 때의 실패 모드가 따라오고, 발급 자체는 왕복 한 번이라 아낄 이유가 없다(설계 §3.1).
export async function mintInstallationToken(o: {
  config: GithubAppConfig;
  repoNames: string[];
  permissions: Record<string, string>;
  nowMs: number;
  fetchImpl?: FetchLike;
}): Promise<{ token: string; expiresAt: string }> {
  const jwt = buildAppJwt({ appId: o.config.appId, privateKeyPem: o.config.privateKeyPem, nowMs: o.nowMs });
  const res = await fetchWithTimeout(
    o.fetchImpl ?? fetch,
    `https://api.github.com/app/installations/${o.config.installationId}/access_tokens`,
    {
      method: "POST",
      headers: headers(jwt, true),
      body: JSON.stringify({ repositories: o.repoNames, permissions: o.permissions }),
    },
  );
  if (res.status !== 201) throw new Error(`깃허브 토큰을 발급하지 못했어요: ${await messageOf(res)}`);
  const body = (await res.json()) as { token: string; expires_at: string };
  return { token: body.token, expiresAt: body.expires_at };
}

// 조직 리포만 만든다. 개인 계정(POST /user/repos)은 설치 토큰으로 부를 수 없다(설계 §4.1, 실측).
export async function createOrgRepo(o: {
  config: GithubAppConfig;
  token: string;
  repoName: string;
  fetchImpl?: FetchLike;
}): Promise<{ cloneUrl: string }> {
  const res = await fetchWithTimeout(o.fetchImpl ?? fetch, `https://api.github.com/orgs/${o.config.org}/repos`, {
    method: "POST",
    headers: headers(o.token, true),
    body: JSON.stringify({ name: o.repoName, private: true, auto_init: false }),
  });
  if (res.status !== 201) throw new Error(`리포를 만들지 못했어요: ${await messageOf(res)}`);
  const body = (await res.json()) as { clone_url: string };
  return { cloneUrl: body.clone_url };
}

// PR 생성. 부원이 sh_exec 의 git 으로 브랜치를 올린 뒤 main 에 PR 을 내는 마지막 조각이다 — git 만으로는
// PR 을 만들 수 없어 봇이 REST 로 만든다. 토큰은 호출측이 그 리포·pull_requests:write 로 좁혀 발급한다
// (core/tools.ts 의 createPullRequestHandler). App 에 Pull requests: Read and write 권한이 있어야
// 발급이 된다(deploy/github-app-셋업.md).
export async function createPullRequest(o: {
  config: GithubAppConfig;
  token: string;
  repoName: string;
  head: string;
  base: string;
  title: string;
  body?: string;
  fetchImpl?: FetchLike;
}): Promise<{ url: string; number: number }> {
  const res = await fetchWithTimeout(
    o.fetchImpl ?? fetch,
    `https://api.github.com/repos/${o.config.org}/${o.repoName}/pulls`,
    {
      method: "POST",
      headers: headers(o.token, true),
      body: JSON.stringify({ title: o.title, head: o.head, base: o.base, body: o.body ?? "" }),
    },
  );
  if (res.status !== 201) throw new Error(`PR 을 만들지 못했어요: ${await messageOf(res)}`);
  const body = (await res.json()) as { html_url: string; number: number };
  return { url: body.html_url, number: body.number };
}

// GET 한 번(2026-09-05, 2단계 — github/repos.ts·github/pulls.ts 가 쓴다). 성공이면 본문(JSON)을,
// 실패면 상태 코드와 깃허브의 message 를 돌려준다 — 던지지 않는다. 호출측이 상태별로 다르게
// 다뤄야 해서다(예: PR 의 대화 코멘트를 403 으로 못 읽으면 "없는 정보"로 두고 나머지는 보여준다).
// 네트워크 실패·타임아웃은 fetchWithTimeout 이 던지는 그대로 올라간다 — 그건 "깃허브가 거절했다"가
// 아니라 "닿지 못했다"라 같은 갈래가 아니다. 헤더·타임아웃·message 추출은 위 함수들과 같은 것을
// 쓴다 — 로직이 갈라지면 한쪽만 고쳐지는 날이 온다.
export type GithubGetResult<T> = { ok: true; body: T } | { ok: false; status: number; message: string };

export async function githubGet<T>(o: { token: string; url: string; fetchImpl?: FetchLike }): Promise<GithubGetResult<T>> {
  const res = await fetchWithTimeout(o.fetchImpl ?? fetch, o.url, { method: "GET", headers: headers(o.token, false) });
  if (res.status < 200 || res.status >= 300) return { ok: false, status: res.status, message: await messageOf(res) };
  return { ok: true, body: (await res.json()) as T };
}
