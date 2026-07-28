// 폴더 구조 렌더링. 순수 함수로 떼어 둔 이유는 실행기(파일시스템)를 목업하지 않고 출력 형식만
// 검증하기 위해서다.
export type TreeEntry = { relPath: string; isDir: boolean; depth: number };

export const TREE_MAX_ENTRIES = 500;
export const TREE_DEFAULT_DEPTH = 3;
export const TREE_MAX_DEPTH = 5;
// 코딩 동아리라 이게 없으면 출력이 즉시 상한을 친다.
export const TREE_EXCLUDED = new Set([".git", "node_modules", "dist", ".venv", "__pycache__"]);

export function renderTree(entries: TreeEntry[], o: { root: string; truncated: boolean }): string {
  if (entries.length === 0) return `${o.root} 는 비어 있어요.`;
  const lines = entries.map((x) => {
    const name = x.relPath.split(/[\\/]/).pop() ?? x.relPath;
    return `${"  ".repeat(x.depth)}${name}${x.isDir ? "/" : ""}`;
  });
  const head = `${o.root}`;
  const tail = o.truncated ? "\n… (항목이 많아 여기서 잘랐어요)" : "";
  return `${head}\n${lines.join("\n")}${tail}`;
}
