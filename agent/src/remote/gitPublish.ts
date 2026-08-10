import type { RunGit } from "./gitCommit.js";

// 제외 규칙은 편의가 아니라 방어선이다 — 부원 폴더에 남은 비밀이 그대로 발행되는 것을 막는
// 유일한 장치다(설계 §6). 목록 기반이라 완전하지 않다는 것은 설계 §11 에 적혀 있다.
export const DEFAULT_EXCLUDES = [
  "node_modules/", ".git/", ".env", ".env.*",
  "dist/", "build/", ".next/", "out/",
  "*.log", "*.pem", "*.key", "*.p12", "*.pfx",
] as const;

export function gitignoreBody(extra: readonly string[] = []): string {
  return [...DEFAULT_EXCLUDES, ...extra].join("\n") + "\n";
}

export type PublishArgs = {
  dir: string;
  cloneUrl: string;
  token: string;
  message: string;
  authorName: string;
  authorEmail: string;
};

// 토큰을 URL 에도 명령줄 인자에도 넣지 않는다(설계 §9):
//   - remote URL 에 박으면 .git/config 에 평문으로 남아 그 부원이 fs_read 로 바로 읽는다
//   - 명령줄 인자로 주면 같은 계정의 프로세스 목록(Win32_Process 의 CommandLine)에 노출된다
//
// 대신 자격증명 헬퍼가 **환경변수를 읽게** 한다. 아래 문자열 자체에는 비밀이 없다 — `$ASAHI_GH_TOKEN`
// 이라는 이름만 들어 있어 명령줄에 실려도 안전하다. git 은 `!` 로 시작하는 헬퍼를 셸로 실행하며,
// Git for Windows 도 번들된 sh 로 같은 문법을 처리한다.
export const CREDENTIAL_HELPER =
  '!f() { echo "username=x-access-token"; echo "password=$ASAHI_GH_TOKEN"; }; f';

// **빈 값이 먼저 와야 한다.** `-c credential.helper=<우리 것>` 은 헬퍼 체인에 *추가*되는 것이지
// 교체가 아니다 — 시스템·전역 설정에 이미 헬퍼가 있으면(Git for Windows 는 기본으로
// credential.helper=manager 를 넣는다) git 이 그쪽에 먼저 묻고, 그것이 돌려준 자격증명을 쓴다.
// 그러면 우리 토큰은 쓰이지도 않고, 비공개 리포는 권한 없는 접근에 404 를 주므로
// "remote: Repository not found" 로만 보인다 — 리포가 실제로 없는 것처럼 읽혀 원인을 엉뚱한
// 곳에서 찾게 된다(2026-08-08 실사용에서 리포가 멀쩡히 있는데도 이 메시지가 나왔다).
//
// 빈 값은 그 지점까지 쌓인 헬퍼 목록을 지운다. `gh auth setup-git` 도 같은 이유로 빈 줄을 먼저
// 넣는다(이 리포 운영자의 ~/.gitconfig 에서 그 형태를 확인했다).
export const CREDENTIAL_ARGS = ["-c", "credential.helper=", "-c", `credential.helper=${CREDENTIAL_HELPER}`];

// 커밋의 committer 신원. author(발행한 부원)와 별개로 git 이 반드시 요구하는 값이고, 없으면
// "Committer identity unknown" 으로 커밋 자체가 실패한다 — 2026-08-07 첫 실사용이 정확히
// 이걸로 막혔다. 그때 모델이 sh_exec 로 `git config --global user.email` 을 실행해 **공유
// 미니PC 의 전역 설정을 바꿔서** 우회했는데, 발행 기능이 공유 기계의 설정을 오염시키면 안 된다.
// 그래서 전역 설정에 기대지 않고 -c 로 그 호출 하나에만 준다(runPublish 참고) — 전역 설정이
// 없는 깨끗한 워커에서도 그대로 돌아야 한다는 뜻이기도 하다.
export const COMMITTER_NAME = "Asahi";
export const COMMITTER_EMAIL = "asahi@users.noreply.github.com";

