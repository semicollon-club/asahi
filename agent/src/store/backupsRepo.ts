import type { Db } from "./db.js";

// 백업 기록(부원 오픈 게이트 2D). `backups` 테이블은 오래전부터 DDL 만 있고 읽고 쓰는 코드가 없었다 —
// 공용 기억은 부원이 쌓는 유일한 복구 불가 데이터인데 앱 차원의 내보내기 경로가 0이었다(ROADMAP 게이트).
// 여기는 "언제 무엇을 어디에 얼마나 썼는가"만 남긴다. 실제 바이트는 파일로 나가고(core/backup.ts),
// 이 표는 그 파일의 목록·상태다 — 마지막 성공 시각으로 "오늘 것을 이미 만들었는가"를 판정한다.

export type BackupKind = "memories";
export type BackupStatus = "ok" | "error";

export type BackupRow = {
  id: number;
  ts: number;
  path: string;
  sizeBytes: number;
  kind: string;
  status: string;
  note: string | null;
};

type Raw = { id: number | string; ts: number | string; path: string; size_bytes: number | string; kind: string; status: string; note: string | null };

const toRow = (r: Raw): BackupRow => ({
  id: Number(r.id), ts: Number(r.ts), path: r.path, sizeBytes: Number(r.size_bytes),
  kind: r.kind, status: r.status, note: r.note ?? null,
});

export class BackupsRepo {
  constructor(private db: Db) {}

  async record(o: { ts: number; path: string; sizeBytes: number; kind: BackupKind; status: BackupStatus; note?: string }): Promise<void> {
    await this.db.query(
      "INSERT INTO backups (ts, path, size_bytes, kind, status, note) VALUES ($1, $2, $3, $4, $5, $6)",
      [o.ts, o.path, o.sizeBytes, o.kind, o.status, o.note ?? null],
    );
  }

  // 마지막으로 성공한 백업 시각. 없으면 null — 그러면 곧바로 한 번 만든다(첫 기동).
  async lastSuccessTs(kind: BackupKind): Promise<number | null> {
    const r = await this.db.query(
      "SELECT ts FROM backups WHERE kind = $1 AND status = 'ok' ORDER BY ts DESC LIMIT 1",
      [kind],
    );
    const row = r.rows[0] as { ts: number | string } | undefined;
    return row === undefined ? null : Number(row.ts);
  }

  // 소유자가 db_query 없이도 볼 수 있게(그리고 테스트가 확인할 수 있게) 최근 목록을 준다.
  async recent(limit = 20): Promise<BackupRow[]> {
    const r = await this.db.query("SELECT id, ts, path, size_bytes, kind, status, note FROM backups ORDER BY ts DESC LIMIT $1", [limit]);
    return (r.rows as Raw[]).map(toRow);
  }
}
