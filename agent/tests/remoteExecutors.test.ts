import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { makeExecutors, OUTPUT_MAX, buildPm2CommandLine } from "../src/remote/executors.js";
import { TREE_MAX_ENTRIES } from "../src/remote/tree.js";

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

  it("도구 12개를 정확히 노출한다", () => {
    // Task 8: fs_mkdir 추가. 모델이 부르는 도구 목록(REMOTE_TOOL_NAMES)에는 안 들어가지만, 워커
    // 실행기 자체는 다른 fs_* 와 나란히 이 객체에 존재한다.
    // Task 4: fs_tree 추가 — 폴더 구조 전용 조회 도구(모델이 부르는 목록에도 들어간다).
    // M2 Task 2: proc_start·proc_stop·proc_list·proc_logs 추가 — 장기 실행 프로세스를 PM2 에
    // 위임하는 실행기 넷(모델이 부르는 도구 목록에도 들어간다).
    expect(Object.keys(ex).sort()).toEqual([
      "fs_edit", "fs_glob", "fs_grep", "fs_mkdir", "fs_read", "fs_tree", "fs_write",
      "proc_list", "proc_logs", "proc_start", "proc_stop", "sh_exec",
    ]);
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

  // 리뷰 지적(Important 1): depth 상한 때문에 순회를 멈출 때 truncated 플래그를 세우지 않아,
  // 잘린 트리가 안내 없이 그냥 끝나고 부원은 그게 전부인 줄 알았다. 아래 세 테스트가 그 구멍과
  // "빈 폴더를 거짓으로 잘렸다고 하지 않는다"는 방지 조건을 함께 고정한다.
  it("depth 상한을 넘는 트리는 상한까지만 보여주고, depth 때문에 잘렸다고 안내한다", async () => {
    // 주의: 임시폴더 접두사에 "depth" 를 쓰지 않는다 — 아래 toMatch(/depth/) 를 썼다가 루트
    // 경로 자체(head 에 그대로 노출됨)에 우연히 걸려 버그가 있어도 통과하는 거짓양성을 겪었다.
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "asahi-tree-cutoff-"));
    // a(0)/b(1)/c(2) — depth:1 로 부르면 b 까지만 보이고, c 는 안 보이는 대신 잘렸다는 안내가 나가야 한다.
    const deep = path.join(root, "a", "b", "c");
    fs.mkdirSync(deep, { recursive: true });
    fs.writeFileSync(path.join(deep, "leaf.txt"), "x");

    const ex = makeExecutors([root]);
    const r = await ex.fs_tree!({ path: root, depth: 1 });
    expect(r.ok).toBe(true);
    expect(r.content).toContain("a/");
    expect(r.content).toContain("b/");
    expect(r.content).not.toContain("c/");
    expect(r.content).not.toContain("leaf.txt");
    // 왜 잘렸는지(깊이 때문)가 구분돼야 depth 를 올릴지 하위 폴더를 지정할지 판단할 수 있다.
    // 안내 문구 고유 표현("못 내려갔")으로 확인한다 — 그냥 "depth" 만 찾으면 위 주의사항과 같은
    // 거짓양성에 다시 노출된다.
    expect(r.content).toContain("못 내려갔");
  });

  it("마지막 depth 의 폴더가 비어 있으면 잘렸다고 하지 않는다(거짓 안내 방지)", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "asahi-tree-cutoff-empty-"));
    const emptyLeaf = path.join(root, "a", "b");
    fs.mkdirSync(emptyLeaf, { recursive: true }); // b 는 비어 있다 — 더 보여줄 게 없다.

    const ex = makeExecutors([root]);
    const r = await ex.fs_tree!({ path: root, depth: 1 });
    expect(r.ok).toBe(true);
    expect(r.content).toContain("a/");
    expect(r.content).toContain("b/");
    expect(r.content).not.toContain("잘랐");
    expect(r.content).not.toContain("잘렸");
  });

  it("항목 수 상한을 넘는 트리는 잘렸다고 안내한다", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "asahi-tree-entries-"));
    for (let i = 0; i < TREE_MAX_ENTRIES + 5; i++) {
      fs.writeFileSync(path.join(root, `f${i}.txt`), "");
    }

    const ex = makeExecutors([root]);
    const r = await ex.fs_tree!({ path: root });
    expect(r.ok).toBe(true);
    expect(r.content).toContain("항목이 많아");
  });

  // 리뷰 지적(Minor 1): roots.ts 의 경로 판정은 대상이 없어도(가장 가까운 상위로 올라가) 통과한다
  // — 오타 난 경로·지워진 폴더가 readdir 실패 → 조용히 건너뜀 → renderTree([]) 를 거쳐 "비어
  // 있어요"로 나왔다. 형제 도구 fs_read 처럼 최상위 실패는 오류로 드러내야 한다.
  it("최상위 경로가 없으면 오류로 드러낸다(비어 있다고 속이지 않는다)", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "asahi-tree-missing-"));
    const ex = makeExecutors([root]);
    const r = await ex.fs_tree!({ path: path.join(root, "no-such-dir") });
    expect(r.ok).toBe(false);
    expect(r.content).toContain("읽지 못했어요");
  });

  // 회귀 재현(1차 수정이 만든 버그): depth 상한과 항목 수 상한을 하나의 truncated 플래그로 같이
  // 썼다. depth 상한은 가지별(local) 조건인데 전역 플래그로 세우는 바람에, walk 맨 위의
  // `if (truncated) return` 이 그 뒤에 오는 모든 형제의 하위 순회까지 막아버렸다 — 알파벳상 뒤에
  // 오는 형제는 이름만 보이고, depth 상한 안쪽(정상 범위)의 내용까지 통째로 사라졌다. 기존
  // 단선(a/b/c) 구조 테스트는 형제가 없어 이 문제를 못 잡는다 — 형제가 있는 구조로 직접 재현한다.
  it("한 가지가 depth 를 넘겨도 다른 형제의 정상 범위 내용은 전부 나온다(깊이 상한은 가지별로만 멈춘다)", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "asahi-tree-siblings-"));
    // A 가지: A/A1/leaf.txt — depth:1 로 부르면 leaf.txt(depth2)는 상한을 넘는다.
    fs.mkdirSync(path.join(root, "A", "A1"), { recursive: true });
    fs.writeFileSync(path.join(root, "A", "A1", "leaf.txt"), "x");
    // B 가지: B/B1.txt — depth1 로 정상 범위 안이다. 알파벳상 A 다음이라, A 의 depth 잘림이
    // truncated 를 전역으로 세우면 B 의 하위 순회가 시작조차 못 하는 게 바로 이 회귀였다.
    fs.mkdirSync(path.join(root, "B"), { recursive: true });
    fs.writeFileSync(path.join(root, "B", "B1.txt"), "x");

    const ex = makeExecutors([root]);
    const r = await ex.fs_tree!({ path: root, depth: 1 });
    expect(r.ok).toBe(true);
    expect(r.content).toContain("A/");
    expect(r.content).toContain("B/");
    // 회귀의 핵심 증상: B1.txt 는 depth 1 안(정상 범위)인데도 예전 코드는 A 의 depth 잘림 때문에
    // B 의 하위 순회를 아예 건너뛰어 이걸 지웠다.
    expect(r.content).toContain("B1.txt");
    expect(r.content).not.toContain("leaf.txt"); // A/A1/leaf.txt 는 depth2 로, 정상적으로 잘려야 한다
  });

  // depth 상한과 항목 수 상한이 같은 호출에서 동시에 걸리는 경우 — 안내 문구는 실제로 일어난
  // 것만 말해야 한다. 하나만 골라 보여주면 나머지 하나는 조용히 잘린 것과 같아진다.
  it("depth 상한과 항목 수 상한이 둘 다 걸리면 안내 문구가 둘 다 드러낸다(거짓 안내 방지)", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "asahi-tree-both-"));
    // "0_deep" 가지 — 이름이 숫자로 시작해 아래 f### 파일들보다 항상 먼저 정렬·처리된다.
    // 0_deep/0_deep2/leaf.txt 는 depth:1 호출에서 depth2 로 상한을 넘는다.
    fs.mkdirSync(path.join(root, "0_deep", "0_deep2"), { recursive: true });
    fs.writeFileSync(path.join(root, "0_deep", "0_deep2", "leaf.txt"), "x");
    // 0_deep·0_deep2 두 항목이 먼저 entries 를 채우므로, 남는 자리는 TREE_MAX_ENTRIES-2 뿐이다.
    // zero-pad 로 이름을 맞춰 정렬 순서 = 생성 순서로 고정한다 — f000.txt 부터 채워지고
    // f498.txt·f499.txt 는 항목 수 상한에 밀려 못 들어간다(결정론적으로 검증하기 위함).
    for (let i = 0; i < TREE_MAX_ENTRIES; i++) {
      fs.writeFileSync(path.join(root, `f${String(i).padStart(3, "0")}.txt`), "");
    }

    const ex = makeExecutors([root]);
    const r = await ex.fs_tree!({ path: root, depth: 1 });
    expect(r.ok).toBe(true);
    // depth 사실: leaf.txt(depth2)는 정상적으로 안 보인다.
    expect(r.content).not.toContain("leaf.txt");
    // entries 사실: 먼저 채워진 f000.txt 는 보이고, 상한에 밀린 f499.txt 는 안 보인다.
    expect(r.content).toContain("f000.txt");
    expect(r.content).not.toContain("f499.txt");
    // 안내 문구는 두 사실을 모두 드러내야 한다.
    expect(r.content).toContain("depth");
    expect(r.content).toContain("항목");
  });

  // 리뷰 지적(Minor) — depth 가 음수면 tools.ts 의 zod 스키마가 하한을 안 둬 그대로 실행기까지
  // 온다. 예전 코드는 최상위(depth0)에서 바로 depth 초과로 판정해 entries 를 하나도 못 채우고,
  // renderTree 가 "entries 가 비었는지"를 truncated 검사보다 먼저 봐서 내용이 있는 폴더를 "비어
  // 있어요"로 속였다. 스키마만 믿지 않고 실행기에서도 0 미만으로 못 내려가게 막아야 한다.
  it("depth 가 음수여도 최상위 내용을 정상적으로 보여준다(비어 있다고 속이지 않는다)", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "asahi-tree-negdepth-"));
    fs.writeFileSync(path.join(root, "a.txt"), "x");

    const ex = makeExecutors([root]);
    const r = await ex.fs_tree!({ path: root, depth: -1 });
    expect(r.ok).toBe(true);
    expect(r.content).toContain("a.txt");
    expect(r.content).not.toContain("비어");
  });
});

