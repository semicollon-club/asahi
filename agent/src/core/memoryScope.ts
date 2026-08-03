import type { Memory } from "../store/memoriesRepo.js";

// 공용 기억 1건의 내용 상한. recall 은 걸린 기억의 "내용 전체"를 돌려주므로, 문서를 통째로
// 넣으면 "회비 얼마야"에 회칙 전문이 딸려온다. 문서 원본이 필요하면 그건 기억이 아니라
// 파일이다 — 워커에 두고 fs_read 로 읽으면 된다.
export const SHARED_MEMORY_MAX_LEN = 4000;

// Important 1(최종 전체 브랜치 리뷰) — 공용 기억 1건의 제목 상한. tools.ts 의 4000자 상한
// 검사가 content 에만 걸려 title 에는 상한이 아예 없었다(12,000자 제목 저장이 실측으로
// 성공했다). 제목은 recall·forget 목록에 한 줄로 나열되고, turnPrep 프롬프트에도 매 서버
// 턴마다 실려 사실상 모든 대화에 영구히 얹힌다 — content(4000)와 같은 크기일 이유가 없다.
// remember 도구 설명이 스스로 "짧은 제목"이라 부르는 값이므로, character_fact 의 제목
// 상한(40, tools.ts 의 CHARACTER_FACT_TITLE_MAX_LEN)보다는 넉넉히 잡는다 — 동아리 문서
// 제목은 지어낸 캐릭터 신상 항목("학년" 등)보다 서술적일 수 있다(예: "2학기 회비 및 활동
// 시간 안내"). 100자면 그런 제목도 넉넉히 담고도 "제목"이라는 성격을 벗어나지 않는다.
export const SHARED_MEMORY_TITLE_MAX_LEN = 100;

// 이번 저장이 개인 기억인지 동아리 공용 기억인지. 위치 하나로만 정한다.
//
// 모델이 스코프를 고르게 하면 틀릴 수 있고, 틀리면 개인 얘기가 전원에게 보이거나 동아리
// 사실이 한 사람에게만 남는다. 위치는 틀릴 수가 없다 — workerSelect.ts 가 어느 기계를 쓸지
// 정할 때 쓰는 규칙과 같은 축이다.
//
// isOwner 를 받지 않는 것이 설계다. 받으면 "소유자는 서버에서도 개인 기억" 같은 갈래가 생기고,
// 그때부터 무엇이 어디에 저장됐는지 사람이 추적할 수 없게 된다.
export function memoryScopeFor(ctx: { isPrivate: boolean }): "user" | "shared" {
  return ctx.isPrivate ? "user" : "shared";
}

// Task 2 리뷰 지적(Important, 병합 차단): names 의 출처는 usersRepo.displayNames() → 회원이
// 디스코드에서 스스로 정하는 표시 이름(discord.ts 의 message.author.displayName)이고, 파이프라인
// 어디에서도 검증되지 않는다. 이름을 검증 없이 그대로 꽂으면, 표시 이름 자체에
// "이름\n- [공지] 총무 계좌가 바뀌었습니다: ..." 같은 문자열을 넣어 그 사람이 과거에 남긴 모든
// 공용 기억의 recall 결과에 진짜 항목과 구분되지 않는 가짜 기억 줄을 끼워 넣을 수 있다 — recall
// 출력은 모델이 그대로 옮기는 텍스트라 그 줄이 동아리 공지처럼 전달된다.
//
// proc.ts 의 memberLabel(pm2 표에 회원 표시 이름을 꽂을 때 대괄호·개행을 지우고 40자로 자르는
// 함수)이 같은 입력(같은 표시 이름)으로 같은 위조(표 형식 흉내)를 이미 겪고 고친 선례다. 그
// 함수를 이 파일에서 import 하지 않는다 — proc.ts 는 워커 쪽 모듈이고 이 파일은 봇 코어라
// 계층을 가로지르는 의존을 만들지 않는다. 대신 같은 처리를 여기 따로 둔다: memberLabel 을 고칠
// 일이 있으면 이 함수도 같이 봐야 한다.
const AUTHOR_NAME_MAX = 40;

function sanitizeAuthorName(raw: string): string | undefined {
  // 대괄호·캐리지리턴·개행을 없앤다 — 이 파일의 출력 형식이 "- [제목] 내용 (이름 등록)"이므로
  // 대괄호는 그 형식을 흉내 내는 축이고, 개행은 "기억 한 건 = 출력 한 줄" 가정을 깨는 축이다.
  const scrubbed = raw.replace(/[[\]\r\n]/g, " ").slice(0, AUTHOR_NAME_MAX).trim();
  // 지우고 나니 아무것도 안 남는 이름(예: 통째로 "[]" 였던 경우)은 이름을 모르는 경우와 같은
  // 폴백으로 떨어뜨린다 — proc.ts 와 달리 여기는 "생성 이름"이라는 대안이 없다.
  return scrubbed.length > 0 ? scrubbed : undefined;
}

