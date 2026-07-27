import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { glob } from "tinyglobby";
import { checkPath } from "./roots.js";

export type ExecResult = { ok: boolean; content: string };
export type Executors = Record<string, (args: Record<string, unknown>) => Promise<ExecResult>>;

// 모델에게 돌려줄 출력 상한. 넘으면 잘라내고 잘렸다고 명시한다 — 조용히 자르면 모델이
// 전체를 봤다고 착각한다.
export const OUTPUT_MAX = 30000;
const READ_DEFAULT_LIMIT = 2000;
const SH_DEFAULT_TIMEOUT_MS = 120_000;
// sh_exec 는 "resolve 를 정확히 한 번, 항상, 유한한 시간 안에" 를 보장해야 한다. 그 보장을
// 3단계로 나눠 각각 유예 시간을 둔다 — close 이벤트가 오면 그 즉시 남은 단계를 모두 건너뛰고
// resolve 하므로, 정상적으로 죽는 프로세스는 아래 두 상수를 전혀 기다리지 않는다. 이 값들은
// "얌전히 안 죽는" 예외적인 경우에만 소요되는 상한이다.
// 1) SIGTERM(또는 윈도우 기본 kill)을 보낸 뒤, 정상 종료를 기다리는 유예 시간. Node 서버·
//    Docker 로 감싼 프로세스처럼 종료 시그널 핸들러가 정리 작업을 하는 경우를 배려한다.
const KILL_GRACE_MS = 3_000;
// 2) 강제종료(SIGKILL / taskkill /F)를 보낸 뒤에도 close 를 기다리는 마지막 유예 시간.
//    SIGKILL 은 가로챌 수 없어 보통 즉시 정리되지만, 느린 스케줄러·바쁜 디스크 I/O 등을
//    감안한 버퍼. 이 시간이 지나면 프로세스 생사와 무관하게 무조건 resolve 한다.
const FORCE_KILL_GRACE_MS = 2_000;

function truncate(s: string): string {
  return s.length <= OUTPUT_MAX ? s : `${s.slice(0, OUTPUT_MAX)}\n… (출력이 길어 ${OUTPUT_MAX}자에서 잘랐어요)`;
}

const str = (v: unknown): string | undefined => (typeof v === "string" && v.length > 0 ? v : undefined);
const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

