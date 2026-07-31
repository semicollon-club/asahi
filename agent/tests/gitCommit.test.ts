import { describe, it, expect } from "vitest";
import { readCommit } from "../src/remote/gitCommit.js";

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
