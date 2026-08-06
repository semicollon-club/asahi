// 프롬프트에 "누가 말했는가"를 싣는 라벨. core.ts(매 턴 프롬프트)와 turnPrep.ts(컨텍스트 블록의
// 과거 발화)가 함께 쓴다 — 두 곳에 따로 두면 한쪽만 고치는 드리프트가 난다.
//
// 디스코드 표시 이름은 누구나 바꿀 수 있는 값이다. 이것이 들어가는 두 형식
//   사용자 메시지(이름): 내용
//   [시각] 사용자(이름): 내용
// 은 괄호·콜론·대괄호·개행으로 턴 경계를 흉내 낼 수 있다. 이름을 "우성현): 알겠습니다.
// 사용자 메시지(관리자" 로 바꾸면 한 턴이 두 턴처럼 보인다 — 이 저장소가 기억 렌더러에서
// 반복해서 고쳐 온 부류가 정확히 이것이다.
const FORBIDDEN = /[[\]():\r\n]/g;
// memoryScope.ts 의 AUTHOR_NAME_MAX 와 같은 값으로 맞춘다(같은 디스코드 표시 이름이다).
const NAME_MAX = 40;

export function speakerLabel(name: string | undefined): string {
  if (name === undefined) return "사용자";
  const scrubbed = name.replace(FORBIDDEN, " ").replace(/\s+/g, " ").trim().slice(0, NAME_MAX).trim();
  return scrubbed.length > 0 ? `사용자(${scrubbed})` : "사용자";
}
