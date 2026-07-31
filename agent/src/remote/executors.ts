import fs from "node:fs/promises";
import os from "node:os";
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
import { pathFlavorOf, isPathWithinAny } from "../core/paths.js";
import { parsePm2List, renderProcList, procNameFor, parseProcName, type ProcInfo } from "./proc.js";

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

// sh_exec 의 타임아웃 메시지 두 곳(아래 hardTimer 갈래·close 핸들러의 timedOut 갈래)이 이
// 문구를 그대로 복제해 갖고 있었다. hardTimer 갈래는 KILL_GRACE_MS+FORCE_KILL_GRACE_MS(5초)가
// 지나도록 close 가 끝내 오지 않아야만 실행되는 경로라, 실제 프로세스로 재현하려면 "강제종료에도
// 안 죽는 프로세스"를 만들어야 해서 느리고 불안정하다 — 그래서 어떤 테스트도 그 경로를 실행하지
// 않는다. 문구를 각 갈래에 따로 적어두면, hardTimer 쪽 문구가 지워지거나 오타가 나도 테스트가
// 실행 없이는 잡을 방법이 없다(둘째, 두 문장이 따로 존재하는 한 나중에 한쪽만 고쳐 말이 갈릴
// 수도 있다). 상수 하나로 뽑아 두 메시지가 같은 값을 참조하게 하면, 이 상수의 내용만 단정해도
// (실행 없이) 두 메시지 모두가 같은 문구임을 보장할 수 있다 — 값이 하나뿐이라 갈릴 수가 없다.
export const SH_EXEC_TIMEOUT_HINT = "계속 도는 프로그램이라면 proc_start 로 띄워야 해요.";

// PM2 CLI 호출을 이음매 뒤로 뺀다. 테스트가 실제 PM2 설치를 요구하면 그 경로는 CI 에서도
// 개발자 기계에서도 한 번도 지나가지 않는다 — 2026-07-28 최종 리뷰가 잡은 Critical(실패 신호
// 소실)이 정확히 그렇게 다섯 번의 리뷰를 통과했다.
export type RunPm2 = (args: string[]) => Promise<{ ok: boolean; stdout: string; stderr: string }>;

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
// 이 인용이 다루는 건 "표준 윈도우 argv 파싱"이라는 한 겹뿐이다. quoteWin32 가 이 \" 이스케이프
// 로직을 갖춘 것은 원래 proc_start 의 command 인자(예: npm run dev -- --title="hi there")처럼
// 모델·사용자가 자유롭게 채워 큰따옴표를 담을 수 있는 값을 겨냥해서였다 — 그런데 바로 그 경로가
// spawn(commandLine, {shell:true}) 가 띄우는 cmd.exe 자신의 재파싱과 부딪혀 실제 사고로
// 이어졌다(아래 buildPm2CommandLine 뒤의 "실제 사고 원인과 고침" 참고 — cmd.exe 는 \" 를 모른다).
// 그래서 지금 command 는 이 함수에 아예 넘어오지 않는다(스크립트 파일로 우회). quoteWin32 자신은
// 여전히 옳고 필요하다 — --cwd·스크립트 경로처럼 공백은 있어도 큰따옴표는 없는 단순 인자에
// 계속 쓰인다. 다만 cmd.exe
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

