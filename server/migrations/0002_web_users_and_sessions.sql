-- 적용: 2026-09-02 (Supabase MCP).
-- 홈페이지 회원 인증: users + DB 세션.
-- id는 앱에서 생성하는 UUIDv4 (학습 노트: 대규모에서는 시간정렬 UUIDv7이
-- 인덱스 단편화에 유리하나, 동아리 규모에서는 v4로 충분).
create table if not exists web.users (
  id uuid primary key,
  username text not null unique,
  display_name text not null,
  password_hash text not null,
  created_at timestamptz not null default now()
);

create table if not exists web.sessions (
  token_hash text primary key,
  user_id uuid not null references web.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null
);

create index if not exists sessions_user_id_idx on web.sessions (user_id);
create index if not exists sessions_expires_at_idx on web.sessions (expires_at);

-- 최소 권한: 테이블별 명시 grant (새 테이블을 만들면 그 마이그레이션에서 직접 grant 할 것).
grant select, insert, update on web.users to web_api;          -- 회원 삭제는 운영자 SQL로만
grant select, insert, update, delete on web.sessions to web_api;
