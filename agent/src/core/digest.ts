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

// FIX2(치명, 최종 리뷰 3차) — 실패한 날은 lastRun 을 기록하지 않으므로 shouldRunDigest 가
// 자정까지 계속 true 를 낸다. 그 상태로 실패가 계속되면(만료된 토큰·error_max_turns 등, 구독
// 토큰이라 현실적이다) 1분 틱마다 재시도해 하루 약 1,020회 × 주제 수만큼 이 앱에서 가장 비싼
// 턴(Opus·웹검색·maxTurns:30)을 부르고, 실패를 무조건 알리는 옛 execute() 탓에 채널이 같은
// 실패 메시지로 도배된다(리뷰 재현: 10틱 실패 시 10번 호출·10번 게시). settings 키
// digest.attempts.<topic> 에 KST 날짜·시도 횟수·안내 여부를 저장해 하루 3회로 시도 자체를
// 제한하고, 실패 안내는 하루 한 번만 낸다(그 이후는 로그 한 줄로 대체 — 같은 실패 메시지로
// 채널을 채우는 것보다 침묵이 낫다). KST 날짜가 바뀌면 자연히 새로 시작한다.
type DigestAttempts = { date: string; count: number; notified: boolean };
const ATTEMPTS_KEY = (topic: DigestTopic) => `digest.attempts.${topic}`;
export const DIGEST_MAX_ATTEMPTS_PER_DAY = 3;

export class DigestRunner {
  private runTurn: TurnRunner;
  private bus: EventBus;
  private settings: SettingsRepo;
  private agentCwd: string;
  private channels: DigestChannels;
  private emotions: string[];
  private now: () => number;
  // FIX1(치명, 최종 리뷰 3차) — 주제별 실행 중 표시. checkAndRun 은 60초마다 fire-and-forget 로
  // 불리므로(index.ts), 이전 틱의 턴이 안 끝난 채 다음 틱이 와도 lastRun 은 성공 후에만 기록돼
  // 재조회한 값이 여전히 "오늘 안 함"이라 새 턴을 또 시작했다(리뷰 재현: 5틱 중 5턴 시작). 이
  // Set 에 있는 동안은 checkAndRun·run(예약어) 어느 경로로도 같은 주제를 다시 시작하지 않는다 —
  // 채널이 아니라 주제로 키를 잡는다: 예약어는 어느 채널에서든 같은 주제를 가리킬 수 있고, 스케줄도
  // 결국 주제 하나당 채널 하나이므로 "그 조사가 지금 도는가"는 주제 단위 사실이다.
  private running = new Set<DigestTopic>();

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

