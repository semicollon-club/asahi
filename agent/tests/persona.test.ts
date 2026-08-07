import { describe, it, expect } from "vitest";
import { buildSystemPrompt } from "../src/core/persona.js";
import { allowedToolsFor } from "../src/core/tools.js";

// 능력 안내에 대한 단정(특히 "이 이름은 없어야 한다")은 검사 범위를 "## 능력" 절로 좁힌다 —
// 능력 안내 밖의 절도 도구 이름이나 능력 관련 낱말을 쓰기 때문이다(기억 블록의
// remember/recall, 정체성 블록의 "아래 능력 안내의 제한을 따른다" 상호참조).
// 그 언급은 "이 도구를 가졌다"는 안내가 아니라서, 프롬프트 전체를 대상으로 하면 이 케이스들이
// 막으려는 결함(안내와 실제 도구 보유의 불일치)과 무관한 오탐이 난다. 캐릭터 제거로 능력
// 안내가 마지막 블록이 됐으므로 끝 경계는 프롬프트 끝이다.
//
// 리뷰 후속 — 마커를 못 찾으면 indexOf 가 -1 을 주고 slice(-1) 이 마지막 한 글자를 돌려준다.
// 이 파일의 negative 단정 수십 개가 그 한 글자에 걸려 전부 조용히 통과한다(fail-open). 능력
// 블록은 항상 있어야 하므로, 없으면 그 자체가 결함이다 — 자르기 전에 단정한다.
function capabilitySection(fullPrompt: string): string {
  const i = fullPrompt.indexOf("## 능력");
  expect(i).toBeGreaterThanOrEqual(0);
  return fullPrompt.slice(i);
}

// 프롬프트가 갈리는 신원 네 가지. "이 문구가 없어야 한다"류 가드는 예외 없이 이 넷 × 워커
// 연결 두 값(여덟 조합)을 전부 돌아야 한다 — Important 2(최종 전체 브랜치 리뷰)가 잡은 결함이
// 정확히 "가드가 미연결 프롬프트만 보고 있었다"였다. 목록을 세 곳에서 따로 적고 있던 것이
// 그 누락의 원인이라, 한 곳에서 관리한다.
const ALL_IDENTITIES = [
  { name: "소유자 DM", ctx: { role: "owner" as const, isPrivate: true, isOwner: true } },
  { name: "소유자 서버", ctx: { role: "owner" as const, isPrivate: false, isOwner: true } },
  { name: "손님 DM", ctx: { role: "allowed" as const, isPrivate: true, isOwner: false } },
  { name: "손님 서버", ctx: { role: "allowed" as const, isPrivate: false, isOwner: false } },
];
const WORKER_STATES = [true, false];

describe("buildSystemPrompt", () => {
  it("이모지·이모티콘 사용 금지 지침을 항상 포함한다", () => {
    const p = buildSystemPrompt({ role: "owner", isPrivate: true, isOwner: true });
    expect(p).toMatch(/이모지|이모티콘/);
  });

  it("답변 품질 지침(정확성·간결함)을 포함한다", () => {
    const p = buildSystemPrompt({ role: "owner", isPrivate: true, isOwner: true });
    expect(p).toMatch(/정확/);
    expect(p).toMatch(/간결/);
  });

  it("기억(remember/recall) 도구 안내를 유지한다", () => {
    const p = buildSystemPrompt({ role: "owner", isPrivate: true, isOwner: true });
    expect(p).toMatch(/remember/);
    expect(p).toMatch(/recall/);
  });

  it("어느 분기에도 character_fact 안내가 없다", () => {
    // 도구가 사라졌으므로 안내가 남으면 모델에게 없는 도구를 쓰라고 지시하는 것이 된다.
    // 리뷰 후속 — workerConnected 를 생략(기본 false)한 네 신원만 돌고 있었다.
    // buildCapabilityBlock 은 이 값으로도 갈리고 연결 분기가 텍스트도 가장 많은데, 그 분기는
    // 한 번도 검사되지 않았다 — 여덟 조합(신원 4 × workerConnected 2) 전부를 돌게 넓혔다.
    for (const { ctx } of ALL_IDENTITIES) {
      for (const workerConnected of WORKER_STATES) {
        expect(buildSystemPrompt({ ...ctx, workerConnected })).not.toContain("character_fact");
      }
    }
  });

  it("외부 관찰 콘텐츠의 지시 실행 금지 문구를 유지한다", () => {
    const p = buildSystemPrompt({ role: "owner", isPrivate: true, isOwner: true });
    expect(p).toMatch(/신뢰할 수 없는/);
  });

  // FIX5(중요, 최종 리뷰 3차) — 이 브랜치로 모든 턴이 웹 검색 결과(신뢰할 수 없는 외부 콘텐츠)를
  // 받게 됐는데, 이 규칙의 괄호 예시는 디스코드 채널 컨텍스트만 들고 있었다. 웹 검색 결과도
  // 같은 위험군이라는 걸 명시한다(capability-model.md 가 이 규칙을 유일한 완화로 지목한다).
  it("외부 관찰 콘텐츠 불신 규칙이 웹 검색 결과도 명시적으로 포함한다(FIX5)", () => {
    const p = buildSystemPrompt({ role: "owner", isPrivate: true, isOwner: true });
    expect(p).toMatch(/웹\s*검색/);
  });

  // FIX3(최종 리뷰): 능력 안내는 이제 deployTarget 이 아니라 workerConnected 로 갈린다 — 실제
  // 파일 도구(fs_read 등)를 쓸 수 있는 상태를 검증하려면 workerConnected:true 를 명시해야 한다
  // (생략 시엔 "워커 미연결" 문구가 나온다 — 아래 별도 describe 블록에서 그 경로를 검증한다).
  it("owner+DM+워커 연결 시 파일 도구·manage_access 능력 안내를 포함한다", () => {
    const p = buildSystemPrompt({ role: "owner", isPrivate: true, isOwner: true, workerConnected: true });
    expect(p).toMatch(/manage_access/);
    expect(p).toMatch(/파일/);
  });

  it("owner+DM+워커 연결 시 sh_exec 봉쇄를 과장하지 않고, 폴더 밖·시스템·네트워크 작업은 하지 말라고 안내한다(보안리뷰 #2, FIX3: 실제 도구 이름 sh_exec 사용)", () => {
    const p = buildSystemPrompt({ role: "owner", isPrivate: true, isOwner: true, workerConnected: true });
    // FIX3: 더 이상 존재하지 않는 SDK 내장 도구 이름(Bash)이 아니라 실제 원격 도구 이름을 쓴다.
    expect(p).toMatch(/sh_exec/);
    // "셸 작업은 허용 폴더 안에서만 가능하다"는 실제보다 강한(거짓) 보장 문구는 없어야 한다.
    expect(p).not.toMatch(/허용\s*폴더\s*안에서만\s*가능/);
    expect(p).toMatch(/완전히 막지/);
    expect(p).toMatch(/네트워크/);
  });

  it("손님 DM 이면 대화·본인 기억만 가능하다는 안내를 포함하고, 파일/manage_access 능력은 언급하지 않는다", () => {
    const p = buildSystemPrompt({ role: "allowed", isPrivate: true, isOwner: false });
    expect(p).toMatch(/기억/);
    expect(p).not.toMatch(/manage_access/);
  });

  it("서버(비 DM) 대화면 공용 recall 전용 안내를 포함하고, manage_access 는 언급하지 않는다", () => {
    const p = buildSystemPrompt({ role: "allowed", isPrivate: false, isOwner: false });
    expect(p).toMatch(/recall/);
    expect(p).not.toMatch(/manage_access/);
  });

  it("항상 한국어 응답 지침을 포함한다", () => {
    const p = buildSystemPrompt({ role: "owner", isPrivate: true, isOwner: true });
    expect(p).toMatch(/한국어/);
  });

  // 캐릭터 제거(2026-08-05) 전에는 이 케이스가 "캐릭터/관계" describe 안에 섞여 있었다. 검증
  // 대상은 능력 안내라 그 describe 와 함께 지우면 안 되므로 본문 그대로 이리로 옮겼다.
  it("소유자 DM(local·cloud) 능력 블록에 db_schema/db_query/runtime_info 로 실측 응답하라는 안내가 있다", () => {
    for (const deployTarget of ["local", "cloud"] as const) {
      const p = buildSystemPrompt({ role: "owner", isPrivate: true, isOwner: true, deployTarget });
      expect(p).toMatch(/db_schema/);
      expect(p).toMatch(/db_query/);
      expect(p).toMatch(/runtime_info/);
      expect(p).toMatch(/실측/);
    }
  });
});

