import fs from "node:fs";
import path from "node:path";
import { isPathWithinAny } from "./paths.js";

// 원격 개발 워크플로우(Phase A) 실제 집행: canUseTool 이 경로 판정을 걸어야 하는 도구 이름 목록.
// tools.ts 의 FILE_TOOLS(+Bash) 와 동일한 이름을 미러링한다 — 도구셋 정의(tools.ts)는 건드리지 않는다.
const PATH_GATED_TOOLS = new Set(["Read", "Write", "Edit", "Glob", "Grep", "Bash"]);

export function isPathGatedTool(toolName: string): boolean {
  return PATH_GATED_TOOLS.has(toolName);
}

export type PathPermissionResult = { behavior: "allow" } | { behavior: "deny"; message: string };

// 순수 판정 함수(테스트 대상) — fs 접근 없이 이미 resolve/realpath 된 경로들만 검사한다.
export function decidePathPermission(
  toolName: string,
  resolvedPaths: string[],
  opts: { isOwnerDm: boolean; allowedDirs: string[]; dangerouslyDisableSandbox?: boolean },
): PathPermissionResult {
  if (!isPathGatedTool(toolName)) return { behavior: "allow" };
  // 보안리뷰 #2: Bash 의 dangerouslyDisableSandbox 는 남은 봉쇄(허용폴더 검사)를 무력화하므로
  // 소유자 DM·허용폴더 상태와 무관하게 무조건 거부한다.
  if (toolName === "Bash" && opts.dangerouslyDisableSandbox) {
    return { behavior: "deny", message: "샌드박스를 해제한 Bash 실행은 허용하지 않아요." };
  }
  if (!opts.isOwnerDm) return { behavior: "deny", message: "PC 작업은 소유자 DM에서만 가능해요." };
  if (opts.allowedDirs.length === 0) return { behavior: "deny", message: "먼저 allow_dir 로 작업할 폴더를 허용해 주세요." };
  for (const p of resolvedPaths) {
    if (!isPathWithinAny(p, opts.allowedDirs)) {
      return { behavior: "deny", message: `허용된 폴더 밖 경로예요: ${p}` };
    }
  }
  return { behavior: "allow" };
}