export function makeExecutors(roots: string[]): Executors {
  // 경로 인자를 검사해 실경로를 돌려준다. 거부되면 그대로 ExecResult 로 반환한다.
  const gate = (raw: unknown): { ok: true; path: string } | { ok: false; res: ExecResult } => {
    const p = str(raw);
    if (!p) return { ok: false, res: { ok: false, content: "path 인자가 필요해요." } };
    const c = checkPath(p, roots);
    return c.ok ? { ok: true, path: c.path } : { ok: false, res: { ok: false, content: c.message } };
  };

  return {
    async fs_read(args) {
      const g = gate(args.path);
      if (!g.ok) return g.res;
      let text: string;
      try {
        text = await fs.readFile(g.path, "utf8");
      } catch (err) {
        return { ok: false, content: `읽지 못했어요: ${String(err)}` };
      }
      const lines = text.split("\n");
      const offset = Math.max(1, num(args.offset) ?? 1);
      const limit = Math.max(1, num(args.limit) ?? READ_DEFAULT_LIMIT);
      const slice = lines.slice(offset - 1, offset - 1 + limit);
      const numbered = slice.map((l, i) => `${offset + i}\t${l}`).join("\n");
      return { ok: true, content: truncate(numbered) };
    },

    async fs_write(args) {
      const g = gate(args.path);
      if (!g.ok) return g.res;
      const content = typeof args.content === "string" ? args.content : "";
      try {
        await fs.mkdir(path.dirname(g.path), { recursive: true });
        await fs.writeFile(g.path, content, "utf8");
      } catch (err) {
        return { ok: false, content: `쓰지 못했어요: ${String(err)}` };
      }
      return { ok: true, content: `썼어요: ${g.path} (${content.length}자)` };
    },

    async fs_edit(args) {
      const g = gate(args.path);
      if (!g.ok) return g.res;
      const oldString = str(args.oldString);
      const newString = typeof args.newString === "string" ? args.newString : undefined;
      if (oldString === undefined || newString === undefined) {
        return { ok: false, content: "oldString·newString 인자가 필요해요." };
      }
      let text: string;
      try {
        text = await fs.readFile(g.path, "utf8");
      } catch (err) {
        return { ok: false, content: `읽지 못했어요: ${String(err)}` };
      }
      const count = text.split(oldString).length - 1;
      if (count === 0) return { ok: false, content: "찾는 문자열이 파일에 없어요." };
      if (count > 1 && args.replaceAll !== true) {
        return { ok: false, content: `${count}군데에서 발견됐어요. 더 긴 문자열로 특정하거나 replaceAll 을 쓰세요.` };
      }
      // text.replace(oldString, newString) 은 newString 이 "문자열"이어도 $&·$$·$`·$'·$<n> 을
      // 특수 치환 패턴으로 해석해버린다 — Makefile·셸 스크립트·CI 설정처럼 '$'가 흔한 파일을
      // 고칠 때 조용히 다른 내용이 써질 수 있다. replacer 를 함수로 주면 반환값이 그대로(리터럴로)
      // 쓰인다. replaceAll 경로(split/join)는 애초에 이 해석을 하지 않아 그대로 둔다.
      const next =
        args.replaceAll === true ? text.split(oldString).join(newString) : text.replace(oldString, () => newString);
      try {
        await fs.writeFile(g.path, next, "utf8");
      } catch (err) {
        return { ok: false, content: `쓰지 못했어요: ${String(err)}` };
      }
      return { ok: true, content: `고쳤어요: ${g.path} (${count}군데)` };
    },

    async fs_glob(args) {
      const base = str(args.path) ?? roots[0];
      const g = gate(base);
      if (!g.ok) return g.res;
      const pattern = str(args.pattern) ?? "**/*";
      let hits: string[];
      try {
        hits = await glob(pattern, { cwd: g.path, absolute: true, dot: false });
      } catch (err) {
        return { ok: false, content: `찾지 못했어요: ${String(err)}` };
      }
      // tinyglobby 는 pattern 에 절대경로나 '..' 를 그대로 받아들일 수 있으므로 결과도 다시 거른다.
      const inside = hits.filter((h) => checkPath(h, roots).ok);
      return { ok: true, content: truncate(inside.length > 0 ? inside.join("\n") : "(일치하는 파일 없음)") };
    },

    async fs_grep(args) {
      const base = str(args.path) ?? roots[0];
      const g = gate(base);
      if (!g.ok) return g.res;
      const pattern = str(args.pattern);
      if (!pattern) return { ok: false, content: "pattern 인자가 필요해요." };
      let re: RegExp;
      try {
        re = new RegExp(pattern);
      } catch (err) {
        return { ok: false, content: `정규식이 올바르지 않아요: ${String(err)}` };
      }
      let files: string[];
      try {
        files = await glob(str(args.glob) ?? "**/*", { cwd: g.path, absolute: true, dot: false });
      } catch (err) {
        return { ok: false, content: `찾지 못했어요: ${String(err)}` };
      }
      const out: string[] = [];
      for (const f of files) {
        if (!checkPath(f, roots).ok) continue;
        let text: string;
        try {
          text = await fs.readFile(f, "utf8");
        } catch {
          continue; // 바이너리·권한 문제 파일은 건너뛴다
        }
        text.split("\n").forEach((line, i) => {
          if (re.test(line)) out.push(`${f}:${i + 1}: ${line.trim()}`);
        });
        if (out.join("\n").length > OUTPUT_MAX) break;
      }
      return { ok: true, content: truncate(out.length > 0 ? out.join("\n") : "(일치하는 내용 없음)") };
    },

    async sh_exec(args) {
      if (roots.length === 0) return { ok: false, content: "워커에 열린 작업 폴더가 없어요." };
      const command = str(args.command);
      if (!command) return { ok: false, content: "command 인자가 필요해요." };
      const timeoutMs = num(args.timeoutMs) ?? SH_DEFAULT_TIMEOUT_MS;
      return new Promise<ExecResult>((resolve) => {
        const child = spawn(command, { cwd: roots[0], shell: true });
        let out = "";
        let timedOut = false;
        let settled = false;
        const append = (chunk: Buffer) => {
          if (out.length < OUTPUT_MAX * 2) out += chunk.toString();
        };
        child.stdout.on("data", append);
        child.stderr.on("data", append);

        // 타임아웃이 되면 죽이기만 하고, resolve 는 실제로 프로세스가 끝난 뒤(close 이벤트)
        // 넘긴다 — kill() 은 종료를 "요청"할 뿐이라 그 순간 바로 resolve 해버리면 OS 가 아직
        // 핸들을 놓기 전인데도 호출자에게는 "멈췄다"고 알리는 경쟁 상태가 생긴다(윈도우에서
        // 실측: kill 직후 같은 tick 에 그 프로세스의 cwd 를 지우면 EBUSY 로 실패한다).
        // 다만 close 를 "무조건" 기다리기만 하면, kill() 이 신호는 전달했지만 프로세스가 실제로는
        // 안 죽는 경우(SIGTERM 핸들러가 있는 Node 서버·Docker 로 감싼 프로세스 등) close 가 영영
        // 안 와서 이 Promise 가 영원히 안 끝난다 — timeoutMs 가 있는 이유 자체가 무색해진다.
        // 그래서 정상 경로(close 를 기다림)는 유지하되, 아래 두 타이머로 유한 시간 안에 반드시
        // resolve 되는 것을 보장한다(KILL_GRACE_MS·FORCE_KILL_GRACE_MS 상수 선언부 주석 참고).
        let graceTimer: ReturnType<typeof setTimeout> | undefined;
        let hardTimer: ReturnType<typeof setTimeout> | undefined;

        const clearAllTimers = () => {
          clearTimeout(timer);
          if (graceTimer) clearTimeout(graceTimer);
          if (hardTimer) clearTimeout(hardTimer);
        };

        // resolve 는 정확히 한 번만 — 어느 경로로 오든 이후 호출은 조용히 무시한다.
        const finish = (result: ExecResult) => {
          if (settled) return;
          settled = true;
          clearAllTimers();
          resolve(result);
        };

        // SIGTERM(또는 윈도우 기본 kill)에 응하지 않는 프로세스를 강제로 정리한다. 실패해도
        // (이미 죽었거나 권한 문제) hardTimer 가 최종 안전망이므로 예외는 삼킨다.
        const forceKill = () => {
          if (!child.pid) return;
          if (process.platform === "win32") {
            // 윈도우에서 child.kill() 은 직접 자식(대개 cmd.exe)만 죽이고, 그 자식이 띄운
            // 손자 프로세스(고아가 된 실제 작업 프로세스)는 정리하지 못한다 — taskkill 의
            // /T(트리 전체) /F(강제)로 프로세스 트리를 통째로 끝낸다.
            try {
              const killer = spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"]);
              killer.on("error", () => {
                /* taskkill 자체가 실행되지 않아도(설치 안 됨 등) hardTimer 가 최종 안전망이다 */
              });
            } catch {
              /* 동기적으로 실패해도 무시 — 위와 동일한 이유 */
            }
          } else {
            try {
              child.kill("SIGKILL");
            } catch {
              /* 이미 죽은 프로세스에 보낸 시그널의 예외는 무시해도 안전하다 */
            }
          }
        };

        const timer = setTimeout(() => {
          timedOut = true;
          child.kill();
          graceTimer = setTimeout(() => {
            forceKill();
            hardTimer = setTimeout(() => {
              // 강제종료 이후에도 close 가 안 왔다 — 프로세스 생사와 무관하게 호출자에게는
              // 반드시 끝을 알려야 한다. sh_exec 의 "유한한 시간 안에 resolve" 보장은 바로 이 지점이다.
              finish({
                ok: false,
                content: truncate(
                  `${out}\n(${timeoutMs}ms 안에 끝나지 않아 중단했어요 — 강제종료에도 응답이 없어 대기를 포기했어요)`,
                ),
              });
            }, FORCE_KILL_GRACE_MS);
          }, KILL_GRACE_MS);
        }, timeoutMs);

        child.on("error", (err) => {
          finish({ ok: false, content: `실행하지 못했어요: ${String(err)}` });
        });
        child.on("close", (code) => {
          if (timedOut) {
            finish({ ok: false, content: truncate(`${out}\n(${timeoutMs}ms 안에 끝나지 않아 중단했어요)`) });
            return;
          }
          finish(
            code === 0
              ? { ok: true, content: truncate(out) }
              : { ok: false, content: truncate(`${out}\n(종료 코드 ${code})`) },
          );
        });
      });
    },

    // Task 8: 손님의 개인 폴더를 만들기 위한 실행기. 모델이 부르는 도구가 아니다 — REMOTE_TOOL_NAMES
    // (core/remoteTools.ts)에 넣지 않아 모델에게는 아예 보이지 않고, 봇이 손님의 첫 원격 호출
    // 직전에 remoteToolHandler 에서 직접 끼워 넣는다. 다른 fs_* 와 완전히 동일한 gate(위 참고)를
    // 거친다 — 이 실행기만을 위한 예외 경로(별도 검사 로직)를 만들지 않는다.
    async fs_mkdir(args) {
      const g = gate(args.path);
      if (!g.ok) return g.res;
      try {
        // recursive:true 는 폴더가 이미 있어도 에러 없이 성공한다 — 이 실행기는 멱등이어야
        // 하므로(매 호출마다 불려도 안전해야 한다) 그 동작이 그대로 맞다.
        await fs.mkdir(g.path, { recursive: true });
        return { ok: true, content: "(완료)" };
      } catch (e) {
        return { ok: false, content: `폴더를 만들지 못했어요: ${e instanceof Error ? e.message : String(e)}` };
      }
    },
  };
}