// FIX3(중요, 최종 리뷰) — 능력 안내는 예전엔 deployTarget 만 보고 갈렸다: 프로덕션(cloud + 워커
// 연결)에서는 "지금은 클라우드에서 실행 중이라 PC 파일·셸(Bash) 작업을 할 수 없습니다"라고
// 안내하면서 실제로는 fs_*/sh_exec 가 열려 있었고, local + 워커 미연결에서는 "Read/Write/Bash 를
// 가지고 있다"고 안내하면서 그 도구들은 아예 존재하지 않았다(builtinTools=[]). 이제는
// workerConnected(이번 턴에 원격 도구가 실제로 열려 있는가)로 갈린다 — deployTarget 은 이
// 블록에 더 이상 영향을 주지 않는다.
describe("buildSystemPrompt — 능력 안내는 deployTarget 이 아니라 workerConnected 로 갈린다(FIX3)", () => {
  it("workerConnected 를 생략하면(기본값) PC 작업 불가 안내를 하고, 더 이상 존재하지 않는 SDK 내장 도구(Read/Write/Bash)를 가지고 있다고 안내하지 않는다", () => {
    const p = buildSystemPrompt({ role: "owner", isPrivate: true, isOwner: true });
    const cap = capabilitySection(p);
    expect(cap).toMatch(/워커/);
    expect(cap).toMatch(/연결되면/);
    expect(cap).toMatch(/manage_access/); // 기억·접근관리는 워커 상태와 무관하니 유지
    expect(cap).not.toMatch(/\bRead\b/);
    expect(cap).not.toMatch(/\bWrite\b/);
    expect(cap).not.toMatch(/\bBash\b/);
  });

  it("workerConnected=true + owner-DM 이면 실제 도구 이름(fs_read 등, sh_exec)으로 PC 작업이 가능하다고 안내한다 — deployTarget 과 무관", () => {
    for (const deployTarget of ["local", "cloud"] as const) {
      const p = buildSystemPrompt({ role: "owner", isPrivate: true, isOwner: true, deployTarget, workerConnected: true });
      expect(p).toMatch(/fs_read/);
      expect(p).toMatch(/sh_exec/);
      expect(p).toMatch(/manage_access/);
      // FIX3 핵심 회귀: 클라우드에서 워커가 연결돼 있는데도 "클라우드라서 PC 작업을 못 한다"고
      // 거짓 안내하면 안 된다.
      expect(p).not.toMatch(/클라우드에서 실행 중이라/);
    }
  });

  it("deployTarget 이 달라도 workerConnected 값이 같으면 owner-DM 능력 안내는 완전히 동일하다(더 이상 deployTarget 로 갈리지 않는다)", () => {
    const localOn = buildSystemPrompt({ role: "owner", isPrivate: true, isOwner: true, deployTarget: "local", workerConnected: true });
    const cloudOn = buildSystemPrompt({ role: "owner", isPrivate: true, isOwner: true, deployTarget: "cloud", workerConnected: true });
    expect(localOn).toBe(cloudOn);

    const localOff = buildSystemPrompt({ role: "owner", isPrivate: true, isOwner: true, deployTarget: "local", workerConnected: false });
    const cloudOff = buildSystemPrompt({ role: "owner", isPrivate: true, isOwner: true, deployTarget: "cloud", workerConnected: false });
    expect(localOff).toBe(cloudOff);
  });

  it("deployTarget 은 여전히 손님 DM·서버 안내에 영향을 주지 않는다(회귀 유지)", () => {
    const guestLocal = buildSystemPrompt({ role: "allowed", isPrivate: true, isOwner: false, deployTarget: "local" });
    const guestCloud = buildSystemPrompt({ role: "allowed", isPrivate: true, isOwner: false, deployTarget: "cloud" });
    expect(guestLocal).toBe(guestCloud);

    const serverLocal = buildSystemPrompt({ role: "allowed", isPrivate: false, isOwner: false, deployTarget: "local" });
    const serverCloud = buildSystemPrompt({ role: "allowed", isPrivate: false, isOwner: false, deployTarget: "cloud" });
    expect(serverLocal).toBe(serverCloud);
  });
});

