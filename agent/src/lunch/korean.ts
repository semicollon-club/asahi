// 받침 유무로 갈리는 한국어 목적격 조사(을/를)를 고른다. 저장소 안에 조사 판정 헬퍼가 이미
// 있는지 찾아봤지만 없었다 — memoryScope.ts:124-125 가 같은 문제(이름 뒤에 붙는 조사)를
// "조사 없는 형태로 바꿔 우회"했을 뿐, 받침을 실제로 판정하는 코드는 이 저장소에 없었다. 이
// 파일이 그 첫 구현이다 — "최근에 음식점을(를) N번 드셨어요" 처럼 값과 무관하게 비문이
// 되는 것을 막는 데 필요한 최소 크기로 짰다(score.ts 의 카테고리 반복 축 reasons 문장).
//
// 유니코드 한글 완성형 음절은 U+AC00("가")부터 U+D7A3("힣")까지 초성·중성·종성 순서로 빠짐없이
// 배열돼 있다. (코드포인트 - 0xAC00) % 28 이 종성(받침) 인덱스이고, 0이면 받침이 없다 — 28은
// 종성 슬롯 수(받침 없음 포함 27개 자음 + 1)다.
const HANGUL_BASE = 0xac00;
const HANGUL_LAST = 0xd7a3;
const JONGSEONG_COUNT = 28;

export function objectParticle(word: string): "을" | "를" {
  const last = word.trim().slice(-1);
  const code = last.codePointAt(0);
  // 한글 완성형 음절이 아니면(공백뿐인 값, 라틴 문자·숫자로 끝나는 값 등) 받침 유무를 판정할
  // 근거가 없다 — 카카오의 세부 카테고리는 실제로는 항상 한글이지만, 방어적으로 받침 없는
  // 쪽(를)을 기본값으로 쓴다. "을"을 잘못 붙이는 쪽보다, 외래어 표기처럼 받침 없이 끝나는
  // 경우에 맞을 확률이 더 높다.
  if (code === undefined || code < HANGUL_BASE || code > HANGUL_LAST) return "를";
  return (code - HANGUL_BASE) % JONGSEONG_COUNT === 0 ? "를" : "을";
}
