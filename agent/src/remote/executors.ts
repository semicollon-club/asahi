import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { glob } from "tinyglobby";
import { checkPath } from "./roots.js";
import {
  renderTree,
  TREE_MAX_ENTRIES,
  TREE_DEFAULT_DEPTH,
  TREE_MAX_DEPTH,
  TREE_EXCLUDED,
  type TreeEntry,
  type TreeTruncReason,
} from "./tree.js";
import { pathFlavorOf } from "../core/paths.js";
import { parsePm2List, renderProcList, procNameFor, parseProcName } from "./proc.js";

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

// PM2 CLI 호출을 이음매 뒤로 뺀다. 테스트가 실제 PM2 설치를 요구하면 그 경로는 CI 에서도
// 개발자 기계에서도 한 번도 지나가지 않는다 — 2026-07-28 최종 리뷰가 잡은 Critical(실패 신호
// 소실)이 정확히 그렇게 다섯 번의 리뷰를 통과했다.
export type RunPm2 = (args: string[]) => Promise<{ ok: boolean; stdout: string; stderr: string }>;

// Defect 2(운영 중 발견): pm2 delete 는 pm2 가 직접 아는 자식(cmd.exe/sh)만 죽이고 그 밑의 실제
// 프로세스 트리(회원의 npm·vite 등, 손자 프로세스)는 그대로 남는다 — 운영 재현: proc_stop 이
// "멈췄어요"를 응답한 뒤에도 npm run dev·vite.js 가 포트를 붙든 채 계속 돌았고 proc_list 에는
// 아예 나타나지 않는 고아가 됐다(pm2 의 treekill 옵션이 윈도우에서 기본 true 라고 알려져 있지만,
// 이 사고에서는 그 기본값이 실제로 트리를 못 죽였다). RunPm2 와 같은 이유로 이음매 뒤로 뺀다 —
// 테스트가 실제 프로세스를 하나도 죽이지 않고도 "정확한 pid 로, pm2 delete 보다 먼저 불렸는지"를
// 확인할 수 있어야 한다.
//
// 리뷰 지적(Important, Finding 3): 실패하면 반드시 reject 해야 한다 — 예전 기본 구현은 taskkill의
// 종료 코드를 보지 않고 항상 resolve 했다(아래 참고). proc_stop 은 이 Promise 가 정상 종료했는지로
// "트리 정리를 확인했다"는 메시지를 결정하므로(treeKilled), 실패를 삼키고 resolve 하면 회원에게
// 거짓 확신을 준다 — throw(reject) 가 유일한 실패 신호다.
export type KillTree = (pid: number) => Promise<void>;

// shellFor()·기본 runPm2(아래)가 함께 쓰는 "워커가 윈도우인지 POSIX 인지" 판정 결과 타입.
export type ShellFlavor = "win32" | "posix";

// 리뷰 지적(Important): 기본 runPm2 는 spawn("pm2", args, {shell:true}) 로 pm2 를 불렀다. Node 의
// spawn(file, args, {shell:true}) 는 [file, ...args] 를 공백 하나로 join 만 할 뿐 인자별 따옴표를
// 붙이지 않는다 — 실측: ["--name","asahi-111","--","-c","npm run dev"] 를 넘기면 자식 프로세스는
// argv 5개가 아니라 7개를 받는다("npm run dev" 가 공백마다 셋으로 쪼개진다). 그러면 pm2 는 "npm"
// 만 스크립트로 알아듣고 "run"·"dev" 는 흘려버린다. 공백이 든 --cwd 경로(예: 사용자 이름에 공백이
// 섞인 윈도우 작업폴더 "C:\Users\Jane Smith\ws\111")도 똑같이 쪼개진다. 모든 테스트가 runPm2 를
// 주입해 실제 spawn 경로를 한 번도 타지 않으므로, 이 결함은 스위트 전체로도 드러나지 않았다.
//
// 고치는 형태는 sh_exec(아래, spawn(command, {shell:true}))와 같다 — 명령줄 전체를 "하나의"
// 문자열로 미리 인용해 만들고, 그 문자열 하나만 file 자리에 넘긴다(별도 args 배열은 쓰지 않는다).
// 인용 로직을 순수 함수로 떼어 export 하는 이유는, 이번 결함의 진짜 원인이 "프로덕션 경로에 테스트
// 표면이 아예 없었다"는 것이었기 때문이다 — 같은 실수를 반복하지 않도록 인용 결과 자체를 직접
// 단정할 수 있게 남긴다.
//
// 인용은 이 바깥 셸 레이어에서 "정확히 한 번"만 한다. pm2 는 이 명령줄을 넘겨받아 다시 sh/cmd.exe
// 를 [flag, command] 배열로 직접 띄운다(shell:true 를 또 쓰는 게 아니라 argv 배열로 바로 spawn
// 하므로 세 번째 셸이 끼지 않는다) — 그래서 command 문자열 안쪽은 한 번 더 인용할 필요가 없다(더
// 하면 따옴표가 겹쳐서 오히려 깨진다).
//
// 인용 규칙은 "공백(또는 빈 문자열) 인자를 하나의 토큰으로 지킨다"와 "POSIX 작은따옴표 자체가
// 토큰 경계를 깨는 것을 막는다"까지만 다룬다. cmd.exe 의 &·|·^·% 같은 특수문자까지 모든 경우에
// 안전한 인용은 셸마다 규칙이 다르고 표준이 없어 범위 밖이다 — 여기서 고치는 건 딱 보고된 실패
// (공백 든 인자가 쪼개지는 것)뿐이다.
function needsQuoting(arg: string, flavor: ShellFlavor): boolean {
  if (arg.length === 0 || /\s/.test(arg)) return true;
  // POSIX 는 작은따옴표, 윈도우는 큰따옴표 — 각 플레이버의 인용 문자가 인자 안에 있으면 공백이
  // 없어도 인용 대상이다. 윈도우 쪽을 빠뜨리면(공백 없이 큰따옴표만 든 인자) 아래에서 quote()
  // 가 아예 호출되지 않아 quoteWin32 의 이스케이프 로직이 있어도 이 인자에는 한 번도 적용되지
  // 않는다 — 인용되지 않은 토큰 안의 " 는 (앞의 백슬래시 개수가 짝수라서) 그 자체로 표준 윈도우
  // argv 파서의 따옴표 모드를 토글해버려, 공백이 없어도 조용히 다른 방식으로 깨진다.
  return flavor === "posix" ? arg.includes("'") : arg.includes('"');
}

