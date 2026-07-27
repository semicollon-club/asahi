import path from "node:path";

// path.win32/path.posix 의 타입. 예전 @types/node 는 이 모양에 PlatformPath 라는 이름을
// 붙여 내보냈지만, 이 리포가 쓰는 버전은 path 네임스페이스를 자기 자신으로 재수출하는
// 형태라 그 이름이 없다(win32/posix 모두 path 자신과 동일 타입). 이름 없이 typeof 로
// 같은 타입을 얻는다 — 런타임 값(경로 판정)은 무관하고 타입 표기만의 문제다.
type PathFlavor = typeof path.win32;

// 이 경로가 어느 플랫폼의 것인지 판정해 그 규칙으로 다루게 한다.
//
// 봇은 Railway(리눅스)에서 돌고 워커는 윈도우일 수 있다. node:path 의 기본 구현은 자기 플랫폼
// 규칙을 쓰므로, 리눅스에서 `C:\ws\my.txt` 를 resolve 하면 역슬래시가 구분자가 아니라 파일명
// 문자로 취급돼 경로 전체가 한 조각이 된다 — 그러면 `C:\ws` 와 `C:\ws\my.txt` 가 서로 형제
// 파일명이 되어 "안에 있다"는 판정이 절대 성립하지 않는다(정상 경로까지 전부 거부된다).
//
// 드라이브 문자(C:\) 또는 UNC(\\서버\공유) 로 시작하면 윈도우, 그 외에는 POSIX 로 본다.
export function pathFlavorOf(p: string): PathFlavor {
  return /^[a-zA-Z]:[\\/]/.test(p) || p.startsWith("\\\\") ? path.win32 : path.posix;
}

// 경로 판정 순수 함수 — fs 접근 없이 문자열만으로 target 이 dir 안(같거나 하위)인지 판정한다.
// 심볼릭 링크 realpath 해석은 이 함수의 범위 밖이다(호출측이 fs 로 처리).
//
// 플레이버는 dir(허용 폴더) 기준으로 고른다 — 판정의 기준점이 그쪽이고, target 은 신뢰할 수 없는
// 입력이라 그 생김새로 규칙을 고르게 하면 공격자가 판정 규칙 자체를 고를 수 있게 된다.
export function isPathWithin(target: string, dir: string): boolean {
  const flavor = pathFlavorOf(dir);
  let d = flavor.resolve(dir);
  let t = flavor.resolve(target);
  // 윈도우 파일시스템은 대소문자를 구분하지 않는다. 판정 대상 경로가 윈도우일 때만 무시한다
  // (예전엔 봇 프로세스의 process.platform 으로 갈랐는데, 그건 워커의 파일시스템과 무관한 값이다).
  if (flavor === path.win32) {
    d = d.toLowerCase();
    t = t.toLowerCase();
  }
  if (d === t) return true;
  const rel = flavor.relative(d, t);
  // rel 이 ".." 로 시작하는지 여부는 정확히 ".."(부모 자신) 이거나 ".."+구분자 로 시작하는 경우만 확인한다.
  // 단순 rel.startsWith("..") 는 "..foobar" 같은(부모 탈출이 아닌) 이름을 오판할 수 있어 제외한다.
  return rel !== ".." && !rel.startsWith(".." + flavor.sep) && !flavor.isAbsolute(rel);
}

export function isPathWithinAny(target: string, dirs: readonly string[]): boolean {
  return dirs.some((dir) => isPathWithin(target, dir));
}

// 저장·비교 일관성을 위해 절대경로로 정규화한다. 여기서도 플레이버를 따른다 — 리눅스 봇이
// `C:\ws` 를 기본 resolve 로 저장하면 `/app/C:\ws` 같은 값이 DB 에 들어간다.
export function normalizeDir(p: string): string {
  return pathFlavorOf(p).resolve(p);
}

// 워커의 루트 경로 아래에 한 단계를 잇는다. 문자열을 "/" 로 잇지 않는 이유는 위와 같다 —
// `C:\ws/111` 처럼 구분자가 섞이면 두 겹의 경로 검사가 서로 다른 판정을 하게 된다.
export function joinUnderRoot(root: string, segment: string): string {
  const flavor = pathFlavorOf(root);
  return `${root.replace(/[\\/]+$/, "")}${flavor.sep}${segment}`;
}
