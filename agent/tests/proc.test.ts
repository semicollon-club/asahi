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

  it("필드가 없어도 죽지 않는다", () => {
    const [p] = parsePm2List(jlist([{ name: "asahi-9" }]));
    expect(p).toMatchObject({ name: "asahi-9", status: "unknown", restarts: 0 });
    expect(p!.memoryBytes).toBeNull();
    expect(p!.uptimeMs).toBeNull();
  });
});

describe("proc — 표 렌더링", () => {
  const labelOf = (userId: string) => (userId === "111" ? "우성현" : userId);
  // uptimeMs 는 "경과 시간"이 아니라 pm2 의 pm_uptime, 즉 **시작 시각(ms)** 이다.
  // 경과로 바꾸는 것은 렌더러가 now 를 받아서 한다 — 그래서 아래는 시작 0, now 를 2시간 12분으로 둔다.
  const NOW = 2 * 3600_000 + 12 * 60_000;
  const one: ProcInfo = { name: "asahi-111", userId: "111", command: "npm run dev", status: "online", uptimeMs: 0, memoryBytes: 184 * 1024 * 1024, restarts: 0 };

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
    const out = renderProcList([{ ...one, uptimeMs: null }], { labelOf, now: NOW });
    expect(out).not.toContain("분");
  });

  it("비어 있으면 비었다고 말한다(빈 문자열을 돌려주지 않는다)", () => {
    expect(renderProcList([], { labelOf })).toContain("도는 것이 없");
  });

  it("개수를 머리글에 넣는다", () => {
    const out = renderProcList([one, { ...one, name: "asahi-222", userId: "222" }], { labelOf, now: NOW });
    expect(out).toContain("2개");
  });
});
