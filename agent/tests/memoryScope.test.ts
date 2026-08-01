import { describe, it, expect } from "vitest";
import { memoryScopeFor, SHARED_MEMORY_MAX_LEN, renderMemories } from "../src/core/memoryScope.js";

describe("memoryScopeFor — 어디서 말하느냐가 스코프를 정한다", () => {
  it("DM 은 개인 기억이다", () => {
    expect(memoryScopeFor({ isPrivate: true })).toBe("user");
  });

  it("서버 채널은 동아리 공용 기억이다", () => {
    // 모델이 스코프를 고르게 하면 틀릴 수 있다 — 개인 얘기가 전원에게 보이거나 동아리
    // 사실이 한 사람에게만 남는다. 위치는 틀릴 수가 없다.
    expect(memoryScopeFor({ isPrivate: false })).toBe("shared");
  });

  it("신원과 무관하다 — 소유자든 손님이든 위치만 본다", () => {
    // 이 함수가 isOwner 를 받지 않는 것이 설계다. 받으면 "소유자는 서버에서도 개인 기억"
    // 같은 갈래가 생기고, 그때부터 어디에 뭐가 저장됐는지 사람이 추적할 수 없게 된다.
    expect(memoryScopeFor({ isPrivate: false })).toBe("shared");
    expect(memoryScopeFor({ isPrivate: true })).toBe("user");
  });

  it("상한은 4000자다", () => {
    expect(SHARED_MEMORY_MAX_LEN).toBe(4000);
  });
});

const mem = (o: Partial<{ id: number; userId: string; scope: "user" | "shared" | "character"; title: string; content: string }> = {}) =>
  ({ id: 1, userId: "u1", scope: "shared" as const, title: "회비", content: "학기당 2만원", ...o }) as never;

describe("renderMemories — 공용 기억에는 작성자를 붙인다", () => {
  it("공용 기억에 작성자 이름을 붙인다", () => {
    const out = renderMemories([mem()], { u1: "우성현" });
    expect(out).toContain("회비");
    expect(out).toContain("학기당 2만원");
    expect(out).toContain("우성현");
  });

  it("개인 기억에는 붙이지 않는다", () => {
    // 본인 것이라 작성자가 자명하다.
    const out = renderMemories([mem({ scope: "user", title: "내 취향", content: "커피" })], { u1: "우성현" });
    expect(out).toContain("내 취향");
    expect(out).not.toContain("우성현");
  });

  it("이름을 모르면 표시를 생략한다", () => {
    // 숫자 id 를 보여주면 읽는 사람에게 아무 의미가 없다.
    const out = renderMemories([mem()], {});
    expect(out).toContain("회비");
    expect(out).not.toContain("u1");
  });

  it("비어 있으면 빈 문자열이다", () => {
    expect(renderMemories([], {})).toBe("");
  });
});
