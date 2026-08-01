import { describe, it, expect } from "vitest";
import path from "node:path";
import { skillPluginDirFrom, resolveSkillsEnabled, skillPluginsFor } from "../src/core/skills.js";

describe("skillPluginDirFrom — 실행 위치가 아니라 모듈 위치에서 계산한다", () => {
  it("개발(src/core)에서 agent/skill-plugin 을 가리킨다", () => {
    expect(skillPluginDirFrom(path.join("/repo", "agent", "src", "core"))).toBe(
      path.join("/repo", "agent", "skill-plugin"),
    );
  });

  it("컨테이너(dist/core)에서 /app/skill-plugin 을 가리킨다", () => {
    // 이 두 단정이 함께 참인 것이 이 함수의 존재 이유다 — 개발과 컨테이너가 같은 상대경로로
    // 맞기 때문에 분기 없이 한 줄로 끝난다.
    expect(skillPluginDirFrom(path.join("/app", "dist", "core"))).toBe(path.join("/app", "skill-plugin"));
  });

  it("cwd 와 무관하다", () => {
    // cwd 를 기준으로 잡으면 로컬 PM2(cwd=agent/)와 컨테이너(cwd=/app)에서 우연히 맞을 뿐이고,
    // 다른 곳에서 띄우는 순간 조용히 빗나간다. 이 테스트가 그 회귀를 잡는다.
    const before = skillPluginDirFrom(path.join("/repo", "agent", "src", "core"));
    const cwd = process.cwd();
    try {
      process.chdir(path.parse(cwd).root);
      expect(skillPluginDirFrom(path.join("/repo", "agent", "src", "core"))).toBe(before);
    } finally {
      process.chdir(cwd);
    }
  });
});

describe("resolveSkillsEnabled — 유휴 요약 턴에서는 스킬도 닫는다", () => {
  it("noSkills 가 없으면(기본) 스킬이 열려 있다", () => {
    expect(resolveSkillsEnabled({})).toBe(true);
  });

  it("noSkills=true 면 닫힌다(유휴 요약 턴)", () => {
    expect(resolveSkillsEnabled({ noSkills: true })).toBe(false);
  });

  it("noSkills=false 를 명시해도 열려 있다", () => {
    expect(resolveSkillsEnabled({ noSkills: false })).toBe(true);
  });
});

describe("skillPluginsFor — 스킬 폴더가 없으면 플러그인을 아예 넘기지 않는다", () => {
  it("폴더가 있으면 local 플러그인 하나를 만든다", () => {
    // path 는 pluginDir 그대로다(플러그인 루트) — 안쪽 skills/ 로 바꾸지 않는다. SDK 가
    // <루트>/skills/<이름>/SKILL.md 를 스스로 스캔하므로(b0a2fde), 여기서 넘길 것은 루트다.
    expect(skillPluginsFor({ pluginDir: "/app/skill-plugin", exists: true })).toEqual([
      { type: "local", path: "/app/skill-plugin" },
    ]);
  });

  it("폴더가 없으면 빈 배열이다(대화는 그대로 돌아야 한다)", () => {
    // 스킬은 부가 능력이지 동작 조건이 아니다. 없는 경로를 SDK 에 넘겼을 때의 동작은
    // 확인되지 않았고, 그것이 턴을 깨면 부가 기능이 본 기능을 인질로 잡는다 — 넘기지 않는 편이
    // 확실하다. 워커 커밋 읽기(readCommit 이 실패하면 undefined 를 돌려주고 워커는 그대로 뜬다)와
    // 같은 원칙이다.
    expect(skillPluginsFor({ pluginDir: "/app/skill-plugin", exists: false })).toEqual([]);
  });
});
