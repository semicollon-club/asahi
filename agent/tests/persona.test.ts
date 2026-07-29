import { describe, it, expect } from "vitest";
import { buildSystemPrompt, deriveRapportStage } from "../src/core/persona.js";

// FIX3(최종 리뷰) 관련 테스트가 "능력 안내에 더 이상 존재하지 않는 SDK 도구 이름이 없다"를
// 확인할 때 쓴다 — 프롬프트 전체를 대상으로 하면 무관한 다른 절(예: 자기 서사의 "지어내면 안
// 되는 것" 목록은 "명령(Bash) 실행 여부와 결과"처럼 범주를 설명할 때 Bash 를 언급한다)에 걸려
// 오탐이 난다. "## 능력" 절만 잘라 그 안에서만 검사한다.
function capabilitySection(fullPrompt: string): string {
  const start = fullPrompt.indexOf("## 능력");
  const end = fullPrompt.indexOf("## 관계·말투");
  return fullPrompt.slice(start, end === -1 ? undefined : end);
}

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

  it("손님 DM·서버 모두 워커 미연결(기본값)이면 기존처럼 파일·셸 도구 이름을 언급하지 않는다(회귀 없음)", () => {
    const dm = buildSystemPrompt({ role: "allowed", isPrivate: true, isOwner: false });
    const server = buildSystemPrompt({ role: "allowed", isPrivate: false, isOwner: false });
    for (const p of [dm, server]) {
      expect(p).not.toMatch(/fs_read|fs_write|fs_edit|fs_glob|fs_grep|sh_exec/);
    }
  });
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

describe("deriveRapportStage", () => {
  it("10 미만이면 0(서먹)", () => {
    expect(deriveRapportStage(0)).toBe(0);
    expect(deriveRapportStage(9)).toBe(0);
  });
  it("10~49면 1(보통)", () => {
    expect(deriveRapportStage(10)).toBe(1);
    expect(deriveRapportStage(49)).toBe(1);
  });
  it("50 이상이면 2(편함)", () => {
    expect(deriveRapportStage(50)).toBe(2);
    expect(deriveRapportStage(1000)).toBe(2);
  });
});