// glob 메타문자(등장하면 그 이전까지가 리터럴 경로 접두). 정규식 문자 클래스로 사용하므로 이스케이프 주의.
const GLOB_META = /[*?[{]/;

// pattern 문자열에서 첫 glob 메타문자 이전까지의 "리터럴 경로 접두"를 뽑는다. 메타문자가 없으면
// pattern 전체가 리터럴. 끝에 남은 경로 구분자(\ 또는 /)는 디렉토리 후보로 쓰기 위해 잘라낸다.
function literalPrefixOfGlobPattern(pattern: string): string {
  const idx = pattern.search(GLOB_META);
  const literal = idx === -1 ? pattern : pattern.slice(0, idx);
  return literal.replace(/[\\/]+$/, "");
}

// 최종 리뷰 FIX1(치명) — pattern/glob 문자열 어디에든 상위 디렉토리 참조("..") 세그먼트가 있는지
// 검사한다. literalPrefixOfGlobPattern 은 "첫 메타문자 이전"만 리터럴로 본다 — 패턴이 메타문자로
// 시작하면(예: "**/../../222/*.txt") 리터럴 접두가 통째로 빈 문자열이 되어, 그 뒤에 실제로 있는
// ".." 는 후보 추출 대상에서 완전히 빠졌다(리뷰 재현: 손님이 이 형태로 다른 회원의 폴더를
// 읽었다 — fs_grep 이 파일 내용까지 그대로 돌려줬다). 글롭을 실제로 풀어(tinyglobby 로) 상위
// 탈출 여부를 계산하는 대신, ".." 세그먼트가 있다는 사실 자체를 "허용 폴더를 벗어나려는 시도"로
// 간주해 무조건 벗어난 후보를 만든다 — 이 시스템에서 glob 패턴이 상위로 나가야 할 정당한 이유는
// 없다(허용 폴더를 늘리려면 소유자가 allow_dir 로 등록하면 된다).
//
// 세그먼트 경계(구분자 또는 문자열 시작/끝)로 정확히 구분해, "..hidden" 같은 리터럴 이름은
// 오탐하지 않는다 — paths.ts 의 isPathWithin 이 rel.startsWith("..") 대신 정확한 세그먼트 경계로
// 판정하는 것과 같은 이유다.
const UPWARD_SEGMENT = /(?:^|[\\/])\.\.(?:[\\/]|$)/;

function hasUpwardTraversalSegment(pattern: string): boolean {
  return UPWARD_SEGMENT.test(pattern);
}

// canUseTool 의 (toolName, input, {blockedPath}, cwd) 에서 검사할 후보 경로들을 뽑는다.
// Read/Write/Edit → file_path. Glob → path(있으면) + pattern 의 리터럴 경로 접두(보안리뷰 #1 —
// tinyglobby 는 pattern 에 절대경로·'..'를 그대로 써서 허용폴더 밖을 열거할 수 있어 반드시 검사해야 한다).
// Grep → path(있으면) + glob(검색 대상 파일 필터, 있으면)의 리터럴 경로 접두(최종 리뷰 FIX1 —
// pattern 은 정규식/검색어라 경로가 아니므로 여전히 건드리지 않지만, glob 은 Glob 의 pattern 과
// 똑같이 파일 경로를 매칭하는 글롭 문법이라 같은 이유로 검사해야 한다. path 가 허용 폴더 안이어도
// glob="../secret/**" 처럼 그 밖을 가리키면 이 후보가 없인 잡히지 않았다). Bash → blockedPath(있을 때만).
// 그 외 도구는 항상 빈 배열(경로 검사 대상이 아님, isPathGatedTool 이 false 이므로 어차피 allow 로 통과한다).
// 보안리뷰 #3: 위 규칙으로도 후보가 하나도 안 나오면(Glob/Grep 의 path 생략, Bash 의 blockedPath 없음 등)
// cwd 를 후보로 대신 넣는다 — 도구는 결국 cwd 를 기준으로 동작하므로 빈 배열=허용은 과도한 신뢰다.
export function extractCandidatePaths(
  toolName: string,
  input: Record<string, unknown>,
  blockedPath?: string,
  cwd?: string,
): string[] {
  let candidates: string[] = [];
  if (toolName === "Read" || toolName === "Write" || toolName === "Edit") {
    const fp = input.file_path;
    candidates = typeof fp === "string" && fp.length > 0 ? [fp] : [];
  } else if (toolName === "Glob") {
    const basePath = typeof input.path === "string" && input.path.length > 0 ? input.path : undefined;
    if (basePath) candidates.push(basePath);
    const pattern = input.pattern;
    if (typeof pattern === "string" && pattern.length > 0) {
      const literal = literalPrefixOfGlobPattern(pattern);
      // 리터럴 접두가 없으면(pattern 이 곧바로 메타문자로 시작) pattern 은 basePath/cwd 이상의 정보를
      // 주지 않으므로 후보를 추가하지 않는다(중복 방지 — basePath 는 이미 위에서, 없으면 아래 cwd 폴백이 처리).
      if (literal.length > 0) {
        candidates.push(path.isAbsolute(literal) ? literal : path.resolve(basePath ?? cwd ?? ".", literal));
      }
      // 최종 리뷰 FIX1(치명): 위 리터럴 접두 계산과 별개로, 메타문자 위치와 무관하게 pattern
      // 전체에 ".." 세그먼트가 있으면 반드시 벗어난 것으로 취급할 후보를 추가한다 — 메타문자가
      // 접두 맨 앞에 오면(literal="") 이 후보가 유일한 방어선이다. basePath(또는 cwd)의 한 단계
      // 위를 후보로 쓴다 — basePath 자신은 이미 허용 폴더 안이라고 검증될 값이므로, 그 부모는
      // (같은 부모를 공유하는 다른 허용 폴더가 없는 한) 항상 벗어난 값이다.
      if (hasUpwardTraversalSegment(pattern)) {
        candidates.push(path.resolve(basePath ?? cwd ?? ".", ".."));
      }
    }
  } else if (toolName === "Grep") {
    const basePath = typeof input.path === "string" && input.path.length > 0 ? input.path : undefined;
    if (basePath) candidates.push(basePath);
    // 최종 리뷰 FIX1(치명): glob 인자도 Glob 의 pattern 과 동일한 방식으로 검사한다.
    const globArg = input.glob;
    if (typeof globArg === "string" && globArg.length > 0) {
      const literal = literalPrefixOfGlobPattern(globArg);
      if (literal.length > 0) {
        candidates.push(path.isAbsolute(literal) ? literal : path.resolve(basePath ?? cwd ?? ".", literal));
      }
      // 최종 리뷰 FIX1: Glob 분기와 동일한 이유로, glob 전체에 ".." 세그먼트가 있으면(메타문자가
      // 접두 맨 앞에 와도) 무조건 벗어난 후보를 추가한다. pattern(정규식)은 여전히 건드리지 않는다.
      if (hasUpwardTraversalSegment(globArg)) {
        candidates.push(path.resolve(basePath ?? cwd ?? ".", ".."));
      }
    }
  } else if (toolName === "Bash") {
    candidates = blockedPath ? [blockedPath] : [];
  }
  if (candidates.length === 0 && isPathGatedTool(toolName) && cwd) {
    candidates = [cwd];
  }
  return candidates;
}

// 심볼릭 링크로 허용 폴더를 우회하는 걸 막기 위해 실경로로 정규화한다.
// 존재하면 fs.realpathSync 그대로. 존재하지 않으면(예: 새로 만들 파일) 존재하는 가장 가까운
// 조상 디렉토리까지 올라가 그 조상만 realpath 하고, 나머지 경로 조각을 이어붙여 돌려준다.
// 그 어떤 조상도 존재하지 않으면(드라이브/루트까지 없음) 정규화된 원본 경로로 안전하게 대체한다.
export function resolveRealOrNearestAncestor(target: string): string {
  const resolved = path.resolve(target);
  try {
    return fs.realpathSync(resolved);
  } catch {
    // 존재하지 않음 — 조상을 찾아 올라간다.
  }
  const remaining: string[] = [path.basename(resolved)];
  let dir = path.dirname(resolved);
  while (true) {
    try {
      const realDir = fs.realpathSync(dir);
      return path.join(realDir, ...remaining.reverse());
    } catch {
      const parent = path.dirname(dir);
      if (parent === dir) return resolved; // 루트까지 존재하는 조상이 없음 — 정규화된 원본으로 대체
      remaining.push(path.basename(dir));
      dir = parent;
    }
  }
}
