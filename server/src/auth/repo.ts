import type { Db } from "../db.js";

// 스키마는 항상 web. 접두사로 명시한다 (search_path 에 의존하지 않는다).

export interface UserRow {
  id: string;
  username: string;
  display_name: string;
  password_hash: string;
}

export async function insertUser(
  db: Db,
  user: { id: string; username: string; displayName: string; passwordHash: string },
): Promise<void> {
  await db.query(
    "insert into web.users (id, username, display_name, password_hash) values ($1, $2, $3, $4)",
    [user.id, user.username, user.displayName, user.passwordHash],
  );
}

export async function findUserByUsername(db: Db, username: string): Promise<UserRow | null> {
  const res = await db.query(
    "select id, username, display_name, password_hash from web.users where username = $1",
    [username],
  );
  return (res.rows[0] as UserRow | undefined) ?? null;
}

export async function insertSession(
  db: Db,
  session: { tokenHash: string; userId: string; expiresAt: Date },
): Promise<void> {
  await db.query(
    "insert into web.sessions (token_hash, user_id, expires_at) values ($1, $2, $3)",
    [session.tokenHash, session.userId, session.expiresAt],
  );
}

/** 유효한(만료 전) 세션의 사용자 정보를 찾는다. */
export async function findSessionUser(
  db: Db,
  tokenHash: string,
): Promise<{ id: string; username: string; display_name: string } | null> {
  const res = await db.query(
    `select u.id, u.username, u.display_name
       from web.sessions s
       join web.users u on u.id = s.user_id
      where s.token_hash = $1 and s.expires_at > now()`,
    [tokenHash],
  );
  return (res.rows[0] as { id: string; username: string; display_name: string } | undefined) ?? null;
}

export async function deleteSession(db: Db, tokenHash: string): Promise<void> {
  await db.query("delete from web.sessions where token_hash = $1", [tokenHash]);
}