describe("proc_* 실행기 — PM2 위임", () => {
  type Call = string[];
  type Pm2Reply = { ok: boolean; stdout: string; stderr?: string };
  // 리뷰 지적(Minor, Finding 5): proc_start 가 시작 뒤 상태를 재조회하면서, 같은 키("jlist")를
  // 한 호출 안에서 두 번(사전 중복 확인 + 사후 상태 확인) 부르게 됐다 — 두 번의 의미가 다르므로
  // (전: 아직 없어야 정상, 후: 이제 있어야 정상) 같은 키에 서로 다른 답을 줄 수 있어야 한다.
  // replies[key] 에 배열을 주면 호출 순서대로 소비하고(마지막 값은 그 뒤로도 반복), 기존처럼
  // 객체 하나만 주면 예전과 동일하게 매 호출 같은 답을 준다 — 기존 테스트는 고칠 필요가 없다.
  const fakePm2 = (replies: Record<string, Pm2Reply | Pm2Reply[]>) => {
    const calls: Call[] = [];
    const seen: Record<string, number> = {};
    const runPm2 = async (args: string[]) => {
      calls.push(args);
      const key = args[0]!;
      const entry = replies[key];
      let r: Pm2Reply;
      if (Array.isArray(entry)) {
        const idx = seen[key] ?? 0;
        seen[key] = idx + 1;
        r = entry[idx] ?? entry[entry.length - 1] ?? { ok: true, stdout: "" };
      } else {
        r = entry ?? { ok: true, stdout: "" };
      }
      return { ok: r.ok, stdout: r.stdout, stderr: r.stderr ?? "" };
    };
    return { calls, runPm2 };
  };
  // Finding 5: proc_start 가 시작 뒤 재조회할 때 "정상적으로 떴다"고 볼 jlist 응답을 만든다.
  const onlineJlist = (name: string, over: Record<string, unknown> = {}) =>
    JSON.stringify([{ name, pm2_env: { status: "online", pm_uptime: Date.now(), restart_time: 0, args: [], pm_exec_path: "node", ...over }, monit: { memory: 1 } }]);

  it("proc_start 는 주입된 이름과 cwd 로 pm2 start 를 부른다", async () => {
    // 첫 jlist(사전 중복 확인)는 비어 있고, start 이후 재조회(Finding 5)는 online 을 돌려준다 —
    // 실제 성공 경로를 그대로 흉내낸다.
    const { calls, runPm2 } = fakePm2({ jlist: [{ ok: true, stdout: "[]" }, { ok: true, stdout: onlineJlist("asahi-111") }] });
    const ex = makeExecutors(["C:\\ws"], { runPm2 });
    const r = await ex.proc_start!({ command: "npm run dev", name: "asahi-111", cwd: "C:\\ws\\111" });
    expect(r.ok).toBe(true);
    const start = calls.find((c) => c[0] === "start")!;
    expect(start).toContain("--name");
    expect(start).toContain("asahi-111");
    expect(start).toContain("--cwd");
    expect(start).toContain("C:\\ws\\111");
    expect(start.join(" ")).toContain("npm run dev");
  });

  it("proc_start 는 같은 이름이 이미 있으면 pm2 를 부르지 않고 거절한다(조용한 교체 금지)", async () => {
    const existing = JSON.stringify([{ name: "asahi-111", pm2_env: { status: "online", pm_uptime: 0, restart_time: 0, args: ["run", "dev"], pm_exec_path: "npm" }, monit: { memory: 1 } }]);
    const { calls, runPm2 } = fakePm2({ jlist: { ok: true, stdout: existing } });
    const ex = makeExecutors(["C:\\ws"], { runPm2 });
    const r = await ex.proc_start!({ command: "npm run dev", name: "asahi-111", cwd: "C:\\ws\\111" });
    expect(r.ok).toBe(false);
    expect(r.content).toContain("이미");
    expect(calls.some((c) => c[0] === "start")).toBe(false);
  });

  // 리뷰 지적(Minor): 위 중복 거절 메시지는 dup.command 를 그대로 보여준다 — proc_start 가 실제로
  // 만드는 셸 래퍼 모양(cmd.exe/sh 를 스크립트 자리에 넣는다, 위 commandOf 관련 테스트 참고)으로
  // 이미 떠 있는 프로세스를 시뮬레이션해, 이 메시지에도 셸 껍데기가 새지 않는지 확인한다.
  it("이름 충돌 거절 메시지는 실제 proc_start 모양(셸 래퍼)에서도 셸 껍데기 없이 명령만 보여준다", async () => {
    const existing = JSON.stringify([{ name: "asahi-111", pm2_env: { status: "online", pm_uptime: 0, restart_time: 0, args: ["/c", "npm run dev"], pm_exec_path: "C:\\Windows\\System32\\cmd.exe" }, monit: { memory: 1 } }]);
    const { runPm2 } = fakePm2({ jlist: { ok: true, stdout: existing } });
    const ex = makeExecutors(["C:\\ws"], { runPm2 });
    const r = await ex.proc_start!({ command: "npm run dev", name: "asahi-111", cwd: "C:\\ws\\111" });
    expect(r.ok).toBe(false);
    expect(r.content).toContain("npm run dev");
    expect(r.content).not.toContain("cmd.exe");
    expect(r.content).not.toContain("/c");
  });

  it("proc_start 성공 응답은 멈추는 법을 그 자리에서 알려준다", async () => {
    const { runPm2 } = fakePm2({ jlist: [{ ok: true, stdout: "[]" }, { ok: true, stdout: onlineJlist("asahi-111") }] });
    const ex = makeExecutors(["C:\\ws"], { runPm2 });
    const r = await ex.proc_start!({ command: "npm run dev", name: "asahi-111", cwd: "C:\\ws\\111" });
    expect(r.content).toContain("멈추");
  });

  // 리뷰 지적(Minor, Finding 5): pm2 의 기본 autorestart 때문에, pm2 start 호출 자체는 성공해도
  // (pm2 가 프로세스 "등록"에 성공했다는 뜻일 뿐) 명령이 오타 등으로 즉시 죽으면 재시작을
  // 반복한다("errored"↔재시작을 오간다). start 호출의 ok:true 만 보고 "띄웠어요"라고 먼저
  // 알리면 이런 크래시 루프도 성공으로 들린다 — 시작 직후 jlist 를 다시 조회해 실제 상태가
  // online 이 아니면 성공을 주장하지 않는다.
  it("proc_start 는 시작 직후 재조회에서 online 이 아니면(크래시 루프 등) 성공을 주장하지 않는다", async () => {
    const crashLooping = onlineJlist("asahi-111", { status: "errored", restart_time: 3 });
    const { runPm2 } = fakePm2({ jlist: [{ ok: true, stdout: "[]" }, { ok: true, stdout: crashLooping }] });
    const ex = makeExecutors(["C:\\ws"], { runPm2 });
    const r = await ex.proc_start!({ command: "오타난명령", name: "asahi-111", cwd: "C:\\ws\\111" });
    expect(r.ok).toBe(false);
    expect(r.content).toContain("errored");
  });

  it("proc_start 는 시작 직후 재조회 자체가 실패해도(연결 끊김 등) 성공을 주장하지 않는다", async () => {
    const { runPm2 } = fakePm2({ jlist: [{ ok: true, stdout: "[]" }, { ok: false, stdout: "", stderr: "연결 끊김" }] });
    const ex = makeExecutors(["C:\\ws"], { runPm2 });
    const r = await ex.proc_start!({ command: "npm run dev", name: "asahi-111", cwd: "C:\\ws\\111" });
    expect(r.ok).toBe(false);
  });

  // 리뷰 지적(Minor 3): name·cwd 누락 거절은 프로세스 소유권·1인 1개 상한의 전제 조건인데
  // 전용 테스트가 없었다. name·cwd 는 봇이 주입하므로(remoteTools.ts, 이후 태스크) 누락은 배선이
  // 깨졌다는 뜻이고, 그럴 때는 pm2 를 아예 부르지 않아야 한다 — jlist 조회조차 없는지까지
  // 확인해야 "아무 것도 시작하지 않는다"는 보장이 선다.
  it("proc_start 는 name·cwd 가 없으면 pm2 를 전혀 부르지 않고 거절한다(배선 오류 방어)", async () => {
    const { calls, runPm2 } = fakePm2({ jlist: { ok: true, stdout: "[]" } });
    const ex = makeExecutors(["C:\\ws"], { runPm2 });
    expect((await ex.proc_start!({ command: "npm run dev", cwd: "C:\\ws\\111" })).ok).toBe(false); // name 없음
    expect((await ex.proc_start!({ command: "npm run dev", name: "asahi-111" })).ok).toBe(false); // cwd 없음
    expect((await ex.proc_start!({ command: "npm run dev" })).ok).toBe(false); // 둘 다 없음
    expect(calls).toEqual([]); // jlist 조회조차 없다 — 이름 없이는 아무 것도 시작하지 않는다
  });

  // 리뷰 지적(Minor 2): shellFor() 는 "워커 루트로 셸을 정한다(호스트 플랫폼이 아니라)"는 규칙을
  // 구현하지만 직접 단정하는 테스트가 없었다 — 기존 9개는 전부 윈도우 루트("C:\\ws")만 써서
  // sh.bin·sh.flag 를 하드코딩해도 통과했을 것이다. 두 플레이버를 각각 확인한다.
  it("proc_start 는 POSIX 루트에서 sh·-c 로 pm2 를 부른다(호스트 플랫폼이 아니라 워커 루트 기준)", async () => {
    const { calls, runPm2 } = fakePm2({ jlist: { ok: true, stdout: "[]" } });
    const ex = makeExecutors(["/w"], { runPm2 });
    await ex.proc_start!({ command: "npm run dev", name: "asahi-111", cwd: "/w/111" });
    const start = calls.find((c) => c[0] === "start")!;
    expect(start).toContain("sh");
    expect(start).toContain("-c");
    expect(start).not.toContain("cmd.exe");
    expect(start).not.toContain("/c");
  });

  it("proc_start 는 윈도우 루트에서 cmd.exe·/c 로 pm2 를 부른다", async () => {
    const { calls, runPm2 } = fakePm2({ jlist: { ok: true, stdout: "[]" } });
    const ex = makeExecutors(["C:\\ws"], { runPm2 });
    await ex.proc_start!({ command: "npm run dev", name: "asahi-111", cwd: "C:\\ws\\111" });
    const start = calls.find((c) => c[0] === "start")!;
    expect(start).toContain("cmd.exe");
    expect(start).toContain("/c");
    expect(start).not.toContain("sh");
    expect(start).not.toContain("-c");
  });

  it("proc_stop 은 pm2 delete 를 부른다", async () => {
    const { calls, runPm2 } = fakePm2({ delete: { ok: true, stdout: "" } });
    const ex = makeExecutors(["C:\\ws"], { runPm2 });
    const r = await ex.proc_stop!({ name: "asahi-111" });
    expect(r.ok).toBe(true);
    expect(calls).toContainEqual(["delete", "asahi-111"]);
  });

  it("proc_stop 은 없는 이름이면 실패로 돌려준다", async () => {
    const { runPm2 } = fakePm2({ delete: { ok: false, stdout: "", stderr: "Process not found" } });
    const ex = makeExecutors(["C:\\ws"], { runPm2 });
    const r = await ex.proc_stop!({ name: "asahi-111" });
    expect(r.ok).toBe(false);
  });

  // 리뷰 지적(Important, 병합 차단): proc_list 는 소유자에게 필터를 걸지 않으므로 asahi-assistant·
  // asahi-worker(봇·워커 자신, deploy/ecosystem.config.cjs)도 평범한 회원 행처럼 보인다.
  // remoteTools.ts 는 소유자가 지정한 이름을 검증 없이 그대로 pm2 delete 로 넘기므로(260행 부근),
  // "돌고 있는 거 다 정리해줘" 같은 지시가 모델을 거쳐 워커 자체를 지울 수 있었다 — pm2 delete 는
  // 완전히 제거하므로 autorestart 로도 못 돌아온다. parseProcName 이 이미 회원 이름과 인프라
  // 이름을 구분하므로(asahi-<숫자> 만 회원), 그 판정을 실행기 자신이 pm2 를 부르기 "전"에 강제한다.
  it("proc_stop 은 asahi-<숫자> 형식이 아닌 이름(봇·워커 자신)을 pm2 를 부르지 않고 거절한다", async () => {
    for (const infraName of ["asahi-worker", "asahi-assistant", "something-else"]) {
      const { calls, runPm2 } = fakePm2({ delete: { ok: true, stdout: "" } });
      const ex = makeExecutors(["C:\\ws"], { runPm2 });
      const r = await ex.proc_stop!({ name: infraName });
      expect(r.ok, `${infraName} 을 멈출 수 있었다`).toBe(false);
      expect(r.content).toContain("회원");
      expect(calls.some((c) => c[0] === "delete"), `${infraName} 에 pm2 delete 가 호출됐다`).toBe(false);
    }
  });

  it("proc_list 는 jlist 를 파싱해 표로 돌려준다", async () => {
    const stdout = JSON.stringify([{ name: "asahi-111", pm2_env: { status: "online", pm_uptime: 0, restart_time: 2, args: ["run", "dev"], pm_exec_path: "npm" }, monit: { memory: 5 * 1024 * 1024 } }]);
    const { runPm2 } = fakePm2({ jlist: { ok: true, stdout } });
    const ex = makeExecutors(["C:\\ws"], { runPm2 });
    const r = await ex.proc_list!({});
    expect(r.ok).toBe(true);
    expect(r.content).toContain("asahi-111");
    expect(r.content).toContain("재시작 2");
  });

  // 리뷰 지적(Important, 병합 차단): proc_list 의 onlyUserId 필터는 손님이 남의 프로세스를 못
  // 보게 막는 유일한 격리 장치인데, 기존 테스트는 전부 ex.proc_list({}) 만 불러 only 가 항상
  // undefined 였다 — .filter(...) 분기 자체가 스위트 어디서도 실행되지 않았다. 여기서는 3개짜리
  // jlist(회원 둘 + 워커 자신)에 onlyUserId 를 실제로 넘겨, 지정한 회원의 것만 남는지 직접
  // 단정한다.
  it("proc_list 는 onlyUserId 가 있으면 그 사용자 것만 남긴다(손님 격리 — 유일한 방어선)", async () => {
    const stdout = JSON.stringify([
      { name: "asahi-111", pm2_env: { status: "online", pm_uptime: 0, restart_time: 0, args: ["run", "dev"], pm_exec_path: "npm" }, monit: { memory: 1 } },
      { name: "asahi-222", pm2_env: { status: "online", pm_uptime: 0, restart_time: 0, args: ["run", "build"], pm_exec_path: "npm" }, monit: { memory: 1 } },
      { name: "asahi-worker", pm2_env: { status: "online", pm_uptime: 0, restart_time: 0, args: [], pm_exec_path: "node" }, monit: { memory: 1 } },
    ]);
    const { runPm2 } = fakePm2({ jlist: { ok: true, stdout } });
    const ex = makeExecutors(["C:\\ws"], { runPm2 });
    const r = await ex.proc_list!({ onlyUserId: "111" });
    expect(r.ok).toBe(true);
    expect(r.content).toContain("asahi-111");
    expect(r.content).not.toContain("asahi-222");
    expect(r.content).not.toContain("asahi-worker");
  });

  it("proc_logs 는 nostream 으로 부르고 줄 수를 넘긴다", async () => {
    const { calls, runPm2 } = fakePm2({ logs: { ok: true, stdout: "로그 본문" } });
    const ex = makeExecutors(["C:\\ws"], { runPm2 });
    const r = await ex.proc_logs!({ name: "asahi-111", lines: 30 });
    expect(r.ok).toBe(true);
    expect(r.content).toContain("로그 본문");
    const logs = calls.find((c) => c[0] === "logs")!;
    expect(logs).toContain("--nostream");
    expect(logs).toContain("30");
  });

  // 리뷰 지적(Minor, Finding 7): lines 는 1..200 으로 클램프되고 기본값은 50 인데, 기존 테스트는
  // lines:30(클램프 범위 안의 평범한 값) 하나만 다뤄 기본값과 양쪽 클램프 경계가 전혀 검증되지
  // 않았다. 세 경우를 모두 채운다 — lines 생략(기본값), 하한 미만(0 이하), 상한 초과(200 초과).
  it("proc_logs 는 lines 를 생략하면 기본값 50줄을 쓴다", async () => {
    const { calls, runPm2 } = fakePm2({ logs: { ok: true, stdout: "로그" } });
    const ex = makeExecutors(["C:\\ws"], { runPm2 });
    await ex.proc_logs!({ name: "asahi-111" });
    const logs = calls.find((c) => c[0] === "logs")!;
    expect(logs).toContain("50");
  });

  it("proc_logs 는 lines 하한(1) 밑으로 내려가지 않는다", async () => {
    const { calls, runPm2 } = fakePm2({ logs: { ok: true, stdout: "로그" } });
    const ex = makeExecutors(["C:\\ws"], { runPm2 });
    await ex.proc_logs!({ name: "asahi-111", lines: -5 });
    const logs = calls.find((c) => c[0] === "logs")!;
    expect(logs).toContain("1");
    expect(logs).not.toContain("-5");
  });

  it("proc_logs 는 lines 상한(200)을 넘지 않는다", async () => {
    const { calls, runPm2 } = fakePm2({ logs: { ok: true, stdout: "로그" } });
    const ex = makeExecutors(["C:\\ws"], { runPm2 });
    await ex.proc_logs!({ name: "asahi-111", lines: 9999 });
    const logs = calls.find((c) => c[0] === "logs")!;
    expect(logs).toContain("200");
    expect(logs).not.toContain("9999");
  });

  // 리뷰 지적(Important, 병합 차단): proc_stop 과 같은 이유로 proc_logs 도 봇·워커 자신의 로그를
  // 회원에게 그대로 노출할 수 있었다 — 이름 형식 검증이 없어 asahi-assistant·asahi-worker 를
  // 그대로 pm2 logs 에 넘겼다.
  it("proc_logs 는 asahi-<숫자> 형식이 아닌 이름(봇·워커 자신)을 pm2 를 부르지 않고 거절한다", async () => {
    for (const infraName of ["asahi-worker", "asahi-assistant"]) {
      const { calls, runPm2 } = fakePm2({ logs: { ok: true, stdout: "로그 본문" } });
      const ex = makeExecutors(["C:\\ws"], { runPm2 });
      const r = await ex.proc_logs!({ name: infraName });
      expect(r.ok, `${infraName} 의 로그를 볼 수 있었다`).toBe(false);
      expect(r.content).toContain("회원");
      expect(calls.some((c) => c[0] === "logs"), `${infraName} 에 pm2 logs 가 호출됐다`).toBe(false);
    }
  });

  it("pm2 가 실패하면 stderr 를 사유로 돌려준다", async () => {
    const { runPm2 } = fakePm2({ jlist: { ok: false, stdout: "", stderr: "pm2 를 찾을 수 없습니다" } });
    const ex = makeExecutors(["C:\\ws"], { runPm2 });
    const r = await ex.proc_list!({});
    expect(r.ok).toBe(false);
    expect(r.content).toContain("pm2");
  });

  it("roots 가 비면 거절한다(sh_exec 와 같은 규칙)", async () => {
    const { runPm2 } = fakePm2({});
    const ex = makeExecutors([], { runPm2 });
    expect((await ex.proc_list!({})).ok).toBe(false);
  });
});

