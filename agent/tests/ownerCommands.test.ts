import { describe, it, expect, vi } from "vitest";
import {
  parseStatusCommand, parseAccessCommand, isChannelCommand, isReservedCommand, isInstantCommand, renderCommandHelp,
} from "../src/core/commands.js";
import { formatRuntimeInfo, type RuntimeInfo } from "../src/core/tools.js";
import { setupCore, flush, threadHint, dmHint } from "./helpers/coreSetup.js";
import type { ConversationHint } from "../src/events/bus.js";

// 빠른 개선 2차 §1(2026-11-25) — 모델을 거치지 않는 운영자 예약어. 소유자 턴은 하네스로 가서 manage_access·runtime_info 가
// 없으므로, 등록·차단·상태 확인을 예약어로 한다. 셋 다 턴을 시작하지 않는 즉시 명령이다(답은 side_notice).

describe("예약어 파싱", () => {
  it("/상태 는 정확히 일치할 때만", () => {
    for (const t of ["/상태", "/status", "  /STATUS "]) expect(parseStatusCommand(t)).toBe(true);
    for (const t of ["상태", "/상태 알려줘", "/상태확인"]) expect(parseStatusCommand(t)).toBe(false);
  });

  it("/차단·/허용 은 멘션이나 숫자 ID 하나를 대상으로 받는다", () => {
    expect(parseAccessCommand("/차단 <@123456>")).toEqual({ action: "block", userId: "123456" });
    expect(parseAccessCommand("/block <@!123456>")).toEqual({ action: "block", userId: "123456" });
    expect(parseAccessCommand("/허용 123456")).toEqual({ action: "allow", userId: "123456" });
    for (const t of ["/해제 <@123456>", "/allow 123456", "/unblock 123456"]) expect(parseAccessCommand(t)?.action).toBe("allow");
  });

  it("대상이 없거나 둘 이상이거나 모양이 틀리면 대상 없음으로 돌려준다(코어가 다시 묻는다)", () => {
    for (const t of ["/차단", "/차단 홍길동", "/차단 <@123456> <@654321>", "/허용 12"]) {
      expect(parseAccessCommand(t)).toEqual({ action: expect.any(String), userId: null });
    }
  });

  it("예약어가 아닌 문장은 null", () => {
    for (const t of ["/허용하는 방법 알려줘", "차단해줘", "/차단해", ""]) expect(parseAccessCommand(t)).toBeNull();
  });

  it("채널 명령이고(멘션 없이 일반 채널에서 된다), 예약어이고, 즉시 명령이다", () => {
    for (const t of ["/상태", "/차단 <@123456>", "/허용 123456"]) {
      expect(isChannelCommand(t)).toBe(true);
      expect(isReservedCommand(t)).toBe(true);
      expect(isInstantCommand(t)).toBe(true);
    }
    expect(isInstantCommand("/취소")).toBe(true);
    expect(isInstantCommand("/help")).toBe(false);
    expect(isInstantCommand("안녕")).toBe(false);
  });

  it("/help 안내문에 나온다", () => {
    const help = renderCommandHelp(true);
    expect(help).toContain("/상태");
    expect(help).toContain("/차단 @사람");
    expect(help).toContain("/허용 @사람");
  });
});

const runtime: RuntimeInfo = {
  model: "claude-opus-5", sdkVersion: "0.3.207", deployTarget: "local", maxTurns: 60,
  botCommit: "b9db146aaaa", botBranch: "production", workers: [{ workerId: "w1", commit: "b9db146aaaa", connectedAt: 1 }],
};

function send(f: Awaited<ReturnType<typeof setupCore>>, hint: ConversationHint, text: string): void {
  f.bus.publish({ type: "user_message", channel: "discord", channelRef: hint.discordChannelId, text, ts: 1_000_000, hint });
}

const texts = (f: Awaited<ReturnType<typeof setupCore>>, ref: string, type: "side_notice" | "assistant_message" | "system_notice") =>
  f.eventsIn(ref, type).map((e) => ("text" in e ? e.text : ""));

describe("코어 — /상태", () => {
  it("runtime_info 와 같은 내용을 side_notice 로 답하고, 대화·메시지·모델 호출을 만들지 않는다", async () => {
    const f = await setupCore({ runtimeInfo: () => runtime });
    send(f, threadHint("guest", "th-s", "allowed"), "/상태");
    await flush(); await f.core.drain();
    expect(texts(f, "th-s", "side_notice")).toEqual([formatRuntimeInfo(runtime)]);
    expect(texts(f, "th-s", "assistant_message")).toEqual([]);
    expect(f.calls).toHaveLength(0);
    expect(await f.repos.conversations.getByChannelId("th-s")).toBeNull();
    expect(formatRuntimeInfo(runtime)).toMatch(/봇과 워커 커밋이 같아요/);
  });

  it("일반 채널의 채널 명령으로도 된다", async () => {
    const f = await setupCore({ runtimeInfo: () => runtime });
    send(f, { ...threadHint("guest", "general", "allowed"), commandOnly: true }, "/상태");
    await flush(); await f.core.drain();
    expect(texts(f, "general", "side_notice")).toEqual([formatRuntimeInfo(runtime)]);
  });
});

describe("코어 — /차단·/허용", () => {
  it("운영자가 치면 역할을 바꾸고, 결과 문구는 대상을 멘션하지 않는다", async () => {
    const f = await setupCore();
    await f.repos.users.upsert("200000", { role: "allowed", displayName: "밥" });
    send(f, dmHint("owner", "owner"), "/차단 <@200000>");
    await flush(); await f.core.drain();
    expect(await f.repos.users.getRole("200000")).toBe("blocked");
    const [notice] = texts(f, "dm-owner", "side_notice");
    expect(notice).toMatch(/밥\(200000\).*차단/);
    expect(notice).not.toMatch(/<@/);

    send(f, threadHint("owner", "th-a", "owner"), "/허용 200000");
    await flush(); await f.core.drain();
    expect(await f.repos.users.getRole("200000")).toBe("allowed");
    expect(texts(f, "th-a", "side_notice")[0]).toMatch(/허용/);
    expect(f.calls).toHaveLength(0);
  });

  it("운영자가 아니면 거절하고 아무것도 바꾸지 않는다", async () => {
    const f = await setupCore();
    send(f, threadHint("guest", "th-b", "allowed"), "/차단 <@guest2>");
    send(f, threadHint("guest", "th-b", "allowed"), "/차단 300000");
    await flush(); await f.core.drain();
    expect(await f.repos.users.getRole("300000")).toBe("blocked"); // 원래 미등록(=blocked) 그대로
    expect(await f.repos.users.getRole("guest2")).toBe("allowed");
    expect(texts(f, "th-b", "side_notice").every((t) => /운영자만/.test(t))).toBe(true);
  });

  it("대상이 없으면 다시 묻고, 운영자 자신은 바꿀 수 없다", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    // 실제 디스코드 ID 처럼 숫자인 운영자 — 대상 파싱은 숫자 ID 만 받는다.
    const f = await setupCore({ config: { ownerId: "100000" } });
    await f.repos.users.upsert("100000", { role: "owner" });
    send(f, dmHint("100000", "owner"), "/차단");
    send(f, dmHint("100000", "owner"), "/차단 <@100000>");
    await flush(); await f.core.drain();
    const [ask, self] = texts(f, "dm-100000", "side_notice");
    expect(ask).toMatch(/@멘션|숫자 ID/);
    expect(self).toMatch(/운영자 자신/);
    expect(await f.repos.users.getRole("100000")).toBe("owner");
  });
});
