import { describe, it, expect } from "vitest";
import { PROC_TOOL_NAMES, procNameFor, parseProcName, parsePm2List, renderProcList, type ProcInfo } from "../src/remote/proc.js";

const jlist = (rows: unknown[]) => JSON.stringify(rows);
const row = (name: string, over: Record<string, unknown> = {}) => ({
  name,
  pid: 1234,
  pm2_env: { status: "online", pm_uptime: 1_000_000, restart_time: 0, args: ["run", "dev"], pm_exec_path: "C:\\Program Files\\nodejs\\npm.cmd", ...(over.pm2_env as object ?? {}) },
  monit: { memory: 184 * 1024 * 1024, cpu: 0, ...(over.monit as object ?? {}) },
});

describe("proc — 이름 규칙", () => {
  it("도구 이름 넷을 고정으로 노출한다", () => {
    expect([...PROC_TOOL_NAMES].sort()).toEqual(["proc_list", "proc_logs", "proc_start", "proc_stop"]);
  });

  it("사용자 id 로 프로세스 이름을 만든다", () => {
    expect(procNameFor("1517428698368704650")).toBe("asahi-1517428698368704650");
  });

  it("프로세스 이름에서 사용자 id 를 되찾는다", () => {
    expect(parseProcName("asahi-1517428698368704650")).toBe("1517428698368704650");
  });

  it("우리 규칙이 아닌 이름은 null 이다(봇·워커 자신의 프로세스를 사람 것으로 오해하지 않는다)", () => {
    expect(parseProcName("asahi-assistant")).toBeNull();
    expect(parseProcName("asahi-worker")).toBeNull();
    expect(parseProcName("something-else")).toBeNull();
  });
});

describe("proc — pm2 jlist 파싱", () => {
  it("필요한 필드만 뽑아 온다", () => {
    const [p] = parsePm2List(jlist([row("asahi-111")]));
    expect(p).toMatchObject({ name: "asahi-111", userId: "111", status: "online", restarts: 0 });
    expect(p!.memoryBytes).toBe(184 * 1024 * 1024);
    expect(p!.command).toContain("run dev");
  });

  it("우리 것이 아닌 프로세스도 목록에 담되 userId 는 null 이다", () => {
    const [p] = parsePm2List(jlist([row("asahi-worker")]));
    expect(p!.userId).toBeNull();
  });

  it("빈 목록을 견딘다", () => {
    expect(parsePm2List("[]")).toEqual([]);
  });

  it("깨진 JSON 이면 던지지 않고 빈 목록을 돌려준다(pm2 가 경고를 섞어 뱉는 경우가 있다)", () => {
    expect(parsePm2List("not json")).toEqual([]);
  });

  // 리뷰 지적(Important, 병합 차단 항목과 같은 자리에서 발견된 이어받은 구멍): 최상위 값이 유효한
  // JSON 이어도 배열이 아니면(예: 객체 하나) raw.map 이 없는 메서드를 부르며 그대로 죽는다 — 아래
  // Array.isArray 가드가 이미 막고 있지만, 이 모양(예: pm2 가 에러를 { message: ... } 객체로
  // 뱉는 경우)을 겨냥한 테스트가 없었다.
  it("최상위가 배열이 아니면(JSON 객체 등) 빈 목록을 돌려준다", () => {
    expect(parsePm2List("{}")).toEqual([]);
    expect(parsePm2List('{"message":"pm2 daemon not running"}')).toEqual([]);
  });

  it("필드가 없어도 죽지 않는다", () => {
    const [p] = parsePm2List(jlist([{ name: "asahi-9" }]));
    expect(p).toMatchObject({ name: "asahi-9", status: "unknown", restarts: 0 });
    expect(p!.memoryBytes).toBeNull();
    expect(p!.startedAtMs).toBeNull();
  });

  // 리뷰 지적(Minor): executors.ts 의 proc_start 는 pm2 의 "스크립트" 자리에 셸(cmd.exe/sh)을
  // 넣고 실제 명령은 "-- <flag> <command>" 로 넘긴다 — pm2 는 그 셸을 pm_exec_path 로, [flag,
  // command] 를 args 로 그대로 돌려주므로, 위 row() 의 기본 픽스처(pm_exec_path: npm.cmd,
  // args: ["run","dev"])는 이 브랜치의 proc_start 가 절대 만들 수 없는 모양이다 — 그래서 이
  // 구멍이 스위트 전체로도 드러나지 않았다. proc_start 가 실제로 만드는 모양을 그대로 재현해
  // commandOf 가 셸 이름·플래그를 걷어내고 진짜 명령만 보여주는지 확인한다.
  it("proc_start 가 실제로 만드는 모양(윈도우 셸 래퍼)은 cmd.exe·/c 를 걷어내고 명령만 보여준다", () => {
    const [p] = parsePm2List(jlist([row("asahi-111", { pm2_env: { pm_exec_path: "C:\\Windows\\System32\\cmd.exe", args: ["/c", "npm run dev"] } })]));
    expect(p!.command).toBe("npm run dev");
  });

  it("proc_start 가 실제로 만드는 모양(POSIX 셸 래퍼)은 sh·-c 를 걷어내고 명령만 보여준다", () => {
    const [p] = parsePm2List(jlist([row("asahi-111", { pm2_env: { pm_exec_path: "/bin/sh", args: ["-c", "npm run dev"] } })]));
    expect(p!.command).toBe("npm run dev");
  });
});

