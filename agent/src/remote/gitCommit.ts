import { spawn } from "node:child_process";

// git 호출을 주입 가능한 이음매로 둔다 — 실제 git 없이 성패 양쪽을 테스트하기 위해서다
// (executors.ts 의 runPm2 와 같은 이유). env 는 gitPublish.ts 가 push 에만 자격증명을 넘기기
// 위해 이 태스크에서 더했다 — 기존 호출부(readCommit)는 인자를 안 주므로 그대로 돈다.
export type RunGit = (args: string[], env?: Record<string, string>) => Promise<{ ok: boolean; stdout: string }>;

export const defaultRunGit: RunGit = (args, env) =>
  new Promise((resolve) => {
    // env 를 주면 현재 환경에 얹는다. 토큰은 여기로만 전달된다 — 명령줄 인자로 주면 같은
    // 계정의 프로세스 목록(Win32_Process 의 CommandLine)에 그대로 노출된다(설계 §9).
    const child = spawn("git", args, env ? { env: { ...process.env, ...env } } : undefined);
    let stdout = "";
    child.stdout.on("data", (c: Buffer) => { stdout += c.toString(); });
    child.stderr.on("data", (c: Buffer) => { stdout += c.toString(); });
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

// 워커가 hello 에 싣는 commit 은 이 HEAD 다. 봇은 Railway 가 주입한 RAILWAY_GIT_COMMIT_SHA 를 보고하므로,
// 두 값이 같으려면 봇과 워커가 같은 브랜치(production)의 같은 커밋으로 배포돼야 한다.
