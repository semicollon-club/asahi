import type { Db } from "./db.js";

export type Role = "owner" | "allowed" | "blocked";

export class UsersRepo {
  private now: () => number;
  constructor(private db: Db, now: () => number = Date.now) { this.now = now; }

  async upsert(id: string, patch: { role?: Role; displayName?: string }): Promise<void> {
    const t = this.now();
    await this.db.query(
      `INSERT INTO users (id, role, display_name, created_ts, updated_ts)
       VALUES ($1, COALESCE($2,'blocked'), $3, $4, $4)
       ON CONFLICT (id) DO UPDATE SET
         role = COALESCE($2, users.role),
         display_name = COALESCE($3, users.display_name),
         updated_ts = $4`,
      [id, patch.role ?? null, patch.displayName ?? null, t],
    );
  }

  async getRole(id: string): Promise<Role> {
    const r = await this.db.query("SELECT role FROM users WHERE id = $1", [id]);
    const row = r.rows[0] as { role: Role } | undefined;
    return row?.role ?? "blocked";
  }

  async list(role?: Role): Promise<Array<{ id: string; role: Role; displayName: string | null }>> {
    const r = role
      ? await this.db.query("SELECT id, role, display_name FROM users WHERE role = $1 ORDER BY id", [role])
      : await this.db.query("SELECT id, role, display_name FROM users ORDER BY id");
    const rows = r.rows as Array<{ id: string; role: Role; display_name: string | null }>;
    return rows.map((row) => ({ id: row.id, role: row.role, displayName: row.display_name }));
  }

  // proc_list 가 사람 이름을 보여주기 위해 "userId → 표시 이름"을 한 번에 읽는다(remoteTools.ts).
  // 이름이 아직 없는 사용자는 키에 넣지 않는다 — 호출자가 "키가 없으면 procNameFor 로 폴백"
  // 으로 다루므로, null 이나 빈 문자열을 실어 보내면 그 판단이 흐려진다.
  async displayNames(): Promise<Record<string, string>> {
    const r = await this.db.query(
      "SELECT id, display_name FROM users WHERE display_name IS NOT NULL AND display_name <> ''",
    );
    const rows = r.rows as Array<{ id: string; display_name: string }>;
    return Object.fromEntries(rows.map((row) => [row.id, row.display_name]));
  }
}