describe("proc — 표 렌더링", () => {
  const labelOf = (userId: string) => (userId === "111" ? "우성현" : userId);
  // startedAtMs 는 "경과 시간"이 아니라 pm2 의 pm_uptime, 즉 **시작 시각(ms)** 이다.
  // 경과로 바꾸는 것은 렌더러가 now 를 받아서 한다 — 그래서 아래는 시작 0, now 를 2시간 12분으로 둔다.
  const NOW = 2 * 3600_000 + 12 * 60_000;
  const one: ProcInfo = { name: "asahi-111", userId: "111", command: "npm run dev", status: "online", startedAtMs: 0, memoryBytes: 184 * 1024 * 1024, restarts: 0 };

  it("사람 이름·명령·상태·업타임·메모리·재시작 횟수를 담는다", () => {
    const out = renderProcList([one], { labelOf, now: NOW });
    expect(out).toContain("우성현");
    expect(out).toContain("npm run dev");
    expect(out).toContain("online");
    expect(out).toContain("2시간 12분");
    expect(out).toContain("184MB");
    expect(out).toContain("재시작 0");
  });

  it("한 시간이 안 되면 분만 보여준다", () => {
    expect(renderProcList([one], { labelOf, now: 7 * 60_000 })).toContain("7분");
  });

  it("시작 시각을 모르면 업타임 자리를 비운다(0분이라고 거짓말하지 않는다)", () => {
    const out = renderProcList([{ ...one, startedAtMs: null }], { labelOf, now: NOW });
    expect(out).not.toContain("분");
  });

  it("비어 있으면 비었다고 말한다(빈 문자열을 돌려주지 않는다)", () => {
    expect(renderProcList([], { labelOf })).toContain("도는 것이 없");
  });

  it("개수를 머리글에 넣는다", () => {
    const out = renderProcList([one, { ...one, name: "asahi-222", userId: "222" }], { labelOf, now: NOW });
    expect(out).toContain("2개");
  });

  // 리뷰 지적(Important, 병합 차단): userId 가 null(봇·워커 자신, 예: asahi-worker)이면 who 가
  // p.name 그대로 떨어지고, 회원은 labelOf(userId) — 실행기가 실제로 주입하는 labelOf 는
  // procNameFor 라 회원 행도 결국 "asahi-<id>" 모양이다. 그러면 두 종류의 행이 형식상 구분되지
  // 않아, "돌고 있는 거 다 정리해줘" 같은 지시를 받은 모델이 인프라 행을 회원 행과 똑같이 취급할
  // 수 있다 — parseProcName 이 이미 이 둘을 구분하므로(파일 상단 주석·테스트) 그 정보를 표시에도
  // 반영해, 인프라 행에만 눈에 띄는 표식을 붙인다.
  it("userId 가 없는 행(봇·워커 자신)에는 회원 행에 없는 구분 표식이 붙는다", () => {
    const infra: ProcInfo = { name: "asahi-worker", userId: null, command: "node dist/worker.js", status: "online", startedAtMs: 0, memoryBytes: 60 * 1024 * 1024, restarts: 0 };
    const out = renderProcList([one, infra], { labelOf, now: NOW });
    const lines = out.split("\n");
    const memberLine = lines.find((l) => l.includes("asahi-111") || l.startsWith("우성현"))!;
    const infraLine = lines.find((l) => l.includes("asahi-worker"))!;
    expect(infraLine).toContain("인프라");
    expect(memberLine).not.toContain("인프라");
    expect(infraLine).toContain("asahi-worker"); // 원래 pm2 이름은 그대로 남는다(무엇인지는 여전히 알아볼 수 있어야 한다)
  });
});
