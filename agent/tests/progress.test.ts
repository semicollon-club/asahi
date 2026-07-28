import { describe, it, expect } from "vitest";
import { progressFromMessage, shortToolName, summarizeToolInput, RESULT_SUMMARY_MAX, type ProgressUpdate, type PendingTool } from "../src/core/agent.js";
import { formatProgress, PROGRESS_SUMMARY_MAX } from "../src/core/core.js";
import { PROGRESS_DISPLAY_MAX_LINES } from "../src/adapters/discord.js";

describe("shortToolName — mcp__asahi__ 접두어 제거", () => {
  it("mcp__asahi__recall → recall", () => {
    expect(shortToolName("mcp__asahi__recall")).toBe("recall");
  });
  it("mcp__asahi__remember → remember", () => {
    expect(shortToolName("mcp__asahi__remember")).toBe("remember");
  });
  it("접두어 없는 파일 도구는 그대로", () => {
    expect(shortToolName("Read")).toBe("Read");
  });
});

describe("summarizeToolInput — 도구 입력 요약", () => {
  it("query 필드를 우선 뽑는다", () => {
    expect(summarizeToolInput({ query: "병원" })).toBe("병원");
  });
  it("title 필드도 뽑는다(remember)", () => {
    expect(summarizeToolInput({ title: "선호", content: "긴 내용..." })).toBe("선호");
  });
  it("문자열 입력은 그대로(트림)", () => {
    expect(summarizeToolInput("  hello  ")).toBe("hello");
  });
  it("알려진 필드가 없으면 undefined", () => {
    expect(summarizeToolInput({ foo: 1 })).toBeUndefined();
  });
  it("너무 길면 잘라낸다", () => {
    const long = "a".repeat(100);
    const out = summarizeToolInput({ query: long });
    expect(out!.length).toBeLessThan(long.length);
    expect(out).toContain("…");
  });
});

// Task 1(2026-07-28 관측 기반 M1): progressFromMessage 의 pending 이 이름(string)만 담던 것에서
// PendingTool(이름·입력·시작시각)을 담는 것으로, tool_result 가 ok/summary/durationMs 를 함께
// 싣는 것으로 확장됐다(agent.ts 참고). 아래는 그 확장에 맞춰 pending 의 타입과 tool_result 기대값을
// 갱신한 것이다 — 짝짓기 자체의 상세 동작(같은 도구 연속 호출, 200자 절단 등)은
// agent.test.ts 의 "progressFromMessage — tool_result 에 성패·입력·소요시간을 싣는다" 쪽에서
// 별도로 두텁게 검증한다. 여기서는 이 파일이 원래 확인하던 것(블록 종류별 분기, pending 소비)만
// 새 모양에 맞춰 유지한다.
describe("progressFromMessage — SDK 메시지에서 진행 업데이트 추출(순수)", () => {
  it("assistant 의 tool_use 블록 → kind:'tool'", () => {
    const pending = new Map<string, PendingTool>();
    const msg = {
      type: "assistant",
      message: { content: [{ type: "tool_use", id: "t1", name: "mcp__asahi__recall", input: { query: "병원" } }] },
    };
    const updates = progressFromMessage(msg, pending);
    expect(updates).toEqual<ProgressUpdate[]>([{ kind: "tool", name: "recall", input: "병원" }]);
    expect(pending.get("t1")?.name).toBe("recall");
  });

  it("assistant 의 text 블록 → kind:'answering'", () => {
    const pending = new Map<string, PendingTool>();
    const msg = { type: "assistant", message: { content: [{ type: "text", text: "안녕하세요" }] } };
    expect(progressFromMessage(msg, pending)).toEqual<ProgressUpdate[]>([{ kind: "answering" }]);
  });

  it("user 의 tool_result 블록 → kind:'tool_result', pending 에서 이름을 되찾는다", () => {
    const pending = new Map<string, PendingTool>([["t1", { name: "recall", input: "병원", startedAt: 0 }]]);
    const msg = { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "결과" }] } };
    expect(progressFromMessage(msg, pending, () => 50)).toEqual<ProgressUpdate[]>([
      { kind: "tool_result", name: "recall", input: "병원", ok: true, summary: "결과", durationMs: 50 },
    ]);
    expect(pending.has("t1")).toBe(false); // 소비 후 제거
  });

  // 리뷰 후속(Minor) — 이 테스트는 name/input/durationMs 가 비는 것뿐 아니라 ok 기본값(true)과
  // summary 추출까지 함께 단정한다. 제목이 "name 없이"만 말하던 예전 상태는 실제 검증 범위보다
  // 좁았다 — 제목을 단정 내용 전체에 맞춘다.
  it("pending 에 없는 tool_result 는 name·input·durationMs 는 비지만 ok:true·summary 는 채워진다", () => {
    const pending = new Map<string, PendingTool>();
    const msg = { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "unknown", content: "결과" }] } };
    expect(progressFromMessage(msg, pending)).toEqual<ProgressUpdate[]>([
      { kind: "tool_result", name: undefined, input: undefined, ok: true, summary: "결과", durationMs: undefined },
    ]);
  });

  it("system/result 타입 등 content 가 없는 메시지는 빈 배열", () => {
    const pending = new Map<string, PendingTool>();
    expect(progressFromMessage({ type: "system" }, pending)).toEqual([]);
    expect(progressFromMessage({ type: "result" }, pending)).toEqual([]);
  });

  it("문자열 content(예: user 메시지 replay)는 빈 배열", () => {
    const pending = new Map<string, PendingTool>();
    const msg = { type: "user", message: { content: "그냥 텍스트" } };
    expect(progressFromMessage(msg, pending)).toEqual([]);
  });
});

