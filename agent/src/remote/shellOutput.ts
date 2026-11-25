import { spawn, type ChildProcess } from "node:child_process";
import { isUtf8 } from "node:buffer";
import iconv from "iconv-lite";

// sh_exec 출력 디코딩(N4, 2026-11-25). 설계: docs/superpowers/specs/2026-11-25-sh-exec-decoding-design.md
//
// 워커는 자식 프로세스의 출력을 청크가 올 때마다 UTF-8 로 읽었다. 윈도우 내장 명령·PowerShell 5.1·Python 은 파이프로 낼 때
// 콘솔 코드페이지(미니PC 949)를 쓰므로 한국어가 통째로 깨졌고(30일 실측 16%), UTF-8 로 내는 프로그램도 한 글자가 두 청크에
// 걸치면 깨졌다. 한 명령의 출력도 줄마다 인코딩이 다를 수 있어(실측: `echo 한글 & node -e ...` 는 앞줄 cp949, 뒷줄 UTF-8)
// 출력 전체가 아니라 줄마다 판정한다. 명령을 UTF-8 출력으로 강제하는 길(`chcp 65001`)은 같은 명령줄의 echo 에도 듣지 않았다.

type IconvEncoding = Parameters<typeof iconv.decode>[1];

// 줄 하나의 종류.
// - "legacy": UTF-8 로 온전하지 않다 — 콘솔 코드페이지(cp949)가 확실하다.
// - "utf8": UTF-8 로 온전하고 3·4바이트 글자(한글·대부분의 기호·이모지)가 있다 — cp949 바이트로는 사실상 나오지 않는다.
// - "ambiguous": UTF-8 로 온전하지만 여러 바이트 글자가 전부 2바이트다. cp949 한글 일부(첫 바이트 0xC2–0xC8·둘째 0xA1–0xBF 인
//   217자 등)로만 된 줄이 이렇게 보인다 — 실측: cp949 `카타.txt` 는 UTF-8 로 `īŸ.txt`, `책` 은 `å` 로 온전하다. 반대로 진짜
//   UTF-8 인 `×`(vitest 의 실패 표시)·`café`·`STATUS·ROADMAP` 을 cp949 로 읽으면 `횞`·`caf챕`·`STATUS쨌ROADMAP` 이 된다.
// - "ascii": 0x80 이상 바이트가 없다 — 어느 쪽으로 읽어도 같다.
export type LineKind = "legacy" | "utf8" | "ambiguous" | "ascii";

export function lineKindOf(line: Buffer): LineKind {
  if (!isUtf8(line)) return "legacy";
  let multibyte = false;
  for (const b of line) {
    // 온전한 UTF-8 이므로 0xE0 이상은 3·4바이트 글자의 첫 바이트, 0xC2–0xDF 는 2바이트 글자의 첫 바이트다.
    if (b >= 0xe0) return "utf8";
    if (b >= 0xc0) multibyte = true;
  }
  return multibyte ? "ambiguous" : "ascii";
}

// sh_exec 한 번의 출력 줄들을 문자열로 바꾼다. legacy 는 UTF-8 이 아닌 줄을 읽을 인코딩이다(콘솔 코드페이지 — legacyEncodingOf).
// null 이면 대체 없이 UTF-8 로만 읽는다(예전 동작 — 깨진 바이트는 U+FFFD 가 된다).
//
// UTF-8 을 먼저 본다(lineKindOf) — node·npm·git 처럼 UTF-8 로 내는 프로그램의 줄을 cp949 로 읽으면 엉뚱한 글자가 된다. 애매한
// 줄은 같은 출력의 다른 줄을 근거로 정한다: cp949 가 확실한 줄이 있고 UTF-8 이 확실한 줄이 없으면 cp949 로 읽는다(그렇게 읽어
// 깨지면 UTF-8 로 둔다). `dir /b` 의 짧은 한글 이름이 다른 이름·오류 문구를 근거로 바로잡힌다. 근거가 없거나 양쪽 근거가 다
// 있으면 UTF-8 로 둔다 — 예전과 같은 결과라 새로 깨뜨리는 줄이 없다(애매한 줄만 있는 출력은 여전히 틀린다, 설계 §4). 다른 줄을
// 봐야 하므로 줄이 올 때마다가 아니라 출력이 다 모인 뒤에 디코드한다.
export function decodeShellOutput(lines: readonly Buffer[], legacy: IconvEncoding | null): string {
  if (legacy === null) return lines.map((l) => l.toString("utf8")).join("");
  const kinds = lines.map(lineKindOf);
  const preferLegacy = kinds.includes("legacy") && !kinds.includes("utf8");
  return lines
    .map((line, i) => {
      const kind = kinds[i];
      if (kind === "legacy") return iconv.decode(line, legacy);
      if (kind === "ambiguous" && preferLegacy) {
        const asLegacy = iconv.decode(line, legacy);
        if (!asLegacy.includes("�")) return asLegacy;
      }
      return line.toString("utf8");
    })
    .join("");
}

