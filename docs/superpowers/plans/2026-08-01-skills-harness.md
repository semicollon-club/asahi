# 스킬 로딩 하네스 구현 계획

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 외부에서 배포되는 스킬(`frontend-design` 등)을 폴더째 복사해 커밋하면 아사히가 실제로 쓸 수 있게 한다.

**Architecture:** SDK 가 이미 스킬을 지원한다 — `plugins: [{type:'local', path}]` 로 폴더를 넘기면 그 안의 `skills/<이름>/SKILL.md` 가 등록되고, `skills: 'all'` 로 켠다. 스킬 폴더는 `agent/skills/` 에 두어 봇(Dockerfile `COPY`)과 미니PC(`update-worker.ps1` 자동 갱신) 양쪽이 같은 파일을 갖게 한다. 켜고 끄는 축은 기존 `resolveWebToolsEnabled` 와 같은 모양의 순수 함수로 뽑는다.

**Tech Stack:** TypeScript (ESM/NodeNext), `@anthropic-ai/claude-agent-sdk@0.3.207`, vitest, Docker

## Global Constraints

- TypeScript ESM/NodeNext — **상대 임포트는 반드시 `.js` 로 끝난다** (소스가 `.ts` 여도)
- 주석·커밋 메시지·사용자 노출 문자열은 전부 **한국어**. 이모지 금지
- 주석은 *왜* 를 설명한다. 코드를 옮겨 적는 주석은 쓰지 않는다
- TDD: 실패하는 테스트를 먼저 쓰고 **실패를 눈으로 확인한 뒤** 구현한다
- 커밋: Conventional Commits + 한국어 제목, 본문 끝에 `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`
- 모든 npm 명령의 작업 디렉터리는 `agent/` 다
- 태스크 완료 전 `npm test` 와 `npm run typecheck` 가 모두 통과해야 한다
- 문서를 건드린 태스크는 리포 루트에서 `node scripts/check-docs.mjs` 가 `문서 검사 통과` 를 내야 한다
- `agent/src/core/paths.ts` 와 `agent/src/remote/roots.ts` 는 읽기 전용 — 이 계획은 건드리지 않는다
- 봇의 SDK 내장 도구 정책(`tools: []` — 파일/Bash 를 열지 않는다)은 **바꾸지 않는다.** Task 1 이 그 제약 안에서 스킬이 되는지 확인하는 것이 이 계획의 출발점이다

## 파일 구조

| 파일 | 역할 | 태스크 |
|---|---|---|
| `agent/src/scripts/skillProbe.ts` | **신규** — SDK 스킬이 우리 옵션 조합에서 동작하는지 확인하는 진단 스크립트 | 1 |
| `agent/skills/.claude-plugin/plugin.json` | **신규** — 플러그인 매니페스트 | 2 |
| `agent/skills/frontend-design/SKILL.md` | **신규** — 첫 외부 스킬(그대로 복사) | 2 |
| `agent/Dockerfile` | `COPY skills ./skills` 한 줄 | 2 |
| `agent/src/core/skills.ts` | **신규** — 경로 계산·켜기 판정(순수) | 3 |
| `agent/src/core/agent.ts` | `TurnRequest.noSkills`, `query()` 옵션 두 줄 | 3 |
| `agent/src/core/core.ts` | 유휴 요약 턴에 `noSkills: true` | 3 |
| `agent/src/core/persona.ts` | 능력 안내에 스킬 한 줄 | 4 |
| `deploy/smoke-test.md`, `docs/status/STATUS.md`, `docs/architecture/overview.md` | 문서 | 4 |

---

### Task 1: 실험 — 우리 옵션 조합에서 Skill 도구가 동작하는가

**Files:**
- Create: `agent/src/scripts/skillProbe.ts`

**Interfaces:**
- Consumes: 없음
- Produces: **코드가 아니라 판정 하나.** "우리 옵션 조합에서 스킬이 호출된다 / 안 된다(그리고 무엇을 바꾸면 되는지)". Task 3 의 배선이 이 판정 위에 선다.