  // 한 주제를 조사해 지정한 채널로 발행한다. 성공 여부를 돌려준다 — checkAndRun 이 이 값으로
  // 기록 여부를 정한다. 예약어 경로(run)는 값을 무시한다.
  // announceFailure(FIX2, 기본 true): false 면 실패해도 채널에 알리지 않고 로그만 남긴다 —
  // 하루 한도 안에서 이미 한 번 안내한 뒤의 재시도(2·3회차)에 스케줄 경로가 이 값을 false 로 넘긴다.
  // 성공했을 때는 이 값과 무관하게 항상 알린다(성공은 도배 문제가 아니다).
  private async execute(topic: DigestTopic, channelRef: string, opts: { announceFailure?: boolean } = {}): Promise<boolean> {
    const announceFailure = opts.announceFailure ?? true;
    const spec = DIGEST_TOPICS[topic];
    // 게시는 사용자 대화가 아니다. 예전엔 공개 채널 계층(isOwner:false, isPrivate:false)으로
    // 돌리는 것만으로 PC 도구가 구조적으로 열리지 않았다 — 그땐 그 계층 자체에 원격 도구가 없었기
    // 때문이다. 최종 리뷰 FIX2: Task 7 로 그 전제가 깨졌다 — 공개 채널 계층도 공유 워커가
    // 연결되면 fs_*/sh_exec 를 받는다(tools.ts 의 allowedToolsFor 마지막 분기, resolveTurnWorker 는
    // 위치만으로 이 턴을 공유 워커에 연결한다). 그래서 이제는 계층만으로 안전하지 않고, 아래 네
    // 축을 turn 요청에 직접 세운다 — noRemoteTools:true(원격 도구 차단): 사람이 지켜보지 않는
    // 타이머로 돌면서 신뢰할 수 없는 웹 검색 결과를 그대로 읽어들이는 이 턴에 공유 기계의 셸
    // 접근까지 열려 있으면 안 된다(유휴 요약 턴에 적용한 것과 같은 이유 — agent.ts 의
    // noRemoteTools 계약·core.ts 의 summarizeAndClose 참고). noWebTools 는 세우지 않는다 — 이
    // 턴의 목적 자체가 웹 검색이다. noSkills:true(스킬 차단, M-2 후속 리뷰): 원격 도구를 막은
    // 것과 이유가 같다(사람이 안 보는 타이머 + 신뢰할 수 없는 웹 검색 결과) — 뉴스 조사에
    // 도움이 되는 스킬이 없으므로 막아도 잃는 기능이 없다. noMemoryWrite:true(Important 4,
    // 최종 전체 브랜치 리뷰): 이 계층이 동아리 공용 기억을 여는 이 브랜치로 세 번째 축이
    // 뚫렸다 — remember 를 무조건 받아, 웹 검색 결과에 심긴 지시가 remember 를 호출하면
    // 조작된 내용이 scope='shared' 로 저장돼 전 부원에게 노출될 수 있었다. recall(읽기)은
    // 막지 않는다 — 공용 기억은 어차피 전 부원이 읽을 수 있고 이 턴의 출력도 공개 채널로
    // 가므로 유출 축이 새로 열리지 않는다.
    const context = { role: "allowed" as const, isPrivate: false, isOwner: false, userId: "digest", conversationId: 0 };
    let text = "";
    let ok = false;
    try {
      const result = await this.runTurn({
        prompt: spec.prompt,
        systemPrompt: buildSystemPrompt({ role: "allowed", isPrivate: false, isOwner: false, emotions: this.emotions }),
        cwd: this.agentCwd,
        context,
        noRemoteTools: true,
        noSkills: true,
        noMemoryWrite: true,
      });
      text = result.text.trim();
      ok = result.ok && text.length > 0;
    } catch (err) {
      console.error(`[digest] ${topic} 조사 실패:`, err);
    }
    if (ok || announceFailure) {
      this.bus.publish({
        type: "assistant_message", channel: "discord", channelRef,
        text: ok ? text : FAILED_TEXT, ts: this.now(),
      });
    } else {
      console.warn(`[digest] ${topic} 실패 — 오늘 이미 안내해 채널 알림은 생략한다(하루 한도 내 재시도).`);
    }
    return ok;
  }

  // FIX1: running 을 확인·표시하고 execute 를 호출한 뒤 finally 로 반드시 해제한다 — run·
  // checkAndRun 양쪽이 이 메서드 하나만 거치므로 가드가 두 경로에 동일하게 적용된다. 이미 그
  // 주제가 실행 중이면 execute 를 아예 호출하지 않고 undefined 를 돌려준다(시도로 치지 않는다 —
  // FIX2 의 일일 횟수 상한과는 별개 개념이다).
  private async guardedExecute(topic: DigestTopic, channelRef: string, opts: { announceFailure?: boolean } = {}): Promise<boolean | undefined> {
    if (this.running.has(topic)) return undefined;
    this.running.add(topic);
    try {
      return await this.execute(topic, channelRef, opts);
    } finally {
      this.running.delete(topic);
    }
  }

