import { CREDENTIAL_HELPER } from "./gitPublish.js";

// sh_exec 가 봇에게서 받는 git 인자(core/remoteTools.ts 의 shellGitArgs 가 만든다). 전부 선택이다 —
// 옛 봇은 이 객체 자체를 안 보내고, 깃허브가 설정되지 않은 봇은 token 없이 tokenError 만 보낸다.
export type ShellGit = {
  // 봇이 발급한 단기 설치 토큰(조직 전체·contents:write·최대 1시간, github/shellToken.ts).
  token?: string;
  // 토큰이 없는 이유. 자격증명 헬퍼가 이 문장을 stderr 로 내보내 git 오류 바로 위에 보이게 한다.
  tokenError?: string;
  // 커밋 author·committer 신원 — 지금 대화하는 부원의 표시 이름과 noreply 주소.
  userName?: string;
  userEmail?: string;
};

export const TOKEN_VAR = "ASAHI_GH_TOKEN";
export const TOKEN_ERROR_VAR = "ASAHI_GH_TOKEN_ERROR";

// 토큰이 없을 때의 헬퍼. 아무것도 돌려주지 않되 사유를 stderr 로 남긴다 — GIT_TERMINAL_PROMPT=0 과
// 함께면 git 은 "could not read Username ... terminal prompts disabled" 로 즉시 실패하고, 그 바로 위에
// 이 문장이 찍혀 모델이 "왜" 를 안다. get 에만 말한다 — git 은 인증 실패 뒤 erase 로 헬퍼를 한 번 더
// 부르는데, 그때까지 같은 문장을 반복할 이유가 없다. 항상 0 으로 끝난다 — 헬퍼가 0 이 아니게 끝나면
// git 이 그것을 별도의 경고로 덧붙여 진짜 사유를 가린다. 문자열 자체에 비밀은 없다(변수 이름뿐).
export const NO_TOKEN_HELPER =
  '!f() { if [ "$1" = get ]; then echo "$' + TOKEN_ERROR_VAR + '" >&2; fi; }; f';

export const DEFAULT_TOKEN_ERROR =
  "아사히: 깃허브 자격증명이 없어요 — 봇이 git 인자를 보내지 않았어요(봇이 옛 버전이거나 깃허브 App 이 설정되지 않았어요).";

// sh_exec 자식 프로세스에 얹을 환경. 전부 이 호출 하나에만 살고 디스크에 남는 것은 없다 — 워커에
// 영구 자격증명을 두지 않는다는 전제(deploy/worker-셋업.md)는 그대로다.
//
// git 설정은 GIT_CONFIG_COUNT/KEY_n/VALUE_n(git 2.31+ 의 공개 규약)으로 준다. -c 와 달리 모델의 셸
// 명령 문자열을 건드리지 않아도 되고(명령을 재작성하면 인용 경계가 깨진다 — docs/agent-onboarding.md
// 5절), .git/config 에도 남지 않는다. cmd.exe 를 거쳐도 빈 값(VALUE_0="")이 살아남아 헬퍼 체인을
// 비우는 것을 2026-09-05 운영자 PC(Git 2.55)에서 실측했다 — gitEnv.test.ts 의 "실제 git" 케이스가
// CI 의 리눅스·윈도우 양쪽에서 이 사실을 계속 지킨다.
//
// 빈 헬퍼가 먼저 오는 이유는 gitPublish.ts 의 CREDENTIAL_ARGS 와 같다 — Git for Windows 의 시스템
// 설정에 있는 manager 가 먼저 답하면 우리 토큰은 쓰이지도 않는다(2026-08-08 실사용).
//
// 신원(user.name/user.email)을 같은 통로로 주는 이유: 2026-08-07 첫 발행이 "Committer identity
// unknown" 으로 막혔을 때 모델이 공유 미니PC 의 전역 git 설정을 바꿔 우회했다. 호출마다 신원을 주면
// 전역 설정에 기댈 이유도, 건드릴 이유도 없다.
export function shellGitEnv(git: ShellGit | undefined): Record<string, string> {
  const token = git?.token;
  const hasToken = typeof token === "string" && token.length > 0;
  const entries: Array<[string, string]> = [
    ["credential.helper", ""],
    ["credential.helper", hasToken ? CREDENTIAL_HELPER : NO_TOKEN_HELPER],
  ];
  if (git?.userName) entries.push(["user.name", git.userName]);
  if (git?.userEmail) entries.push(["user.email", git.userEmail]);

  const env: Record<string, string> = {
    // 자격증명이 없을 때 git 이 입력을 기다리며 sh_exec 타임아웃까지 매달리면 안 된다 — 즉시 실패시킨다.
    GIT_TERMINAL_PROMPT: "0",
    // 체인은 비우지만, 혹시 남는 경로가 있어도 Git Credential Manager 가 창을 띄우지 않게 한다.
    GCM_INTERACTIVE: "never",
    GIT_CONFIG_COUNT: String(entries.length),
  };
  entries.forEach(([k, v], i) => {
    env[`GIT_CONFIG_KEY_${i}`] = k;
    env[`GIT_CONFIG_VALUE_${i}`] = v;
  });
  if (hasToken) env[TOKEN_VAR] = token;
  else env[TOKEN_ERROR_VAR] = git?.tokenError || DEFAULT_TOKEN_ERROR;
  return env;
}

// 네트워크 프레임을 건너온 값을 문자열 필드만 남기고 좁힌다(executors.ts 의 str/strMap 과 같은 방어).
// 워커는 봇을 신뢰하지만, 형태가 어긋난 값이 그대로 자식 환경에 흘러들게 두지는 않는다.
export function shellGitOf(v: unknown): ShellGit | undefined {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return undefined;
  const o = v as Record<string, unknown>;
  const out: ShellGit = {};
  for (const k of ["token", "tokenError", "userName", "userEmail"] as const) {
    const val = o[k];
    if (typeof val === "string" && val.length > 0) out[k] = val;
  }
  return out;
}