// 최종 리뷰 FIX4(사소하지만 "안내와 실제 도구가 어긋남" 결함 유형) — Task 7 로 서버 채널의
// 소유자·손님(DM·서버)도 워커가 연결되면 fs_*/sh_exec(+소유자는 allow_dir 등)를 받게 됐는데,
// 이 블록은 그 두 갈래를 여전히 "PC 작업을 하지 않습니다/못 합니다"로 고정 안내하고 있었다.
// 세 경우(owner-DM/owner-서버/손님) 모두 workerConnected 로 안내가 실제 도구 보유와 일치해야 한다.
describe("buildSystemPrompt — 능력 안내가 실제 도구 보유와 어긋나지 않는다(최종 리뷰 FIX4)", () => {
  it("서버 채널의 소유자 + 워커 연결 시 파일·셸 도구와 폴더 관리(allow_dir) 안내를 포함한다", () => {
    const p = buildSystemPrompt({ role: "owner", isPrivate: false, isOwner: true, workerConnected: true });
    const cap = capabilitySection(p);
    expect(cap).toMatch(/fs_read/);
    expect(cap).toMatch(/sh_exec/);
    expect(cap).toMatch(/allow_dir/);
  });

  it("서버 채널의 소유자 + 워커 연결 시에도 DM 전용 도구(manage_access/db_schema/db_query)는 언급하지 않는다", () => {
    const p = buildSystemPrompt({ role: "owner", isPrivate: false, isOwner: true, workerConnected: true });
    const cap = capabilitySection(p);
    expect(cap).not.toMatch(/manage_access/);
    expect(cap).not.toMatch(/db_query/);
  });

  it("서버 채널의 소유자 + 워커 미연결(기본값)이면 파일·셸 도구 이름을 언급하지 않고, recall 은 된다고 안내한다", () => {
    const p = buildSystemPrompt({ role: "owner", isPrivate: false, isOwner: true });
    const cap = capabilitySection(p);
    expect(cap).not.toMatch(/fs_read|sh_exec|allow_dir/);
    expect(cap).toMatch(/recall/);
  });

  it("손님(DM) + 워커 연결 시 파일·셸 도구 안내를 포함하고, 폴더 관리 도구는 언급하지 않는다(관리자 전용)", () => {
    const p = buildSystemPrompt({ role: "allowed", isPrivate: true, isOwner: false, workerConnected: true });
    expect(p).toMatch(/fs_read/);
    expect(p).toMatch(/sh_exec/);
    expect(p).not.toMatch(/allow_dir|revoke_dir|list_dirs/);
    expect(p).not.toMatch(/manage_access/);
  });

  it("손님(서버) + 워커 연결 시에도 파일·셸 도구 안내를 포함하고, 폴더 관리 도구는 언급하지 않는다", () => {
    const p = buildSystemPrompt({ role: "allowed", isPrivate: false, isOwner: false, workerConnected: true });
    expect(p).toMatch(/fs_read/);
    expect(p).toMatch(/sh_exec/);
    expect(p).not.toMatch(/allow_dir|revoke_dir|list_dirs/);
  });

  it("손님은 워커 연결 여부와 무관하게 manage_access·폴더 관리 도구를 절대 언급하지 않는다(회귀 유지)", () => {
    for (const isPrivate of [true, false]) {
      for (const workerConnected of [true, false]) {
        const p = buildSystemPrompt({ role: "allowed", isPrivate, isOwner: false, workerConnected });
        expect(p).not.toMatch(/manage_access/);
        expect(p).not.toMatch(/allow_dir|revoke_dir|list_dirs/);
      }
    }
  });

  // 2026-08-05(캐릭터 제거)에 검사 범위를 프롬프트 전체에서 "## 능력" 절로 좁혔다가, 리뷰
  // 후속으로 다시 전체로 되돌렸다. 좁힌 유일한 이유가 새 정체성 블록이 "명령(sh_exec)"이라고
  // 도구 이름을 흘린 것이었는데(persona.ts 에서 "셸 명령"으로 고쳤다), 그 원인이 사라졌으므로
  // 좁힐 이유도 없다. 전체 검사가 더 강하다 — 도구 이름이 능력 안내가 아닌 다른 블록으로
  // 새어 들어오는 경로까지 함께 막는다.
  it("손님 DM·서버 모두 워커 미연결(기본값)이면 기존처럼 파일·셸 도구 이름을 언급하지 않는다(회귀 없음)", () => {
    const dm = buildSystemPrompt({ role: "allowed", isPrivate: true, isOwner: false });
    const server = buildSystemPrompt({ role: "allowed", isPrivate: false, isOwner: false });
    for (const p of [dm, server]) {
      expect(p).not.toMatch(/fs_read|fs_write|fs_edit|fs_glob|fs_grep|sh_exec/);
    }
  });
});

