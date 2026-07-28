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

  // 리뷰 지적(Important 1의 "가능하면") — 잘린 이유가 depth 상한인지 항목 수 상한인지 구분되면
  // 부원이 depth 를 올릴지 하위 폴더를 지정할지 판단할 수 있다.
  it("잘린 이유가 depth 면 depth 를 늘리라고 안내한다", () => {
    const out = renderTree([e("a", true, 0)], { root: "C:\\ws\\u1", truncated: true, truncatedReason: "depth" });
    expect(out).toContain("depth");
  });

  it("잘린 이유가 entries 면 항목이 많다고 안내한다", () => {
    const out = renderTree([e("a.ts", false, 0)], { root: "C:\\ws\\u1", truncated: true, truncatedReason: "entries" });
    expect(out).toContain("항목이 많아");
  });

  // 회귀 수정: depth 상한과 항목 수 상한이 한 호출에서 동시에 걸릴 수 있다(executors.ts 의
  // walk 가 가지별 depth 플래그와 전역 entries 플래그를 따로 추적한다). 하나만 골라 보여주면
  // 나머지 하나는 조용히 잘린 것과 같아지므로, 안내 문구는 두 사실을 모두 드러내야 한다.
  it("잘린 이유가 둘 다(both)면 depth·항목 수 둘 다 언급한다", () => {
    const out = renderTree([e("a.ts", false, 0)], { root: "C:\\ws\\u1", truncated: true, truncatedReason: "both" });
    expect(out).toContain("depth");
    expect(out).toContain("항목");
  });
});
