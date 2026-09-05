import { describe, it, expect } from "vitest";
import { profileFor, GUEST_MODEL } from "../src/core/profiles.js";

// 풀 하네스 2단계(2026-09-05 밤): 신원 → 세션 프로필(스펙 §6). 2단계에서 새 경로를 타는 것은 소유자 턴뿐이지만,
// 프로필은 네 신원 모두 정의해 둔다 — 5단계(부원 개방)가 이 표를 그대로 쓴다. 소유자 = 전부(Opus 5·기본 effort·
// 서브에이전트 열림), 손님 = 절약(Sonnet 5·낮은 effort·서브에이전트 끔).
describe("profileFor", () => {
  const owner = { ownerModel: "claude-opus-5" };

  it("소유자(DM·서버)는 운영자 모델·기본 effort·서브에이전트 열림", () => {
    for (const isPrivate of [true, false]) {
      const p = profileFor({ isOwner: true, isPrivate, role: "owner" }, owner);
      expect(p).toEqual({ model: "claude-opus-5", maxTurns: 30, subagents: true });
    }
  });

  it("손님(DM·서버)은 Sonnet 5·낮은 effort·서브에이전트 끔", () => {
    for (const isPrivate of [true, false]) {
      const p = profileFor({ isOwner: false, isPrivate, role: "allowed" }, owner);
      expect(p).toEqual({ model: GUEST_MODEL, effort: "low", maxTurns: 30, subagents: false });
    }
    expect(GUEST_MODEL).toBe("claude-sonnet-5");
  });

  it("maxTurns 를 주입할 수 있다(봇의 상한과 같은 값을 넘긴다)", () => {
    expect(profileFor({ isOwner: true, isPrivate: true, role: "owner" }, { ...owner, maxTurns: 12 }).maxTurns).toBe(12);
  });
});
