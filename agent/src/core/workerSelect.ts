import { joinUnderRoot } from "./paths.js";

// 이 턴이 어느 기계를 쓰는가. 규칙은 한 줄이다 — "어디서 말하느냐가 어느 기계냐를 정한다".
// 유일한 예외가 손님인데, 손님은 개인 워커가 없으므로 어디서든 공유 기계로 간다.
//
// 순수 함수로 떼어 둔 이유는 agent.ts 의 resolveTurnWorker 와 같다: 이 판단 하나를 검증하려고 SDK
// query() 나 DB 전체를 목업하고 싶지 않다. 실제 워커 id 로 바꾸는 것은 호출측(레지스트리 조회)의 몫이다.
export type WorkerSelector = { kind: "personal"; userId: string } | { kind: "shared" };

export function resolveWorkerSelector(ctx: { isOwner: boolean; isPrivate: boolean; userId: string }): WorkerSelector {
  return ctx.isOwner && ctx.isPrivate ? { kind: "personal", userId: ctx.userId } : { kind: "shared" };
}

// 봇 쪽 1차 필터가 쓸 폴더 목록. 공유 기계에서 손님은 자기 하위 폴더로만 좁혀진다.
// 소유자는 관리자이므로 좁히지 않는다 — 다른 사람의 작업을 조회할 수 있어야 한다.
//
// 빈 목록은 빈 목록 그대로 돌려준다. "허용 폴더가 하나도 없다"를 "전부 허용"으로 바꾸면
// 1차 필터가 통째로 무력화된다(fail closed 유지 — 호출측이 빈 목록을 거부로 다룬다).
//
// userId 를 joinUnderRoot 에 그대로 넘긴다 — joinUnderRoot 가 그 값을 평범한 식별자로 검증하고,
// 아니면 던진다(paths.ts 참고). 이 함수는 그 예외를 잡지 않는다: 호출측(remoteToolHandler)이
// 이미 allowedDirs 조회 전체를 try/catch 로 감싸고 있어, 여기서 또 잡으면 오류 처리 경로가
// 두 곳으로 갈린다.
export function scopeDirs(
  dirs: string[],
  o: { workerKind: "personal" | "shared"; isOwner: boolean; userId: string },
): string[] {
  if (o.workerKind === "personal" || o.isOwner) return dirs;
  return dirs.map((d) => joinUnderRoot(d, o.userId));
}
