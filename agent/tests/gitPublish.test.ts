import { describe, it, expect } from "vitest";
import {
  DEFAULT_EXCLUDES, gitignoreBody, publishArgv, pushEnv, runPublish,
  inspectLocal, runRestore,
} from "../src/remote/gitPublish.js";
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

describe("inspectLocal", () => {
  const yes = async () => true;
  const no = async () => false;

  it("폴더가 없으면 missing", async () => {
    expect(await inspectLocal("/ws/x", (async () => ({ ok: true, stdout: "" })) as RunGit, no)).toBe("missing");
  });

  it("status 가 비어 있으면 clean", async () => {
    expect(await inspectLocal("/ws/x", (async () => ({ ok: true, stdout: "" })) as RunGit, yes)).toBe("clean");
  });

  it("status 에 내용이 있으면 dirty", async () => {
    const runGit: RunGit = async () => ({ ok: true, stdout: " M src/a.ts\n?? b.txt\n" });
    expect(await inspectLocal("/ws/x", runGit, yes)).toBe("dirty");
  });

  // git 저장소가 아니면 status 가 실패한다. 그것을 clean 으로 보면 다음 단계가 pull 을 시도해
  // 엉뚱한 오류를 낸다 — 폴더는 있는데 저장소가 아닌 것은 "망가진" 쪽에 가깝다.
  it("git 저장소가 아니면 dirty 로 본다(안전한 쪽)", async () => {
    const runGit: RunGit = async () => ({ ok: false, stdout: "not a git repository" });
    expect(await inspectLocal("/ws/x", runGit, yes)).toBe("dirty");
  });
});

describe("runRestore", () => {
  const a = { dir: "/ws/111/todo-app", cloneUrl: "https://github.com/semicollon-club/todo-app.git", token: "ghs_secret", discardLocal: false };
  const never = async () => { throw new Error("불려서는 안 됩니다"); };

  it("없으면 clone 한다", async () => {
    const calls: string[][] = [];
    const runGit: RunGit = async (args) => { calls.push(args); return { ok: true, stdout: "" }; };
    const r = await runRestore(a, { runGit, exists: async () => false, rmrf: never });
    expect(r.ok).toBe(true);
    expect(calls.some((c) => c.includes("clone"))).toBe(true);
  });

  it("깨끗하면 pull --ff-only 한다", async () => {
    const calls: string[][] = [];
    const runGit: RunGit = async (args) => { calls.push(args); return { ok: true, stdout: "" }; };
    const r = await runRestore(a, { runGit, exists: async () => true, rmrf: never });
    expect(r.ok).toBe(true);
    const pull = calls.find((c) => c.includes("pull"));
    expect(pull).toBeDefined();
    expect(pull!).toContain("--ff-only");
  });

  // 이 케이스가 이 도구의 핵심이다 — 복구하려다 방금 한 작업을 없애면 안 된다(설계 §7.1).
  it("더러우면 아무것도 하지 않고 거절한다", async () => {
    const calls: string[][] = [];
    const runGit: RunGit = async (args) => {
      calls.push(args);
      return args.includes("status") ? { ok: true, stdout: " M a.ts\n" } : { ok: true, stdout: "" };
    };
    const r = await runRestore(a, { runGit, exists: async () => true, rmrf: never });
    expect(r.ok).toBe(false);
    expect(r.content).toContain("저장하지 않은 변경");
    expect(calls.some((c) => c.includes("pull") || c.includes("clone"))).toBe(false);
  });

  it("discardLocal 이면 더러워도 지우고 새로 clone 한다", async () => {
    const removed: string[] = [];
    const calls: string[][] = [];
    const runGit: RunGit = async (args) => {
      calls.push(args);
      return args.includes("status") ? { ok: true, stdout: " M a.ts\n" } : { ok: true, stdout: "" };
    };
    const r = await runRestore({ ...a, discardLocal: true }, {
      runGit, exists: async () => true, rmrf: async (p) => { removed.push(p); },
    });
    expect(r.ok).toBe(true);
    expect(removed).toEqual(["/ws/111/todo-app"]);
    expect(calls.some((c) => c.includes("clone"))).toBe(true);
    expect(r.content).toContain("지우고");
  });

  it("clone URL 과 실패 메시지에 토큰이 없다", async () => {
    const runGit: RunGit = async () => ({ ok: false, stdout: "fatal: https://ghs_secret@github.com denied" });
    const r = await runRestore(a, { runGit, exists: async () => false, rmrf: never });
    expect(r.content).not.toContain("ghs_secret");
  });

  // 브리프의 Interfaces 절은 이 태스크가 pushEnv 를 소비한다고 적어 두었지만, 브리프 Step 3
  // 예시 코드는 clone·pull 호출에 env 를 넘기지 않는다 — 그대로 옮기면 리포가 기본값대로
  // 비공개일 때(설계 §4) 되받기가 인증 실패로 항상 막힌다. 위 테스트들은 "인자에 토큰 문자열이
  // 없다"만 확인하고 "애초에 인증 자체를 시도했다"는 별개다 — 이 테스트가 그 회귀를 잡는다.
  it("clone·pull 에도 자격증명을 넘긴다 — 비공개 리포 인증(설계 §7.1 · §9)", async () => {
    const seen: Array<{ cmd: string[]; env: Record<string, string> | undefined }> = [];
    const runGit: RunGit = async (args, env) => { seen.push({ cmd: args, env }); return { ok: true, stdout: "" }; };

    await runRestore(a, { runGit, exists: async () => false, rmrf: never }); // clone 경로
    await runRestore(a, { runGit, exists: async () => true, rmrf: never }); // pull 경로(깨끗함)

    const withToken = seen.filter((s) => s.env?.ASAHI_GH_TOKEN === "ghs_secret");
    // clone 은 인덱스 0 이 아니다 — -c 가 앞에 온다(그래야 새 저장소 config 에 안 남는다).
    expect(withToken.some((s) => s.cmd.includes("clone"))).toBe(true);
    expect(withToken.some((s) => s.cmd.includes("pull"))).toBe(true);
    // 로컬 상태만 보는 status 호출에는 자격증명을 얹지 않는다 — push 가 add·init 같은 로컬
    // 명령에는 env 를 안 주는 것과 같은 이유다.
    expect(seen.some((s) => s.cmd.includes("status") && s.env !== undefined)).toBe(false);
  });
});