// 실제 사고 원인과 고침(2026-07-30, 미니PC 실측으로 확정 — 재추론하지 말 것): 위 buildPm2CommandLine
// 은 MSVCRT/CommandLineToArgvW 규칙으로 인용한다 — 임베디드 큰따옴표는 \" 로, 그 앞 백슬래시는
// 두 배로 늘린다. 그런데 그렇게 만든 문자열을 처음 파싱하는 것은 이 규칙을 따르는 프로그램이
// 아니라 spawn(commandLine, {shell:true}) 가 띄우는 **cmd.exe 자신**이다 — cmd.exe 는 \" 를 모른다.
// 백슬래시를 리터럴 문자로 그대로 두고 큰따옴표 개수만 세어 인용 모드를 토글하므로, 첫 임베디드
// 큰따옴표(예: command = npm run dev -- --title="hi there")부터 토큰 경계가 전부 어긋난다.
//
// 미니PC 에서 직접 재현·확정한 사실:
//   - 공백 없는 단순 명령(인용 자체가 필요 없음): 어떤 cwd 에서도 online 으로 성공.
//   - 한글+공백 폴더("…\테스트 1")에서 큰따옴표가 든 명령: stopped, 로그 0바이트.
//   - **ASCII 만 쓴** 공백 폴더("…\test dir")에서 같은 명령: 역시 stopped, 로그 0바이트 — 이
//     한 줄이 핵심이다. 한글이 원인이었다면 이 경우는 성공했어야 한다. 바뀐 변수는 "인용이
//     필요한 큰따옴표의 유무"뿐이었다.
//   - 명령을 .bat 스크립트 파일에 적어 pm2 start ... -- /c <스크립트경로> 로 띄운 형태는 두
//     경우(한글+공백 cwd, ASCII+공백 cwd) 모두 online 으로 성공했다.
// 파일 "내용"은 어떤 셸도 명령줄로 파싱하지 않고 줄 단위로 그대로 읽으므로, 명령을 파일에 적어
// 넘기면 인용 자체가 필요 없어진다 — cmd.exe 가 이해하지 못하는 인용 규칙과 다시 마주칠 일이
// 없다. 그래서 proc_start(아래)는 회원의 명령을 pm2 명령줄 인자로 절대 넘기지 않고, 이 스크립트
// 파일에 적은 뒤 그 "경로"만 인자로 준다 — --cwd·스크립트 경로처럼 임베디드 큰따옴표가 없는
// 단순 인자는 지금도 buildPm2CommandLine 을 그대로 거친다(깨지는 건 \" 뿐이므로 이 좁은 인용은
// 그 인자들에는 여전히 정확하고 충분하다). 이 우회를 걷어내고 명령을 다시 명령줄 인자로 합치면,
// 위 재현이 그대로 재발한다 — "간단해 보인다"는 이유로 되돌리지 말 것.
export function scriptContentFor(command: string, flavor: ShellFlavor): string {
  const header = flavor === "win32" ? "@echo off" : "#!/bin/sh";
  // 참고(유지보수 경고): pm2 는 pm2.cmd — 배치 파일이다. 배치 파일 안에서 다른 배치 파일을 call
  // 없이 부르면 실행 흐름이 그쪽으로 완전히 넘어가 버려(제어가 돌아오지 않는다) 그 뒤에 이어 적은
  // 어떤 줄도 조용히 실행되지 않는다. 지금 이 함수는 명령 한 줄만 담아 해당 사항이 없지만(더
  // 실행할 줄 자체가 없다), 언젠가 이 본문 뒤에 로그·종료 코드 처리 등을 이어 붙이게 되면 그 새
  // 줄이 pm2(.cmd) 든 다른 .cmd/.bat 든 배치 파일을 부를 경우 반드시 call 을 써야 한다.
  return `${header}\n${command}\n`;
}

// Finding 1(Critical, 후속 리뷰 — 미니PC 실측으로 확정, 재추론하지 말 것): 위에서 명령을 스크립트
// 파일에 적어 pm2 명령줄 인용 문제(\" 를 cmd.exe 가 이해 못 하는 것)는 피했지만, 그 스크립트 파일
// 자체를 writeStartScript(아래)가 UTF-8(BOM 없음)로 쓰는 것과 cmd.exe 가 배치 파일을 읽을 때 쓰는
// 인코딩이 서로 다르다 — cmd.exe 는 배치 파일이 실제로 어떤 인코딩으로 저장됐는지와 무관하게
// "시스템 ANSI 코드페이지"로 그 파일을 읽는다. 미니PC(`chcp` 결과 949)에서 한글 경로의 loop.js 를
// 실행하는 동일한 명령(node "<한글 경로>\loop.js")을 배치 파일 인코딩만 바꿔 가며 세 가지로
// 실측했다:
//
//   배치 파일 인코딩                            | pm2 상태
//   --------------------------------------------|-------------------
//   UTF-8, BOM 없음(지금 writeStartScript 형태)  | stopped, 0b
//   UTF-8 + 파일 첫 줄에 `chcp 65001>nul` 추가    | stopped, 0b
//   cp949                                        | online, 8.0mb
//
// 즉 파일 안에 chcp 를 넣어도 소용없다 — cmd.exe 는 파일을 한 줄씩 읽으며 "그 chcp 줄 자신"까지도
// 이미 시스템 코드페이지로 디코드한 뒤이므로, chcp 명령이 실제로 적용되는 시점은 이미 늦다. 다음에
// 이걸 보는 사람이 "그럼 파일 맨 앞에 chcp 를 추가하면 되지 않나"로 "고치고" 싶어질 수 있는데, 위
// 표의 둘째 줄이 정확히 그 시도이고 실패했다 — 다시 시도하지 말 것. 유일하게 동작한 것은 파일을
// 그 미니PC 의 시스템 코드페이지(cp949)로 직접 쓰는 것뿐인데, Node 에는 내장 cp949 인코더가 없고
// 정확한 코드페이지는 기계마다 다르다(시스템 로캘 설정에 종속) — 이를 일반적으로 구현하는 것은
// 작은 변경이 아니다.
//
// 결정(사용자 결정, 2026-07-30): 스크립트를 cp949 로 옮겨 쓰는 대신, 스크립트를 ASCII 전용으로
// 제한하고 ASCII 가 아닌 명령은 거부한다. 실무 제약은 좁다 — 작업 폴더(cwd)는 이 검사와 무관하게
// 명령줄의 --cwd 인자로 넘어가고, 그 경로는 CreateProcessW(UTF-16)를 거치므로 한글·공백을 이미
// 문제없이 처리한다(미니PC 실측으로 확인됨 — 위 buildPm2CommandLine 뒤 "실제 사고 원인과 고침"의
// "한글+공백 폴더" 사례 참고) — 그러니 한글이 문제가 되는 자리는 "회원 명령 문자열 자체"에 한글이
// 섞였을 때뿐이다. "npm run dev"·"npm start"·"python app.py" 류는 전혀 영향받지 않고, "node
// 서버.js" 처럼 명령 자체에 한글이 섞인 경우만 거절 대상이다.
//
// POSIX(.sh)는 이 제약을 받지 않는다 — sh 는 스크립트 파일을 "시스템 코드페이지"로 다시 디코드하는
// 계층이 없다. 셸의 토큰 분리는 ASCII 공백·메타문자 기준이고 UTF-8 연속 바이트(0x80 이상)는 그
// 무엇과도 겹치지 않으므로, 쓸 때와 같은 인코딩(UTF-8)의 로캘에서 읽으면 바이트가 그대로 왕복한다
// — cmd.exe 처럼 "쓴 인코딩과 읽는 인코딩이 다르다"는 문제 자체가 성립하지 않는다. 그래서 아래
// 검사는 flavor==="win32" 일 때만 적용한다 — 윈도우의 한계를 POSIX 에 조용히 옮기지 않는다.
function hasNonAsciiChar(s: string): boolean {
  return /[^\x00-\x7F]/.test(s);
}

