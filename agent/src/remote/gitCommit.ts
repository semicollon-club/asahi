import { spawn } from "node:child_process";

// git 호출을 주입 가능한 이음매로 둔다 — 실제 git 없이 성패 양쪽을 테스트하기 위해서다
// (executors.ts 의 runPm2 와 같은 이유).
export type RunGit = (args: string[]) => Promise<{ ok: boolean; stdout: string }>;

export const defaultRunGit: RunGit = (args) =>
  new Promise((resolve) => {
    const child = spawn("git", args);
    let stdout = "";
    child.stdout.on("data", (c: Buffer) => { stdout += c.toString(); });
    child.on("error", () => resolve({ ok: false, stdout: "" }));
    child.on("close", (code) => resolve({ ok: code === 0, stdout }));
  });

// 워커가 지금 어떤 커밋으로 도는지. 실패하면 undefined 를 돌려주고 호출측은 그대로 진행한다 —
// 버전을 모르는 것이 워커가 아예 못 뜨는 것보다 낫다. 이 값은 부가 정보이지 동작 조건이 아니다.
export async function readCommit(runGit: RunGit): Promise<string | undefined> {
  try {
    const r = await runGit(["rev-parse", "HEAD"]);
    if (!r.ok) return undefined;
    const sha = r.stdout.trim();
    return sha.length > 0 ? sha : undefined;
  } catch {
    return undefined;
  }
}
