import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  makeExecutors,
  OUTPUT_MAX,
  buildPm2CommandLine,
  scriptContentFor,
  writeStartScript,
  recoverCommands,
  describeExit,
  SH_EXEC_TIMEOUT_HINT,
} from "../src/remote/executors.js";
import { TREE_MAX_ENTRIES } from "../src/remote/tree.js";
import type { ProcInfo } from "../src/remote/proc.js";

// 아래 "hardTimer·timedOut 두 타임아웃 메시지" 테스트가 소스를 직접 읽어 상수 참조 개수를
// 세는 데 쓴다 — executors.ts 선언부 참고(같은 파일을 가리켜야 하므로 여기 한 곳에서만 계산).
const EXECUTORS_SRC = fileURLToPath(new URL("../src/remote/executors.ts", import.meta.url));

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

  it("도구 15개를 정확히 노출한다", () => {
    // Task 8: fs_mkdir 추가. 모델이 부르는 도구 목록(REMOTE_TOOL_NAMES)에는 안 들어가지만, 워커
    // 실행기 자체는 다른 fs_* 와 나란히 이 객체에 존재한다.
    // Task 4: fs_tree 추가 — 폴더 구조 전용 조회 도구(모델이 부르는 목록에도 들어간다).
    // M2 Task 2: proc_start·proc_stop·proc_list·proc_logs 추가 — 장기 실행 프로세스를 PM2 에
    // 위임하는 실행기 넷(모델이 부르는 도구 목록에도 들어간다).
    // Task 2(파일 전달): file_fetch 추가 — fs_mkdir 과 같은 이유로 REMOTE_TOOL_NAMES 밖이다.
    // 봇이 hub.call 로 직접 부른다(모델이 URL 을 정하게 하지 않는다).
    // 깃허브 발행 Task 6: git_publish·git_restore 추가 — file_fetch 와 같은 이유로
    // REMOTE_TOOL_NAMES 밖이다. 모델이 cloneUrl·token 을 정하게 하면 워커가 임의 원격으로
    // 푸시하는 표면이 열리므로, 봇이 계산해 hub.call 로 직접 부른다.
    expect(Object.keys(ex).sort()).toEqual([
      "file_fetch", "fs_edit", "fs_glob", "fs_grep", "fs_mkdir", "fs_read", "fs_tree", "fs_write",
      "git_publish", "git_restore",
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

  it("sh_exec 는 0이 아닌 종료 코드를 ok=true 로 보고하고 코드를 본문에 싣는다", async () => {
    // 셸에서 non-zero 는 실패 신호가 아니라 통신 수단이다(findstr/grep 의 1 = 매칭 없음).
    // 도구는 명령을 실행하는 데 성공했으므로 ok:true 이고, 종료 코드는 사실로만 전달한다.
    const r = await ex.sh_exec({ command: "exit 3" });
    expect(r.ok).toBe(true);
    expect(r.content).toContain("종료 코드 3");
  });

  // 최종 리뷰 Fix 1(중요, 이 브랜치가 낸 회귀): ok:false 가 사라진 뒤로 실패를 알리는 신호는
  // 본문 끝의 종료 코드 하나뿐인데, truncate 는 앞에서 자르므로 출력이 상한을 넘기면 그 유일한
  // 신호까지 통째로 사라졌다 — 오류가 쏟아지는 npm run build 가 정확히 이 모양이라(본문은 길고
  // 코드는 0이 아니다) 모델은 "잘린 본문 + ok:true" 만 받아 성공으로 읽는다.
  it("sh_exec 는 출력이 상한을 넘겨 잘려도 종료 코드를 남긴다(회귀)", async () => {
    fs.writeFileSync(path.join(root, "big.txt"), "a".repeat(OUTPUT_MAX * 2));
    // sh_exec 의 cwd 는 roots[0](=root)이므로 파일 이름만으로 닿는다.
    const command = process.platform === "win32" ? "type big.txt & exit 3" : "cat big.txt; exit 3";
    const r = await ex.sh_exec({ command });
    expect(r.ok).toBe(true);
    // 상한에 실제로 걸린 상황이 맞는지부터 못박는다 — 이게 없으면 출력이 짧아도 통과한다.
    expect(r.content).toContain("잘랐어요");
    expect(r.content).toContain("종료 코드 3");
  }, 20000);

  it("sh_exec 는 출력이 없으면 그 사실을 본문에 적는다", async () => {
    // 빈 문자열만 돌려주면 모델은 "도구가 아무 말도 안 했다"와 "명령이 아무것도 안 냈다"를
    // 구분할 수 없다. 실사용에서 findstr 이 정확히 이 모양이었다.
    const r = await ex.sh_exec({ command: "exit 1" });
    expect(r.ok).toBe(true);
    expect(r.content).toContain("출력 없음");
    expect(r.content).toContain("종료 코드 1");
  });

  it("sh_exec 는 종료 코드가 0이면 코드를 언급하지 않는다", async () => {
    const r = await ex.sh_exec({ command: "echo asahi" });
    expect(r.ok).toBe(true);
    expect(r.content).toContain("asahi");
    expect(r.content).not.toContain("종료 코드");
  });

  it("describeExit 는 신호 종료(code=null)를 코드 대신 사실로 적는다", () => {
    // "(종료 코드 null)" 은 사람에게도 모델에게도 의미가 없다.
    expect(describeExit("", null)).toContain("신호로 종료됨");
    expect(describeExit("", null)).not.toContain("null");
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

  // Task 2(셸·프로세스 사용성): 타임아웃으로 끝나는 두 갈래(hardTimer·timedOut) 모두 proc_start 를
  // 안내해야, 모델이 재시도할 때 sh_exec 를 다시 쓰지 않고 proc_start 로 옮겨간다.
  it("sh_exec 타임아웃 문구는 proc_start 를 안내한다", async () => {
    const longRunning = process.platform === "win32" ? "for /L %i in (1,1,2000000000) do @rem" : "sleep 5";
    const r = await ex.sh_exec({ command: longRunning, timeoutMs: 200 });
    expect(r.ok).toBe(false);
    expect(r.content).toContain("proc_start");
  }, 10000);

  // 리뷰 지적(Important): 위 테스트는 timedOut 갈래(close 가 정상적으로 온 경우)만 지나간다 —
  // hardTimer 갈래(강제종료에도 close 가 안 와 최종적으로 포기하는 경우)는 KILL_GRACE_MS+
  // FORCE_KILL_GRACE_MS(5초) 동안 close 가 끝내 오지 않는 프로세스를 요구하는데, 그런 프로세스를
  // 짧고 결정론적인 단위테스트로 만들 방법이 없다(만들 수 있어도 매번 5초 이상 걸려 느리고
  // 불안정해진다). executors.ts 가 SH_EXEC_TIMEOUT_HINT 상수 하나로 두 메시지를 만들게 고친
  // 이유가 이것이다 — hardTimer 갈래를 실행하지 않고도, (1) 상수 자체의 값과 (2) 두 메시지가
  // 실제로 이 상수를 참조해 만들어지는지를 소스에서 직접 확인하면 문구가 지워지거나 갈리는
  // 것을 잡을 수 있다.
  it("SH_EXEC_TIMEOUT_HINT 문구는 정확히 이 내용이다", () => {
    expect(SH_EXEC_TIMEOUT_HINT).toBe("계속 도는 프로그램이라면 proc_start 로 띄워야 해요.");
  });

  it("hardTimer·timedOut 두 타임아웃 메시지 모두 SH_EXEC_TIMEOUT_HINT 하나를 참조해 만든다", () => {
    const src = fs.readFileSync(EXECUTORS_SRC, "utf8");
    // hardTimer 갈래·timedOut 갈래 각각 한 번씩, 정확히 2회 참조해야 한다 — 어느 한쪽이 상수
    // 참조를 잃고 다시 별도 문자열로 되돌아가면(예: 되돌리는 리팩터) 이 개수가 어긋난다.
    const interpolations = src.match(/\$\{SH_EXEC_TIMEOUT_HINT\}/g) ?? [];
    expect(interpolations).toHaveLength(2);
    // 상수 값 자체의 문자열 리터럴은 선언부 한 곳에만 있어야 한다 — 둘 이상이면 어딘가 이
    // 상수와 몰래 따로 노는 하드코딩 사본이 다시 생겼다는 뜻이다(고치려던 중복의 재발).
    const literalOccurrences = src.split(`"${SH_EXEC_TIMEOUT_HINT}"`).length - 1;
    expect(literalOccurrences).toBe(1);
  });

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

  // Task 2: 봇이 디스코드 첨부를 미니PC 에 직접 받아 저장하는 실행기. 모델이 부르는 도구가
  // 아니다 — REMOTE_TOOL_NAMES(core/remoteTools.ts)에 없으므로 mcp__asahi__* 로 노출되지 않고,
  // 봇이 remoteTools.ts 를 거치지 않고 hub.call(...) 로 직접 부른다(Task 3). 경로가 아니라
  // dir·name 을 따로 받는 이유: 봇은 리눅스 컨테이너, 워커는 윈도우라 봇에서 path.join 하면
  // '/' 로 이어붙어 워커 경로와 어긋난다 — 조립은 파일이 실제로 놓일 이 기계(워커)가 한다.
  describe("file_fetch — 봇이 부르는 첨부 저장(모델 도구가 아니다)", () => {
    it("허용 폴더 밖은 거부한다", async () => {
      const ex = makeExecutors([root]);
      const r = await ex.file_fetch({ url: "https://cdn.discordapp.com/attachments/1/2/a.pdf", dir: path.join(root, ".."), name: "escape.pdf" });
      expect(r.ok).toBe(false);
      expect(r.content).toContain("워커 작업 폴더 밖");
    });

    it("이름으로 폴더를 벗어나려 해도 거부한다", async () => {
      // 봇이 safeFileName 으로 이미 걸렀지만 워커가 다시 막는다 — 봇을 신뢰하지 않는다.
      const ex = makeExecutors([root]);
      const r = await ex.file_fetch({ url: "https://cdn.discordapp.com/attachments/1/2/a.pdf", dir: root, name: "../escape.pdf" });
      expect(r.ok).toBe(false);
    });

    it("디스코드 CDN 이 아닌 주소는 거부한다", async () => {
      // 봇이 이미 실제 첨부에서 URL 을 꺼내지만, 워커는 봇을 신뢰하지 않고 다시 판정한다 —
      // 이 리포의 이중 게이트 원칙(봇 1차 필터 + 워커 최종 판정) 그대로다.
      const ex = makeExecutors([root]);
      const r = await ex.file_fetch({ url: "https://evil.test/a.pdf", dir: root, name: "a.pdf" });
      expect(r.ok).toBe(false);
      expect(r.content).toContain("디스코드");
    });

    it("받아서 바이너리 그대로 파일로 쓴다", async () => {
      // utf8 로 쓰면 0x00·0x80 이상 바이트가 깨진다 — PDF·docx 는 전부 바이너리다.
      const bytes = new Uint8Array([0, 1, 2, 255, 128]);
      const ex = makeExecutors([root], {
        fetchImpl: (async () => new Response(bytes, { status: 200 })) as unknown as typeof fetch,
      });
      const r = await ex.file_fetch({ url: "https://cdn.discordapp.com/attachments/1/2/a.pdf", dir: root, name: "a.pdf" });
      expect(r.ok).toBe(true);
      expect(r.content).toBe(path.join(root, "a.pdf"));
      expect(await fsp.readFile(path.join(root, "a.pdf"))).toEqual(Buffer.from(bytes));
    });

    it("응답이 실패면 파일을 만들지 않는다", async () => {
      const ex = makeExecutors([root], {
        fetchImpl: (async () => new Response("nope", { status: 404 })) as unknown as typeof fetch,
      });
      const r = await ex.file_fetch({ url: "https://cdn.discordapp.com/attachments/1/2/a.pdf", dir: root, name: "missing.pdf" });
      expect(r.ok).toBe(false);
      expect(r.content).toContain("404");
      await expect(fsp.access(path.join(root, "missing.pdf"))).rejects.toThrow();
    });

    // M-3(최종 리뷰, Minor): CDN 이 응답을 멈추면 예전엔 허브의 120초 호출 타임아웃에만 기대야
    // 했다 — 첨부 최대 3개를 순차로 받으므로 한 턴이 최대 6분 묶일 수 있었다. downloadImages
    // (core/images.ts)와 같은 AbortController 패턴을 따랐는지, "신호를 받아야만 끝나는" 가짜
    // fetch 로 확인한다(fileFetchTimeoutMs 를 짧게 주입해 실제로 10초를 기다리지 않는다).
    it("CDN 이 응답하지 않으면 타임아웃으로 실패하고 파일을 만들지 않는다(무기한 대기하지 않는다)", async () => {
      const hangingFetch = ((_url: string, init?: { signal?: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          // 실제 fetch(undici)가 abort 시 던지는 것과 같은 성격의 오류(AbortError)로 reject 한다.
          init?.signal?.addEventListener("abort", () => reject(new DOMException("The operation was aborted.", "AbortError")));
        })) as unknown as typeof fetch;
      const ex = makeExecutors([root], { fetchImpl: hangingFetch, fileFetchTimeoutMs: 20 });
      const r = await ex.file_fetch({ url: "https://cdn.discordapp.com/attachments/1/2/a.pdf", dir: root, name: "stuck.pdf" });
      expect(r.ok).toBe(false);
      expect(r.content).toContain("받아오지 못했어요");
      await expect(fsp.access(path.join(root, "stuck.pdf"))).rejects.toThrow();
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

  // 타임아웃을 명시하는 이유: 이 테스트는 TREE_MAX_ENTRIES + 5 = 505 개의 실제 파일을 만든다.
  // 상한을 넘겼을 때의 안내를 확인하는 것이 목적이라 파일 수를 줄일 수 없고, 505 번의 파일 생성은
  // 본질적으로 I/O 바운드다. 로컬(윈도우)에서는 1초 안에 끝나지만 GitHub Actions 의 윈도우
  // 러너에서는 훨씬 느려, 2026-08-07 CI 에서 5,032ms 로 기본 타임아웃(5,000ms)을 32ms 차이로
  // 넘겨 실패했다 — 같은 커밋의 다른 실행에서는 통과했다(플레이키). 느린 것이 결함이 아니라
  // 기본 타임아웃이 이 테스트에 안 맞는 것이므로, 이 테스트에만 여유를 준다.
  it("항목 수 상한을 넘는 트리는 잘렸다고 안내한다", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "asahi-tree-entries-"));
    for (let i = 0; i < TREE_MAX_ENTRIES + 5; i++) {
      fs.writeFileSync(path.join(root, `f${i}.txt`), "");
    }

    const ex = makeExecutors([root]);
    const r = await ex.fs_tree!({ path: root });
    expect(r.ok).toBe(true);
    expect(r.content).toContain("항목이 많아");
  }, 30_000);

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

  // Defect 1(운영 중 발견): proc_start 는 이제 cwd 를 checkPath(WORKER_ROOTS, roots.ts)로 검사하고
  // 실제로 존재하는 폴더인지도 확인한다(아래 참고) — fs_* 실행기(위 "워커 실행기" describe)와 같은
  // 이유로, 더 이상 임의의 문자열을 cwd 로 써서는 안 되고 실제 임시 폴더가 있어야 한다. root 는
  // WORKER_ROOTS, projectDir 는 그 안의(회원 "111"의) 프로젝트 폴더 역할이다.
  let root: string;
  let projectDir: string;
  // proc_start 가 회원 명령을 적는 스크립트 파일 위치(아래 "명령을 pm2 명령줄에 올리지 않는다"
  // 참고) — 실제 OS 임시폴더를 더럽히지 않도록, 그리고 다른 테스트 파일과 이름이 겹칠 걱정 없이
  // 이 스위트 전용 폴더를 주입한다. proc_start 를 부르지 않는 테스트에는 영향이 없다.
  let scriptDir: string;
  beforeEach(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "asahi-proc-")));
    projectDir = path.join(root, "111");
    fs.mkdirSync(projectDir, { recursive: true });
    scriptDir = fs.mkdtempSync(path.join(os.tmpdir(), "asahi-proc-scripts-"));
  });
  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(scriptDir, { recursive: true, force: true });
  });

  it("proc_start 는 주입된 이름과 cwd 로 pm2 start 를 부른다", async () => {
    // 첫 jlist(사전 중복 확인)는 비어 있고, start 이후 재조회(Finding 5)는 online 을 돌려준다 —
    // 실제 성공 경로를 그대로 흉내낸다.
    const { calls, runPm2 } = fakePm2({ jlist: [{ ok: true, stdout: "[]" }, { ok: true, stdout: onlineJlist("asahi-111") }] });
    const ex = makeExecutors([root], { runPm2, scriptDir });
    const r = await ex.proc_start!({ command: "npm run dev", name: "asahi-111", cwd: projectDir });
    expect(r.ok).toBe(true);
    const start = calls.find((c) => c[0] === "start")!;
    expect(start).toContain("--name");
    expect(start).toContain("asahi-111");
    expect(start).toContain("--cwd");
    expect(start).toContain(projectDir);
    // 실제 사고 원인 수정: 명령 문자열 자체는 pm2 인자 배열 어디에도 나타나지 않는다 — cmd.exe 가
    // 그 명령줄을 다시 파싱하며 buildPm2CommandLine 의 MSVCRT \" 이스케이프를 이해하지 못해
    // 토큰 경계가 깨지는 사고를 원천적으로 없애려고, 명령은 스크립트 파일에만 적는다(아래
    // "scriptContentFor"·"writeStartScript" 참고).
    expect(start.some((tok) => tok.includes("npm run dev"))).toBe(false);
    const scriptPath = start[start.length - 1]!;
    expect(fs.readFileSync(scriptPath, "utf8")).toContain("npm run dev");
  });

  // 실제 사고 원인 수정의 핵심 회귀 가드. buildPm2CommandLine 은 MSVCRT 규칙(임베디드 따옴표를
  // \" 로)으로 인용하지만, 그 결과 문자열을 spawn(commandLine, {shell:true}) 가 먼저 cmd.exe 로
  // 실행한다 — cmd.exe 는 \" 를 모른다. 백슬래시를 리터럴로 두고 따옴표 개수만 세므로 첫 임베디드
  // 따옴표 뒤로 토큰 경계가 전부 어긋난다. 미니PC 실측(한글 경로뿐 아니라 ASCII 만 쓴 공백 경로로도
  // 같은 증상을 재현해, 원인이 한글이 아니라 인용 자체임을 확인)으로 확정된 사고다 — 명령을 pm2
  // 명령줄에 다시는 올리지 않는 것이 유일하고 근본적인 고침이다.
  it("proc_start 는 임베디드 따옴표가 든 명령도 pm2 인자 배열에 올리지 않는다(실제 사고 재현)", async () => {
    const trapCommand = 'npm run dev -- --title="hi there"';
    const { calls, runPm2 } = fakePm2({ jlist: [{ ok: true, stdout: "[]" }, { ok: true, stdout: onlineJlist("asahi-111") }] });
    const ex = makeExecutors([root], { runPm2, scriptDir });
    const r = await ex.proc_start!({ command: trapCommand, name: "asahi-111", cwd: projectDir });
    expect(r.ok).toBe(true);
    const start = calls.find((c) => c[0] === "start")!;
    // buildPm2CommandLine 이 다시 망가뜨릴 여지 자체가 없다 — 이 문자열도 인자 배열 어디에도 없다.
    expect(start.some((tok) => tok.includes(trapCommand))).toBe(false);
    // Finding 4(Minor, 후속 리뷰): 아래 한 줄은 인용 "이전"의 인자 배열(start)을 그대로 검사한다
    // — \" 는 buildPm2CommandLine(인용 단계)을 실제로 거쳐야만 나타나는 문자열이라, 인용 전
    // 배열에서 그걸 찾는 단정은 buildPm2CommandLine 이 무엇을 하든(심지어 안 불러도) 항상 참에
    // 가깝다 — 실제 사고의 두 절반(회원 명령이 pm2 인자에 실리는 것 + buildPm2CommandLine 의 \"
    // 이스케이프)을 하나로 잇지 못한다. start 를 실제로 buildPm2CommandLine(기본 runPm2 가 실제로
    // 부르는 바로 그 함수, 위 "buildPm2CommandLine — pm2 명령줄 인용" describe 참고)에 통과시켜,
    // 그 결과 명령줄 문자열 자체에 \" 가 없는지 확인한다 — 이러면 나중에 어떤 인자(cwd·스크립트
    // 경로 등)가 큰따옴표를 갖게 되는 회귀가 생겨도 이 단정이 실제로 걸린다.
    expect(buildPm2CommandLine(start, "win32")).not.toContain('\\"');
    // "--" 뒤 마지막 인자는 스크립트 파일 경로 하나뿐이고, 명령은 그 파일 안에 이스케이프 없이
    // 그대로 있다.
    const scriptPath = start[start.length - 1]!;
    expect(fs.existsSync(scriptPath)).toBe(true);
    expect(fs.readFileSync(scriptPath, "utf8")).toContain(trapCommand);
  });

  // --no-autorestart 로 띄우는 이유(Finding 5): 오타 난 개발서버가 크래시를 반복해도 회원 눈에
  // 안 보이게 재시작을 계속하면, 시작 직후 재조회가 그 순간 크래시 루프의 어느 타이밍을 볼지
  // 흔들린다 — 꺼두면 한 번 죽고 그대로 멈추므로 재조회가 실패를 매번 결정론적으로 잡는다.
  // (예전엔 proc_stop 의 트리 kill과 pm2 재시작 사이의 경쟁을 막는다는 이유도 있었지만, 그 트리
  // kill 자체가 sh_exec 가 띄운 고아를 pm2 관리 프로세스로 착각한 오진단이었다 — pm2 delete 는
  // 실측으로 이미 트리 전체를 정리한다는 것이 확인돼 되돌렸다.)
  it("proc_start 는 --no-autorestart 로 띄운다", async () => {
    const { calls, runPm2 } = fakePm2({ jlist: [{ ok: true, stdout: "[]" }, { ok: true, stdout: onlineJlist("asahi-111") }] });
    const ex = makeExecutors([root], { runPm2, scriptDir });
    await ex.proc_start!({ command: "npm run dev", name: "asahi-111", cwd: projectDir });
    const start = calls.find((c) => c[0] === "start")!;
    expect(start).toContain("--no-autorestart");
    // 커버리지 공백 보완(Gap 3): 존재 여부(toContain)만으로는 부족하다 — pm2 는 "--" 앞의
    // 토큰만 자기 옵션으로 해석하고, 그 뒤는 그대로 cmd.exe/sh 스크립트 인자로 흘려보낸다.
    // --no-autorestart 가 "--" 뒤로 밀리면 pm2 에게는 안 보이는 문자열 하나가 될 뿐이라
    // autorestart 는 계속 켜진 채로 남는다. 위 toContain 은 이 회귀를 못 잡는다 — "--" 뒤로
    // 옮겨도 배열엔 여전히 들어 있기 때문이다. 위치까지 직접 고정한다.
    const flagIndex = start.indexOf("--no-autorestart");
    const sepIndex = start.indexOf("--");
    expect(flagIndex).toBeGreaterThanOrEqual(0);
    expect(sepIndex).toBeGreaterThanOrEqual(0);
    expect(flagIndex).toBeLessThan(sepIndex);
  });

  it("proc_start 는 같은 이름이 이미 있으면 pm2 를 부르지 않고 거절한다(조용한 교체 금지)", async () => {
    const existing = JSON.stringify([{ name: "asahi-111", pm2_env: { status: "online", pm_uptime: 0, restart_time: 0, args: ["run", "dev"], pm_exec_path: "npm" }, monit: { memory: 1 } }]);
    const { calls, runPm2 } = fakePm2({ jlist: { ok: true, stdout: existing } });
    const ex = makeExecutors([root], { runPm2, scriptDir });
    const r = await ex.proc_start!({ command: "npm run dev", name: "asahi-111", cwd: projectDir });
    expect(r.ok).toBe(false);
    expect(r.content).toContain("이미");
    expect(calls.some((c) => c[0] === "start")).toBe(false);
  });

  // 리뷰 지적(Minor): 위 중복 거절 메시지는 dup.command 를 그대로 보여준다 — proc_start 가 pm2 의
  // "스크립트" 자리에 cmd.exe/sh 를 넣는 셸 래퍼 모양(commandOf 가 걷어내는 모양, proc.test.ts
  // 참고)으로 이미 떠 있는 프로세스를 시뮬레이션해, 이 메시지에도 셸 껍데기가 새지 않는지
  // 확인한다. (참고: 스크립트 파일 우회 이후 실제 proc_start 는 이 자리에 "npm run dev" 가 아니라
  // 스크립트 경로를 남긴다 — 이 테스트는 그 구체적인 뒷부분과 무관하게 commandOf 의 셸 래퍼
  // 스트리핑 자체를 겨냥한다.)
  it("이름 충돌 거절 메시지는 셸 래퍼 모양에서도 셸 껍데기 없이 뒷부분만 보여준다", async () => {
    const existing = JSON.stringify([{ name: "asahi-111", pm2_env: { status: "online", pm_uptime: 0, restart_time: 0, args: ["/c", "npm run dev"], pm_exec_path: "C:\\Windows\\System32\\cmd.exe" }, monit: { memory: 1 } }]);
    const { runPm2 } = fakePm2({ jlist: { ok: true, stdout: existing } });
    const ex = makeExecutors([root], { runPm2, scriptDir });
    const r = await ex.proc_start!({ command: "npm run dev", name: "asahi-111", cwd: projectDir });
    expect(r.ok).toBe(false);
    expect(r.content).toContain("npm run dev");
    expect(r.content).not.toContain("cmd.exe");
    expect(r.content).not.toContain("/c");
  });

  // UX 회귀(2026-07-30, 스크립트 파일 우회의 부작용): pm2 jlist 는 이제 회원 명령이 아니라
  // writeStartScript 가 쓴 스크립트 "경로"만 알고 있다(commandOf, proc.ts 참고) — 고치기 전에는
  // 이 거절 메시지가 dup.command 를 그대로 보여줘 "C:\...\asahi-proc-scripts\asahi-111.bat"
  // 류가 회원에게 노출됐다. jlist 가 실제로 보고할 형태(cmd.exe 셸 래퍼 뒤에 스크립트 경로 —
  // Finding 2 이후 recoverCommands 가 이 경로를 신뢰하려면 실제로 필요한 형태이기도 하다)를
  // 그대로 흉내내, "메시지에 보이는 명령이 그 raw 경로가 아니라 스크립트 파일에서 되찾은 값"
  // 이라는 것을 직접 증명한다.
  // 2026-08-07 CI: 이 케이스는 윈도우에서만 돌린다. 아래 가짜 jlist 가 흉내내는 것이 윈도우
  // 고유의 형태(`cmd.exe /c <경로>.bat`)이고, 실제로 파일을 쓰는 쪽인 writeStartScript 는
  // shellFlavorOf(roots) 로 확장자를 정한다(win32→.bat, posix→.sh, executors.ts 의
  // scriptPathFor). 리눅스 호스트에서는 root/scriptDir 이 POSIX 라 실제 스크립트가 `.sh` 로
  // 쓰이는데 이 테스트는 `.bat` 을 하드코딩하므로, recoverCommands 가 그 파일을 못 찾아
  // 되찾기에 실패하고 raw 경로가 그대로 노출된다 — **구현 결함이 아니라 흉내낸 데이터가
  // 그 호스트와 안 맞는 것이다.** 같은 파일의 shellFor() 케이스가 이미 쓰는 관례를 따른다.
  it.skipIf(process.platform !== "win32")("중복 거절 메시지는 스크립트 경로가 아니라 되찾은 원래 명령을 보여준다(UX 회귀)", async () => {
    const trapCommand = 'npm run dev -- --title="hi there"';
    const scriptPath = path.join(scriptDir, "asahi-111.bat");
    const runningWithScriptPath = JSON.stringify([
      {
        name: "asahi-111",
        pm2_env: { status: "online", pm_uptime: Date.now(), restart_time: 0, args: ["/c", scriptPath], pm_exec_path: "C:\\Windows\\System32\\cmd.exe" },
        monit: { memory: 1 },
      },
    ]);
    const { runPm2 } = fakePm2({ jlist: [{ ok: true, stdout: "[]" }, { ok: true, stdout: runningWithScriptPath }] });
    const ex = makeExecutors([root], { runPm2, scriptDir });
    const first = await ex.proc_start!({ command: trapCommand, name: "asahi-111", cwd: projectDir });
    expect(first.ok).toBe(true);

    const second = await ex.proc_start!({ command: "npm run build", name: "asahi-111", cwd: projectDir });
    expect(second.ok).toBe(false);
    expect(second.content).toContain(trapCommand);
    expect(second.content).not.toContain(scriptDir);
  });

  it("proc_start 성공 응답은 멈추는 법을 그 자리에서 알려준다", async () => {
    const { runPm2 } = fakePm2({ jlist: [{ ok: true, stdout: "[]" }, { ok: true, stdout: onlineJlist("asahi-111") }] });
    const ex = makeExecutors([root], { runPm2, scriptDir });
    const r = await ex.proc_start!({ command: "npm run dev", name: "asahi-111", cwd: projectDir });
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
    const ex = makeExecutors([root], { runPm2, scriptDir });
    // Finding 1(이번 라운드) 이후 명령은 ASCII 여야 한다 — 이 테스트가 겨냥하는 것(크래시 루프
    // 감지)과 무관한 이유로 거절되지 않도록 오타 명령도 ASCII 로 적는다("오타난명령" 대신).
    const r = await ex.proc_start!({ command: "typo-command", name: "asahi-111", cwd: projectDir });
    expect(r.ok).toBe(false);
    expect(r.content).toContain("errored");
  });

  it("proc_start 는 시작 직후 재조회 자체가 실패해도(연결 끊김 등) 성공을 주장하지 않는다", async () => {
    const { runPm2 } = fakePm2({ jlist: [{ ok: true, stdout: "[]" }, { ok: false, stdout: "", stderr: "연결 끊김" }] });
    const ex = makeExecutors([root], { runPm2, scriptDir });
    const r = await ex.proc_start!({ command: "npm run dev", name: "asahi-111", cwd: projectDir });
    expect(r.ok).toBe(false);
  });

  // 리뷰 지적(Minor 3): name·cwd 누락 거절은 프로세스 소유권·1인 1개 상한의 전제 조건인데
  // 전용 테스트가 없었다. name·cwd 는 봇이 주입하므로(remoteTools.ts, 이후 태스크) 누락은 배선이
  // 깨졌다는 뜻이고, 그럴 때는 pm2 를 아예 부르지 않아야 한다 — jlist 조회조차 없는지까지
  // 확인해야 "아무 것도 시작하지 않는다"는 보장이 선다.
  it("proc_start 는 name·cwd 가 없으면 pm2 를 전혀 부르지 않고 거절한다(배선 오류 방어)", async () => {
    const { calls, runPm2 } = fakePm2({ jlist: { ok: true, stdout: "[]" } });
    const ex = makeExecutors([root], { runPm2, scriptDir });
    expect((await ex.proc_start!({ command: "npm run dev", cwd: projectDir })).ok).toBe(false); // name 없음
    expect((await ex.proc_start!({ command: "npm run dev", name: "asahi-111" })).ok).toBe(false); // cwd 없음
    expect((await ex.proc_start!({ command: "npm run dev" })).ok).toBe(false); // 둘 다 없음
    expect(calls).toEqual([]); // jlist 조회조차 없다 — 이름 없이는 아무 것도 시작하지 않는다
  });

  // 리뷰 지적(Minor 2): shellFor() 는 "워커 루트로 셸을 정한다(호스트 플랫폼이 아니라)"는 규칙을
  // 구현하지만 직접 단정하는 테스트가 없었다 — 두 플레이버를 각각 확인한다.
  //
  // Defect 1 이후: cwd 가 checkPath(roots.ts, 읽기 전용)의 실제 검사를 받게 되면서, "루트 유효성"
  // 자체의 기준(isUnambiguousRoot)이 실행 중인 호스트 플랫폼에 따라 달라진다 — POSIX 호스트에서만
  // posix 스타일 루트("/...")를 유효한 절대경로로 인정하고, win32 호스트에서만 드라이브 문자·UNC
  // 루트를 인정한다(paths.ts 의 hasUnambiguousWindowsRoot 주석 참고). 그래서 아래 두 테스트는 각자
  // 자신이 검증하려는 플레이버와 실제로 실행 중인 호스트가 일치할 때만 의미가 있다 — 그렇지 않으면
  // (예: win32 호스트에서 "/w" 를 루트로 주면) checkPath 가 "워커 루트 설정이 잘못됐어요"로 무조건
  // 거부해 shellFor() 의 선택 자체를 검증하지 못한 채 실패한다. remoteRoots.test.ts 가 반대 방향
  // (윈도우 전용 케이스를 POSIX 호스트에서 건너뜀)으로 이미 쓰는 것과 같은 관례로, it.skipIf 를
  // 대칭으로 적용한다 — 공유 root/projectDir(위 beforeEach)는 이 테스트가 실제로 실행되는 호스트
  // 위에서 만들어지므로 그 호스트의 flavor 를 자연히 따른다.
  it.skipIf(process.platform !== "win32")(
    "proc_start 는 윈도우 루트에서 cmd.exe·/c 로 pm2 를 부른다",
    async () => {
      const { calls, runPm2 } = fakePm2({ jlist: { ok: true, stdout: "[]" } });
      const ex = makeExecutors([root], { runPm2, scriptDir });
      await ex.proc_start!({ command: "npm run dev", name: "asahi-111", cwd: projectDir });
      const start = calls.find((c) => c[0] === "start")!;
      expect(start).toContain("cmd.exe");
      expect(start).toContain("/c");
      expect(start).not.toContain("sh");
      expect(start).not.toContain("-c");
    },
  );

  // 실제 사고 원인 수정 이후 POSIX 쪽은 더 이상 "-c" 를 쓰지 않는다 — -c 는 "다음 인자를 명령
  // 문자열로 실행하라"는 뜻이라 스크립트 파일 경로에는 맞지 않는다(윈도우의 cmd.exe 는 /c 뒤에
  // 배치파일 경로를 그대로 줘도 되지만, sh 는 플래그 없이 경로를 인자로 주면 그 파일을 스크립트로
  // 직접 연다 — 그래서 이 플레이버에서만 shellFor() 의 flag 가 없다).
  it.skipIf(process.platform === "win32")(
    "proc_start 는 POSIX 루트에서 sh 로 스크립트 파일을 직접 연다(호스트 플랫폼이 아니라 워커 루트 기준)",
    async () => {
      const { calls, runPm2 } = fakePm2({ jlist: { ok: true, stdout: "[]" } });
      const ex = makeExecutors([root], { runPm2, scriptDir });
      await ex.proc_start!({ command: "npm run dev", name: "asahi-111", cwd: projectDir });
      const start = calls.find((c) => c[0] === "start")!;
      expect(start).toContain("sh");
      expect(start).not.toContain("-c");
      expect(start).not.toContain("cmd.exe");
      expect(start).not.toContain("/c");
    },
  );

  // ── Defect 1(운영 중 발견) — proc_start 의 cwd 는 이제 워커 쪽 최종 게이트를 거친다 ──────────
  // 봇(remoteTools.ts)이 allowed_dirs 로 cwd 를 한 번 걸렀더라도, fs_* 실행기가 gate()/checkPath 로
  // 다시 한번 걸러 두 겹을 유지하는 것과 같은 이유로, proc_start 도 WORKER_ROOTS 를 최종 관문으로
  // 확인해야 한다. 아울러 회원의 프로젝트가 하위 폴더에 있는데 그 폴더가 실제로 없으면(오타 등)
  // pm2 가 --cwd 에서 바로 실패해 원인을 알 수 없었다는 게 운영 중 실제로 겪은 결함이다 — 존재
  // 여부까지 미리 확인해 한국어로 명확히 안내한다.
  describe("proc_start — cwd 는 WORKER_ROOTS 와 실존 여부를 워커가 최종적으로 검사한다(Defect 1)", () => {
    it("WORKER_ROOTS 밖 cwd 는 pm2 를 전혀 부르지 않고 거절한다(봇의 1차 필터를 우회해도 워커가 최종 관문)", async () => {
      const outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "asahi-proc-outside-")));
      try {
        const { calls, runPm2 } = fakePm2({ jlist: { ok: true, stdout: "[]" } });
        const ex = makeExecutors([root], { runPm2, scriptDir });
        const r = await ex.proc_start!({ command: "npm run dev", name: "asahi-111", cwd: outside });
        expect(r.ok).toBe(false);
        expect(r.content).toContain("워커 작업 폴더 밖");
        expect(calls).toEqual([]); // jlist 조회조차 없다 — 경로 검사가 가장 먼저다
      } finally {
        fs.rmSync(outside, { recursive: true, force: true });
      }
    });

    it("존재하지 않는 cwd 는 pm2 를 부르지 않고 한국어로 명확히 거절한다(운영 중 실제로 겪은 결함 — 프로젝트가 하위 폴더에 있는데 그 폴더가 없으면 pm2 가 --cwd 에서 바로 실패해 원인을 알 수 없었다)", async () => {
      const noSuchDir = path.join(root, "없는-프로젝트");
      const { calls, runPm2 } = fakePm2({ jlist: { ok: true, stdout: "[]" } });
      const ex = makeExecutors([root], { runPm2, scriptDir });
      const r = await ex.proc_start!({ command: "npm run dev", name: "asahi-111", cwd: noSuchDir });
      expect(r.ok).toBe(false);
      expect(r.content).toContain("폴더가 없어요");
      expect(calls).toEqual([]);
    });

    it("cwd 가 폴더가 아니라 파일이면 pm2 를 부르지 않고 거절한다", async () => {
      const filePath = path.join(root, "이건-파일.txt");
      fs.writeFileSync(filePath, "x");
      const { calls, runPm2 } = fakePm2({ jlist: { ok: true, stdout: "[]" } });
      const ex = makeExecutors([root], { runPm2, scriptDir });
      const r = await ex.proc_start!({ command: "npm run dev", name: "asahi-111", cwd: filePath });
      expect(r.ok).toBe(false);
      expect(r.content).toContain("폴더가 아니에요");
      expect(calls).toEqual([]);
    });

    it("한글·공백이 섞인 실제 하위 폴더는 정상적으로 띄운다(운영 중 재현 — '테스트 1' 폴더)", async () => {
      const koreanProject = path.join(root, "테스트 1");
      fs.mkdirSync(koreanProject, { recursive: true });
      const { calls, runPm2 } = fakePm2({ jlist: [{ ok: true, stdout: "[]" }, { ok: true, stdout: onlineJlist("asahi-111") }] });
      const ex = makeExecutors([root], { runPm2, scriptDir });
      const r = await ex.proc_start!({ command: "npm run dev", name: "asahi-111", cwd: koreanProject });
      expect(r.ok).toBe(true);
      const start = calls.find((c) => c[0] === "start")!;
      expect(start).toContain(koreanProject);
    });
  });

  // ── Finding 1(Critical, 후속 리뷰) — 명령은 윈도우에서 ASCII 만 허용한다 ──────────────────────
  // 미니PC 실측(배경 참고): writeStartScript 가 쓰는 UTF-8(BOM 없음) .bat 파일을 cmd.exe 는 시스템
  // ANSI 코드페이지로 읽는다 — chcp 를 파일 안에 넣어도 그 줄 자신이 이미 잘못된 코드페이지로
  // 디코드된 뒤라 소용없다(scriptContentFor 선언부의 실측 표 참고). cwd(--cwd)는 이 검사와 무관하게
  // CreateProcessW(UTF-16)를 거치므로 한글·공백이 이미 문제없이 동작한다(바로 위 "한글·공백이
  // 섞인..." 테스트가 그 증거) — 그러니 한글이 문제가 되는 자리는 명령 문자열 자체뿐이다.
  describe("proc_start — 명령에 ASCII 가 아닌 문자가 있으면 거절한다(Finding 1)", () => {
    it.skipIf(process.platform !== "win32")(
      "윈도우에서는 명령에 한글이 섞이면 pm2 를 부르지 않고 거절한다",
      async () => {
        const { calls, runPm2 } = fakePm2({ jlist: { ok: true, stdout: "[]" } });
        const ex = makeExecutors([root], { runPm2, scriptDir });
        const r = await ex.proc_start!({ command: "node 서버.js", name: "asahi-111", cwd: projectDir });
        expect(r.ok).toBe(false);
        expect(r.content).toContain("ASCII");
        expect(calls).toEqual([]); // pm2 조회조차 없다 — 스크립트를 쓰기 전에, pm2 를 부르기 전에 거절한다
      },
    );

    it.skipIf(process.platform === "win32")(
      "POSIX 에서는 명령에 ASCII 가 아닌 문자가 있어도 거절하지 않는다(윈도우 전용 제약 — sh 는 스크립트를 코드페이지로 디코드하지 않는다)",
      async () => {
        const { calls, runPm2 } = fakePm2({ jlist: [{ ok: true, stdout: "[]" }, { ok: true, stdout: onlineJlist("asahi-111") }] });
        const ex = makeExecutors([root], { runPm2, scriptDir });
        const r = await ex.proc_start!({ command: "node 서버.js", name: "asahi-111", cwd: projectDir });
        expect(r.ok).toBe(true);
        expect(calls.some((c) => c[0] === "start")).toBe(true);
      },
    );
  });

  // ── Finding 3(Minor, 후속 리뷰) — 스크립트 폴더가 회원 폴더 안에 있으면 실행을 거절한다 ─────────
  // DEFAULT_SCRIPT_DIR 선언부의 "회원 폴더(roots) 밖에 둔다"는 지금까지 강제되지 않는 주석일
  // 뿐이었다 — roots(WORKER_ROOTS)에 언젠가 사용자 프로필 폴더가 포함되면(개인 워커에서는 충분히
  // 있을 수 있는 설정) scriptDir 이 roots 안에 들어오고, 그 순간부터 fs_write·fs_edit 로 회원이
  // 자기 .bat/.sh 파일 내용을 직접 고쳐 proc_start 가 실제로 실행할 내용을 바꿔치기할 수 있다.
  describe("proc_start — 스크립트 폴더가 회원 작업 폴더 안에 있으면 실행을 거절한다(Finding 3)", () => {
    it("scriptDir 이 roots 의 하위 폴더면 pm2 를 부르지 않고 명시적으로 거절한다", async () => {
      const scriptDirInsideRoot = path.join(root, "스크립트-보관");
      const { calls, runPm2 } = fakePm2({ jlist: { ok: true, stdout: "[]" } });
      const ex = makeExecutors([root], { runPm2, scriptDir: scriptDirInsideRoot });
      const r = await ex.proc_start!({ command: "npm run dev", name: "asahi-111", cwd: projectDir });
      expect(r.ok).toBe(false);
      expect(r.content).toContain("스크립트");
      expect(calls).toEqual([]); // pm2 조회조차 없다 — 설정 오류는 다른 무엇보다 먼저 걸러야 한다
    });

    it("scriptDir 이 roots 와 정확히 같아도 거절한다(경계값)", async () => {
      const { calls, runPm2 } = fakePm2({ jlist: { ok: true, stdout: "[]" } });
      const ex = makeExecutors([root], { runPm2, scriptDir: root });
      const r = await ex.proc_start!({ command: "npm run dev", name: "asahi-111", cwd: projectDir });
      expect(r.ok).toBe(false);
      expect(calls).toEqual([]);
    });

    it("scriptDir 이 roots 밖이면(정상 설정) 평소처럼 진행한다(회귀 방지)", async () => {
      const { calls, runPm2 } = fakePm2({ jlist: [{ ok: true, stdout: "[]" }, { ok: true, stdout: onlineJlist("asahi-111") }] });
      const ex = makeExecutors([root], { runPm2, scriptDir }); // beforeEach 의 scriptDir 은 root 의 형제 폴더
      const r = await ex.proc_start!({ command: "npm run dev", name: "asahi-111", cwd: projectDir });
      expect(r.ok).toBe(true);
      expect(calls.some((c) => c[0] === "start")).toBe(true);
    });
  });

  it("proc_stop 은 pm2 delete 를 부른다", async () => {
    const { calls, runPm2 } = fakePm2({ delete: { ok: true, stdout: "" } });
    const ex = makeExecutors([root], { runPm2, scriptDir });
    const r = await ex.proc_stop!({ name: "asahi-111" });
    expect(r.ok).toBe(true);
    expect(calls).toContainEqual(["delete", "asahi-111"]);
    // 트리 kill 되돌림(오진단 revert): pm2 delete 하나의 결과를 그대로, 조건부 문구 없이
    // 담백하게 전달한다 — 실측으로 pm2 delete 가 이미 트리 전체를 정리한다는 것이 확인됐다
    // (진짜 원인은 sh_exec 가 띄운 고아였다). "확인하지 못했어요" 같은 부가 설명이 붙지 않는다.
    expect(r.content).toBe("멈췄어요: asahi-111");
  });

  it("proc_stop 은 없는 이름이면 실패로 돌려준다", async () => {
    const { runPm2 } = fakePm2({ delete: { ok: false, stdout: "", stderr: "Process not found" } });
    const ex = makeExecutors([root], { runPm2, scriptDir });
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
      const ex = makeExecutors([root], { runPm2, scriptDir });
      const r = await ex.proc_stop!({ name: infraName });
      expect(r.ok, `${infraName} 을 멈출 수 있었다`).toBe(false);
      expect(r.content).toContain("회원");
      expect(calls.some((c) => c[0] === "delete"), `${infraName} 에 pm2 delete 가 호출됐다`).toBe(false);
    }
  });

  it("proc_list 는 jlist 를 파싱해 표로 돌려준다", async () => {
    const stdout = JSON.stringify([{ name: "asahi-111", pm2_env: { status: "online", pm_uptime: 0, restart_time: 2, args: ["run", "dev"], pm_exec_path: "npm" }, monit: { memory: 5 * 1024 * 1024 } }]);
    const { runPm2 } = fakePm2({ jlist: { ok: true, stdout } });
    const ex = makeExecutors([root], { runPm2, scriptDir });
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
    const ex = makeExecutors([root], { runPm2, scriptDir });
    const r = await ex.proc_list!({ onlyUserId: "111" });
    expect(r.ok).toBe(true);
    expect(r.content).toContain("asahi-111");
    expect(r.content).not.toContain("asahi-222");
    expect(r.content).not.toContain("asahi-worker");
  });

  // UX 회귀(2026-07-30): proc_list 가 존재하는 이유는 "뭐 돌고 있어?"에 모델의 기억이 아니라
  // 사실을 답하기 위해서다 — pm2 raw 값(스크립트 경로)을 그대로 보여주면 그 목적이 무색해진다.
  // 위 중복 거절 메시지 테스트와 같은 이유로, jlist 가 실제로 보고할 형태(cmd.exe 셸 래퍼 뒤에
  // 스크립트 경로)를 그대로 흉내내 "표에 보이는 값이 그 raw 경로가 아니라 스크립트 파일에서
  // 되찾은 원래 명령"이라는 것을 직접 증명한다.
  // 2026-08-07 CI: 위 "중복 거절 메시지" 케이스와 같은 이유로 윈도우에서만 돌린다 — 가짜 jlist 가
  // 윈도우 고유 형태(`cmd.exe /c <경로>.bat`)를 흉내내는데, 실제 스크립트 확장자는
  // shellFlavorOf(roots) 가 정하므로 리눅스 호스트에서는 `.sh` 다. 흉내낸 데이터가 그 호스트와
  // 안 맞는 것이지 구현 결함이 아니다.
  it.skipIf(process.platform !== "win32")("proc_list 는 스크립트 경로가 아니라 되찾은 원래 명령을 보여준다(UX 회귀)", async () => {
    const trapCommand = 'npm run dev -- --title="hi there"';
    const scriptPath = path.join(scriptDir, "asahi-111.bat");
    const runningWithScriptPath = JSON.stringify([
      {
        name: "asahi-111",
        pm2_env: { status: "online", pm_uptime: Date.now(), restart_time: 0, args: ["/c", scriptPath], pm_exec_path: "C:\\Windows\\System32\\cmd.exe" },
        monit: { memory: 1 },
      },
    ]);
    const { runPm2 } = fakePm2({ jlist: [{ ok: true, stdout: "[]" }, { ok: true, stdout: runningWithScriptPath }] });
    const ex = makeExecutors([root], { runPm2, scriptDir });
    const started = await ex.proc_start!({ command: trapCommand, name: "asahi-111", cwd: projectDir });
    expect(started.ok).toBe(true);

    const r = await ex.proc_list!({});
    expect(r.ok).toBe(true);
    expect(r.content).toContain(trapCommand);
    expect(r.content).not.toContain(scriptDir);
  });

  // Finding 2(Important, 후속 리뷰) 통합 검증: asahi-111 로 npm run dev(A)를 띄웠다가 멈추면
  // 스크립트 파일은 남는다(proc_stop 은 지우지 않는다). 같은 pm2 이름으로 sh_exec + pm2 start 를
  // 통해 완전히 다른 명령(B)을 직접 띄우는 것은 능력 모델이 명시적으로 허용하는 경로다 — 이때
  // proc_list 는 파일에 남은 죽은 A 의 명령이 아니라 pm2 가 지금 실제로 보고하는 B 를 보여줘야
  // 한다("워커가 확인한 사실을 답한다"는 proc_list 의 존재 이유 자체가 걸린 문제다).
  it("proc_list 는 같은 이름 아래 다른 명령이 돌면(재시작) 오래된 스크립트 파일 내용을 보여주지 않는다(Finding 2)", async () => {
    const { runPm2: firstRunPm2 } = fakePm2({ jlist: [{ ok: true, stdout: "[]" }, { ok: true, stdout: onlineJlist("asahi-111") }] });
    const first = makeExecutors([root], { runPm2: firstRunPm2, scriptDir });
    await first.proc_start!({ command: "npm run dev", name: "asahi-111", cwd: projectDir }); // 파일을 남긴다

    // 같은 이름으로 sh_exec + pm2 start 를 통해 완전히 다른 명령이 직접 떠 있는 상황을 재현한다 —
    // pm2 는 셸 래퍼 없이 그 명령을 곧바로 보고한다(isShellWrapper 가 아닌 형태, commandOf 참고).
    const differentCommandStdout = JSON.stringify([
      { name: "asahi-111", pm2_env: { status: "online", pm_uptime: Date.now(), restart_time: 0, args: ["other_app.py"], pm_exec_path: "python" }, monit: { memory: 1 } },
    ]);
    const { runPm2 } = fakePm2({ jlist: { ok: true, stdout: differentCommandStdout } });
    const second = makeExecutors([root], { runPm2, scriptDir }); // 같은 scriptDir(A 의 파일이 그대로 남아 있다)
    const r = await second.proc_list!({});
    expect(r.ok).toBe(true);
    expect(r.content).toContain("python other_app.py"); // pm2 가 지금 실제로 보고한 값(B)
    expect(r.content).not.toContain("npm run dev"); // 죽은 A 의 흔적(스크립트 파일 내용)이 아니다
  });

  // 되찾기가 실패해도(파일이 없거나 못 읽음) proc_list 전체가 죽어서는 안 된다 — pm2 가 보고한
  // 값(commandOf 의 결과)으로 조용히 대체한다. writeStartScript 를 거치지 않은 이름(asahi-999)
  // 이라 애초에 대응하는 스크립트 파일이 없는 상황을 그대로 재현한다.
  it("스크립트 파일이 없으면 proc_list 는 실패하지 않고 pm2 가 보고한 값을 그대로 보여준다(우아한 폴백)", async () => {
    const stdout = JSON.stringify([
      { name: "asahi-999", pm2_env: { status: "online", pm_uptime: 0, restart_time: 0, args: ["run", "dev"], pm_exec_path: "npm" }, monit: { memory: 1 } },
    ]);
    const { runPm2 } = fakePm2({ jlist: { ok: true, stdout } });
    const ex = makeExecutors([root], { runPm2, scriptDir });
    const r = await ex.proc_list!({});
    expect(r.ok).toBe(true);
    expect(r.content).toContain("npm run dev");
  });

  it("proc_list 는 labels 에 있는 이름으로 표시한다", async () => {
    const stdout = JSON.stringify([
      { name: "asahi-111", pm2_env: { status: "online", pm_uptime: 0, restart_time: 0, args: ["run", "dev"], pm_exec_path: "npm" }, monit: { memory: 1 } },
    ]);
    const { runPm2 } = fakePm2({ jlist: { ok: true, stdout } });
    const ex = makeExecutors([root], { runPm2, scriptDir });

    // onlyUserId 를 명시해 손님 호출로 둔다 — 소유자(onlyUserId 없음)는 pm2 이름을 함께 받으므로
    // 아래 not.toContain 이 성립하지 않는다. 이 테스트가 보는 것은 "이름으로 바뀌는가"이므로,
    // 식별자가 함께 나오지 않는 쪽을 골라 단정이 흐려지지 않게 한다.
    const r = await ex.proc_list!({ onlyUserId: "111", labels: { "111": "우성현" } });

    expect(r.ok).toBe(true);
    expect(r.content).toContain("우성현");
    expect(r.content).not.toContain("asahi-111");
  });

  // 실사용 회귀(2026-07-31): 사람 이름이 pm2 이름을 밀어내면서, 소유자가 proc_stop·proc_logs 에
  // 넘길 name 을 알아낼 창구가 사라졌다. 소유자의 "로그 보여줘"에 모델이 "우성현"을 name 으로
  // 넘겨 parseProcName 에 걸렸다. 아래 두 테스트가 그 분기를 양쪽에서 고정한다.
  it("proc_list 는 소유자(onlyUserId 없음)에게 pm2 이름을 함께 보여준다", async () => {
    const stdout = JSON.stringify([
      { name: "asahi-111", pm2_env: { status: "online", pm_uptime: 0, restart_time: 0, args: ["run", "dev"], pm_exec_path: "npm" }, monit: { memory: 1 } },
    ]);
    const { runPm2 } = fakePm2({ jlist: { ok: true, stdout } });
    const ex = makeExecutors([root], { runPm2, scriptDir });

    const r = await ex.proc_list!({ labels: { "111": "우성현" } });

    expect(r.ok).toBe(true);
    expect(r.content).toContain("우성현"); // 읽기 좋은 이름은 그대로
    expect(r.content).toContain("asahi-111"); // 도구에 넘길 식별자도 함께
  });

  it("proc_list 는 손님(onlyUserId 있음)에게는 pm2 이름을 보여주지 않는다", async () => {
    const stdout = JSON.stringify([
      { name: "asahi-111", pm2_env: { status: "online", pm_uptime: 0, restart_time: 0, args: ["run", "dev"], pm_exec_path: "npm" }, monit: { memory: 1 } },
    ]);
    const { runPm2 } = fakePm2({ jlist: { ok: true, stdout } });
    const ex = makeExecutors([root], { runPm2, scriptDir });

    const r = await ex.proc_list!({ onlyUserId: "111", labels: { "111": "우성현" } });

    expect(r.content).toContain("우성현");
    expect(r.content).not.toContain("asahi-111");
  });

  it("proc_list 는 labels 에 없는 사람은 예전처럼 asahi-<id> 로 표시한다", async () => {
    // 폴백을 지우면 이름을 아직 못 얻은 사용자와, 옛 봇(labels 를 안 보냄) + 새 워커가 섞여
    // 도는 배포 중간 상태에서 목록이 깨진다.
    const stdout = JSON.stringify([
      { name: "asahi-222", pm2_env: { status: "online", pm_uptime: 0, restart_time: 0, args: ["run", "dev"], pm_exec_path: "npm" }, monit: { memory: 1 } },
    ]);
    const { runPm2 } = fakePm2({ jlist: { ok: true, stdout } });
    const ex = makeExecutors([root], { runPm2, scriptDir });

    const r = await ex.proc_list!({ labels: { "111": "우성현" } });

    expect(r.content).toContain("asahi-222");
  });

  it("proc_list 는 labels 가 아예 없어도 깨지지 않는다(옛 봇 + 새 워커)", async () => {
    const stdout = JSON.stringify([
      { name: "asahi-111", pm2_env: { status: "online", pm_uptime: 0, restart_time: 0, args: ["run", "dev"], pm_exec_path: "npm" }, monit: { memory: 1 } },
    ]);
    const { runPm2 } = fakePm2({ jlist: { ok: true, stdout } });
    const ex = makeExecutors([root], { runPm2, scriptDir });

    const r = await ex.proc_list!({});

    expect(r.ok).toBe(true);
    expect(r.content).toContain("asahi-111");
  });

  it("proc_list 는 형태가 어긋난 labels 를 무시하고 폴백한다", async () => {
    // labels 는 네트워크 프레임을 건너온다 — 배열이나 숫자 값이 렌더링까지 흘러들면 안 된다.
    //
    // 최종 리뷰 Fix 3(사소함, 공허한 테스트): 프로세스 주인을 일부러 userId "0" 으로 둔다.
    // 예전 픽스처는 "asahi-111" 이었는데, 배열을 Object.entries 로 풀면 키가 "0" 이라 111 과
    // 절대 부딪히지 않았다 — strMap 의 Array.isArray 가드를 지워도 폴백이 그대로 나와 이
    // 테스트가 통과했다. 인덱스 키와 실제로 겹치는 id 를 써야 가드가 이 단정을 지탱한다.
    const stdout = JSON.stringify([
      { name: "asahi-0", pm2_env: { status: "online", pm_uptime: 0, restart_time: 0, args: ["run", "dev"], pm_exec_path: "npm" }, monit: { memory: 1 } },
    ]);
    const { runPm2 } = fakePm2({ jlist: { ok: true, stdout } });
    const ex = makeExecutors([root], { runPm2, scriptDir });

    const r = await ex.proc_list!({ labels: ["우성현"] });

    expect(r.ok).toBe(true);
    expect(r.content).toContain("asahi-0");
    expect(r.content).not.toContain("우성현");
  });

  it("proc_logs 는 nostream 으로 부르고 줄 수를 넘긴다", async () => {
    const { calls, runPm2 } = fakePm2({ logs: { ok: true, stdout: "로그 본문" } });
    const ex = makeExecutors([root], { runPm2, scriptDir });
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
    const ex = makeExecutors([root], { runPm2, scriptDir });
    await ex.proc_logs!({ name: "asahi-111" });
    const logs = calls.find((c) => c[0] === "logs")!;
    expect(logs).toContain("50");
  });

  it("proc_logs 는 lines 하한(1) 밑으로 내려가지 않는다", async () => {
    const { calls, runPm2 } = fakePm2({ logs: { ok: true, stdout: "로그" } });
    const ex = makeExecutors([root], { runPm2, scriptDir });
    await ex.proc_logs!({ name: "asahi-111", lines: -5 });
    const logs = calls.find((c) => c[0] === "logs")!;
    expect(logs).toContain("1");
    expect(logs).not.toContain("-5");
  });

  it("proc_logs 는 lines 상한(200)을 넘지 않는다", async () => {
    const { calls, runPm2 } = fakePm2({ logs: { ok: true, stdout: "로그" } });
    const ex = makeExecutors([root], { runPm2, scriptDir });
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
      const ex = makeExecutors([root], { runPm2, scriptDir });
      const r = await ex.proc_logs!({ name: infraName });
      expect(r.ok, `${infraName} 의 로그를 볼 수 있었다`).toBe(false);
      expect(r.content).toContain("회원");
      expect(calls.some((c) => c[0] === "logs"), `${infraName} 에 pm2 logs 가 호출됐다`).toBe(false);
    }
  });

  it("pm2 가 실패하면 stderr 를 사유로 돌려준다", async () => {
    const { runPm2 } = fakePm2({ jlist: { ok: false, stdout: "", stderr: "pm2 를 찾을 수 없습니다" } });
    const ex = makeExecutors([root], { runPm2, scriptDir });
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

// 실제 사고 원인 수정 검증(2026-07-30): 명령을 pm2 명령줄 인자로 넘기면 spawn(commandLine,
// {shell:true}) 가 그 문자열을 먼저 cmd.exe 로 파싱한다 — buildPm2CommandLine 의 MSVCRT \"
// 이스케이프를 cmd.exe 는 이해하지 못해(백슬래시를 리터럴로 두고 따옴표 개수만 센다) 첫 임베디드
// 따옴표 뒤 토큰 경계가 전부 어긋난다. 미니PC 실측(한글 경로뿐 아니라 ASCII 만 쓴 공백 경로로도
// 재현해 원인이 한글이 아니라 인용 자체임을 확인)으로 확정됐다 — 명령을 파일에 적어 넘기면 그
// 내용은 어떤 셸도 명령줄로 파싱하지 않으므로 인용 자체가 필요 없어진다. 이 파일 내용 형식을
// scriptContentFor 로 순수 함수로 떼어 직접 단정한다.
describe("scriptContentFor — 스크립트 파일 내용(명령을 파일에 적으면 셸 인용이 필요 없다)", () => {
  it("윈도우는 @echo off 다음 줄에 명령을 인용 없이 그대로 적는다(미니PC 실측으로 동작을 확인한 형태)", () => {
    expect(scriptContentFor("npm run dev", "win32")).toBe("@echo off\nnpm run dev\n");
  });

  it("POSIX 는 셔뱅 다음 줄에 명령을 그대로 적는다", () => {
    expect(scriptContentFor("npm run dev", "posix")).toBe("#!/bin/sh\nnpm run dev\n");
  });

  it("임베디드 따옴표가 든 명령도 이스케이프 없이 한 줄 그대로 적는다(실제 사고 재현 명령)", () => {
    const cmd = 'npm run dev -- --title="hi there"';
    expect(scriptContentFor(cmd, "win32")).toBe(`@echo off\n${cmd}\n`);
  });
});

describe("writeStartScript — 회원 명령을 스크립트 파일로 남긴다", () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), "asahi-scripts-unit-")); });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it("이름별로 파일 하나를 만들고 내용을 그대로 담는다", async () => {
    const p = await writeStartScript(dir, "asahi-111", "npm run dev", "win32");
    expect(p).toBe(path.join(dir, "asahi-111.bat"));
    expect(fs.readFileSync(p, "utf8")).toBe("@echo off\nnpm run dev\n");
  });

  // proc_start 는 같은 이름이 이미 떠 있으면 이 단계에 도달하기 전에 거절한다(위 "조용히
  // 교체하지 않는다" 참고) — 그러니 이 지점에 왔다는 것 자체가 "이 이름으로 새로 써도 안전하다"는
  // 뜻이다. 재시작 때마다 최신 명령만 남기고 예전 파일이 쌓이지 않는 것이 의도된 동작이다.
  it("같은 이름으로 다시 부르면 덮어쓴다(재시작마다 최신 명령만 남는다)", async () => {
    await writeStartScript(dir, "asahi-111", "npm run old", "win32");
    const p = await writeStartScript(dir, "asahi-111", "npm run new", "win32");
    const content = fs.readFileSync(p, "utf8");
    expect(content).toContain("npm run new");
    expect(content).not.toContain("npm run old");
  });

  it("스크립트 폴더가 없으면 만들어서 쓴다", async () => {
    const nested = path.join(dir, "a", "b");
    const p = await writeStartScript(nested, "asahi-111", "npm run dev", "win32");
    expect(fs.existsSync(p)).toBe(true);
  });

  // name 은 오늘 remoteTools.ts 가 항상 procNameFor(디스코드 userId)로 주입해 "asahi-<숫자>"
  // 형태만 온다(이 실행기에 직접 닿는 다른 프로덕션 경로가 없다) — 그래도 이 값을 파일 경로
  // 조각으로 쓰므로, 경로 구분자·'..' 가 섞여도 스크립트 폴더 밖으로 못 나가는지 방어적으로
  // 확인한다(paths.ts 의 joinUnderRoot 와 같은 종류의 방어를 이 파일에서도 독립적으로 건다).
  it("이름에 경로 구분자·'..'가 섞여도 스크립트 폴더 밖으로 못 나간다(방어적 sanitize)", async () => {
    const p = await writeStartScript(dir, "../../evil", "npm run dev", "win32");
    expect(path.dirname(p)).toBe(dir);
    expect(fs.existsSync(p)).toBe(true);
  });
});

