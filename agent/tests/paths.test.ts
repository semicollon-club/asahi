import { describe, it, expect } from "vitest";
import path from "node:path";
import { isPathWithin, isPathWithinAny, normalizeDir } from "../src/core/paths.js";

describe("isPathWithin", () => {
  it("같은 경로면 true", () => {
    expect(isPathWithin("C:\\a\\b", "C:\\a\\b")).toBe(true);
  });

  it("하위 경로면 true", () => {
    expect(isPathWithin("C:\\a\\b\\c\\d.txt", "C:\\a\\b")).toBe(true);
  });

  it("접두사만 같은 형제 폴더는 false (C:\\a\\bc 는 C:\\a\\b 밖)", () => {
    expect(isPathWithin("C:\\a\\bc", "C:\\a\\b")).toBe(false);
    expect(isPathWithin("C:\\a\\bc\\d.txt", "C:\\a\\b")).toBe(false);
  });

  it("..으로 상위 탈출하면 false", () => {
    expect(isPathWithin("C:\\a\\b\\..\\..\\escape", "C:\\a\\b")).toBe(false);
    expect(isPathWithin("C:\\a\\b\\..", "C:\\a\\b")).toBe(false); // dir 자체의 부모
  });

  it("target 이 절대경로로 dir 밖을 가리키면 false", () => {
    expect(isPathWithin("C:\\other\\place", "C:\\a\\b")).toBe(false);
    expect(isPathWithin("D:\\a\\b\\c", "C:\\a\\b")).toBe(false); // 드라이브 다름
  });

  it("후행 슬래시가 있어도 정상 판정", () => {
    expect(isPathWithin("C:\\a\\b\\c", "C:\\a\\b\\")).toBe(true);
    expect(isPathWithin("C:\\a\\b\\", "C:\\a\\b")).toBe(true);
  });

  it("Windows 대소문자를 무시하고 비교한다", () => {
    expect(isPathWithin("c:\\A\\B\\c.txt", "C:\\a\\b")).toBe(true);
    expect(isPathWithin("C:\\A\\B", "c:\\a\\b")).toBe(true);
  });

  it("'..'로 시작하지만 실제로는 하위인 이름은 true (예: ..foobar 폴더)", () => {
    expect(isPathWithin("C:\\a\\b\\..foobar\\file.txt", "C:\\a\\b")).toBe(true);
  });

  it("dir 과 무관한 완전히 다른 경로는 false", () => {
    expect(isPathWithin("C:\\x\\y", "C:\\a\\b")).toBe(false);
  });
});

describe("isPathWithinAny", () => {
  it("빈 배열이면 false", () => {
    expect(isPathWithinAny("C:\\a\\b\\c", [])).toBe(false);
  });

  it("여러 dir 중 하나라도 within 이면 true", () => {
    const dirs = ["C:\\x\\y", "C:\\a\\b", "C:\\z"];
    expect(isPathWithinAny("C:\\a\\b\\c.txt", dirs)).toBe(true);
  });

  it("어느 dir 에도 속하지 않으면 false", () => {
    const dirs = ["C:\\x\\y", "C:\\z"];
    expect(isPathWithinAny("C:\\a\\b\\c.txt", dirs)).toBe(false);
  });
});

