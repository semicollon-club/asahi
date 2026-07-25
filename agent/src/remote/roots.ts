import { resolveRealOrNearestAncestor } from "../core/pathPermission.js";
import { isPathWithinAny } from "../core/paths.js";
import { isAbsolute } from "node:path";

export type PathCheck = { ok: true; path: string } | { ok: false; message: string };

// 윈도우에서 "드라이브 문자(C:\...)" 또는 "UNC(\\server\share\...)"로 시작하는지 검사한다.
// path.isAbsolute 는 "/workspace"·"\foo" 처럼 드라이브 문자 없이 구분자 하나로만 시작하는 경로도
// true 를 돌려주지만, 그런 경로를 path.resolve 에 넣으면 process.cwd() 의 "현재 드라이브"를 그대로
// 채워 넣는다 — 즉 같은 루트 문자열이 워커 프로세스의 cwd 드라이브에 따라 매번 다른 폴더를 가리킬 수
// 있다. 드라이브 문자·UNC 접두는 cwd 와 무관하게 고정되므로, 이 두 형태만 "모호하지 않다"고 인정한다.
function hasUnambiguousWindowsRoot(root: string): boolean {
  return /^(?:[a-zA-Z]:[\\/]|[\\/]{2}[^\\/])/.test(root);
}

// 워커의 최종 경로 관문. 봇 쪽 allowed_dirs 를 통과했더라도 여기서 다시 판정한다 —
// 심볼릭 링크·'..'·존재하지 않는 경로의 실제 위치를 아는 건 파일시스템을 가진 이 프로세스뿐이다.
// 정규화 규칙은 기존 canUseTool 경로 게이트와 동일한 함수를 재사용한다(동작이 갈리지 않게).
export function checkPath(target: string, roots: string[]): PathCheck {
  if (roots.length === 0) return { ok: false, message: "워커에 열린 작업 폴더가 없어요." };

  // 루트 설정이 "모호하지 않은" 절대경로인지 검증한다. 상대경로·빈 문자열은 물론, 윈도우에서 드라이브
  // 문자·UNC 없이 구분자로만 시작하는 경로(예: "/workspace")도 거부한다 — path.isAbsolute 만으로는
  // 이런 경로가 걸러지지 않는데, runtime 에 process.cwd() 의 드라이브가 바뀌면 예상치 못한 드라이브의
  // 폴더를 노출할 수 있기 때문이다(POSIX 는 드라이브 개념이 없어 '/' 로 시작하면 그 자체로 모호하지
  // 않다). 잘못된 루트를 조용히 필터링하지 않고 전체를 거부해야 워커의 루트 설정이 부분적으로 잘못된
  // 경우 명확히 드러난다.
  for (const root of roots) {
    const isUnambiguous = process.platform === "win32" ? hasUnambiguousWindowsRoot(root) : isAbsolute(root);
    if (!isUnambiguous) {
      return {
        ok: false,
        message: `워커 루트 설정이 잘못됐어요: "${root}" — 절대경로여야 합니다(윈도우는 드라이브 문자·UNC 필요).`,
      };
    }
  }

  const resolved = resolveRealOrNearestAncestor(target);
  if (!isPathWithinAny(resolved, roots)) {
    return { ok: false, message: `워커 작업 폴더 밖 경로예요: ${resolved}` };
  }
  return { ok: true, path: resolved };
}