export function pushEnv(token: string): Record<string, string> {
  return {
    ASAHI_GH_TOKEN: token,
    // 대화형 프롬프트를 끈다 — 자격증명이 없을 때 워커가 입력을 기다리며 영원히 멈추면 안 된다.
    GIT_TERMINAL_PROMPT: "0",
  };
}

// git 서브커맨드 목록을 순서대로 돌려준다. 각 배열의 0번째는 항상 그 서브커맨드 이름
// (init·branch·remote·add·commit·push)이다 — runPublish 가 "이게 add 단계인가·push 단계인가"를
// 판정하고 실패 메시지에 이름을 넣을 때 이 위치를 그대로 믿는다.
//
// 실행에 필요한 "-C dir"(모든 명령)·"-c credential.helper=..."(push 만)는 여기 넣지 않고
// runPublish 가 실제로 실행하기 직전에 얹는다. 여기서 같이 섞으면 두 가지가 깨진다:
//   1) "-C" 가 0번째를 차지해 서브커맨드 이름으로 각 배열을 식별할 수 없게 된다 — 이 목록을
//      순수 함수로 검증하는 이유 자체(위 설명)가 무색해진다.
//   2) "-c" 의 값(credential.helper=...)은 "-" 로 시작하지 않는 일반 문자열이라, "이 배열이
//      add 명령인가"를 부분 포함으로 판정하면 remote add 단계와 헷갈리고, 실패 메시지의
//      명령 이름도 이 값을 잘못 주워 담을 수 있다.
// 목록 자체(토큰 없음)를 순수 함수로 검증하는 목적은 그대로 남는다 — 실제 실행은 runPublish 가 한다.
export function publishArgv(a: PublishArgs): string[][] {
  return [
    ["init"],
    ["branch", "-M", "main"],
    ["remote", "remove", "origin"],
    ["remote", "add", "origin", a.cloneUrl],
    ["add", "-A"],
    ["commit", "-m", a.message, `--author=${a.authorName} <${a.authorEmail}>`, "--allow-empty"],
    ["push", "-u", "origin", "main"],
  ];
}

// 토큰이 어떤 경로로든 사용자 대면 문자열에 섞이지 않게 마지막에 한 번 더 가린다. git 이
// 실패 메시지에 URL 을 통째로 실어 주는 경우가 있어, 상류에서 안 넣는 것만으로는 부족하다.
function redact(text: string, token: string): string {
  return token.length > 0 ? text.split(token).join("***") : text;
}

// 제외 후 총 용량 상한(설계 §6). 넘으면 발행하지 않고 무엇이 컸는지 알린다 — 조용히 자르면
// 부원이 "올렸는데 왜 안 도나"로 오해한다.
export const MAX_PUBLISH_BYTES = 50 * 1024 * 1024;

export type PublishDeps = {
  runGit: RunGit;
  writeFile: (p: string, body: string) => Promise<void>;
  sizeOf: (dir: string, rels: string[]) => Promise<number>;
};