describe("normalizeDir", () => {
  it("절대경로로 정규화한다(후행 슬래시 제거)", () => {
    expect(normalizeDir("C:\\a\\b\\")).toBe(path.win32.resolve("C:\\a\\b"));
    expect(normalizeDir("C:\\a\\b")).toBe(path.win32.resolve("C:\\a\\b"));
  });

  // [Task 6 검토 필요] 이 입력("some\relative\dir")은 드라이브 문자·UNC 접두가 없어
  // pathFlavorOf 가 POSIX 로 판정한다(brief 의 판정 규칙 그대로). 그래서 정답은 이제
  // "이 프로세스가 어느 플랫폼이냐"(path.resolve, 호출부 플랫폼 종속)가 아니라
  // "이 문자열이 어느 플랫폼처럼 생겼냐"(path.posix.resolve)로 정의된다 — 이 함수를
  // 플랫폼 인식으로 바꾼 목적 자체가 앞의 것을 없애는 것이라, 두 기준은 이제 근본적으로
  // 양립할 수 없다. 실제 호출부(tools.ts allowDirHandler, allowedDirsRepo.ts)는 항상
  // isPathWithinAny 로 이미 절대경로임이 확인된 값만 normalizeDir 에 넘기므로, 드라이브
  // 문자 없는 상대경로가 실제로 들어오는 경로는 없다(grep 으로 확인).
  //
  // **위 두 케이스(드라이브 문자 있는 절대경로)는 2026-08-07 에 고쳤다.** 원래 이 자리에는
  // "현재 이 리포에 Linux 에서 테스트를 돌리는 CI 가 없어 이 변경 없이도 그대로 통과하므로
  // 손대지 않았다"고 적혀 있었다 — 그날 CI 가 붙으며 그 전제가 사라졌고, 첫 실행에서 곧바로
  // 깨졌다. host `path.resolve` 로 만든 기대값이 리눅스에서 `C:\a\b` 를 상대경로로 봐 cwd 를
  // 붙였기 때문이다. **구현은 멀쩡했고 기대값이 틀렸다.** 기대값은 host 가 아니라 그 문자열의
  // 플레이버로 계산한다(win32 리터럴 → `path.win32`).
  it("상대경로도 절대경로로 변환한다(드라이브 문자가 없으면 POSIX 규칙)", () => {
    expect(normalizeDir("some\\relative\\dir")).toBe(path.posix.resolve("some\\relative\\dir"));
  });
});

describe("경로 비교는 대상 경로의 플랫폼을 따른다 — 봇(리눅스)이 윈도우 워커 경로를 판정한다", () => {
  it("윈도우 경로: 허용 폴더 안의 파일을 허용한다", () => {
    expect(isPathWithin(String.raw`C:\ws\my.txt`, String.raw`C:\ws`)).toBe(true);
    expect(isPathWithin(String.raw`C:\ws\111\my.txt`, String.raw`C:\ws\111`)).toBe(true);
  });

  it("윈도우 경로: 상위 참조로 빠져나가면 거부한다", () => {
    expect(isPathWithin(String.raw`C:\ws\111\..\222\secret.txt`, String.raw`C:\ws\111`)).toBe(false);
    expect(isPathWithin(String.raw`C:\ws\222\secret.txt`, String.raw`C:\ws\111`)).toBe(false);
  });

  it("윈도우 경로: 대소문자를 구분하지 않는다(NTFS)", () => {
    expect(isPathWithin(String.raw`c:\WS\My.TXT`, String.raw`C:\ws`)).toBe(true);
  });

  it("윈도우 경로: 접두사만 같은 형제 폴더는 거부한다", () => {
    expect(isPathWithin(String.raw`C:\ws2\my.txt`, String.raw`C:\ws`)).toBe(false);
  });

  it("UNC 경로도 윈도우 규칙으로 판정한다", () => {
    expect(isPathWithin(String.raw`\\nas\share\a\b.txt`, String.raw`\\nas\share\a`)).toBe(true);
    expect(isPathWithin(String.raw`\\nas\share\a\..\c\b.txt`, String.raw`\\nas\share\a`)).toBe(false);
  });

  it("POSIX 경로는 POSIX 규칙으로 판정한다(대소문자 구분)", () => {
    expect(isPathWithin("/srv/ws/my.txt", "/srv/ws")).toBe(true);
    expect(isPathWithin("/srv/ws/../other/x", "/srv/ws")).toBe(false);
    expect(isPathWithin("/srv/WS/my.txt", "/srv/ws")).toBe(false);
  });

  it("normalizeDir 도 대상 경로의 플랫폼을 따른다 — 리눅스 봇이 윈도우 경로를 저장할 때", () => {
    // 주의: `String.raw`C:\ws\`` 처럼 원시 템플릿을 백슬래시로 끝내면 그 백슬래시가 닫는 백틱을
    // 이스케이프해 버려 템플릿이 닫히지 않는다(String.raw 도 렉서 단계의 이 규칙을 피하지 못한다).
    // 그래서 후행 백슬래시가 필요한 입력은 문자열 접합으로 만든다.
    expect(normalizeDir(String.raw`C:\ws` + "\\")).toBe(String.raw`C:\ws`);
    expect(normalizeDir(String.raw`C:\ws\a\..\b`)).toBe(String.raw`C:\ws\b`);
    expect(normalizeDir("/srv/ws/")).toBe("/srv/ws");
  });
});
