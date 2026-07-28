import { describe, it, expect } from "vitest";
import { renderTree, TREE_MAX_ENTRIES, type TreeEntry } from "../src/remote/tree.js";

const e = (relPath: string, isDir: boolean, depth: number): TreeEntry => ({ relPath, isDir, depth });

describe("renderTree", () => {
  it("깊이에 따라 들여쓰고 폴더는 구분한다", () => {
    const out = renderTree([e("src", true, 0), e("src/a.ts", false, 1)], { root: "C:\\ws\\u1", truncated: false });
    expect(out).toContain("src/");
    expect(out).toContain("  a.ts");
  });

  it("비어 있으면 비었다고 말한다(조용히 빈 문자열을 돌려주지 않는다)", () => {
    const out = renderTree([], { root: "C:\\ws\\u1", truncated: false });
    expect(out).toContain("비어");
  });

  it("잘렸으면 명시한다", () => {
    const out = renderTree([e("a.ts", false, 0)], { root: "C:\\ws\\u1", truncated: true });
    expect(out).toContain("잘랐");
  });

  it("항목 상한이 정의돼 있다", () => {
    expect(TREE_MAX_ENTRIES).toBe(500);
  });
});
