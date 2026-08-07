import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  isPathGatedTool, extractCandidatePaths, resolveRealOrNearestAncestor,
} from "../src/core/pathPermission.js";
import { isPathWithinAny } from "../src/core/paths.js";

describe("isPathGatedTool — 경로 집행 대상 판정", () => {
  it("파일계열·Bash 는 대상이다", () => {
    expect(isPathGatedTool("Read")).toBe(true);
    expect(isPathGatedTool("Write")).toBe(true);
    expect(isPathGatedTool("Edit")).toBe(true);
    expect(isPathGatedTool("Glob")).toBe(true);
    expect(isPathGatedTool("Grep")).toBe(true);
    expect(isPathGatedTool("Bash")).toBe(true);
  });

  it("mcp 도구·기타 도구는 대상이 아니다", () => {
    expect(isPathGatedTool("mcp__asahi__remember")).toBe(false);
    expect(isPathGatedTool("mcp__asahi__recall")).toBe(false);
    expect(isPathGatedTool("WebSearch")).toBe(false);
    expect(isPathGatedTool("Task")).toBe(false);
  });
});

// decidePathPermission(옛 canUseTool 전용 최종 allow/deny 판정 함수)은 최종 pre-merge 리뷰
// FIX6 에서 삭제했다 — grep 으로 확인한 프로덕션 호출자가 이 파일과 테스트뿐이었다(canUseTool
// 자체가 얇은 워커 전환으로 이미 삭제됨). 남겨 두면 "PC 작업은 소유자 DM에서만 가능해요"라는,
// 이 브랜치가 뒤집은 정책을 그대로 반환하는 죽은 함수가 재사용의 근거처럼 보일 위험이 있었다.
// 그 함수가 검증하던 "후보 경로가 허용 폴더 안인가"는 지금 프로덕션이 실제로 쓰는 판정
// (remoteToolHandler 의 isPathWithinAny 호출)로 아래 통합 테스트를 다시 썼다.
describe("extractCandidatePaths — canUseTool 입력에서 경로 추출", () => {
  it("Read/Write/Edit 는 file_path 를 뽑는다", () => {
    expect(extractCandidatePaths("Read", { file_path: "C:\\a\\b.txt" })).toEqual(["C:\\a\\b.txt"]);
    expect(extractCandidatePaths("Write", { file_path: "C:\\a\\b.txt", content: "x" })).toEqual(["C:\\a\\b.txt"]);
    expect(extractCandidatePaths("Edit", { file_path: "C:\\a\\b.txt" })).toEqual(["C:\\a\\b.txt"]);
  });

  it("Glob/Grep 는 path 가 있으면 뽑고 없으면 빈 배열", () => {
    expect(extractCandidatePaths("Glob", { pattern: "*.ts", path: "C:\\a" })).toEqual(["C:\\a"]);
    expect(extractCandidatePaths("Grep", { pattern: "foo" })).toEqual([]);
  });

  it("Bash 는 blockedPath 가 있으면 뽑고 없으면 빈 배열", () => {
    expect(extractCandidatePaths("Bash", { command: "ls" }, "C:\\a")).toEqual(["C:\\a"]);
    expect(extractCandidatePaths("Bash", { command: "ls" })).toEqual([]);
  });

  it("그 외 도구는 항상 빈 배열", () => {
    expect(extractCandidatePaths("mcp__asahi__remember", { title: "t", content: "c" })).toEqual([]);
  });

  // 기대값을 host `path` 가 아니라 `path.win32` 로 만든다. 이 블록 아래의 base 는 전부
  // `C:\proj\a` 같은 윈도우 경로이고, 구현(pathPermission.ts 의 resolveAgainstBase)은
  // process.platform 이 아니라 **문자열 자신의 생김새**로 win32/posix 를 고른다 — 리눅스 봇이
  // 윈도우 워커의 경로를 다뤄야 해서 일부러 그렇게 만든 것이다(paths.ts 의 pathFlavorOf).
  //
  // 기대값을 host `path.resolve` 로 만들면 그 계약을 검증하지 못하고 **테스트가 도는 플랫폼을
  // 따라간다**: 윈도우에서는 우연히 맞고, 리눅스에서는 `C:\proj\a` 를 상대경로로 봐서
  // `/home/runner/.../agent/C:\proj\a/sub` 를 기대하게 되어 실패한다. 2026-08-07 CI 를 처음
  // 붙였을 때 이 파일에서만 27건이 그 이유로 깨졌다(윈도우 잡은 통과, 리눅스 잡만 실패).
  // 구현은 멀쩡했고 기대값이 틀렸던 것이다.
  //
  // 아래 §"실제 경로 문자열" 블록이 같은 이유로 이미 기대값을 리터럴로 적고 있다 — 그 블록만
  // 고쳐졌고 이 블록들이 남아 있었다.
  describe("Glob pattern 경로 집행(보안리뷰 #1) — pattern 도 검사 후보에 넣는다", () => {
    it("path 없이 pattern 이 절대경로면 그 리터럴 접두를 후보로 뽑는다", () => {
      expect(extractCandidatePaths("Glob", { pattern: "C:\\other\\**" })).toEqual(["C:\\other"]);
    });

    it("path 있고 pattern 이 ../ 로 상위 탈출하면 결합·정규화된 경로가 후보에 포함된다", () => {
      const result = extractCandidatePaths("Glob", { path: "C:\\proj\\a", pattern: "../../x/**" });
      expect(result).toContain("C:\\proj\\a");
      expect(result).toContain(path.win32.resolve("C:\\proj\\a", "../../x"));
    });

    it("path 있고 pattern 이 하위 상대경로면 결합한 경로가 후보에 포함된다", () => {
      const result = extractCandidatePaths("Glob", { path: "C:\\proj\\a", pattern: "sub/**" });
      expect(result).toContain(path.win32.resolve("C:\\proj\\a", "sub"));
    });

    it("path 없고 pattern 이 상대경로면 cwd 기준으로 resolve 한다", () => {
      const result = extractCandidatePaths("Glob", { pattern: "sub/**" }, undefined, "C:\\proj\\a");
      expect(result).toContain(path.win32.resolve("C:\\proj\\a", "sub"));
    });

    it("pattern 이 메타문자로 시작해 리터럴 접두가 없으면 pattern 후보를 추가하지 않는다(중복 방지)", () => {
      expect(extractCandidatePaths("Glob", { pattern: "*.ts", path: "C:\\a" })).toEqual(["C:\\a"]);
    });

    it("Grep 의 pattern 은 정규식이므로 건드리지 않는다(메타문자가 있어도 무시)", () => {
      expect(extractCandidatePaths("Grep", { pattern: "a*b[c]{2}" })).toEqual([]);
      expect(extractCandidatePaths("Grep", { pattern: "a*b", path: "C:\\a" })).toEqual(["C:\\a"]);
    });
  });

  // FIX1(치명) — fs_grep 의 glob 인자(검색 대상 파일 필터)는 Glob 의 pattern 과 똑같이 파일
  // 경로를 매칭하는 글롭 문법이라 경로를 담을 수 있다. pattern(정규식·검색어)과 달리 glob 은
  // 반드시 검사해야 한다 — 그동안 이 분기가 glob 을 건드리지 않아, path 가 허용 폴더 안이어도
  // glob="../secret/**" 로 그 밖을 가리키면 후보에 전혀 잡히지 않았다(리뷰 재현: remoteTools.test.ts
  // 참고).
  describe("Grep glob 경로 집행(FIX1) — glob 도 검사 후보에 넣는다", () => {
    it("path 없이 glob 이 절대경로면 그 리터럴 접두를 후보로 뽑는다", () => {
      expect(extractCandidatePaths("Grep", { pattern: "foo", glob: "C:\\other\\**" })).toEqual(["C:\\other"]);
    });

    it("path 있고 glob 이 ../ 로 상위 탈출하면 결합·정규화된 경로가 후보에 포함된다", () => {
      const result = extractCandidatePaths("Grep", { pattern: "foo", path: "C:\\proj\\a", glob: "../../x/**" });
      expect(result).toContain("C:\\proj\\a");
      expect(result).toContain(path.win32.resolve("C:\\proj\\a", "../../x"));
    });

    it("path 있고 glob 이 하위 상대경로면 결합한 경로가 후보에 포함된다", () => {
      const result = extractCandidatePaths("Grep", { pattern: "foo", path: "C:\\proj\\a", glob: "sub/**" });
      expect(result).toContain(path.win32.resolve("C:\\proj\\a", "sub"));
    });

    it("path 없고 glob 이 상대경로면 cwd 기준으로 resolve 한다", () => {
      const result = extractCandidatePaths("Grep", { pattern: "foo", glob: "sub/**" }, undefined, "C:\\proj\\a");
      expect(result).toContain(path.win32.resolve("C:\\proj\\a", "sub"));
    });

    it("glob 이 메타문자로 시작해 리터럴 접두가 없으면 glob 후보를 추가하지 않는다(중복 방지)", () => {
      expect(extractCandidatePaths("Grep", { pattern: "foo", glob: "*.ts", path: "C:\\a" })).toEqual(["C:\\a"]);
    });

    it("glob 이 아예 없으면(기존 동작) path 만 후보로 남는다(회귀 없음)", () => {
      expect(extractCandidatePaths("Grep", { pattern: "foo", path: "C:\\a" })).toEqual(["C:\\a"]);
      expect(extractCandidatePaths("Grep", { pattern: "foo" })).toEqual([]);
    });
  });

  // 최종 리뷰 FIX1(치명) — literalPrefixOfGlobPattern 은 "첫 메타문자 이전"만 리터럴로 본다.
  // 패턴이 메타문자로 시작하면(예: "**/../../222/*.txt") 리터럴 접두가 통째로 빈 문자열이 되어
  // 그 뒤의 ".." 가 후보 추출에서 완전히 빠졌다(리뷰 재현: 손님이 이 형태로 다른 회원의 폴더를
  // 읽었다). 메타문자가 어디 있든 ".." 세그먼트가 있으면 항상 벗어난 후보를 만들어야 한다.
  describe("Glob/Grep pattern·glob 의 상위 탈출은 메타문자 위치와 무관하게 차단된다(최종 리뷰 FIX1)", () => {
    const base = "C:\\proj\\a";

    it("Glob: '**/../x' — 메타문자(**)로 시작해도 벗어난 후보를 만든다", () => {
      const result = extractCandidatePaths("Glob", { path: base, pattern: "**/../x" });
      expect(result).toContain(path.win32.resolve(base, ".."));
    });

    it("Glob: '*/../x' — 단일 메타문자(*)로 시작해도 벗어난 후보를 만든다", () => {
      const result = extractCandidatePaths("Glob", { path: base, pattern: "*/../x" });
      expect(result).toContain(path.win32.resolve(base, ".."));
    });

    it("Glob: '[a]/../x' — 문자 클래스로 시작해도 벗어난 후보를 만든다", () => {
      const result = extractCandidatePaths("Glob", { path: base, pattern: "[a]/../x" });
      expect(result).toContain(path.win32.resolve(base, ".."));
    });

    it("Glob: '{a,b}/../x' — 브레이스로 시작해도 벗어난 후보를 만든다", () => {
      const result = extractCandidatePaths("Glob", { path: base, pattern: "{a,b}/../x" });
      expect(result).toContain(path.win32.resolve(base, ".."));
    });

    it("Glob: 선행 '..'(메타문자 없음) — 기존에도 리터럴 접두로 잡혔지만 회귀로 다시 확인", () => {
      const result = extractCandidatePaths("Glob", { path: base, pattern: "../x" });
      expect(result).toContain(path.win32.resolve(base, "../x"));
    });

    it("Grep: glob='**/../x' — 메타문자로 시작해도 벗어난 후보를 만든다", () => {
      const result = extractCandidatePaths("Grep", { pattern: "foo", path: base, glob: "**/../x" });
      expect(result).toContain(path.win32.resolve(base, ".."));
    });

    it("Grep: glob='*/../x' — 단일 메타문자로 시작해도 벗어난 후보를 만든다", () => {
      const result = extractCandidatePaths("Grep", { pattern: "foo", path: base, glob: "*/../x" });
      expect(result).toContain(path.win32.resolve(base, ".."));
    });

    it("Grep: glob='[a]/../x' — 문자 클래스로 시작해도 벗어난 후보를 만든다", () => {
      const result = extractCandidatePaths("Grep", { pattern: "foo", path: base, glob: "[a]/../x" });
      expect(result).toContain(path.win32.resolve(base, ".."));
    });

    it("Grep: glob='{a,b}/../x' — 브레이스로 시작해도 벗어난 후보를 만든다", () => {
      const result = extractCandidatePaths("Grep", { pattern: "foo", path: base, glob: "{a,b}/../x" });
      expect(result).toContain(path.win32.resolve(base, ".."));
    });

    it("Grep: 선행 '..'(메타문자 없음) — 기존에도 리터럴 접두로 잡혔지만 회귀로 다시 확인", () => {
      const result = extractCandidatePaths("Grep", { pattern: "foo", path: base, glob: "../x" });
      expect(result).toContain(path.win32.resolve(base, "../x"));
    });

    // decidePathPermission 삭제(최종 pre-merge 리뷰 FIX6)로, "이 후보가 실제로 허용 폴더 판정에서
    // deny/allow 로 이어지는가"는 이제 프로덕션이 실제로 쓰는 판정 함수(paths.ts 의
    // isPathWithinAny — remoteToolHandler 가 그대로 호출한다)로 직접 확인한다.
    it("긍정 사례 — 평범한 재귀 글롭('**/*.ts')은 상위 탈출 후보를 추가하지 않고 그대로 통과한다", () => {
      const candidates = extractCandidatePaths("Glob", { path: base, pattern: "**/*.ts" });
      expect(candidates).toEqual([base]);
      expect(candidates.every((c) => isPathWithinAny(c, [base]))).toBe(true);
    });

    it("긍정 사례 — 메타문자 시작 패턴의 상위 탈출 후보는 허용 폴더 밖으로 판정된다", () => {
      for (const pattern of ["**/../x", "*/../x", "[a]/../x", "{a,b}/../x"]) {
        const candidates = extractCandidatePaths("Glob", { path: base, pattern });
        expect(candidates.some((c) => !isPathWithinAny(c, [base]))).toBe(true);
      }
    });

    it("'..' 를 포함하지 않는 일반 문자열(예: '..hidden')은 오탐하지 않는다", () => {
      // 세그먼트 경계 밖의 '..'(리터럴 디렉토리 이름의 일부)는 상위 탈출로 취급하지 않는다.
      const result = extractCandidatePaths("Glob", { path: base, pattern: "*/foo..bar/x" });
      expect(result).not.toContain(path.win32.resolve(base, ".."));
    });
  });

  describe("후보가 비면 cwd 를 후보로 넣는다(보안리뷰 #3)", () => {
    it("Bash: blockedPath 없고 cwd 있으면 cwd 를 후보로", () => {
      expect(extractCandidatePaths("Bash", { command: "ls" }, undefined, "C:\\proj\\a")).toEqual(["C:\\proj\\a"]);
    });

    it("Glob: path/pattern 둘 다 없고 cwd 있으면 cwd 를 후보로", () => {
      expect(extractCandidatePaths("Glob", {}, undefined, "C:\\proj\\a")).toEqual(["C:\\proj\\a"]);
    });

    it("Grep: path 없고 cwd 있으면 cwd 를 후보로", () => {
      expect(extractCandidatePaths("Grep", { pattern: "foo" }, undefined, "C:\\proj\\a")).toEqual(["C:\\proj\\a"]);
    });

    it("cwd 도 없으면 기존처럼 빈 배열(회귀 유지)", () => {
      expect(extractCandidatePaths("Bash", { command: "ls" })).toEqual([]);
    });
  });

  describe("통합: extractCandidatePaths → isPathWithinAny (보안리뷰 #1/#3 시나리오, 프로덕션이 실제로 쓰는 판정)", () => {
    const allowedDirs = ["C:\\proj\\a"];
    const anyOutside = (candidates: string[]) => candidates.some((c) => !isPathWithinAny(c, allowedDirs));

    it("Glob {pattern: 절대경로}(path 없음) → 허용폴더 밖이면 deny", () => {
      const candidates = extractCandidatePaths("Glob", { pattern: "C:\\other\\**" });
      expect(anyOutside(candidates)).toBe(true);
    });

    it("Glob {path: 허용, pattern: '../../x/**'} → 밖이면 deny", () => {
      const candidates = extractCandidatePaths("Glob", { path: "C:\\proj\\a", pattern: "../../x/**" });
      expect(anyOutside(candidates)).toBe(true);
    });

    it("FIX1 — Grep {path: 허용, glob: '../../x/**'} → 밖이면 deny", () => {
      const candidates = extractCandidatePaths("Grep", { pattern: "foo", path: "C:\\proj\\a", glob: "../../x/**" });
      expect(anyOutside(candidates)).toBe(true);
    });

    it("Glob {path: 허용, pattern: 'sub/**'} → 안이면 allow", () => {
      const candidates = extractCandidatePaths("Glob", { path: "C:\\proj\\a", pattern: "sub/**" });
      expect(anyOutside(candidates)).toBe(false);
    });

    it("후보가 빈 경우 cwd 로 대체되고, cwd 가 밖이면 deny", () => {
      const candidates = extractCandidatePaths("Bash", { command: "ls" }, undefined, "C:\\other");
      expect(anyOutside(candidates)).toBe(true);
    });

    it("후보가 빈 경우 cwd 로 대체되고, cwd 가 안이면 allow", () => {
      const candidates = extractCandidatePaths("Bash", { command: "ls" }, undefined, "C:\\proj\\a\\sub");
      expect(anyOutside(candidates)).toBe(false);
    });
  });

  // 최종 pre-merge 리뷰 FIX2(중요) — extractCandidatePaths 는 이제 대상 문자열의 생김새로
  // 플레이버를 고른다(paths.ts 의 pathFlavorOf 재사용, isPathWithin 이 이미 쓰는 것과 같은 원칙).
  // 이전에는 node:path 의 기본 export(host 프로세스의 process.platform 을 따름)를 그대로 썼다 —
  // 봇은 리눅스(Railway)에서 돌고 base(허용 폴더·워커 루트)는 윈도우 워커의 경로일 수 있어,
  // 리눅스 host 에서 `path.win32.resolve("C:\\ws\\111", "src")` 를 부르면 역슬래시가 구분자로 인식되지
  // 않아 완전히 엉뚱한 값이 나왔다(리뷰 재현: fs_glob(path=손님 루트, pattern='src/**/*.ts') 가
  // 정상 호출인데도 "허용된 폴더 밖"으로 거부됐다). 아래 기대값은 host `path.resolve` 로 만들지
  // 않고 문자열 리터럴로 직접 적는다 — host `path.resolve` 로 기대값을 만들면 이 테스트를 도는
  // 기계가 우연히 같은 플레이버일 때만 통과하는, 바로 그 함정에 빠진다(이 리포의 CI/개발 환경이
  // 어느 플랫폼이든 이 describe 는 항상 같은 결과를 내야 한다).
  describe("extractCandidatePaths 는 대상 경로의 플레이버를 따른다 — host 플랫폼과 무관하다(최종 pre-merge 리뷰 FIX2)", () => {
    it("윈도우 스타일 base + 상대 pattern → 윈도우 규칙으로 결합한다(host 가 POSIX 여도)", () => {
      const result = extractCandidatePaths("Glob", { path: String.raw`C:\ws\111`, pattern: "src/**/*.ts" });
      expect(result).toContain(String.raw`C:\ws\111\src`);
    });

    it("윈도우 스타일 base + 상위 탈출 pattern → 윈도우 규칙으로 부모를 계산한다", () => {
      const result = extractCandidatePaths("Glob", { path: String.raw`C:\ws\111`, pattern: "**/../x" });
      expect(result).toContain(String.raw`C:\ws`);
    });

    it("POSIX 스타일 base + 상대 pattern → POSIX 규칙으로 결합한다", () => {
      const result = extractCandidatePaths("Glob", { path: "/srv/ws/111", pattern: "src/**/*.ts" });
      expect(result).toContain("/srv/ws/111/src");
    });

    it("POSIX 스타일 base + 상위 탈출 pattern → POSIX 규칙으로 부모를 계산한다", () => {
      const result = extractCandidatePaths("Glob", { path: "/srv/ws/111", pattern: "**/../x" });
      expect(result).toContain("/srv/ws");
    });

    it("path 생략 + 윈도우 스타일 cwd(allowed[0] 대체값) → 윈도우 규칙을 따른다", () => {
      const result = extractCandidatePaths("Glob", { pattern: "src/**/*.ts" }, undefined, String.raw`C:\ws\111`);
      expect(result).toContain(String.raw`C:\ws\111\src`);
    });

    it("Grep 의 glob 인자도 동일하게 대상 플레이버를 따른다(fs_grep 경로)", () => {
      const result = extractCandidatePaths("Grep", { pattern: "TODO", path: String.raw`C:\ws\111`, glob: "src/*.ts" });
      expect(result).toContain(String.raw`C:\ws\111\src`);
    });

    it("literal 자체가 절대경로면(예: pattern 이 통째로 다른 드라이브를 가리킴) base 의 플레이버와 무관하게 literal 자신의 플레이버를 따른다", () => {
      // base 는 POSIX 모양이지만 pattern 의 리터럴 접두 자신은 윈도우 절대경로다 — literal 이
      // 스스로 밝히는 플레이버가 이긴다(paths.ts 의 normalizeDir 과 같은 원칙).
      const result = extractCandidatePaths("Glob", { path: "/srv/ws", pattern: String.raw`C:\other\**` });
      expect(result).toContain(String.raw`C:\other`);
    });

    it("실제 리뷰 시나리오 재현 — 손님 루트(윈도우)에서 path 지정 + 평범한 상대 glob 은 자기 폴더 안으로 판정된다", () => {
      const guestRoot = String.raw`C:\ws\111`;
      const candidates = extractCandidatePaths("Glob", { path: guestRoot, pattern: "src/**/*.ts" });
      expect(candidates.every((c) => isPathWithinAny(c, [guestRoot]))).toBe(true);
    });

    it("실제 리뷰 시나리오 재현 — 같은 상황에서 상위 탈출 시도는 여전히 허용 폴더 밖으로 판정된다", () => {
      const guestRoot = String.raw`C:\ws\111`;
      const candidates = extractCandidatePaths("Glob", { path: guestRoot, pattern: "**/../222/*.txt" });
      expect(candidates.some((c) => !isPathWithinAny(c, [guestRoot]))).toBe(true);
    });
  });
});

describe("resolveRealOrNearestAncestor — 심볼릭 링크 우회 방지용 realpath 정규화", () => {
  let tmp: string;

  it("존재하는 경로는 realpathSync 그대로 반환한다", () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "asahi-realpath-"));
    const real = resolveRealOrNearestAncestor(tmp);
    expect(real).toBe(fs.realpathSync(tmp));
  });

  it("존재하지 않는 파일 경로는 가장 가까운 조상을 realpath 하고 나머지를 이어붙인다", () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "asahi-realpath-"));
    const target = path.join(tmp, "new-file.txt");
    const result = resolveRealOrNearestAncestor(target);
    expect(result).toBe(path.join(fs.realpathSync(tmp), "new-file.txt"));
  });

  it("존재하지 않는 중첩 디렉토리도 존재하는 조상까지 올라가 realpath 한다", () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "asahi-realpath-"));
    const target = path.join(tmp, "sub", "deeper", "new-file.txt");
    const result = resolveRealOrNearestAncestor(target);
    expect(result).toBe(path.join(fs.realpathSync(tmp), "sub", "deeper", "new-file.txt"));
  });
});
