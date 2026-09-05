import { describe, it, expect } from "vitest";
import crypto from "node:crypto";
import { buildAppJwt, mintInstallationToken, createOrgRepo, createPullRequest } from "../src/github/appToken.js";

// 실제 키를 리포에 두지 않는다 — 테스트마다 생성한다(2048비트도 vitest 에서 충분히 빠르다).
const { privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
const privateKeyPem = privateKey.export({ type: "pkcs1", format: "pem" }).toString();

const config = { appId: "4514057", installationId: "151876954", org: "semicollon-club", privateKeyPem };

describe("buildAppJwt", () => {
  it("세 조각으로 나뉘고 헤더가 RS256 이다", () => {
    const jwt = buildAppJwt({ appId: "4514057", privateKeyPem, nowMs: 1_700_000_000_000 });
    const parts = jwt.split(".");
    expect(parts.length).toBe(3);
    expect(JSON.parse(Buffer.from(parts[0], "base64url").toString())).toEqual({ alg: "RS256", typ: "JWT" });
  });

  // iat 를 60초 앞당기는 것은 GitHub 권고다 — 이쪽 시계가 조금 빠르면 "미래에 발급된 토큰"으로
  // 거부된다. 이 값이 사라지면 시계가 맞는 기계에서는 멀쩡히 돌아 회귀를 알아채기 어렵다.
  it("iat 를 60초 앞당기고 exp 를 10분 안으로 둔다", () => {
    const nowMs = 1_700_000_000_000;
    const nowSec = Math.floor(nowMs / 1000);
    const payload = JSON.parse(
      Buffer.from(buildAppJwt({ appId: "4514057", privateKeyPem, nowMs }).split(".")[1], "base64url").toString(),
    );
    expect(payload.iat).toBe(nowSec - 60);
    expect(payload.iss).toBe("4514057");
    expect(payload.exp - nowSec).toBeLessThanOrEqual(600);
    expect(payload.exp).toBeGreaterThan(nowSec);
  });

  it("서명이 그 공개키로 검증된다", () => {
    const jwt = buildAppJwt({ appId: "4514057", privateKeyPem, nowMs: 1_700_000_000_000 });
    const [h, p, s] = jwt.split(".");
    expect(crypto.verify("RSA-SHA256", Buffer.from(`${h}.${p}`), privateKey, Buffer.from(s, "base64url"))).toBe(true);
  });

  // Finding 2(Minor, 리뷰): crypto.sign 이 손상된 PEM 에 던지는 OpenSSL 오류
  // (실측: `error:1E08010C:DECODER routines::unsupported`)는 오늘은 키 원문을 담지 않는다 —
  // 그런데 그건 Node/OpenSSL 자체 동작일 뿐, 이 리포의 어떤 테스트도 그 경로를 직접 태워
  // 확인한 적이 없었다. 나중에 누군가 "어떤 키로 실패했는지 보여주면 디버깅이 편하겠다"며
  // 오류 메시지에 PEM 원문을 보간하도록 "개선"해도, 그 회귀를 잡을 테스트가 없으면 조용히
  // 병합된다. messageOf 는 fetch 응답만 다루므로 이 실패는 messageOf 를 거치지도 않는다
  // (buildAppJwt 는 HTTP 호출 전에 던진다) — 그 우회 경로를 정확히 겨냥해야 한다.
  //
  // 손상된 PEM 안에 이 테스트만의 고유한 캐너리 문자열을 심고, 실제 crypto.sign 경로를 그대로
  // 태워 오류 메시지에 그 캐너리가 없는지 확인한다. 문구 자체가 나중에 바뀌어도("손상된 키"
  // 대신 "키 형식 오류" 등) 캐너리 부재만 확인하면 되므로 문구 변경에는 흔들리지 않는다.
  it("crypto.sign 이 손상된 PEM 으로 실패해도 오류 메시지에 키 조각이 섞이지 않는다", () => {
    const canary = "CANARY-DO-NOT-LEAK-8f3a1c9e";
    const malformedPem = `-----BEGIN RSA PRIVATE KEY-----\n${canary}\n-----END RSA PRIVATE KEY-----`;

    let thrown: unknown;
    try {
      buildAppJwt({ appId: "4514057", privateKeyPem: malformedPem, nowMs: 1_700_000_000_000 });
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(Error);
    const message = thrown instanceof Error ? thrown.message : String(thrown);
    expect(message).not.toContain(canary);
  });
});

describe("mintInstallationToken", () => {
  it("리포와 권한을 좁혀 요청하고 토큰·만료를 돌려준다", async () => {
    let seenUrl = "";
    let seenBody: unknown = null;
    const fetchImpl = (async (url: string, init: RequestInit) => {
      seenUrl = String(url);
      seenBody = JSON.parse(String(init.body));
      return new Response(JSON.stringify({ token: "ghs_x", expires_at: "2026-08-07T08:00:00Z" }), { status: 201 });
    }) as unknown as typeof fetch;

    const r = await mintInstallationToken({
      config, repoNames: ["todo-app"], permissions: { contents: "write" },
      nowMs: 1_700_000_000_000, fetchImpl,
    });

    expect(seenUrl).toBe("https://api.github.com/app/installations/151876954/access_tokens");
    expect(seenBody).toEqual({ repositories: ["todo-app"], permissions: { contents: "write" } });
    expect(r).toEqual({ token: "ghs_x", expiresAt: "2026-08-07T08:00:00Z" });
  });

  it("실패하면 본문의 message 를 담아 던진다", async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ message: "Bad credentials" }), { status: 401 })) as unknown as typeof fetch;
    await expect(
      mintInstallationToken({ config, repoNames: ["x"], permissions: {}, nowMs: 1, fetchImpl }),
    ).rejects.toThrow(/Bad credentials/);
  });

  // 진단 로그가 곧 유출 경로가 되면 안 된다(설계 §3).
  it("던지는 오류 메시지에 개인키가 섞이지 않는다", async () => {
    const fetchImpl = (async () => new Response("{}", { status: 500 })) as unknown as typeof fetch;
    await expect(
      mintInstallationToken({ config, repoNames: ["x"], permissions: {}, nowMs: 1, fetchImpl }),
    ).rejects.toThrow(/^(?!.*BEGIN RSA)/s);
  });
});

