import { joinUnderRoot } from "./paths.js";
import type { ProjectRow } from "../store/projectsRepo.js";

// 리포 이름은 그대로 미니PC 의 폴더 이름이 되고 GitHub URL 의 한 조각이 된다. 그래서 경로
// 구분자·상위 이동·드라이브 문자가 섞이면 고쳐 쓰지 않고 **거절한다** — 고치면 무엇으로
// 고쳐졌는지 사람도 모델도 모른다(attachments.ts 의 safeFileName 과 같은 원칙).
//
// 점(.)은 넣지 않는다 — joinUnderRoot(paths.ts)의 SEGMENT_PATTERN 이 점을 허용하지 않기
// 때문이다. 여기서 점을 허용하면 이 함수는 통과시키는데 joinUnderRoot 는 던지는 이름이
// 생겨서, 사용자 눈에는 "방금 통과했는데 알 수 없는 오류"로만 보인다. 두 패턴은 항상 같이
// 맞춘다.
export const REPO_NAME_PATTERN = /^[A-Za-z0-9_-]+$/;
const REPO_NAME_MAX_LEN = 100; // GitHub 리포명 상한

export function normalizeRepoName(raw: string): string | null {
  const n = raw.trim();
  if (n.length === 0 || n.length > REPO_NAME_MAX_LEN) return null;
  if (!REPO_NAME_PATTERN.test(n)) return null;
  // 패턴이 이미 점을 막으므로 "."·".." 는 사실 이 줄에 닿기 전에 걸러진다. 그래도 남겨
  // 둔다 — 패턴이 나중에 다시 느슨해지더라도(예: 점을 되살리는 변경) 이 둘만은 항상
  // 막히게 하는 이중 방어다.
  if (n === "." || n === "..") return null;
  return n;
}

export type OwnershipDecision = { ok: true; repoName: string } | { ok: false; reason: string };

// 남의 리포에 푸시하는 것을 막는 유일한 지점이다. 사유에 기존 소유자의 아이디를 넣지 않는다 —
// 누가 무엇을 만들었는지가 이 경로로 새어 나갈 이유가 없다.
export function decideOwnership(o: {
  repoName: string;
  requesterUserId: string;
  existing: ProjectRow | null;
}): OwnershipDecision {
  if (o.existing === null) return { ok: true, repoName: o.repoName };
  if (o.existing.ownerUserId === o.requesterUserId) return { ok: true, repoName: o.repoName };
  return { ok: false, reason: `「${o.repoName}」 은 다른 분이 쓰고 있는 이름이에요. 다른 이름으로 해주세요.` };
}

// 발행 소스는 봇이 계산한다 — 모델이 경로를 주면 남의 폴더를 발행할 수 있다(설계 §6).
// joinUnderRoot 는 세그먼트를 영숫자·밑줄·하이픈으로 제한하고 base 의 플레이버로 잇는다.
export function publishSourceDir(o: { workspaceDir: string; repoName: string }): string {
  return joinUnderRoot(o.workspaceDir, o.repoName);
}
