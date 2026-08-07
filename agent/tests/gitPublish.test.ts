import { describe, it, expect } from "vitest";
import { DEFAULT_EXCLUDES, gitignoreBody, publishArgv, pushEnv, runPublish } from "../src/remote/gitPublish.js";
import type { RunGit } from "../src/remote/gitCommit.js";

const base = {
  dir: "/ws/111/todo-app",
  cloneUrl: "https://github.com/semicollon-club/todo-app.git",
  token: "ghs_secret",
  message: "발행",
  authorName: "홍길동",
  authorEmail: "1@users.noreply.github.com",
};

describe("제외 규칙", () => {
  it("비밀·빌드 산출물을 기본으로 뺀다", () => {
    for (const p of ["node_modules/", ".env", "dist/", "*.pem"]) expect(DEFAULT_EXCLUDES).toContain(p);
  });

  it("gitignore 본문은 한 줄에 하나씩이고 끝에 줄바꿈이 있다", () => {
    const body = gitignoreBody();
    expect(body.endsWith("\n")).toBe(true);
    expect(body.split("\n").filter(Boolean)).toEqual([...DEFAULT_EXCLUDES]);
  });

  it("추가 제외를 덧붙일 수 있다", () => {
    expect(gitignoreBody(["secret.txt"]).split("\n")).toContain("secret.txt");
  });
});

describe("publishArgv", () => {
  // 토큰이 명령줄에 실리면 같은 계정의 프로세스 목록으로 새어 나간다(설계 §9).
  it("어떤 인자에도 토큰이 들어가지 않는다", () => {
    const flat = publishArgv(base).flat().join(" ");
    expect(flat).not.toContain("ghs_secret");
  });

  it("remote 를 토큰 없는 URL 로 설정한다", () => {
    const flat = publishArgv(base).flat().join(" ");
    expect(flat).toContain("https://github.com/semicollon-club/todo-app.git");
  });

  it("author 를 부원 이름으로 지정한다", () => {
    const commit = publishArgv(base).find((a) => a[0] === "commit");
    expect(commit).toBeDefined();
    expect(commit!.join(" ")).toContain("--author=홍길동 <1@users.noreply.github.com>");
  });

  it("현재 브랜치를 main 으로 고정해 푸시한다", () => {
    const argv = publishArgv(base);
    expect(argv.some((a) => a[0] === "branch" && a.includes("main"))).toBe(true);
    expect(argv.some((a) => a[0] === "push")).toBe(true);
  });
});

describe("pushEnv", () => {
  // 토큰을 환경변수로만 넘긴다 — .git/config 에도 명령줄에도 남기지 않는다.
  it("자격증명을 환경변수로 넘긴다", () => {
    const env = pushEnv("ghs_secret");
    expect(Object.values(env).join(" ")).toContain("ghs_secret");
  });
});

describe("runPublish", () => {
  // 모든 케이스가 쓰는 기본 의존성. 용량은 작게, 파일 쓰기는 기록만.
  const deps = (runGit: RunGit, size = 10) => {
    const written: Array<[string, string]> = [];
    return {
      written,
      deps: { runGit, writeFile: async (p: string, b: string) => { written.push([p, b]); }, sizeOf: async () => size },
    };
  };
  const okGit: RunGit = async () => ({ ok: true, stdout: "" });

  it("모든 git 명령이 성공하면 ok 다", async () => {
    const calls: string[][] = [];
    const runGit: RunGit = async (args) => { calls.push(args); return { ok: true, stdout: "" }; };
    const r = await runPublish(base, deps(runGit).deps);
    expect(r.ok).toBe(true);
    // publishArgv 목록 + add 뒤의 ls-files 한 번
    expect(calls.length).toBe(publishArgv(base).length + 1);
  });

  // 이것이 제외 규칙이 실제로 집행되는 유일한 지점이다 — 목록만 있고 파일을 안 쓰면
  // node_modules 와 .env 가 그대로 커밋된다.
  it("add 전에 .gitignore 를 쓴다", async () => {
    const { written, deps: d } = deps(okGit);
    await runPublish(base, d);
    expect(written.length).toBe(1);
    expect(written[0][0]).toBe("/ws/111/todo-app/.gitignore");
    expect(written[0][1]).toContain("node_modules/");
    expect(written[0][1]).toContain(".env");
  });

  it("상한을 넘으면 commit·push 전에 멈춘다", async () => {
    const calls: string[][] = [];
    const runGit: RunGit = async (args) => { calls.push(args); return { ok: true, stdout: "big.bin\n" }; };
    const r = await runPublish(base, deps(runGit, 60 * 1024 * 1024).deps);
    expect(r.ok).toBe(false);
    expect(r.content).toContain("50MB");
    expect(calls.some((c) => c.includes("commit") || c.includes("push"))).toBe(false);
  });

  // 실패를 삼키면 "올렸다"고 말해놓고 아무것도 안 올라간 상태가 된다 — 이 저장소가 결함 유형으로
  // 다루는 "안내와 실제가 어긋남" 그 자체다.
  it("중간에 실패하면 거기서 멈추고 실패를 돌려준다", async () => {
    const calls: string[][] = [];
    const runGit: RunGit = async (args) => {
      calls.push(args);
      return args.includes("push") ? { ok: false, stdout: "rejected" } : { ok: true, stdout: "" };
    };
    const r = await runPublish(base, deps(runGit).deps);
    expect(r.ok).toBe(false);
    expect(r.content).toContain("push");
    expect(calls[calls.length - 1]).toContain("push");
  });

  // push 에만 토큰을 준다 — 토큰이 닿는 프로세스 수를 최소로 둔다.
  it("자격증명은 push 에만 넘긴다", async () => {
    const seen: Array<{ cmd: string[]; env: Record<string, string> | undefined }> = [];
    const runGit: RunGit = async (args, env) => { seen.push({ cmd: args, env }); return { ok: true, stdout: "" }; };
    await runPublish(base, deps(runGit).deps);
    const withToken = seen.filter((s) => s.env !== undefined);
    expect(withToken.length).toBe(1);
    expect(withToken[0].cmd).toContain("push");
    expect(withToken[0].env!.ASAHI_GH_TOKEN).toBe("ghs_secret");
  });

  it("실패 메시지에도 토큰이 섞이지 않는다", async () => {
    const runGit: RunGit = async () => ({ ok: false, stdout: "fatal: could not read Password for 'https://ghs_secret@github.com'" });
    const r = await runPublish(base, deps(runGit).deps);
    expect(r.content).not.toContain("ghs_secret");
  });
});
