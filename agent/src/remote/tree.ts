// 폴더 구조 렌더링. 순수 함수로 떼어 둔 이유는 실행기(파일시스템)를 목업하지 않고 출력 형식만
// 검증하기 위해서다.
export type TreeEntry = { relPath: string; isDir: boolean; depth: number };

// 잘린 이유. depth 상한 때문인지 항목 수 상한 때문인지에 따라 부원이 다음에 뭘 바꿔 다시 부를지
// (depth 를 올릴지, 하위 폴더를 지정할지)가 달라지므로 안내 문구도 구분한다.
export type TreeTruncReason = "depth" | "entries";

export const TREE_MAX_ENTRIES = 500;
export const TREE_DEFAULT_DEPTH = 3;
export const TREE_MAX_DEPTH = 5;
// 코딩 동아리라 이게 없으면 출력이 즉시 상한을 친다.
export const TREE_EXCLUDED = new Set([".git", "node_modules", "dist", ".venv", "__pycache__"]);

export function renderTree(
  entries: TreeEntry[],
  o: { root: string; truncated: boolean; truncatedReason?: TreeTruncReason },
): string {
  if (entries.length === 0) return `${o.root} 는 비어 있어요.`;
  const lines = entries.map((x) => {
    const name = x.relPath.split(/[\\/]/).pop() ?? x.relPath;
    return `${"  ".repeat(x.depth)}${name}${x.isDir ? "/" : ""}`;
  });
  const head = `${o.root}`;
  // 이유를 밝히지 않으면(reason 생략) 항목 수 상한과 같은 문구로 대신한다 — 호출자가 이유를
  // 안 줬다고 안내 자체를 생략하면 "잘렸다"는 사실이 다시 조용해진다.
  const tail = !o.truncated
    ? ""
    : o.truncatedReason === "depth"
      ? "\n… (depth 상한이라 더 못 내려갔어요 — depth 를 늘리거나 하위 폴더를 지정해서 다시 불러보세요)"
      : "\n… (항목이 많아 여기서 잘랐어요 — 하위 폴더를 지정해서 다시 불러보세요)";
  return `${head}\n${lines.join("\n")}${tail}`;
}