// Important 1(최종 전체 브랜치 리뷰) — 손님 분기의 제한 안내가 "…는 여전히 이 채널에서 할 수
// 없습니다 — 소유자 DM 전용입니다" 였다. 2026-08-06 사건에서 모델이 지어낸 거짓 설명("이
// 채널에서는 안 되니 소유자 DM 에서 다시 해보라")과 글자 그대로 같은 형태이고, 하필 모델의
// 시스템 프롬프트 안에서 가장 가까운 템플릿이었다. 그 턴에 못 쓰는 도구를 아예 등록하지 않게
// 된 지금(3b37dea)은 SDK 거절 문자열조차 오지 않으므로, 손님이 모델·버전을 물으면 모델이
// 근거를 찾을 곳은 이 프롬프트뿐이다 — 여기 채널 기준 문장이 남아 있으면 사건의 답변이 그대로
// 재생산된다. deploy/smoke-test.md 는 채널 기준 설명이 나오면 그 회차를 실패로 판정한다.
// 두 번째 결함: 손님에게 "소유자 DM" 은 애초에 들어갈 수 없는 장소다. 제한의 축은 위치가
// 아니라 신원이다(tools.ts 의 allowedToolsFor — runtime_info 는 isOwner, db_* 는 isOwner &&
// isPrivate. 손님은 채널을 어디로 옮겨도 얻지 못한다).
describe("buildSystemPrompt — 손님 제한 안내는 채널이 아니라 신원 기준이다(Important 1)", () => {
  for (const isPrivate of [true, false]) {
    const where = isPrivate ? "DM" : "서버";
    const guest = { role: "allowed" as const, isOwner: false, isPrivate };

    for (const workerConnected of WORKER_STATES) {
      const label = `손님(${where}, 워커 ${workerConnected ? "연결" : "미연결"})`;

      it(`${label}: 채널 기준 제한 문구가 없다`, () => {
        const cap = capabilitySection(buildSystemPrompt({ ...guest, workerConnected }));
        expect(cap).not.toMatch(/소유자 DM/);
        expect(cap).not.toMatch(/이 채널에서(는)? ?[^\n]{0,15}(할 수 없|안 됩니다|불가)/);
      });

      it(`${label}: 모델·버전 확인이 소유자만 가능하다고 안내한다`, () => {
        // 거절할 근거를 프롬프트가 직접 준다 — 도구가 안 보이는 것만으로는 모델이 이유를
        // 지어내는 것을 막지 못한다(2026-08-06 사건의 요지).
        const cap = capabilitySection(buildSystemPrompt({ ...guest, workerConnected }));
        const line = cap.split("\n").find((l) => l.includes("버전"));
        expect(line).toBeDefined();
        expect(line).toMatch(/소유자만/);
      });
    }
  }
});

// 실배포 점검(2026-07-28)에서 드러난 결함 — 셸이 실제로 열리는 네 분기(소유자 DM·소유자 서버·
// 손님 DM·손님 서버) 중 손님 분기만 sh_exec 주의사항이 없었고, 그 자리에 "접근은 네 몫의 폴더
// 안으로만 제한된다"고 fs_* 와 sh_exec 를 한 문장에 묶어 단언하고 있었다. 실측으로 반증됐다:
// 손님이 fs_read 로는 거부된 상위 폴더 파일(C:\asahi-workspace\smoke.txt)을 sh_exec(`type ...`)
// 로 그대로 읽었다. sh_exec 는 경로 인자가 없어 remoteTools.ts 의 1차 필터 대상이 아니고,
// 워커 쪽도 roots 로 판정하지 않는다(의도된 설계) — 거짓인 것은 도구가 아니라 안내문이었다.
//
// 손님 턴은 공개 채널에서 돌아 누구나 텍스트를 심을 수 있으므로, 인젝션 가드가 가장 필요한
// 분기가 유일하게 가드 없이 돌고 있었다. persona.ts 의 규칙(셸 주의사항은 sh_exec 가 실제로
// 열린 분기에서만 낸다)에서 손님 분기가 누락돼 있던 것이다.
describe("buildSystemPrompt — 손님 분기도 sh_exec 봉쇄를 과장하지 않는다", () => {
  for (const isPrivate of [true, false]) {
    const where = isPrivate ? "DM" : "서버";
    const guest = { role: "allowed" as const, isOwner: false, isPrivate };

    it(`손님(${where}) + 워커 연결 시 셸까지 폴더로 봉쇄된다고 단언하지 않는다`, () => {
      const cap = capabilitySection(buildSystemPrompt({ ...guest, workerConnected: true }));
      // 회귀 대상 문구 그대로: fs_* 와 sh_exec 를 묶어 "접근은 ... 폴더 안으로만 제한"이라고 말했다.
      expect(cap).not.toMatch(/접근은 네 몫의 폴더 안으로만 제한/);
      expect(cap).toMatch(/완전히 막지/);
    });

    it(`손님(${where}) + 워커 연결 시 파일 도구는 폴더로 제한된다고 정확히 안내한다`, () => {
      const cap = capabilitySection(buildSystemPrompt({ ...guest, workerConnected: true }));
      expect(cap).toMatch(/fs_read/);
      expect(cap).toMatch(/거부됩니다/);
    });

    it(`손님(${where}) + 워커 연결 시 폴더 밖 작업 자제와 프롬프트 인젝션 가드를 안내한다`, () => {
      const cap = capabilitySection(buildSystemPrompt({ ...guest, workerConnected: true }));
      expect(cap).toMatch(/네트워크/);
      expect(cap).toMatch(/따르지 마세요/);
    });

    it(`손님(${where}) + 워커 미연결이면 셸 주의사항 자체를 넣지 않는다(도구가 없는데 주의만 주지 않는다)`, () => {
      const cap = capabilitySection(buildSystemPrompt(guest));
      expect(cap).not.toMatch(/sh_exec/);
      expect(cap).not.toMatch(/완전히 막지/);
    });
  }

  it("셸이 열리는 네 분기가 모두 같은 주의사항(봉쇄 한계·자제·인젝션 가드)을 갖는다", () => {
    const branches = [
      { isOwner: true, isPrivate: true },
      { isOwner: true, isPrivate: false },
      { isOwner: false, isPrivate: true },
      { isOwner: false, isPrivate: false },
    ];
    for (const b of branches) {
      const p = buildSystemPrompt({ role: b.isOwner ? "owner" : "allowed", ...b, workerConnected: true });
      const cap = capabilitySection(p);
      expect(cap).toMatch(/sh_exec/);
      expect(cap).toMatch(/완전히 막지/);
      expect(cap).toMatch(/네트워크/);
      expect(cap).toMatch(/따르지 마세요/);
    }
  });
});