  // 예약어 경로: 명령을 친 채널에 즉시 답한다. FIX2 의 일일 시도 상한과는 무관하다 — 그건
  // 스케줄의 무인 재시도 폭주를 막기 위한 것이고, 예약어는 사람이 직접 요청한 단발성 호출이라
  // 이미 손님 한도(turns.reserve, core.ts)로 별도 보호된다.
  // FIX1: started=false 면 같은 주제가 이미 실행 중이라 새로 시작하지 않았다는 뜻 — 호출자
  // (core.ts)가 이 값으로 "이미 조사 중" 안내를 낼지 정한다.
  //
  // FIX3(중요, 머지 전 리뷰) — lastRun 기록 여부는 "결과가 그 주제의 지정 채널(this.channels[topic])로
  // 갔는가"로 가른다. core.ts 는 예약어 결과를 그 주제의 지정 채널로 리다이렉트하므로(설정돼 있고
  // DM 이 아니면), 그 채널로 성공적으로 올라간 실행은 스케줄이 몇 시간 뒤 같은 채널에 같은 주제를
  // 또 올리지 않도록 lastRun 을 남겨야 한다(리뷰 재현: 06시 수동 실행 + 07시 스케줄 = 같은 채널에
  // 2회 게시). 반대로 DM 으로 답했거나 지정 채널이 없어 명령 친 곳으로 폴백했다면 그 채널은
  // 오늘 치 소식을 못 봤으므로 예전처럼 lastRun 을 그대로 둔다 — 그래야 그날 아침 스케줄이
  // 정상적으로 돈다. 성공 시의 정리(attempts 삭제)는 checkAndRun 의 성공 처리와 동일하게 맞춘다.
  async run(topic: DigestTopic, channelRef: string): Promise<{ started: boolean }> {
    const ok = await this.guardedExecute(topic, channelRef);
    if (ok && this.channels[topic] === channelRef) {
      const today = kstDateString(this.now());
      await this.settings.set(LAST_RUN_KEY(topic), today);
      await this.settings.delete(ATTEMPTS_KEY(topic));
    }
    return { started: ok !== undefined };
  }

  // 스케줄 경로: 주제별로 판정해 실행하고, 성공한 것만 기록한다.
  // FIX1: guardedExecute 가 이미 실행 중인 주제를 걸러준다 — 겹친 틱은 시도 자체를 하지 않으므로
  // FIX2 의 시도 횟수에도 반영하지 않는다(continue). FIX2: 하루 시도 상한에 도달했으면
  // guardedExecute 를 부르지도 않는다(모델 호출 자체가 없다) — 실패 안내는 그 하루의 첫 실패
  // 때만 내고 이후는 announceFailure:false 로 로그만 남긴다.
  async checkAndRun(): Promise<void> {
    for (const topic of Object.keys(DIGEST_TOPICS) as DigestTopic[]) {
      const channelRef = this.channels[topic];
      if (!channelRef) continue; // 채널 미설정 주제는 조용히 건너뛴다(부팅 시 한 번 안내한다)
      const nowMs = this.now();
      const last = await this.settings.get(LAST_RUN_KEY(topic));
      if (!shouldRunDigest(nowMs, last)) continue;

      const today = kstDateString(nowMs);
      const attempts = await this.readAttempts(topic, today);
      if (attempts.count >= DIGEST_MAX_ATTEMPTS_PER_DAY) continue; // 오늘 한도 소진 — 더 시도하지 않는다

      const ok = await this.guardedExecute(topic, channelRef, { announceFailure: !attempts.notified });
      if (ok === undefined) continue; // FIX1 가드에 막힘(다른 실행이 진행 중) — 시도로 치지 않는다

      if (ok) {
        // 성공했으니 다음 날을 위해 실패 기록을 정리한다(다음에 실패하면 다시 처음부터 안내한다).
        await this.settings.set(LAST_RUN_KEY(topic), today);
        await this.settings.delete(ATTEMPTS_KEY(topic));
      } else {
        await this.writeAttempts(topic, { date: today, count: attempts.count + 1, notified: true });
      }
    }
  }

  // KST 날짜가 저장된 값과 다르면(자정을 넘겼거나 최초 호출) 새로 시작한다 — 손상된 JSON 도
  // 같은 방식으로 안전하게 리셋한다(fail-open 이 아니라 "오늘 처음"으로 취급).
  private async readAttempts(topic: DigestTopic, today: string): Promise<DigestAttempts> {
    const raw = await this.settings.get(ATTEMPTS_KEY(topic));
    if (!raw) return { date: today, count: 0, notified: false };
    try {
      const parsed = JSON.parse(raw) as DigestAttempts;
      if (parsed.date !== today) return { date: today, count: 0, notified: false };
      return parsed;
    } catch {
      return { date: today, count: 0, notified: false };
    }
  }

  private async writeAttempts(topic: DigestTopic, attempts: DigestAttempts): Promise<void> {
    await this.settings.set(ATTEMPTS_KEY(topic), JSON.stringify(attempts));
  }
}
