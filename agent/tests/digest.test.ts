import { describe, it, expect } from "vitest";
import { kstDateString, shouldRunDigest, DIGEST_TOPICS, DIGEST_HOUR_KST } from "../src/core/digest.js";

// KST = UTC+9. 아래 UTC 시각들의 KST 환산을 주석으로 적어 둔다.
const utc = (iso: string) => Date.parse(iso);

describe("kstDateString", () => {
  it("UTC 자정 직후는 KST 로 같은 날 오전 9시다", () => {
    expect(kstDateString(utc("2026-07-26T00:30:00Z"))).toBe("2026-07-26");
  });

  it("UTC 15:00 은 KST 로 다음 날 0시다(날짜가 넘어간다)", () => {
    expect(kstDateString(utc("2026-07-26T15:00:00Z"))).toBe("2026-07-27");
  });

  it("UTC 14:59 는 아직 KST 같은 날이다", () => {
    expect(kstDateString(utc("2026-07-26T14:59:00Z"))).toBe("2026-07-26");
  });

  it("월말·연말 경계를 넘긴다", () => {
    expect(kstDateString(utc("2026-07-31T15:00:00Z"))).toBe("2026-08-01");
    expect(kstDateString(utc("2026-12-31T15:00:00Z"))).toBe("2027-01-01");
  });
});

describe("shouldRunDigest", () => {
  // KST 7시 = UTC 22:00 (전날)
  const beforeSeven = utc("2026-07-26T21:00:00Z"); // KST 7/27 06:00
  const exactlySeven = utc("2026-07-26T22:00:00Z"); // KST 7/27 07:00
  const afterSeven = utc("2026-07-27T03:00:00Z"); // KST 7/27 12:00

  it("KST 7시 이전이면 실행하지 않는다", () => {
    expect(shouldRunDigest(beforeSeven, null)).toBe(false);
  });

  it("KST 7시 정각이면 실행한다(경계 포함)", () => {
    expect(shouldRunDigest(exactlySeven, null)).toBe(true);
  });

  it("7시가 지났고 기록이 없으면 실행한다", () => {
    expect(shouldRunDigest(afterSeven, null)).toBe(true);
  });

  it("오늘(KST) 이미 했으면 실행하지 않는다", () => {
    expect(shouldRunDigest(afterSeven, "2026-07-27")).toBe(false);
  });

  it("어제 기록이면 실행한다", () => {
    expect(shouldRunDigest(afterSeven, "2026-07-26")).toBe(true);
  });

  it("7시 이전이면 어제 기록이 있어도 실행하지 않는다", () => {
    expect(shouldRunDigest(beforeSeven, "2026-07-26")).toBe(false);
  });

  it("hourKst 를 바꾸면 그 기준을 따른다", () => {
    // KST 7/27 06:00 — 기준이 5시면 실행, 9시면 미실행
    expect(shouldRunDigest(beforeSeven, null, 5)).toBe(true);
    expect(shouldRunDigest(beforeSeven, null, 9)).toBe(false);
  });
});

describe("주제 정의", () => {
  it("주제는 정확히 contest·devnews 둘이다", () => {
    expect(Object.keys(DIGEST_TOPICS).sort()).toEqual(["contest", "devnews"]);
  });

  it("각 주제는 라벨과 조사 프롬프트를 갖는다", () => {
    for (const t of Object.values(DIGEST_TOPICS)) {
      expect(t.label.length).toBeGreaterThan(0);
      expect(t.prompt.length).toBeGreaterThan(20);
    }
  });

  it("기본 게시 시각은 7시다", () => {
    expect(DIGEST_HOUR_KST).toBe(7);
  });
});