// POSIX(sh) 인용 — 작은따옴표로 감싼다. 작은따옴표 안에는 이스케이프가 없으므로, 인자에 작은
// 따옴표가 있으면 그 지점에서 일단 닫고(') 이스케이프된 따옴표(\')를 따옴표 밖에 쓴 뒤 다시
// 연다(') — 표준적인 기법이다.
function quotePosix(arg: string): string {
  return `'${arg.replace(/'/g, "'\\''")}'`;
}

// cmd.exe 인용 — MSVCRT/CommandLineToArgvW 의 표준 명령줄 인용 알고리즘을 그대로 구현한다(근사치가
// 아니라 문서화된 그 규칙 자체 — Python subprocess.list2cmdline 과 같은 알고리즘이다). 큰따옴표
// 바로 앞의 백슬래시들은 두 배로 늘린 뒤 \" 를 쓴다(따옴표는 리터럴로 살리고, 그 앞의 백슬래시도
// 리터럴로 보존한다). 백슬래시가 아닌 문자 앞에서는 백슬래시를 그대로 둔다(늘리지 않는다). 인자
// 끝에 남는 백슬래시(바로 뒤에 우리가 붙이는 닫는 큰따옴표가 오는 자리)도 두 배로 늘린다 — 안
// 그러면 그 백슬래시가 우리가 붙이는 닫는 큰따옴표를 이스케이프해버려 따옴표가 안 닫힌 것처럼
// 파싱된다.
//
// 이 인용이 다루는 건 "표준 윈도우 argv 파싱"이라는 한 겹뿐이다. proc_start 가 pm2 에 넘기는
// command 인자(예: npm run dev -- --title="hi there")처럼 모델·사용자가 자유롭게 채우는 값이
// 실제로 큰따옴표를 담을 수 있는 바로 그 필드이고, quoteWin32 가 존재하는 이유이기도 하다 — cwd
// 는 애초에 큰따옴표를 쓸 수 없는 윈도우 경로라 이 계층에서는 참고 사례일 뿐이다. 다만 cmd.exe
// 는 이 표준 argv 파싱 위에 자기만의 인용·특수문자 해석 계층을 하나 더 얹는다: 여기서 만든 큰
// 따옴표 쌍 안이든 밖이든 &·|·^·% 같은 cmd.exe 메타문자는 cmd.exe 가 명령 구분자·파이프·이스케이프
// 문자로 재해석할 수 있다. 그 계층까지 모든 경우에 안전한 인용은 셸마다 규칙이 다르고 표준이
// 없어 여전히 범위 밖이다(위 needsQuoting 주석의 범위 설명과 같은 이유) — 이번에 고친 건 표준
// argv 파싱 단계에서 인자가 깨지는 것(공백·큰따옴표로 토큰이 쪼개지거나 따옴표가 조용히 사라지는
// 것)뿐이다.
function quoteWin32(arg: string): string {
  let escaped = "";
  let backslashes = 0;
  for (const ch of arg) {
    if (ch === "\\") {
      backslashes++;
      continue;
    }
    if (ch === '"') {
      escaped += "\\".repeat(backslashes * 2 + 1) + '"';
    } else {
      escaped += "\\".repeat(backslashes) + ch;
    }
    backslashes = 0;
  }
  escaped += "\\".repeat(backslashes * 2);
  return `"${escaped}"`;
}

