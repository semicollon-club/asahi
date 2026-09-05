import { describe, it, expect } from "vitest";
import {
  makeShellTokenSource, SHELL_TOKEN_MIN_REMAINING_MS, SHELL_TOKEN_PERMISSIONS, SHELL_TOKEN_ERROR_COOLDOWN_MS,
} from "../src/github/shellToken.js";

const config = { org: "semicollon-club", appId: "1", installationId: "2", privateKeyPem: "PEM" };
const HOUR = 3_600_000;
const iso = (ms: number) => new Date(ms).toISOString();

type MintArgs = { repoNames: string[]; permissions: Record<string, string>; nowMs: number };
// 발급 호출을 하나씩 대본대로 응답한다 — 대본이 떨어졌는데 또 부르면 그 자체가 결함이다.
function fakeMint(script: Array<() => Promise<{ token: string; expiresAt: string }>>) {
  const calls: MintArgs[] = [];
  const mint = async (o: MintArgs) => {
    calls.push({ repoNames: o.repoNames, permissions: o.permissions, nowMs: o.nowMs });
    const next = script.shift();
    if (!next) throw new Error("예정에 없는 발급 호출");
    return next();
  };
  return { mint, calls };
}
const ok = (token: string, expiresAtMs: number) => async () => ({ token, expiresAt: iso(expiresAtMs) });

describe("makeShellTokenSource", () => {
  it("조직 전체·contents:write 로 발급하고 토큰을 돌려준다", async () => {
    const { mint, calls } = fakeMint([ok("ghs_1", HOUR)]);
    const src = makeShellTokenSource({ config, mint });
    expect(await src.get(0)).toEqual({ token: "ghs_1" });
    expect(calls).toEqual([{ repoNames: [], permissions: SHELL_TOKEN_PERMISSIONS, nowMs: 0 }]);
  });

  // sh_exec 는 git 과 무관한 명령이 대부분이다(ls·npm test). 호출마다 발급하면 그 전부가 깃허브
  // API 왕복을 물게 된다 — 만료까지 여유가 있는 동안은 같은 토큰을 쓴다.
  it("만료까지 여유가 있으면 재발급하지 않고 같은 토큰을 준다", async () => {
    const { mint, calls } = fakeMint([ok("ghs_1", HOUR)]);
    const src = makeShellTokenSource({ config, mint });
    await src.get(0);
    expect(await src.get(HOUR - SHELL_TOKEN_MIN_REMAINING_MS - 1)).toEqual({ token: "ghs_1" });
    expect(calls).toHaveLength(1);
  });

  // 여유를 두는 이유: 토큰을 받은 셸 명령(clone·push)이 몇 분 걸릴 수 있다 — 만료 직전 토큰을
  // 주면 명령 도중에 인증이 끊긴다.
  it("여유가 기준 아래로 떨어지면 새로 발급한다", async () => {
    const { mint, calls } = fakeMint([ok("ghs_1", HOUR), ok("ghs_2", 2 * HOUR)]);
    const src = makeShellTokenSource({ config, mint });
    await src.get(0);
    expect(await src.get(HOUR - SHELL_TOKEN_MIN_REMAINING_MS)).toEqual({ token: "ghs_2" });
    expect(calls).toHaveLength(2);
  });

  it("동시에 여러 호출이 와도 한 번만 발급한다", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const { mint, calls } = fakeMint([async () => { await gate; return { token: "ghs_1", expiresAt: iso(HOUR) }; }]);
    const src = makeShellTokenSource({ config, mint });
    const all = Promise.all([src.get(0), src.get(0), src.get(0)]);
    release();
    expect(await all).toEqual([{ token: "ghs_1" }, { token: "ghs_1" }, { token: "ghs_1" }]);
    expect(calls).toHaveLength(1);
  });

  // 실패를 캐시하지 않으면 키가 잘못된 동안 모든 sh_exec 가 깃허브를 두드린다. 반대로 영원히
  // 캐시하면 키를 고쳐도 봇을 재시작해야 한다 — 짧은 냉각 뒤 다시 시도한다.
  it("발급이 실패하면 사유를 돌려주고, 잠시 동안은 같은 사유를 재시도 없이 준다", async () => {
    const { mint, calls } = fakeMint([async () => { throw new Error("Bad credentials"); }, ok("ghs_2", 2 * HOUR)]);
    const src = makeShellTokenSource({ config, mint });
    expect(await src.get(0)).toEqual({ error: "Bad credentials" });
    expect(await src.get(SHELL_TOKEN_ERROR_COOLDOWN_MS - 1)).toEqual({ error: "Bad credentials" });
    expect(calls).toHaveLength(1);
    expect(await src.get(SHELL_TOKEN_ERROR_COOLDOWN_MS)).toEqual({ token: "ghs_2" });
    expect(calls).toHaveLength(2);
  });

  it("만료 시각을 읽을 수 없는 응답은 그 호출에만 쓰고 캐시하지 않는다", async () => {
    const { mint, calls } = fakeMint([async () => ({ token: "ghs_1", expiresAt: "언제?" }), ok("ghs_2", HOUR)]);
    const src = makeShellTokenSource({ config, mint });
    expect(await src.get(0)).toEqual({ token: "ghs_1" });
    expect(await src.get(1)).toEqual({ token: "ghs_2" });
    expect(calls).toHaveLength(2);
  });
});
