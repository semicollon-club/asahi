import { isPathWithinAny } from "./paths.js";
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

// 인자에서 1차 필터를 걸 경로를 뽑는다. sh_exec 는 경로 인자가 없으므로 대상이 아니다
// (셸은 애초에 경로 판정이 성립하지 않는다 — 워커 루트가 유일한 방어선이다).
// 빈 문자열도 "값이 있는" 것으로 그대로 돌려준다 — "인자 없음"과 "빈 인자"는 다른 상태다.
// 후자를 전자로 취급하면 호출부의 1차 필터 전체가 조용히 스킵된다(빈/공백 판정은 호출부의 몫).
function pathArgOf(args: Record<string, unknown>): string | undefined {
  const p = args.path;
  return typeof p === "string" ? p : undefined;
}

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
// 경로 검사는 두 겹이다. 여기(봇)는 사용자가 allow_dir 로 관리하는 목록에 대한 1차 필터로,
// 왕복 전에 빠르게 거르고 안내 문구를 낸다. 최종 판정은 워커(remote/roots.ts)가 한다 —
// realpath·심볼릭 링크·실제 존재 여부를 아는 건 파일시스템을 가진 그쪽뿐이다.
export async function remoteToolHandler(
  ctx: ToolCtx,
  tool: string,
  args: Record<string, unknown>,
): Promise<string> {
  if (!isOwnerDm(ctx)) return OWNER_DM_ONLY;

  if (!ctx.remote) return "지금은 워커가 연결돼 있지 않아 PC 작업을 할 수 없어요.";

  const target = pathArgOf(args);
  if (target !== undefined) {
    // 빈 문자열/공백 문자열은 "경로 인자 없음"이 아니라 "잘못된 경로 인자"다 — 여기서 걸러내지
    // 않으면 아래 필터 전체가 조용히 스킵되고 호출이 그대로 워커로 넘어간다.
    if (target.trim().length === 0) return "경로가 비어 있어요. 올바른 절대경로를 지정해 주세요.";

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
    if (!isPathWithinAny(target, allowed)) return `허용된 폴더 밖 경로예요: ${target}`;
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
