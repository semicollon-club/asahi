import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import dotenv from "dotenv";

// 깃허브 발행 진단. App 개인키로 설치 토큰이 실제로 "스코프대로" 발급되는지 확인한다.
// skillProbe.ts 와 같은 이유로 존재한다 — 문서만 읽고 구현을 쌓지 않기 위해서다.
//
// 설계 문서(docs/superpowers/specs/2026-08-07-github-publish-design.md) §3 은 "요청마다 단일
// 리포·contents:write·1시간 토큰"에 보안 논리 전체를 걸고 있고, §4.1 은 "조직이어야 리포
// 자동 생성이 된다"를 GitHub 문서 표로만 확인했다. 둘 다 실물로 눌러본 적이 없다.
//
// 이 프로브가 확인하는 것:
//   1. 개인키 + App ID 조합이 맞는가          (GET /app)
//   2. 설치 토큰이 발급되는가                 (POST /app/installations/:id/access_tokens)
//   3. permissions 파라미터가 실제로 좁히는가 (발급 응답의 permissions)
//   4. 만료가 정말 1시간인가                  (발급 응답의 expires_at)
//   5. (옵션) 조직 리포 생성이 되는가         (--create-repo, 실제로 만든다)
//
// 토큰도 개인키도 절대 출력하지 않는다 — 진단 로그가 곧 유출 경로가 되면 안 된다.

dotenv.config({ path: path.resolve("..", ".env") });
dotenv.config();

const args = process.argv.slice(2);
const argOf = (name: string): string | undefined => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};

// 개인키는 두 경로로 받는다. 환경변수(base64 한 줄)가 운영 형태이고, --pem 은 Railway 에
// 넣기 전에 내려받은 파일로 바로 시험해 보기 위한 것이다 — 순서를 강제하면 "넣어봐야
// 되는지 알 수 있는데 되는지 알아야 넣는다"가 된다.
function loadPrivateKey(): string {
  const pemPath = argOf("--pem");
  if (pemPath) return fs.readFileSync(pemPath, "utf8");
  const b64 = process.env.GITHUB_APP_PRIVATE_KEY_B64;
  if (!b64) {
    throw new Error("GITHUB_APP_PRIVATE_KEY_B64 가 없습니다. 또는 --pem <경로> 로 주세요.");
  }
  return Buffer.from(b64, "base64").toString("utf8");
}

const appId = argOf("--app-id") ?? process.env.GITHUB_APP_ID;
const installationId = argOf("--installation-id") ?? process.env.GITHUB_APP_INSTALLATION_ID;
const org = argOf("--org") ?? process.env.GITHUB_ORG;

if (!appId || !installationId || !org) {
  console.error("[probe] GITHUB_APP_ID·GITHUB_APP_INSTALLATION_ID·GITHUB_ORG 가 모두 필요합니다.");
  console.error("        (--app-id / --installation-id / --org 로도 줄 수 있습니다)");
  process.exit(1);
}

const b64url = (b: Buffer): string => b.toString("base64url");

// App JWT. RS256 서명이고 iss 는 App ID 다. iat 를 60초 앞당기는 것은 GitHub 권고다 —
// 이쪽 시계가 조금 빠르면 "미래에 발급된 토큰"으로 거부된다.
function appJwt(privateKey: string): string {
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })));
  const payload = b64url(Buffer.from(JSON.stringify({ iat: now - 60, exp: now + 540, iss: appId })));
  const signature = b64url(crypto.sign("RSA-SHA256", Buffer.from(`${header}.${payload}`), privateKey));
  return `${header}.${payload}.${signature}`;
}

async function gh(url: string, token: string, init: RequestInit = {}): Promise<{ status: number; body: unknown }> {
  const res = await fetch(url, {
    ...init,
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${token}`,
      "x-github-api-version": "2022-11-28",
      ...(init.body ? { "content-type": "application/json" } : {}),
      ...init.headers,
    },
  });
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  return { status: res.status, body };
}

const pick = (o: unknown, k: string): unknown => (o && typeof o === "object" ? (o as Record<string, unknown>)[k] : undefined);

async function main(): Promise<void> {
  const privateKey = loadPrivateKey();
  const jwt = appJwt(privateKey);

  // 1. 개인키와 App ID 가 짝이 맞는가. 여기서 401 이면 뒤를 볼 필요가 없다.
  const app = await gh("https://api.github.com/app", jwt);
  if (app.status !== 200) {
    console.error(`[probe] 1. App 인증 실패 (HTTP ${app.status}) — ${String(pick(app.body, "message"))}`);
    console.error("        개인키와 App ID 가 같은 App 의 것인지 확인하세요.");
    process.exit(1);
  }
  console.log(`[probe] 1. App 인증 성공 — slug=${String(pick(app.body, "slug"))} id=${String(pick(app.body, "id"))}`);
  console.log(`[probe]    App 이 가진 권한: ${JSON.stringify(pick(app.body, "permissions"))}`);

  // 2·3·4. 좁힌 토큰을 발급해 본다. 설계가 실제로 기대는 지점이다.
  const wanted = { contents: "write", administration: "write" };
  const tok = await gh(`https://api.github.com/app/installations/${installationId}/access_tokens`, jwt, {
    method: "POST",
    body: JSON.stringify({ permissions: wanted }),
  });
  if (tok.status !== 201) {
    console.error(`[probe] 2. 토큰 발급 실패 (HTTP ${tok.status}) — ${String(pick(tok.body, "message"))}`);
    console.error("        App 이 그 권한을 갖고 있지 않거나 installation id 가 다를 수 있습니다.");
    process.exit(1);
  }
  const token = String(pick(tok.body, "token"));
  console.log(`[probe] 2. 토큰 발급 성공 (토큰 자체는 출력하지 않습니다)`);
  console.log(`[probe] 3. 요청한 권한: ${JSON.stringify(wanted)}`);
  console.log(`[probe]    실제 발급된 권한: ${JSON.stringify(pick(tok.body, "permissions"))}`);
  const expiresAt = String(pick(tok.body, "expires_at"));
  const minutes = Math.round((Date.parse(expiresAt) - Date.now()) / 60000);
  console.log(`[probe] 4. 만료: ${expiresAt} (약 ${minutes}분 뒤)`);

  // 5. 조직 리포 생성. 실제로 만들기 때문에 반드시 명시적으로 켜야 한다 — 진단이 부작용을
  //    남기는 것은 그 자체로 결함이고, 만들어진 리포는 이 스크립트가 지우지 않는다.
  const repoName = argOf("--create-repo");
  if (!repoName) {
    console.log("[probe] 5. 리포 생성은 건너뜀 — 실제로 만들려면 --create-repo <이름> 을 주세요.");
    console.log("[probe]    (그 리포는 이 스크립트가 지우지 않습니다. 확인 후 직접 지우세요.)");
    return;
  }
  const created = await gh(`https://api.github.com/orgs/${org}/repos`, token, {
    method: "POST",
    body: JSON.stringify({ name: repoName, private: true, auto_init: false }),
  });
  if (created.status !== 201) {
    console.error(`[probe] 5. 리포 생성 실패 (HTTP ${created.status}) — ${String(pick(created.body, "message"))}`);
    console.error("        설계 §4.1 의 전제(설치 토큰으로 조직 리포 생성 가능)가 틀렸다면 여기서 드러납니다.");
    process.exit(1);
  }
  console.log(`[probe] 5. 리포 생성 성공 — ${String(pick(created.body, "full_name"))} (private=${String(pick(created.body, "private"))})`);
  console.log("[probe]    확인이 끝나면 직접 지우세요.");
}

await main();
