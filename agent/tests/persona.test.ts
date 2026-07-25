import { describe, it, expect } from "vitest";
import { buildSystemPrompt, deriveRapportStage } from "../src/core/persona.js";

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

  it("owner+DM 이면 파일 도구·manage_access 능력 안내를 포함한다", () => {
    const p = buildSystemPrompt({ role: "owner", isPrivate: true, isOwner: true });
    expect(p).toMatch(/manage_access/);
    expect(p).toMatch(/파일/);
  });

  it("owner+DM 이면 Bash 봉쇄를 과장하지 않고, 폴더 밖·시스템·네트워크 작업은 하지 말라고 안내한다(보안리뷰 #2)", () => {
    const p = buildSystemPrompt({ role: "owner", isPrivate: true, isOwner: true });
    expect(p).toMatch(/Bash/);
    // "Bash 도 허용 폴더 안에서만 가능하다"는 실제보다 강한(거짓) 보장 문구는 없어야 한다.
    expect(p).not.toMatch(/파일\s*[·,]?\s*셸\(?Bash\)?\s*작업은[^.]*허용\s*폴더\s*안에서만\s*가능/);
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

describe("buildSystemPrompt — deployTarget(§Railway 조각2)", () => {
  it("deployTarget 을 생략하면 local 과 동일하게(기존 owner-DM 파일 도구 안내) 동작한다", () => {
    const withoutField = buildSystemPrompt({ role: "owner", isPrivate: true, isOwner: true });
    const withLocal = buildSystemPrompt({ role: "owner", isPrivate: true, isOwner: true, deployTarget: "local" });
    expect(withoutField).toBe(withLocal);
    expect(withoutField).toMatch(/파일/);
    expect(withoutField).toMatch(/manage_access/);
  });

  it("deployTarget='cloud' + owner-DM 이면 PC 파일·셸 작업 불가 + 로컬 워커 연결 안내로 바뀐다", () => {
    const p = buildSystemPrompt({ role: "owner", isPrivate: true, isOwner: true, deployTarget: "cloud" });
    expect(p).toMatch(/클라우드/);
    expect(p).toMatch(/로컬 워커/);
    expect(p).toMatch(/manage_access/); // 기억·접근관리는 PC 무관하니 유지
  });

  it("deployTarget='cloud' 라도 손님 DM·서버 안내는 local 과 동일(영향 없음)", () => {
    const guestLocal = buildSystemPrompt({ role: "allowed", isPrivate: true, isOwner: false, deployTarget: "local" });
    const guestCloud = buildSystemPrompt({ role: "allowed", isPrivate: true, isOwner: false, deployTarget: "cloud" });
    expect(guestLocal).toBe(guestCloud);

    const serverLocal = buildSystemPrompt({ role: "allowed", isPrivate: false, isOwner: false, deployTarget: "local" });
    const serverCloud = buildSystemPrompt({ role: "allowed", isPrivate: false, isOwner: false, deployTarget: "cloud" });
    expect(serverLocal).toBe(serverCloud);
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
