-- 적용: 2026-09-02 (Supabase MCP).
-- 심층 방어: web 스키마는 Data API에 노출되지 않지만, 만약 나중에 노출되더라도
-- anon/authenticated가 접근할 수 없도록 RLS를 켠다. web_api(우리 서버)만 전체 접근.
alter table web.users enable row level security;
alter table web.sessions enable row level security;

create policy web_api_all_users on web.users
  for all to web_api using (true) with check (true);

create policy web_api_all_sessions on web.sessions
  for all to web_api using (true) with check (true);
