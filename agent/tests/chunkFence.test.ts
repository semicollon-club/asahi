import { describe, it, expect } from "vitest";
import { chunkMessage, chunkLines } from "../src/adapters/discord.js";

// 빠른 개선 1.2(2026-11-25 설계): 긴 답을 2000자로 나눌 때 코드블록(```)을 깨지 않는다.
// 펜스가 있는 본문만 새 규칙을 타고, 펜스가 없는 본문은 예전 분할(chunkLines)과 바이트 단위로 같아야 한다.

const isFence = (line: string) => line.trimStart().startsWith("```");
const fenceCount = (chunk: string) => chunk.split("\n").filter(isFence).length;
const contentLines = (s: string) => s.split("\n").filter((l) => !isFence(l));

describe("chunkMessage — 펜스가 없으면 예전 분할 그대로", () => {
  it("줄바꿈이 많은 긴 본문", () => {
    const text = Array.from({ length: 400 }, (_, i) => `${i}번째 줄 ${"가".repeat(30)}`).join("\n");
    expect(chunkMessage(text)).toEqual(chunkLines(text, 2000));
  });

  it("줄바꿈 없는 긴 본문(강제 절단)", () => {
    const text = "나".repeat(4500);
    expect(chunkMessage(text)).toEqual(chunkLines(text, 2000));
  });

  it("짧은 본문은 한 조각", () => {
    expect(chunkMessage("안녕하세요")).toEqual(["안녕하세요"]);
  });
});

describe("chunkMessage — 코드블록 중간에서 잘리면 닫고 다시 연다", () => {
  const code = Array.from({ length: 300 }, (_, i) => `const v${i} = ${i}; // ${"x".repeat(20)}`).join("\n");
  const text = `설명입니다.\n\n\`\`\`ts\n${code}\n\`\`\`\n\n끝.`;

  it("모든 조각이 2000자 이하이고 펜스 줄 수가 짝수다(열린 블록이 없다)", () => {
    const chunks = chunkMessage(text);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) {
      expect(c.length).toBeLessThanOrEqual(2000);
      expect(fenceCount(c) % 2).toBe(0);
    }
  });

  it("이어지는 조각은 같은 언어 표기로 다시 연다", () => {
    const chunks = chunkMessage(text);
    // 첫 조각 뒤 블록 안에서 이어지는 조각들은 ```ts 로 시작한다(마지막 조각은 블록이 끝난 뒤일 수 있다).
    const continued = chunks.slice(1).filter((c) => c.startsWith("```"));
    expect(continued.length).toBeGreaterThan(0);
    for (const c of continued) expect(c.split("\n")[0]).toBe("```ts");
  });

  it("펜스 줄을 빼면 원문의 내용 줄이 빠짐·중복 없이 순서대로 남는다", () => {
    const chunks = chunkMessage(text);
    expect(chunks.flatMap(contentLines)).toEqual(contentLines(text));
  });

  it("언어 표기가 너무 길면 다시 열 때 표기를 뺀다(여유분 안에 들어가게)", () => {
    const longInfo = `\`\`\`${"l".repeat(40)}`;
    const t = `${longInfo}\n${code}\n\`\`\``;
    const chunks = chunkMessage(t);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(2000);
    for (const c of chunks.slice(1)) {
      if (c.startsWith("```")) expect(c.split("\n")[0]).toBe("```");
    }
  });

  it("여러 크기에서 상한·짝 규칙이 항상 지켜진다", () => {
    for (const n of [50, 120, 199, 260, 333, 501]) {
      const body = Array.from({ length: n }, (_, i) => `line ${i} ${"y".repeat(i % 37)}`).join("\n");
      const t = `머리말\n\`\`\`py\n${body}\n\`\`\`\n꼬리말`;
      for (const c of chunkMessage(t)) {
        expect(c.length).toBeLessThanOrEqual(2000);
        expect(fenceCount(c) % 2).toBe(0);
      }
    }
  });
});
