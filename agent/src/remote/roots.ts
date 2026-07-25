import { resolveRealOrNearestAncestor } from "../core/pathPermission.js";
import { isPathWithinAny } from "../core/paths.js";

export type PathCheck = { ok: true; path: string } | { ok: false; message: string };

// 워커의 최종 경로 관문. 봇 쪽 allowed_dirs 를 통과했더라도 여기서 다시 판정한다 —
// 심볼릭 링크·'..'·존재하지 않는 경로의 실제 위치를 아는 건 파일시스템을 가진 이 프로세스뿐이다.
// 정규화 규칙은 기존 canUseTool 경로 게이트와 동일한 함수를 재사용한다(동작이 갈리지 않게).
export function checkPath(target: string, roots: string[]): PathCheck {
  if (roots.length === 0) return { ok: false, message: "워커에 열린 작업 폴더가 없어요." };
  const resolved = resolveRealOrNearestAncestor(target);
  if (!isPathWithinAny(resolved, roots)) {
    return { ok: false, message: `워커 작업 폴더 밖 경로예요: ${resolved}` };
  }
  return { ok: true, path: resolved };
}
