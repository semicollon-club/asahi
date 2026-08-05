import type { Conversation } from "../store/conversationsRepo.js";
import type { MessagesRepo } from "../store/messagesRepo.js";
import type { SummariesRepo } from "../store/summariesRepo.js";
import type { MemoriesRepo } from "../store/memoriesRepo.js";
import type { UsersRepo } from "../store/usersRepo.js";
import { renderMemories, MEMORY_SECTION_BUDGET } from "./memoryScope.js";

// core.ts(봇 실시간 경로)가 쓰는 턴 준비 로직 — 원래 AgentCore 의 private 메서드/지역 함수였던
// 것을 그대로 옮긴 것(동작은 완전히 동일하다). 한때는 워커(job 처리, worker/jobRunner.ts)와도
// 공유했으나, Task 8(위임 기계장치 삭제)에서 그 워커 자체가 삭제되어 지금은 core.ts 단독 사용이다.

// users 는 공용 기억의 작성자 이름을 붙이기 위해 필요하다(아래 buildContextBlock 주석 참고).
export type ContextRepos = { memories: MemoriesRepo; summaries: SummariesRepo; messages: MessagesRepo; users: UsersRepo };

// 새 세션 시작 시 주입할 기억+요약+최근대화 컨텍스트 블록.
// 프라이버시(§6): DM 은 상대(primaryUser)의 개인+공용, 서버/스레드는 공용만.
export async function buildContextBlock(repos: ContextRepos, conv: Conversation, excludeMessageId: number): Promise<string> {
  // Critical(최종 전체 브랜치 리뷰) — 렌더링을 memoryScope.ts 에 맡긴다. 예전엔 여기서 직접
  // `- [${title}] ${content}` 를 만들어 개행 방어가 없었다 — 서버에서 등록한 공용 기억이
  // forUser()(scope='shared' 도 포함)를 통해 소유자 DM 컨텍스트에도 실리므로, 내용에 개행과
  // 가짜 "## 최근 대화 기록" 을 심으면 이 블록의 섹션 구조 자체가 위조됐다.
  //
  // 2026-08-03: renderMemoryLine 대신 renderMemories 를 쓴다 — 공용 기억에 작성자를 붙이기
  // 위해서다. 작성자 표시를 recall 에만 넣었더니 실사용에서 한 번도 보이지 않았다: 서버 대화는
  // 공용 기억이 이 블록으로 매 턴 통째로 실리므로 모델이 recall 을 부를 이유가 없다(실측에서
  // 부원이 회비를 물었을 때 recall 호출이 0건이었고, 아사히는 "누가 넣었는지 볼 수 없다"며
  // 없는 권한 규칙까지 지어냈다). 이 블록이 실사용의 주 읽기 경로다.
  //
  // 이름 조회 실패는 블록 생성을 막지 않는다 — 부가 정보가 본 기능을 인질로 잡지 않는다는
  // 원칙은 recall·proc_list 와 같다.
  let names: Record<string, string> = {};
  try {
    names = await repos.users.displayNames();
  } catch (err) {
    console.error("[turnPrep] 표시 이름 조회 실패 — 작성자 없이 진행:", err);
  }
  const memories = conv.isPrivate ? await repos.memories.forUser(conv.primaryUserId) : await repos.memories.sharedOnly();
  // Task 1(컨텍스트 블록 문자 예산) — 요약·최근 대화는 각각 3건·20건 상한이 있는데 기억만
  // 무제한이었다. 공용 기억은 부원 누구나 늘릴 수 있으므로 여기에만 문자 예산을 건다.
  const memoryLines = memories.length > 0 ? renderMemories(memories, names, { budget: MEMORY_SECTION_BUDGET }) : "(기억 없음)";
  // 컨텍스트 바닥선(conv.contextFloorTs) — NULL 이면 지금까지처럼 바닥선 없이 전부 대상이다.
  const floor = conv.contextFloorTs ?? undefined;
  const summaries = await repos.summaries.recent(conv.id, 3, floor);
  const recentAll = await repos.messages.recent(conv.id, 21, floor);
  const recent = recentAll.filter((m) => m.id !== excludeMessageId).slice(-20);
  const recentLines = recent
    .map((m) => `[${new Date(m.ts).toISOString()}] ${m.role === "user" ? "사용자" : m.role === "assistant" ? "비서" : "시스템"}: ${m.content}`)
    .join("\n");
  return [
    "[기억 컨텍스트 — 새 세션 시작]",
    "## 기억 (개인/공용)",
    memoryLines,
    "## 이전 대화 요약 (최신순)",
    summaries.length > 0 ? summaries.join("\n---\n") : "(요약 없음)",
    "## 최근 대화 기록",
    "(무슨 이야기를 나눴는지 파악하기 위한 참고용입니다. 아래 '비서:' 이전 답변의 말투·성격을 흉내내지 말고, 당신의 말투·성격·정체성은 반드시 위 시스템 지침의 캐릭터 설정을 따르세요.)",
    recentLines.length > 0 ? recentLines : "(기록 없음)",
  ].join("\n\n");
}

// SDK 가 resume 세션을 못 찾을 때의 에러(클라우드 컨테이너 재배포로 세션 저장소가 초기화된 경우 등).
export function isSessionNotFound(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.includes("No conversation found with session ID");
}