// UX 회귀 수정 검증(2026-07-30): writeStartScript 가 회원 명령을 pm2 명령줄에서 스크립트 파일로
// 옮기면서, pm2 jlist 가 돌려주는 command 는 더 이상 사람이 읽는 명령이 아니라 그 스크립트
// "경로"가 됐다 — proc_list·중복 거절 메시지가 회원에게 그 경로를 그대로 보여주면 "뭐 돌고
// 있어?"에 사실을 답한다는 이 기능의 존재 이유가 무색해진다. recoverCommands 는 이름(pm2 프로세스
// 이름)만으로 writeStartScript 가 썼을 경로를 그대로 다시 계산해(scriptPathFor, 두 곳이 규칙을
// 공유한다) 그 파일을 직접 읽어 원래 명령을 되찾는다 — pm2 가 무엇을 보고했든 무관하게 항상
// 우리가 디스크에 쓴 값이 진실이다. 아래는 이 되찾기 자체를 직접 단정한다(통합 테스트는 위
// "proc_* 실행기" describe 안의 proc_list·중복 거절 테스트 참고).
describe("recoverCommands — pm2 jlist 의 command(스크립트 경로)를 원래 명령으로 되찾는다", () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), "asahi-recover-")); });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  const proc = (over: Partial<ProcInfo> = {}): ProcInfo => ({
    name: "asahi-111",
    userId: "111",
    command: "(pm2 가 보고한 원래 값 — 되찾기 성공 시 버려져야 한다)",
    status: "online",
    startedAtMs: null,
    memoryBytes: null,
    restarts: 0,
    ...over,
  });

  // Finding 2(Important, 후속 리뷰) 이후: recoverCommands 는 pm2 가 실제로 보고한 값이 그 스크립트
  // 경로를 가리킬 때만 파일을 신뢰한다(아래 recoverCommands 선언부 참고) — 그래서 되찾기가
  // "성공해야 하는" 테스트들은 command 를 "pm2 가 실제로 이 스크립트를 통해 그 프로세스를
  // 실행했다"고 보고했을 형태(스크립트 경로 자체 — commandOf 가 셸 래퍼를 걷어내면 결국 경로
  // 하나만 남는다)로 명시한다. "되찾기가 실패해야 하는" 테스트만 command 를 다른 값으로 둔다.
  const scriptPathOf = (name: string) => path.join(dir, `${name}.bat`);

  it("회원 프로세스는 스크립트 파일에서 읽은 원래 명령으로 command 를 덮어쓴다", async () => {
    await writeStartScript(dir, "asahi-111", "npm run dev", "win32");
    const [r] = await recoverCommands([proc({ command: scriptPathOf("asahi-111") })], dir, "win32");
    expect(r!.command).toBe("npm run dev");
  });

  it("임베디드 따옴표가 든 명령도 이스케이프 없이 그대로 되찾는다", async () => {
    const trapCommand = 'npm run dev -- --title="hi there"';
    await writeStartScript(dir, "asahi-111", trapCommand, "win32");
    const [r] = await recoverCommands([proc({ command: scriptPathOf("asahi-111") })], dir, "win32");
    expect(r!.command).toBe(trapCommand);
  });

  it("스크립트 파일이 없으면(회원이 지웠거나 애초에 없음) pm2 가 보고한 값을 그대로 둔다(우아한 폴백)", async () => {
    const [r] = await recoverCommands([proc({ name: "asahi-999", userId: "999" })], dir, "win32");
    expect(r!.command).toBe("(pm2 가 보고한 원래 값 — 되찾기 성공 시 버려져야 한다)");
  });

  // userId===null 은 봇·워커 자신의 PM2 앱(asahi-assistant·asahi-worker, deploy/ecosystem.config.cjs)
  // — writeStartScript 를 거치지 않으므로 대응하는 스크립트 파일 자체가 없다. 이름이 우연히
  // 겹쳐 파일이 실제로 존재해도 손대지 않아야 한다는 것까지 확인한다(읽으면 안 되는 파일이
  // 실수로 읽히는 회귀를 잡기 위해 일부러 만들어 둔다).
  it("userId 가 null 인 프로세스(봇·워커 자신)는 파일이 있어도 건드리지 않는다", async () => {
    await writeStartScript(dir, "asahi-worker", "이 파일은 읽히면 안 된다", "win32");
    const [r] = await recoverCommands(
      [proc({ name: "asahi-worker", userId: null, command: "node dist/worker.js" })],
      dir,
      "win32",
    );
    expect(r!.command).toBe("node dist/worker.js");
  });

  it("여러 프로세스를 한 번에 처리한다(각자 자기 이름의 파일만 읽는다)", async () => {
    await writeStartScript(dir, "asahi-111", "npm run dev", "win32");
    await writeStartScript(dir, "asahi-222", "npm run build", "win32");
    const [r1, r2] = await recoverCommands(
      [
        proc({ name: "asahi-111", userId: "111", command: scriptPathOf("asahi-111") }),
        proc({ name: "asahi-222", userId: "222", command: scriptPathOf("asahi-222") }),
      ],
      dir,
      "win32",
    );
    expect(r1!.command).toBe("npm run dev");
    expect(r2!.command).toBe("npm run build");
  });

  // Finding 2(Important, 후속 리뷰): "이름이 같은 파일이 있다"와 "이 프로세스가 실제로 그 파일에서
  // 시작됐다"는 서로 다른 사실이다. proc_stop 은 스크립트 파일을 지우지 않으므로(writeStartScript
  // 선언부 참고) 파일이 프로세스보다 오래 산다 — 회원이 asahi-111 로 A(npm run old-dev)를 띄웠다가
  // 멈추고(파일은 남는다), 같은 pm2 이름으로 sh_exec + pm2 start 를 통해 완전히 다른 명령 B 를
  // 직접 띄우면(능력 모델이 명시적으로 허용하는 경로), pm2 는 이제 B 를 보고한다 — 그런데도 파일
  // "이름"만 보고 되찾으면 죽은 A 의 명령(파일 내용)을 지금 도는 B 인 것처럼 보여주게 된다. 그
  // 프로세스가 실제로 그 스크립트에서 시작됐다는 증거(pm2 가 보고한 값이 그 경로를 가리킴)가 없는
  // 한 파일을 신뢰하지 않는다.
  it("파일은 있어도 pm2 가 보고한 값이 그 스크립트 경로를 가리키지 않으면 파일 내용으로 덮어쓰지 않는다(Finding 2)", async () => {
    await writeStartScript(dir, "asahi-111", "npm run old-dev", "win32"); // 죽은 프로세스의 흔적(파일은 남는다)
    const [r] = await recoverCommands(
      [proc({ command: "python other_app.py" })], // pm2 가 실제로 보고한 값 — 스크립트 경로를 전혀 언급하지 않는다
      dir,
      "win32",
    );
    // 파일이 존재하고 이름도 일치하지만, pm2 가 보고한 값은 그 파일을 가리키지 않는다 — 파일
    // 내용이 아니라 pm2 가 보고한 값(지금 실제로 도는 프로세스)을 그대로 남겨야 한다.
    expect(r!.command).toBe("python other_app.py");
  });

  // Finding 5(Minor, 후속 리뷰): writeStartScript 는 항상 "헤더\n명령\n" 두 줄 형식으로만 쓰므로,
  // 이 형식이 깨진 파일은 사람이 스크립트를 직접 열어 고친 경우에만 생긴다(줄바꿈 자체가 없는
  // 등). commandFromScriptContent 의 헤더 가드(headerEnd===-1 이면 undefined)를 지우면 이 경우
  // 헤더(@echo off)까지 포함한 파일 전체가 통째로 "명령"인 것처럼 노출된다 — 그 회귀를 잡는
  // 테스트가 없었다.
  it("스크립트 파일이 예상 형식과 다르면(줄바꿈이 없음 — 사람이 직접 고친 경우) 헤더까지 노출하지 않고 pm2 가 보고한 값을 그대로 둔다(Finding 5)", async () => {
    const scriptPath = scriptPathOf("asahi-111");
    fs.writeFileSync(scriptPath, "@echo off npm run dev"); // 줄바꿈 없이 한 줄로 뭉개짐 — writeStartScript 는 이런 형식을 만들지 않는다
    const [r] = await recoverCommands([proc({ command: scriptPath })], dir, "win32");
    expect(r!.command).not.toContain("@echo off");
    expect(r!.command).toBe(scriptPath); // 되찾기 실패 — pm2 가 보고한 원래 값(스크립트 경로)을 그대로 둔다
  });

  // Finding 6(Minor, 후속 리뷰): commandFromScriptContent 는 명령 자체에 섞인 줄바꿈을 잃지 않고
  // 그대로 되돌리는데, renderProcList(proc.ts)는 "프로세스 하나 = 줄 하나"를 전제한다 — 줄바꿈이
  // 그대로 되찾아지면 표에 유령 행을 만들어 모델이 실제보다 프로세스가 더 많다고 읽을 수 있다.
  it("명령에 줄바꿈이 섞여 있으면 한 줄로 뭉개 되찾는다(Finding 6 — renderProcList 의 '한 줄 = 프로세스 하나' 전제를 지킨다)", async () => {
    const multilineCommand = "npm run dev\n--title=여러줄";
    await writeStartScript(dir, "asahi-111", multilineCommand, "win32");
    const [r] = await recoverCommands([proc({ command: scriptPathOf("asahi-111") })], dir, "win32");
    expect(r!.command).not.toContain("\n");
    expect(r!.command).not.toContain("\r");
    // 뭉개졌을 뿐 정보 자체는 잃지 않는다 — 회원이 실제로 무엇을 실행했는지는 여전히 알 수 있다.
    expect(r!.command).toContain("npm run dev");
    expect(r!.command).toContain("--title=여러줄");
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

describe("git_publish / git_restore — 봇 전용 실행기", () => {
  let root: string;
  beforeEach(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "asahi-git-ex-")));
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  // 모델에게 노출되지 않는다는 것이 이 두 도구의 전제다 — 노출되면 모델이 cloneUrl·token 을
  // 정할 수 있게 되고, 워커가 임의 원격으로 푸시하는 표면이 열린다.
  it("모델에게 노출되는 원격 도구 목록에 없다", async () => {
    const { REMOTE_TOOL_NAMES } = await import("../src/core/remoteTools.js");
    expect(REMOTE_TOOL_NAMES).not.toContain("git_publish");
    expect(REMOTE_TOOL_NAMES).not.toContain("git_restore");
  });

  it("워커 루트 밖 경로는 경로 관문이 거절한다", async () => {
    const ex = makeExecutors([root], { runGit: async () => ({ ok: true, stdout: "" }) });
    const outside = path.join(root, "..", "asahi-git-ex-outside");
    for (const tool of ["git_publish", "git_restore"] as const) {
      const r = await ex[tool]!({ dir: outside, cloneUrl: "https://g/x.git", token: "t" });
      expect(r.ok).toBe(false);
      expect(r.content).toContain("폴더");
    }
  });

  it("dir 인자가 없으면 거절한다", async () => {
    const ex = makeExecutors([root], { runGit: async () => ({ ok: true, stdout: "" }) });
    expect((await ex.git_publish!({ cloneUrl: "https://g/x.git" })).ok).toBe(false);
    expect((await ex.git_restore!({ cloneUrl: "https://g/x.git" })).ok).toBe(false);
  });

  it("git_publish 는 .gitignore 를 실제로 쓰고 스테이징 용량을 잰다", async () => {
    const proj = path.join(root, "proj");
    fs.mkdirSync(proj);
    fs.writeFileSync(path.join(proj, "big.txt"), "x".repeat(1234));
    const ex = makeExecutors([root], {
      runGit: async (args) => ({ ok: true, stdout: args.includes("ls-files") ? "big.txt\n" : "" }),
    });
    const r = await ex.git_publish!({ dir: proj, cloneUrl: "https://g/x.git", token: "t", authorName: "n", authorEmail: "e" });
    expect(r.ok).toBe(true);
    expect(fs.readFileSync(path.join(proj, ".gitignore"), "utf8")).toContain("node_modules/");
  });

  // 파괴적인 쪽으로 기울면 안 된다 — 문자열 "true" 나 1 은 true 가 아니다.
  it("git_restore 의 discardLocal 은 정확히 boolean true 일 때만 지운다", async () => {
    const proj = path.join(root, "proj");
    fs.mkdirSync(proj);
    fs.writeFileSync(path.join(proj, "mine.txt"), "작업중");
    const dirty = async (args: string[]) => ({ ok: true, stdout: args.includes("status") ? " M mine.txt\n" : "" });

    const ex = makeExecutors([root], { runGit: dirty });
    for (const v of ["true", 1, undefined]) {
      const r = await ex.git_restore!({ dir: proj, cloneUrl: "https://g/x.git", token: "t", discardLocal: v });
      expect(r.ok).toBe(false);
      expect(fs.existsSync(path.join(proj, "mine.txt"))).toBe(true);
    }

    const r = await ex.git_restore!({ dir: proj, cloneUrl: "https://g/x.git", token: "t", discardLocal: true });
    expect(r.ok).toBe(true);
    expect(fs.existsSync(proj)).toBe(false);
  });
});
