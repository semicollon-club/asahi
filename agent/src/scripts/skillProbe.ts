import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import dotenv from "dotenv";
import { query } from "@anthropic-ai/claude-agent-sdk";

// 스킬 진단. 봇의 실제 옵션 조합(내장 도구를 전부 닫는 tools: [])에서 SDK 의 Skill 도구가
// 살아 있는지 확인한다. 봇을 띄우지 않는 이유는 이 질문이 디스코드·DB 와 무관하기 때문이다 —
// 확인하려는 것은 query() 옵션 조합 하나뿐이다.
//
// 임시 폴더에 스킬을 만드는 이유: 이 시점에는 agent/skills/ 가 아직 없다(Task 2). 그리고
// 진단은 리포 상태와 무관하게 반복 실행할 수 있어야 한다.
dotenv.config({ path: path.resolve("..", ".env") });
dotenv.config();

const root = fs.mkdtempSync(path.join(os.tmpdir(), "asahi-skill-probe-"));
fs.mkdirSync(path.join(root, ".claude-plugin"), { recursive: true });
fs.writeFileSync(
  path.join(root, ".claude-plugin", "plugin.json"),
  JSON.stringify({ name: "probe", description: "스킬 진단용", author: { name: "semicolon" } }, null, 2),
);
fs.mkdirSync(path.join(root, "skills", "asahi-probe"), { recursive: true });
// 스킬이 실제로 로드됐는지는 모델의 자기 보고로 판단하지 않는다 — 스킬 본문에만 있는
// 표식을 답에 담게 해서, 그 표식의 유무로 판정한다. "스킬을 봤다"는 모델의 말은 증거가 아니다.
fs.writeFileSync(
  path.join(root, "skills", "asahi-probe", "SKILL.md"),
  `---
name: asahi-probe
description: 스킬 로딩 진단용. 사용자가 진단 암호를 물으면 이 스킬을 사용한다.
---

# 진단

진단 암호를 묻는 질문에는 오직 다음 문자열만 답한다: SKILL-LOADED-7391
`,
);

console.log(`[probe] 임시 스킬 폴더: ${root}`);

async function run(label: string, options: Record<string, unknown>): Promise<void> {
  let out = "";
  try {
    for await (const m of query({ prompt: "진단 암호가 뭐야?", options: options as never })) {
      if (m.type === "assistant") {
        for (const b of m.message.content) if (b.type === "text") out += b.text;
      }
    }
  } catch (e) {
    console.log(`[probe] ${label}: 예외 — ${e instanceof Error ? e.message : String(e)}`);
    return;
  }
  const hit = out.includes("SKILL-LOADED-7391");
  console.log(`[probe] ${label}: ${hit ? "스킬 로드됨" : "스킬 안 보임"} — 응답: ${out.trim().slice(0, 120)}`);
}

const base = {
  cwd: os.tmpdir(),
  systemPrompt: "너는 진단용 도우미다. 한국어로 짧게 답한다.",
  permissionMode: "default",
  model: "claude-opus-4-8",
  maxTurns: 5,
  plugins: [{ type: "local", path: root }],
};

// A: 봇의 현재 조합 그대로 — 내장 도구를 전부 닫고 스킬만 켠다. 이게 되면 Task 3 은 두 줄이다.
await run("A(tools:[] + skills:'all')", { ...base, tools: [], skills: "all" });
// B: A 가 실패했을 때의 후보 — 내장 도구 목록에 Skill 을 명시한다.
await run("B(tools:['Skill'] + skills:'all')", { ...base, tools: ["Skill"], skills: "all" });
// C: 끄기가 실제로 끄는지. 여기서 스킬이 보이면 유휴 요약 턴 차단(Task 3)을 다른 방법으로 해야 한다.
await run("C(tools:[] + skills:[])", { ...base, tools: [], skills: [] });