**이 태스크가 왜 코드가 아니라 실험인가:** 봇은 SDK 내장 도구를 전부 닫아 둔다(`tools: []`). 그것이 `Skill` 도구까지 닫는지 타입 선언만으로는 확정할 수 없다. SDK 주석은 `skills` 옵션이 `allowedTools` 쪽을 알아서 처리한다고 하지만 `tools`(내장 도구 목록)와의 상호작용은 그 문장의 범위 밖이다. 이 프로젝트는 문서·추측을 실측보다 앞세워 이미 여러 번 시간을 태웠다 — 여기서는 계획 구조로 막는다.

**함께 확인할 것:** `skills: []` 가 실제로 끄는지. SDK 주석은 생략 / `'all'` / 이름 배열 셋만 설명하고 빈 배열을 따로 말하지 않는다. Task 3 의 유휴 요약 턴 차단이 이 한 줄에 걸려 있다.

- [ ] **Step 1: 진단 스크립트를 쓴다**

`agent/src/scripts/skillProbe.ts` 를 새로 만든다. 이 파일은 봇을 띄우지 않는다 — 디스코드도 DB 도 없이 `query()` 만 부른다.

```ts
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
```

- [ ] **Step 2: 실행한다**

```bash
cd agent && npx tsx src/scripts/skillProbe.ts
```

`.env` 에 API 자격증명이 있어야 한다. 없으면 세 줄 모두 예외로 끝나므로 그때는 자격증명을 먼저 해결한다(그 자체가 진단 결과가 아니다).

- [ ] **Step 3: 결과를 판정한다**

세 줄의 출력을 그대로 기록하고 아래 표로 판정한다.

| A | B | C | 판정 |
|---|---|---|---|
| 로드됨 | — | 안 보임 | **정상 경로.** Task 3 을 계획대로 진행한다 |
| 안 보임 | 로드됨 | 안 보임 | Task 3 에서 `tools` 에 `"Skill"` 을 더한다. **웹 검색과 같이 열려야 하므로** `builtinTools` 조립이 `webToolsEnabled` 와 `skillsEnabled` 를 모두 반영해야 한다 |
| 안 보임 | 안 보임 | — | **여기서 멈춘다.** 계획을 진행하지 말고 컨트롤러에게 보고한다 — 스펙의 전제가 깨진 것이라 설계를 다시 봐야 한다 |
| — | — | 로드됨 | `skills: []` 로는 끌 수 없다. Task 3 의 유휴 턴 차단을 "그 턴에는 `plugins` 자체를 넘기지 않는다"로 바꾼다 |

- [ ] **Step 4: 커밋**

```bash
git add agent/src/scripts/skillProbe.ts
git commit -F - <<'EOF'
chore(scripts): 스킬 로딩 진단 스크립트를 더한다

봇은 SDK 내장 도구를 전부 닫아 둔다(tools: []). 그것이 Skill 도구까지 닫는지 타입 선언만으로는
확정할 수 없어, 배선을 쌓기 전에 실측으로 확인한다. 이 프로젝트는 문서·추측을 실측보다 앞세워
이미 여러 번 시간을 태웠다.

봇을 띄우지 않고 query() 만 부른다 — 확인하려는 것이 옵션 조합 하나라 디스코드·DB 는 무관하다.
스킬 본문에만 있는 표식을 답에 담게 해서 그 유무로 판정한다: "스킬을 봤다"는 모델의 말은
증거가 아니다.

SDK 를 올릴 때 같은 질문이 다시 생기므로 스크립트를 남긴다.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
```

- [ ] **Step 5: 보고**

Step 3 의 세 줄 출력과 판정을 보고에 그대로 담는다. 컨트롤러가 이 결과로 Task 3 의 형태를 확정한다.

---

### Task 2: 스킬 폴더와 첫 외부 스킬

**Files:**
- Create: `agent/skills/.claude-plugin/plugin.json`
- Create: `agent/skills/frontend-design/SKILL.md`
- Modify: `agent/Dockerfile`

**Interfaces:**
- Consumes: 없음
- Produces: `agent/skills/` 가 존재하고 플러그인 형식을 만족한다. Task 3 의 `skillsDir` 이 이 경로를 가리킨다.

**왜 `agent/` 밑인가:** `agent/Dockerfile` 의 빌드 컨텍스트는 리포 루트가 아니라 `agent/` 다(Railway 서비스의 Root Directory 를 `agent` 로 지정한 전제). 그 Dockerfile 은 `package.json`·`package-lock.json`·`tsconfig.json`·`src` 만 복사하므로 **리포 루트에 둔 폴더는 봇 컨테이너에 존재하지 않는다.**