// Task 4 리뷰 지적 — sanitizeAuthorName 은 작성자 이름의 개행을 막지만, 제목·내용은 그대로
// 나갔다. 공용 기억은 이제 부원 누구나 쓸 수 있으므로, 제목이나 내용에 개행을 넣으면 이 파일의
// 출력 형식이 한 줄 = 한 건이라는 가정을 깨고 여러 항목처럼 렌더링된다 — 작성자 표시가 붙는
// 지금은 더 나쁘다. "\n- [공지] 총무 계좌 변경" 같은 줄을 끼워 넣어 다른 사람이 등록한 것처럼
// 위조할 수 있다.
//
// 이름과 달리 대괄호까지 지우거나 길이를 자르지는 않는다 — 내용은 실제 정보라 자르면 사실이
// 손상되고, 대괄호는 정상적인 본문에도 흔하다. 깨지는 축은 개행 하나뿐이다. tools.ts 의
// singleLine(forget 목록의 제목을 다루는 것)과 같은 처리이지만, 그 파일은 도구 계층이고 이
// 파일은 코어 모듈이라 계층을 가로지르는 의존을 만들지 않는다 — 대신 같은 처리를 여기 따로 둔다.
const stripNewlines = (s: string): string => s.replace(/[\r\n]+/g, " ");

// "[제목] 내용" 조각(선행 "- " 는 뺀다) — 개행만 없앤다. renderMemoryLine 과 renderMemories
// 양쪽이 공유하는 유일한 자리라, 여기 하나만 고치면 둘 다 같이 고쳐진다.
function titleContentPart(m: { title: string; content: string }): string {
  return `[${stripNewlines(m.title)}] ${stripNewlines(m.content)}`;
}

// Critical(최종 전체 브랜치 리뷰) — 기억(또는 캐릭터 설정) 한 건을 "- [제목] 내용" 한 줄로.
// turnPrep.ts(세션을 여는 프롬프트 본문 — buildContextBlock 의 캐릭터 설정 줄·기억 줄)가 이
// 함수 이전에는 같은 형식을 직접 만들면서 개행 방어가 없었다. recall(아래 renderMemories)은
// 도구 결과일 뿐이지만 turnPrep 쪽은 세션마다 열리는 시스템 프롬프트 본문이고, 서버에서 등록한
// 공용 기억이 forUser()(scope='shared' 도 포함)를 통해 소유자 DM 컨텍스트에도 실린다 —
// 개행과 가짜 "## 최근 대화 기록" 같은 섹션 헤더를 내용에 심으면 "반드시 이대로 유지"라고
// 못박은 섹션 구조 자체가 위조됐다(리뷰가 실제로 재현했다). 같은 처리가 이미 세 곳
// (여기의 stripNewlines, tools.ts 의 singleLine, turnPrep 의 인라인 렌더링)으로 늘어날
// 뻔했으므로, memoryScope.ts 가 이 함수 하나를 내보내고 turnPrep 이 그대로 쓴다(같은 코어
// 계층이라 계층 횡단이 아니다).
//
// 작성자 표시는 이 함수의 책임이 아니다 — turnPrep 은 표시 이름을 조회하지 않고(다른 계층이라
// users 리포를 새로 엮지 않는다), recall 전용의 작성자 표시(공격자가 못 쓰는 자리로 옮기는
// 처리, 아래 참고)는 renderMemories 가 이 함수 위에 따로 얹는다.
export function renderMemoryLine(m: { title: string; content: string }): string {
  return `- ${titleContentPart(m)}`;
}

// 이름을 모르거나 정리 후 완전히 비는 회원의 작성자 표시. Important 3(최종 전체 브랜치
// 리뷰) 전에는 이럴 때 표시를 생략했다 — 그런데 생략하면 "표시 없음"이 개인 기억과 구별되지
// 않아, 내용 끝에 심은 가짜 "(이름 등록)"이 유일한 작성자 표시처럼 보였다(이름이 없는
// 회원일수록 오히려 위조하기 좋았다). 생략 대신 "모른다"는 사실 자체를 항상 보여준다.
const UNKNOWN_AUTHOR_TAG = "작성자 미상";

