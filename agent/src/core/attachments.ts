// 디스코드 첨부 중 "워커 디스크에 내려놓을" 파일을 다룬다. images.ts 와 나눠 둔 이유는 목적지가
// 다르기 때문이다 — 이미지는 모델에 멀티모달 입력으로 직접 실리고, 여기 파일은 미니PC 에
// 저장돼 fs_*·sh_exec 가 다루는 대상이 된다. 한 파일에 섞으면 두 상한이 같은 것처럼 읽힌다.
type RawAttachment = { url: string; contentType: string | null; name: string; size: number };

export type FileRef = { url: string; name: string; size: number };

// 8MB 인 이유(스펙 §4.2): 이 값은 내려받기 방향의 디스코드 첨부 한도와 짝을 맞춘 것이다. 그
// 한도는 서버 부스트 등급·시기에 따라 달라져 왔고 8MB 는 모든 등급에서 확실히 통과한다.
// 올리기만 놓고 보면 더 커도 되지만, 두 방향의 상한이 다르면 "올라갔는데 못 돌려받는" 파일이
// 생긴다.
export const FILE_LIMITS = Object.freeze({ maxCount: 3, maxBytes: 8 * 1024 * 1024 } as const);

// 디스코드가 첨부를 서빙하는 호스트. URL 파싱 후 hostname 전체와 비교한다 — 문자열 포함으로
// 검사하면 cdn.discordapp.com.evil.test 가 통과한다.
const CDN_HOSTS = Object.freeze(["cdn.discordapp.com", "media.discordapp.net"] as const);

export function isDiscordCdnUrl(url: string): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  // https 로 고정한다 — 평문으로 받아오면 첨부 내용이 그대로 노출된다.
  return u.protocol === "https:" && (CDN_HOSTS as readonly string[]).includes(u.hostname);
}

// 널 문자를 이스케이프 리터럴로 소스에 직접 박지 않고 함수로 만든다 — 제어 문자가 소스
// 파일에 그대로 들어가면 편집기·diff·린터마다 다르게 다뤄 눈에 안 보이는 손상이 생기기 쉽다.
const NUL = String.fromCharCode(0);

// 저장 위치는 봇이 정한다. 이름에 경로 구분자나 상위 이동이 있으면 그 결정을 우회하므로,
// 고쳐서 쓰지 않고 아예 거절한다 — 고치면 "무엇으로 고쳐졌는지"를 사람도 모델도 모른다.
export function safeFileName(name: string): string | null {
  const n = name.trim();
  if (n.length === 0) return null;
  if (n.includes(NUL)) return null; // 경로 문자열을 중간에서 끊는 고전적 수법
  if (n.includes("/") || n.includes("\\")) return null;
  if (n === "." || n === "..") return null;
  return n;
}

export function filterFileAttachments(
  atts: RawAttachment[],
  limits: { maxCount: number; maxBytes: number } = FILE_LIMITS,
): { files: FileRef[]; skipped: string[] } {
  const files: FileRef[] = [];
  const skipped: string[] = [];
  for (const a of atts) {
    const mt = (a.contentType ?? "").split(";")[0].trim().toLowerCase();
    if (mt.startsWith("image/")) continue; // images.ts 가 가져간다 — 두 번 처리하지 않는다
    const name = safeFileName(a.name);
    if (name === null) { skipped.push(`${a.name}(이름을 쓸 수 없음)`); continue; }
    if (a.size > limits.maxBytes) { skipped.push(`${name}(너무 큼)`); continue; }
    if (files.length >= limits.maxCount) { skipped.push(`${name}(개수 초과)`); continue; }
    files.push({ url: a.url, name, size: a.size });
  }
  return { files, skipped };
}

// 첨부를 어디에 저장할지. 이 판정을 봇이 하는 것이 중요하다 — 모델이 정하면 폴더 격리를
// 우회할 수 있다.
//
// 손님은 workspaceDirs(이미 scopeDirs 로 그 사람 몫으로 좁혀진 값)의 첫 폴더다. 소유자는
// core.ts 의 resolveGuestWorkspaceDirs 가 undefined 를 돌려준다 — scopeDirs 가 소유자를 좁히지
// 않아 "그 사람의 폴더" 하나로 특정되지 않기 때문이다. 그래서 소유자는 워커 루트를 쓴다.
export function uploadDirFor(o: { workspaceDirs?: string[]; workerRoots: string[] }): string | null {
  return o.workspaceDirs?.[0] ?? o.workerRoots[0] ?? null;
}

// 모델에게 "무엇이 어디에 저장됐는지"를 알린다. buildImageMarker(images.ts)와 같은 자리·같은
// 방식이다. 경로가 들어가는 것이 핵심이다 — 경로가 없으면 모델이 fs_read 로 열 방법을 모른다.
//
// 실패도 함께 싣는다. 조용히 버리는 것이 이 기능이 고치려는 문제이므로(이미지가 아닌 첨부를
// 무시하던 종전 동작), 같은 침묵을 다른 자리에 다시 만들지 않는다.
export function buildFileMarker(text: string, saved: string[], failed: string[]): string {
  const parts: string[] = [];
  if (saved.length > 0) parts.push(`[파일 ${saved.length}개 저장됨: ${saved.join(", ")}]`);
  if (failed.length > 0) parts.push(`[파일 처리 실패: ${failed.join(", ")}]`);
  if (parts.length === 0) return text;
  const marker = parts.join(" ");
  return text.trim() ? `${marker} ${text}` : marker;
}
