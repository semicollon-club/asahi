import { joinUnderRoot } from "./paths.js";

// 2026-09-17(ADR 0011): 이 파일에 있던 resolveWorkerSelector("어디서 말하느냐가 어느 기계냐를
// 정한다" — 소유자 DM 만 개인 워커, 그 외는 공유 워커)가 삭제됐다. **모든 턴은 동아리 미니PC 의
// 공유 워커로 간다.** 고를 것이 하나뿐이라 고르는 함수가 필요 없다 — 워커 해석은 레지스트리 조회
// 하나로 줄었고(agent.ts 의 resolveTurnWorker), 그 자리에 남아 있던 개인 워커 분기도 함께 없앴다.
//
// 같은 이유로 아래 두 함수의 workerKind 인자도 사라졌다. 개인 워커가 선택되지 않는 이상
// `workerKind === "personal"` 분기는 도달할 수 없는데, 그 분기가 하필 **폴더 좁히기를 건너뛰는**
// 쪽이었다 — 도달하지 않는 채로 접근을 넓히는 분기를 남겨 두는 것이 이 저장소가 ownWorkstation
// 에서 이미 한 번 겪은 함정이다(capability-model.md 의 canManagePc 항목). 판정 축은 이제 신원
// 하나다: 소유자면 좁히지 않고, 손님이면 자기 하위 폴더로 좁힌다.

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
  o: { isOwner: boolean; userId: string },
): string[] {
  if (o.isOwner) return dirs;
  return dirs.map((d) => joinUnderRoot(d, o.userId));
}

// 하네스 세션의 작업 폴더(풀 하네스 설계 §6, 위험 등록부 §11).
// 얇은 워커의 `fs_*` 가 위 scopeDirs 로 좁혀지는 것과 **같은 규칙**을 세션 cwd 에도 적용한다 — 한 사람이
// 두 경로(원격 도구·하네스)에서 서로 다른 폴더를 받으면 "내 폴더"라는 말의 뜻이 갈리고, 안내와 실제가
// 어긋난다. 그래서 규칙을 새로 쓰지 않고 scopeDirs 를 그대로 쓴다.
//
// **이건 OS 경계가 아니다.** 세션의 내장 Bash 는 계정 B 가 읽는 곳이면 어디든 볼 수 있다(§11 의 "완화의
// 한계"). 이 값이 정하는 것은 "어디서 시작하는가" 뿐 — 사고를 막는 첫 선이지 공격을 막는 벽이 아니다.
//
// 폴더를 정할 수 없으면 undefined. 호출측(agent.ts)은 그것을 "하네스로 보내지 않는다"로 읽는다 — 루트가
// 없거나 식별자가 이상해 좁힐 수 없을 때 워크스페이스 루트로 떨어지는 것이 이 함수가 막으려는 바로 그
// 일이므로, 실패는 넓히는 쪽이 아니라 닫는 쪽으로 간다.
export function harnessCwdFor(
  roots: string[],
  o: { isOwner: boolean; userId: string },
): string | undefined {
  try {
    return scopeDirs(roots, o)[0];
  } catch {
    // scopeDirs 는 크래프트한 userId 에 예외를 던진다(joinUnderRoot). 삼키는 이유는 위와 같다 —
    // 턴 전체를 죽이는 것보다 하네스를 건너뛰는 편이 낫다(옛 경로로 답은 나간다).
    return undefined;
  }
}