const NON_ASCII_COMMAND_MSG =
  "명령에 한글 등 ASCII 가 아닌 문자가 있어 실행할 수 없어요 — 폴더 경로(한글·공백 가능)는 path 인자로 넣고, 명령 자체는 영문·숫자·기호만 쓰세요.";

// name 은 오늘 remoteTools.ts 가 항상 procNameFor(디스코드 userId, "asahi-<숫자>")로 주입한다(이
// 실행기에 직접 닿는 다른 프로덕션 경로가 없다). 그래도 이 값을 그대로 파일 경로 조각으로 쓰므로,
// paths.ts 의 joinUnderRoot(SEGMENT_PATTERN)와 같은 이유로 영숫자·밑줄·하이픈 밖의 문자는 전부
// 밑줄로 바꿔 경로 구분자·'..' 가 섞여도 스크립트 폴더를 벗어나는 경로를 만들 수 없게 한 번 더
// 방어적으로 막는다.
function safeFileStem(name: string): string {
  return name.replace(/[^A-Za-z0-9_-]/g, "_");
}

// proc_start 의 스크립트 파일 기본 위치. 회원 폴더(roots) 밖에 둔다 — 그 폴더는 회원 것이라
// 낯선 생성 파일이 섞이면 혼란스럽고, 회원이 그 내용을 직접 고쳐 다음 실행에 영향을 줄 수도
// 있다. os.tmpdir() 은 워커 프로세스를 몇 번을 다시 띄워도 같은 값이라, "이름별로 항상 같은
// 경로"가 자연히 보장된다(opts.scriptDir 로 테스트가 격리된 위치를 주입할 수 있다 — 아래
// makeExecutors 참고).
const DEFAULT_SCRIPT_DIR = path.join(os.tmpdir(), "asahi-proc-scripts");

// scriptDir·name·flavor 로 writeStartScript 가 쓴(또는 쓸) 스크립트 경로를 결정한다. 이름을 파일
// 경로 조각으로 바꾸는 규칙(safeFileStem)과 확장자 규칙은 여기 단 한 곳에만 있어야 한다 —
// writeStartScript(쓰기)와 recoverCommands(아래, 읽기)가 서로 다른 규칙으로 각자 경로를
// 계산하면, 둘 중 하나만 고쳐졌을 때 조용히 다른 파일을 가리키게 된다.
function scriptPathFor(scriptDir: string, name: string, flavor: ShellFlavor): string {
  const ext = flavor === "win32" ? "bat" : "sh";
  return path.join(scriptDir, `${safeFileStem(name)}.${ext}`);
}

// 회원 명령을 스크립트 파일에 적고 그 경로를 돌려준다(위 "실제 사고 원인과 고침" 참고). 이름당
// 파일 하나이고 재시작마다 덮어쓴다 — proc_start 는 같은 이름이 이미 떠 있으면 이 함수를 부르기
// 전에 이미 거절하므로(조용한 교체 금지, 아래 proc_start 참고), 이 시점에 도달했다는 것 자체가
// "이 이름으로 새로 써도 안전하다"는 뜻이다. 예전 스크립트 파일을 지우는 절차는 따로 두지 않는다
// — 최신 파일이 그 자리를 그대로 덮어쓰므로 쌓일 게 없다(proc_stop 에서의 정리 여부는 그 실행기
// 선언부에서 따로 설명한다).
export async function writeStartScript(
  scriptDir: string,
  name: string,
  command: string,
  flavor: ShellFlavor,
): Promise<string> {
  const scriptPath = scriptPathFor(scriptDir, name, flavor);
  await fs.mkdir(scriptDir, { recursive: true });
  await fs.writeFile(scriptPath, scriptContentFor(command, flavor), "utf8");
  return scriptPath;
}

