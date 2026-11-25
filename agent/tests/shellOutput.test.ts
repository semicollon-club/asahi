import { describe, it, expect } from "vitest";
import { isUtf8 } from "node:buffer";
import iconv from "iconv-lite";
import {
  lineKindOf,
  decodeShellOutput,
  legacyEncodingOf,
  parseChcpOutput,
  safeCutOf,
  utf8CompleteEndOf,
  makeLineSplitter,
  detectConsoleCodePage,
  LINE_PENDING_MAX,
} from "../src/remote/shellOutput.js";
import { SH_EXEC_RAW_MAX } from "../src/remote/executors.js";

// sh_exec 출력 디코딩(N4, 2026-11-25). 설계: docs/superpowers/specs/2026-11-25-sh-exec-decoding-design.md
// 실제 프로세스로 sh_exec 에 붙인 것은 remoteExecutors.test.ts 가 본다.

// cp949 바이트는 한글로 적고 iconv-lite 로 만든다 — 바이트를 손으로 적으면 무엇을 검증하는지 읽히지 않는다.
const cp949 = (s: string): Buffer => iconv.encode(s, "cp949");
const utf8 = (s: string): Buffer => Buffer.from(s);
const decode949 = (...lines: Buffer[]): string => decodeShellOutput(lines, "cp949");

// 청크를 차례로 밀어 넣고 넘겨받은 줄을 모은다(넘겨받은 조각은 내부 버퍼를 가리킬 수 있어 복사해 둔다).
function splitAll(chunks: Buffer[], maxPending?: number): Buffer[] {
  const lines: Buffer[] = [];
  const s = makeLineSplitter((l) => lines.push(Buffer.from(l)), maxPending);
  for (const c of chunks) s.push(c);
  s.end();
  return lines;
}

