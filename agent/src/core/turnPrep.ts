import type { Conversation } from "../store/conversationsRepo.js";
import type { MessagesRepo } from "../store/messagesRepo.js";
import type { SummariesRepo } from "../store/summariesRepo.js";
import type { MemoriesRepo } from "../store/memoriesRepo.js";

// core.ts(봇 실시간 경로)가 쓰는 턴 준비 로직 — 원래 AgentCore 의 private 메서드/지역 함수였던
// 것을 그대로 옮긴 것(동작은 완전히 동일하다). 한때는 워커(job 처리, worker/jobRunner.ts)와도
// 공유했으나, Task 8(위임 기계장치 삭제)에서 그 워커 자체가 삭제되어 지금은 core.ts 단독 사용이다.

export type ContextRepos = { memories: MemoriesRepo; summaries: SummariesRepo; messages: MessagesRepo };

// 캐릭터 확정 설정 주입 상한. 프롬프트 예산을 지키면서 초기 canon 을 우선 보존한다(id ASC + 앞에서 자름).
export const CHARACTER_FACT_LIMIT = 40;

// 새 세션 시작 시 주입할 기억+요약+최근대화 컨텍스트 블록.
// 프라이버시(§6): DM 은 상대(primaryUser)의 개인+공용, 서버/스레드는 공용만.
export async function buildContextBlock(repos: ContextRepos, conv: Conversation, excludeMessageId: number): Promise<string> {
  // 캐릭터 설정은 유저 스코프가 아니라 전역이다 — 소유자에게 한 말이 손님에게도 같아야 한다.
  // 상한을 하나 더 조회해 잘림 여부를 알아낸다. 조용히 자르면 "설정을 다 기억한다"고 오해하게 된다.
  const probed = await repos.memories.characterFacts(CHARACTER_FACT_LIMIT + 1);
  const facts = probed.slice(0, CHARACTER_FACT_LIMIT);
  if (probed.length > CHARACTER_FACT_LIMIT) {
    console.warn(`[turnPrep] 캐릭터 설정이 상한(${CHARACTER_FACT_LIMIT})을 넘어 오래된 것만 주입합니다.`);
  }
  const factLines = facts.length > 0 ? facts.map((f) => `- [${f.title}] ${f.content}`).join("\n") : "(설정 없음)";
  const memories = conv.isPrivate ? await repos.memories.forUser(conv.primaryUserId) : await repos.memories.sharedOnly();
  const memoryLines = memories.length > 0 ? memories.map((m) => `- [${m.title}] ${m.content}`).join("\n") : "(기억 없음)";
  const summaries = await repos.summaries.recent(conv.id, 3);
  const recentAll = await repos.messages.recent(conv.id, 21);
  const recent = recentAll.filter((m) => m.id !== excludeMessageId).slice(-20);
  const recentLines = recent
    .map((m) => `[${new Date(m.ts).toISOString()}] ${m.role === "user" ? "사용자" : m.role === "assistant" ? "비서" : "시스템"}: ${m.content}`)
    .join("\n");
  return [
    "[기억 컨텍스트 — 새 세션 시작]",
    "## 내 설정 (이미 말한 것 — 반드시 이대로 유지)",
    factLines,
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
