export const SCHEMA_VERSION = 4;

// Postgres DDL. better-sqlite3 -> pg 이전(feat/postgres-supabase-store)에서
// 기존 SQLite 스키마(db.ts 의 legacy SCHEMA + 이 파일의 NEW_SCHEMA)를 하나로 합쳤다.
// - INTEGER PRIMARY KEY AUTOINCREMENT -> BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY
// - 불리언 의미 컬럼(is_private, processed, private_memory_loaded) -> BOOLEAN
// - FTS5 가상테이블(messages_fts/events_fts)과 그 트리거는 제거했다. 검색은 이후 태스크에서 ILIKE 로 구현한다.
// - 1단계 호환 테이블(events/summaries)은 "새로 시작" 정책(T3)에 따라 제거했다 — migrateFromPhase1
//   삭제로 더 이상 아무도 참조하지 않는다(legacy Repo(better-sqlite3) 도 함께 제거).
export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  role TEXT NOT NULL DEFAULT 'blocked',
  display_name TEXT,
  created_ts BIGINT NOT NULL,
  updated_ts BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS conversations (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  kind TEXT NOT NULL,
  discord_channel_id TEXT NOT NULL UNIQUE,
  origin_message_id TEXT UNIQUE,
  guild_id TEXT,
  parent_channel_id TEXT,
  primary_user_id TEXT NOT NULL,
  is_private BOOLEAN NOT NULL DEFAULT FALSE,
  session_id TEXT,
  first_message_id BIGINT,
  private_memory_loaded BOOLEAN NOT NULL DEFAULT FALSE,
  last_active_ts BIGINT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  created_ts BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS conversation_participants (
  conversation_id BIGINT NOT NULL,
  user_id TEXT NOT NULL,
  joined_ts BIGINT NOT NULL,
  PRIMARY KEY (conversation_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_participants_conv ON conversation_participants(conversation_id);

CREATE TABLE IF NOT EXISTS messages (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  conversation_id BIGINT NOT NULL,
  ts BIGINT NOT NULL,
  role TEXT NOT NULL,
  user_id TEXT,
  discord_message_id TEXT,
  content TEXT NOT NULL,
  processed BOOLEAN NOT NULL DEFAULT TRUE
);
CREATE INDEX IF NOT EXISTS idx_messages_conv ON messages(conversation_id, id);
CREATE INDEX IF NOT EXISTS idx_messages_unprocessed ON messages(processed) WHERE processed = FALSE;
-- 리뷰(Finding 1): countUserMessages(rapportStage 파생용, 매 턴 실행)가 user_id+role 로 필터하는데
-- 인덱스가 없어 풀스캔이었다. partial index(WHERE role='user')는 pg-mem 파싱 위험이 있어
-- 복합 인덱스로 둔다 — 이 쿼리(WHERE user_id=$1 AND role='user')를 그대로 커버한다.
CREATE INDEX IF NOT EXISTS idx_messages_user ON messages(user_id, role);

CREATE TABLE IF NOT EXISTS memories (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id TEXT NOT NULL,
  scope TEXT NOT NULL,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  source_conversation_id BIGINT,
  created_ts BIGINT NOT NULL,
  updated_ts BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_memories_user ON memories(user_id, scope);

CREATE TABLE IF NOT EXISTS conversation_summaries (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  conversation_id BIGINT NOT NULL,
  from_message_id BIGINT NOT NULL,
  to_message_id BIGINT NOT NULL,
  content TEXT NOT NULL,
  created_ts BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_conversation_summaries_conv ON conversation_summaries(conversation_id);

CREATE TABLE IF NOT EXISTS logs (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  ts BIGINT NOT NULL,
  level TEXT NOT NULL,
  source TEXT NOT NULL,
  message TEXT NOT NULL,
  detail TEXT
);
CREATE INDEX IF NOT EXISTS idx_logs_ts ON logs(ts, level);

CREATE TABLE IF NOT EXISTS actions (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  ts BIGINT NOT NULL,
  conversation_id BIGINT,
  user_id TEXT,
  tool TEXT NOT NULL,
  input TEXT,
  result_summary TEXT,
  status TEXT NOT NULL,
  duration_ms BIGINT
);
CREATE INDEX IF NOT EXISTS idx_actions_conv ON actions(conversation_id, ts);

CREATE TABLE IF NOT EXISTS turns (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  ts BIGINT NOT NULL,
  user_id TEXT,
  conversation_id BIGINT,
  kind TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_turns_ts ON turns(ts);
CREATE INDEX IF NOT EXISTS idx_turns_user_ts ON turns(user_id, ts);

CREATE TABLE IF NOT EXISTS backups (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  ts BIGINT NOT NULL,
  path TEXT NOT NULL,
  size_bytes BIGINT NOT NULL,
  kind TEXT NOT NULL,
  status TEXT NOT NULL,
  note TEXT
);

CREATE TABLE IF NOT EXISTS triggers (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  kind TEXT NOT NULL,
  spec TEXT NOT NULL,
  next_run_ts BIGINT,
  target_user_id TEXT,
  target_conversation_id BIGINT,
  action TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  created_ts BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_triggers_next ON triggers(next_run_ts) WHERE status = 'active';

-- 하이브리드 재설계 조각3(사용자별 로컬 워커): Railway 봇이 owner/손님 DM 의 PC 작업(파일/Bash)을
-- 각자의 로컬 워커에게 위임하던 큐였다(워커가 비동기 2차 에이전트로 job 전체를 실행하던 시절).
-- 미사용(2026-07 얇은 워커 전환). 워커가 비동기 2차 에이전트였을 때의 작업 큐다.
-- 테이블은 마이그레이션 위험을 피해 남겨두었으나 코드는 더 이상 읽고 쓰지 않는다.
CREATE TABLE IF NOT EXISTS worker_jobs (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id TEXT NOT NULL,
  conversation_id BIGINT NOT NULL,
  discord_channel_id TEXT NOT NULL,
  user_message TEXT NOT NULL,
  message_id BIGINT,
  status TEXT NOT NULL DEFAULT 'pending',
  progress TEXT,
  result TEXT,
  error TEXT,
  created_ts BIGINT NOT NULL,
  claimed_ts BIGINT,
  done_ts BIGINT,
  delivered_ts BIGINT
);
-- 리뷰 #2/#5a 이전에 이미 만들어졌을 수 있는 환경을 위한 안전한 보강(이미 있으면 no-op).
ALTER TABLE worker_jobs ADD COLUMN IF NOT EXISTS message_id BIGINT;
ALTER TABLE worker_jobs ADD COLUMN IF NOT EXISTS delivered_ts BIGINT;
CREATE INDEX IF NOT EXISTS idx_worker_jobs_user_status ON worker_jobs(user_id, status);
CREATE INDEX IF NOT EXISTS idx_worker_jobs_status ON worker_jobs(status);
-- 리뷰 #2(HIGH): 위임 job 을 그 트리거 메시지(message_id)로 멱등화한다 — 봇 크래시 후 recoverPending 이
-- 이미 위임(enqueue)까지 끝났던 메시지를 다시 위임 시도해도, 이 부분 유니크 인덱스 덕에 같은 job 에
-- 합류할 뿐 중복 job(=중복 실행)을 만들지 않는다. NULL 은 여러 개 허용(messageId 를 안 주는 경로도 지원).
CREATE UNIQUE INDEX IF NOT EXISTS idx_worker_jobs_message_id ON worker_jobs(message_id) WHERE message_id IS NOT NULL;
-- 리뷰 #5a(MED): 타임아웃 뒤늦게 끝난 job 의 결과가 유실되지 않도록 "배달(디스코드 발행) 완료" 여부를
-- delivered_ts 로 추적했다(NULL=아직 안 보냄). 이 인덱스를 스캔하던 배달 스윕(core.ts
-- deliverPendingJobResults)은 Task 8(위임 기계장치 삭제)에서 함께 제거됐다.
CREATE INDEX IF NOT EXISTS idx_worker_jobs_undelivered ON worker_jobs(status) WHERE delivered_ts IS NULL;

-- 사용자별 워커 생존 신호였다. 워커가 주기적으로 heartbeat 를 찍고, 봇은 isOnline(cutoff) 으로
-- "지금 이 사용자의 워커가 떠 있는지" 를 판단해 위임 라우팅에 썼다.
-- 미사용(2026-07 얇은 워커 전환). 얇은 워커는 하트비트를 찍지 않는다(위임 자체가 없어졌으므로).
-- worker_jobs 와 같은 이유로 테이블은 남기고 코드만 걷어냈다.
CREATE TABLE IF NOT EXISTS worker_heartbeats (
  user_id TEXT PRIMARY KEY,
  last_ts BIGINT NOT NULL
);

-- 사용자별 허용 폴더(원격 개발 작업 대상). 기존 owner.allowedDirs 단일 settings 키를 대체한다 —
-- 소유자는 지금까지처럼 자신의 userId(config.ownerId) 로 저장/조회되어 동작이 그대로다.
CREATE TABLE IF NOT EXISTS allowed_dirs (
  user_id TEXT NOT NULL,
  dir TEXT NOT NULL,
  PRIMARY KEY (user_id, dir)
);

-- 캐릭터 표정 이미지 카탈로그. 실제 파일은 Supabase Storage 에 있고 여기엔 URL 만 둔다.
-- agent/scripts/sync-images.mjs 가 image/ 를 훑어 전체를 교체한다(부분 갱신 없음).
CREATE TABLE IF NOT EXISTS character_images (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  emotion TEXT NOT NULL,
  url TEXT NOT NULL,
  created_ts BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_character_images_emotion ON character_images(emotion);

-- 워커 신원의 정본. 워커는 hello 프레임에 자기 id 와 토큰을 실어 보내고, 허브가 여기서 행을
-- 찾아 token_hash 를 대조한다(remote/hub.ts). 평문 토큰은 저장하지 않는다 — 발급 시점에
-- 스크립트가 한 번 출력할 뿐이다.
-- kind: 'personal' 이면 user_id 가 담당 사용자, 'shared' 면 NULL(동아리 공용 기계).
CREATE TABLE IF NOT EXISTS workers (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  user_id TEXT,
  token_hash TEXT NOT NULL,
  label TEXT,
  created_ts BIGINT NOT NULL,
  last_seen_ts BIGINT
);
CREATE INDEX IF NOT EXISTS idx_workers_user ON workers(user_id);
`;