describe("committer 신원", () => {
  // git 은 author 와 committer 를 따로 요구한다. --author 만 주면 전역 설정이 없는 워커에서
  // "Committer identity unknown" 으로 커밋이 통째로 실패한다 — 2026-08-07 첫 실사용이 이걸로
  // 막혔고, 그때 모델이 sh_exec 로 공유 미니PC 의 전역 git 설정을 바꿔서 우회했다.
  it("commit 호출에 committer 신원을 -c 로 실어 준다", async () => {
    const seen: string[][] = [];
    const runGit: RunGit = async (args) => { seen.push(args); return { ok: true, stdout: "" }; };
    await runPublish(base, { runGit, writeFile: async () => {}, sizeOf: async () => 1 });

    const commit = seen.find((a) => a.includes("commit"));
    expect(commit).toBeDefined();
    expect(commit!.join(" ")).toContain("user.name=");
    expect(commit!.join(" ")).toContain("user.email=");
  });

  // 발행이 공유 기계의 전역 설정에 기대면, 그 설정이 없는 워커에서 조용히 실패하고 누군가
  // 또 전역을 바꿔 우회하게 된다.
  it("전역 git 설정을 바꾸는 명령은 하나도 실행하지 않는다", async () => {
    const seen: string[][] = [];
    const runGit: RunGit = async (args) => { seen.push(args); return { ok: true, stdout: "" }; };
    await runPublish(base, { runGit, writeFile: async () => {}, sizeOf: async () => 1 });
    expect(seen.some((a) => a.includes("config") || a.includes("--global"))).toBe(false);
  });

  // publishArgv 의 계약: 0번째는 항상 서브커맨드다. -c 를 그 앞에 끼우면 runPublish 의 단계
  // 판정(add·push·commit·remote remove)이 통째로 깨진다 — Task 4 에서 실제로 났던 결함이다.
  it("publishArgv 는 여전히 0번째가 서브커맨드다", () => {
    for (const cmd of publishArgv(base)) {
      expect(cmd[0].startsWith("-")).toBe(false);
    }
  });
});

