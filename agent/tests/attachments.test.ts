import { describe, it, expect } from "vitest";
import {
  filterFileAttachments, safeFileName, isDiscordCdnUrl, buildFileMarker, uploadDirFor, FILE_LIMITS,
} from "../src/core/attachments.js";

const att = (o: Partial<{ url: string; contentType: string | null; name: string; size: number }> = {}) => ({
  url: "https://cdn.discordapp.com/attachments/1/2/a.pdf",
  contentType: "application/pdf",
  name: "a.pdf",
  size: 1024,
  ...o,
});

describe("filterFileAttachments", () => {
  it("이미지가 아닌 첨부만 고른다", () => {
    // 이미지는 filterImageAttachments 가 이미 가져가 모델에 직접 실린다. 여기서 또 집으면
    // 같은 파일이 멀티모달 입력으로도 가고 워커 디스크에도 떨어져 두 번 처리된다.
    const r = filterFileAttachments([att(), att({ contentType: "image/png", name: "b.png" })]);
    expect(r.files.map((f) => f.name)).toEqual(["a.pdf"]);
  });

  it("contentType 이 없어도 이미지가 아니면 받는다", () => {
    // 디스코드가 형식을 못 알아본 첨부를 버리면 사용자는 이유를 알 수 없다.
    const r = filterFileAttachments([att({ contentType: null, name: "x.bin" })]);
    expect(r.files.map((f) => f.name)).toEqual(["x.bin"]);
  });

  it("크기 상한을 넘으면 이유와 함께 건너뛴다", () => {
    const r = filterFileAttachments([att({ size: FILE_LIMITS.maxBytes + 1, name: "big.pdf" })]);
    expect(r.files).toEqual([]);
    expect(r.skipped[0]).toContain("big.pdf");
  });

  it("개수 상한을 넘으면 나머지를 건너뛴다", () => {
    const many = Array.from({ length: FILE_LIMITS.maxCount + 2 }, (_, i) => att({ name: `f${i}.pdf` }));
    const r = filterFileAttachments(many);
    expect(r.files).toHaveLength(FILE_LIMITS.maxCount);
    expect(r.skipped).toHaveLength(2);
  });

  it("이름이 안전하지 않으면 건너뛴다", () => {
    const r = filterFileAttachments([att({ name: "../../evil.sh" })]);
    expect(r.files).toEqual([]);
    expect(r.skipped[0]).toContain("evil");
  });
});

describe("safeFileName — 폴더를 벗어나는 이름을 막는다", () => {
  it("평범한 이름은 그대로", () => {
    expect(safeFileName("보고서 v2.pdf")).toBe("보고서 v2.pdf");
  });

  it("경로 구분자가 들어가면 거절한다", () => {
    // 저장 위치는 봇이 정하는데, 이름에 구분자가 있으면 그 결정을 우회한다.
    expect(safeFileName("a/b.pdf")).toBeNull();
    expect(safeFileName("a\\b.pdf")).toBeNull();
  });

  it("상위 이동은 거절한다", () => {
    expect(safeFileName("..")).toBeNull();
    expect(safeFileName("../x")).toBeNull();
  });

  it("빈 이름·점만 있는 이름은 거절한다", () => {
    expect(safeFileName("")).toBeNull();
    expect(safeFileName("   ")).toBeNull();
    expect(safeFileName(".")).toBeNull();
  });

  it("널 바이트가 든 이름은 거절한다", () => {
    // 경로 문자열을 중간에서 끊어 검사를 통과시키는 고전적 수법이다.
    expect(safeFileName("a\u0000.pdf")).toBeNull();
  });
});

describe("isDiscordCdnUrl", () => {
  it("디스코드 CDN 호스트는 통과한다", () => {
    expect(isDiscordCdnUrl("https://cdn.discordapp.com/attachments/1/2/a.pdf")).toBe(true);
    expect(isDiscordCdnUrl("https://media.discordapp.net/attachments/1/2/a.png")).toBe(true);
  });

  it("비슷하게 생긴 호스트는 거절한다", () => {
    // 접두·접미 일치로 검사하면 전부 통과한다. 호스트 전체가 같아야 한다.
    expect(isDiscordCdnUrl("https://cdn.discordapp.com.evil.test/a.pdf")).toBe(false);
    expect(isDiscordCdnUrl("https://evil.test/cdn.discordapp.com/a.pdf")).toBe(false);
    expect(isDiscordCdnUrl("https://xcdn.discordapp.com/a.pdf")).toBe(false);
  });

  it("http 는 거절한다", () => {
    expect(isDiscordCdnUrl("http://cdn.discordapp.com/attachments/1/2/a.pdf")).toBe(false);
  });

  it("URL 이 아니면 거절한다", () => {
    expect(isDiscordCdnUrl("cdn.discordapp.com/a.pdf")).toBe(false);
    expect(isDiscordCdnUrl("")).toBe(false);
  });
});

describe("uploadDirFor — 저장 위치는 봇이 정한다", () => {
  it("손님은 자기 몫으로 좁혀진 폴더에 저장한다", () => {
    expect(uploadDirFor({ workspaceDirs: ["C:\\ws\\111"], workerRoots: ["C:\\ws"] })).toBe("C:\\ws\\111");
  });

  it("소유자는 워커 루트에 저장한다", () => {
    // resolveGuestWorkspaceDirs(core.ts)는 소유자에게 undefined 를 돌려준다 — scopeDirs 가
    // 소유자를 좁히지 않아 "그 사람의 폴더" 하나로 특정되지 않기 때문이다. 그래서 루트를 쓴다.
    expect(uploadDirFor({ workspaceDirs: undefined, workerRoots: ["C:\\ws"] })).toBe("C:\\ws");
  });

  it("둘 다 비면 null 이다(저장할 곳이 없다)", () => {
    expect(uploadDirFor({ workspaceDirs: [], workerRoots: [] })).toBeNull();
    expect(uploadDirFor({ workspaceDirs: undefined, workerRoots: [] })).toBeNull();
  });
});

describe("buildFileMarker", () => {
  it("저장된 경로를 본문 앞에 붙인다", () => {
    // 경로가 마커에 들어가는 것이 핵심이다 — 없으면 모델이 fs_read 로 열 방법을 모른다.
    const out = buildFileMarker("이거 봐줘", ["C:\\ws\\1\\a.pdf"], []);
    expect(out).toContain("C:\\ws\\1\\a.pdf");
    expect(out).toContain("이거 봐줘");
  });

  it("실패한 파일도 알린다", () => {
    // 조용히 버리는 것이 이 기능이 고치려는 문제다. 같은 침묵을 다른 자리에 다시 만들지 않는다.
    const out = buildFileMarker("", [], ["a.pdf(받아오지 못함)"]);
    expect(out).toContain("a.pdf");
  });

  it("아무것도 없으면 본문을 그대로 둔다", () => {
    expect(buildFileMarker("안녕", [], [])).toBe("안녕");
  });
});
