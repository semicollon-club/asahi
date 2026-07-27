import { describe, it, expect } from "vitest";
import { resolveWorkerSelector, scopeDirs } from "../src/core/workerSelect.js";
import { joinUnderRoot } from "../src/core/paths.js";

describe("resolveWorkerSelector — 어디서 말하느냐가 어느 기계냐를 정한다", () => {
  it("소유자 DM 은 그 소유자의 개인 워커", () => {
    expect(resolveWorkerSelector({ isOwner: true, isPrivate: true, userId: "owner" }))
      .toEqual({ kind: "personal", userId: "owner" });
  });

  it("소유자가 서버에 있으면 공유 워커", () => {
    expect(resolveWorkerSelector({ isOwner: true, isPrivate: false, userId: "owner" }))
      .toEqual({ kind: "shared" });
  });

  it("손님은 DM 이든 서버든 공유 워커", () => {
    expect(resolveWorkerSelector({ isOwner: false, isPrivate: true, userId: "g" })).toEqual({ kind: "shared" });
    expect(resolveWorkerSelector({ isOwner: false, isPrivate: false, userId: "g" })).toEqual({ kind: "shared" });
  });
});

describe("joinUnderRoot — 워커 플랫폼의 구분자를 따른다", () => {
  it("윈도우 루트에는 역슬래시로 잇는다", () => {
    expect(joinUnderRoot("C:\\workspace", "123")).toBe("C:\\workspace\\123");
    expect(joinUnderRoot("C:\\workspace\\", "123")).toBe("C:\\workspace\\123");
  });

  it("POSIX 루트에는 슬래시로 잇는다", () => {
    expect(joinUnderRoot("/srv/workspace", "123")).toBe("/srv/workspace/123");
    expect(joinUnderRoot("/srv/workspace/", "123")).toBe("/srv/workspace/123");
  });

  it("UNC 경로도 역슬래시", () => {
    expect(joinUnderRoot("\\\\nas\\share", "123")).toBe("\\\\nas\\share\\123");
  });
});

describe("scopeDirs — 공유 기계 안에서 사용자별로 가른다", () => {
  const dirs = ["C:\\workspace", "D:\\projects"];

  it("개인 워커는 목록을 그대로 쓴다", () => {
    expect(scopeDirs(dirs, { workerKind: "personal", isOwner: true, userId: "owner" })).toEqual(dirs);
  });

  it("공유 워커 + 소유자는 루트 전체", () => {
    expect(scopeDirs(dirs, { workerKind: "shared", isOwner: true, userId: "owner" })).toEqual(dirs);
  });

  it("공유 워커 + 손님은 본인 폴더로 좁혀진다", () => {
    expect(scopeDirs(dirs, { workerKind: "shared", isOwner: false, userId: "123" }))
      .toEqual(["C:\\workspace\\123", "D:\\projects\\123"]);
  });

  it("허용 폴더가 없으면 결과도 없다 — 빈 목록을 전체 허용으로 바꾸지 않는다", () => {
    expect(scopeDirs([], { workerKind: "shared", isOwner: false, userId: "123" })).toEqual([]);
  });
});
