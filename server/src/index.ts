import "dotenv/config";
import { createApp } from "./app.js";
import { openDb } from "./db.js";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  console.error("[web-api] DATABASE_URL 이 설정되지 않았습니다. .env 또는 Railway 변수를 확인하세요.");
  process.exit(1);
}

const port = Number(process.env.PORT ?? 8788);
const db = openDb(connectionString);

createApp({ db }).listen(port, "0.0.0.0", () => {
  console.log(`[web-api] listening on :${port}`);
});