// 콘솔 코드페이지 번호 → iconv-lite 인코딩 이름. 65001 은 UTF-8 이라 대체가 필요 없고, iconv-lite 가 모르는 번호·검출 실패도
// null(대체 없음)이다. Node 내장 TextDecoder("euc-kr") 를 쓰지 않는 이유: KS X 1001 만 읽어 UHC 확장 글자(예: `똠`)가 깨진다.
export function legacyEncodingOf(codePage: number | null | undefined): IconvEncoding | null {
  if (codePage === null || codePage === undefined || codePage === 65001) return null;
  const name = `cp${codePage}`;
  return iconv.encodingExists(name) ? name : null;
}

// `chcp` 출력에서 코드페이지 번호를 꺼낸다. 문구는 로캘마다 다르고("활성 코드 페이지: 949", "Active code page: 65001",
// "Aktive Codepage: 850.") 그 문구 자체가 그 코드페이지로 인코딩돼 있으므로, 숫자만 본다 — 마지막 숫자 묶음이 번호다.
export function parseChcpOutput(out: string): number | null {
  const nums = out.match(/\d+/g);
  if (nums === null) return null;
  const n = Number(nums[nums.length - 1]);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

// 끝나지 않은 줄을 스트림마다 이만큼(바이트)까지만 쌓는다. 줄바꿈 없는 거대한 출력(압축된 JS 를 type 하는 경우)이 메모리를
// 잡아먹지 않게 하는 상한이고, sh_exec 가 모으는 바이트 상한(executors.ts 의 SH_EXEC_RAW_MAX)과 같거나 커야 평범한 긴 줄을
// 끊지 않는다.
export const LINE_PENDING_MAX = 120_000;

// 글자를 가르지 않고 끊을 수 있는 마지막 위치(그 바이트 바로 뒤). 0x00–0x40(제어 문자·공백·숫자·대부분의 구두점)은 UTF-8 의
// 여러 바이트 글자(모든 바이트가 0x80 이상)에도, cp949 의 두 바이트 글자(첫 바이트 0x81 이상, 둘째 0x41 이상)에도 나오지
// 않는다. 그런 바이트가 없으면 0.
export function safeCutOf(buf: Buffer): number {
  for (let i = buf.length - 1; i >= 0; i--) if (buf[i] <= 0x40) return i + 1;
  return 0;
}

// buf 끝에 덜 온 UTF-8 글자가 걸려 있으면 그 글자의 시작 위치, 아니면 buf.length. 안전한 자리가 없어 강제로 끊을 때 UTF-8 글자를
// 가르지 않게 한다 — 갈린 조각은 UTF-8 로 온전하지 않아 조각 전체(최대 LINE_PENDING_MAX)가 cp949 로 읽힌다(2026-11-25 리뷰).
export function utf8CompleteEndOf(buf: Buffer): number {
  for (let i = buf.length - 1; i >= 0 && i >= buf.length - 4; i--) {
    const b = buf[i];
    if (b < 0x80) return buf.length; // ASCII 바로 뒤 — 글자 경계다
    if (b >= 0xc0) {
      // 글자의 첫 바이트다. 뒤따를 바이트가 다 왔으면 끝까지, 덜 왔으면 이 글자 앞에서 끊는다.
      const need = b >= 0xf0 ? 4 : b >= 0xe0 ? 3 : 2;
      return buf.length - i >= need ? buf.length : i;
    }
    // 0x80–0xBF: 이어지는 바이트 — 더 앞을 본다
  }
  return buf.length;
}

export type LineSplitter = { push(chunk: Buffer): void; end(): void };

// 한 스트림(stdout 또는 stderr)의 바이트를 줄로 끊어 emit 에 넘긴다(줄바꿈 바이트 포함). 스트림마다 하나씩 만든다 — 두
// 스트림을 한 버퍼에 섞으면 한 글자 사이에 다른 스트림의 청크가 끼어들 때 그 글자가 갈린다. 0x0A 는 UTF-8·cp949 어느 쪽에서도
// 여러 바이트 글자 안에 나오지 않으므로 줄바꿈에서 끊으면 글자가 갈리지 않는다. end() 는 끝나지 않은 마지막 줄을 넘기며, 두 번
// 불러도 안전하다.
export function makeLineSplitter(emit: (line: Buffer) => void, maxPending: number = LINE_PENDING_MAX): LineSplitter {
  let parts: Buffer[] = [];
  let size = 0;
  // 쌓인 바이트의 앞 n 개를 넘기고 나머지를 남긴다.
  const take = (n: number) => {
    const all = parts.length === 1 ? parts[0] : Buffer.concat(parts, size);
    emit(all.subarray(0, n));
    const rest = all.subarray(n);
    parts = rest.length > 0 ? [rest] : [];
    size = rest.length;
  };
  return {
    push(chunk) {
      let start = 0;
      for (let nl = chunk.indexOf(0x0a); nl !== -1; nl = chunk.indexOf(0x0a, start)) {
        parts.push(chunk.subarray(start, nl + 1));
        size += nl + 1 - start;
        take(size);
        start = nl + 1;
      }
      if (start < chunk.length) {
        parts.push(chunk.subarray(start));
        size += chunk.length - start;
      }
      if (size > maxPending) {
        // 안전한 자리 뒤에서 끊는다. 그런 자리가 없거나 끊고 남는 쪽이 여전히 상한을 넘으면 덜 온 UTF-8 글자만 남기고 넘긴다 —
        // 메모리 상한이 먼저다. 그때 갈릴 수 있는 것은 cp949 글자 하나다(설계 §4).
        const all = parts.length === 1 ? parts[0] : Buffer.concat(parts, size);
        parts = [all];
        const safe = safeCutOf(all);
        const cut = safe > 0 && size - safe <= maxPending ? safe : utf8CompleteEndOf(all);
        take(cut > 0 ? cut : size);
      }
    },
    end() {
      if (size > 0) take(size);
    },
  };
}

const CHCP_TIMEOUT_MS = 5_000;

// 워커가 띄우는 셸의 콘솔 코드페이지를 묻는다(윈도우만, 기동 때 한 번 — worker.ts). sh_exec 와 똑같이(shell:true, 창 옵션
// 없이) 띄워야 그 자식들이 받을 콘솔과 같은 답이 나온다 — windowsHide 를 주면 새 콘솔을 받아, 워커가 콘솔에 붙어 있을 때 그
// 콘솔의 코드페이지와 달라질 수 있다. 실패·시간 초과는 null(대체 없이 UTF-8 로만 읽는다 — 예전 동작).
export function detectConsoleCodePage(platform: NodeJS.Platform = process.platform): Promise<number | null> {
  if (platform !== "win32") return Promise.resolve(null);
  return new Promise((resolve) => {
    let out = "";
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (v: number | null) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(v);
    };
    let child: ChildProcess;
    try {
      child = spawn("chcp", { shell: true });
    } catch {
      finish(null);
      return;
    }
    timer = setTimeout(() => {
      child.kill();
      finish(null);
    }, CHCP_TIMEOUT_MS);
    // 숫자만 보므로 latin1 로 읽는다 — 어떤 바이트든 한 글자로 대응해 숫자(ASCII)가 그대로 남는다.
    child.stdout?.on("data", (c: Buffer) => { out += c.toString("latin1"); });
    child.on("error", () => finish(null));
    child.on("close", (code) => finish(code === 0 ? parseChcpOutput(out) : null));
  });
}