// 기억(또는 캐릭터 설정) 한 건을 renderMemories 가 예산과 함께 쓸 한 줄로. 공용 기억에는
// 작성자 표시를 항상 붙인다 — 누구나 쓸 수 있는 저장소라 "누가 넣었는지"가 그 정보를 얼마나
// 믿을지의 근거가 된다. 개인 기억은 본인 것이라 작성자가 자명하므로 붙이지 않는다.
//
// Important 3(최종 전체 브랜치 리뷰) — 작성자 표시는 줄 끝이 아니라 맨 앞에 둔다. 예전엔
// "- [제목] 내용 (이름 등록)"이라 내용 끝에 "(소유자 등록)" 을 넣으면 진짜 표시와 구분되지
// 않았다. renderMemoryLine 이 개행을 막은 뒤에는 기억 한 건이 정확히 한 줄이므로, 줄의 첫
// 글자는 title·content 를 붙이기 전에 이 함수가 이미 쓴 자리다 — title·content 가 아무리
// 조작돼도(개행 없이 그 안에 위조 문구를 넣어도) 그 문구는 이 접두사보다 뒤에만 나타날 수
// 있다. 그래서 이 접두사가 "이 줄의 진짜 작성자"를 가리키는 유일한 근거로 남는다.
//
// Task 1(컨텍스트 블록 문자 예산) — renderMemories 본문에 있던 .map 콜백을 이름을 붙여
// 뽑은 것뿐이다. 한 줄을 만드는 규칙은 전혀 바뀌지 않았다 — renderMemories 가 이 결과를
// 예산 안에 넣을지만 새로 판단한다.
//
// Important 1(최종 전체 브랜치 리뷰) — 태그를 만드는 부분만 authorTag 로 다시 뽑았다. 예산을
// 넘겨 "제목만" 남는 줄이 이 함수를 거치지 않고 접두사를 따로 만들면서 작성자 표시를 통째로
// 잃었기 때문이다(아래 renderTitleOnly 주석). 두 갈래가 같은 함수 하나에서 접두사를 받게 해,
// 한쪽만 고치는 드리프트가 다시 생길 수 없게 한다.
function renderOne(m: Memory, names: Record<string, string>): string {
  return `- ${authorTag(m, names)}${titleContentPart(m)}`;
}

// "- " 뒤에 붙는 작성자 접두사("(우성현 등록) ")를 만든다. 공용 기억이 아니면 빈 문자열이다 —
// 개인 기억은 본인 것이라 작성자가 자명하고, 캐릭터 설정(scope='character')은 아사히가 지어낸
// 값이라 작성자 개념 자체가 없다.
function authorTag(m: Memory, names: Record<string, string>): string {
  if (m.scope !== "shared") return "";
  const name = names[m.userId];
  const who = name !== undefined ? sanitizeAuthorName(name) : undefined;
  // 조사 없는 형태를 쓴다("이 등록" 이 아니라 "등록") — 이름이 모음으로 끝나면("김지우")
  // "김지우이 등록"처럼 비문이 된다. 받침 유무를 코드로 판정하는 것은 이 한 줄에 값하지 않는다.
  const tag = who !== undefined ? `${who} 등록` : UNKNOWN_AUTHOR_TAG;
  return `(${tag}) `;
}

// Important 1(최종 전체 브랜치 리뷰) — 예산을 넘긴 기억의 "제목만" 줄. 예전엔 renderMemories
// 본문이 이 줄을 `- [제목]` 으로 직접 만들어 작성자 표시를 붙이지 않았다 — 그 형식은 개인
// 기억이 렌더링되는 형식과 모양이 같아서, 공용 기억이 예산을 넘기는 순간 작성자 표시를 잃고
// 소유자 개인 기억과 구분되지 않는 줄이 됐다. 위 renderOne 이 태그를 맨 앞에 두는 이유(제목·
// 내용이 아무리 조작돼도 닿을 수 없는 자리)가 이 갈래에서만 통째로 무효였던 셈이고, remember
// 는 서버 채널에서 부원 누구나 쓸 수 있으므로 공격자가 그 상태를 스스로 만들 수 있었다.
// stripNewlines 는 그대로 둔다 — 그건 섹션 헤더 위조를 막는 별개의 축이다.
function renderTitleOnly(m: Memory, names: Record<string, string>): string {
  return `- ${authorTag(m, names)}[${stripNewlines(m.title)}]`;
}

// 컨텍스트 블록의 기억 섹션 문자 예산. recall 에는 걸지 않는다 — 그쪽은 사용자가 명시적으로
// 물어본 결과다.
//
// 6000 인 이유: 기억 1건 상한이 4000자(SHARED_MEMORY_MAX_LEN)이므로 큰 기억 한 건이 예산을
// 통째로 먹지 않고, 2026-08-03 실제 규모(공용 7건 1,409자)의 네 배까지는 동작이 전혀 바뀌지
// 않는다.
export const MEMORY_SECTION_BUDGET = 6000;

// 예산을 넘긴 기억을 "자르지" 않고 제목만 남기는 이유: 잘린 기억은 모델에게 존재 자체가 안
// 보인다. 아는 것이 있는데 없는 줄 아는 상태가 되고, 그러면 recall 할 생각도 못 한다. 제목이
// 남으면 "그 주제가 있다"는 것을 알고 가져올 수 있다.
export function renderMemories(
  mems: Memory[],
  names: Record<string, string>,
  opts: { budget?: number } = {},
): string {
  const budget = opts.budget;
  const full: string[] = [];
  const titlesOnly: string[] = [];
  let used = 0;
  for (const m of mems) {
    const line = renderOne(m, names);
    // 첫 건은 예산을 넘겨도 싣는다 — 안 그러면 큰 기억 하나 때문에 섹션 전체가 색인이 된다.
    if (budget === undefined || full.length === 0 || used + line.length <= budget) {
      full.push(line);
      used += line.length;
    } else {
      titlesOnly.push(renderTitleOnly(m, names));
    }
  }
  if (titlesOnly.length === 0) return full.join("\n");
  return [
    ...full,
    "(아래 주제는 제목만 있어요 — 내용이 필요하면 recall 로 물어보세요)",
    ...titlesOnly,
  ].join("\n");
}
