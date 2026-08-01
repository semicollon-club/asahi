import type { Memory } from "../store/memoriesRepo.js";

// 공용 기억 1건의 내용 상한. recall 은 걸린 기억의 "내용 전체"를 돌려주므로, 문서를 통째로
// 넣으면 "회비 얼마야"에 회칙 전문이 딸려온다. 문서 원본이 필요하면 그건 기억이 아니라
// 파일이다 — 워커에 두고 fs_read 로 읽으면 된다.
export const SHARED_MEMORY_MAX_LEN = 4000;

// 이번 저장이 개인 기억인지 동아리 공용 기억인지. 위치 하나로만 정한다.
//
// 모델이 스코프를 고르게 하면 틀릴 수 있고, 틀리면 개인 얘기가 전원에게 보이거나 동아리
// 사실이 한 사람에게만 남는다. 위치는 틀릴 수가 없다 — workerSelect.ts 가 어느 기계를 쓸지
// 정할 때 쓰는 규칙과 같은 축이다.
//
// isOwner 를 받지 않는 것이 설계다. 받으면 "소유자는 서버에서도 개인 기억" 같은 갈래가 생기고,
// 그때부터 무엇이 어디에 저장됐는지 사람이 추적할 수 없게 된다.
export function memoryScopeFor(ctx: { isPrivate: boolean }): "user" | "shared" {
  return ctx.isPrivate ? "user" : "shared";
}

// recall 결과를 사람이 읽을 문자열로. 공용 기억에만 작성자를 붙인다 — 누구나 쓸 수 있는
// 저장소라 "누가 넣었는지"가 그 정보를 얼마나 믿을지의 근거가 된다. 개인 기억은 본인 것이라
// 작성자가 자명하므로 붙이지 않는다.
//
// 이름을 모르면 생략한다. 숫자 id 를 보여주면 읽는 사람에게 아무 의미가 없고, "누가 넣었는지
// 알 수 없다"는 사실은 이름이 없는 것만으로 이미 드러난다.
export function renderMemories(mems: Memory[], names: Record<string, string>): string {
  return mems
    .map((m) => {
      const who = m.scope === "shared" ? names[m.userId] : undefined;
      return who ? `- [${m.title}] ${m.content} (${who}이 등록)` : `- [${m.title}] ${m.content}`;
    })
    .join("\n");
}