describe("셸 출력 디코딩(N4)", () => {
  describe("lineKindOf — 줄 하나의 종류", () => {
    it("UTF-8 로 온전하지 않으면 cp949 가 확실하다 — 윈도우 내장 명령의 오류 문구", () => {
      expect(lineKindOf(cp949("지정된 파일을 찾을 수 없습니다.\r\n"))).toBe("legacy");
    });

    it("3바이트 글자가 있으면 UTF-8 이 확실하다 — 한글·✓", () => {
      expect(lineKindOf(utf8("노드 한글\n"))).toBe("utf8");
      expect(lineKindOf(utf8(" ✓ a.test.ts\n"))).toBe("utf8");
    });

    it("2바이트 글자뿐이면 애매하다 — cp949 `카타`·`책` 도, UTF-8 `×`·`café` 도 이렇게 보인다", () => {
      expect(isUtf8(cp949("카타.txt\r\n"))).toBe(true);
      expect(lineKindOf(cp949("카타.txt\r\n"))).toBe("ambiguous");
      expect(lineKindOf(cp949("책\r\n"))).toBe("ambiguous");
      expect(lineKindOf(utf8(" × b.test.ts\n"))).toBe("ambiguous");
      expect(lineKindOf(utf8("café\n"))).toBe("ambiguous");
    });

    it("ASCII 뿐이면 어느 쪽이든 같다", () => {
      expect(lineKindOf(utf8("Ping 127.0.0.1 TTL=128\r\n"))).toBe("ascii");
    });
  });

  describe("decodeShellOutput — 줄마다 판정, 애매한 줄은 같은 출력을 근거로", () => {
    it("UTF-8 로 온전한 줄은 UTF-8 로 읽는다(node·npm·git 의 출력)", () => {
      expect(decode949(utf8("노드 한글\n"))).toBe("노드 한글\n");
    });

    it("UTF-8 이 아닌 줄은 콘솔 코드페이지로 읽는다 — 윈도우 내장 명령의 오류 문구", () => {
      expect(decode949(cp949("지정된 파일을 찾을 수 없습니다.\r\n"))).toBe("지정된 파일을 찾을 수 없습니다.\r\n");
    });

    it("UHC 확장 글자도 읽는다 — dir 에 나오는 파일 이름(Node 내장 TextDecoder 는 못 읽는다)", () => {
      expect(decode949(cp949("2026-11-25  오후 11:00   1 똠방각하.txt\r\n"))).toBe("2026-11-25  오후 11:00   1 똠방각하.txt\r\n");
    });

    it("한 출력에 섞인 두 인코딩을 줄마다 읽는다(실측: echo … & node …)", () => {
      expect(decode949(cp949("앞줄 cp949\r\n"), utf8("뒷줄 utf8\n"))).toBe("앞줄 cp949\r\n뒷줄 utf8\n");
    });

    it("애매한 줄은 cp949 가 확실한 줄이 있으면 cp949 로 읽는다 — dir /b 의 짧은 이름(앞에 와도)", () => {
      expect(decode949(cp949("카타.txt\r\n"), cp949("책\r\n"), cp949("과제\r\n"))).toBe("카타.txt\r\n책\r\n과제\r\n");
    });

    it("UTF-8 이 확실한 줄도 있으면 애매한 줄은 UTF-8 로 둔다 — vitest 의 ×", () => {
      const out = decode949(cp949("경고: 파일을 찾을 수 없습니다.\r\n"), utf8(" ✓ a.test.ts\n"), utf8(" × b.test.ts\n"));
      expect(out).toContain(" × b.test.ts\n");
      expect(out).toContain("경고: 파일을 찾을 수 없습니다.");
    });

    it("근거가 없으면 애매한 줄은 UTF-8 로 둔다 — 예전과 같은 결과(진짜 UTF-8 인 café 를 깨뜨리지 않는다)", () => {
      expect(decode949(utf8("café\n"))).toBe("café\n");
      expect(decode949(utf8("STATUS·ROADMAP\n"), utf8("ok\n"))).toBe("STATUS·ROADMAP\nok\n");
    });

    it("cp949 로 읽어 깨지는 애매한 줄은 UTF-8 로 둔다", () => {
      // C7 81 은 UTF-8 로 `ǁ` 이고 cp949 에는 없는 바이트열이다.
      expect(decode949(Buffer.from([0xc7, 0x81, 0x0a]), cp949("지정된\r\n"))).toBe("ǁ\n지정된\r\n");
    });

    it("대체가 없으면(null) 예전처럼 UTF-8 로만 읽는다 — 깨진 바이트는 U+FFFD", () => {
      expect(decodeShellOutput([cp949("한글")], null)).toContain("�");
      expect(decodeShellOutput([utf8("한글")], null)).toBe("한글");
    });
  });

  describe("legacyEncodingOf — 코드페이지 번호를 인코딩 이름으로", () => {
    it("949 는 cp949, 932 는 cp932", () => {
      expect(legacyEncodingOf(949)).toBe("cp949");
      expect(legacyEncodingOf(932)).toBe("cp932");
    });

    it("65001 은 UTF-8 이라 대체가 필요 없다", () => {
      expect(legacyEncodingOf(65001)).toBeNull();
    });

    it("모르는 번호·검출 실패는 대체 없음", () => {
      expect(legacyEncodingOf(4242)).toBeNull();
      expect(legacyEncodingOf(null)).toBeNull();
      expect(legacyEncodingOf(undefined)).toBeNull();
    });
  });

  describe("parseChcpOutput — chcp 출력에서 번호만", () => {
    it("문구가 cp949 로 인코딩된 한국어여도 숫자를 꺼낸다(워커는 latin1 로 읽는다)", () => {
      expect(parseChcpOutput(cp949("활성 코드 페이지: 949\r\n").toString("latin1"))).toBe(949);
    });

    it("로캘마다 다른 문구 — 영어, 끝에 마침표가 붙는 독일어", () => {
      expect(parseChcpOutput("Active code page: 65001\r\n")).toBe(65001);
      expect(parseChcpOutput("Aktive Codepage: 850.\r\n")).toBe(850);
    });

    it("숫자가 없으면 null", () => {
      expect(parseChcpOutput("")).toBeNull();
      expect(parseChcpOutput("code page")).toBeNull();
    });
  });

  describe("safeCutOf·utf8CompleteEndOf — 글자를 가르지 않는 자리", () => {
    it("마지막 공백·구두점 바로 뒤", () => {
      expect(safeCutOf(Buffer.from("ab cd"))).toBe(3);
      expect(safeCutOf(Buffer.from("가나 다라"))).toBe(7);
    });

    it("ASCII 영문자는 안전하지 않다 — cp949 의 둘째 바이트가 영문자 범위일 수 있다(똠 = 0x8C 'c')", () => {
      expect(cp949("똠")).toEqual(Buffer.from([0x8c, 0x63]));
      expect(safeCutOf(cp949("똠"))).toBe(0);
    });

    it("끝에 덜 온 UTF-8 글자가 있으면 그 글자 앞, 없으면 끝", () => {
      const ga = Buffer.from("가나"); // 3+3 바이트
      expect(utf8CompleteEndOf(ga)).toBe(6);
      expect(utf8CompleteEndOf(ga.subarray(0, 5))).toBe(3);
      expect(utf8CompleteEndOf(ga.subarray(0, 4))).toBe(3);
      expect(utf8CompleteEndOf(Buffer.from("ab"))).toBe(2);
    });
  });

  describe("makeLineSplitter — 스트림 하나를 줄로", () => {
    it("줄바꿈마다 넘기고, 끝나지 않은 마지막 줄은 end 에서 넘긴다", () => {
      expect(splitAll([Buffer.from("a\nb\nc")]).map(String)).toEqual(["a\n", "b\n", "c"]);
    });

    it("여러 청크에 걸친 줄을 하나로 잇는다", () => {
      expect(splitAll([Buffer.from("ab"), Buffer.from("c\nd")]).map(String)).toEqual(["abc\n", "d"]);
    });

    it("청크 경계가 글자 한가운데여도 다시 붙인다 — UTF-8, 모든 자리에서", () => {
      const line = Buffer.from("한글 줄\n");
      for (let i = 1; i < line.length; i++) {
        expect(splitAll([line.subarray(0, i), line.subarray(i)])).toEqual([line]);
      }
    });

    it("청크 경계가 글자 한가운데여도 다시 붙인다 — cp949, 모든 자리에서", () => {
      const line = cp949("지정된 파일\r\n");
      for (let i = 1; i < line.length; i++) {
        expect(splitAll([line.subarray(0, i), line.subarray(i)])).toEqual([line]);
      }
    });

    it("두 스트림이 한 글자 사이에 끼어들어도 깨지지 않는다(스트림마다 따로 모은다)", () => {
      const got: Buffer[] = [];
      const emit = (l: Buffer) => got.push(Buffer.from(l));
      const stdout = makeLineSplitter(emit);
      const stderr = makeLineSplitter(emit);
      const outLine = Buffer.from("반쪽 글자\n");
      stdout.push(outLine.subarray(0, 1));
      stderr.push(cp949("액세스가 거부되었습니다.\r\n"));
      stdout.push(outLine.subarray(1));
      stdout.end();
      stderr.end();
      expect(decodeShellOutput(got, "cp949")).toBe("액세스가 거부되었습니다.\r\n반쪽 글자\n");
    });

    it("end 를 두 번 불러도 같은 줄을 다시 넘기지 않는다", () => {
      const lines: string[] = [];
      const s = makeLineSplitter((l) => lines.push(String(l)));
      s.push(Buffer.from("끝"));
      s.end();
      s.end();
      expect(lines).toEqual(["끝"]);
    });

    it("끝나지 않은 줄이 상한을 넘으면 글자를 가르지 않는 자리에서 끊는다", () => {
      const lines = splitAll([Buffer.from("가나 다라"), Buffer.from("\n")], 10);
      expect(lines.map(String)).toEqual(["가나 ", "다라\n"]);
      expect(lines.every((l) => isUtf8(l))).toBe(true);
    });

    it("안전한 자리가 없으면 덜 온 UTF-8 글자만 남기고 넘긴다 — 조각이 통째로 cp949 로 읽히지 않게", () => {
      // 2026-11-25 리뷰가 낸 재현: 상한 10, `가나다라마바\n` 을 11+8 바이트로 넣으면 예전에는 첫 조각이 `라` 의 앞 두 바이트를 물고
      // 끊겨 UTF-8 로 온전하지 않았다.
      const line = Buffer.from("가나다라마바\n");
      const lines = splitAll([line.subarray(0, 11), line.subarray(11)], 10);
      expect(lines.map(String)).toEqual(["가나다", "라마바\n"]);
      expect(decodeShellOutput(lines, "cp949")).toBe("가나다라마바\n");
    });

    it("안전한 자리도 덜 온 글자도 없으면 상한에서 통째로 넘긴다 — 메모리 상한이 먼저다", () => {
      expect(splitAll([Buffer.from("가나")], 4).map(String)).toEqual(["가나"]);
    });

    it("기본 상한은 sh_exec 가 모으는 바이트 상한 이상이다 — 그 안의 평범한 긴 줄은 끊지 않는다", () => {
      expect(LINE_PENDING_MAX).toBeGreaterThanOrEqual(SH_EXEC_RAW_MAX);
    });
  });

  describe("detectConsoleCodePage — 워커 기동 때 한 번", () => {
    it("윈도우가 아니면 묻지 않고 null(대체 없음)", async () => {
      expect(await detectConsoleCodePage("linux")).toBeNull();
    });

    it.skipIf(process.platform !== "win32")("윈도우에서는 chcp 로 읽은 번호를 돌려준다", async () => {
      const cp = await detectConsoleCodePage();
      expect(cp).not.toBeNull();
      expect(cp).toBeGreaterThan(0);
    });
  });
});
