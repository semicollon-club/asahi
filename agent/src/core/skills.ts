import path from "node:path";

// 스킬 폴더의 절대경로. 실행 위치(cwd)가 아니라 이 모듈 자신의 위치에서 계산한다 — cwd 기준은
// 로컬 PM2(cwd=agent/)와 컨테이너(cwd=/app)에서 우연히 맞을 뿐이고, 다른 곳에서 띄우면 조용히
// 빗나간다. 스킬이 안 보이는 것과 폴더를 못 찾은 것은 증상이 같아서 그 오진이 특히 비싸다.
//
// 개발은 agent/src/core, 컨테이너는 /app/dist/core 인데 둘 다 두 단계 위가 스킬 폴더의 부모라
// 분기가 필요 없다(agent/ 와 /app 이 각각 그 자리다).
//
// resolve 가 아니라 join 을 쓴다: moduleDir 은 호출측(fileURLToPath)이 항상 완전한 절대경로로
// 주므로 둘의 결과는 실사용에서 같다. 다만 Windows 의 resolve 는 드라이브 문자가 없는
// 루트-상대 입력("\repo\...")을 만나면 process.cwd() 의 드라이브 문자를 채워 넣는다 — 이 함수가
// "cwd 와 무관"하다고 주장하는 것과 정면으로 어긋난다. join 은 cwd 를 전혀 들여다보지 않는다.
export function skillPluginDirFrom(moduleDir: string): string {
  return path.join(moduleDir, "..", "..", "skill-plugin");
}

// 이번 턴에 스킬을 열지. resolveWebToolsEnabled(agent.ts)와 같은 모양이고 같은 이유로 순수
// 함수다 — SDK query() 전체를 목업하지 않고 이 판정 하나만 검증하기 위해서.
//
// 유휴 요약 턴이 유일한 차단 대상이다: 사람이 지켜보지 않는 타이머로 돌고, 프롬프트 인젝션이
// 심겼을 수도 있는 세션을 그대로 이어받는다(resume). 요약에 스킬이 필요할 이유가 없으므로
// 열어 둘 이유도 없다 — 웹 검색을 같은 근거로 닫은 것과 같다.
export function resolveSkillsEnabled(req: { noSkills?: boolean }): boolean {
  return !req.noSkills;
}

// query() 에 넘길 plugins 배열. 폴더가 없으면 아예 넘기지 않는다 — 없는 경로를 SDK 에 줬을 때의
// 동작은 확인되지 않았고, 그것이 턴을 깨면 부가 기능이 본 기능을 인질로 잡는다. 스킬은 부가
// 능력이지 동작 조건이 아니다(워커 커밋 읽기와 같은 원칙: readCommit 은 실패하면 undefined 를
// 돌려주고 워커는 그대로 뜬다).
//
// 존재 확인을 인자로 받는 이유는 이 함수를 순수하게 두기 위해서다 — 호출측이 fs 를 한 번
// 들여다보고 그 결과만 넘긴다.
export function skillPluginsFor(o: { pluginDir: string; exists: boolean }): Array<{ type: "local"; path: string }> {
  return o.exists ? [{ type: "local", path: o.pluginDir }] : [];
}
