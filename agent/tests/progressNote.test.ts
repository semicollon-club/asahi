import { describe, it, expect } from "vitest";
import { progressFromMessage, isProgressUpdate, NOTE_MAX, type PendingTool, type ProgressUpdate } from "../src/core/sdkEvents.js";
import { formatProgress } from "../src/core/core.js";

// N1(a) 판단 줄(2026-11-25 설계 §2): 모델의 텍스트 블록이 진행 표시에 한 줄로 남는다. 예전엔 text 블록이 통째로
// answering("답변 작성 중") 한 종류로 접혀, 도구 사이에서 모델이 무엇을 보고 무엇을 하기로 했는지가 한 줄도 안 나갔다.

const assistant = (content: unknown[]) => ({ type: "assistant", message: { content } });

describe("progressFromMessage — 텍스트 블록은 판단(note)", () => {
  it("짧은 텍스트는 그대로 note 가 된다", () => {
    const pending = new Map<string, PendingTool>();
    expect(progressFromMessage(assistant([{ type: "text", text: "설정 파일부터 확인하겠습니다." }]), pending))
      .toEqual<ProgressUpdate[]>([{ kind: "note", text: "설정 파일부터 확인하겠습니다." }]);
  });

  it("여러 줄이면 첫 줄(비어 있지 않은)만, 길면 상한에서 자르고 말줄임표", () => {
    const pending = new Map<string, PendingTool>();
    const long = "가".repeat(NOTE_MAX + 30);
    expect(progressFromMessage(assistant([{ type: "text", text: `\n\n  ${long}\n둘째 줄` }]), pending))
      .toEqual<ProgressUpdate[]>([{ kind: "note", text: `${"가".repeat(NOTE_MAX)}…` }]);
  });

  it("빈 텍스트 블록은 예전처럼 answering", () => {
    const pending = new Map<string, PendingTool>();
    expect(progressFromMessage(assistant([{ type: "text", text: "   " }]), pending)).toEqual<ProgressUpdate[]>([{ kind: "answering" }]);
  });

  it("user 메시지의 텍스트 블록(서브에이전트 프롬프트·스킬 본문·합성 메시지)은 판단 줄이 아니다(2026-11-25 리뷰)", () => {
    const pending = new Map<string, PendingTool>();
    expect(progressFromMessage({ type: "user", message: { content: [{ type: "text", text: "이 파일들을 조사해 주세요" }] } }, pending)).toEqual([]);
  });

  it("텍스트와 도구 호출이 한 메시지에 오면 순서대로 note → tool", () => {
    const pending = new Map<string, PendingTool>();
    const updates = progressFromMessage(assistant([
      { type: "text", text: "테스트를 돌려 보겠습니다" },
      { type: "tool_use", id: "t1", name: "mcp__asahi__sh_exec", input: { command: "npm test" } },
    ]), pending);
    expect(updates).toEqual<ProgressUpdate[]>([
      { kind: "note", text: "테스트를 돌려 보겠습니다" },
      { kind: "tool", name: "sh_exec", input: "npm test" },
    ]);
  });
});

describe("isProgressUpdate — note 를 받는다(하네스 워커가 보내는 turn.event)", () => {
  it("text 가 문자열인 note 는 통과", () => {
    expect(isProgressUpdate({ kind: "note", text: "판단" })).toBe(true);
  });
  it("text 가 없거나 문자열이 아니면 거른다", () => {
    expect(isProgressUpdate({ kind: "note" })).toBe(false);
    expect(isProgressUpdate({ kind: "note", text: 3 })).toBe(false);
  });
  it("옛 워커가 보내는 answering 은 그대로 통과(호환)", () => {
    expect(isProgressUpdate({ kind: "answering" })).toBe(true);
  });
});

describe("formatProgress — note 는 '판단:' 줄", () => {
  it("앞에 '판단:' 을 붙인다", () => {
    expect(formatProgress({ kind: "note", text: "빌드 오류부터 보겠습니다" })).toBe("판단: 빌드 오류부터 보겠습니다");
  });
  it("손님 폴더 기준으로 경로를 줄인다(다른 줄과 같은 규칙)", () => {
    expect(formatProgress({ kind: "note", text: "C:\\ws\\u1\\src\\a.ts 를 열겠습니다" }, ["C:\\ws\\u1"])).toBe("판단: src\\a.ts 를 열겠습니다");
  });
});
