import { describe, it, expect } from "vitest";
import { profileFor, GUEST_MODEL, OWNER_MCP_HUB, GUEST_MCP_HUB } from "../src/core/profiles.js";

// 풀 하네스 2단계(2026-09-05 밤): 신원 → 세션 프로필(스펙 §6). 2단계에서 새 경로를 타는 것은 소유자 턴뿐이지만,
// 프로필은 네 신원 모두 정의해 둔다 — 5단계(부원 개방)가 이 표를 그대로 쓴다. 소유자 = 전부(Opus 5·기본 effort·
// 서브에이전트 열림), 손님 = 절약(Sonnet 5·낮은 effort·서브에이전트 끔).
describe("profileFor", () => {
  const owner = { ownerModel: "claude-opus-5" };

  it("소유자(DM·서버)는 운영자 모델·기본 effort·서브에이전트 열림·허브 MCP(GitHub·Supabase)", () => {
    for (const isPrivate of [true, false]) {
      const p = profileFor({ isOwner: true, isPrivate, role: "owner" }, owner);
      expect(p).toEqual({ model: "claude-opus-5", maxTurns: 30, subagents: true, mcpHub: ["github", "supabase"] });
    }
    // 4단계 4.1·4.2: 소유자만 허브 GitHub·Supabase 를 연다. 상수와 어긋나지 않게 대조한다.
    expect([...OWNER_MCP_HUB]).toEqual(["github", "supabase"]);
  });

  it("손님(DM·서버)은 Sonnet 5·낮은 effort·서브에이전트 끔·허브 MCP 는 Supabase 만", () => {
    for (const isPrivate of [true, false]) {
      const p = profileFor({ isOwner: false, isPrivate, role: "allowed" }, owner);
      expect(p).toEqual({ model: GUEST_MODEL, effort: "low", maxTurns: 30, subagents: false, mcpHub: ["supabase"] });
      // ADR 0010(2026-09-17): DB 읽기는 신원으로 갈리지 않는다 — 봇 세션 경로에서 열어 두고 하네스
      // 경로만 닫으면 "같은 사람이 같은 채널에서 물어도 경로에 따라 답이 갈리는" 어긋남이 남는다.
      // GitHub 허브는 그대로 소유자만이다(설치 토큰이라 축이 다르다).
      expect(p.mcpHub).not.toContain("github");
    }
    expect([...GUEST_MCP_HUB]).toEqual(["supabase"]);
    expect(GUEST_MODEL).toBe("claude-sonnet-5");
  });

  it("maxTurns 를 주입할 수 있다(봇의 상한과 같은 값을 넘긴다)", () => {
    expect(profileFor({ isOwner: true, isPrivate: true, role: "owner" }, { ...owner, maxTurns: 12 }).maxTurns).toBe(12);
  });
});
