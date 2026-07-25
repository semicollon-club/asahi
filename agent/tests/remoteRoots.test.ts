import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { checkPath } from "../src/remote/roots.js";

describe("checkPath — 워커 루트 검사", () => {
  let root: string;
  beforeEach(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "asahi-roots-")));
    fs.mkdirSync(path.join(root, "proj"), { recursive: true });
    fs.writeFileSync(path.join(root, "proj", "a.txt"), "hello");
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it("루트 안의 기존 파일은 허용하고 realpath 를 돌려준다", () => {
    const r = checkPath(path.join(root, "proj", "a.txt"), [root]);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.path).toBe(path.join(root, "proj", "a.txt"));
  });

  it("아직 없는 파일도 조상이 루트 안이면 허용한다(새로 쓸 파일)", () => {
    const r = checkPath(path.join(root, "proj", "new.txt"), [root]);
    expect(r.ok).toBe(true);
  });

  it("루트 밖 경로는 거부한다", () => {
    const r = checkPath(path.join(os.tmpdir(), "elsewhere.txt"), [root]);
    expect(r.ok).toBe(false);
  });

  it("'..' 로 루트를 벗어나면 거부한다", () => {
    const r = checkPath(path.join(root, "proj", "..", "..", "escape.txt"), [root]);
    expect(r.ok).toBe(false);
  });

  it("루트 목록이 비어 있으면 거부한다", () => {
    expect(checkPath(path.join(root, "proj", "a.txt"), []).ok).toBe(false);
  });

  it("여러 루트 중 하나에만 속해도 허용한다", () => {
    const other = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "asahi-roots2-")));
    try {
      expect(checkPath(path.join(root, "proj", "a.txt"), [other, root]).ok).toBe(true);
    } finally {
      fs.rmSync(other, { recursive: true, force: true });
    }
  });

  it('빈 문자열 루트는 거부한다', () => {
    const r = checkPath(path.join(root, "proj", "a.txt"), [""]);
    expect(r.ok).toBe(false);
  });

  it('현재 디렉토리 상대경로 루트는 거부한다', () => {
    const r = checkPath(path.join(root, "proj", "a.txt"), ["."]);
    expect(r.ok).toBe(false);
  });

  it('상대경로 루트는 거부한다', () => {
    const r = checkPath(path.join(root, "proj", "a.txt"), ["some/rel"]);
    expect(r.ok).toBe(false);
  });

  it('절대경로 루트 하나와 상대경로 루트 하나가 섞여 있으면 거부한다', () => {
    const r = checkPath(path.join(root, "proj", "a.txt"), [root, "relative/path"]);
    expect(r.ok).toBe(false);
  });

  it('절대경로 루트만 있으면 허용한다', () => {
    const r = checkPath(path.join(root, "proj", "a.txt"), [root]);
    expect(r.ok).toBe(true);
  });

  it('루트 끝에 구분자가 있어도 허용한다', () => {
    const r = checkPath(path.join(root, "proj", "a.txt"), [root + path.sep]);
    expect(r.ok).toBe(true);
  });

  // 아래는 윈도우 전용 케이스다 — path.isAbsolute 는 "\foo"·"/workspace" 처럼 드라이브 문자 없이
  // 구분자로만 시작하는 경로도 true 를 반환하지만, path.resolve 는 그런 경로에 process.cwd() 의
  // "현재 드라이브"를 채워 넣는다(예: cwd 가 E:\ 면 "/workspace" → "E:\workspace"). POSIX 는 애초에
  // 드라이브 개념이 없어 이 문제 자체가 성립하지 않으므로, 다른 플랫폼에서 실행하면 검증 대상이
  // 아닌 이유로 우연히 통과할 수 있다 — process.platform 으로 명시적으로 걸러 윈도우에서만 돌린다.
  //
  // 단순히 r.ok 만 false 인지 보면 안 된다 — os.tmpdir() 이 cwd 와 다른 드라이브에 있으면, 이 루트를
  // 그냥 "루트 밖 경로"로 잘못 판정해도 우연히 ok:false 가 나와 버그를 놓친다. 그래서 거부 사유가
  // "루트 설정이 잘못됐다"인지(=드라이브 상대경로를 실제로 잡아냈는지) 메시지로 못박아 확인한다.
  it.skipIf(process.platform !== "win32")(
    '드라이브 문자 없이 구분자로만 시작하는 루트는 "루트 설정이 잘못됐다"는 사유로 거부한다(윈도우 드라이브 상대경로)',
    () => {
      const r = checkPath(path.join(root, "proj", "a.txt"), ["\\some\\dir"]);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.message).toContain("워커 루트 설정이 잘못됐어요");
    },
  );

  it.skipIf(process.platform !== "win32")(
    '"/workspace" 처럼 슬래시로 시작하지만 드라이브가 없는 루트는 "루트 설정이 잘못됐다"는 사유로 거부한다',
    () => {
      const r = checkPath(path.join(root, "proj", "a.txt"), ["/workspace"]);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.message).toContain("워커 루트 설정이 잘못됐어요");
    },
  );

  it.skipIf(process.platform !== "win32")(
    '드라이브 문자가 있는 절대경로 루트는 여전히 허용한다',
    () => {
      // 전제 확인: 임시폴더 루트가 실제로 드라이브 문자로 시작하는지(윈도우다운 절대경로인지) 먼저 확인한다.
      expect(/^[a-zA-Z]:[\\/]/.test(root)).toBe(true);
      const r = checkPath(path.join(root, "proj", "a.txt"), [root]);
      expect(r.ok).toBe(true);
    },
  );

  it.skipIf(process.platform !== "win32")(
    'UNC 루트는 절대경로 검사를 통과한다(대상이 그 밖이라 최종 거부되더라도 사유는 "루트 설정이 잘못됐다"가 아니어야 한다)',
    () => {
      const r = checkPath(path.join(root, "proj", "a.txt"), ["\\\\server\\share"]);
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.message).not.toContain("워커 루트 설정이 잘못됐어요");
        expect(r.message).toContain("워커 작업 폴더 밖");
      }
    },
  );

  it.skipIf(process.platform !== "win32")(
    '정상 루트와 드라이브 없는 루트가 섞여 있으면 전체를 거부한다',
    () => {
      const r = checkPath(path.join(root, "proj", "a.txt"), [root, "\\some\\dir"]);
      expect(r.ok).toBe(false);
    },
  );

  it('거부 메시지에 잘못된 루트 항목을 그대로 담는다', () => {
    const r = checkPath(path.join(root, "proj", "a.txt"), ["some/rel"]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toContain("some/rel");
  });
});
