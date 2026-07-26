#!/usr/bin/env node
// 표정 이미지 동기화: image/<감정>/*.png 를 Supabase Storage 에 올리고
// character_images 카탈로그를 통째로 갈아끼운다.
//
// 실행: cd agent && npm run sync-images
// 필요 환경변수: DATABASE_URL, SUPABASE_URL, SUPABASE_SERVICE_KEY
//
// 이미지를 추가·교체·삭제한 뒤 이 스크립트만 다시 돌리면 된다. 재배포는 필요 없다.
// 다만 "새로운 감정 폴더"를 추가한 경우, 봇이 기동 시 감정 목록을 읽으므로
// 봇을 재시작해야 모델이 그 표정을 알게 된다.

import fs from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import dotenv from "dotenv";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
dotenv.config({ path: path.join(ROOT, ".env") });

const BUCKET = "character-images";
// 감정이 아닌 폴더. 새로 생기면 여기에 추가한다.
const IGNORED_DIRS = new Set(["임시"]);
const IMAGE_EXT = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp"]);
const CONTENT_TYPE = {
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
  ".gif": "image/gif", ".webp": "image/webp",
};

function requireEnv(key) {
  const v = process.env[key];
  if (!v) {
    console.error(`환경변수 누락: ${key} — .env 를 확인하세요 (.env.example 참고)`);
    process.exit(1);
  }
  return v;
}

const DATABASE_URL = requireEnv("DATABASE_URL");
const SUPABASE_URL = requireEnv("SUPABASE_URL").replace(/\/+$/, "");
const SERVICE_KEY = requireEnv("SUPABASE_SERVICE_KEY");

// image/ 아래에서 감정 폴더와 그 안의 이미지 파일을 모은다. 빈 폴더는 아예 제외한다 —
// 이미지가 없는 감정이 카탈로그에 들어가면 모델이 부를 수 없는 표정을 알게 된다.
function collect() {
  const imageDir = path.join(ROOT, "image");
  const out = [];
  for (const entry of fs.readdirSync(imageDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || IGNORED_DIRS.has(entry.name)) continue;
    const files = fs.readdirSync(path.join(imageDir, entry.name))
      .filter((f) => IMAGE_EXT.has(path.extname(f).toLowerCase()));
    if (files.length === 0) {
      console.log(`  건너뜀: ${entry.name} (이미지 없음)`);
      continue;
    }
    for (const file of files) {
      out.push({ emotion: entry.name, file, abs: path.join(imageDir, entry.name, file) });
    }
  }
  return out;
}

// Supabase Storage 는 객체 키에 한글을 허용하지 않는다. URL 인코딩해서 보내도 서버가
// 디코딩한 뒤 검증하므로 소용이 없다(InvalidKey). 그래서 키는 이름을 해시한 ASCII 로 만든다.
//
// 해시는 결정적이라 같은 파일을 다시 올리면 같은 키가 되고, x-upsert 로 덮어써진다 —
// 재실행해도 스토리지에 사본이 쌓이지 않는다. 한글 감정 이름은 키가 아니라 DB 카탈로그의
// emotion 컬럼에 그대로 들어가며, 모델의 마커가 대조하는 건 그쪽이다.
const short = (s) => createHash("sha1").update(s, "utf8").digest("hex").slice(0, 12);
const objectPath = (emotion, file) => `${short(emotion)}/${short(file)}${path.extname(file).toLowerCase()}`;

async function upload(item) {
  const p = objectPath(item.emotion, item.file);
  const body = fs.readFileSync(item.abs);
  const res = await fetch(`${SUPABASE_URL}/storage/v1/object/${BUCKET}/${p}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${SERVICE_KEY}`,
      "Content-Type": CONTENT_TYPE[path.extname(item.file).toLowerCase()] ?? "application/octet-stream",
      "x-upsert": "true",
    },
    body,
  });
  if (!res.ok) throw new Error(`업로드 실패 ${item.emotion}/${item.file}: ${res.status} ${await res.text()}`);
  return `${SUPABASE_URL}/storage/v1/object/public/${BUCKET}/${p}`;
}

async function main() {
  const items = collect();
  if (items.length === 0) {
    console.error("올릴 이미지가 없습니다. image/ 아래 감정 폴더를 확인하세요.");
    process.exit(1);
  }
  console.log(`이미지 ${items.length}장 업로드 시작…`);

  const rows = [];
  for (const item of items) {
    rows.push({ emotion: item.emotion, url: await upload(item) });
    process.stdout.write(".");
  }
  console.log("\n업로드 완료. 카탈로그 갱신 중…");

  const client = new pg.Client({ connectionString: DATABASE_URL });
  await client.connect();
  try {
    // 테이블을 여기서도 보장한다. 정본은 agent/src/store/schema.ts 이고 봇이 기동할 때 만들지만,
    // 이 스크립트는 봇보다 먼저 돌 수 있다(첫 셋업이 정확히 그 상황이다). 둘 다 IF NOT EXISTS 라
    // 어느 쪽이 먼저 돌든 결과가 같다 — schema.ts 를 고치면 이쪽도 같이 고칠 것.
    await client.query(`
      CREATE TABLE IF NOT EXISTS character_images (
        id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        emotion TEXT NOT NULL,
        url TEXT NOT NULL,
        created_ts BIGINT NOT NULL
      );
    `);
    await client.query("CREATE INDEX IF NOT EXISTS idx_character_images_emotion ON character_images(emotion)");

    await client.query("BEGIN");
    await client.query("DELETE FROM character_images");
    const ts = Date.now();
    for (const row of rows) {
      await client.query(
        "INSERT INTO character_images (emotion, url, created_ts) VALUES ($1, $2, $3)",
        [row.emotion, row.url, ts],
      );
    }
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    await client.end();
  }

  const byEmotion = rows.reduce((acc, r) => ({ ...acc, [r.emotion]: (acc[r.emotion] ?? 0) + 1 }), {});
  console.log("완료:");
  for (const [emotion, count] of Object.entries(byEmotion)) console.log(`  ${emotion}: ${count}장`);
  console.log("\n새 감정 폴더를 추가했다면 봇을 재시작해야 모델이 그 표정을 알게 됩니다.");
}

main().catch((err) => {
  console.error("동기화 실패:", err);
  process.exit(1);
});
