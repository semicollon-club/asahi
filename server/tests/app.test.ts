import { describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "../src/app.js";

describe("web-api 기본 동작", () => {
  it("GET /health 는 서비스 식별 정보를 반환한다", async () => {
    const res = await request(createApp()).get("/health");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, service: "web-api" });
  });

  it("등록되지 않은 경로는 404를 반환한다", async () => {
    const res = await request(createApp()).get("/no-such-route");
    expect(res.status).toBe(404);
  });
});
