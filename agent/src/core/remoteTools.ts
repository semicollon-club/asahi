import { isPathWithinAny } from "./paths.js";
import { extractCandidatePaths } from "./pathPermission.js";
import type { ToolCtx } from "./tools.js";

// 워커에서 실행되는 원격 도구 이름. SDK 내장 Read/Write/Edit/Glob/Grep/Bash 를 대체한다.
// 이름을 달리 지은 이유: 내장 도구와 이름이 겹치면 어느 쪽이 도는지 알 수 없다.
export const REMOTE_TOOL_NAMES = ["fs_read", "fs_write", "fs_edit", "fs_glob", "fs_grep", "sh_exec"] as const;

// 원격 개발 워크플로우는 1단계 한정 소유자 DM 전용이다. tools.ts 의 다른 특권 핸들러들과
// 같은 문구로 거부해 사용자에게는 하나의 일관된 목소리로 보이게 한다.
const OWNER_DM_ONLY = "이 작업은 소유자 DM에서만 할 수 있어요.";

// tools.ts 의 isOwnerDm 과 완전히 동일한 판정이다. 그쪽 함수를 그대로 가져다 쓰지 못하는 이유는
// tools.ts 가 이미 이 모듈(remoteTools.ts)을 import 하고 있어서다 — 역방향 import 는 순환 참조가
// 된다. 로직만 그대로 복제한다(한쪽이 바뀌면 반드시 같이 바꿔야 한다).
function isOwnerDm(ctx: ToolCtx): boolean {
  return ctx.isOwner && ctx.isPrivate;
}

// 인자에서 1차 필터를 걸 경로를 뽑는다(fs_read/fs_write/fs_edit 용 — fs_glob/fs_grep 은 아래
// LOCAL_TOOL_NAME 경로로 별도 처리한다). sh_exec 는 경로 인자가 없으므로 대상이 아니다 — 뿐만
// 아니라 봇 쪽에서 경로를 아무리 걸러도 셸 명령 자체(파이프·리다이렉트·PATH 탐색 등)는 경로 인자
// 하나로 판정할 수 있는 대상이 아니다(FIX6). sh_exec 의 유일한 경계는 실행 시 cwd(워커 roots[0])와
// 워커 프로세스를 돌리는 OS 계정의 권한뿐이며, 이는 의도된 설계다 — 셸을 경로로 봉쇄하려는 시도는
// 하지 않는다. 아래 remoteToolHandler 의 주석과 .env.example 도 같은 내용을 명시한다.
// 빈 문자열도 "값이 있는" 것으로 그대로 돌려준다 — "인자 없음"과 "빈 인자"는 다른 상태다.
// 후자를 전자로 취급하면 호출부의 1차 필터 전체가 조용히 스킵된다(빈/공백 판정은 호출부의 몫).
function pathArgOf(args: Record<string, unknown>): string | undefined {
  const p = args.path;
  return typeof p === "string" ? p : undefined;
}

// FIX6(중요): fs_glob·fs_grep 는 path 인자가 없어도 pattern(글롭 패턴, fs_grep 은 +glob 검색
// 필터) 자체가 경로를 담을 수 있다. path 유무만으로 필터 전체를 걸고/건너뛰면 (1) path 를
// 생략하면 allowedDirs 검사가 통째로 스킵되어 — 워커는 path 생략 시 roots[0] 를 기본값으로
// 쓰므로 — 빈 allowedDirs 로도 워커 루트 전체를 열거할 수 있었고, (2) path 가 허용 폴더 안이어도
// pattern="../../**/*"(fs_grep 은 glob="../../**/*")같은 값으로 그 밖을 가리키면 봇 쪽은 path 만
// 보고 통과시켰다(워커도 결과를 roots 로만 재검사할 뿐 allowedDirs 는 모른다). 이 두 도구가
// 대체한 로컬 SDK 의 Glob/Grep 도구(canUseTool 이 쓰던 원래 게이트)는 pathPermission.ts 의
// extractCandidatePaths 로 정확히 이 문제를 이미 풀어 뒀다 — 같은 규칙을 두 번 만들지 않고 그대로
// 재사용한다. "path 생략 시 실행기(executors.ts)가 roots[0] 를 기본값으로 쓴다"는 것과 같은
// 정신으로, 여기서는 allowedDirs[0](사용자가 실제로 허용한 첫 폴더)을 extractCandidatePaths 의
// cwd 인자로 넘긴다 — "후보가 하나도 안 나오면 그 기본값을 검사한다"는 이미 검증된 규칙을 그대로
// 태운다. 다만 "검사"만으로는 부족하다 — 아래 remoteToolHandler 본문의 최종 리뷰 FIX1 주석 참고
// (검사에 쓴 기본값을 실제로 args 에 주입해야, 워커가 자신의 roots[0] 을 대신 쓰는 일이 없다).
const LOCAL_TOOL_NAME: Partial<Record<string, string>> = { fs_glob: "Glob", fs_grep: "Grep" };

