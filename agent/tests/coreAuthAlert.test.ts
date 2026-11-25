import { describe, it, expect, vi } from "vitest";
import { setupCore, flush, dmHint, threadHint, say } from "./helpers/coreSetup.js";
import { AUTH_ALERT_COOLDOWN_MS } from "../src/core/authFailure.js";

// 빠른 개선 1.1(2026-11-25 설계): 구독 인증 실패를 소유자 DM 에 알린다. 2026-11-25 의 실제 문구로 재현한다.
const REVOKED = "Claude Code returned an error result: Failed to authenticate. API Error: 401 OAuth access token has been revoked.";

async function withOwnerDm(f: Awaited<ReturnType<typeof setupCore>>) {
  // 소유자 DM 대화를 먼저 만든다 — 경보는 그 대화 채널로 간다(index.ts 의 워커 부재 경보와 같은 자리).
  say(f.bus, dmHint("owner", "owner"), "안녕");
  await flush();
  await f.core.drain();
  f.published.length = 0;
}

describe("인증 실패 — 결과(ok:false) 갈래", () => {
  it("부원 턴이 인증 실패로 끝나면 부원에게는 '운영자에게 알렸다', 소유자 DM 에는 조치가 담긴 경보가 간다", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    let fail = false;
    const f = await setupCore({ runTurn: async () => (fail ? { ok: false, text: `(에이전트 오류: ${REVOKED})` } : { ok: true, text: "답", sessionId: "s1" }) });
    await withOwnerDm(f);
    fail = true;

    say(f.bus, threadHint("guest", "th-1", "allowed"), "빌드해줘");
    await flush();
    await f.core.drain();

    const toGuest = f.eventsIn("th-1", "system_notice").map((e) => ("text" in e ? e.text : ""));
    expect(toGuest).toHaveLength(1);
    expect(toGuest[0]).toMatch(/운영자에게 알렸/);
    expect(toGuest[0]).not.toContain("API Error");
    // 경보는 턴을 끝내지 않는 side_notice 다 — 소유자가 DM 에서 다른 작업을 돌리는 중이어도 그 상태를 닫지 않는다.
    const toOwner = f.eventsIn("dm-owner", "side_notice").map((e) => ("text" in e ? e.text : ""));
    expect(toOwner).toHaveLength(1);
    expect(toOwner[0]).toContain("CLAUDE_CODE_OAUTH_TOKEN");
    expect(toOwner[0]).toContain("revoked");
    expect(f.eventsIn("dm-owner", "system_notice")).toHaveLength(0);
  });

  it("주기 안의 두 번째 실패는 소유자에게 다시 알리지 않고, 주기가 지나면 다시 알린다", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    let fail = false;
    const f = await setupCore({ runTurn: async () => (fail ? { ok: false, text: REVOKED } : { ok: true, text: "답", sessionId: "s1" }) });
    await withOwnerDm(f);
    fail = true;

    say(f.bus, threadHint("guest", "th-a", "allowed"), "하나");
    await flush(); await f.core.drain();
    say(f.bus, threadHint("guest2", "th-b", "allowed"), "둘");
    await flush(); await f.core.drain();
    expect(f.eventsIn("dm-owner", "side_notice")).toHaveLength(1);

    f.setClock(f.now() + AUTH_ALERT_COOLDOWN_MS);
    say(f.bus, threadHint("guest", "th-c", "allowed"), "셋");
    await flush(); await f.core.drain();
    expect(f.eventsIn("dm-owner", "side_notice")).toHaveLength(2);
  });

  it("소유자 자신의 DM 에서 난 실패는 그 자리 안내가 곧 알림이라 같은 채널에 두 번 보내지 않는다", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    let fail = false;
    const f = await setupCore({ runTurn: async () => (fail ? { ok: false, text: REVOKED } : { ok: true, text: "답", sessionId: "s1" }) });
    await withOwnerDm(f);
    fail = true;

    say(f.bus, dmHint("owner", "owner"), "상태 어때");
    await flush(); await f.core.drain();

    const notices = f.eventsIn("dm-owner", "system_notice").map((e) => ("text" in e ? e.text : ""));
    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain("CLAUDE_CODE_OAUTH_TOKEN");
    expect(f.eventsIn("dm-owner", "side_notice")).toHaveLength(0);
  });

  it("인증과 무관한 실패는 지금처럼 원문 안내만 하고 경보는 없다", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    let fail = false;
    const f = await setupCore({ runTurn: async () => (fail ? { ok: false, text: "(에이전트 오류: error_max_turns)" } : { ok: true, text: "답", sessionId: "s1" }) });
    await withOwnerDm(f);
    fail = true;

    say(f.bus, threadHint("guest", "th-x", "allowed"), "긴 작업");
    await flush(); await f.core.drain();

    const toGuest = f.eventsIn("th-x", "system_notice").map((e) => ("text" in e ? e.text : ""));
    expect(toGuest).toEqual(["비서 처리 중 오류가 있었어요: (에이전트 오류: error_max_turns)"]);
    expect(f.eventsIn("dm-owner")).toHaveLength(0);
  });
});

describe("인증 실패 — 예외 갈래", () => {
  it("SDK 가 인증 실패로 던져도 같은 안내·경보로 바뀐다(예기치 못한 오류 문구가 아니다)", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    let fail = false;
    const f = await setupCore({
      runTurn: async () => {
        if (fail) throw new Error(REVOKED);
        return { ok: true, text: "답", sessionId: "s1" };
      },
    });
    await withOwnerDm(f);
    fail = true;

    say(f.bus, threadHint("guest", "th-e", "allowed"), "해줘");
    await flush(); await f.core.drain();

    const toGuest = f.eventsIn("th-e", "system_notice").map((e) => ("text" in e ? e.text : ""));
    expect(toGuest).toHaveLength(1);
    expect(toGuest[0]).toMatch(/운영자에게 알렸/);
    expect(f.eventsIn("dm-owner", "side_notice")).toHaveLength(1);
  });

  it("소유자 DM 대화가 아직 없으면 경보는 로그로만 남고 턴 처리는 계속된다", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const f = await setupCore({ runTurn: async () => ({ ok: false, text: REVOKED }) });

    say(f.bus, threadHint("guest", "th-n", "allowed"), "해줘");
    await flush(); await f.core.drain();

    expect(f.eventsIn("th-n", "system_notice")).toHaveLength(1);
    expect(err.mock.calls.some((args) => args.some((a) => typeof a === "string" && a.includes("[auth]")))).toBe(true);
  });
});
