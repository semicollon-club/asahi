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
      const next = args.replaceAll === true ? text.split(oldString).join(newString) : text.replace(oldString, newString);
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
        const append = (chunk: Buffer) => {
          if (out.length < OUTPUT_MAX * 2) out += chunk.toString();
        };
        child.stdout.on("data", append);
        child.stderr.on("data", append);
        // 타임아웃이 되면 죽이기만 하고, resolve 는 실제로 프로세스가 끝난 뒤(close 이벤트)
        // 넘긴다 — kill() 은 종료를 "요청"할 뿐이라 그 순간 바로 resolve 해버리면 OS 가 아직
        // 핸들을 놓기 전인데도 호출자에게는 "멈췄다"고 알리는 경쟁 상태가 생긴다(윈도우에서
        // 실측: kill 직후 같은 tick 에 그 프로세스의 cwd 를 지우면 EBUSY 로 실패한다).
        const timer = setTimeout(() => {
          timedOut = true;
          child.kill();
        }, timeoutMs);
        child.on("error", (err) => {
          clearTimeout(timer);
          resolve({ ok: false, content: `실행하지 못했어요: ${String(err)}` });
        });
        child.on("close", (code) => {
          clearTimeout(timer);
          if (timedOut) {
            resolve({ ok: false, content: truncate(`${out}\n(${timeoutMs}ms 안에 끝나지 않아 중단했어요)`) });
            return;
          }
          resolve(code === 0
            ? { ok: true, content: truncate(out) }
            : { ok: false, content: truncate(`${out}\n(종료 코드 ${code})`) });
        });
      });
    },
  };
}