- [ ] **Step 1: 매니페스트를 만든다**

`agent/skills/.claude-plugin/plugin.json`:

```json
{
  "name": "asahi-skills",
  "description": "Asahi 가 사용하는 스킬 모음",
  "author": {
    "name": "semicolon"
  }
}
```

- [ ] **Step 2: `frontend-design` 을 그대로 복사한다**

원본은 이 기계에 이미 설치돼 있다.

```bash
cp -r "$HOME/.claude/plugins/cache/claude-plugins-official/frontend-design/unknown/skills/frontend-design" agent/skills/frontend-design
```

복사 후 `agent/skills/frontend-design/` 에 `SKILL.md` 와 `LICENSE.txt` 가 있는지 확인한다. **내용을 고치지 않는다** — 외부 스킬을 그대로 받아들이는 것이 이 하네스의 목적이고, 손대기 시작하면 갱신할 때마다 충돌한다.

원본이 없으면 이 경로를 확인한다:

```bash
find "$HOME/.claude/plugins" -path "*frontend-design/SKILL.md" 2>/dev/null
```

- [ ] **Step 3: 형식을 확인한다**

```bash
head -5 agent/skills/frontend-design/SKILL.md
```

기대: `---` 로 시작하고 `name: frontend-design` 과 `description:` 이 있다. frontmatter 의 `name` 이 폴더명과 같아야 SDK 가 찾는다.

- [ ] **Step 4: Dockerfile 에 복사를 더한다**

`agent/Dockerfile` 의 runtime 스테이지에서 `COPY --from=builder /app/dist ./dist` 바로 다음 줄에 넣는다.

```dockerfile
COPY --from=builder /app/dist ./dist

# 스킬은 빌드 산출물이 아니라 읽기 전용 자원이라 소스에서 그대로 옮긴다. 이 줄이 없으면
# 컨테이너에 skills/ 가 없어 스킬이 하나도 로드되지 않는다 — 그런데 그 실패는 배포 후에야,
# 그것도 조용히 드러난다(스킬이 없는 것과 안 켜진 것을 구별할 방법이 없다).
COPY skills ./skills
```

`COPY skills ./skills` 는 builder 가 아니라 빌드 컨텍스트(`agent/`)에서 직접 가져온다 — builder 스테이지는 `src` 만 복사하므로 거기엔 `skills` 가 없다.

- [ ] **Step 5: 도커 빌드로 확인한다**

```bash
docker build -f agent/Dockerfile -t asahi-skills-check agent && docker run --rm asahi-skills-check ls -R /app/skills
```

기대: `/app/skills` 아래에 `.claude-plugin` 과 `frontend-design` 이 보이고, `frontend-design` 안에 `SKILL.md` 가 있다.

**도커가 없으면 이 단계를 건너뛰되 보고에 반드시 적는다** — 그 경우 이 `COPY` 는 실제 배포까지 검증되지 않은 채로 남고, Task 4 의 스모크 항목이 유일한 방어선이 된다.

- [ ] **Step 6: 전체 검증**

```bash
cd agent && npm test && npm run typecheck
```

기대: 변화 없음(이 태스크는 코드를 건드리지 않는다). 숫자가 달라지면 뭔가 잘못 건드린 것이다.

- [ ] **Step 7: 커밋**

```bash
git add agent/skills agent/Dockerfile
git commit -F - <<'EOF'
feat(skills): 스킬 폴더를 만들고 frontend-design 을 들인다

외부 스킬을 폴더째 복사해 커밋하는 것이 이 하네스의 설치 방식이다. plugin.json 은 세 항목,
SKILL.md 는 frontmatter 두 필드라 변환이 필요 없다 — frontend-design 을 손대지 않고 그대로
넣었다. 손대기 시작하면 갱신할 때마다 충돌한다.

리포 루트가 아니라 agent/ 밑인 이유는 Dockerfile 의 빌드 컨텍스트가 agent/ 이기 때문이다.
그 Dockerfile 은 package.json·package-lock.json·tsconfig.json·src 만 복사하므로 리포 루트에
둔 폴더는 컨테이너에 존재하지 않는다. COPY skills ./skills 를 더해 봇도 받게 했다 — 이 줄이
없으면 스킬이 하나도 로드되지 않는데 그 실패는 배포 후에야 조용히 드러난다.

미니PC 워커는 update-worker.ps1 이 5분마다 리포를 당겨오므로 같은 파일을 자동으로 받는다.
스크립트를 동반한 스킬을 다룰 2단계 때 파일은 이미 양쪽에 있게 된다.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
```

