# server 마이그레이션

`web` 스키마의 변화는 전부 이 폴더의 SQL 파일로 관리한다. **DB 대시보드에서 직접 스키마를
고치지 않는다** — 파일로 남겨야 dev/운영이 같은 상태를 유지하고 리뷰가 가능하다.

## 팀원 워크플로 (DB 권한 불필요)

1. `NNNN_설명.sql` 파일 추가 (번호는 마지막 +1, 파일명은 영문)
2. dev DB에 적용해 확인: `npm run migrate:dev` (`.env`의 `MIGRATE_DATABASE_URL` = dev용, 운영자에게 받기)
3. 코드와 함께 PR → 리뷰 → 병합
4. **운영 반영은 자동**: production 배포 시 pre-deploy 단계에서 러너가 미적용 파일만 실행

## 작성 규칙

- 한 파일 = 한 번 적용되면 끝. 이미 병합된 파일은 수정하지 말고 새 파일로 후속 변경
- 새 테이블을 만들면 같은 파일에서 `web_api`에 필요한 최소 권한만 grant (예: 0002 참조)
- 재실행 안전(idempotent)하게 쓰면 더 좋다 (`if not exists`, 0003의 DO 블록 패턴)
- 비밀값(role 비밀번호 등)은 절대 커밋 금지 — role 생성은 아래 프로비저닝으로

## 환경 프로비저닝 (운영자 1회, 저장소 밖)

새 DB(예: dev 재구축)에는 러너 실행 전에 role 두 개를 만들어야 한다:

```sql
create role web_api login password '<비밀>';       -- 서버 런타임: web 스키마 DML만
create role web_migrator login password '<비밀>';  -- 러너: web 스키마 한정 DDL
grant web_api to postgres; grant web_migrator to postgres;
grant create on database postgres to web_migrator;
alter role web_api set search_path = web;
alter role web_migrator set search_path = web;
```

## 적용 이력

- 적용 여부는 각 DB의 `web.schema_migrations` 테이블이 기록한다 (러너가 자동 관리)
- 운영 DB에는 0001~0003이 구축 시점(2026-09-02)에 수동 적용됐고, 같은 날 기준선으로 이력에 등록됨