describe("formatProgress — 진행 업데이트를 사용자용 텍스트로", () => {
  // Task 3: baseDirs 로 경로를 줄이는 shortenPath 가 "tool" 분기에도 적용되면서 표시 형식이
  // `name("input")` 에서 `name input` (공백 구분, 따옴표·괄호 없음)으로 의도적으로 바뀌었다 —
  // baseDirs 를 안 주면 shortenPath 는 원문을 그대로 돌려주므로 input 자체는 그대로다.
  it("tool + input → name input", () => {
    expect(formatProgress({ kind: "tool", name: "recall", input: "병원" })).toBe("recall 병원");
  });
  it("tool without input → name()", () => {
    expect(formatProgress({ kind: "tool", name: "Read" })).toBe("Read()");
  });
  it("tool_result with name", () => {
    // ok 는 Task 1 로 새로 필수가 된 필드다(타입만 맞추는 값 — 이 테스트의 관심사는 이름 노출이다).
    expect(formatProgress({ kind: "tool_result", name: "recall", ok: true })).toContain("recall");
  });
  it("tool_result without name도 문구를 낸다", () => {
    expect(formatProgress({ kind: "tool_result", ok: true }).length).toBeGreaterThan(0);
  });
  it("answering → 답변 작성 중", () => {
    expect(formatProgress({ kind: "answering" })).toBe("답변 작성 중");
  });
});