---

### Task 3: 경로·판정 함수와 query() 배선

**Files:**
- Create: `agent/src/core/skills.ts`
- Create: `agent/tests/skills.test.ts`
- Modify: `agent/src/core/agent.ts`, `agent/src/core/core.ts`

**Interfaces:**
- Consumes: Task 1 의 판정(어떤 옵션 조합이 실제로 동작하는지), Task 2 의 `agent/skills/`
- Produces:
  - `export function skillsDirFrom(moduleDir: string): string`
  - `export function resolveSkillsEnabled(req: { noSkills?: boolean }): boolean`
  - `export function skillPluginsFor(o: { skillsDir: string; exists: boolean }): Array<{ type: "local"; path: string }>`
  - `TurnRequest` 에 `noSkills?: boolean`

**Task 1 의 판정(2026-08-01 실측, 이 태스크는 그 결과를 반영해 이미 고쳐졌다):**

| 조합 | 결과 |
|---|---|
| A: `tools: []` + `skills: 'all'` | **스킬 안 보임** |
| B: `tools: ['Skill']` + `skills: 'all'` | **스킬 로드됨** |
| C: `tools: []` + `skills: []` | 스킬 안 보임 |

**`tools: []` 가 `Skill` 도구까지 닫는다.** `skills: 'all'` 만으로는 되살릴 수 없고 `tools` 배열에 `"Skill"` 을 명시해야 한다. 그래서 이 태스크의 켜고 끄는 축은 `skills` 옵션이 아니라 **`builtinTools` 멤버십**이다 — WebSearch 와 정확히 같은 방식이라 오히려 단순해졌다.

C 는 `skills: []` 가 끄는지를 **독립적으로 증명하지 못한다**(A 에서 이미 `tools: []` 자체가 막으므로 C 의 "안 보임"이 어느 쪽 때문인지 분리되지 않는다 — Task 1 구현자 지적). 그래서 이 계획은 **증명되지 않은 `skills: []` 에 의존하지 않는다.** `skills` 는 항상 `"all"` 로 두고 `tools` 로만 가른다 — A 와 B 가 각각 그 두 상태를 실측으로 확인했다.

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`agent/tests/skills.test.ts` 를 새로 만든다.

```ts
import { describe, it, expect } from "vitest";
import path from "node:path";
import { skillsDirFrom, resolveSkillsEnabled, skillPluginsFor } from "../src/core/skills.js";

describe("skillsDirFrom — 실행 위치가 아니라 모듈 위치에서 계산한다", () => {
  it("개발(src/core)에서 agent/skills 를 가리킨다", () => {
    expect(skillsDirFrom(path.join("/repo", "agent", "src", "core"))).toBe(
      path.join("/repo", "agent", "skills"),
    );
  });

  it("컨테이너(dist/core)에서 /app/skills 를 가리킨다", () => {
    // 이 두 단정이 함께 참인 것이 이 함수의 존재 이유다 — 개발과 컨테이너가 같은 상대경로로
    // 맞기 때문에 분기 없이 한 줄로 끝난다.
    expect(skillsDirFrom(path.join("/app", "dist", "core"))).toBe(path.join("/app", "skills"));
  });

  it("cwd 와 무관하다", () => {
    // cwd 를 기준으로 잡으면 로컬 PM2(cwd=agent/)와 컨테이너(cwd=/app)에서 우연히 맞을 뿐이고,
    // 다른 곳에서 띄우는 순간 조용히 빗나간다. 이 테스트가 그 회귀를 잡는다.
    const before = skillsDirFrom(path.join("/repo", "agent", "src", "core"));
    const cwd = process.cwd();
    try {
      process.chdir(path.parse(cwd).root);
      expect(skillsDirFrom(path.join("/repo", "agent", "src", "core"))).toBe(before);
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
    expect(skillPluginsFor({ skillsDir: "/app/skills", exists: true })).toEqual([
      { type: "local", path: "/app/skills" },
    ]);
  });

  it("폴더가 없으면 빈 배열이다(대화는 그대로 돌아야 한다)", () => {
    // 스킬은 부가 능력이지 동작 조건이 아니다. 없는 경로를 SDK 에 넘겼을 때의 동작은
    // 확인되지 않았고, 그것이 턴을 깨면 부가 기능이 본 기능을 인질로 잡는다 — 넘기지 않는 편이
    // 확실하다. 워커 커밋 읽기(readCommit 이 실패하면 undefined 를 돌려주고 워커는 그대로 뜬다)와
    // 같은 원칙이다.
    expect(skillPluginsFor({ skillsDir: "/app/skills", exists: false })).toEqual([]);
  });
});
```

