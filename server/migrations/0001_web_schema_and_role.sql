-- web-api 스키마 기틀.
-- role(web_api = DML 전용, web_migrator = web 스키마 한정 DDL)은 비밀번호가 필요해
-- 저장소에 두지 않고, 운영자가 환경(DB)마다 1회 직접 생성한다 — README '환경 프로비저닝' 참조.
create schema if not exists web;
grant usage on schema web to web_api;