// Task 4(스킬 하네스) 후속 — buildCapabilityBlock 위쪽 주석은 "스킬은 신원으로 가르지 않는다"
// (소유자·손님 모든 분기가 같은 문장을 쓴다)고 설계 의도를 명시하지만, 그 불변식을 지키는
// 테스트가 이 파일에 하나도 없었다("스킬" 이 0건). 위 "셸이 열리는 네 분기가 모두 같은
// 주의사항을 갖는다" 테스트와 같은 형태로, 분기가 늘어나거나 한 줄이 실수로 빠져도 이 테스트가
// 잡도록 고정한다. 스킬 안내는 workerConnected 와 무관하게 항상 실리므로 그 값도 함께 바꿔가며
// 확인한다(도구 연결 여부가 스킬 노출과 섞여 있지 않다는 것 자체가 이 불변식의 일부다).
describe("buildSystemPrompt — 모든 능력 분기가 스킬 안내를 갖는다(Task 4)", () => {
  it("소유자·손님 × DM·서버 × 워커 연결 여부(8가지 조합) 전부 스킬 안내를 포함한다", () => {
    const identities = [
      { isOwner: true, isPrivate: true },
      { isOwner: true, isPrivate: false },
      { isOwner: false, isPrivate: true },
      { isOwner: false, isPrivate: false },
    ];
    for (const identity of identities) {
      for (const workerConnected of [true, false]) {
        const p = buildSystemPrompt({ role: identity.isOwner ? "owner" : "allowed", ...identity, workerConnected });
        expect(capabilitySection(p)).toMatch(/스킬/);
      }
    }
  });
});

// 실사용에서 드러난 문제 — 능력 안내가 "네 몫의 폴더"라고만 하고 경로를 주지 않아, 손님이
// "내 워크스페이스에 폴더 만들어줘"라고 하면 봇이 절대경로를 되물었다. 손님에게는 list_dirs
// (관리자 전용)도 없어서, 자기 디스코드 숫자 id 를 개발자 모드로 직접 복사해 오지 않는 한
// fs_* 를 쓸 방법이 없었다. core.ts 가 remoteToolHandler 와 같은 scopeDirs 계산으로 구한
// 경로를 실어 준다 — 안내와 집행이 다른 계산에서 나오면 어긋난다.
describe("buildSystemPrompt — 손님에게 자기 작업 폴더 경로를 알려준다", () => {
  const DIR = "C:\\asahi-workspace\\1517428698368704650";

  for (const isPrivate of [true, false]) {
    const where = isPrivate ? "DM" : "서버";
    const guest = { role: "allowed" as const, isOwner: false, isPrivate };

    it(`손님(${where}) + 워커 연결 + 폴더가 있으면 그 경로를 능력 안내에 넣는다`, () => {
      const cap = capabilitySection(buildSystemPrompt({ ...guest, workerConnected: true, workspaceDirs: [DIR] }));
      expect(cap).toContain(DIR);
    });

    it(`손님(${where}) + 폴더가 비었거나 생략되면 경로 줄 자체를 넣지 않는다(빈 안내로 지어낼 여지를 주지 않는다)`, () => {
      for (const workspaceDirs of [undefined, []]) {
        const cap = capabilitySection(buildSystemPrompt({ ...guest, workerConnected: true, workspaceDirs }));
        expect(cap).not.toMatch(/작업 폴더는/);
      }
    });

    it(`손님(${where}) + 워커 미연결이면 폴더가 주어져도 경로를 안내하지 않는다(도구가 없는데 위치만 알리지 않는다)`, () => {
      const cap = capabilitySection(buildSystemPrompt({ ...guest, workspaceDirs: [DIR] }));
      expect(cap).not.toContain(DIR);
    });

    it(`손님(${where}) 폴더가 여러 개면 모두 알려준다`, () => {
      const second = "D:\\ws\\1517428698368704650";
      const cap = capabilitySection(buildSystemPrompt({ ...guest, workerConnected: true, workspaceDirs: [DIR, second] }));
      expect(cap).toContain(DIR);
      expect(cap).toContain(second);
    });
  }

  it("소유자에게는 workspaceDirs 를 안내하지 않는다(scopeDirs 가 좁히지 않아 한 폴더로 특정되지 않고, list_dirs 로 직접 조회한다)", () => {
    for (const isPrivate of [true, false]) {
      const cap = capabilitySection(
        buildSystemPrompt({ role: "owner", isOwner: true, isPrivate, workerConnected: true, workspaceDirs: [DIR] }),
      );
      expect(cap).not.toContain(DIR);
    }
  });
});

