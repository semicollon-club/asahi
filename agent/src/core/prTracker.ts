import type { EventBus } from "../events/bus.js";
import type { PullRequestsRepo, PullRequestRow, PullRequestPatch, PrState } from "../store/pullRequestsRepo.js";
import { mintInstallationToken, type GithubAppConfig, type FetchLike } from "../github/appToken.js";
import {
  fetchPullRequestSnapshot, fetchWorkflowRuns, aggregateCi, failedRuns, type CiState, type WorkflowRun,
} from "../github/pulls.js";

// PR 추적(2026-09-05, docs/superpowers/specs/2026-09-05-git-workflow-followups-design.md §4).
//
// 부원이 디스코드로 PR 을 낸 뒤의 일 — CI 가 통과했는지, 운영자가 병합했는지 — 은 깃허브에 가야만
// 보였다. 이 폴러는 봇이 create_pull_request 로 만든 PR(pull_requests 표)을 1분 타이머에서 훑어
// (1) 새 PR 을 운영자에게 한 번 알리고, (2) CI 가 처음 성공·실패로 끝나면 그 PR 을 낸 대화 채널에
// 한 번 알리고, (3) 병합·닫힘을 그 채널에 한 번 알린 뒤 추적을 끝낸다. 웹훅이 아니라 폴링인 이유는
// 봇의 공개 리스너를 /worker 하나로 유지하기 위해서다(스펙 §6-D).
//
// 판정(pollIntervalMs·isDue·planPrUpdate)은 순수 함수로 떼어 두고 클래스는 그것을 표·깃허브·버스에
// 잇기만 한다 — digest.ts 의 shouldRunDigest·staleWorker.ts 의 decideMissingAlerts 와 같은 배치다.
// 여기서 만든 알림 문구는 코멘트 본문을 싣지 않는다(제목·상태·링크만) — 리뷰 코멘트는 신뢰할 수 없는
// 입력이고, 채널로 나가는 문구에 그것을 그대로 옮기지 않는다(스펙 §5).

export const PR_POLL_YOUNG_INTERVAL_MS = 2 * 60_000;
export const PR_POLL_MID_INTERVAL_MS = 10 * 60_000;
export const PR_POLL_OLD_INTERVAL_MS = 60 * 60_000;
const HOUR_MS = 60 * 60_000;
const DAY_MS = 24 * HOUR_MS;
export const PR_POLL_YOUNG_MAX_AGE_MS = 6 * HOUR_MS;
export const PR_POLL_MID_MAX_AGE_MS = 3 * DAY_MS;
export const PR_POLL_MAX_AGE_MS = 30 * DAY_MS;

// PR 하나에 깃허브를 얼마나 자주 묻는가. 갓 낸 PR 은 CI 가 몇 분 안에 끝나므로 자주, 며칠 묵은 PR 은
// 운영자가 병합할 때까지 한 시간에 한 번이면 충분하다. 30일이 지나면 그만 본다(null) — 그런 PR 은
// 사람이 잊은 것이고, 그것까지 매시간 두드리면 열린 PR 수에 비례해 호출이 영원히 쌓인다.
export function pollIntervalMs(ageMs: number): number | null {
  if (ageMs < PR_POLL_YOUNG_MAX_AGE_MS) return PR_POLL_YOUNG_INTERVAL_MS;
  if (ageMs < PR_POLL_MID_MAX_AGE_MS) return PR_POLL_MID_INTERVAL_MS;
  if (ageMs < PR_POLL_MAX_AGE_MS) return PR_POLL_OLD_INTERVAL_MS;
  return null;
}

export function isDue(row: { createdTs: number; lastCheckedTs: number | null }, nowMs: number): boolean {
  const interval = pollIntervalMs(nowMs - row.createdTs);
  if (interval === null) return false;
  return row.lastCheckedTs === null || nowMs - row.lastCheckedTs >= interval;
}

type MintFn = typeof mintInstallationToken;
export type TrackerToken = { token: string; ciAvailable: boolean };

