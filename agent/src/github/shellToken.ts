import { mintInstallationToken, type GithubAppConfig } from "./appToken.js";

// sh_exec 의 git 이 쓰는 단기 토큰 공급원 — 발행 설계의 자격증명 모델(§3: 자격증명은 봇이 들고
// 워커에는 짧은 토큰만 넘긴다)을 셸까지 넓힌 것이다. 배경과 위협 판단은
// docs/superpowers/specs/2026-09-05-worker-git-credentials-design.md.
//
// 범위는 조직 전체(repositories 미지정)·contents:write 다. 발행 토큰이 리포 하나로 좁혀지는 것과
// 다른 이유는 이 토큰이 "어느 리포를 건드릴지 모르는" 셸 명령에 앞서 발급되기 때문이다 — 부원이
// 동아리 저장소 아무것이나 clone·push 하는 것이 목적이므로 좁힐 축 자체가 없다. pull_requests 는
// 넣지 않는다 — PR 은 봇이 REST 로 만들고(core/tools.ts 의 createPullRequestHandler) git 은 그
// 권한을 쓸 일이 없다. 권한을 넓히면 App 에 그 권한이 아직 없을 때 발급 자체가 실패해 git push 까지
// 막힌다(실제로 2026-09-05 기준 App 에는 pull_requests 가 없다).
export const SHELL_TOKEN_PERMISSIONS = { contents: "write" } as const;

export type ShellTokenResult = { token: string } | { error: string };
export type ShellTokenSource = { get(nowMs: number): Promise<ShellTokenResult> };

// 만료까지 이만큼은 남아 있어야 재사용한다. 토큰을 받은 명령(clone·push)이 몇 분 걸릴 수 있어 만료
// 직전 토큰을 주면 명령 도중 인증이 끊긴다. 깃허브 토큰 수명이 1시간이라 한 토큰이 약 50분 쓰인다.
export const SHELL_TOKEN_MIN_REMAINING_MS = 10 * 60_000;
// 발급 실패를 이만큼 기억한다. 없으면 키가 잘못된 동안 모든 sh_exec 가 깃허브를 두드리고, 너무
// 길면 키를 고쳐도 봇을 재시작해야 한다.
export const SHELL_TOKEN_ERROR_COOLDOWN_MS = 60_000;

type Mint = typeof mintInstallationToken;

// appToken.ts 의 mintInstallationToken 은 "요청마다 새로 발급한다 — 캐시하지 않는다"고 적어 뒀고
// 발행에서는 그게 맞다(왕복 한 번이라 아낄 이유가 없다). 여기는 다르다 — sh_exec 는 대부분 git 과
// 무관한 명령(ls·npm test)이고 호출마다 발급하면 그 전부가 깃허브 API 왕복을 문다. 그래서 이
// 공급원만 캐시를 갖되, 상태를 최소(토큰 하나 + 만료 시각 + 마지막 실패)로 두고 시각은 밖에서
// 받는다 — 만료 판정이 틀렸을 때의 실패 모드가 테스트로 고정돼야 한다(shellToken.test.ts).
export function makeShellTokenSource(o: {
  config: GithubAppConfig;
  mint?: Mint;
  minRemainingMs?: number;
  errorCooldownMs?: number;
}): ShellTokenSource {
  const mint = o.mint ?? mintInstallationToken;
  const minRemaining = o.minRemainingMs ?? SHELL_TOKEN_MIN_REMAINING_MS;
  const cooldown = o.errorCooldownMs ?? SHELL_TOKEN_ERROR_COOLDOWN_MS;

  let cached: { token: string; expiresAtMs: number } | null = null;
  let lastError: { error: string; untilMs: number } | null = null;
  // 동시에 온 호출은 한 발급을 나눠 쓴다 — 턴 하나가 sh_exec 를 연달아 부르는 것이 보통이다.
  let inflight: Promise<ShellTokenResult> | null = null;

  return {
    async get(nowMs) {
      if (cached && cached.expiresAtMs - nowMs > minRemaining) return { token: cached.token };
      if (lastError && nowMs < lastError.untilMs) return { error: lastError.error };
      if (inflight) return inflight;
      inflight = (async (): Promise<ShellTokenResult> => {
        try {
          const r = await mint({ config: o.config, repoNames: [], permissions: { ...SHELL_TOKEN_PERMISSIONS }, nowMs });
          const expiresAtMs = Date.parse(r.expiresAt);
          // 만료를 모르는 토큰은 이 호출에만 쓰고 캐시하지 않는다 — 언제 죽을지 모르는 값을 재사용하면
          // 죽은 토큰을 50분 동안 나눠 주게 된다.
          cached = Number.isFinite(expiresAtMs) ? { token: r.token, expiresAtMs } : null;
          lastError = null;
          return { token: r.token };
        } catch (err) {
          const error = err instanceof Error ? err.message : String(err);
          lastError = { error, untilMs: nowMs + cooldown };
          return { error };
        } finally {
          inflight = null;
        }
      })();
      return inflight;
    },
  };
}