// 리뷰 지적(Important 2) — Task 4 가 fs_tree 실행기·도구 선언을 추가했지만, 능력 안내(사용자에게
// 노출되는 서술형 도구 나열)에는 넣지 않았다. 이 저장소는 "안내와 실제 도구가 어긋남"을 결함
// 유형으로 명시적으로 다룬다(위 FIX3·FIX4 참고) — fs_tree 누락도 같은 유형이므로, 워커가 연결된
// 세 분기(소유자 DM·소유자 서버·손님) 모두에서 fs_tree 언급을 회귀 테스트로 고정한다.
describe("buildSystemPrompt — 능력 안내에 fs_tree 를 포함한다(fs_tree 도구 안내 누락 고침)", () => {
  it("owner-DM + 워커 연결 시 fs_tree 를 언급한다", () => {
    const p = buildSystemPrompt({ role: "owner", isPrivate: true, isOwner: true, workerConnected: true });
    expect(capabilitySection(p)).toMatch(/fs_tree/);
  });

  it("owner-서버 + 워커 연결 시 fs_tree 를 언급한다", () => {
    const p = buildSystemPrompt({ role: "owner", isPrivate: false, isOwner: true, workerConnected: true });
    expect(capabilitySection(p)).toMatch(/fs_tree/);
  });

  it("손님(DM·서버) + 워커 연결 시 fs_tree 를 언급한다", () => {
    for (const isPrivate of [true, false]) {
      const p = buildSystemPrompt({ role: "allowed", isPrivate, isOwner: false, workerConnected: true });
      expect(capabilitySection(p)).toMatch(/fs_tree/);
    }
  });
});

// Task 4 — 도구(tools.ts)가 서버 채널에도 remember/forget 을 이미 열어 뒀지만, 아사히가
// "서버에서는 저장할 수 없다"고 배운 상태면 도구가 열려도 시도하지 않는다. persona.ts 가 정확히
// 그렇게 말하고 있었다 — 소유자 서버(워커 연결/미연결)·손님 서버 세 분기 모두 공용 기억 저장을
// 안내해야 한다.
describe("buildSystemPrompt — 서버 분기는 공용 기억 저장을 안내한다(Task 4)", () => {
  it("서버 분기는 공용 기억 저장을 안내한다(소유자·손님 모두)", () => {
    // 도구가 열려도 "저장할 수 없다"고 배운 상태면 시도하지 않는다.
    for (const ctx of [
      { role: "owner" as const, isPrivate: false, isOwner: true, workerConnected: true },
      { role: "owner" as const, isPrivate: false, isOwner: true, workerConnected: false },
      { role: "allowed" as const, isPrivate: false, isOwner: false, workerConnected: false },
    ]) {
      expect(buildSystemPrompt(ctx)).toContain("동아리 공용");
    }
  });
});

// Important 5(최종 전체 브랜치 리뷰) — persona.ts:189(소유자 서버·워커 미연결 분기)가
// "공용 기억 조회(recall)만 가능합니다"라고 단정하면서 두 줄 아래에서 "remember 로 저장하면
// ... 동아리 공용 기억이 되어"라고 말해 자기모순이었다. 새 불릿(remember 안내)을 더하면서
// 원래 문장의 "만"을 못 지운 것이 원인이다 — 기존 테스트가 toContain("동아리 공용")만 봐서
// 이 모순을 못 잡았다. :179(연결 분기)도 능력을 열거하면서 remember·forget 을 빠뜨렸다.
// 그리고 이 파일에 forget 이 한 번도 등장하지 않았다 — 소유자는 DM·서버 양쪽에서 forget 을
// 받는데 안내가 없으면 "도구가 열려도 배운 상태가 아니면 시도하지 않는다"는 이 태스크
// 자신의 논리가 그대로 적용된다.
describe("buildSystemPrompt — 소유자 서버 능력 안내가 remember 가능 여부와 모순되지 않는다(Important 5)", () => {
  it("워커 미연결이어도 'recall 만 가능하다'고 단정하지 않는다 — remember 도 가능하므로(모순 방지)", () => {
    // toContain 만으로는 이 모순을 못 잡는다(리뷰 지적) — 정확히 이 낡은 단정 문구가 없는지
    // 직접 확인한다.
    const cap = capabilitySection(buildSystemPrompt({ role: "owner", isPrivate: false, isOwner: true, workerConnected: false }));
    expect(cap).not.toMatch(/recall\)만\s*가능/);
    expect(cap).toContain("동아리 공용");
  });

  it("워커 연결 시 능력을 열거하는 첫 문장 자체에 remember 가 포함된다(예전엔 recall·PC 작업만 열거해 remember·forget 을 빠뜨렸다)", () => {
    const cap = capabilitySection(buildSystemPrompt({ role: "owner", isPrivate: false, isOwner: true, workerConnected: true }));
    const firstBullet = cap.split("\n").find((l) => l.startsWith("- 공개 채널(서버) 대화입니다"));
    expect(firstBullet).toBeDefined();
    expect(firstBullet).toMatch(/remember/);
  });
});

describe("buildSystemPrompt — persona 가 forget 을 안내한다(Important 5, 회귀 전엔 한 번도 등장하지 않았다)", () => {
  it("소유자 DM(워커 연결·미연결) 능력 안내에 forget 이 등장한다", () => {
    for (const workerConnected of [true, false]) {
      const p = buildSystemPrompt({ role: "owner", isPrivate: true, isOwner: true, workerConnected });
      expect(capabilitySection(p)).toMatch(/forget/);
    }
  });

  it("소유자 서버(워커 연결·미연결) 능력 안내에 forget 이 등장한다", () => {
    for (const workerConnected of [true, false]) {
      const p = buildSystemPrompt({ role: "owner", isPrivate: false, isOwner: true, workerConnected });
      expect(capabilitySection(p)).toMatch(/forget/);
    }
  });

  it("손님(DM·서버)에는 forget 을 언급하지 않는다 — 도구 자체가 없다(allowedToolsFor 와 일치)", () => {
    for (const isPrivate of [true, false]) {
      const p = buildSystemPrompt({ role: "allowed", isPrivate, isOwner: false, workerConnected: true });
      expect(capabilitySection(p)).not.toMatch(/forget/);
    }
  });
});