// pm2 CLI 호출 전체를 "하나의" 명령줄 문자열로 만드는 순수 함수. flavor 는 shellFor() 와 똑같이
// 워커 루트의 플레이버로 정해야 한다(shellFlavorOf 참고) — 호스트 플랫폼으로 정하면 안 되는
// 이유는 shellFor 의 주석과 같다.
export function buildPm2CommandLine(args: string[], flavor: ShellFlavor): string {
  const quote = flavor === "win32" ? quoteWin32 : quotePosix;
  // 단순한 토큰(start·--name·asahi-111 등)은 따옴표 없이 그대로 둬 로그에서 읽기 쉽게 한다.
  return ["pm2", ...args].map((a) => (needsQuoting(a, flavor) ? quote(a) : a)).join(" ");
}

// shellFor()·기본 runPm2 가 공유하는 플레이버 판정 — 두 곳이 각자 계산하면 언젠가 갈릴 수 있어
// 한 곳으로 모은다.
function shellFlavorOf(roots: string[]): ShellFlavor {
  return pathFlavorOf(roots[0] ?? "/") === path.win32 ? "win32" : "posix";
}

const PROC_LOG_DEFAULT_LINES = 50;

// 리뷰 지적(Important, 병합 차단): proc_list 는 소유자에게 필터를 걸지 않으므로 asahi-assistant·
// asahi-worker(봇·워커 자신, deploy/ecosystem.config.cjs 로 관리되는 PM2 앱)도 평범한 회원 행처럼
// 보인다. remoteTools.ts 는 소유자가 지정한 이름을 검증 없이 그대로 proc_stop·proc_logs 로
// 넘기므로(모델이 정한 이름을 신뢰), "돌고 있는 거 다 정리해줘" 같은 지시 한 번으로 워커나 봇
// 자신이 pm2 delete 로 사라질 수 있었다 — pm2 delete 는 완전히 제거해 autorestart 로도 못
// 돌아오고, 복구하려면 기계에 직접 접근해야 한다. parseProcName(proc.ts)이 이미 회원 이름
// (asahi-<숫자>)과 인프라 이름을 구분하므로, 그 판정을 pm2 를 실제로 부르는 이 계층(실행기)이
// 강제한다 — 봇(remoteTools.ts)이 아니라 여기서 막는 이유는, sh_exec 로 pm2 명령을 직접 쓰는
// 것은 여전히 허용된 탈출구이기 때문이다(소유자가 정말로 의도했다면 그 경로가 남아 있다).
const NOT_MEMBER_PROC_MSG =
  "그건 회원 프로세스가 아니에요 — 봇·워커 같은 인프라는 이 도구로 건드리지 않아요. 정말 필요하면 sh_exec 로 직접 하세요.";

function truncate(s: string): string {
  return s.length <= OUTPUT_MAX ? s : `${s.slice(0, OUTPUT_MAX)}\n… (출력이 길어 ${OUTPUT_MAX}자에서 잘랐어요)`;
}

const str = (v: unknown): string | undefined => (typeof v === "string" && v.length > 0 ? v : undefined);
const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