export async function runPublish(a: PublishArgs, deps: PublishDeps): Promise<{ ok: boolean; content: string }> {
  const argv = publishArgv(a);
  const env = pushEnv(a.token);

  for (const cmd of argv) {
    // publishArgv 의 계약대로 0번째는 항상 서브커맨드 이름이다 — remote add 단계도 "add" 라는
    // 토큰을 담고 있으므로, 부분 포함(includes)이 아니라 정확히 이 위치로만 add·push 단계를
    // 구분한다(위 publishArgv 주석 참고).
    const name = cmd[0];
    const isAdd = name === "add";
    const isPush = name === "push";
    const isCommit = name === "commit";

    // `add -A` 직전에 .gitignore 를 쓴다. 이것이 제외 규칙이 실제로 집행되는 유일한 지점이다 —
    // 목록만 만들어 두고 파일을 안 쓰면 node_modules 와 .env 가 그대로 커밋된다.
    // init 뒤에 쓰는 이유는 폴더가 그때 확실히 존재하기 때문이고, add 앞에 쓰는 이유는
    // .gitignore 자신도 함께 커밋되어야 다음 발행에서도 같은 규칙이 적용되기 때문이다.
    if (isAdd) {
      await deps.writeFile(`${a.dir}/.gitignore`, gitignoreBody());
    }

    // -C dir 는 모든 호출에 필요하다 — RunGit 은 cwd 를 받지 않으므로(gitCommit.ts), 어느
    // 작업 폴더에서 도는지는 이 인자가 정한다. push 에만 자격증명 헬퍼(-c)를 더 얹는다 — 로컬
    // 명령까지 붙이면 그 문자열이 이유 없이 여러 프로세스의 명령줄에 퍼진다.
    // committer 신원은 commit 에만 얹는다(위 COMMITTER_NAME 선언부 참고). 자격증명 헬퍼와
    // 같은 자리에서 같은 방식으로 붙이는 이유는 publishArgv 의 계약을 지키기 위해서다 —
    // 그 배열의 0번째는 항상 서브커맨드여야 하고, -c 를 거기 끼우면 위 name 판정이 깨진다.
    const fullArgs = isPush
      ? ["-C", a.dir, ...CREDENTIAL_ARGS, ...cmd]
      : isCommit
        ? ["-C", a.dir, "-c", `user.name=${COMMITTER_NAME}`, "-c", `user.email=${COMMITTER_EMAIL}`, ...cmd]
        : ["-C", a.dir, ...cmd];

    // push 만 자격증명이 필요하다. 나머지에 env 를 주지 않는 것은 토큰이 닿는 프로세스 수를
    // 최소로 두기 위해서다.
    const r = isPush ? await deps.runGit(fullArgs, env) : await deps.runGit(fullArgs);

    // remote remove 는 origin 이 없으면 실패한다 — 첫 발행에서는 정상이므로 넘어간다.
    if (!r.ok && name === "remote" && cmd[1] === "remove") continue;
    if (!r.ok) {
      return { ok: false, content: redact(`git ${name} 에 실패했어요: ${r.stdout}`, a.token) };
    }

    // add 직후에 스테이징된 것의 총 용량을 잰다. commit·push 전에 멈춰야 되돌릴 것이 없다.
    if (isAdd) {
      const listed = await deps.runGit(["-C", a.dir, "ls-files", "--cached"]);
      const rels = listed.stdout.split("\n").map((s) => s.trim()).filter(Boolean);
      const total = await deps.sizeOf(a.dir, rels);
      if (total > MAX_PUBLISH_BYTES) {
        const mb = (total / 1024 / 1024).toFixed(1);
        return {
          ok: false,
          content:
            `올릴 파일이 너무 커요(${mb}MB, 상한 50MB). 빌드 산출물이나 큰 파일이 섞여 있는지 ` +
            `확인해 주세요 — node_modules·dist 같은 폴더는 자동으로 빠집니다.`,
        };
      }
    }
  }
  return { ok: true, content: "발행했어요." };
}

export type LocalState = "missing" | "clean" | "dirty";

// 로컬이 어떤 상태인지. "폴더는 있는데 git 저장소가 아니다"는 dirty 로 본다 — 안전한 쪽이다.
// clean 으로 보면 다음 단계가 pull 을 시도해 엉뚱한 오류를 내고, 사람이 원인을 엉뚱한 곳에서
// 찾게 된다.
export async function inspectLocal(
  dir: string,
  runGit: RunGit,
  exists: (p: string) => Promise<boolean>,
): Promise<LocalState> {
  if (!(await exists(dir))) return "missing";
  const r = await runGit(["-C", dir, "status", "--porcelain"]);
  if (!r.ok) return "dirty";
  return r.stdout.trim().length === 0 ? "clean" : "dirty";
}

export type RestoreArgs = { dir: string; cloneUrl: string; token: string; discardLocal: boolean };

