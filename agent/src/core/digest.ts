// 정기 뉴스 게시. 실행 판정은 순수 함수로 떼어내 시각·기록만으로 결정하고,
// 실제 실행(DigestRunner)은 같은 파일 아래쪽에 둔다.

export type DigestTopic = "contest" | "devnews";

// KST 기준 게시 시각. 환경변수로 빼지 않는다 — 잘못 설정하면 조용히 안 도는 것보다
// 상수 한 줄을 고치고 재배포하는 편이 낫다.
export const DIGEST_HOUR_KST = 7;

// KST 는 UTC+9 고정이고 서머타임이 없다. 라이브러리 없이 산술로 정확하다.
const KST_OFFSET_MS = 9 * 60 * 60 * 1000;

export const DIGEST_TOPICS: Record<DigestTopic, { label: string; prompt: string }> = {
  contest: {
    label: "대회",
    prompt: `웹 검색으로 지금 참가 신청을 받고 있거나 곧 열리는 코딩 대회·CTF(해킹) 대회를 3~5개 찾아 정리해줘.
각 항목마다 대회 이름, 일정, 참가 대상, 출처 링크를 적어. 날짜가 이미 지난 대회는 빼.
찾지 못했으면 억지로 채우지 말고 못 찾았다고 해.`,
  },
  devnews: {
    label: "개발 뉴스",
    prompt: `웹 검색으로 최근 개발자에게 의미 있는 소식을 3~5개 찾아 정리해줘.
프레임워크·언어·개발 도구의 주요 릴리스나 화제가 된 이슈 위주로. 각 항목마다 무엇이 바뀌었고
왜 중요한지 한두 줄로 설명하고 출처 링크를 붙여. 찾지 못했으면 억지로 채우지 말고 못 찾았다고 해.`,
  },
};

// 그 시각의 KST 날짜를 "YYYY-MM-DD" 로. UTC 로 9시간 민 뒤 UTC 필드를 읽으면 그게 KST 다.
export function kstDateString(nowUtcMs: number): string {
  return new Date(nowUtcMs + KST_OFFSET_MS).toISOString().slice(0, 10);
}

// 지금 게시를 실행해야 하는가. "정각에 쏘기"가 아니라 "지났는데 오늘 아직 안 했으면 한다" —
// 재배포나 일시 장애로 정각을 놓쳐도 그날 안에 올라간다.
export function shouldRunDigest(
  nowUtcMs: number,
  lastRunDate: string | null,
  hourKst: number = DIGEST_HOUR_KST,
): boolean {
  const kst = new Date(nowUtcMs + KST_OFFSET_MS);
  if (kst.getUTCHours() < hourKst) return false;
  return lastRunDate !== kstDateString(nowUtcMs);
}