- [ ] **Step 2: 테스트를 돌려 실패를 확인**

```bash
cd agent && npx vitest run tests/skills.test.ts
```

기대: FAIL — `Cannot find module '../src/core/skills.js'`.

- [ ] **Step 3: `skills.ts` 를 만든다**

`agent/src/core/skills.ts`:

```ts
import path from "node:path";

// 스킬 폴더의 절대경로. 실행 위치(cwd)가 아니라 이 모듈 자신의 위치에서 계산한다 — cwd 기준은
// 로컬 PM2(cwd=agent/)와 컨테이너(cwd=/app)에서 우연히 맞을 뿐이고, 다른 곳에서 띄우면 조용히
// 빗나간다. 스킬이 안 보이는 것과 폴더를 못 찾은 것은 증상이 같아서 그 오진이 특히 비싸다.
//
// 개발은 agent/src/core, 컨테이너는 /app/dist/core 인데 둘 다 두 단계 위가 스킬 폴더의 부모라
// 분기가 필요 없다(agent/ 와 /app 이 각각 그 자리다).
export function skillsDirFrom(moduleDir: string): string {
  return path.resolve(moduleDir, "..", "..", "skills");
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
export function skillPluginsFor(o: { skillsDir: string; exists: boolean }): Array<{ type: "local"; path: string }> {
  return o.exists ? [{ type: "local", path: o.skillsDir }] : [];
}
```

- [ ] **Step 4: 테스트가 통과하는지 확인**

```bash
cd agent && npx vitest run tests/skills.test.ts
```

기대: PASS (8건).

- [ ] **Step 5: `agent.ts` 에 배선한다**

import 를 더한다(파일 상단, 다른 상대 임포트 옆).

```ts
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { skillsDirFrom, resolveSkillsEnabled, skillPluginsFor } from "./skills.js";
```

`TurnRequest` 에 필드를 더한다.

```ts
export type TurnRequest = {
  prompt: string; systemPrompt: string; resume?: string; cwd: string; context: TurnContext;
  onProgress?: (u: ProgressUpdate) => void; images?: ImageInput[]; noRemoteTools?: boolean; noWebTools?: boolean;
  noSkills?: boolean;
};
```

모듈 최상단(함수 밖)에 경로를 한 번만 계산한다.

```ts
// 프로세스 수명 동안 바뀌지 않으므로 턴마다 다시 계산하지 않는다. 존재 확인도 여기서 한 번만
// 한다 — 턴마다 디스크를 보는 것은 낭비이고, 스킬 폴더는 배포 산출물이라 도는 중에 생기거나
// 사라지지 않는다.
const SKILLS_DIR = skillsDirFrom(path.dirname(fileURLToPath(import.meta.url)));
const SKILL_PLUGINS = skillPluginsFor({ skillsDir: SKILLS_DIR, exists: fs.existsSync(SKILLS_DIR) });
if (SKILL_PLUGINS.length === 0) console.warn(`[agent] 스킬 폴더가 없어 스킬 없이 돕니다: ${SKILLS_DIR}`);
```

`console.warn` 을 남기는 이유: 스킬이 안 보이는 증상은 "폴더를 못 찾음"과 "안 켜짐"이 구별되지 않는다. 이 한 줄이 그 둘을 가른다.

`webToolsEnabled` 를 계산하는 줄 바로 아래에 판정을 더한다.