// scriptContentFor(위)가 쓴 "헤더 한 줄 + 명령 한 줄"에서 명령 부분만 되돌린다. 첫 줄바꿈까지가
// 헤더(@echo off 또는 #!/bin/sh)이고, 그 뒤부터 파일 끝의 줄바꿈 하나를 뺀 나머지가 원래 명령이다
// — split("\n") 으로 둘째 줄만 집으면 명령 자체에 줄바꿈이 섞였을 때 뒷부분을 잃으므로, 첫
// 줄바꿈의 위치만 찾아 그 뒤 전체를 취한다. 형식이 예상과 다르면(줄바꿈 자체가 없는 등, 사람이
// 파일을 직접 건드린 경우) undefined 를 돌려주고 판단은 호출측(recoverCommands)에 맡긴다.
//
// Finding 6(Minor, 후속 리뷰): 위에서 "명령 자체에 줄바꿈이 섞여도 잃지 않는다"고 했는데, 그
// 값을 그대로 돌려주면 그 줄바꿈이 되찾은 값에도 그대로 남는다 — renderProcList(proc.ts)는
// "프로세스 하나 = 줄 하나"를 전제하므로, 줄바꿈 하나가 표에 유령 행을 만들어 모델이 실제보다
// 프로세스가 더 많다고 읽을 수 있다(중복 거절 메시지도 한 줄짜리 문장을 전제하므로 마찬가지로
// 영향을 받는다). 값을 통째로 버리면(undefined) 되찾기 자체가 실패한 것처럼 보여 UX 회귀
// (Change 4)가 되살아나므로, 정보를 죽이지 않고 줄바꿈만 공백으로 뭉갠다 — 표 구조를 지키는
// 것과 회원이 실제로 무엇을 실행했는지 알 수 있는 것을 모두 지킨다.
function commandFromScriptContent(content: string): string | undefined {
  const headerEnd = content.indexOf("\n");
  if (headerEnd === -1) return undefined;
  const rest = content.slice(headerEnd + 1);
  const command = rest.endsWith("\n") ? rest.slice(0, -1) : rest;
  return command.replace(/\r\n|\r|\n/g, " ");
}

