import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { makeExecutors, OUTPUT_MAX } from "../src/remote/executors.js";

describe("워커 실행기", () => {
  let root: string;
  let ex: ReturnType<typeof makeExecutors>;
  beforeEach(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "asahi-ex-")));
    fs.writeFileSync(path.join(root, "a.txt"), "첫줄\n둘째줄\n셋째줄\n");
    fs.mkdirSync(path.join(root, "sub"), { recursive: true });
    fs.writeFileSync(path.join(root, "sub", "b.ts"), "export const x = 1;\n");
    ex = makeExecutors([root]);
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it("도구 8개를 정확히 노출한다", () => {
    // Task 8: fs_mkdir 추가. 모델이 부르는 도구 목록(REMOTE_TOOL_NAMES)에는 안 들어가지만, 워커
    // 실행기 자체는 다른 fs_* 와 나란히 이 객체에 존재한다.
    // Task 4: fs_tree 추가 — 폴더 구조 전용 조회 도구(모델이 부르는 목록에도 들어간다).
    expect(Object.keys(ex).sort()).toEqual(["fs_edit", "fs_glob", "fs_grep", "fs_mkdir", "fs_read", "fs_tree", "fs_write", "sh_exec"]);
  });

  it("fs_read 는 줄번호를 붙여 읽는다", async () => {
    const r = await ex.fs_read({ path: path.join(root, "a.txt") });
    expect(r.ok).toBe(true);
    expect(r.content).toContain("1\t첫줄");
    expect(r.content).toContain("3\t셋째줄");
  });

  it("fs_read 는 offset·limit 를 적용한다", async () => {
    const r = await ex.fs_read({ path: path.join(root, "a.txt"), offset: 2, limit: 1 });
    expect(r.content).toContain("2\t둘째줄");
    expect(r.content).not.toContain("첫줄");
    expect(r.content).not.toContain("셋째줄");
  });

  it("루트 밖은 모든 fs 도구가 거부한다", async () => {
    const outside = path.join(os.tmpdir(), "outside.txt");
    const args = { path: outside, content: "x", oldString: "a", newString: "b", pattern: "*" };
    // Task 4: fs_tree 도 같은 gate(path 인자 검사)를 거치므로 나란히 검증한다.
    for (const tool of ["fs_read", "fs_write", "fs_edit", "fs_glob", "fs_grep", "fs_tree"]) {
      const run = ex[tool];
      const r = await run(args);
      expect(r.ok, `${tool} 이 루트 밖을 허용했다`).toBe(false);
    }
  });

  it("fs_write 는 없는 상위 폴더를 만들고 쓴다", async () => {
    const target = path.join(root, "deep", "c.txt");
    const r = await ex.fs_write({ path: target, content: "내용" });
    expect(r.ok).toBe(true);
    expect(fs.readFileSync(target, "utf8")).toBe("내용");
  });

  it("fs_edit 는 정확히 한 번 등장할 때만 치환한다", async () => {
    const p = path.join(root, "a.txt");
    const ok = await ex.fs_edit({ path: p, oldString: "둘째줄", newString: "바뀐줄" });
    expect(ok.ok).toBe(true);
    expect(fs.readFileSync(p, "utf8")).toContain("바뀐줄");

    const missing = await ex.fs_edit({ path: p, oldString: "없는문자열", newString: "x" });
    expect(missing.ok).toBe(false);
  });

  it("fs_edit 는 여러 번 등장하면 replaceAll 없이는 거부한다", async () => {
    const p = path.join(root, "dup.txt");
    fs.writeFileSync(p, "같음\n같음\n");
    expect((await ex.fs_edit({ path: p, oldString: "같음", newString: "다름" })).ok).toBe(false);
    const all = await ex.fs_edit({ path: p, oldString: "같음", newString: "다름", replaceAll: true });
    expect(all.ok).toBe(true);
    expect(fs.readFileSync(p, "utf8")).toBe("다름\n다름\n");
  });

  it("fs_edit 는 newString 에 담긴 '$&'·'$$' 같은 치환 패턴을 문자 그대로 쓴다(단건 치환)", async () => {
    // String.prototype.replace 는 두 번째 인자가 "문자열"이어도 $&·$$·$`·$'·$<n> 을
    // 특수 치환 패턴으로 해석한다 — replacer 를 함수로 주지 않으면 이 문자들을 리터럴로
    // 쓸 수 없다. Makefile·셸 스크립트·CI 설정처럼 '$'가 흔한 파일을 고칠 때 조용히
    // 다른 내용이 써지는 걸 막기 위한 회귀 테스트.
    const p = path.join(root, "dollar.txt");
    fs.writeFileSync(p, "TARGET\n");
    const r = await ex.fs_edit({ path: p, oldString: "TARGET", newString: "$&-literal-$$" });
    expect(r.ok).toBe(true);
    expect(fs.readFileSync(p, "utf8")).toBe("$&-literal-$$\n");
  });

  it("fs_glob 는 루트 기준 상대 패턴으로 파일을 찾는다", async () => {
    const r = await ex.fs_glob({ pattern: "**/*.ts", path: root });
    expect(r.ok).toBe(true);
    expect(r.content).toContain("b.ts");
    expect(r.content).not.toContain("a.txt");
  });

  it("fs_grep 는 내용에 매칭되는 파일과 줄을 찾는다", async () => {
    const r = await ex.fs_grep({ pattern: "export const", path: root });
    expect(r.ok).toBe(true);
    expect(r.content).toContain("b.ts");
  });

  it("sh_exec 는 명령을 실행하고 출력을 돌려준다", async () => {
    const r = await ex.sh_exec({ command: "echo asahi" });
    expect(r.ok).toBe(true);
    expect(r.content).toContain("asahi");
  });

  it("sh_exec 는 실패 종료코드를 ok=false 로 보고한다", async () => {
    const r = await ex.sh_exec({ command: "exit 3" });
    expect(r.ok).toBe(false);
    expect(r.content).toContain("3");
  });

  it("sh_exec 는 타임아웃되면 ok=false 로 끝난다", async () => {
    // 윈도우에서는 "sleep 5"가 Git 배포판의 실제 sleep.exe 를 자식으로 실행하는데,
    // cmd.exe(직접 자식)를 kill 해도 그 손자 프로세스는 안 죽는다 — 윈도우는 POSIX 셸의
    // "마지막 명령 exec 대체" 최적화나 프로세스 그룹 시그널 전파가 없기 때문이다. 그러면
    // 고아가 된 sleep.exe 가 임시 루트를 cwd 로 붙든 채 남아 afterEach 의 rmSync 가
    // EBUSY 로 실패한다. 여기서 검증할 것은 "타임아웃을 넘기는 명령이 ok:false 를
    // 돌려준다"이지 sleep 자체가 아니므로, 손자 프로세스를 만들지 않는(cmd.exe 내장이라
    // kill 하나로 확실히 죽는) 동등한 명령으로 대체한다.
    const longRunning = process.platform === "win32" ? "for /L %i in (1,1,2000000000) do @rem" : "sleep 5";
    const r = await ex.sh_exec({ command: longRunning, timeoutMs: 200 });
    expect(r.ok).toBe(false);
  }, 10000);

  it("루트가 비면 sh_exec 도 거부한다", async () => {
    const none = makeExecutors([]);
    expect((await none.sh_exec({ command: "echo x" })).ok).toBe(false);
  });

  it("긴 출력은 상한으로 자른다", async () => {
    const p = path.join(root, "big.txt");
    fs.writeFileSync(p, "가".repeat(OUTPUT_MAX * 2));
    const r = await ex.fs_read({ path: p });
    expect(r.content.length).toBeLessThanOrEqual(OUTPUT_MAX + 200);
  });

  // Task 8: 손님의 개인 폴더를 만드는 전용 실행기. 모델이 부르는 도구가 아니라(REMOTE_TOOL_NAMES
  // 밖) 봇이 remoteTools.ts 에서 직접 끼워 넣는다 — 그래서 다른 fs_* 와 동일한 gate(경로 검사)만
  // 검증하면 되고, 별도의 권한·존재 규칙은 없다.
  describe("fs_mkdir", () => {
    it("루트 안에 폴더를 만든다", async () => {
      const target = path.join(root, "111");
      const r = await ex.fs_mkdir({ path: target });
      expect(r.ok).toBe(true);
      expect(fs.existsSync(target)).toBe(true);
    });

    it("이미 있으면 성공으로 취급한다(멱등)", async () => {
      const target = path.join(root, "111");
      await ex.fs_mkdir({ path: target });
      expect((await ex.fs_mkdir({ path: target })).ok).toBe(true);
    });

    it("중간 경로가 없어도 만든다", async () => {
      const target = path.join(root, "a", "b", "c");
      expect((await ex.fs_mkdir({ path: target })).ok).toBe(true);
      expect(fs.existsSync(target)).toBe(true);
    });

    it("루트 밖은 거부한다 — 다른 fs_* 와 같은 관문을 거친다", async () => {
      const r = await ex.fs_mkdir({ path: path.join(root, "..", "탈출") });
      expect(r.ok).toBe(false);
    });

    it("path 가 없으면 거부한다", async () => {
      expect((await ex.fs_mkdir({})).ok).toBe(false);
    });
  });

  // fs_glob·fs_grep 는 glob 패턴 자체에 절대경로나 '..' 를 담아 루트 밖을 가리킬 수 있으므로,
  // tinyglobby 가 돌려준 결과를 checkPath 로 다시 거른다(executors.ts 의 hits.filter / 파일별
  // continue). 기존 "루트 밖은 모든 fs 도구가 거부한다" 테스트는 인자 자체가 루트 밖인 경우만
  // 검사해 이 재검증 로직을 지나지 않으므로, 그 방어 코드를 지워도 기존 스위트는 그대로
  // 초록불이었다 — 실제로 루트 밖에 파일을 만들어 두고 4가지 탈출 경로를 각각 확인한다.
  describe("fs_glob·fs_grep 는 패턴으로 루트 밖을 노출하지 않는다(회귀)", () => {
    const OUTSIDE_MARKER = "바깥전용비밀표식";
    const OUTSIDE_FILE_PREFIX = "zz-asahi-fix2-outside-secret";
    let outsideFile: string;
    // tinyglobby(picomatch 기반)는 '\' 를 글롭 이스케이프 문자로 다뤄서, 윈도우의
    // path.join 이 만든 역슬래시 절대경로를 패턴으로 주면 애초에 아무 것도 매칭하지 않는다
    // (재검증 이전에 이미 무해해짐 — 즉 그 상태로는 이 테스트가 재검증 로직을 지나가지도
    // 않는다). 절대경로 패턴이 실제로 루트 밖에 "닿게" 하려면 슬래시로 바꿔줘야 한다 —
    // fs_glob({ absolute: true }) 가 돌려주는 경로들도 항상 슬래시 형태인 것과 동일한 이유.
    const toGlobPattern = (p: string) => p.split(path.sep).join("/");

    beforeEach(() => {
      // root 와 형제 위치(os.tmpdir() 바로 아래)에 둬야 "../*" 패턴 하나만으로도 이 파일에 닿는다.
      outsideFile = path.join(os.tmpdir(), `${OUTSIDE_FILE_PREFIX}-${process.pid}-${Date.now()}.txt`);
      fs.writeFileSync(outsideFile, `${OUTSIDE_MARKER}\n`);
    });
    afterEach(() => fs.rmSync(outsideFile, { force: true }));

    it("fs_glob 는 루트 밖을 가리키는 절대경로 패턴을 다시 걸러낸다", async () => {
      const r = await ex.fs_glob({ path: root, pattern: toGlobPattern(path.join(os.tmpdir(), `${OUTSIDE_FILE_PREFIX}-*`)) });
      expect(r.ok).toBe(true);
      expect(r.content).not.toContain(OUTSIDE_FILE_PREFIX);
      expect(r.content).toBe("(일치하는 파일 없음)");
    });

    it("fs_glob 는 '../*' 로 루트 상위를 오르는 패턴을 다시 걸러낸다", async () => {
      const r = await ex.fs_glob({ path: root, pattern: "../*" });
      expect(r.ok).toBe(true);
      expect(r.content).not.toContain(OUTSIDE_FILE_PREFIX);
    });

    it("fs_grep 는 glob 인자가 루트 밖 절대경로를 가리켜도 내용을 읽지 않는다", async () => {
      const r = await ex.fs_grep({
        path: root,
        pattern: OUTSIDE_MARKER,
        glob: toGlobPattern(path.join(os.tmpdir(), `${OUTSIDE_FILE_PREFIX}-*`)),
      });
      expect(r.ok).toBe(true);
      expect(r.content).not.toContain(OUTSIDE_MARKER);
      expect(r.content).not.toContain(OUTSIDE_FILE_PREFIX);
      expect(r.content).toBe("(일치하는 내용 없음)");
    });

    it("fs_grep 는 glob 인자가 '..' 로 루트 상위를 올라도 내용을 읽지 않는다", async () => {
      const r = await ex.fs_grep({ path: root, pattern: OUTSIDE_MARKER, glob: `../${OUTSIDE_FILE_PREFIX}-*` });
      expect(r.ok).toBe(true);
      expect(r.content).not.toContain(OUTSIDE_MARKER);
      expect(r.content).not.toContain(OUTSIDE_FILE_PREFIX);
    });
  });
});

