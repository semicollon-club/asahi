import { isPathWithinAny } from "./paths.js";
import type { ToolCtx } from "./tools.js";

// 워커에서 실행되는 원격 도구 이름. SDK 내장 Read/Write/Edit/Glob/Grep/Bash 를 대체한다.
// 이름을 달리 지은 이유: 내장 도구와 이름이 겹치면 어느 쪽이 도는지 알 수 없다.
export const REMOTE_TOOL_NAMES = ["fs_read", "fs_write", "fs_edit", "fs_glob", "fs_grep", "sh_exec"] as const;

// 인자에서 1차 필터를 걸 경로를 뽑는다. sh_exec 는 경로 인자가 없으므로 대상이 아니다
// (셸은 애초에 경로 판정이 성립하지 않는다 — 워커 루트가 유일한 방어선이다).
function pathArgOf(args: Record<string, unknown>): string | undefined {
  const p = args.path;
  return typeof p === "string" && p.length > 0 ? p : undefined;
}

// 원격 호출은 실패해도 예외를 던지지 않는다 — 도구 하나의 실패가 턴 전체를 죽이면
// 모델이 다른 방법을 시도하거나 사용자에게 알릴 기회 자체가 사라진다.
//
// 경로 검사는 두 겹이다. 여기(봇)는 사용자가 allow_dir 로 관리하는 목록에 대한 1차 필터로,
// 왕복 전에 빠르게 거르고 안내 문구를 낸다. 최종 판정은 워커(remote/roots.ts)가 한다 —
// realpath·심볼릭 링크·실제 존재 여부를 아는 건 파일시스템을 가진 그쪽뿐이다.
export async function remoteToolHandler(
  ctx: ToolCtx,
  tool: string,
  args: Record<string, unknown>,
): Promise<string> {
  if (!ctx.remote) return "지금은 워커가 연결돼 있지 않아 PC 작업을 할 수 없어요.";

  // repos.allowedDirs 가 없는 호출측(예: 최소 스텁 ctx)에서는 1차 필터를 건너뛴다 — 어차피
  // 최종 판정은 워커가 하므로, 봇 쪽에서 판정 수단이 없다고 예외로 턴을 죽일 이유는 없다.
  const target = pathArgOf(args);
  if (target !== undefined && ctx.repos?.allowedDirs) {
    const allowed = await ctx.repos.allowedDirs.list(ctx.userId);
    if (allowed.length === 0) return "먼저 allow_dir 로 작업할 폴더를 허용해 주세요.";
    if (!isPathWithinAny(target, allowed)) return `허용된 폴더 밖 경로예요: ${target}`;
  }

  const r = await ctx.remote.call(tool, args);
  return r.content.length > 0 ? r.content : (r.ok ? "(완료)" : "(실패했지만 내용이 없어요)");
}