// UX 회귀 수정(2026-07-30): 회원 명령을 pm2 명령줄에 절대 넘기지 않기로 한 결정(위 "실제 사고
// 원인과 고침" 참고) 이후, pm2 jlist 가 돌려주는 명령은 더 이상 회원이 실제로 실행한 "npm run
// dev" 같은 값이 아니라 writeStartScript 가 만든 스크립트 파일의 "경로"다 — pm2 는 cmd.exe/sh 로
// 그 경로를 여는 것만 알 뿐, 안에 무엇이 있는지 모른다. pm2 로부터는 원래 명령을 영영 되찾을 수
// 없다는 뜻이다. 그런데 그 파일을 "쓴" 것은 다름 아닌 이 워커 자신이고, 경로는 scriptPathFor 로
// 이름만 알면 언제든 같은 규칙으로 다시 계산할 수 있다 — 그래서 pm2 에 원래 명령을 실어 보내는
// 대신, 우리가 이미 디스크에 적어 둔 값을 다시 읽어 오는 쪽을 택한다.
//
// 이 되찾기가 없으면 proc_list·proc_start 의 중복 거절 메시지가 회원에게
// "C:\...\asahi-proc-scripts\asahi-111.bat" 같은, 아무 의미도 없는 경로를 그대로 보여준다 —
// proc_list 가 존재하는 이유 자체(부원이 "뭐 돌고 있어?"라고 물었을 때 모델의 기억이 아니라
// 워커가 확인한 사실을 답하기 위함이고, 서로 다른 회원의 서버를 이름만으로 구분할 수 있어야
// 한다는 것)가 무색해진다. 나중에 누군가 "그냥 명령을 다시 pm2 명령줄에 실으면 간단하지 않냐"고
// 되돌리고 싶어질 수 있는데, 그러면 cmd.exe 가 MSVCRT `\"` 인용을 이해하지 못해 토큰 경계가
// 깨지는 원래 사고(buildPm2CommandLine 뒤 "실제 사고 원인과 고침" 참고)가 그대로 재발한다 —
// 이 되찾기가 그 유혹에 대한 유일한 정답이다.
//
// 스크립트 파일이 없거나(회원이 지웠다·아직 한 번도 안 썼다 등) 못 읽으면 pm2 가 보고한 값을
// 그대로 둔다 — 파일 하나가 없다고 proc_list 호출 전체를 실패시키면 안 된다(회원이 자기 프로세스
// 목록 전체를 잃는 것이 파일 하나를 못 읽는 것보다 항상 더 나쁘다). userId 가 null 인 항목
// (asahi-assistant·asahi-worker 같은 봇·워커 자신의 PM2 앱, deploy/ecosystem.config.cjs)은
// 건드리지 않는다 — writeStartScript 를 거치지 않으므로 대응하는 스크립트 파일 자체가 없고,
// 있어서도 안 된다. 이 함수는 순수 로직만 담는 proc.ts 가 아니라 여기(파일시스템에 닿는
// executors.ts)에 둔다 — proc.ts 는 fs·CLI 를 모르는 채로 남아야 한다(파일 상단 주석 참고).
//
// Finding 2(Important, 후속 리뷰): "이름이 같은 스크립트 파일이 있다"와 "이 프로세스가 실제로
// 그 파일에서 시작됐다"는 서로 다른 사실이다 — proc_stop 은 스크립트 파일을 지우지 않으므로
// (proc_stop 선언부 참고) 파일이 프로세스보다 오래 살아남는다. 회원이 asahi-111 로 A 를
// 띄웠다가 멈추면(파일은 남는다), 같은 pm2 이름으로 sh_exec + pm2 start 를 통해 완전히 다른
// 명령 B 를 직접 띄울 수 있다(능력 모델이 명시적으로 허용하는 경로 — capability-model.md
// "손님·공유 기계" 참고). 그 순간 파일 "이름"만 보고 되찾으면, 죽은 A 의 명령을 지금 도는 B 인
// 것처럼 proc_list·중복 거절 메시지에 "사실"이라고 보여주게 된다 — 워커가 확인한 사실을
// 답한다는 이 되찾기의 존재 이유 자체를 배반한다. 그래서 파일을 열기 전에 먼저 pm2 가 실제로
// 보고한 값(p.command, commandOf 의 결과)이 이 스크립트 경로를 실제로 가리키는지부터 확인한다
// — 그 경로를 언급하지 않으면(다른 명령으로 재시작됐다는 증거) 파일을 아예 열어 보지 않고 pm2
// 가 보고한 값을 그대로 둔다. p.command 가 정확히 그 경로와 같지 않고 "포함"만 해도 통과시키는
// 이유는, 정상 경로(writeStartScript 로 띄운 프로세스)에서 commandOf 가 셸 래퍼를 걷어내면 그
// 경로 문자열 자체가 고스란히 남기 때문이다(includes 는 이 경우를 정확히 포함하는 가장 단순한
// 조건이다).
export async function recoverCommands(procs: ProcInfo[], scriptDir: string, flavor: ShellFlavor): Promise<ProcInfo[]> {
  return Promise.all(
    procs.map(async (p) => {
      if (p.userId === null) return p;
      const scriptPath = scriptPathFor(scriptDir, p.name, flavor);
      if (!p.command.includes(scriptPath)) return p;
      let content: string;
      try {
        content = await fs.readFile(scriptPath, "utf8");
      } catch {
        return p;
      }
      const command = commandFromScriptContent(content);
      return command === undefined ? p : { ...p, command };
    }),
  );
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

// sh_exec 의 본문 문구를 만든다. close 핸들러 안에 인라인으로 두면 문자열 조합만 따로 검증할
// 방법이 없어(자식 프로세스를 실제로 띄워야 한다) 순수 함수로 뺀다.
//
// 출력이 비었을 때 그 사실을 명시하는 이유: 빈 문자열만 돌려주면 모델은 "도구가 아무 말도
// 안 했다"와 "명령이 아무것도 출력하지 않았다"를 구분할 수 없다. 실사용에서 netstat|findstr 이
// 정확히 이 모양(빈 출력 + exit 1)이었고, 모델이 매번 문맥으로 추측해야 했다.
export function describeExit(out: string, code: number | null): string {
  const body = out.length > 0 ? out : "(출력 없음)";
  if (code === 0) return body;
  // code 가 null 이면 프로세스가 신호로 끝난 것이다(POSIX 에서 흔하다). "(종료 코드 null)" 은
  // 아무 정보도 주지 못하므로 무슨 일이 있었는지를 그대로 적는다.
  return code === null ? `${body}\n(신호로 종료됨)` : `${body}\n(종료 코드 ${code})`;
}

const str = (v: unknown): string | undefined => (typeof v === "string" && v.length > 0 ? v : undefined);
const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

export function makeExecutors(roots: string[], opts: { runPm2?: RunPm2; scriptDir?: string } = {}): Executors {
  // proc_start 가 회원 명령을 적을 스크립트 파일 위치(DEFAULT_SCRIPT_DIR·writeStartScript 선언부
  // 참고) — 테스트가 실제 OS 임시폴더를 더럽히지 않고 파일 내용을 직접 들여다볼 수 있도록 주입
  // 지점을 열어 둔다. 프로덕션(worker.ts)은 opts 를 생략하므로 항상 기본값을 쓴다.
  const scriptDir = opts.scriptDir ?? DEFAULT_SCRIPT_DIR;

  // Finding 3(Minor, 후속 리뷰): DEFAULT_SCRIPT_DIR 선언부의 "회원 폴더(roots) 밖에 둔다"는
  // 지금까지 강제되지 않는 주석일 뿐이었다 — roots(WORKER_ROOTS)에 언젠가 사용자 프로필 폴더가
  // 포함되면(개인 워커에서는 충분히 있을 수 있는 설정) scriptDir 이 roots 안에 들어오고, 그
  // 순간부터 fs_write·fs_edit 로 회원이 자기 .bat/.sh 파일 내용을 직접 고쳐 proc_start 가 실제로
  // 실행할 내용을 바꿔치기할 수 있다 — 파일이 "이 회원이 요청한 명령을 기록하는 자리"에서 "이
  // 회원이 마음대로 다시 쓸 수 있는 자리"로 바뀌는 것이다. roots·scriptDir 은 이 함수 호출 동안
  // 바뀌지 않으므로 proc_start 호출마다 다시 판정하지 않고 한 번만 계산해 둔다(아래 proc_start
  // 가 이 값을 참조해 거절한다 — 조용히 넘어가지 않고 명시적으로 실패한다).
  const scriptDirIsSafe = !isPathWithinAny(scriptDir, roots);

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

  // 경로 인자를 검사해 실경로를 돌려준다. 거부되면 그대로 ExecResult 로 반환한다.
  const gate = (raw: unknown): { ok: true; path: string } | { ok: false; res: ExecResult } => {
    const p = str(raw);
    if (!p) return { ok: false, res: { ok: false, content: "path 인자가 필요해요." } };
    const c = checkPath(p, roots);
    return c.ok ? { ok: true, path: c.path } : { ok: false, res: { ok: false, content: c.message } };
  };

  // proc_start(아래)가 스크립트 파일(writeStartScript 가 만든 .bat/.sh)을 열 셸을 고른다. 어느
  // 셸인지는 워커 루트의 플레이버로 정한다 — 봇은 리눅스, 워커는 윈도우일 수 있어 호스트
  // 플랫폼으로 정하면 어긋난다(paths.ts 와 같은 이유). 이 판정은 기본 runPm2(위)의 명령줄 인용과
  // 같은 기준을 써야 하므로 shellFlavorOf 로 뺐다.
  //
  // flag 는 윈도우에만 있다 — cmd.exe 는 /c 뒤에 배치파일 경로를 그대로 줘도 그 파일을 실행하지만,
  // POSIX sh 는 다르다: -c 는 "다음 인자를 명령 '문자열'로 실행하라"는 뜻이라 파일 경로에는 맞지
  // 않는다(sh -c '/path/to/a.sh' 는 그 경로를 명령 문자열로 해석해 실행 권한이 없으면 그냥
  // 실패한다). 플래그 없이 경로를 그대로 첫 인자로 주면 sh 가 그 파일을 스크립트로 직접 열어
  // 실행 권한 여부와 무관하게 동작한다 — 그래서 POSIX 쪽은 flag 가 없다.
  const shellFor = (): { bin: string; flag?: string } =>
    shellFlavorOf(roots) === "win32" ? { bin: "cmd.exe", flag: "/c" } : { bin: "sh" };

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
                  `${out}\n(${timeoutMs}ms 안에 끝나지 않아 중단했어요 — 강제종료에도 응답이 없어 대기를 포기했어요. ${SH_EXEC_TIMEOUT_HINT})`,
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
            finish({
              ok: false,
              content: truncate(
                `${out}\n(${timeoutMs}ms 안에 끝나지 않아 중단했어요. ${SH_EXEC_TIMEOUT_HINT})`,
              ),
            });
            return;
          }
          // 명령이 끝까지 실행됐다면 sh_exec 는 제 일을 한 것이다 — 종료 코드가 0이 아니어도
          // ok:true 다. 셸에서 non-zero 는 실패 신호가 아니라 통신 수단이라(findstr/grep 의 1 은
          // "매칭 없음", diff 의 1 은 "차이 있음", test 의 1 은 "거짓"), 이걸 도구 실패로 옮기면
          // 모델이 <error> 로 받는다 — core/tools.ts 의 remoteResult 가 ok 를 그대로 isError 로
          // 싣기 때문이다. 실사용 실패 8건 중 5건이 정확히 이 오분류였다.
          //
          // ok:false 는 "도구가 명령을 실행하지 못했다"로 좁힌다 — spawn 실패(child.on("error"))와
          // 타임아웃(위 timedOut 갈래)뿐이다. 종료 코드에 대한 해석("findstr 이라면 매칭 없음")은
          // 넣지 않는다: 셸 명령은 무한하고 파이프라인이면 마지막 명령의 코드라 어떤 목록도
          // 정확할 수 없다. 사실만 전달하고 판단은 모델에게 맡긴다.
          finish({ ok: true, content: truncate(describeExit(out, code)) });
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
      // Finding 3(Minor, 후속 리뷰): 위 scriptDirIsSafe 선언부 참고 — 회원의 명령·이름·cwd 를
      // 보기도 전에, 이 워커 자신의 설정이 안전한 전제를 지키는지부터 확인한다. 이 판정은
      // 개별 호출의 인자와 무관하므로(roots·scriptDir 은 makeExecutors 호출 동안 고정) 가장
      // 먼저 걸러도 된다.
      if (!scriptDirIsSafe) {
        return {
          ok: false,
          content: `워커 설정 오류로 실행할 수 없어요 — 실행 스크립트를 저장하는 폴더(${scriptDir})가 회원 작업 폴더 안에 있어요. 이대로 두면 fs_write·fs_edit 로 그 스크립트 내용을 직접 바꿔 다음 실행에 영향을 줄 수 있으니, 스크립트 폴더 설정을 회원 작업 폴더 밖으로 옮겨야 해요(관리자에게 알려주세요).`,
        };
      }
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

      // flavor 를 dup 판정보다 먼저 뽑아 둔다 — 아래 거절 메시지에서도 recoverCommands 에 같은
      // 값을 써야 하고(스크립트 파일 확장자가 갈리면 다른 파일을 찾는다), writeStartScript 호출부
      // (더 아래)에서도 어차피 필요하므로 한 번만 계산해 공유한다.
      const flavor = shellFlavorOf(roots);

      // Finding 1(Critical, 후속 리뷰): 스크립트를 쓰기도, pm2 를 부르기도 전에 거절한다 — 위
      // hasNonAsciiChar 선언부의 실측 표 참고(윈도우에서만 적용, POSIX 는 이 제약이 없다).
      if (flavor === "win32" && hasNonAsciiChar(command)) {
        return { ok: false, content: NON_ASCII_COMMAND_MSG };
      }

      const before = await listProcs();
      if (!before.ok) return { ok: false, content: before.message };
      const dup = before.procs.find((p) => p.name === name);
      // 조용히 교체하지 않는다 — 부원이 자기도 모르게 돌던 서버를 잃는다. 바꾸려면 멈추고 다시 띄운다.
      if (dup) {
        // recoverCommands 선언부의 "UX 회귀 수정" 참고 — dup.command 는 pm2 jlist 가 돌려준
        // 스크립트 경로일 뿐이므로, 그대로 보여주면 회원은 "내가 뭘 이미 띄워놨었지?"에 답을 얻지
        // 못한다. 스크립트 파일에서 되찾은 원래 명령으로 바꿔 보여준다.
        const [recovered] = await recoverCommands([dup], scriptDir, flavor);
        return {
          ok: false,
          content: `이미 돌고 있는 게 있어요: ${recovered.command} (${dup.status}). 먼저 멈춰야 새로 띄울 수 있어요.`,
        };
      }

      const sh = shellFor();
      // 실제 사고 원인 수정: command 를 pm2 명령줄 인자로 직접 넘기지 않는다(buildPm2CommandLine
      // 선언부의 "실제 사고 원인과 고침" 참고) — 스크립트 파일에 적고 그 경로만 넘긴다.
      let scriptPath: string;
      try {
        scriptPath = await writeStartScript(scriptDir, name, command, flavor);
      } catch (err) {
        return { ok: false, content: `실행 스크립트를 만들지 못했어요: ${err instanceof Error ? err.message : String(err)}` };
      }
      // cwd 가 아니라 cwdCheck.path 를 쓴다 — fs_* 의 gate() 가 g.path(검사에서 나온 실경로)로 실제
      // 파일시스템 작업을 하는 것과 같은 이유다(심볼릭 링크 등을 해석한 정규화된 값). scriptPath 도
      // --cwd 와 마찬가지로 임베디드 큰따옴표가 없는 단순 경로라 buildPm2CommandLine 을 그대로
      // 거쳐도 안전하다(공백이 있어도 인용만 되고 깨지지 않는다 — 위 buildPm2CommandLine 주석 참고).
      //
      // --no-autorestart 로 띄운다(컨트롤러 결정, Finding 5) — 오타 난 개발서버가 크래시를
      // 반복해도 회원 눈에 안 보이게 재시작을 계속하면, 아래 재조회가 그 순간 크래시 루프의
      // 어느 타이밍을 볼지 재시작 간격에 따라 흔들린다. 꺼두면 한 번 죽고 그대로 멈추므로,
      // 재조회가 실패를 매번 결정론적으로 잡아낸다. (예전엔 proc_stop 의 트리 kill과 pm2
      // 재시작 사이의 경쟁을 막는다는 이유도 적혀 있었지만, 그 트리 kill 자체가 오진단에 기반한
      // 조치였다 — pm2 delete 는 실측으로 이미 트리 전체를 정리하는 것이 확인돼 되돌렸다. 이
      // 플래그의 근거는 이제 Finding 5 하나뿐이다.)
      const r = await runPm2([
        "start", sh.bin, "--name", name, "--cwd", cwdCheck.path, "--no-autorestart",
        "--", ...(sh.flag !== undefined ? [sh.flag] : []), scriptPath,
      ]);
      if (!r.ok) return { ok: false, content: `띄우지 못했어요: ${r.stderr.trim() || r.stdout.trim() || "알 수 없는 오류"}` };

      // 리뷰 지적(Minor, Finding 5 — 원래 M2 리뷰): pm2 의 start 호출이 ok:true 여도 "pm2 가 프로세스
      // 등록에 성공했다"는 뜻일 뿐, 명령 자체가 오타 등으로 즉시 죽으면 상태가 곧바로 무너진다 —
      // 여기서 바로 "띄웠어요"라고 알리면 그 실패도 성공으로 들린다. 재조회 한 번으로 실제 상태를
      // 확인해 보고한다(재시도·대기 루프는 두지 않는다 — 그 순간의 스냅샷만 정직하게 전달하면
      // 충분하고, pm2 가 안정화되길 기다리는 건 별개의 더 큰 설계다). 위에서 --no-autorestart 를
      // 켠 뒤로는(이 브랜치 후속 리뷰 Finding 4) 이 재조회가 잡아내는 것이 "크래시 루프 중간의 스냅샷"이
      // 아니라 "한 번 죽고 멈춘, 흔들리지 않는 결과"라 이 확인이 오히려 더 믿을 만해졌다.
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

      // 결정: writeStartScript(위)가 만든 스크립트 파일은 여기서 지우지 않는다. 이름당 파일 하나
      // 라 proc_start 가 재시작마다 덮어쓰므로, 지우지 않아도 회원 한 명이 몇 번을 다시 띄우든
      // 파일이 늘어나지 않는다(쌓이는 건 "한 번도 안 지운 게" 아니라 "멈춘 뒤 다시는 안 띄운"
      // 회원 수만큼뿐이고, 동아리 규모에서는 무시할 만하다). 지우면 오히려 잃는 게 있다 — 방금
      // 멈춘 프로세스가 정확히 무엇을 실행했는지 미니PC 에서 파일 하나로 바로 확인할 수 있는
      // 진단 자료가 사라진다. 지우지 않기로 한다.
      //
      // 되돌림(2026-07-30): 한때 이 자리에 pm2 delete 전에 jlist 로 pid 를 찾아 taskkill /T 등으로
      // 프로세스 트리를 먼저 끝내는 코드가 있었다("pm2 delete 는 자기 자식만 죽이고 손자 프로세스는
      // 고아로 남는다"는 운영 관찰에 대한 대응이었다). 그 진단이 틀렸다 — 실제로 포트를 붙든 채
      // 남았던 npm/vite 는 pm2 가 아니라 sh_exec 로 띄운 프로세스였다(당시 봇 자신의 디스코드
      // 메시지에 그렇게 적혀 있었는데 놓쳤다). 이후 실제 PM2 관리 프로세스(vite 손자를 둔
      // npm run dev)로 다시 확인해 보니, 그냥 pm2 delete 만으로 트리 전체가 죽고 포트도 풀렸다 —
      // 윈도우에서 pm2 의 기본 treekill 이 이미 이 일을 한다. 그래서 이 실행기는 pm2 delete 의
      // 결과만 그대로 보고한다(taskkill 을 따로 부르지 않는다).
      const r = await runPm2(["delete", name]);
      return r.ok
        ? { ok: true, content: `멈췄어요: ${name}` }
        : { ok: false, content: `멈추지 못했어요: ${r.stderr.trim() || "그런 프로세스가 없어요"}` };
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
      // recoverCommands 선언부의 "UX 회귀 수정" 참고 — pm2 jlist 가 돌려준 command 는 스크립트
      // 경로일 뿐이므로, 렌더링 직전에 우리가 직접 쓴 스크립트 파일에서 원래 명령을 되찾아
      // 덮어쓴다. 이게 없으면 "뭐 돌고 있어?"에 "C:\...\asahi-proc-scripts\asahi-111.bat" 같은
      // 답을 주게 된다.
      const withCommands = await recoverCommands(procs, scriptDir, shellFlavorOf(roots));
      // labelOf 는 "디스코드 userId → 사람이 알아볼 이름"을 위한 자리지만, 워커는 디스코드를
      // 전혀 모른다(신원 해석은 봇만 할 수 있다 — proc.ts 상단 주석과 동일한 이유). 실제 이름
      // 해석은 이 범위 밖이므로, 최소한 pm2 프로세스 이름(asahi-<id>)으로 되돌려 누구 것인지
      // 알아볼 수 있게 한다 — procNameFor 는 parseProcName 의 역함수라 원래 이름과 정확히 같다.
      return { ok: true, content: truncate(renderProcList(withCommands, { labelOf: (id) => procNameFor(id) })) };
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
