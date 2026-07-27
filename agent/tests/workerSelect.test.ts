import { describe, it, expect } from "vitest";
import { resolveWorkerSelector, scopeDirs } from "../src/core/workerSelect.js";
import { joinUnderRoot, isPathWithin } from "../src/core/paths.js";

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

// Task 6 리뷰 이월: joinUnderRoot 는 동아리 회원 한 명을 다른 회원의 폴더 밖에 묶어 두는 마지막
// 경계다. 지금까지는 "userId 는 항상 디스코드 스노플레이크(숫자)"라는 호출측의 습관에만 기대고
// 있었다 — 이 블록은 그 습관이 깨진 경우(크래프트한 조각)에도 이 함수 자신이 탈출을 막는지 확인한다.
describe("joinUnderRoot — 세그먼트 검증(회원 격리의 마지막 경계)", () => {
  it("디스코드 스노플레이크(숫자)는 평소대로 이어붙인다", () => {
    expect(joinUnderRoot("C:\\ws", "123456789012345678")).toBe("C:\\ws\\123456789012345678");
  });

  it("영숫자·밑줄·하이픈 조각도 허용한다(숫자 전용은 아니다 — 미래의 비-디스코드 식별자 대비)", () => {
    expect(joinUnderRoot("C:\\ws", "user-1_2")).toBe("C:\\ws\\user-1_2");
  });

  it("경로 구분자가 섞인 조각은 거부한다 — 다른 회원 폴더로 빠져나가려는 시도", () => {
    expect(() => joinUnderRoot("C:\\ws", "111/../222")).toThrow();
    expect(() => joinUnderRoot("C:\\ws", "111\\222")).toThrow();
    expect(() => joinUnderRoot("C:\\ws", "111/222")).toThrow();
  });

  it("'..' 자체를 거부한다", () => {
    expect(() => joinUnderRoot("C:\\ws", "..")).toThrow();
  });

  it("드라이브 문자 접두를 거부한다 — 결과 경로를 통째로 다른 절대경로로 바꿔치기하려는 시도", () => {
    expect(() => joinUnderRoot("C:\\ws", "C:\\evil")).toThrow();
  });

  it("크래프트한 조각으로는 검증을 거치지 않고서는 루트 밖으로 나가는 경로 자체가 만들어지지 않는다", () => {
    const root = "C:\\ws";
    const crafted = "..\\..\\Windows\\System32";
    expect(() => joinUnderRoot(root, crafted)).toThrow();
    // 검증이 없었다면 만들어졌을 값이 실제로 루트 밖이라는 것도 함께 확인한다(왜 막아야 하는지).
    const wouldBeEscaped = `${root}\\${crafted}`;
    expect(isPathWithin(wouldBeEscaped, root)).toBe(false);
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

  // Task 6 리뷰 이월: userId 는 joinUnderRoot 로 그대로 넘어간다 — 크래프트한 값이 와도 이
  // 함수가 조용히 잘못된 경로를 만들지 않고 예외로 실패해야 한다(remoteToolHandler 가 이미
  // try/catch 로 감싸고 있어 fail closed 로 이어진다 — remoteTools.test.ts 참고).
  it("크래프트한 userId(상위 참조 등)가 들어와도 예외를 던져 격리를 깨지 않는다", () => {
    expect(() => scopeDirs(dirs, { workerKind: "shared", isOwner: false, userId: "../222" })).toThrow();
  });
});
