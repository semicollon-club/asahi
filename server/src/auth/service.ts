import { createHash, randomBytes, randomUUID } from "node:crypto";
import bcrypt from "bcryptjs";
import type { Db } from "../db.js";
import {
  deleteSession,
  findSessionUser,
  findUserByUsername,
  insertSession,
  insertUser,
} from "./repo.js";

// 학습 노트(세션 vs JWT): 여기서는 DB 세션 방식을 쓴다.
// - 세션: 상태를 DB에 두고 쿠키에는 무의미한 토큰만 싣는다 → 서버에서 즉시 무효화 가능.
// - JWT: 무상태라 서버 부담이 적지만, 강제 로그아웃·폐기가 어렵다.
// 동아리 규모에서는 즉시 무효화가 되는 세션이 운영·보안상 단순하다.

const BCRYPT_ROUNDS = 10;
const SESSION_TTL_MS = 14 * 24 * 60 * 60 * 1000; // 14일

export class AuthError extends Error {
  constructor(
    public readonly code: "USERNAME_TAKEN" | "INVALID_CREDENTIALS",
    message: string,
  ) {
    super(message);
  }
}

export interface PublicUser {
  id: string;
  username: string;
  displayName: string;
}

// 세션 토큰 원문은 쿠키에만 살고, DB에는 sha256 해시만 저장한다.
// (DB가 유출되어도 토큰 원문을 복원해 세션을 탈취할 수 없다)
export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export async function register(
  db: Db,
  input: { username: string; password: string; displayName: string },
): Promise<PublicUser> {
  const username = input.username.toLowerCase();
  const passwordHash = await bcrypt.hash(input.password, BCRYPT_ROUNDS);
  const id = randomUUID();
  try {
    await insertUser(db, { id, username, displayName: input.displayName, passwordHash });
  } catch (e) {
    // Postgres unique_violation. 존재 여부를 미리 조회하지 않고 유니크 제약에 맡긴다(경쟁 조건 방지).
    if ((e as { code?: string }).code === "23505") {
      throw new AuthError("USERNAME_TAKEN", "이미 사용 중인 아이디입니다");
    }
    throw e;
  }
  return { id, username, displayName: input.displayName };
}

export async function login(
  db: Db,
  input: { username: string; password: string },
): Promise<{ user: PublicUser; sessionToken: string; expiresAt: Date }> {
  const user = await findUserByUsername(db, input.username.toLowerCase());
  // 사용자가 없어도 bcrypt 비교를 한 번 수행해, 아이디 존재 여부가
  // 응답 시간 차이로 새어 나가는 것을 줄인다.
  const hash = user?.password_hash ?? "$2b$10$invalidinvalidinvalidinvalidinvalidinvalidinvalidinv";
  const ok = await bcrypt.compare(input.password, hash);
  if (!user || !ok) {
    throw new AuthError("INVALID_CREDENTIALS", "아이디 또는 비밀번호가 올바르지 않습니다");
  }

  const sessionToken = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  await insertSession(db, { tokenHash: hashToken(sessionToken), userId: user.id, expiresAt });
  return {
    user: { id: user.id, username: user.username, displayName: user.display_name },
    sessionToken,
    expiresAt,
  };
}

export async function getSessionUser(db: Db, sessionToken: string): Promise<PublicUser | null> {
  const row = await findSessionUser(db, hashToken(sessionToken));
  return row ? { id: row.id, username: row.username, displayName: row.display_name } : null;
}

export async function logout(db: Db, sessionToken: string): Promise<void> {
  await deleteSession(db, hashToken(sessionToken));
}
