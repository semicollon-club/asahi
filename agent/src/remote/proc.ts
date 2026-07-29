// 장기 실행 프로세스(개발서버 등)를 PM2 에 위임하면서 필요한 순수 로직만 모은다.
// 파일시스템도 CLI 도 모른다 — 실제 PM2 호출은 executors.ts 가, 신원 주입은 remoteTools.ts 가 한다.
// 이렇게 떼어 두는 이유는 fs_tree 의 tree.ts 와 같다: 외부 의존 없이 형식만 검증하기 위해서다.

export const PROC_TOOL_NAMES = ["proc_start", "proc_stop", "proc_list", "proc_logs"] as const;

// 프로세스 이름이 곧 소유권이자 "1인 1개" 상한이다 — PM2 안에서 이름이 유일하므로, 같은 사람이
// 두 번째를 띄우려 하면 이름이 충돌한다. 별도 상태 저장이 필요 없다.
const PREFIX = "asahi-";
// 디스코드 스노플레이크는 숫자로만 이루어진다. 이렇게 구분하면 봇 자신의 PM2 앱(asahi-assistant,
// asahi-worker)까지 "누군가의 프로세스"로 오해하지 않는다.
const USER_ID = /^\d+$/;

// procNameFor(짓는 방향)는 입력을 검증하지 않고 그대로 이어붙인다 — 지금까지는 호출측
// (remoteTools.ts)이 이미 검증된 ctx.userId 만 넘긴다는 전제에 기댔다. 이 파일은 fs·CLI 를 모르는
// 순수 로직만 담으므로(파일 상단 주석 참고) 그 전제를 여기서 강제하지는 않지만, parseProcName
// (푸는 방향)이 이미 쓰는 것과 같은 규칙을 호출측이 재사용할 수 있게 내보낸다 — 같은 판정 규칙이
// 두 곳에 따로 있으면 한쪽만 고쳐지는 날이 온다.
export function isValidUserId(id: string): boolean {
  return USER_ID.test(id);
}

export function procNameFor(userId: string): string {
  return `${PREFIX}${userId}`;
}

export function parseProcName(name: string): string | null {
  if (!name.startsWith(PREFIX)) return null;
  const rest = name.slice(PREFIX.length);
  return USER_ID.test(rest) ? rest : null;
}

export type ProcInfo = {
  name: string;
  userId: string | null;
  command: string;
  status: string;
  uptimeMs: number | null;
  memoryBytes: number | null;
  restarts: number;
};

type RawEnv = { status?: unknown; pm_uptime?: unknown; restart_time?: unknown; args?: unknown; pm_exec_path?: unknown };
type RawProc = { name?: unknown; pm2_env?: RawEnv; monit?: { memory?: unknown } };

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

// pm2 가 실행 중인 명령을 하나의 문자열로 복원한다. pm_exec_path 는 절대경로라 그대로 보여주면
// 한 줄을 잡아먹으므로 마지막 조각만 쓴다(사람이 알아보는 데는 그것으로 충분하다).
function commandOf(env: RawEnv | undefined): string {
  const exec = typeof env?.pm_exec_path === "string" ? env.pm_exec_path.split(/[\\/]/).pop() ?? "" : "";
  const args = Array.isArray(env?.args) ? env.args.filter((a): a is string => typeof a === "string") : [];
  return [exec, ...args].filter((s) => s.length > 0).join(" ") || "(알 수 없음)";
}

// pm2 는 경고를 stdout 에 섞어 뱉는 경우가 있다. 파싱 실패로 도구 전체를 죽이지 않고 빈 목록으로
// 떨어뜨린다 — 호출측(executors.ts)이 "지금 도는 것이 없어요"로 안내하는 편이, 사용자에게
// JSON 파싱 오류를 보여주는 것보다 낫다.
export function parsePm2List(json: string): ProcInfo[] {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return [];
  }
  if (!Array.isArray(raw)) return [];
  return raw.map((r) => {
    const p = (r ?? {}) as RawProc;
    const name = typeof p.name === "string" ? p.name : "(이름 없음)";
    const started = num(p.pm2_env?.pm_uptime);
    return {
      name,
      userId: parseProcName(name),
      command: commandOf(p.pm2_env),
      status: typeof p.pm2_env?.status === "string" ? p.pm2_env.status : "unknown",
      // pm_uptime 은 "시작 시각(ms)"이지 경과 시간이 아니다. 경과로 바꾸는 것은 시계를 아는
      // 호출측의 몫이라, 여기서는 시작 시각을 그대로 담고 렌더러가 뺀다.
      uptimeMs: started,
      memoryBytes: num(p.monit?.memory),
      restarts: num(p.pm2_env?.restart_time) ?? 0,
    };
  });
}

function humanUptime(startedAtMs: number | null, now: number): string {
  if (startedAtMs === null) return "-";
  const ms = Math.max(0, now - startedAtMs);
  const min = Math.floor(ms / 60_000);
  const h = Math.floor(min / 60);
  return h > 0 ? `${h}시간 ${min % 60}분` : `${min}분`;
}

function humanMem(bytes: number | null): string {
  return bytes === null ? "-" : `${Math.round(bytes / (1024 * 1024))}MB`;
}

// labelOf: 디스코드 userId → 사람이 알아볼 이름. 봇 쪽에서만 알 수 있으므로 주입받는다.
// now: 업타임 계산 기준. 테스트가 고정할 수 있게 인자로 둔다.
export function renderProcList(
  procs: ProcInfo[],
  o: { labelOf: (userId: string) => string; now?: number },
): string {
  if (procs.length === 0) return "지금 도는 것이 없어요.";
  const now = o.now ?? Date.now();
  const lines = procs.map((p) => {
    const who = p.userId === null ? p.name : o.labelOf(p.userId);
    return `${who}  ${p.command}  ${p.status}  ${humanUptime(p.uptimeMs, now)}  ${humanMem(p.memoryBytes)}  재시작 ${p.restarts}`;
  });
  return [`지금 도는 것 (${procs.length}개)`, "", ...lines].join("\n");
}
