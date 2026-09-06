import { describe, it, expect } from "vitest";
import { profileFor, GUEST_MODEL, OWNER_MCP_HUB } from "../src/core/profiles.js";

// 풀 하네스 2단계(2026-09-05 밤): 신원 → 세션 프로필(스펙 §6). 2단계에서 새 경로를 타는 것은 소유자 턴뿐이지만,
// 프로필은 네 신원 모두 정의해 둔다 — 5단계(부원 개방)가 이 표를 그대로 쓴다. 소유자 = 전부(Opus 5·기본 effort·
// 서브에이전트 열림), 손님 = 절약(Sonnet 5·낮은 effort·서브에이전트 끔).
describe("profileFor", () => {
  const owner = { ownerModel: "claude-opus-5" };

  it("소유자(DM·서버)는 운영자 모델·기본 effort·서브에이전트 열림·허브 MCP(GitHub)", () => {
    for (const isPrivate of [true, false]) {
      const p = profileFor({ isOwner: true, isPrivate, role: "owner" }, owner);
      expect(p).toEqual({ model: "claude-opus-5", maxTurns: 30, subagents: true, mcpHub: ["github"] });
    }
    // 4단계 4.1: 소유자만 허브 GitHub 를 연다. 상수와 어긋나지 않게 대조한다.
    expect([...OWNER_MCP_HUB]).toEqual(["github"]);
  });

  it("손님(DM·서버)은 Sonnet 5·낮은 effort·서브에이전트 끔·허브 MCP 없음", () => {
    for (const isPrivate of [true, false]) {
      const p = profileFor({ isOwner: false, isPrivate, role: "allowed" }, owner);
      expect(p).toEqual({ model: GUEST_MODEL, effort: "low", maxTurns: 30, subagents: false });
      // 손님 프로필에는 mcpHub 키 자체가 없다(§6: 손님 허브는 "부원용으로 연 것만", 지금은 없음).
      expect("mcpHub" in p).toBe(false);
    }
    expect(GUEST_MODEL).toBe("claude-sonnet-5");
  });

  it("maxTurns 를 주입할 수 있다(봇의 상한과 같은 값을 넘긴다)", () => {
    expect(profileFor({ isOwner: true, isPrivate: true, role: "owner" }, { ...owner, maxTurns: 12 }).maxTurns).toBe(12);
  });
});
