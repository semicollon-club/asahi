-- 적용: 2026-09-02 (Supabase MCP). 비밀번호는 커밋하지 않는다 — Railway 변수에만 존재.
-- 동아리 웹 백엔드(web-api) 전용 스키마와 최소 권한 role.
-- agent(상주 에이전트) 테이블은 public 스키마에 있고, web_api role에는
-- public 테이블 권한을 일절 주지 않는다 (워커 토큰·대화 기록 보호).
create schema if not exists web;

do $$
begin
  if not exists (select from pg_roles where rolname = 'web_api') then
    create role web_api login password '<비밀 — Railway DATABASE_URL 참조>';
  end if;
end$$;

alter role web_api set search_path = web;
grant usage on schema web to web_api;
