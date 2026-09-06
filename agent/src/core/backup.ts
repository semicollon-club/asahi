import path from "node:path";
import type { Memory } from "../store/memoriesRepo.js";
import type { BackupsRepo } from "../store/backupsRepo.js";

// 기억 백업(부원 오픈 게이트 2D). 공용 기억은 부원이 쌓는 유일한 복구 불가 데이터인데, 지금까지 앱 차원의
// 내보내기 경로가 없었다 — `backups` 테이블은 DDL 만 있었다. 여기서 정기적으로 기억 전체를 JSON 파일로
// 내보내고 그 사실을 표에 남긴다. 되돌리기는 `src/scripts/restoreMemories.ts`.
//
// 판정·조립·정리는 전부 순수 함수로 두고(테스트가 파일시스템 없이 고정한다), 실제 파일 쓰기만 주입한 fs 로 한다.

export const BACKUP_VERSION = 1;
export const DEFAULT_BACKUP_KEEP = 14;
export const DEFAULT_BACKUP_INTERVAL_MS = 24 * 60 * 60 * 1000;
const FILE_PREFIX = "memories-";
const FILE_SUFFIX = ".json";

export type MemoryBackup = { version: number; createdTs: number; count: number; memories: Memory[] };

// 이미 오늘 것을 만들었는가. 마지막 성공이 없으면(첫 기동) 곧바로 한 번 만든다 — 백업이 하나도 없는 상태가
// 이 게이트가 걱정하는 바로 그 상태이므로, 첫날을 기다릴 이유가 없다.
export function decideBackupDue(lastSuccessTs: number | null, now: number, intervalMs: number): boolean {
  if (lastSuccessTs === null) return true;
  return now - lastSuccessTs >= intervalMs;
}

// 파일 이름은 시각순으로 정렬되는 모양이다 — 문자열 정렬이 곧 시간 정렬이라 정리(prune)가 단순해진다.
export function backupFileName(now: number): string {
  const iso = new Date(now).toISOString().replace(/[:.]/g, "-");
  return `${FILE_PREFIX}${iso}${FILE_SUFFIX}`;
}

export function isBackupFile(name: string): boolean {
  return name.startsWith(FILE_PREFIX) && name.endsWith(FILE_SUFFIX);
}

// 저장할 내용. scope='character' 는 memoriesRepo.all() 이 이미 뺀다(옛 캐릭터 시절 픽션).
export function buildMemoryBackup(memories: Memory[], now: number): MemoryBackup {
  return { version: BACKUP_VERSION, createdTs: now, count: memories.length, memories };
}

// 남길 개수를 넘긴 오래된 파일들(지울 대상). 이름이 시각순이라 정렬 후 앞쪽이 오래된 것이다.
export function pruneList(files: string[], keep: number): string[] {
  const backups = files.filter(isBackupFile).sort();
  return keep <= 0 ? backups : backups.slice(0, Math.max(0, backups.length - keep));
}

export type BackupFs = {
  mkdir(dir: string): Promise<void>;
  writeFile(file: string, data: string): Promise<void>;
  readdir(dir: string): Promise<string[]>;
  unlink(file: string): Promise<void>;
};

export type BackupRunner = { runIfDue(): Promise<void> };

// 정기 실행기. index.ts 의 타이머가 부른다 — 주기가 안 됐으면 아무것도 안 한다. 실패해도 던지지 않는다:
// 백업은 부가 기능이고, 그것이 봇의 턴 처리를 죽이면 안 된다(정기 게시·PR 추적과 같은 원칙). 실패도 표에
// 남겨(status='error') 조용히 사라지지 않게 한다.
export function makeBackupRunner(o: {
  memories: { all(): Promise<Memory[]> };
  backups: BackupsRepo;
  dir: string;
  fs: BackupFs;
  keep?: number;
  intervalMs?: number;
  now?: () => number;
}): BackupRunner {
  const keep = o.keep ?? DEFAULT_BACKUP_KEEP;
  const intervalMs = o.intervalMs ?? DEFAULT_BACKUP_INTERVAL_MS;
  const now = o.now ?? Date.now;

  return {
    async runIfDue() {
      const at = now();
      let file = "";
      try {
        const last = await o.backups.lastSuccessTs("memories");
        if (!decideBackupDue(last, at, intervalMs)) return;

        const rows = await o.memories.all();
        const body = `${JSON.stringify(buildMemoryBackup(rows, at), null, 2)}\n`;
        file = path.join(o.dir, backupFileName(at));
        await o.fs.mkdir(o.dir);
        await o.fs.writeFile(file, body);
        await o.backups.record({ ts: at, path: file, sizeBytes: Buffer.byteLength(body, "utf8"), kind: "memories", status: "ok" });
        console.log(`[backup] 기억 ${rows.length}건을 ${file} 로 내보냈어요.`);

        // 정리는 백업이 성공한 뒤에만 한다 — 새 백업을 못 만든 날에 옛 것을 지우면 가진 것만 줄어든다.
        const names = await o.fs.readdir(o.dir);
        for (const name of pruneList(names, keep)) {
          await o.fs.unlink(path.join(o.dir, name)).catch(() => {});
        }
      } catch (err) {
        const note = err instanceof Error ? err.message : String(err);
        console.error("[backup] 백업 실패:", note);
        // 실패 기록 자체가 또 실패할 수 있다(DB 장애) — 그건 삼킨다. 로그는 이미 남겼다.
        await o.backups.record({ ts: at, path: file, sizeBytes: 0, kind: "memories", status: "error", note }).catch(() => {});
      }
    },
  };
}
