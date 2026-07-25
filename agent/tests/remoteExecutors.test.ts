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

  it("도구 6개를 정확히 노출한다", () => {
    expect(Object.keys(ex).sort()).toEqual(["fs_edit", "fs_glob", "fs_grep", "fs_read", "fs_write", "sh_exec"]);
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
    for (const tool of ["fs_read", "fs_write", "fs_edit", "fs_glob", "fs_grep"]) {
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
});
