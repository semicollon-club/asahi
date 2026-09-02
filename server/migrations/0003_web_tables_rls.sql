-- 심층 방어: web 스키마는 Data API에 노출되지 않지만, 만약 나중에 노출되더라도
-- anon/authenticated가 접근할 수 없도록 RLS를 켠다. web_api(우리 서버)만 전체 접근.
-- (재실행 안전: 정책이 이미 있으면 건너뛴다)
alter table web.users enable row level security;
alter table web.sessions enable row level security;

do $$
begin
  if not exists (select from pg_policies where schemaname = 'web' and tablename = 'users' and policyname = 'web_api_all_users') then
    create policy web_api_all_users on web.users for all to web_api using (true) with check (true);
  end if;
  if not exists (select from pg_policies where schemaname = 'web' and tablename = 'sessions' and policyname = 'web_api_all_sessions') then
    create policy web_api_all_sessions on web.sessions for all to web_api using (true) with check (true);
  end if;
end$$;