describe("자격증명 헬퍼 체인", () => {
  // -c credential.helper=X 는 체인에 *추가*된다. 시스템 설정에 이미 헬퍼가 있으면(Git for
  // Windows 기본 credential.helper=manager) git 이 그쪽에 먼저 묻고 그 결과를 쓴다 — 우리
  // 토큰은 쓰이지도 않고, 비공개 리포는 404 "Repository not found" 를 준다. 2026-08-08
  // 실사용에서 리포가 멀쩡히 있는데도 그 메시지가 나왔다. 빈 값이 먼저 와야 체인이 비워진다.
  const chainIsReset = (args: string[]) => {
    const i = args.indexOf("credential.helper=");
    const j = args.findIndex((a) => a.startsWith("credential.helper=!"));
    return i >= 0 && j >= 0 && i < j;
  };

  it("push 는 빈 헬퍼로 체인을 비운 뒤 우리 헬퍼를 얹는다", async () => {
    const seen: string[][] = [];
    const runGit: RunGit = async (args) => { seen.push(args); return { ok: true, stdout: "" }; };
    await runPublish(base, { runGit, writeFile: async () => {}, sizeOf: async () => 1 });
    const push = seen.find((a) => a.includes("push"));
    expect(push).toBeDefined();
    expect(chainIsReset(push!)).toBe(true);
  });

  it("clone 도 체인을 비운다", async () => {
    const seen: string[][] = [];
    const runGit: RunGit = async (args) => { seen.push(args); return { ok: true, stdout: "" }; };
    await runRestore(
      { dir: "/ws/x", cloneUrl: "https://g/x.git", token: "t", discardLocal: false },
      { runGit, exists: async () => false, rmrf: async () => {} },
    );
    const clone = seen.find((a) => a.includes("clone"));
    expect(clone).toBeDefined();
    expect(chainIsReset(clone!)).toBe(true);
  });

  it("pull 도 체인을 비운다", async () => {
    const seen: string[][] = [];
    const runGit: RunGit = async (args) => { seen.push(args); return { ok: true, stdout: "" }; };
    await runRestore(
      { dir: "/ws/x", cloneUrl: "https://g/x.git", token: "t", discardLocal: false },
      { runGit, exists: async () => true, rmrf: async () => {} },
    );
    const pull = seen.find((a) => a.includes("pull"));
    expect(pull).toBeDefined();
    expect(chainIsReset(pull!)).toBe(true);
  });

  it("체인을 비우는 인자에도 토큰은 없다", async () => {
    const seen: string[][] = [];
    const runGit: RunGit = async (args) => { seen.push(args); return { ok: true, stdout: "" }; };
    await runPublish(base, { runGit, writeFile: async () => {}, sizeOf: async () => 1 });
    expect(seen.flat().join(" ")).not.toContain("ghs_secret");
  });
});

describe("clone 이 새 저장소 config 를 오염시키지 않는가", () => {
  // `git clone -c k=v` (clone 자신의 옵션)는 그 값을 새 저장소의 .git/config 에 **영구 기록**
  // 한다. 2026-08-08 실사용에서 되받은 저장소에 [credential] 두 줄이 남은 것을 확인했다.
  // 토큰은 없지만, 부원의 저장소에 우리가 넣은 설정이 남으면 그 사람이 나중에 직접 git 을 쓸 때
  // 헬퍼 체인이 조용히 달라진다. `git -c k=v clone` 은 이 호출에만 적용되고 남기지 않는다.
  it("-c 가 clone 서브커맨드보다 앞에 온다", async () => {
    const seen: string[][] = [];
    const runGit: RunGit = async (args) => { seen.push(args); return { ok: true, stdout: "" }; };
    await runRestore(
      { dir: "/ws/x", cloneUrl: "https://g/x.git", token: "t", discardLocal: false },
      { runGit, exists: async () => false, rmrf: async () => {} },
    );
    const cmd = seen.find((a) => a.includes("clone"))!;
    expect(cmd.indexOf("-c")).toBeLessThan(cmd.indexOf("clone"));
  });
});
