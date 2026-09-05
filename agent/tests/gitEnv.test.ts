import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import {
  shellGitEnv, shellGitOf, TOKEN_VAR, TOKEN_ERROR_VAR, DEFAULT_TOKEN_ERROR, NO_TOKEN_HELPER,
} from "../src/remote/gitEnv.js";
import { CREDENTIAL_HELPER } from "../src/remote/gitPublish.js";

// GIT_CONFIG_COUNT/KEY_n/VALUE_n 을 [key, value] 목록으로 되읽는다. 낱개 변수 이름을 테스트가
// 하드코딩하면 항목 순서를 바꾸는 사소한 리팩터에도 깨진다 — git 이 실제로 보는 형태 그대로 검증한다.
function configEntries(env: Record<string, string>): Array<[string, string]> {
  const n = Number(env.GIT_CONFIG_COUNT ?? 0);
  return Array.from({ length: n }, (_, i) => [env[`GIT_CONFIG_KEY_${i}`], env[`GIT_CONFIG_VALUE_${i}`]] as [string, string]);
}
const helpersOf = (env: Record<string, string>) =>
  configEntries(env).filter(([k]) => k === "credential.helper").map(([, v]) => v);

describe("shellGitEnv", () => {
  // 토큰이 명령줄이나 .git/config 에 실리면 같은 계정의 프로세스 목록·fs_read 로 새어 나간다
  // (발행 설계 §9). 환경변수 하나에만 두고, 헬퍼 문자열은 그 변수의 *이름*만 담는다.
  it("토큰은 환경변수로만 넘기고 헬퍼 문자열은 그 이름만 담는다", () => {
    const env = shellGitEnv({ token: "ghs_secret", userName: "홍길동", userEmail: "1@users.noreply.github.com" });
    expect(env[TOKEN_VAR]).toBe("ghs_secret");
    expect(helpersOf(env)).toEqual(["", CREDENTIAL_HELPER]);
    expect(configEntries(env).flat().join(" ")).not.toContain("ghs_secret");
  });

  // 빈 값이 먼저 와야 한다 — 시스템 gitconfig 의 manager 가 먼저 답하면 우리 토큰은 쓰이지도
  // 않는다(gitPublish.ts 의 CREDENTIAL_ARGS 와 같은 이유, 2026-08-08 실사용에서 겪었다).
  it("빈 헬퍼로 체인을 비운 뒤 우리 것을 얹는다", () => {
    const helpers = helpersOf(shellGitEnv({ token: "t" }));
    expect(helpers[0]).toBe("");
    expect(helpers[1]).toBe(CREDENTIAL_HELPER);
  });

  it("대화형 프롬프트를 끈다 — 토큰이 있든 없든", () => {
    expect(shellGitEnv({ token: "t" }).GIT_TERMINAL_PROMPT).toBe("0");
    expect(shellGitEnv(undefined).GIT_TERMINAL_PROMPT).toBe("0");
  });

  // 2026-08-07 첫 발행이 "Committer identity unknown" 으로 막혔고, 그때 모델이 공유 미니PC 의
  // 전역 git 설정을 바꿔 우회했다. 신원을 호출마다 같은 통로로 주면 전역 설정을 건드릴 이유가 없다.
  it("커밋 신원을 같은 통로로 준다", () => {
    const entries = configEntries(shellGitEnv({ token: "t", userName: "홍길동", userEmail: "1@users.noreply.github.com" }));
    expect(entries).toContainEqual(["user.name", "홍길동"]);
    expect(entries).toContainEqual(["user.email", "1@users.noreply.github.com"]);
  });

  it("토큰이 없으면 토큰 변수를 두지 않고, 헬퍼가 사유를 stderr 로 말한다", () => {
    const env = shellGitEnv({ tokenError: "발급 실패" });
    expect(env[TOKEN_VAR]).toBeUndefined();
    expect(env[TOKEN_ERROR_VAR]).toBe("발급 실패");
    expect(helpersOf(env)).toEqual(["", NO_TOKEN_HELPER]);
    expect(NO_TOKEN_HELPER).toContain(TOKEN_ERROR_VAR);
    expect(NO_TOKEN_HELPER).toContain(">&2");
  });

  // 봇이 옛 버전이면 git 인자 자체가 없다 — 그래도 프롬프트를 끄고 사유를 남겨야 매달리지 않는다.
  it("git 인자가 없어도(옛 봇) 기본 사유로 동작한다", () => {
    const env = shellGitEnv(undefined);
    expect(env[TOKEN_ERROR_VAR]).toBe(DEFAULT_TOKEN_ERROR);
    expect(helpersOf(env)[0]).toBe("");
  });

  it("GIT_CONFIG_COUNT 가 실제 항목 수와 같다", () => {
    expect(Number(shellGitEnv({ token: "t", userName: "a", userEmail: "b" }).GIT_CONFIG_COUNT)).toBe(4);
    expect(Number(shellGitEnv(undefined).GIT_CONFIG_COUNT)).toBe(2);
  });
});

describe("shellGitOf", () => {
  // 워커는 봇을 신뢰하지만 이 값은 네트워크 프레임을 건너온다 — 형태가 어긋난 값이 그대로 자식
  // 환경에 흘러들지 않게 문자열만 남긴다(executors.ts 의 str/strMap 과 같은 이유).
  it("문자열 필드만 받아들이고 나머지는 버린다", () => {
    expect(shellGitOf({ token: "t", userName: 1, userEmail: "e", extra: "x" })).toEqual({ token: "t", userEmail: "e" });
    expect(shellGitOf(undefined)).toBeUndefined();
    expect(shellGitOf("nope")).toBeUndefined();
    expect(shellGitOf({ token: "" })).toEqual({});
  });
});

// 이음매 너머의 실제 git. 위 단정은 env 의 모양만 보므로, git 이 그 env 를 실제로 그렇게 읽는지는
// 여기서만 확인된다 — 2026-09-05 운영자 PC(Git 2.55, cmd.exe 경유)에서 실측했고, CI 가 리눅스·
// 윈도우 양쪽에서 이 사실을 계속 지킨다(사유 문구는 ASCII 로 두어 콘솔 코드페이지와 무관하게 한다).
const hasGit = spawnSync("git", ["--version"]).status === 0;
describe.skipIf(!hasGit)("실제 git 이 env 를 읽는가", () => {
  const fill = (git: Parameters<typeof shellGitEnv>[0]) =>
    spawnSync("git", ["credential", "fill"], {
      input: "protocol=https\nhost=github.com\npath=semicollon-club/x.git\n\n",
      encoding: "utf8",
      timeout: 15_000,
      env: { ...process.env, GCM_INTERACTIVE: "never", ...shellGitEnv(git) },
    });

  it("토큰이 있으면 우리 헬퍼가 자격증명을 준다", () => {
    const r = fill({ token: "sekrit-probe" });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("username=x-access-token");
    expect(r.stdout).toContain("password=sekrit-probe");
  });

  it("토큰이 없으면 매달리지 않고 사유를 남기며 실패한다", () => {
    const r = fill({ tokenError: "PROBE-REASON-7f3a" });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("PROBE-REASON-7f3a");
  });
});