// 되받기. 로컬 상태로 셋으로 갈린다(설계 §7.1) — 없으면 clone, 깨끗하면 pull --ff-only,
// 더러우면 **거절한다.** 더러울 때 미는 것을 막는 게 이 도구의 핵심이다: 복구하려다 방금 한
// 작업을 조용히 없애면 안 된다. --ff-only 도 같은 이유로 갈라진 히스토리를 자동 병합하지 않는다.
export async function runRestore(
  a: RestoreArgs,
  deps: { runGit: RunGit; exists: (p: string) => Promise<boolean>; rmrf: (p: string) => Promise<void> },
): Promise<{ ok: boolean; content: string }> {
  const state = await inspectLocal(a.dir, deps.runGit, deps.exists);

  if (state === "dirty" && !a.discardLocal) {
    return {
      ok: false,
      content:
        "저장하지 않은 변경이 있어서 되받지 않았어요. 그대로 덮으면 그 작업이 사라져요. " +
        "먼저 발행해서 올리시거나, 버려도 괜찮으면 버리고 새로 받겠다고 말씀해 주세요.",
    };
  }

  let discarded = false;
  if (state !== "missing" && a.discardLocal) {
    await deps.rmrf(a.dir);
    discarded = true;
  }

  const needsClone = state === "missing" || discarded;

  // clone·pull 도 push 와 마찬가지로 네트워크로 나가 GitHub 인증이 필요하다(설계 §7.1: "토큰은
  // 발행과 같다" — 이 태스크의 Interfaces 절이 pushEnv 를 소비 대상으로 적어 둔 이유이기도
  // 하다). 여기서 credential.helper 를 안 얹으면, 리포는 기본이 비공개라(설계 §4) 이 명령이
  // 매번 인증 실패로 끝난다 — "폴더가 없으면 clone" 이 실제로는 절대 안 되는 도구가 된다.
  // clone·pull 모두 **서브커맨드 앞**에 -c 를 둔다(아래 args 선언부에 그 이유를 적었다).
  // 실제 토큰 값은 이 인자들 어디에도 없다 — pushEnv 로 만든 환경변수로만 전달한다(§9).
  // 위 상태 확인(status) 호출에는 얹지 않는다 — 토큰이 닿는 프로세스 수를 최소로 두는 것은
  // push 와 같은 이유다.
  const env = pushEnv(a.token);
  // **-c 는 서브커맨드 앞에 온다.** `git clone -c k=v` (clone 자신의 옵션)는 그 값을 **새
  // 저장소의 .git/config 에 영구 기록한다** — git-clone 의 의도된 동작이다. 반면 `git -c k=v
  // clone` 은 이 호출에만 적용되고 아무것도 남기지 않는다. 둘 다 원격 fetch 전에 적용되므로
  // 인증에는 차이가 없다.
  //
  // 2026-08-08 실사용에서 되받은 저장소의 .git/config 에 [credential] 두 줄이 그대로 남은 것을
  // 확인했다. 토큰은 없지만(헬퍼 문자열은 환경변수 *이름* 만 담는다) 남길 이유가 없다 — 부원의
  // 저장소에 우리가 넣은 설정이 남아 있으면 나중에 그 사람이 직접 git 을 쓸 때 헬퍼 체인이
  // 조용히 달라지고, 원인을 찾기 어려운 자리가 하나 늘어난다.
  const args = needsClone
    ? [...CREDENTIAL_ARGS, "clone", a.cloneUrl, a.dir]
    : ["-C", a.dir, ...CREDENTIAL_ARGS, "pull", "--ff-only", "origin", "main"];

  const r = await deps.runGit(args, env);
  if (!r.ok) return { ok: false, content: redact(`되받지 못했어요: ${r.stdout}`, a.token) };

  return {
    ok: true,
    content: discarded ? "로컬을 지우고 새로 받았어요." : needsClone ? "새로 받았어요." : "최신으로 되받았어요.",
  };
}
