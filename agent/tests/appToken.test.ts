import { describe, it, expect } from "vitest";
import crypto from "node:crypto";
import { buildAppJwt, mintInstallationToken, createOrgRepo } from "../src/github/appToken.js";

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