describe("formatProgress — 성패와 사유가 보인다", () => {
  const BASE = ["C:\\asahi-workspace\\1517428698368704650"];

  it("성공은 체크 표시와 소요시간을 붙인다", () => {
    const s = formatProgress({ kind: "tool_result", name: "fs_read", ok: true, summary: "본문", durationMs: 320 });
    expect(s).toContain("✓");
    expect(s).toContain("fs_read");
    expect(s).toContain("0.3");
  });

  it("실패는 X 표시와 사유를 그대로 보여준다", () => {
    const s = formatProgress({ kind: "tool_result", name: "fs_write", ok: false, summary: "허용된 폴더 밖 경로예요", durationMs: 5 });
    expect(s).toContain("✗");
    expect(s).toContain("허용된 폴더 밖 경로예요");
    expect(s).not.toContain("완료");
  });

  it("경로는 그 사용자의 폴더 기준으로 줄인다", () => {
    const s = formatProgress({ kind: "tool", name: "fs_read", input: "C:\\asahi-workspace\\1517428698368704650\\src\\a.ts" }, BASE);
    expect(s).toContain("src\\a.ts");
    expect(s).not.toContain("1517428698368704650");
  });

  it("기준 폴더 밖 경로는 줄이지 않는다", () => {
    const s = formatProgress({ kind: "tool", name: "fs_read", input: "C:\\other\\a.ts" }, BASE);
    expect(s).toContain("C:\\other\\a.ts");
  });

  it("answering 은 그대로다(회귀 없음)", () => {
    expect(formatProgress({ kind: "answering" })).toBe("답변 작성 중");
  });
});

// 리뷰 후속(Task 3): shortenPath 가 실측 실패 케이스 두 가지를 놓쳤다 — (1) LLM 이 도구 인자를
// 슬래시로 정규화해 base(백슬래시)와 구분자가 섞이는 경우, (2) 드라이브 문자 대소문자만 다른 경우.
// 둘 다 예전엔 "조용히" 축약 없이 전체 경로를 그대로 노출했다(폴더 밖 경로와 구분이 안 됨).
describe("formatProgress — shortenPath 가 혼합 구분자·대소문자에도 축약한다(리뷰 후속)", () => {
  const BASE = ["C:\\asahi-workspace\\1517428698368704650"];

  it("슬래시로 정규화된 텍스트 + 역슬래시 base → 축약된다", () => {
    const s = formatProgress({ kind: "tool", name: "fs_read", input: "C:/asahi-workspace/1517428698368704650/src/a.ts" }, BASE);
    expect(s).toBe("fs_read src/a.ts");
  });

  it("대소문자만 다른 텍스트(드라이브 문자) → 축약된다", () => {
    const s = formatProgress({ kind: "tool", name: "fs_read", input: "c:\\asahi-workspace\\1517428698368704650\\src\\a.ts" }, BASE);
    expect(s).toBe("fs_read src\\a.ts");
  });

  it("축약 결과가 원본의 표기를 유지한다(정규화된 사본이 아니라 원본 텍스트에서 잘라낸다)", () => {
    const s = formatProgress({ kind: "tool", name: "fs_read", input: "C:/asahi-workspace/1517428698368704650/src/sub/a.ts" }, BASE);
    // 원본이 슬래시로 왔으니 잘라낸 나머지도 슬래시인 채로 남아야 한다(역슬래시로 재작성되면 안 됨).
    expect(s).toBe("fs_read src/sub/a.ts");
  });

  it("기준 폴더 밖 경로는 그대로다(회귀)", () => {
    const s = formatProgress({ kind: "tool", name: "fs_read", input: "C:\\other\\a.ts" }, BASE);
    expect(s).toBe("fs_read C:\\other\\a.ts");
  });

  it("형제 폴더 오탐이 없다 — base 뒤에 다른 이름이 이어지면 축약하지 않는다", () => {
    const s = formatProgress(
      { kind: "tool", name: "fs_read", input: "C:\\asahi-workspace\\1517428698368704650-backup\\a.ts" },
      BASE,
    );
    expect(s).toBe("fs_read C:\\asahi-workspace\\1517428698368704650-backup\\a.ts");
  });
});