describe("fs_tree 실행기", () => {
  it("루트 아래 구조를 돌려준다", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "asahi-tree-"));
    fs.mkdirSync(path.join(root, "src"));
    fs.writeFileSync(path.join(root, "src", "a.ts"), "x");
    fs.mkdirSync(path.join(root, "node_modules"));
    fs.writeFileSync(path.join(root, "node_modules", "junk.js"), "x");

    const ex = makeExecutors([root]);
    const r = await ex.fs_tree!({ path: root });
    expect(r.ok).toBe(true);
    expect(r.content).toContain("a.ts");
    expect(r.content).not.toContain("junk.js"); // node_modules 제외
  });

  it("심볼릭 링크를 따라가지 않는다(워크스페이스 밖 열거 방지)", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "asahi-tree-root-"));
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "asahi-tree-outside-"));
    fs.writeFileSync(path.join(outside, "secret.txt"), "x");
    try {
      fs.symlinkSync(outside, path.join(root, "escape"), "junction");
    } catch {
      return; // 링크를 만들 권한이 없는 환경에서는 건너뛴다
    }
    const ex = makeExecutors([root]);
    const r = await ex.fs_tree!({ path: root });
    expect(r.content).not.toContain("secret.txt");
  });

  it("roots 밖 경로는 거부한다", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "asahi-tree-gate-"));
    const other = fs.mkdtempSync(path.join(os.tmpdir(), "asahi-tree-other-"));
    const ex = makeExecutors([root]);
    const r = await ex.fs_tree!({ path: other });
    expect(r.ok).toBe(false);
  });
});
