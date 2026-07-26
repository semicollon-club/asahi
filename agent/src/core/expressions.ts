// 모델이 답변에 섞어 쓰는 표정 마커를 떼어내는 순수 함수.
// 감정→URL 해석·빈도 제한·실제 전송은 어댑터의 몫이다 — 마커는 "표시 지시"이므로
// 코어는 이미지의 존재 자체를 모른다(향후 다른 채널이 같은 마커를 다르게 렌더링할 수 있다).

export type ParsedExpression = { text: string; emotion: string | null };

// [표정:<이름>] — 이름에는 공백이 들어갈 수 있다(기본 무표정, 빤히 응시).
// 콜론이 없는 [표정] 은 매칭되지 않는다(마커가 아니라 일반 텍스트로 본다).
const MARKER = /\[표정:([^\]]*)\]/g;

// 마커를 떼어낸 자리에 남는 공백을 정리한다. 줄바꿈은 의미가 있으므로 보존하되,
// 줄 안의 연속 공백·줄 끝 공백·과도한 빈 줄만 정리한다.
function tidy(s: string): string {
  return s
    .split("\n")
    .map((line) => line.replace(/[ \t]{2,}/g, " ").trimEnd())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function parseExpression(raw: string): ParsedExpression {
  let emotion: string | null = null;
  const stripped = raw.replace(MARKER, (_match, name: string) => {
    const trimmed = name.trim();
    // 첫 번째로 나온 유효한 이름만 채택한다. 나머지 마커도 전부 제거한다 —
    // 하나라도 남으면 사용자에게 그대로 보인다.
    if (emotion === null && trimmed.length > 0) emotion = trimmed;
    return "";
  });
  return { text: tidy(stripped), emotion };
}
