import { describe, it, expect, vi, afterEach } from "vitest";
import {
  DiscordAdapter, formatProgressMessage, formatStatusHeader, formatProgressRecord, formatElapsed, STATUS_HEARTBEAT_MS,
  STATUS_HEARTBEAT_IDLE_MAX_MS,
} from "../src/adapters/discord.js";
import { EventBus } from "../src/events/bus.js";
import type { Config } from "../src/config.js";
import type { UsersRepo } from "../src/store/usersRepo.js";
import type { ConversationsRepo } from "../src/store/conversationsRepo.js";

// N1(b)(c) 진행 표시 2.0(2026-11-25 설계 §2): 머리줄에 단계·경과, 끝나도 남는 접힌 기록.

describe("formatElapsed", () => {
  it("1분 미만은 초, 이상은 분·초(0초는 생략)", () => {
    expect(formatElapsed(0)).toBe("0초");
    expect(formatElapsed(12_400)).toBe("12초");
    expect(formatElapsed(60_000)).toBe("1분");
    expect(formatElapsed(130_000)).toBe("2분 10초");
  });
});

describe("formatStatusHeader — 진행 중 머리줄", () => {
  it("단계가 있으면 단계와 경과", () => {
    expect(formatStatusHeader({ steps: 3, elapsedMs: 80_000 })).toBe("처리 중 · 3단계 · 경과 1분 20초");
  });
  it("도구를 아직 안 썼으면 경과만", () => {
    expect(formatStatusHeader({ steps: 0, elapsedMs: 5_000 })).toBe("처리 중 · 경과 5초");
  });
});

describe("formatProgressMessage — 머리줄을 받는다(없으면 예전 그대로)", () => {
  it("기본 머리줄은 '처리 중'", () => {
    expect(formatProgressMessage(["a"])).toBe("처리 중\n· a");
  });
  it("넘긴 머리줄을 쓴다", () => {
    expect(formatProgressMessage(["a"], "처리 중 · 1단계 · 경과 3초")).toBe("처리 중 · 1단계 · 경과 3초\n· a");
  });
});

describe("formatProgressRecord — 끝난 뒤 남는 기록", () => {
  const lines = ["판단: 테스트를 돌려 보겠습니다", "sh_exec npm test", "✓ sh_exec — 통과 (4.2초)", "판단: 모두 통과했습니다"];
  const kinds = ["note", "tool", "tool_result", "note"] as const;

  it("머리줄 + 스포일러로 접고, 마지막 도구 뒤의 판단 줄(=최종 답의 첫 문장)은 뺀다", () => {
    expect(formatProgressRecord(lines, [...kinds], { steps: 1, elapsedMs: 5_000 })).toBe(
      "작업 기록 · 1단계 · 5초\n||· 판단: 테스트를 돌려 보겠습니다\n· sh_exec npm test\n· ✓ sh_exec — 통과 (4.2초)||",
    );
  });

  it("줄 안의 || 는 스포일러를 끊지 않게 폭 없는 공백을 끼운다", () => {
    const r = formatProgressRecord(["sh_exec a || b", "✓ sh_exec"], ["tool", "tool_result"], { steps: 1, elapsedMs: 1_000 });
    expect(r).toContain("a |​| b");
    expect(r.match(/\|\|/g)?.length).toBe(2); // 여는 것·닫는 것 둘뿐
  });

  it("2000자를 넘으면 오래된 줄부터 빼고 생략 표시를 남긴다", () => {
    const many = Array.from({ length: 200 }, (_, i) => `sh_exec 명령 ${i} ${"x".repeat(30)}`);
    const r = formatProgressRecord(many, many.map(() => "tool"), { steps: 200, elapsedMs: 600_000 });
    expect(r.length).toBeLessThanOrEqual(2000);
    expect(r).toMatch(/\(앞 \d+줄 생략\)/);
    expect(r).toContain("명령 199"); // 최근 줄은 남는다
    expect(r.endsWith("||")).toBe(true);
  });

  it("연속 중복 줄은 하나로 접는다", () => {
    const r = formatProgressRecord(["a", "a", "b"], ["tool", "tool", "tool"], { steps: 3, elapsedMs: 0 });
    expect(r).toBe("작업 기록 · 3단계 · 0초\n||· a\n· b||");
  });
});

// ── 어댑터 수명주기: 상태 메시지를 만들고, 머리줄을 갱신하고, 끝날 때 기록으로 남기거나 지운다 ──
type FakeMsg = { content: string; edits: unknown[]; deleted: boolean; edit(p: unknown): Promise<FakeMsg>; delete(): Promise<void> };
function fakeMsg(content: string): FakeMsg {
  const m: FakeMsg = {
    content, edits: [], deleted: false,
    async edit(p) { m.edits.push(p); return m; },
    async delete() { m.deleted = true; },
  };
  return m;
}

type Testable = {
  client: unknown;
  handleProgress(channelRef: string, text: string, kind?: string, record?: string): Promise<void>;
  finishStatus(channelRef: string): Promise<void>;
  stop(): Promise<void>;
};

function makeConfig(): Config {
  return {
    discordToken: "t", ownerId: "owner", databaseUrl: "postgres://test", dataDir: ":memory:", memoryDir: "x",
    sessionIdleMinutes: 30, maxTurnsPerHour: 30, maxTurnsPerHourPerUser: 20, maxTurnsPerHourGlobal: 40, ownerReserve: 10,
    deployTarget: "local", model: "m", httpPort: 3000, digestChannels: {}, github: null,
  };
}

