import { describe, it, expect } from "vitest";
import path from "node:path";
import { normalizeRepoName, decideOwnership, publishSourceDir } from "../src/core/publish.js";

describe("normalizeRepoName", () => {
  it("영숫자·하이픈·밑줄은 그대로 통과한다", () => {
    expect(normalizeRepoName("todo-app")).toBe("todo-app");
    expect(normalizeRepoName("my_site2")).toBe("my_site2");
  });

  it("앞뒤 공백은 다듬는다", () => {
    expect(normalizeRepoName("  todo-app  ")).toBe("todo-app");
  });

  // 이 거절이 경로 조작을 막는 자리다 — 이름이 그대로 폴더 이름이 되기 때문이다.
  it("경로 구분자·상위 이동·드라이브 문자는 거절한다", () => {
    expect(normalizeRepoName("../etc")).toBeNull();
    expect(normalizeRepoName("a/b")).toBeNull();
    expect(normalizeRepoName("a\\b")).toBeNull();
    expect(normalizeRepoName("C:")).toBeNull();
    expect(normalizeRepoName(".")).toBeNull();
  });

  it("빈 이름·공백뿐인 이름은 거절한다", () => {
    expect(normalizeRepoName("")).toBeNull();
    expect(normalizeRepoName("   ")).toBeNull();
  });

  it("너무 긴 이름은 거절한다(깃허브 상한 100자)", () => {
    expect(normalizeRepoName("a".repeat(100))).toBe("a".repeat(100));
    expect(normalizeRepoName("a".repeat(101))).toBeNull();
  });

  // joinUnderRoot(paths.ts)의 세그먼트 규칙과 반드시 같아야 한다 — 여기서 통과시킨 이름이
  // 거기서 던지면 사용자에게는 "알 수 없는 오류"로만 보인다.
  it("점이 든 이름은 거절한다(joinUnderRoot 세그먼트 규칙과 일치)", () => {
    expect(normalizeRepoName("my.app")).toBeNull();
  });
});

describe("decideOwnership", () => {
  const row = { id: 1, repoName: "todo-app", ownerUserId: "u1", createdTs: 1, lastPushTs: null };

  it("없는 이름이면 새로 만들 수 있다", () => {
    expect(decideOwnership({ repoName: "todo-app", requesterUserId: "u1", existing: null }))
      .toEqual({ ok: true, repoName: "todo-app" });
  });

  it("내 것이면 통과한다", () => {
    expect(decideOwnership({ repoName: "todo-app", requesterUserId: "u1", existing: row }))
      .toEqual({ ok: true, repoName: "todo-app" });
  });

  // 남의 리포에 푸시하는 것을 막는 유일한 지점이다.
  it("남의 것이면 거절하고, 사유에 남의 아이디를 노출하지 않는다", () => {
    const d = decideOwnership({ repoName: "todo-app", requesterUserId: "u2", existing: row });
    expect(d.ok).toBe(false);
    if (!d.ok) {
      expect(d.reason).toContain("todo-app");
      expect(d.reason).not.toContain("u1");
    }
  });
});

describe("publishSourceDir", () => {
  it("작업 폴더 아래 프로젝트 이름을 잇는다(윈도우 워커)", () => {
    expect(publishSourceDir({ workspaceDir: "C:\\ws\\111", repoName: "todo-app" }))
      .toBe(path.win32.join("C:\\ws\\111", "todo-app"));
  });

  it("POSIX 워커도 그 플레이버로 잇는다", () => {
    expect(publishSourceDir({ workspaceDir: "/ws/111", repoName: "todo-app" }))
      .toBe(path.posix.join("/ws/111", "todo-app"));
  });
});