// pull_requests 읽기 + actions 읽기를 한 토큰으로. App 에 actions 권한이 없으면 깃허브가 발급 자체를
// 거절하므로, 그때는 pull_requests 만으로 다시 발급하고 CI 는 포기한다(ciAvailable=false) — 병합
// 감지·운영자 알림은 그래도 돌아야 한다. 둘 다 실패하면 던진다.
export async function mintTrackerToken(o: {
  config: GithubAppConfig; repoNames: string[]; nowMs: number; fetchImpl?: FetchLike; mint?: MintFn;
  onActionsDenied?: (message: string) => void;
}): Promise<TrackerToken> {
  const mint = o.mint ?? mintInstallationToken;
  try {
    const r = await mint({
      config: o.config, repoNames: o.repoNames, permissions: { pull_requests: "read", actions: "read" }, nowMs: o.nowMs, fetchImpl: o.fetchImpl,
    });
    return { token: r.token, ciAvailable: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (!/permission/i.test(message)) throw err;
    o.onActionsDenied?.(message);
    const r = await mint({ config: o.config, repoNames: o.repoNames, permissions: { pull_requests: "read" }, nowMs: o.nowMs, fetchImpl: o.fetchImpl });
    return { token: r.token, ciAvailable: false };
  }
}

export type PrInspection = {
  state: PrState; title: string; url: string; headSha: string; ci: CiState; failures: WorkflowRun[];
};

// 깃허브에서 PR 하나를 본다 — 상태, 그리고 열려 있으면 그 커밋의 CI. 닫힌 PR 은 CI 를 묻지 않는다
// (알 필요도 없고 호출 하나를 아낀다). prTracker 의 틱과 tools.ts 의 pr_status 가 같은 함수를 쓴다 —
// 두 경로가 다른 판정을 하면 "도구는 통과라는데 알림은 실패" 같은 어긋남이 생긴다.
export async function inspectPullRequest(o: {
  config: GithubAppConfig; repo: string; number: number; token: TrackerToken; nowMs: number; createdTs: number; fetchImpl?: FetchLike;
}): Promise<PrInspection> {
  const s = await fetchPullRequestSnapshot({ org: o.config.org, repo: o.repo, number: o.number, token: o.token.token, fetchImpl: o.fetchImpl });
  const base = { title: s.title, url: s.url, headSha: s.headSha };
  if (s.state === "closed") return { ...base, state: s.merged ? "merged" : "closed", ci: "unknown", failures: [] };
  if (!o.token.ciAvailable) return { ...base, state: "open", ci: "unknown", failures: [] };
  const runs = await fetchWorkflowRuns({ org: o.config.org, repo: o.repo, headSha: s.headSha, token: o.token.token, fetchImpl: o.fetchImpl });
  return { ...base, state: "open", ci: aggregateCi(runs, { ageMs: o.nowMs - o.createdTs }), failures: failedRuns(runs) };
}

// 채널로 나갈 알림. assistant_message 는 담담한 소식(디스코드 어댑터가 그대로 보낸다), system_notice 는
// 경고(어댑터가 ⚠️ 를 붙인다 — core.ts 의 publishAck 주석 참고) — CI 실패·병합 없이 닫힘만 경고다.
export type PrNotice = { kind: "assistant_message" | "system_notice"; text: string };

const label = (row: PullRequestRow) => `${row.repo}#${row.number} 「${row.title}」`;

export function ownerNoticeText(row: PullRequestRow, requesterName: string): string {
  return `새 PR: ${label(row)} — ${requesterName} 님이 냈어요. 리뷰·병합은 깃허브에서: ${row.url}`;
}

function ciNotice(row: PullRequestRow, insp: PrInspection): PrNotice {
  if (insp.ci === "failure") {
    const names = insp.failures.map((f) => f.name).join(", ") || "이름 모름";
    const link = insp.failures[0]?.url ?? row.url;
    return { kind: "system_notice", text: `${label(row)} CI 실패 — ${names}. 같은 브랜치에 고쳐 push 하면 다시 돌아요. ${link}` };
  }
  return { kind: "assistant_message", text: `${label(row)} CI 통과. 이제 운영자가 검토·병합하면 됩니다. ${row.url}` };
}

function closedNotice(row: PullRequestRow, state: PrState): PrNotice {
  if (state === "merged") {
    return {
      kind: "assistant_message",
      text: `${label(row)} 이 ${row.base} 에 병합됐어요. 작업 폴더의 클론은 \`git switch main\` 뒤 \`git pull --ff-only\` 로 정리하면 됩니다. ${row.url}`,
    };
  }
  return { kind: "system_notice", text: `${label(row)} 이 병합 없이 닫혔어요. 사유는 깃허브에서 확인해 주세요: ${row.url}` };
}

// 관측 결과를 표 갱신(patch)과 알림(notices)으로 바꾸는 순수 함수. "한 번만"의 규칙이 전부 여기 있다:
// - 닫힘(병합 포함)은 closedNotifiedTs 가 비어 있을 때 한 번.
// - CI 는 처음 success/failure 로 끝날 때 한 번. 단, 커밋이 바뀌면(새 push) 그 커밋의 결과는 새 사실이라
//   다시 알린다 — 실패 알림을 받고 고쳐 올린 부원이 "이제 통과했다"를 들어야 한다.
// 알릴 수 없는 사정(대화를 못 찾음 등)이 있어도 patch 는 notified 로 남긴다 — 매 틱 같은 알림을 재시도해
// 언젠가 도착하면 그때는 이미 낡은 소식이고, 그 사이 로그만 채운다.
export function planPrUpdate(row: PullRequestRow, insp: PrInspection, nowMs: number): { patch: PullRequestPatch; notices: PrNotice[] } {
  const patch: PullRequestPatch = { lastCheckedTs: nowMs, headSha: insp.headSha };
  const notices: PrNotice[] = [];
  if (insp.state !== "open") {
    patch.state = insp.state;
    if (row.closedNotifiedTs === null) {
      notices.push(closedNotice(row, insp.state));
      patch.closedNotifiedTs = nowMs;
    }
    return { patch, notices };
  }
  patch.ciState = insp.ci;
  const shaChanged = row.headSha !== null && row.headSha !== insp.headSha;
  const alreadyNotified = row.ciNotifiedTs !== null && !shaChanged;
  if ((insp.ci === "success" || insp.ci === "failure") && !alreadyNotified) {
    notices.push(ciNotice(row, insp));
    patch.ciNotifiedTs = nowMs;
  } else if (shaChanged) {
    patch.ciNotifiedTs = null;
  }
  return { patch, notices };
}

type ChannelLookup = { discordChannelId: string } | null;

export class PrTracker {
  private readonly deps: {
    pullRequests: PullRequestsRepo;
    conversations: { getById(id: number): Promise<ChannelLookup>; findDmFor(userId: string): Promise<ChannelLookup> };
    users: { displayNames(): Promise<Record<string, string>> };
    bus: EventBus;
    github: GithubAppConfig | null;
    ownerId: string;
    notifyChannelId?: string;
    fetchImpl?: FetchLike;
    mint?: MintFn;
  };
  private readonly now: () => number;
  // actions 권한 거절은 설정 문제라 매 틱 반복되는데, 그때마다 경고하면 로그가 그 한 줄로 채워진다.
  private actionsDeniedWarned = false;

  constructor(deps: PrTracker["deps"] & { now?: () => number }) {
    const { now, ...rest } = deps;
    this.deps = rest;
    this.now = now ?? Date.now;
  }

  // 1분 타이머가 부른다(index.ts). 열린 PR 이 없으면 깃허브를 부르지 않는다 — 평소 대부분의 틱이다.
  async tick(): Promise<void> {
    const github = this.deps.github;
    if (!github) return;
    const rows = await this.deps.pullRequests.listOpen();
    if (rows.length === 0) return;
    const now = this.now();

    for (const row of rows) {
      if (row.ownerNotifiedTs === null) await this.notifyOwner(row, now);
    }

    const due = rows.filter((row) => isDue(row, now));
    if (due.length === 0) return;

    let token: TrackerToken;
    try {
      token = await mintTrackerToken({
        config: github, repoNames: [...new Set(due.map((r) => r.repo))], nowMs: now, fetchImpl: this.deps.fetchImpl, mint: this.deps.mint,
        onActionsDenied: (message) => {
          if (this.actionsDeniedWarned) return;
          this.actionsDeniedWarned = true;
          console.warn(`[prTracker] App 에 actions 권한이 없어 CI 결과는 확인하지 못해요 — 병합 알림만 갑니다(deploy/github-app-셋업.md): ${message}`);
        },
      });
    } catch (err) {
      console.warn("[prTracker] 깃허브 토큰 발급 실패 — 이번 틱은 건너뜁니다:", err instanceof Error ? err.message : err);
      return;
    }

    for (const row of due) {
      try {
        const insp = await inspectPullRequest({
          config: github, repo: row.repo, number: row.number, token, nowMs: now, createdTs: row.createdTs, fetchImpl: this.deps.fetchImpl,
        });
        await this.apply(row, insp, now);
      } catch (err) {
        console.warn(`[prTracker] ${row.repo}#${row.number} 확인 실패:`, err instanceof Error ? err.message : err);
        // 실패해도 간격은 지킨다 — 매 틱 재시도로 깃허브를 두드리지 않는다(다음 간격에 다시 본다).
        await this.deps.pullRequests.update(row.id, { lastCheckedTs: now });
      }
    }
  }

  private async apply(row: PullRequestRow, insp: PrInspection, now: number): Promise<void> {
    const { patch, notices } = planPrUpdate(row, insp, now);
    await this.deps.pullRequests.update(row.id, patch);
    if (notices.length === 0) return;
    const channelRef = row.conversationId === null ? null : (await this.deps.conversations.getById(row.conversationId))?.discordChannelId ?? null;
    if (channelRef === null) {
      console.warn(`[prTracker] ${row.repo}#${row.number} 을 낸 대화를 찾지 못해 알림을 건너뜁니다(대화 ${row.conversationId ?? "없음"})`);
      return;
    }
    for (const n of notices) {
      this.deps.bus.publish({ type: n.kind, channel: "discord", channelRef, text: n.text, ts: now });
    }
  }

  // 운영자에게 새 PR 을 알린다. 운영자 자신이 낸 PR 은 건너뛴다(자기에게 자기 PR 을 알릴 이유가 없다).
  // 채널은 PR_NOTIFY_CHANNEL_ID → 소유자 DM 순으로 찾고, 둘 다 없으면 로그만 남기되 표시는 남긴다 —
  // 채널이 생길 때까지 매 틱 같은 경고를 반복하지 않기 위해서다.
  private async notifyOwner(row: PullRequestRow, now: number): Promise<void> {
    if (row.requesterUserId !== this.deps.ownerId) {
      let channelRef: string | null = this.deps.notifyChannelId ?? null;
      if (channelRef === null) channelRef = (await this.deps.conversations.findDmFor(this.deps.ownerId))?.discordChannelId ?? null;
      if (channelRef === null) {
        console.warn(`[prTracker] 운영자에게 알릴 채널이 없어요 — 소유자 DM 대화도 PR_NOTIFY_CHANNEL_ID 도 없습니다(${row.repo}#${row.number})`);
      } else {
        let names: Record<string, string> = {};
        try {
          names = await this.deps.users.displayNames();
        } catch (err) {
          console.error("[prTracker] 표시 이름 조회 실패 — id 로 진행:", err);
        }
        this.deps.bus.publish({
          type: "assistant_message", channel: "discord", channelRef,
          text: ownerNoticeText(row, names[row.requesterUserId] ?? row.requesterUserId), ts: now,
        });
      }
    }
    await this.deps.pullRequests.update(row.id, { ownerNotifiedTs: now });
  }
}