// 캐릭터를 걷어낸 뒤에도 남는 가드 — 프롬프트에 연기 지시를 다시 심는 변경을 막는다. 예전엔
// "미성년 캐릭터라 연애·성적 맥락은 연기하지 않는다"는 불가침 규칙이 같은 일을 했지만, 그 규칙은
// 연기할 인격이 있다는 전제 위에 서 있었다. 전제가 사라져도 "이런 지시가 프롬프트에 없어야
// 한다"는 단정은 그대로 유효하므로 이 케이스만 남긴다.
describe("buildSystemPrompt — 연기 지시 회귀 가드", () => {
  it("성적 연기 지시가 없다(회귀 가드)", () => {
    // Important 2(최종 전체 브랜치 리뷰) — 예전엔 세 신원을 workerConnected 없이(기본 false)
    // 돌았다. 연결 분기가 텍스트를 가장 많이 지는데 이 가드는 그 분기를 한 번도 보지 못했다.
    // 위 character_fact 케이스(:38)가 이미 여덟 조합으로 넓혀 둔 것과 같은 형태로 맞춘다.
    for (const { ctx } of ALL_IDENTITIES) {
      for (const workerConnected of WORKER_STATES) {
        const p = buildSystemPrompt({ ...ctx, workerConnected });
        expect(p).not.toMatch(/음란|성적인 대화|성적 대화 방식|사정|노골적|야한|신체 접촉/);
      }
    }
  });
});

describe("buildSystemPrompt — 장기 실행 프로세스 도구를 안내한다", () => {
  it("워커가 연결된 네 분기 모두 proc_start 를 언급한다", () => {
    const branches = [
      { isOwner: true, isPrivate: true }, { isOwner: true, isPrivate: false },
      { isOwner: false, isPrivate: true }, { isOwner: false, isPrivate: false },
    ];
    for (const b of branches) {
      const p = buildSystemPrompt({ role: b.isOwner ? "owner" : "allowed", ...b, workerConnected: true });
      expect(capabilitySection(p)).toMatch(/proc_start/);
    }
  });

  it("워커 미연결이면 언급하지 않는다", () => {
    const cap = capabilitySection(buildSystemPrompt({ role: "allowed", isPrivate: false, isOwner: false }));
    expect(cap).not.toMatch(/proc_start/);
  });

  // 2차 리뷰 Important — 아래 두 클레임은 손님이 그대로 믿고 행동하는 내용이다(executors.ts 가
  // 실제로 강제하는 동작과 일치해야 한다). 이름 존재(/proc_start/)만 보는 위 테스트로는 이 문장이
  // 통째로 뒤집혀도(예: "여러 개 띄울 수 있고", "재부팅해도 유지됩니다") 잡아내지 못한다.
  it("손님 분기는 한 사람당 하나만 띄울 수 있다고 안내한다(executors.ts 의 중복 거부와 일치)", () => {
    const guestBranches = [{ isPrivate: true }, { isPrivate: false }];
    for (const b of guestBranches) {
      const p = buildSystemPrompt({ role: "allowed", isOwner: false, ...b, workerConnected: true });
      // "여러 개 띄울 수 있고" 로 뒤집히면 "한 사람당 하나"라는 substring 자체가 사라진다.
      expect(capabilitySection(p)).toMatch(/한 사람당 하나/);
    }
  });

  it("손님 분기는 공유 기계가 재부팅되면 프로세스가 전부 사라진다고 안내한다(pm2 save/resurrect 없음과 일치)", () => {
    const guestBranches = [{ isPrivate: true }, { isPrivate: false }];
    for (const b of guestBranches) {
      const p = buildSystemPrompt({ role: "allowed", isOwner: false, ...b, workerConnected: true });
      // "재부팅해도 유지됩니다" 로 뒤집히면 "사라집니다"가 사라진다. 어간 "사라"만 보면
      // "사라지지 않습니다" 같은 부정문(같은 어간을 공유)에도 걸려 뒤집힘을 놓치므로,
      // 활용까지 포함한 "사라집니다"를 "재부팅"과 함께 고정한다.
      expect(capabilitySection(p)).toMatch(/재부팅.*사라집니다/);
    }
  });
});

