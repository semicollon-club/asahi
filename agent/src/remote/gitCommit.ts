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
// 1단계(2026-09-05)부터 봇(index.ts)도 같은 함수로 자기 커밋을 읽는다 — 아래 resolveBotVersion.
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

// 지금 체크아웃된 브랜치 이름. detached(-q 는 그때 아무것도 찍지 않고 0 이 아닌 코드로 끝난다)·실패는 undefined.
export async function readBranch(runGit: RunGit): Promise<string | undefined> {
  try {
    const r = await runGit(["symbolic-ref", "-q", "--short", "HEAD"]);
    if (!r.ok) return undefined;
    const name = r.stdout.trim();
    return name.length > 0 ? name : undefined;
  } catch {
    return undefined;
  }
}

export type BotVersion = { commit?: string; branch?: string };

// 봇이 runtime_info 로 보고할 자기 커밋·브랜치(미니PC 단일 호스트 1단계, 2026-09-05). 예전엔 Railway 가 주입하는
// RAILWAY_GIT_COMMIT_SHA/RAILWAY_GIT_BRANCH 만 봤다 — 미니PC 에는 그 변수가 없어 봇 커밋이 영원히 "알 수 없음"
// 이 된다. 우선순위는 명시 env(ASAHI_GIT_COMMIT/ASAHI_GIT_BRANCH — 테스트·특수 배포용) → git(클론에서 도는 봇:
// 미니PC·로컬 PM2) → Railway 변수(컨테이너에는 .git 이 없어 git 이 실패한다) 순이다. 어느 것도 없으면 undefined —
// 기동을 막지 않는다(readCommit 과 같은 원칙). git 은 기동 시 한 번만 부른다 — 봇은 갱신될 때 재시작되므로
// 도는 동안 커밋이 바뀌지 않는다(worker.ts 와 같은 이유).
export async function resolveBotVersion(env: NodeJS.ProcessEnv, runGit: RunGit): Promise<BotVersion> {
  const envCommit = env.ASAHI_GIT_COMMIT?.trim() || undefined;
  const envBranch = env.ASAHI_GIT_BRANCH?.trim() || undefined;
  const commit = envCommit ?? (await readCommit(runGit)) ?? (env.RAILWAY_GIT_COMMIT_SHA || undefined);
  const branch = envBranch ?? (await readBranch(runGit)) ?? (env.RAILWAY_GIT_BRANCH || undefined);
  return { commit, branch };
}
