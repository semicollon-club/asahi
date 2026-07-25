import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  decidePathPermission, isPathGatedTool, extractCandidatePaths, resolveRealOrNearestAncestor,
} from "../src/core/pathPermission.js";

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

describe("decidePathPermission — 순수 판정 함수", () => {
  it("파일도구·허용폴더 내부 경로면 allow", () => {
    const result = decidePathPermission("Read", ["C:\\proj\\a\\file.txt"], {
      isOwnerDm: true,
      allowedDirs: ["C:\\proj\\a"],
    });
    expect(result).toEqual({ behavior: "allow" });
  });

  it("파일도구·허용폴더 밖 경로면 deny(경로를 메시지에 포함)", () => {
    const result = decidePathPermission("Write", ["C:\\other\\file.txt"], {
      isOwnerDm: true,
      allowedDirs: ["C:\\proj\\a"],
    });
    expect(result.behavior).toBe("deny");
    expect((result as { message: string }).message).toContain("C:\\other\\file.txt");
  });

  it("여러 경로 중 하나라도 밖이면 deny", () => {
    const result = decidePathPermission("Edit", ["C:\\proj\\a\\ok.txt", "C:\\proj\\b\\bad.txt"], {
      isOwnerDm: true,
      allowedDirs: ["C:\\proj\\a"],
    });
    expect(result.behavior).toBe("deny");
  });

  it("허용폴더가 비어있으면(파일도구) deny", () => {
    const result = decidePathPermission("Read", ["C:\\proj\\a\\file.txt"], {
      isOwnerDm: true,
      allowedDirs: [],
    });
    expect(result.behavior).toBe("deny");
    expect((result as { message: string }).message).toContain("allow_dir");
  });

  it("손님 DM(isOwnerDm=false) 이면 허용폴더·경로 상관없이 deny", () => {
    const result = decidePathPermission("Read", ["C:\\proj\\a\\file.txt"], {
      isOwnerDm: false,
      allowedDirs: ["C:\\proj\\a"],
    });
    expect(result.behavior).toBe("deny");
    expect((result as { message: string }).message).toContain("소유자 DM");
  });

  it("비파일·비Bash 도구(mcp__asahi__remember 등)는 항상 allow", () => {
    expect(decidePathPermission("mcp__asahi__remember", [], { isOwnerDm: false, allowedDirs: [] }))
      .toEqual({ behavior: "allow" });
    expect(decidePathPermission("WebSearch", ["C:\\anything"], { isOwnerDm: true, allowedDirs: [] }))
      .toEqual({ behavior: "allow" });
  });

  describe("Bash", () => {
    it("소유자 DM·허용폴더 있음·경로가 허용폴더 내부면 allow", () => {
      const result = decidePathPermission("Bash", ["C:\\proj\\a\\sub"], {
        isOwnerDm: true,
        allowedDirs: ["C:\\proj\\a"],
      });
      expect(result).toEqual({ behavior: "allow" });
    });

    it("경로 없이(빈 배열) 소유자 DM·허용폴더 있음이면 allow(cwd 내부로 간주)", () => {
      const result = decidePathPermission("Bash", [], {
        isOwnerDm: true,
        allowedDirs: ["C:\\proj\\a"],
      });
      expect(result).toEqual({ behavior: "allow" });
    });

    it("blockedPath 가 허용폴더 밖이면 deny", () => {
      const result = decidePathPermission("Bash", ["C:\\other"], {
        isOwnerDm: true,
        allowedDirs: ["C:\\proj\\a"],
      });
      expect(result.behavior).toBe("deny");
    });

    it("허용폴더가 비어있으면 경로 유무와 상관없이 deny", () => {
      expect(decidePathPermission("Bash", [], { isOwnerDm: true, allowedDirs: [] }).behavior).toBe("deny");
      expect(decidePathPermission("Bash", ["C:\\proj\\a"], { isOwnerDm: true, allowedDirs: [] }).behavior).toBe("deny");
    });

    it("소유자 DM 이 아니면 경로 유무와 상관없이 deny", () => {
      expect(decidePathPermission("Bash", [], { isOwnerDm: false, allowedDirs: ["C:\\proj\\a"] }).behavior).toBe("deny");
    });

    it("dangerouslyDisableSandbox=true 면 소유자 DM·허용폴더 내부라도 무조건 deny(보안리뷰 #2)", () => {
      const result = decidePathPermission("Bash", ["C:\\proj\\a\\sub"], {
        isOwnerDm: true,
        allowedDirs: ["C:\\proj\\a"],
        dangerouslyDisableSandbox: true,
      });
      expect(result.behavior).toBe("deny");
    });

    it("dangerouslyDisableSandbox 가 없거나 false 면 기존 판정을 그대로 따른다", () => {
      expect(
        decidePathPermission("Bash", ["C:\\proj\\a\\sub"], {
          isOwnerDm: true,
          allowedDirs: ["C:\\proj\\a"],
          dangerouslyDisableSandbox: false,
        }),
      ).toEqual({ behavior: "allow" });
    });
  });
});

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

  describe("Glob pattern 경로 집행(보안리뷰 #1) — pattern 도 검사 후보에 넣는다", () => {
    it("path 없이 pattern 이 절대경로면 그 리터럴 접두를 후보로 뽑는다", () => {
      expect(extractCandidatePaths("Glob", { pattern: "C:\\other\\**" })).toEqual(["C:\\other"]);
    });

    it("path 있고 pattern 이 ../ 로 상위 탈출하면 결합·정규화된 경로가 후보에 포함된다", () => {
      const result = extractCandidatePaths("Glob", { path: "C:\\proj\\a", pattern: "../../x/**" });
      expect(result).toContain("C:\\proj\\a");
      expect(result).toContain(path.resolve("C:\\proj\\a", "../../x"));
    });

    it("path 있고 pattern 이 하위 상대경로면 결합한 경로가 후보에 포함된다", () => {
      const result = extractCandidatePaths("Glob", { path: "C:\\proj\\a", pattern: "sub/**" });
      expect(result).toContain(path.resolve("C:\\proj\\a", "sub"));
    });

    it("path 없고 pattern 이 상대경로면 cwd 기준으로 resolve 한다", () => {
      const result = extractCandidatePaths("Glob", { pattern: "sub/**" }, undefined, "C:\\proj\\a");
      expect(result).toContain(path.resolve("C:\\proj\\a", "sub"));
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
      expect(result).toContain(path.resolve("C:\\proj\\a", "../../x"));
    });

    it("path 있고 glob 이 하위 상대경로면 결합한 경로가 후보에 포함된다", () => {
      const result = extractCandidatePaths("Grep", { pattern: "foo", path: "C:\\proj\\a", glob: "sub/**" });
      expect(result).toContain(path.resolve("C:\\proj\\a", "sub"));
    });

    it("path 없고 glob 이 상대경로면 cwd 기준으로 resolve 한다", () => {
      const result = extractCandidatePaths("Grep", { pattern: "foo", glob: "sub/**" }, undefined, "C:\\proj\\a");
      expect(result).toContain(path.resolve("C:\\proj\\a", "sub"));
    });

    it("glob 이 메타문자로 시작해 리터럴 접두가 없으면 glob 후보를 추가하지 않는다(중복 방지)", () => {
      expect(extractCandidatePaths("Grep", { pattern: "foo", glob: "*.ts", path: "C:\\a" })).toEqual(["C:\\a"]);
    });

    it("glob 이 아예 없으면(기존 동작) path 만 후보로 남는다(회귀 없음)", () => {
      expect(extractCandidatePaths("Grep", { pattern: "foo", path: "C:\\a" })).toEqual(["C:\\a"]);
      expect(extractCandidatePaths("Grep", { pattern: "foo" })).toEqual([]);
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

  describe("통합: extractCandidatePaths → decidePathPermission (보안리뷰 #1/#3 시나리오)", () => {
    const allowedDirs = ["C:\\proj\\a"];

    it("Glob {pattern: 절대경로}(path 없음) → 허용폴더 밖이면 deny", () => {
      const candidates = extractCandidatePaths("Glob", { pattern: "C:\\other\\**" });
      const result = decidePathPermission("Glob", candidates, { isOwnerDm: true, allowedDirs });
      expect(result.behavior).toBe("deny");
    });

    it("Glob {path: 허용, pattern: '../../x/**'} → 밖이면 deny", () => {
      const candidates = extractCandidatePaths("Glob", { path: "C:\\proj\\a", pattern: "../../x/**" });
      const result = decidePathPermission("Glob", candidates, { isOwnerDm: true, allowedDirs });
      expect(result.behavior).toBe("deny");
    });

    it("FIX1 — Grep {path: 허용, glob: '../../x/**'} → 밖이면 deny", () => {
      const candidates = extractCandidatePaths("Grep", { pattern: "foo", path: "C:\\proj\\a", glob: "../../x/**" });
      const result = decidePathPermission("Grep", candidates, { isOwnerDm: true, allowedDirs });
      expect(result.behavior).toBe("deny");
    });

    it("Glob {path: 허용, pattern: 'sub/**'} → 안이면 allow", () => {
      const candidates = extractCandidatePaths("Glob", { path: "C:\\proj\\a", pattern: "sub/**" });
      const result = decidePathPermission("Glob", candidates, { isOwnerDm: true, allowedDirs });
      expect(result).toEqual({ behavior: "allow" });
    });

    it("후보가 빈 경우 cwd 로 대체되고, cwd 가 밖이면 deny", () => {
      const candidates = extractCandidatePaths("Bash", { command: "ls" }, undefined, "C:\\other");
      const result = decidePathPermission("Bash", candidates, { isOwnerDm: true, allowedDirs });
      expect(result.behavior).toBe("deny");
    });

    it("후보가 빈 경우 cwd 로 대체되고, cwd 가 안이면 allow", () => {
      const candidates = extractCandidatePaths("Bash", { command: "ls" }, undefined, "C:\\proj\\a\\sub");
      const result = decidePathPermission("Bash", candidates, { isOwnerDm: true, allowedDirs });
      expect(result).toEqual({ behavior: "allow" });
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
