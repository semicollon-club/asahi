import "dotenv/config";
import { createApp } from "./app.js";

const port = Number(process.env.PORT ?? 8788);

createApp().listen(port, "0.0.0.0", () => {
  console.log(`[web-api] listening on :${port}`);
});