// ── 최종 리뷰 Important 2 — 표시 줄이 디스코드 2000자 한도를 넘기지 못하게 한다 ────────────
// formatProgressMessage(discord.ts)의 유일한 길이 보호는 12줄 상한(PROGRESS_DISPLAY_MAX_LINES)인데,
// 그 값은 짧은 줄(`fs_read 완료`, 52자)을 전제로 잡힌 것이다. 이 브랜치가 summary 200자를 표시
// 줄에 실으면서 한 줄 최악이 220자가 됐고, 12줄이면 2694자로 한도를 넘긴다. 넘으면 send/edit 이
// reject 되고 catch 가 로그만 남겨 상태 메시지가 그 턴 내내 옛 내용으로 얼어붙는다 — 하필 도구를
// 많이 쓴 턴, 즉 진행 표시가 가장 필요한 턴에서 그렇게 된다.
//
// 계층을 지켜 고친다: 이벤트의 summary 200자(RESULT_SUMMARY_MAX)는 기록 해상도이므로 그대로 두고,
// 자르는 것은 표시 포맷터에서만 한다. 그래서 아래 테스트는 "긴 summary 를 가진 이벤트"를 넣고
// 표시 줄의 길이만 본다 — 이벤트 자체를 짧게 만드는 방식으로 이 테스트를 통과시키면 안 된다.
describe("formatProgress — 긴 summary 는 표시 줄에서만 자른다(최종 리뷰 Important 2)", () => {
  const LONG = "가".repeat(RESULT_SUMMARY_MAX); // 이벤트가 실을 수 있는 최댓값

  it("성공 줄이 표시 상한 안으로 잘린다", () => {
    const s = formatProgress({ kind: "tool_result", name: "fs_read", ok: true, summary: LONG, durationMs: 320 });
    expect([...s].length).toBeLessThanOrEqual(PROGRESS_SUMMARY_MAX + 40);
    expect(s).toContain("✓");
    expect(s).toContain("0.3");
  });

  it("실패 줄도 잘리되 사유의 앞부분(가장 중요한 부분)은 남는다", () => {
    const reason = `허용된 폴더 밖 경로예요: C:\\ws\\${"x".repeat(300)}\\a.txt`.slice(0, RESULT_SUMMARY_MAX);
    const s = formatProgress({ kind: "tool_result", name: "fs_write", ok: false, summary: reason });
    expect([...s].length).toBeLessThanOrEqual(PROGRESS_SUMMARY_MAX + 40);
    expect(s).toContain("✗");
    expect(s).toContain("허용된 폴더 밖 경로예요");
  });

  it("12줄 최악 케이스가 디스코드 2000자 한도 안에 들어간다(이 수정의 실제 목적)", () => {
    const line = formatProgress({ kind: "tool_result", name: "fs_write", ok: false, summary: LONG });
    // formatProgressMessage 가 붙이는 머리글("처리 중")과 줄머리("· ")까지 포함해 실제로 계산한다.
    const message = ["처리 중", ...Array.from({ length: PROGRESS_DISPLAY_MAX_LINES }, () => `· ${line}`)].join("\n");
    expect(message.length).toBeLessThan(2000);
  });

  it("짧은 summary 는 손대지 않는다(회귀 없음)", () => {
    const s = formatProgress({ kind: "tool_result", name: "fs_read", ok: true, summary: "본문", durationMs: 320 });
    expect(s).toBe("✓ fs_read — 본문 (0.3초)");
  });

  it("자르기는 첫 줄을 뽑은 뒤에 한다 — 여러 줄 summary 의 둘째 줄이 새어 나오지 않는다", () => {
    const s = formatProgress({ kind: "tool_result", name: "sh_exec", ok: true, summary: `${"a".repeat(200)}\n둘째줄` });
    expect(s).not.toContain("둘째줄");
  });
});

describe("formatProgress — 기준 폴더가 여러 개일 때(리뷰 후속: Minor)", () => {
  it("두 번째 baseDirs 항목으로도 매칭된다", () => {
    const bases = ["C:\\asahi-workspace\\1111111111111111111", "C:\\asahi-workspace\\2222222222222222222"];
    const s = formatProgress({ kind: "tool", name: "fs_read", input: "C:\\asahi-workspace\\2222222222222222222\\src\\a.ts" }, bases);
    expect(s).toBe("fs_read src\\a.ts");
  });
});