// 리뷰 지적(Important) 수정 검증. 기본 runPm2 의 실제 spawn 경로는 이음매 설계상 이 스위트 어디서도
// 지나가지 않는다(위 블록 전부 fakePm2 를 주입한다) — 그래서 인용 로직 자체를 순수 함수로 떼어
// 여기서 직접 단정한다. buildPm2CommandLine 은 executors.ts 의 기본 runPm2 가 실제로 호출하는 바로
// 그 함수다(재구현이 아니다). 기대값은 Node 의 실제 spawn(그 문자열, {shell:true}) 라운드트립으로
// 먼저 실측 확인했다 — 인용 없이 join 만 하면(예전 버그) 같은 인자가 7개가 아니라 10개 토큰으로
// 쪼개졌고, 여기 인용을 거치면 정확히 원래 개수로 돌아온다.
describe("buildPm2CommandLine — pm2 명령줄 인용(리뷰 Important 수정)", () => {
  it("공백 없는 단순 토큰은 따옴표 없이 그대로 둔다(로그 가독성)", () => {
    const line = buildPm2CommandLine(["start", "sh", "--name", "asahi-111"], "posix");
    expect(line).toBe("pm2 start sh --name asahi-111");
  });

  it("POSIX 플레이버는 공백 든 인자를 작은따옴표로 감싼다(리뷰가 실측한 인자 배열)", () => {
    // 예전 코드(join(' ')) 라면 "npm run dev" 가 공백마다 쪼개져 pm2 에 5개가 아니라 7개의
    // argv 가 전달됐다 — 리뷰가 실측한 바로 그 사례.
    const line = buildPm2CommandLine(["--name", "asahi-111", "--", "-c", "npm run dev"], "posix");
    expect(line).toBe("pm2 --name asahi-111 -- -c 'npm run dev'");
  });

  it("윈도우 플레이버는 공백 든 인자를 큰따옴표로 감싼다(공백 든 --cwd 경로 포함)", () => {
    // 실제 윈도우 작업폴더는 사용자 이름에 공백이 들어갈 수 있다(예: "Jane Smith").
    const line = buildPm2CommandLine(
      ["start", "cmd.exe", "--name", "asahi-111", "--cwd", "C:\\Users\\Jane Smith\\ws\\111", "--", "/c", "npm run dev"],
      "win32",
    );
    expect(line).toBe(
      'pm2 start cmd.exe --name asahi-111 --cwd "C:\\Users\\Jane Smith\\ws\\111" -- /c "npm run dev"',
    );
  });

  it("POSIX 는 인자에 든 작은따옴표를 이스케이프한다(따옴표 자체가 토큰 경계를 깨지 않게)", () => {
    // 작은따옴표 안에는 이스케이프가 없으므로 공백이 없어도 인용 대상이다 — needsQuoting 이
    // 공백만 보면 이 경우를 놓친다.
    const line = buildPm2CommandLine(["it's"], "posix");
    expect(line).toBe("pm2 'it'\\''s'");
  });

  it("빈 문자열 인자도 따옴표로 감싸 사라지지 않게 한다", () => {
    const line = buildPm2CommandLine(["start", ""], "posix");
    expect(line).toBe("pm2 start ''");
  });
});

