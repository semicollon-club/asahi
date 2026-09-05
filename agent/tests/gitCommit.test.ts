import { describe, it, expect } from "vitest";
import { readCommit, readBranch, resolveBotVersion } from "../src/remote/gitCommit.js";

describe("readCommit", () => {
  it("git 이 성공하면 SHA 를 다듬어 돌려준다", async () => {
    const runGit = async (args: string[]) => {
      expect(args).toEqual(["rev-parse", "HEAD"]);
      return { ok: true, stdout: "abc1234def5678\n" };
    };
    expect(await readCommit(runGit)).toBe("abc1234def5678");
  });

  it("git 이 실패하면 undefined 를 돌려준다(연결은 계속한다)", async () => {
    const runGit = async () => ({ ok: false, stdout: "" });
    expect(await readCommit(runGit)).toBeUndefined();
  });

  it("git 이 던져도 undefined 를 돌려준다", async () => {
    // 리포가 아닌 곳에서 실행하거나 git 이 없을 때다. 여기서 던지면 워커가 아예 못 뜬다.
    const runGit = async () => { throw new Error("ENOENT"); };
    expect(await readCommit(runGit)).toBeUndefined();
  });

  it("출력이 비면 undefined 를 돌려준다", async () => {
    const runGit = async () => ({ ok: true, stdout: "  \n" });
    expect(await readCommit(runGit)).toBeUndefined();
  });
});

// 미니PC 단일 호스트 1단계(2026-09-05): 봇 커밋을 Railway 가 주입하는 변수가 아니라 git 에서 읽는다 — 미니PC 에는
// 그 변수가 없고, 그러면 runtime_info 의 봇 커밋이 영원히 "알 수 없음"이다. 우선순위는 명시 env(ASAHI_GIT_*) →
// git → Railway 변수 순이다: 컨테이너(.git 없음)는 그대로 Railway 변수로 떨어지고, 미니PC 는 git 이 답한다.
describe("readBranch", () => {
  it("브랜치에 있으면 이름을 돌려준다", async () => {
    const runGit = async (args: string[]) => {
      expect(args).toEqual(["symbolic-ref", "-q", "--short", "HEAD"]);
      return { ok: true, stdout: "production\n" };
    };
    expect(await readBranch(runGit)).toBe("production");
  });

  it("detached 면(실패·빈 출력) undefined", async () => {
    expect(await readBranch(async () => ({ ok: false, stdout: "" }))).toBeUndefined();
    expect(await readBranch(async () => ({ ok: true, stdout: "\n" }))).toBeUndefined();
    expect(await readBranch(async () => { throw new Error("ENOENT"); })).toBeUndefined();
  });
});

describe("resolveBotVersion — 명시 env → git → Railway 변수", () => {
  const gitOk = async (args: string[]) =>
    args[0] === "rev-parse" ? { ok: true, stdout: "abc1234def5678\n" } : { ok: true, stdout: "production\n" };
  const gitFail = async () => ({ ok: false, stdout: "" });

  it("git 이 답하면 그 커밋·브랜치다(미니PC)", async () => {
    expect(await resolveBotVersion({}, gitOk)).toEqual({ commit: "abc1234def5678", branch: "production" });
  });

  it("git 이 없으면(컨테이너) Railway 변수로 떨어진다", async () => {
    expect(await resolveBotVersion({ RAILWAY_GIT_COMMIT_SHA: "r1", RAILWAY_GIT_BRANCH: "production" }, gitFail))
      .toEqual({ commit: "r1", branch: "production" });
  });

  it("ASAHI_GIT_COMMIT/BRANCH 가 있으면 git 도 Railway 도 보지 않는다", async () => {
    let called = 0;
    const spy = async (args: string[]) => { called++; return gitOk(args); };
    expect(await resolveBotVersion({ ASAHI_GIT_COMMIT: " e1 ", ASAHI_GIT_BRANCH: "main", RAILWAY_GIT_COMMIT_SHA: "r1" }, spy))
      .toEqual({ commit: "e1", branch: "main" });
    expect(called).toBe(0);
  });

  it("아무것도 없으면 둘 다 undefined — 기동은 막지 않는다", async () => {
    expect(await resolveBotVersion({}, gitFail)).toEqual({ commit: undefined, branch: undefined });
  });

  it("커밋만 git 이 답하고 브랜치는 detached 면 브랜치만 Railway 변수로 떨어진다", async () => {
    const git = async (args: string[]) =>
      args[0] === "rev-parse" ? { ok: true, stdout: "abc\n" } : { ok: false, stdout: "" };
    expect(await resolveBotVersion({ RAILWAY_GIT_BRANCH: "production" }, git)).toEqual({ commit: "abc", branch: "production" });
  });
});