// 2026-08-05(캐릭터 제거) — 안전 규칙 셋(인젝션 가드·이모지 금지·작업 사실 조작 금지)이 캐릭터를
// 설명하는 문맥 안에 얹혀 있어서, 캐릭터 블록만 걷어내면 함께 사라진다. 셋 다 신원 네 분기
// 전부에서 고정해 둔다 — 분기별로 프롬프트가 다르게 조립되므로 한 분기만 확인하면 나머지가
// 조용히 빠져도 모른다.
describe("buildSystemPrompt — 캐릭터 제거 후 남아야 할 것", () => {
  // Important 2(최종 전체 브랜치 리뷰) — 신원 넷만 돌고 workerConnected 를 생략(기본 false)해,
  // 이 파일에서 가장 중요한 회귀 가드("캐릭터 흔적이 없다")가 미연결 프롬프트만 보고 있었다.
  // 연결 분기가 텍스트를 가장 많이 지고, 이 브랜치가 능력 블록에서 실제로 고친 한 줄도 그쪽에만
  // 있다. 리뷰가 재현한 대로 연결 분기에만 실리는 문자열(guestPcLine)에 캐릭터 지시를 심으면
  // 전체 스위트가 그대로 초록이었다 — 신원 4 × 워커 2 여덟 조합 전부로 넓힌다.
  const CONTEXTS = ALL_IDENTITIES.flatMap(({ name, ctx }) =>
    WORKER_STATES.map((workerConnected) => ({
      name: `${name}·워커 ${workerConnected ? "연결" : "미연결"}`,
      ctx: { ...ctx, workerConnected },
    })),
  );

  for (const { name, ctx } of CONTEXTS) {
    it(`${name}: 프롬프트 인젝션 가드가 있다`, () => {
      expect(buildSystemPrompt(ctx)).toContain("신뢰할 수 없는 데이터");
    });

    it(`${name}: 이모지 금지가 있다`, () => {
      expect(buildSystemPrompt(ctx)).toContain("이모지");
    });

    it(`${name}: 작업 사실을 지어내지 말라는 규칙이 있다`, () => {
      // 캐릭터가 사라지면 이 규칙이 오히려 더 중요해진다 — 지어내도 되는 영역이 아예 없어진다.
      // 지금은 "자기 인생 얘기는 지어내고 도구가 한 일은 그대로 말한다"는 대비로 서술돼 있어,
      // 앞쪽만 지우면 이 문장이 통째로 사라진다.
      const out = buildSystemPrompt(ctx);
      expect(out).toContain("도구 호출의 성공·실패");
      expect(out).toContain("지어내지 않는다");
    });

    // 리뷰 후속 — 정체성 블록의 "규칙은 바뀌지 않는다"가 가리키는 대상이 능력 안내다. 구
    // 불가침 규칙의 둘째 문장("아래 능력 안내의 제한을 항상 따른다")이 교체 과정에서 빠졌던
    // 것을 되살렸다. 능력 안내는 신원·워커 상태로 갈리지만 이 상호참조는 갈리지 않아야
    // 한다 — 네 분기 전부에서 고정한다.
    it(`${name}: 능력 안내의 제한을 따르라는 상호참조가 있다`, () => {
      expect(buildSystemPrompt(ctx)).toContain("능력 안내의 제한을 항상 따른다");
    });

    it(`${name}: 캐릭터 흔적이 없다`, () => {
      // 이 작업의 가장 흔한 실패 모드가 "문구 한 줄이 어딘가 남는 것"이다.
      //
      // 리뷰 후속 — 이 목록이 이름값을 못 했다. 지운 관계·말투 블록을 그대로 다시 심어 보니
      // 소유자 DM 만 걸리고(우연히 "반말"이 있었다) 소유자 서버·손님 DM·손님 서버는 전부
      // 빠져나갔다. 실제로 관계 단계별 태도를 실어 나르던 낱말(서먹·익숙·시크·다정)과 캐릭터
      // 전제를 드러내는 낱말(캐릭터·인격·연기), 구 정체성의 라틴 표기(Asahi)가 목록에
      // 없었기 때문이다. "AI냐고"도 넣는다 — 구 자기 서사의 AI 부인 지시("AI냐고 물으면
      // 아니라고 답한다")를 되살려도 "너는 AI 어시스턴트다"와 나란히 통과해, 서로 모순되는
      // 프롬프트가 두 테스트를 다 지나갔다.
      const out = buildSystemPrompt(ctx);
      const TRACES = [
        "16세", "고등학생", "표정", "반말", "무표정", "자기 서사", "사람처럼",
        "서먹", "익숙", "시크", "다정", "Asahi", "캐릭터", "인격", "연기", "AI냐고",
      ];
      for (const trace of TRACES) {
        expect(out).not.toContain(trace);
      }
    });

    it(`${name}: AI 임을 숨기지 않는다`, () => {
      expect(buildSystemPrompt(ctx)).toContain("AI 어시스턴트다");
    });
  }
});

// Task 5 — persona.ts 의 "## 사실성" 절 끝에 더한 보조 지침(상태·버전·목록처럼 시간에 따라
// 변하는 값은 다시 조회하라)이 네 신원 분기 모두에서 빠짐없이 실리는지 고정한다. IDENTITY 는
// ctx 로 갈리지 않는 상수라 네 분기 전부 동일하게 나와야 정상이다 — 이 지침은 보조일 뿐,
// 화자 표기(speaker.ts)와 턴별 도구 등록(tools.ts 의 allowedToolDefinitions)이 하는 구조적
// 수정을 대신하지 않는다.
describe("buildSystemPrompt — 시간에 따라 변하는 값은 다시 조회하라는 지침(Task 5)", () => {
  for (const { name, ctx } of ALL_IDENTITIES) {
    it(`${name}: 시간에 따라 변하는 것은 다시 조회하라는 지침이 있다`, () => {
      expect(buildSystemPrompt(ctx)).toContain("새로 조회한다");
    });
  }
});

describe("깃허브 발행 안내", () => {
  const base = { role: "allowed" as const, isPrivate: true, isOwner: true };

  it("워커가 붙고 설정이 있으면 발행을 안내한다", () => {
    const p = buildSystemPrompt({ ...base, workerConnected: true, githubReady: true });
    expect(p).toContain("publish_project");
    expect(p).toContain("restore_project");
  });

  // 없는 도구를 쓰라고 안내하면 모델이 시도했다가 실패를 사용자에게 전달한다.
  it("깃허브 설정이 없으면 안내하지 않는다", () => {
    const p = buildSystemPrompt({ ...base, workerConnected: true, githubReady: false });
    expect(p).not.toContain("publish_project");
  });

  it("워커가 없으면 안내하지 않는다", () => {
    const p = buildSystemPrompt({ ...base, workerConnected: false, githubReady: true });
    expect(p).not.toContain("publish_project");
  });

  // 안내가 나오는 조합은 도구가 열리는 조합과 정확히 같아야 한다(tools.ts 의 publishTools).
  // 어긋나면 "도구는 있는데 안내가 없다"거나 그 반대가 된다 — 이 저장소가 결함 유형으로 다루는 것이다.
  it("네 신원 모두에서 도구 노출과 안내가 일치한다", () => {
    for (const [isPrivate, isOwner] of [[true, true], [false, true], [true, false], [false, false]] as const) {
      for (const githubReady of [true, false]) {
        const prompt = buildSystemPrompt({ role: "allowed", isPrivate, isOwner, workerConnected: true, githubReady });
        const tools = allowedToolsFor("allowed", isPrivate, isOwner, "local", { workerConnected: true, githubReady });
        expect(prompt.includes("publish_project")).toBe(tools.includes("mcp__asahi__publish_project"));
      }
    }
  });
});