```ts
    const webToolsEnabled = resolveWebToolsEnabled(req);
    // 스킬도 같은 축으로 닫는다 — 유휴 요약 턴은 사람이 지켜보지 않고 인젝션이 심겼을 수도 있는
    // 세션을 이어받는다(core.ts 의 noWebTools 주석 참고). 요약에 스킬이 필요하지 않다.
    const skillsEnabled = resolveSkillsEnabled(req);
```

`builtinTools` 조립을 바꾼다. **여기가 스킬을 실제로 켜고 끄는 유일한 지점이다** — 2026-08-01 실측: `tools` 에 `"Skill"` 이 없으면 `skills: 'all'` 을 줘도 스킬이 보이지 않는다.

```ts
    // SDK 내장 도구는 웹 검색과 스킬만 연다. 파일/Bash 는 원격 도구(fs_*·sh_exec)가 대신하므로
    // 계속 닫아 둔다 — 열면 봇 컨테이너의 파일시스템을 건드리게 된다.
    //
    // Skill 을 여기 넣어야 하는 이유(2026-08-01 실측, src/scripts/skillProbe.ts): tools 가 비면
    // SDK 는 Skill 도구까지 닫으며, skills: 'all' 을 줘도 되살아나지 않는다. 즉 스킬을 켜고 끄는
    // 실제 스위치는 skills 옵션이 아니라 이 배열이다 — WebSearch 와 같은 방식이다.
    const builtinTools: string[] = [
      ...(webToolsEnabled ? ["WebSearch"] : []),
      ...(skillsEnabled ? ["Skill"] : []),
    ];
```

`query()` 의 `options` 에 두 줄을 더한다(`maxTurns: 30` 다음).

```ts
        maxTurns: 30,
        // 스킬은 agent/skills/ 에 플러그인 하나로 모여 있다(agent/skills/.claude-plugin).
        // 외부 스킬은 그 폴더에 그대로 복사해 커밋하는 것이 설치 방식이다.
        plugins: SKILL_PLUGINS,
        // 항상 'all' 이다. 끄는 일은 위 builtinTools 가 한다 — skills: [] 가 실제로 끄는지는
        // 실측으로 증명되지 않았고(Task 1 의 C 갈래는 tools: [] 와 겹쳐 분리되지 않았다),
        // 증명되지 않은 경로에 차단을 걸지 않는다.
        skills: "all" as const,
```

**기존 `builtinTools` 상수 선언(웹 검색만 보던 줄)은 지운다** — 같은 이름의 선언이 둘 남으면 컴파일이 막히거나, 더 나쁘게는 나중 것이 조용히 이긴다.

- [ ] **Step 6: `core.ts` 의 유휴 요약 턴에 플래그를 넘긴다**

`noWebTools: true` 바로 아래에 더한다.

```ts
          noWebTools: true,
          // 스킬도 같은 이유로 닫는다 — 이 턴은 사람이 지켜보지 않고, 요약에 스킬이 필요없다.
          noSkills: true,
```

- [ ] **Step 7: 전체 검증**

```bash
cd agent && npm test && npm run typecheck
```

`plugins`/`skills` 옵션의 타입이 맞지 않으면 SDK 타입 선언(`node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts` 의 `SdkPluginConfig`, `skills?: string[] | 'all'`)을 직접 확인해 맞춘다. **`as never` 나 `any` 로 넘기지 않는다** — 타입이 안 맞는다는 것은 옵션 이름이나 형태가 틀렸다는 신호다.

- [ ] **Step 8: 역전 시험**

셋을 차례로 확인하고 각각 되돌린다.

1. `resolveSkillsEnabled` 를 `return true;` 로 → "noSkills=true 면 닫힌다" 가 **FAIL**
2. `skillsDirFrom` 의 `".."` 하나를 지움 → 첫 두 경로 테스트가 **FAIL**
3. `skillPluginsFor` 를 `return [{ type: "local", path: o.skillsDir }];` 로(존재 확인 무시) → "폴더가 없으면 빈 배열" 이 **FAIL**

- [ ] **Step 8b: `builtinTools` 배선을 눈으로 확인한다**

이 줄은 유닛 테스트가 닿지 않는다(`query()` 옵션 조립부). 대신 직접 읽어 확인한다.

```bash
cd agent && grep -n -A6 "const builtinTools" src/core/agent.ts
```