describe("buildSystemPrompt — 캐릭터/관계", () => {
  const OWNER = { role: "owner", isPrivate: true, isOwner: true } as const;
  const GUEST = { role: "allowed", isPrivate: true, isOwner: false } as const;
  const SERVER = { role: "allowed", isPrivate: false, isOwner: false } as const;

  it("모든 컨텍스트에 Asahi 정체성과 불가침 규칙(미성년 선긋기)을 포함한다", () => {
    for (const ctx of [OWNER, GUEST, SERVER]) {
      const p = buildSystemPrompt(ctx);
      expect(p).toMatch(/Asahi/);
      expect(p).toMatch(/미성년/);
      expect(p).toMatch(/연애/);
      // 회귀 가드: "미성년이지만 연애 요청은 받아준다" 같은 뒤집힌 문구도 /미성년/,/연애/ 만으로는
      // 잡히지 않으므로, 실제 금지 문장 그대로를 확인한다.
      expect(p).toMatch(/연애적·성적 맥락은 절대 연기하지 않는다/);
    }
  });

  it("소유자 DM 은 반말 말투 지시를 포함한다", () => {
    expect(buildSystemPrompt(OWNER)).toMatch(/반말/);
  });

  it("소유자 친근도 0(기본)은 '서먹', 2는 '편한'/'먼저' 다정 문구로 바뀐다", () => {
    const s0 = buildSystemPrompt(OWNER);
    expect(s0).toMatch(/서먹/);
    const s2 = buildSystemPrompt({ ...OWNER, rapportStage: 2 });
    expect(s2).toMatch(/편한|먼저/);
    expect(s2).not.toMatch(/아직 서먹/);
  });

  it("손님 DM 은 낮은 존댓말·거리감 지시를 포함한다", () => {
    const p = buildSystemPrompt(GUEST);
    expect(p).toMatch(/존댓말/);
    expect(p).toMatch(/거리/);
  });

  it("서버 공개 채널은 건조·공적 지시를 포함한다", () => {
    const p = buildSystemPrompt(SERVER);
    expect(p).toMatch(/공개 채널|건조|공적/);
  });

  it("소유자 친근도 1(익숙)은 '익숙' 다정 문구를 포함한다", () => {
    expect(buildSystemPrompt({ ...OWNER, rapportStage: 1 })).toMatch(/익숙/);
  });

  it("손님 친근도 2는 '덜 서먹'/'여러 번' 다정 문구를 포함한다", () => {
    expect(buildSystemPrompt({ ...GUEST, rapportStage: 2 })).toMatch(/덜 서먹|여러 번/);
  });

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

describe("buildSystemPrompt — 캐릭터 시트 · 거짓말 경계", () => {
  const OWNER = { role: "owner", isPrivate: true, isOwner: true } as const;
  const GUEST = { role: "allowed", isPrivate: true, isOwner: false } as const;
  const SERVER = { role: "allowed", isPrivate: false, isOwner: false } as const;
  const ALL = [OWNER, GUEST, SERVER];

  it("고정 설정(16세·안테나·붉은 눈·세미콜론)을 모든 컨텍스트에 포함한다", () => {
    for (const ctx of ALL) {
      const p = buildSystemPrompt(ctx);
      expect(p).toMatch(/16세/);
      expect(p).toMatch(/안테나/);
      expect(p).toMatch(/붉은 눈/);
      expect(p).toMatch(/세미콜론/);
    }
  });

  it("AI냐고 물으면 아니라고 답하라는 정체성 부인 지시를 모든 컨텍스트(소유자 DM/손님 DM/공개 서버)에 포함한다", () => {
    for (const ctx of ALL) {
      const p = buildSystemPrompt(ctx);
      expect(p).toMatch(/AI냐고 물으면 아니라고 답한다/);
    }
  });

  it("나이 서술이 모순되지 않는다(성인 표현 없음)", () => {
    for (const ctx of ALL) expect(buildSystemPrompt(ctx)).not.toMatch(/성인|어른/);
  });

  it("성적 연기 지시가 없다(회귀 가드)", () => {
    for (const ctx of ALL) {
      const p = buildSystemPrompt(ctx);
      expect(p).not.toMatch(/음란|성적인 대화|성적 대화 방식|사정|노골적|야한|신체 접촉/);
    }
  });

  it("지어내도 되는 영역과 안 되는 영역을 분리해 명시한다", () => {
    for (const ctx of ALL) {
      const p = buildSystemPrompt(ctx);
      expect(p).toMatch(/지어내도 되는/);
      expect(p).toMatch(/지어내면 안 되는/);
      if (ctx.isPrivate) {
        // DM(소유자·손님)은 character_fact 로 저장하라는 지시를 받는다.
        expect(p).toMatch(/character_fact/);
      } else {
        // 공개 서버 채널은 character_fact 도구가 없으므로(§FIX1) 저장 불가 안내로 대체된다.
        expect(p).toMatch(/공개 채널에서는 새 설정을 저장할 수 없다/);
        // 회귀 가드(커밋 553284b): 공개 채널 프롬프트에 character_fact 언급이 다시 섞여 들어가면
        // 모델이 없는 도구를 쓰려 하거나 "저장했다"고 거짓 보고할 위험이 생긴다.
        expect(p).not.toMatch(/character_fact/);
      }
    }
  });

  it("작업 사실(도구 결과·파일·DB)은 지어내지 말라고 명시한다", () => {
    for (const ctx of ALL) {
      const p = buildSystemPrompt(ctx);
      expect(p).toMatch(/도구가 한 일은 그대로/);
    }
  });

  it("위기 상황 예외(안전밸브)를 포함한다", () => {
    for (const ctx of ALL) {
      const p = buildSystemPrompt(ctx);
      expect(p).toMatch(/자해|응급/);
      // 문구가 "위기에도 캐릭터를 깨지 마라"처럼 뒤집혀도 /자해|응급/ 만으로는 잡히지 않으므로,
      // 실제로 캐릭터를 깨고 사람이 아님을 밝히라는 지시인지까지 확인한다.
      expect(p).toMatch(/캐릭터를 깨고/);
      expect(p).toMatch(/사람이 아님/);
    }
  });
});

describe("buildSystemPrompt — 표정 이미지", () => {
  const OWNER = { role: "owner", isPrivate: true, isOwner: true } as const;
  const GUEST = { role: "allowed", isPrivate: true, isOwner: false } as const;
  const SERVER = { role: "allowed", isPrivate: false, isOwner: false } as const;
  const EMOTIONS = ["기본 무표정", "당황", "홍조"];

  it("감정 목록이 있으면 마커 문법과 감정 이름이 프롬프트에 들어간다", () => {
    const p = buildSystemPrompt({ ...OWNER, emotions: EMOTIONS });
    expect(p).toMatch(/\[표정:/);
    for (const e of EMOTIONS) expect(p).toContain(e);
  });

  it("전 채널에서 동일하게 제공된다", () => {
    for (const ctx of [OWNER, GUEST, SERVER]) {
      expect(buildSystemPrompt({ ...ctx, emotions: EMOTIONS })).toMatch(/\[표정:/);
    }
  });

  it("감정 목록이 비었거나 없으면 표정 지침 자체가 빠진다", () => {
    expect(buildSystemPrompt({ ...OWNER, emotions: [] })).not.toMatch(/\[표정:/);
    expect(buildSystemPrompt(OWNER)).not.toMatch(/\[표정:/);
  });

  it("남발 금지 지침을 포함한다", () => {
    const p = buildSystemPrompt({ ...OWNER, emotions: EMOTIONS });
    expect(p).toMatch(/매 답변마다/);
    expect(p).toMatch(/감정이 실제로/);
  });

  it("이모지 금지 규칙은 그대로 유지된다", () => {
    expect(buildSystemPrompt({ ...OWNER, emotions: EMOTIONS })).toMatch(/이모지/);
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