export function makeExecutors(roots: string[], opts: { runPm2?: RunPm2; killTree?: KillTree } = {}): Executors {
  const runPm2: RunPm2 =
    opts.runPm2 ??
    ((args) =>
      new Promise((resolve) => {
        // shell:true 로 부르는 이유는 sh_exec 와 같다 — 윈도우에서 pm2 는 pm2.cmd 셰임이라
        // 셸을 거치지 않으면 실행 파일을 찾지 못한다. args 를 별도 배열로 넘기지 않고 명령줄
        // 전체를 문자열 하나로 미리 인용해 file 자리에 통째로 넘기는 이유는 위 buildPm2CommandLine
        // 주석 참고 — spawn(file, args, {shell:true}) 는 인자별 따옴표를 붙여주지 않는다.
        const commandLine = buildPm2CommandLine(args, shellFlavorOf(roots));
        const child = spawn(commandLine, { shell: true });
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (c: Buffer) => { stdout += c.toString(); });
        child.stderr.on("data", (c: Buffer) => { stderr += c.toString(); });
        child.on("error", (e) => resolve({ ok: false, stdout, stderr: String(e) }));
        child.on("close", (code) => resolve({ ok: code === 0, stdout, stderr }));
      }));

  // Defect 2 기본 구현. 플랫폼은 shellFor()·기본 runPm2 와 정확히 같은 기준(shellFlavorOf →
  // pathFlavorOf(roots[0]))으로 고른다 — process.platform 을 쓰면 안 되는 이유도 같다: 이
  // executors.ts 모듈 자체는 실제로 워커 프로세스 위에서 실행되므로 오늘은 결과가 같지만, "무엇을
  // 신뢰의 기준으로 삼는가"를 이미 검증된 WORKER_ROOTS(설정)로 통일해 두면 이 함수가 언제 어디서
  // 불려도(예: 테스트) 근거가 하나뿐이다.
  const killTree: KillTree =
    opts.killTree ??
    ((pid) =>
      new Promise<void>((resolve, reject) => {
        if (shellFlavorOf(roots) === "win32") {
          // pm2 는 cmd.exe /c <command> 를 띄우고, 회원의 실제 서버(npm/vite 등)는 그 자식(pm2
          // 입장에서는 손자) 프로세스다 — pm2 delete 는 pm2 가 직접 아는 cmd.exe 만 죽이고 그
          // 밑의 트리는 그대로 둔다(운영 실측: pm2 delete 뒤에도 npm run dev·vite.js 가 포트를
          // 잡은 채 계속 돌았다 — pm2 의 treekill 옵션이 윈도우 기본값 true 라고 알려져 있지만
          // 실측에서 트리를 못 죽였다). sh_exec 의 forceKill(위)과 같은 도구, 같은 이유로
          // taskkill /T(트리 전체) /F(강제)를 직접 쓴다.
          try {
            const killer = spawn("taskkill", ["/PID", String(pid), "/T", "/F"]);
            killer.on("error", (e) => reject(e));
            // 리뷰 지적(Important, Finding 3): 예전엔 close 이벤트만 보고 종료 코드를 확인하지
            // 않아, taskkill 이 실패해도(이미 없는 pid, 권한 부족 등) 항상 "성공"으로 resolve 했다
            // — proc_stop 이 이 결과를 "트리를 실제로 정리했다"는 신호로 못 쓰는 원인이었다. 0 이
            // 아니면 reject 해 호출측(proc_stop)의 catch/treeKilled 로 실패가 그대로 전달되게 한다.
            killer.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`taskkill 종료 코드 ${code}`))));
          } catch (e) {
            reject(e);
          }
        } else {
          // POSIX: 이 클럽의 실제 워커는 전부 회원 개인 PC·공유 미니 PC 로, 오늘은 전부 윈도우다
          // — 이 분기가 실제 배포에서 지나가는 경로는 없다. 그래도 미래를 위해 taskkill 을 그대로
          // 옮겨 심는(윈도우 전용 도구를 POSIX 에 억지로 흉내 내는) 대신, POSIX 표준 방식으로
          // 올바른 것을 쓴다: pm2 가 sh -c <command> 로 띄우므로 회원의 실제 명령도 sh 의 자식(같은
          // 모양의 손자 프로세스)이 될 수 있다 — process.kill(-pid, …) 는 pid 를 그룹 리더로 하는
          // 프로세스 그룹 전체에 신호를 보내는 POSIX 표준 동작이라, sh 와 그 자식들을 한 번에
          // 정리한다(pm2 가 별도로 setsid 등을 하지 않는 한 자식들이 같은 그룹에 남는다). 다만
          // POSIX 셸은 "마지막 명령을 exec 로 대체"하는 최적화가 흔해(sh -c "npm run dev" 가 exec
          // 로 npm 프로세스 자체가 되어 애초에 손자를 두지 않는 경우가 많다) 윈도우만큼 사무적이지
          // 않다 — 이 캐비엇을 인지한 채로, "적어도 표준적이고 틀리지 않은" 선택을 한다.
          try {
            process.kill(-pid, "SIGKILL");
            resolve();
          } catch (e) {
            // 리뷰 지적(Important, Finding 3): 윈도우 분기와 같은 이유로 여기서도 실패를 삼키지
            // 않는다 — 이미 죽었거나(ESRCH) 권한 문제(EPERM)면 reject 해 proc_stop 이 "확인하지
            // 못했다"고 정직하게 알리게 한다. 최종 판정은 여전히 pm2 delete 의 성패이므로(proc_stop
            // 의 catch 참고) 이 reject 자체가 도구 호출을 실패시키지는 않는다.
            reject(e);
          }
        }
      }));

  // 경로 인자를 검사해 실경로를 돌려준다. 거부되면 그대로 ExecResult 로 반환한다.
  const gate = (raw: unknown): { ok: true; path: string } | { ok: false; res: ExecResult } => {
    const p = str(raw);
    if (!p) return { ok: false, res: { ok: false, content: "path 인자가 필요해요." } };
    const c = checkPath(p, roots);
    return c.ok ? { ok: true, path: c.path } : { ok: false, res: { ok: false, content: c.message } };
  };

  // pm2 에 임의 명령을 넘기는 안전한 형태. pm2 는 "스크립트 파일"을 기대하므로, 셸 명령은
  // 인터프리터를 명시해 넘겨야 한다. 어느 셸인지는 워커 루트의 플레이버로 정한다 — 봇은
  // 리눅스, 워커는 윈도우일 수 있어 호스트 플랫폼으로 정하면 어긋난다(paths.ts 와 같은 이유).
  // 이 판정은 기본 runPm2(위)의 명령줄 인용과 같은 기준을 써야 하므로 shellFlavorOf 로 뺐다.
  const shellFor = (): { bin: string; flag: string } =>
    shellFlavorOf(roots) === "win32" ? { bin: "cmd.exe", flag: "/c" } : { bin: "sh", flag: "-c" };

  const procGate = (): { ok: true } | { ok: false; res: ExecResult } =>
    roots.length === 0
      ? { ok: false, res: { ok: false, content: "워커에 열린 작업 폴더가 없어요." } }
      : { ok: true };

  const listProcs = async () => {
    const r = await runPm2(["jlist"]);
    return r.ok
      ? { ok: true as const, procs: parsePm2List(r.stdout) }
      : { ok: false as const, message: `pm2 목록을 가져오지 못했어요: ${r.stderr.trim() || "알 수 없는 오류"}` };
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

    // 재귀 순회라 fs_read 에 없던 위험이 하나 있다 — 심볼릭 링크 하나로 워크스페이스 밖을
    // 열거할 수 있다. withFileTypes 로 링크를 아예 건너뛴다(따라가지 않는다).
    async fs_tree(args) {
      const g = gate(args.path);
      if (!g.ok) return g.res;
      // depth 는 0 미만으로 내려가지 않는다 — tools.ts 의 zod 스키마가 하한을 두더라도, 모델이
      // 스키마를 우회해 음수를 보낼 가능성까지 여기서 막는다(스키마만 믿지 않는다). 클램프가
      // 없으면 최상위(depth0)에서 바로 depth 초과로 판정돼 entries 를 하나도 못 채우고,
      // renderTree 의 "entries 가 비었는지" 검사가 truncated 검사보다 먼저 걸려 내용이 있는
      // 폴더를 "비어 있어요"로 속인다.
      const maxDepth = Math.max(0, Math.min(num(args.depth) ?? TREE_DEFAULT_DEPTH, TREE_MAX_DEPTH));
      const entries: TreeEntry[] = [];
      // 두 상한은 성격이 다르므로 플래그를 분리한다.
      // - entries 는 전역이다: 상한에 닿으면 순회 전체를 멈추는 게 맞다(더 읽어봐야 어차피 다
      //   보여줄 수 없다).
      // - depth 는 가지별(local)이다: 어떤 가지가 너무 깊다고 다른 형제 가지의 얕은 내용까지
      //   못 볼 이유가 없다. 예전엔 이 둘을 하나의 truncated 플래그로 같이 써서, depth 로 멈춘
      //   가지가 walk 맨 위의 `if (truncated) return` 을 통해 그 뒤 모든 형제의 순회까지
      //   막아버리는 회귀가 있었다 — A/A1/leaf.txt 가 depth 를 넘겨 플래그가 서면, 알파벳상
      //   뒤에 오는 형제 B 는 이름만 보이고 depth 상한 안(정상 범위)의 B/B1.txt 까지 사라졌다.
      let entriesTruncated = false;
      let depthTruncated = false;

      const walk = async (dir: string, rel: string, depth: number): Promise<void> => {
        if (entriesTruncated) return; // 전역 상한만 이후 호출 전체를 막는다. depth 상한은 여기서 걸지 않는다.
        let items;
        try {
          items = await fs.readdir(dir, { withFileTypes: true });
        } catch (err) {
          // depth 0 은 요청받은 경로(g.path) 자기 자신이다. roots.ts 의 경로 판정은 대상이 없어도
          // (가장 가까운 상위로 올라가) 통과할 수 있어, 오타 난 경로·지워진 폴더가 바로 여기로
          // 온다 — 그걸 조용히 건너뛰면 renderTree([]) 가 "비어 있어요"로 속인다. 형제 도구
          // fs_read 처럼 오류로 드러내야 하므로 최상위 호출자에게 그대로 던진다. 하위 폴더의
          // 실패(권한 등)는 흔하고 하나 때문에 전체를 실패시키면 안 되므로 조용히 건너뛴다 —
          // depth===0 인지 여부가 이 둘을 가른다.
          if (depth === 0) throw err;
          return;
        }
        const visible = items
          .filter((it) => !it.isSymbolicLink() && !TREE_EXCLUDED.has(it.name))
          .sort((a, b) => a.name.localeCompare(b.name));

        if (depth > maxDepth) {
          // depth 상한 때문에 이 가지에서 멈출 때, 더 보여줄 게 실제로 있을 때만(필터 후에도
          // 남는 게 있을 때만) "잘렸다"고 말한다 — 마지막 depth 의 폴더가 비어 있으면 자른 게
          // 아니므로 거짓 안내가 된다(OUTPUT_MAX 와 같은 원칙: 조용히 자르면 모델이 전체를 봤다고
          // 착각한다). 이 가지만 return 할 뿐, 전역 플래그를 세우지 않으므로 형제 가지의 walk
          // 호출은 영향받지 않는다.
          if (visible.length > 0) depthTruncated = true;
          return;
        }

        for (const it of visible) {
          if (entries.length >= TREE_MAX_ENTRIES) {
            entriesTruncated = true;
            return;
          }
          const childRel = rel === "" ? it.name : `${rel}/${it.name}`;
          entries.push({ relPath: childRel, isDir: it.isDirectory(), depth });
          if (it.isDirectory()) await walk(path.join(dir, it.name), childRel, depth + 1);
        }
      };

      try {
        await walk(g.path, "", 0);
      } catch (err) {
        return { ok: false, content: `읽지 못했어요: ${String(err)}` };
      }
      // 안내 문구는 실제로 일어난 것만 말한다 — 둘 다 걸렸으면 둘 다 드러낸다. 하나만 골라
      // 보여주면 나머지 하나는 조용히 잘린 것과 같아진다.
      const truncatedReason: TreeTruncReason | undefined =
        entriesTruncated && depthTruncated ? "both" : entriesTruncated ? "entries" : depthTruncated ? "depth" : undefined;
      const truncated = truncatedReason !== undefined;
      return { ok: true, content: truncate(renderTree(entries, { root: g.path, truncated, truncatedReason })) };
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

    async proc_start(args) {
      const g = procGate();
      if (!g.ok) return g.res;
      const command = str(args.command);
      const name = str(args.name);
      const cwd = str(args.cwd);
      if (!command) return { ok: false, content: "실행할 명령이 필요해요." };
      // name·cwd 는 봇이 주입한다(remoteTools.ts). 없으면 배선이 깨진 것이므로 실행하지 않는다 —
      // 이름 없이 띄우면 소유권도 1인 1개 상한도 성립하지 않는다.
      if (!name || !cwd) return { ok: false, content: "프로세스 이름·작업 폴더가 지정되지 않았어요." };

      // Defect 1(운영 중 발견): 봇(remoteTools.ts)이 allowed_dirs 로 cwd 를 이미 한 번 걸렀지만,
      // 그 검증이 이 프로세스까지 그대로 왔는지는 워커 자신만 안다 — fs_* 실행기의 gate()(위 참고)
      // 와 정확히 같은 이유로 checkPath 를 여기서도 최종 관문으로 한 번 더 돌린다. 봇은
      // allowed_dirs 를, 워커는 WORKER_ROOTS 를 검사한다 — 다른 모든 원격 도구와 마찬가지로 두
      // 겹 다 걸어야 하며, 어느 한쪽만으로는 부족하다(remoteTools.ts 의 FIX1 원칙과 같다: 검사한
      // 값과 실제로 쓰는 값이 같아야 검사가 의미를 갖는다).
      const cwdCheck = checkPath(cwd, roots);
      if (!cwdCheck.ok) return { ok: false, content: cwdCheck.message };

      // 운영 중 실제로 겪은 결함: 회원의 프로젝트는 폴더 루트가 아니라 그 아래 하위 폴더(예:
      // "…\<id>\테스트 1\")에 있는 게 보통인데, 그 폴더가 실제로 없으면(오타 등) pm2 가 --cwd 에서
      // 그 자리에서 실패한다 — 회원은 원인을 알 방법이 없어 cd/--prefix 변형을 여러 번 시도하며
      // 헤맸다. pm2 를 부르기 전에 여기서 먼저 확인해 원인을 한국어로 명확히 알린다.
      let cwdStat: Awaited<ReturnType<typeof fs.stat>>;
      try {
        cwdStat = await fs.stat(cwdCheck.path);
      } catch {
        return { ok: false, content: `그 폴더가 없어요: ${cwdCheck.path} — 경로를 다시 확인해 주세요.` };
      }
      if (!cwdStat.isDirectory()) {
        return { ok: false, content: `그 경로는 폴더가 아니에요: ${cwdCheck.path}` };
      }

      const before = await listProcs();
      if (!before.ok) return { ok: false, content: before.message };
      const dup = before.procs.find((p) => p.name === name);
      // 조용히 교체하지 않는다 — 부원이 자기도 모르게 돌던 서버를 잃는다. 바꾸려면 멈추고 다시 띄운다.
      if (dup) return { ok: false, content: `이미 돌고 있는 게 있어요: ${dup.command} (${dup.status}). 먼저 멈춰야 새로 띄울 수 있어요.` };

      const sh = shellFor();
      // cwd 가 아니라 cwdCheck.path 를 쓴다 — fs_* 의 gate() 가 g.path(검사에서 나온 실경로)로 실제
      // 파일시스템 작업을 하는 것과 같은 이유다(심볼릭 링크 등을 해석한 정규화된 값).
      const r = await runPm2(["start", sh.bin, "--name", name, "--cwd", cwdCheck.path, "--", sh.flag, command]);
      if (!r.ok) return { ok: false, content: `띄우지 못했어요: ${r.stderr.trim() || r.stdout.trim() || "알 수 없는 오류"}` };

      // 리뷰 지적(Minor, Finding 5): pm2 의 기본 autorestart 때문에 위 start 호출이 ok:true 여도
      // "pm2 가 프로세스 등록에 성공했다"는 뜻일 뿐, 명령 자체가 오타 등으로 즉시 죽으면 재시작을
      // 반복한다 — 여기서 바로 "띄웠어요"라고 알리면 크래시 루프도 성공으로 들린다. 재조회 한
      // 번으로 실제 상태를 확인해 보고한다(재시도·대기 루프는 두지 않는다 — 그 순간의 스냅샷만
      // 정직하게 전달하면 충분하고, pm2 가 안정화되길 기다리는 건 별개의 더 큰 설계다).
      const after = await listProcs();
      const status = after.ok ? after.procs.find((p) => p.name === name)?.status : undefined;
      if (status !== "online") {
        return {
          ok: false,
          content: `띄우긴 했는데 상태가 정상이 아니에요(${status ?? "확인 불가"}). "로그 보여줘" 라고 하면 원인을 확인할 수 있어요.`,
        };
      }
      // 발견성: 시작한 그 순간이 멈추는 법을 알려주기 가장 좋은 시점이다(설계 §6).
      return { ok: true, content: `띄웠어요: ${command}\n멈추려면 "돌고 있는 거 꺼줘" 라고 말하면 돼요. "뭐 돌고 있어?" 로 확인할 수 있어요.` };
    },

    async proc_stop(args) {
      const g = procGate();
      if (!g.ok) return g.res;
      const name = str(args.name);
      if (!name) return { ok: false, content: "멈출 프로세스가 지정되지 않았어요." };
      // NOT_MEMBER_PROC_MSG 선언부 주석 참고 — pm2 를 부르기 전에 반드시 걸러야, 이미 나간
      // delete 를 되돌리는 게 아니라 애초에 나가지 않게 막는다.
      if (parseProcName(name) === null) return { ok: false, content: NOT_MEMBER_PROC_MSG };

      // Defect 2(운영 중 발견, KillTree 선언부 주석 참고): pm2 delete 는 자기 자식(cmd.exe/sh)만
      // 죽이고 그 밑의 실제 프로세스 트리는 못 죽인다 — delete 전에 jlist 로 pid 를 찾아 트리
      // 전체를 먼저 끝낸다. 이름을 못 찾으면(이미 사라졌거나 jlist 자체가 실패했으면) 죽일 pid 가
      // 없다는 뜻이므로 트리 kill 은 건너뛰고 아래 delete 로 그대로 진행한다 — "pid 를 못 구했다"는
      // "delete 도 하지 않는다"는 뜻이 아니다(예전에도 jlist 조회 없이 곧장 delete 를 불렀으니,
      // 최소한 그 동작은 그대로 보장한다).
      const before = await listProcs();
      const proc = before.ok ? before.procs.find((p) => p.name === name) : undefined;
      // 리뷰 지적(Important, Finding 1): pid !== null 만으로는 부족하다 — pm2 는 정지·오류 상태의
      // 앱에 pid:0 을 돌려준다(회원의 크래시한 개인 서버에 "꺼줘"를 부르는 보통의 경로가 정확히
      // 이 상태다). pid:0 이 이 검사를 통과하면 POSIX 분기의 process.kill(-pid, "SIGKILL")(위
      // killTree 선언부 참고)이 process.kill(-0, …) 이 되고, POSIX 표준은 pid 0 을 "신호를 보내는
      // 프로세스 자신의 그룹"으로 해석한다 — 워커가 도구 요청 하나로 자기 자신을 죽인다. pid 가
      // 양수인지까지 반드시 확인한다.
      //
      // status === "online" 도 함께 요구한다(컨트롤러 결정) — 공유 기계에서는 OS 가 pid 번호를
      // 재사용하므로, pm2 jlist 가 들고 있는 pid 가 이미 죽은 뒤 갱신되지 않은 값이라면 그 번호가
      // 지금 이 순간 완전히 다른(어쩌면 다른 회원의) 프로세스를 가리킬 수 있다. "online" 은 pm2
      // 자신이 "이 pid 가 바로 지금 이 앱의 것"이라고 확인해 주는 유일한 근거이고, 그 밖의
      // 상태(정지·오류 등)에는 그 근거가 없다 — 회원 하나를 멈추려다 공유 기계의 다른 무언가를
      // 죽이는 것보다는, 트리 kill을 건너뛰고 그 사실을 정직하게 알리는 쪽(아래 Finding 3)이 안전하다.
      // 리뷰 지적(Important, Finding 3): treeKilled 는 "트리 kill을 실제로 걸었고, killTree 가
      // 실패 신호(reject) 없이 끝났다"는 것만 뜻한다 — jlist 실패·이름 못 찾음·pid 무효(Finding 1)로
      // 아예 시도하지 않은 경우는 물론, 시도했지만 killTree 가 던진 경우(catch)까지 전부 false 로
      // 남는다. 아래 최종 메시지가 이 값을 그대로 반영한다.
      let treeKilled = false;
      if (proc && proc.status === "online" && proc.pid !== null && proc.pid > 0) {
        try {
          await killTree(proc.pid);
          treeKilled = true;
        } catch {
          // 트리 kill은 최선을 다하는 정리일 뿐 이 도구의 성패(delete 여부)를 좌우하지 않는다 —
          // 실패해도(이미 죽었거나 권한 문제) 아래 pm2 delete로 계속 진행한다. 다만 treeKilled는
          // false로 남겨, 아래 메시지가 "정리를 확인하지 못했다"고 정직하게 알리게 한다.
        }
      }

      const r = await runPm2(["delete", name]);
      if (!r.ok) return { ok: false, content: `멈추지 못했어요: ${r.stderr.trim() || "그런 프로세스가 없어요"}` };
      // 리뷰 지적(Important, Finding 3): pm2 delete 가 성공해도 그건 pm2 가 아는 자식(cmd.exe/sh)
      // 까지만 보장한다(KillTree 선언부 주석 참고) — treeKilled 가 false 면 그 밑의 진짜 서버
      // 프로세스가 여전히 돌고 있을 수 있는데, 예전엔 이 경우에도 "멈췄어요"만 그대로 돌려줘 이
      // 결함을 처음 만든 바로 그 증상(회원은 멈췄다고 믿지만 npm run dev 가 포트를 붙든 채
      // 남는다)을 되풀이했다. 확인하지 못했다는 사실 자체를 회원에게 그대로 전달한다.
      return treeKilled
        ? { ok: true, content: `멈췄어요: ${name}` }
        : {
            ok: true,
            content: `멈췄어요 — 다만 하위 프로세스까지 정리했는지는 확인하지 못했어요. "뭐 돌고 있어?" 로 확인해 주세요.`,
          };
    },

    async proc_list(args) {
      const g = procGate();
      if (!g.ok) return g.res;
      const r = await listProcs();
      if (!r.ok) return { ok: false, content: r.message };
      // 필터는 봇이 하지 않고 여기서 한다 — onlyUserId 는 remoteTools.ts 가 주입한다(손님이면
      // 자기 것만, 소유자면 생략해 전원).
      const only = str(args.onlyUserId);
      const procs = only === undefined ? r.procs : r.procs.filter((p) => p.userId === only);
      // labelOf 는 "디스코드 userId → 사람이 알아볼 이름"을 위한 자리지만, 워커는 디스코드를
      // 전혀 모른다(신원 해석은 봇만 할 수 있다 — proc.ts 상단 주석과 동일한 이유). 실제 이름
      // 해석은 이 범위 밖이므로, 최소한 pm2 프로세스 이름(asahi-<id>)으로 되돌려 누구 것인지
      // 알아볼 수 있게 한다 — procNameFor 는 parseProcName 의 역함수라 원래 이름과 정확히 같다.
      return { ok: true, content: truncate(renderProcList(procs, { labelOf: (id) => procNameFor(id) })) };
    },

    async proc_logs(args) {
      const g = procGate();
      if (!g.ok) return g.res;
      const name = str(args.name);
      if (!name) return { ok: false, content: "로그를 볼 프로세스가 지정되지 않았어요." };
      // proc_stop 과 같은 이유(NOT_MEMBER_PROC_MSG 선언부 주석 참고) — 봇·워커 자신의 로그를
      // 회원에게 그대로 노출하지 않는다.
      if (parseProcName(name) === null) return { ok: false, content: NOT_MEMBER_PROC_MSG };
      // Defect 3(운영 중 발견, 문서만): pm2 가 캡처하는 stdout 은 파이프 버퍼링을 거친다 — 자식
      // 프로세스가 stdout 을 파일이 아니라 파이프로 볼 때, 많은 런타임의 표준 출력 버퍼가 줄
      // 단위(line-buffered)가 아니라 블록 단위(fully-buffered)로 바뀌는 게 원인이다(터미널에
      // 붙어 있을 때만 줄 단위가 되는 게 흔한 기본값이다). 실측: 계속 출력을 내는 `ping -t` 를
      // pm2 로 띄웠더니 "정상적으로 실행 중"인데도 이 도구가 돌려주는 로그가 0바이트였다 — 같은
      // 명령을 파일로 리다이렉트해서 실제로 출력이 쌓이고 있음을 별도로 확인했다(pm2 문제가
      // 아니라 파이프 자체의 특성). 그래서 이 도구가 빈 로그("(로그가 비어 있어요)")를 돌려줘도
      // "그 프로세스가 안 돌고 있다"거나 "출력을 안 냈다"는 뜻이 아니다 — proc_list 로 status 를
      // 함께 확인해야 한다. 다음에 이걸로 헤매지 않도록 여기 남긴다 — 동작은 바꾸지 않는다.
      const lines = Math.max(1, Math.min(num(args.lines) ?? PROC_LOG_DEFAULT_LINES, 200));
      const r = await runPm2(["logs", name, "--nostream", "--lines", String(lines)]);
      if (!r.ok) return { ok: false, content: `로그를 가져오지 못했어요: ${r.stderr.trim() || "그런 프로세스가 없어요"}` };
      const body = r.stdout.trim();
      return { ok: true, content: truncate(body.length > 0 ? body : "(로그가 비어 있어요)") };
    },
  };
}