확인할 것: 선언이 **하나뿐**이고, `skillsEnabled` 일 때 `"Skill"` 이 들어가며, 웹 검색 조건과 독립적이다(웹 도구가 닫혀도 스킬은 열릴 수 있어야 한다 — 둘은 별개 축이다).

- [ ] **Step 9: 커밋**

```bash
git add agent/src/core/skills.ts agent/tests/skills.test.ts agent/src/core/agent.ts agent/src/core/core.ts
git commit -F - <<'EOF'
feat(core): 스킬을 로드하고 유휴 요약 턴에서는 닫는다

query() 에 plugins 와 skills 두 옵션을 넘긴다. 스킬 폴더 경로는 실행 위치가 아니라 모듈
자신의 위치에서 계산한다 — cwd 기준은 로컬 PM2(cwd=agent/)와 컨테이너(cwd=/app)에서 우연히
맞을 뿐이고 다른 곳에서 띄우면 조용히 빗나간다. 스킬이 안 보이는 것과 폴더를 못 찾은 것은
증상이 같아서 그 오진이 특히 비싸다.

유휴 요약 턴에서는 스킬을 닫는다. 그 턴은 사람이 지켜보지 않는 타이머로 돌고 프롬프트
인젝션이 심겼을 수도 있는 세션을 그대로 이어받는데(resume), 요약에 스킬이 필요할 이유가
없다 — 웹 검색을 같은 근거로 닫은 것(FIX3)과 같은 축이다.

판정을 순수 함수로 뽑은 이유는 resolveWebToolsEnabled 와 같다: SDK query() 전체를 목업하지
않고 이 판정 하나만 검증하기 위해서다.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
```

---

### Task 4: 아사히가 스킬을 알게 하고 문서를 맞춘다

**Files:**
- Modify: `agent/src/core/persona.ts`, `deploy/smoke-test.md`, `docs/status/STATUS.md`, `docs/architecture/overview.md`

**Interfaces:**
- Consumes: Task 3 의 배선
- Produces: 없음

**왜 필요한가:** 스킬이 로드돼도 아사히가 존재를 모르면 쓰지 않는다. 그리고 로딩 자체는 유닛 테스트가 닿지 않으므로(SDK 내부), 실사용 검증을 스모크로 옮겨 적지 않으면 이 기능은 검증되지 않은 채 남는다.

- [ ] **Step 1: `persona.ts` 능력 안내에 한 줄 더한다**

`buildCapabilityBlock` 의 **모든 분기**(소유자 DM 연결/미연결, 소유자 서버 연결/미연결, 손님)에 같은 한 줄을 더한다. 스킬은 신원으로 가르지 않으므로 분기마다 다르게 쓰지 않는다.

```
- 특정 작업(예: UI 디자인)에는 전용 스킬이 있을 수 있습니다. 먼저 쓸 수 있는 스킬이 있는지 살펴보고, 있으면 그 지침을 따르세요.
```

**스킬 이름을 나열하지 않는다** — 나열하면 스킬을 추가할 때마다 프롬프트를 고쳐야 하고, 목록은 SDK 가 이미 모델에게 준다.

- [ ] **Step 2: 문구가 실제로 들어갔는지 확인한다**

```bash
cd agent && grep -c "전용 스킬이 있을 수 있습니다" src/core/persona.ts
```

기대: `buildCapabilityBlock` 의 분기 수와 같은 숫자. 하나라도 빠지면 그 계층의 사용자에게만 스킬이 없는 것처럼 보인다.

- [ ] **Step 3: `deploy/smoke-test.md` 에 항목 둘을 더한다**

```markdown
- [ ] **스킬이 모델에게 실제로 보이는가** — 서버 채널에서 "쓸 수 있는 스킬 있어?" 라고 묻는다.
  기대 결과: `frontend-design` 을 포함한 목록을 답한다. "없다"고 하면 컨테이너에 `skills/` 가
  안 들어갔을 가능성이 가장 크다 — `agent/Dockerfile` 의 `COPY skills ./skills` 부터 확인한다.

- [ ] **스킬이 실사용에서 호출되는가** — 서버 채널에서 "간단한 랜딩 페이지 하나 만들어줘" 처럼
  UI 를 만들게 시킨다.
  기대 결과: 진행 표시에 `Skill` 호출이 보이고, 결과물이 기본 템플릿 같지 않은 의도적인 디자인
  선택(타이포그래피·색·여백)을 담는다. 스킬 없이도 그럴듯한 결과가 나올 수 있으므로 **판정
  근거는 결과물의 인상이 아니라 `Skill` 호출 여부다.**
```

