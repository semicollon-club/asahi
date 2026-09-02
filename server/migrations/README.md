# server 마이그레이션 기록

Supabase(프로젝트 Asahi)의 `web` 스키마에 적용된 마이그레이션의 기록 사본이다.
아직 자동 마이그레이션 러너는 없으며(추후 실험 과제), 적용은 운영자가
Supabase MCP/SQL Editor로 수행하고 여기 파일로 남긴다.

| 파일 | 적용일 | 내용 |
| --- | --- | --- |
| 0001_web_schema_and_role.sql | 2026-09-02 | `web` 스키마 + `web_api` 최소권한 role |
| 0002_web_users_and_sessions.sql | 2026-09-02 | users/sessions 테이블 + 테이블별 grant |
| 0003_web_tables_rls.sql | 2026-09-02 | RLS + web_api 전용 정책 (심층 방어) |

규칙: 새 테이블을 만들면 그 마이그레이션에서 `web_api`에 필요한 최소 권한만 직접 grant 한다.
비밀번호 등 비밀값은 이 저장소에 절대 커밋하지 않는다.