// 원격 호출은 실패해도 예외를 던지지 않는다 — 도구 하나의 실패가 턴 전체를 죽이면
// 모델이 다른 방법을 시도하거나 사용자에게 알릴 기회 자체가 사라진다.
//
// 신원 재확인은 allowedToolsFor(능력 계층)와 독립적으로 다시 한다. ctx.remote 는 "워커 연결
// 여부"만으로 채워질 수 있어(허브 쪽 배선은 이 턴이 공개 채널인지 모른다) allowedToolsFor 가
// 이번 턴에 도구 이름을 안 줬다는 사실 하나에만 기대면, 그 산정이 어긋나는 순간(예: 소유자가
// 공개 서버 채널에서 말했는데도 ctx.remote 가 채워지는 배선 버그) sh_exec 로 가는 마지막
// 방어선이 SDK 의 allowed-tools 검사 하나만 남는다. 그래서 다른 특권 핸들러(dbQueryHandler 등의
// isOwnerDm, allowDirHandler 등의 canManagePc)처럼 핸들러 자신이 다시 확인한다.
//
// 경로 검사는 두 겹이다 — 단, fs_read/fs_write/fs_edit/fs_glob/fs_grep 에 한해서다. 여기(봇)는
// 사용자가 allow_dir 로 관리하는 목록에 대한 1차 필터로, 왕복 전에 빠르게 거르고 안내 문구를
// 낸다. 최종 판정은 워커(remote/roots.ts)가 한다 — realpath·심볼릭 링크·실제 존재 여부를 아는
// 건 파일시스템을 가진 그쪽뿐이다. sh_exec 는 이 두 겹 중 어느 쪽에도 속하지 않는다(FIX6 — 문서만
// 바로잡을 뿐 동작은 원래도 이랬다): 셸 명령은 경로 인자 자체가 없어 위 필터가 적용될 대상이 없고,
// 워커 쪽(executors.ts)도 sh_exec 는 roots 로 판정하지 않는다 — 유일한 경계는 실행 시 cwd
// (roots[0])와 워커 프로세스를 돌리는 OS 계정의 권한뿐이다. 셸을 "경로"로 봉쇄하려는 시도는 하지
// 않는다 — 셸은 애초에 경로 판정이 성립하지 않는다(파이프·서브셸·PATH 탐색 등으로 얼마든지
// 우회된다).
export async function remoteToolHandler(
  ctx: ToolCtx,
  tool: string,
  args: Record<string, unknown>,
): Promise<string> {
  if (!isOwnerDm(ctx)) return OWNER_DM_ONLY;

  if (!ctx.remote) return "지금은 워커가 연결돼 있지 않아 PC 작업을 할 수 없어요.";

  const singlePathArg = pathArgOf(args);
  const localTool = LOCAL_TOOL_NAME[tool];
  // FIX6: fs_glob·fs_grep 는 path 가 없어도(localTool 이 있으면) 아래 필터를 계속 타야 한다.
  // 나머지 도구(fs_read/fs_write/fs_edit)는 path 인자가 있을 때만(기존 방식 그대로) 검사한다.
  // sh_exec 는 path 도 없고 localTool 도 없으므로 이 필터의 대상이 아니다(위 주석 참고).
  const needsPathCheck = singlePathArg !== undefined || localTool !== undefined;

  if (needsPathCheck) {
    // 빈 문자열/공백 문자열은 "경로 인자 없음"이 아니라 "잘못된 경로 인자"다 — 여기서 걸러내지
    // 않으면 아래 필터 전체가 조용히 스킵되고 호출이 그대로 워커로 넘어간다.
    if (singlePathArg !== undefined && singlePathArg.trim().length === 0) {
      return "경로가 비어 있어요. 올바른 절대경로를 지정해 주세요.";
    }

    // repos.allowedDirs 가 없는 호출측은 현재 운영 코드(buildToolCtx)에서는 나타나지 않아야
    // 하지만, "판정할 수 없다"를 "통과시킨다"로 처리하면(fail open) 이 1차 필터가 있으나 마나
    // 해진다. 판정 불가 상태의 안전한 기본값은 거부다(fail closed).
    if (!ctx.repos?.allowedDirs) return "허용 폴더 목록을 확인할 수 없어 요청을 거부했어요.";

    let allowed: string[];
    try {
      allowed = await ctx.repos.allowedDirs.list(ctx.userId);
    } catch (e) {
      // allowedDirs.list 는 실제 DB 호출이라 reject 할 수 있다(아래 허브 콜과 달리 "절대
      // reject 하지 않는다"는 보장이 없다) — 여기서 잡아 문자열로 바꾼다.
      return `허용 폴더 확인 중 오류가 발생했어요: ${e instanceof Error ? e.message : String(e)}`;
    }
    if (allowed.length === 0) return "먼저 allow_dir 로 작업할 폴더를 허용해 주세요.";

    // FIX6: fs_glob/fs_grep 은 path·pattern(fs_grep 은 +glob) 양쪽에서 후보 경로를 뽑는다
    // (extractCandidatePaths 가 path 생략 시 allowed[0] 기본값까지 포함해 처리한다). 나머지
    // 도구는 기존처럼 path 하나만 본다.
    const candidates = localTool
      ? extractCandidatePaths(localTool, args, undefined, allowed[0])
      : singlePathArg !== undefined ? [singlePathArg] : [];
    for (const c of candidates) {
      if (!isPathWithinAny(c, allowed)) return `허용된 폴더 밖 경로예요: ${c}`;
    }

    // 최종 리뷰 FIX1(치명): 위에서 "검사"만 하고 끝내면 안 된다 — fs_glob/fs_grep 은 path 가
    // 생략되면 워커(executors.ts)가 자신의 roots[0](워커 루트, 보통 allowed_dirs 보다 넓다)을
    // 기본값으로 쓴다. 방금 검사에 쓴 allowed[0] 은 봇이 "이 값을 기준으로 검색될 것"이라고
    // 가정하고 확인한 값인데, 실제로 워커에 보내는 args 를 그대로 두면 워커는 그 가정과 무관하게
    // roots[0] 을 쓴다 — "검사한 값"과 "실제로 쓰이는 값"이 달라 검사 자체가 무의미해진다(리뷰
    // 재현: path 없이 fs_grep 을 부르면 워커 루트 전체가 열거됐다). path 를 생략한 경우에 한해,
    // 검사에 쓴 allowed[0] 을 args 에 실제로 주입해 워커로 보낸다 — 사용자가 이미 path 를
    // 지정했다면(singlePathArg !== undefined) 그 값을 존중해 덮어쓰지 않는다.
    if (localTool && singlePathArg === undefined) {
      args = { ...args, path: allowed[0] };
    }
  }

  let r: { ok: boolean; content: string };
  try {
    r = await ctx.remote.call(tool, args);
  } catch (e) {
    // WorkerHub.call 은 reject 하지 않도록 설계돼 있지만, 그 보장이 깨지는 경우까지 대비한다 —
    // "절대 던지지 않는다"는 이 함수 자신의 계약이므로 방어를 이중으로 둔다.
    return `원격 작업 처리 중 오류가 발생했어요: ${e instanceof Error ? e.message : String(e)}`;
  }
  return r.content.length > 0 ? r.content : (r.ok ? "(완료)" : "(실패했지만 내용이 없어요)");
}
