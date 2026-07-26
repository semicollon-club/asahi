// 정기 뉴스 게시. 실행 판정은 순수 함수로 떼어내 시각·기록만으로 결정하고,
// 실제 실행(DigestRunner)은 같은 파일 아래쪽에 둔다.

import type { TurnRunner } from "./agent.js";
import type { EventBus } from "../events/bus.js";
import type { SettingsRepo } from "../store/settingsRepo.js";
import { buildSystemPrompt } from "./persona.js";

export type DigestTopic = "contest" | "devnews";

// KST 기준 게시 시각. 환경변수로 빼지 않는다 — 잘못 설정하면 조용히 안 도는 것보다
// 상수 한 줄을 고치고 재배포하는 편이 낫다.
export const DIGEST_HOUR_KST = 7;

// KST 는 UTC+9 고정이고 서머타임이 없다. 라이브러리 없이 산술로 정확하다.
const KST_OFFSET_MS = 9 * 60 * 60 * 1000;

export const DIGEST_TOPICS: Record<DigestTopic, { label: string; prompt: string }> = {
  contest: {
    label: "대회",
    prompt: `웹 검색으로 지금 참가 신청을 받고 있거나 곧 열리는 코딩 대회·CTF(해킹) 대회를 3~5개 찾아 정리해줘.
각 항목마다 대회 이름, 일정, 참가 대상, 출처 링크를 적어. 날짜가 이미 지난 대회는 빼.
찾지 못했으면 억지로 채우지 말고 못 찾았다고 해.`,
  },
  devnews: {
    label: "개발 뉴스",
    prompt: `웹 검색으로 최근 개발자에게 의미 있는 소식을 3~5개 찾아 정리해줘.
프레임워크·언어·개발 도구의 주요 릴리스나 화제가 된 이슈 위주로. 각 항목마다 무엇이 바뀌었고
왜 중요한지 한두 줄로 설명하고 출처 링크를 붙여. 찾지 못했으면 억지로 채우지 말고 못 찾았다고 해.`,
  },
};

// 그 시각의 KST 날짜를 "YYYY-MM-DD" 로. UTC 로 9시간 민 뒤 UTC 필드를 읽으면 그게 KST 다.
export function kstDateString(nowUtcMs: number): string {
  return new Date(nowUtcMs + KST_OFFSET_MS).toISOString().slice(0, 10);
}

// 지금 게시를 실행해야 하는가. "정각에 쏘기"가 아니라 "지났는데 오늘 아직 안 했으면 한다" —
// 재배포나 일시 장애로 정각을 놓쳐도 그날 안에 올라간다.
export function shouldRunDigest(
  nowUtcMs: number,
  lastRunDate: string | null,
  hourKst: number = DIGEST_HOUR_KST,
): boolean {
  const kst = new Date(nowUtcMs + KST_OFFSET_MS);
  if (kst.getUTCHours() < hourKst) return false;
  return lastRunDate !== kstDateString(nowUtcMs);
}

export type DigestChannels = Partial<Record<DigestTopic, string>>;

const LAST_RUN_KEY = (topic: DigestTopic) => `digest.lastRun.${topic}`;
const FAILED_TEXT = "…오늘은 못 찾았어. 나중에 다시 볼게.";

export class DigestRunner {
  private runTurn: TurnRunner;
  private bus: EventBus;
  private settings: SettingsRepo;
  private agentCwd: string;
  private channels: DigestChannels;
  private emotions: string[];
  private now: () => number;

  constructor(deps: {
    runTurn: TurnRunner; bus: EventBus; settings: SettingsRepo; agentCwd: string;
    channels: DigestChannels; emotions?: string[]; now?: () => number;
  }) {
    this.runTurn = deps.runTurn;
    this.bus = deps.bus;
    this.settings = deps.settings;
    this.agentCwd = deps.agentCwd;
    this.channels = deps.channels;
    this.emotions = deps.emotions ?? [];
    this.now = deps.now ?? Date.now;
  }

  // 한 주제를 조사해 지정한 채널로 발행한다. 성공 여부를 돌려준다 —
  // checkAndRun 이 이 값으로 기록 여부를 정한다. 예약어 경로는 값을 무시한다.
  private async execute(topic: DigestTopic, channelRef: string): Promise<boolean> {
    const spec = DIGEST_TOPICS[topic];
    // 게시는 사용자 대화가 아니다. 공개 채널 계층(isOwner:false, isPrivate:false)으로 돌려
    // PC 도구가 구조적으로 열리지 않게 한다 — 플래그로 빼는 게 아니라 그 계층에 애초에 없다.
    const context = { role: "allowed" as const, isPrivate: false, isOwner: false, userId: "digest", conversationId: 0 };
    let text = "";
    let ok = false;
    try {
      const result = await this.runTurn({
        prompt: spec.prompt,
        systemPrompt: buildSystemPrompt({ role: "allowed", isPrivate: false, isOwner: false, emotions: this.emotions }),
        cwd: this.agentCwd,
        context,
      });
      text = result.text.trim();
      ok = result.ok && text.length > 0;
    } catch (err) {
      console.error(`[digest] ${topic} 조사 실패:`, err);
    }
    this.bus.publish({
      type: "assistant_message", channel: "discord", channelRef,
      text: ok ? text : FAILED_TEXT, ts: this.now(),
    });
    return ok;
  }

  // 예약어 경로: 명령을 친 채널에 즉시 답한다. lastRun 을 건드리지 않는다 —
  // 수동으로 한 번 봤다고 다음 날 아침 게시가 걸러지면 안 된다.
  async run(topic: DigestTopic, channelRef: string): Promise<void> {
    await this.execute(topic, channelRef);
  }

  // 스케줄 경로: 주제별로 판정해 실행하고, 성공한 것만 기록한다.
  async checkAndRun(): Promise<void> {
    for (const topic of Object.keys(DIGEST_TOPICS) as DigestTopic[]) {
      const channelRef = this.channels[topic];
      if (!channelRef) continue; // 채널 미설정 주제는 조용히 건너뛴다(부팅 시 한 번 안내한다)
      const nowMs = this.now();
      const last = await this.settings.get(LAST_RUN_KEY(topic));
      if (!shouldRunDigest(nowMs, last)) continue;
      const ok = await this.execute(topic, channelRef);
      // 실패한 날은 기록하지 않아 다음 확인(1분 뒤)에서 다시 시도한다.
      if (ok) await this.settings.set(LAST_RUN_KEY(topic), kstDateString(nowMs));
    }
  }
}
