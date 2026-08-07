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
  const res = await (o.fetchImpl ?? fetch)(
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
  const res = await (o.fetchImpl ?? fetch)(`https://api.github.com/orgs/${o.config.org}/repos`, {
    method: "POST",
    headers: headers(o.token, true),
    body: JSON.stringify({ name: o.repoName, private: true, auto_init: false }),
  });
  if (res.status !== 201) throw new Error(`리포를 만들지 못했어요: ${await messageOf(res)}`);
  const body = (await res.json()) as { clone_url: string };
  return { cloneUrl: body.clone_url };
}