// 후속 리뷰 지적(Important) 수정 검증. 위 5개 테스트가 통과하던 시점에도 quoteWin32 는 인자를
// "..." 로 감싸기만 했고, 인자 안의 큰따옴표 자체는 전혀 이스케이프하지 않았다. 실측(리뷰가 실제
// cmd.exe 로 확인): buildPm2CommandLine([..., 'npm run dev -- --title="hi there"'], "win32") 를
// 그대로 다시 spawn(그 문자열, {shell:true}) 하면 큰따옴표가 조용히 사라지고 인자가 둘로 쪼개진다
// ("npm run dev -- --title=hi" 와 "there") — 공백 대신 큰따옴표가 방아쇠라는 점만 다를 뿐, 원래
// 버그와 같은 조용한 손상 클래스다. 아래는 MSVCRT/CommandLineToArgvW 표준 인용 규칙(큰따옴표
// 앞의 백슬래시만 두 배로 늘리고 큰따옴표는 \" 로 이스케이프)을 정확한 문자열로 고정한다. 기대값은
// POSIX 인용 테스트와 같은 원칙으로, 손으로 지어내지 않고 이 인자들을 실제
// spawn(문자열, {shell:true})로 다시 라운드트립해 원래 배열과 바이트 단위로 같아지는 것까지 먼저
// 실측 확인한 뒤 옮겨 적었다.
describe("buildPm2CommandLine — 윈도우 큰따옴표 이스케이프(추가 리뷰 Important 수정)", () => {
  it("윈도우 플레이버는 인자에 든 큰따옴표를 이스케이프한다(리뷰가 실측한 cmd.exe 라운드트립 사례)", () => {
    // 리뷰가 실측으로 보고한 바로 그 사례 — 공백이 있어 인용 대상인 건 이전 라운드부터 그랬지만,
    // 감싸는 큰따옴표 안의 두 " 가 지금까지는 전혀 이스케이프되지 않았다.
    const line = buildPm2CommandLine(['npm run dev -- --title="hi there"'], "win32");
    expect(line).toBe('pm2 "npm run dev -- --title=\\"hi there\\""');
  });

  it("윈도우 플레이버는 인자 끝의 백슬래시를 닫는 큰따옴표 앞에서 두 배로 늘린다", () => {
    // 실제 윈도우 작업폴더가 백슬래시로 끝나는 경우(예: 사용자가 트레일링 슬래시를 붙인 cwd).
    // 늘리지 않으면 그 백슬래시가 우리가 붙이는 닫는 큰따옴표를 이스케이프해버려 따옴표가 안
    // 닫힌 것처럼 파싱된다.
    const line = buildPm2CommandLine(["C:\\Users\\Jane Smith\\ws\\111\\"], "win32");
    expect(line).toBe('pm2 "C:\\Users\\Jane Smith\\ws\\111\\\\"');
  });

  it("윈도우 플레이버는 백슬래시가 바로 앞에 오는 큰따옴표도 이스케이프한다(공백 없이 큰따옴표만 있어도 인용 대상)", () => {
    // 공백이 전혀 없는 인자 — needsQuoting 이 윈도우에서도 큰따옴표 포함 여부를 보도록 고치지
    // 않으면 이 인자는 애초에 인용조차 되지 않아 quoteWin32 의 이스케이프가 한 번도 호출되지
    // 않는다(그러면 인용 안 된 토큰 안의 "가 표준 argv 파서의 따옴표 모드를 그 자체로 토글해버려
    // 공백 없이도 조용히 다른 방식으로 깨진다).
    const line = buildPm2CommandLine(['a\\"b'], "win32");
    expect(line).toBe('pm2 "a\\\\\\"b"');
  });
});