describe("createOrgRepo", () => {
  it("조직 엔드포인트로 비공개 리포를 만든다", async () => {
    let seenUrl = "";
    let seenBody: Record<string, unknown> = {};
    const fetchImpl = (async (url: string, init: RequestInit) => {
      seenUrl = String(url);
      seenBody = JSON.parse(String(init.body));
      return new Response(
        JSON.stringify({ clone_url: "https://github.com/semicollon-club/todo-app.git" }),
        { status: 201 },
      );
    }) as unknown as typeof fetch;

    const r = await createOrgRepo({ config, token: "ghs_x", repoName: "todo-app", fetchImpl });

    expect(seenUrl).toBe("https://api.github.com/orgs/semicollon-club/repos");
    expect(seenBody.private).toBe(true);
    expect(seenBody.name).toBe("todo-app");
    expect(r.cloneUrl).toBe("https://github.com/semicollon-club/todo-app.git");
  });

  it("이미 있으면 그 사실을 알 수 있게 던진다", async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ message: "name already exists on this account" }), { status: 422 })) as unknown as typeof fetch;
    await expect(createOrgRepo({ config, token: "t", repoName: "x", fetchImpl })).rejects.toThrow(/already exists/);
  });
});

// 2026-09-05: 부원이 디스코드만으로 브랜치를 올리고 main 에 PR 을 내는 흐름의 마지막 조각.
// git 만으로는 PR 을 만들 수 없어 봇이 REST 로 만든다 — 자격증명은 발행과 같이 봇만 갖는다.
describe("createPullRequest", () => {
  it("리포의 pulls 엔드포인트로 PR 을 만들고 주소·번호를 돌려준다", async () => {
    let seenUrl = "";
    let seenBody: Record<string, unknown> = {};
    let seenAuth = "";
    const fetchImpl = (async (url: string, init: RequestInit) => {
      seenUrl = String(url);
      seenBody = JSON.parse(String(init.body));
      seenAuth = String((init.headers as Record<string, string>).authorization);
      return new Response(
        JSON.stringify({ html_url: "https://github.com/semicollon-club/homepage/pull/7", number: 7 }),
        { status: 201 },
      );
    }) as unknown as typeof fetch;

    const r = await createPullRequest({
      config, token: "ghs_pr", repoName: "homepage", head: "feat/login", base: "main", title: "로그인", body: "설명", fetchImpl,
    });

    expect(seenUrl).toBe("https://api.github.com/repos/semicollon-club/homepage/pulls");
    expect(seenBody).toEqual({ title: "로그인", head: "feat/login", base: "main", body: "설명" });
    expect(seenAuth).toBe("Bearer ghs_pr");
    expect(r).toEqual({ url: "https://github.com/semicollon-club/homepage/pull/7", number: 7 });
  });

  it("실패하면 깃허브의 사유를 담아 던진다", async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ message: "No commits between main and feat/login" }), { status: 422 })) as unknown as typeof fetch;
    await expect(
      createPullRequest({ config, token: "t", repoName: "homepage", head: "feat/login", base: "main", title: "x", fetchImpl }),
    ).rejects.toThrow(/No commits between/);
  });
});