function makeAdapter() {
  const adapter = new DiscordAdapter({ bus: new EventBus(), config: makeConfig(), users: {} as unknown as UsersRepo, conversations: {} as unknown as ConversationsRepo });
  const sent: Array<{ payload: unknown; msg: FakeMsg }> = [];
  const view = adapter as unknown as Testable;
  view.client = {
    channels: {
      fetch: async () => ({
        isSendable: () => true,
        send: async (payload: unknown) => {
          const content = typeof payload === "string" ? payload : String((payload as { content?: string }).content ?? "");
          const msg = fakeMsg(content);
          sent.push({ payload, msg });
          return msg;
        },
      }),
    },
    destroy: async () => {},
  };
  return { view, sent };
}

const contentOf = (p: unknown) => (typeof p === "string" ? p : String((p as { content?: string }).content ?? ""));

afterEach(() => {
  vi.useRealTimers();
});

describe("DiscordAdapter — 진행 표시 수명주기", () => {
  it("도구를 쓴 턴은 끝나도 지우지 않고 접힌 기록으로 바꾼다", async () => {
    const { view, sent } = makeAdapter();
    await view.handleProgress("c1", "판단: 파일을 보겠습니다", "note");
    await view.handleProgress("c1", "fs_read a.ts", "tool");
    await view.handleProgress("c1", "✓ fs_read — 10줄 (0.1초)", "tool_result");
    await view.finishStatus("c1");

    expect(sent).toHaveLength(1);
    const status = sent[0].msg;
    expect(status.deleted).toBe(false);
    const last = status.edits.at(-1);
    expect(contentOf(last)).toMatch(/^작업 기록 · 1단계 · /);
    expect(contentOf(last)).toContain("fs_read a.ts");
  });

  it("도구를 한 번도 안 쓴 턴(짧은 대화)은 지금처럼 지운다", async () => {
    const { view, sent } = makeAdapter();
    await view.handleProgress("c2", "판단: 안녕하세요", "note");
    await view.finishStatus("c2");
    expect(sent[0].msg.deleted).toBe(true);
  });

  it("다음 턴은 단계 수와 기록을 처음부터 다시 센다", async () => {
    const { view, sent } = makeAdapter();
    await view.handleProgress("c3", "fs_read a", "tool");
    await view.finishStatus("c3");
    await view.handleProgress("c3", "판단: 인사", "note");
    await view.finishStatus("c3");
    expect(sent).toHaveLength(2);
    expect(sent[1].msg.deleted).toBe(true); // 두 번째 턴은 도구가 없었다 — 앞 턴의 단계가 이월되지 않는다
  });

  it("첫 상태 메시지의 머리줄에 경과가 있고, 하트비트가 경과를 다시 그린다", async () => {
    vi.useFakeTimers();
    const { view, sent } = makeAdapter();
    await view.handleProgress("c4", "sh_exec npm install", "tool");
    expect(contentOf(sent[0].payload)).toMatch(/^처리 중 · 1단계 · 경과 0초/);
    await vi.advanceTimersByTimeAsync(STATUS_HEARTBEAT_MS + 10);
    const edited = sent[0].msg.edits.map(contentOf);
    expect(edited.some((c) => /경과 1\d초/.test(c))).toBe(true);
    await view.finishStatus("c4");
    const before = sent[0].msg.edits.length;
    await vi.advanceTimersByTimeAsync(STATUS_HEARTBEAT_MS * 3);
    expect(sent[0].msg.edits.length).toBe(before); // 끝난 뒤에는 하트비트가 멈춘다
  });

  // 2026-11-25 리뷰 M5: 진행 중에는 흘러가던 도구 출력이 이제 공개 스레드에 영구히 남는다 — 기록에는 요약을 뺀 줄을 쓴다.
  it("기록에는 도구 결과의 요약 대신 기록용 줄(record)을 쓴다", async () => {
    const { view, sent } = makeAdapter();
    await view.handleProgress("c5", "fs_read .env", "tool");
    await view.handleProgress("c5", "✓ fs_read — TOKEN=sk-ant-oat01-xxxx (0.1초)", "tool_result", "✓ fs_read (0.1초)");
    await view.finishStatus("c5");
    const last = contentOf(sent[0].msg.edits.at(-1));
    expect(last).toContain("✓ fs_read (0.1초)");
    expect(last).not.toContain("sk-ant");
  });

  it("상태 메시지는 멘션 알림을 보내지 않는다 — 판단 줄·도구 출력에 든 @everyone 이 사람을 부르지 않게", async () => {
    const { view, sent } = makeAdapter();
    await view.handleProgress("c7", "판단: @everyone 에게 알릴게요", "note");
    expect((sent[0].payload as { allowedMentions?: unknown }).allowedMentions).toEqual({ parse: [] });
  });

  // 2026-11-25 리뷰 M4: 종료 이벤트를 놓친 상태 메시지가 봇이 사는 내내 15초마다 편집되지 않게.
  it("진행 이벤트가 상한 넘게 없으면 하트비트가 스스로 멈춘다", async () => {
    vi.useFakeTimers();
    const { view, sent } = makeAdapter();
    await view.handleProgress("c6", "sh_exec 오래 걸리는 명령", "tool");
    await vi.advanceTimersByTimeAsync(STATUS_HEARTBEAT_IDLE_MAX_MS + STATUS_HEARTBEAT_MS * 2);
    const n = sent[0].msg.edits.length;
    expect(n).toBeGreaterThan(0); // 상한 전까지는 경과를 다시 그렸다
    await vi.advanceTimersByTimeAsync(STATUS_HEARTBEAT_MS * 5);
    expect(sent[0].msg.edits.length).toBe(n);
  });
});