- [ ] **Step 4: `docs/status/STATUS.md` 를 갱신한다**

"라이브 인프라" 또는 그에 준하는 절에, 스킬 하네스가 들어왔다는 것을 한 문단으로 적는다. 담을 것: 스킬은 `agent/skills/` 에 플러그인 하나로 모여 있고 외부 스킬을 폴더째 복사해 커밋하는 것이 설치 방식이라는 것, 전원에게 열리고 유휴 요약 턴에서만 닫힌다는 것, **현재는 문서형 스킬만 다루며 스크립트를 동반한 스킬은 다음 단계라는 것**.

- [ ] **Step 5: `docs/architecture/overview.md` 에 스킬을 적는다**

`## 원격 도구 호출` 절(79행 부근)이 *"SDK 내장 도구 대신 인프로세스 MCP 도구 11종을 호출한다 — 내장 도구는 `builtinTools: []` 로 아예 닫혀 있다"* 라고 설명하는 대목이 있다. 스킬은 정확히 그 제약과 맞물리므로 그 절 끝에 문단을 하나 더한다. 담을 것:

- 스킬은 `agent/skills/` 에 플러그인 하나로 모여 있고 `query()` 의 `plugins`/`skills` 옵션으로 로드된다
- **스킬 문서는 봇에 있고 파일·셸 실행은 워커에 있다** — 이 비대칭 때문에 지금은 문서형 스킬만 동작하고, 스크립트를 동반한 스킬은 다음 단계다
- 미니PC 는 `update-worker.ps1` 로 같은 `agent/skills/` 를 이미 받고 있어서, 다음 단계는 파일을 나르는 문제가 아니라 경로 규약 문제다

- [ ] **Step 6: 문서 검사**

```bash
node scripts/check-docs.mjs
```

기대: `문서 검사 통과`.

- [ ] **Step 7: 전체 검증**

```bash
cd agent && npm test && npm run typecheck
```

- [ ] **Step 8: 커밋**

```bash
git add agent/src/core/persona.ts deploy/smoke-test.md docs/status/STATUS.md docs/architecture/overview.md
git commit -F - <<'EOF'
docs(skills): 아사히가 스킬의 존재를 알게 하고 검증 항목을 남긴다

스킬이 로드돼도 아사히가 존재를 모르면 쓰지 않는다. 능력 안내의 모든 분기에 같은 한 줄을
더했다 — 스킬은 신원으로 가르지 않으므로 계층마다 다르게 쓰지 않는다. 스킬 이름은 나열하지
않는다: 추가할 때마다 프롬프트를 고쳐야 하고, 목록은 SDK 가 이미 모델에게 준다.

로딩 자체는 SDK 내부라 유닛 테스트가 닿지 않아 실사용 검증을 스모크로 옮겼다. 두 번째 항목의
판정 근거를 결과물의 인상이 아니라 Skill 호출 여부로 못박았다 — 스킬 없이도 그럴듯한 UI 는
나오므로, 인상으로 판정하면 스킬이 죽어 있어도 통과로 적게 된다.

overview 에는 스킬 파일은 봇에 있고 실행은 워커에 있다는 비대칭을 적었다. 그것이 스크립트형
스킬이 아직 안 되는 이유이고 다음 단계를 읽는 사람이 가장 먼저 알아야 할 사실이다.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
```

---

## 배포 후 확인

이 계획의 변경은 **봇에만** 영향을 준다(워커는 `query()` 를 돌리지 않는다). main 에 머지하면 Railway 가 자동 배포하고, 미니PC 는 `agent/skills/` 를 자동 갱신으로 받되 1단계에서는 그 파일을 쓰지 않는다 — 2단계(스크립트 브리지)를 위한 사전 배치다.

배포 후 `deploy/smoke-test.md` 의 새 두 항목을 실행한다. 첫 항목이 실패하면 `COPY skills ./skills` 를, 둘째만 실패하면 `persona.ts` 안내와 Task 1 의 판정을 다시 본다.
