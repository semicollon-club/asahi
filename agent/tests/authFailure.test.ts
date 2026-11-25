import { describe, it, expect } from "vitest";
import {
  isAuthFailure, shouldAlertOwner, AUTH_ALERT_COOLDOWN_MS, authFailureUserNotice, authFailureOwnerAlert,
} from "../src/core/authFailure.js";

// 빠른 개선 1.1(2026-11-25 설계): 구독 토큰이 폐기·만료되면 모든 턴이 같은 식으로 실패한다. 그 실패만 정확히
// 가려 소유자에게 알린다 — 다른 실패(한도·과부하·세션 없음·작업 토큰)를 섞으면 거짓 경보가 된다.

describe("isAuthFailure — 업스트림 구독 인증 실패만 참", () => {
  it("2026-11-25 실제 문구(토큰 폐기)", () => {
    expect(isAuthFailure("Claude Code returned an error result: Failed to authenticate. API Error: 401 OAuth access token has been revoked.")).toBe(true);
  });

  it("만료·잘못된 키·authentication_error 본문", () => {
    expect(isAuthFailure('API Error: 401 {"type":"error","error":{"type":"authentication_error","message":"OAuth token has expired"}}')).toBe(true);
    expect(isAuthFailure("Invalid API key · Please run /login")).toBe(true);
    expect(isAuthFailure("invalid x-api-key")).toBe(true);
  });

  it("Claude Code 가 비대화 모드에서 바꿔 내는 문구와 프록시의 구독 자격증명 없음(2026-11-25 리뷰)", () => {
    expect(isAuthFailure("Your account does not have access to Claude. Please login again or contact your administrator.")).toBe(true);
    expect(isAuthFailure("Not logged in · Please run /login")).toBe(true);
    expect(isAuthFailure("OAuth token revoked · Please run /login")).toBe(true);
    expect(isAuthFailure("Login expired")).toBe(true);
    expect(isAuthFailure('API Error: 503 {"type":"error","error":{"type":"api_error","message":"프록시에 구독 자격증명이 없어요 — 봇의 CLAUDE_CODE_OAUTH_TOKEN 을 확인하세요."}}')).toBe(true);
  });

  it("프록시가 작업 토큰을 거부한 것은 구독 문제가 아니다", () => {
    expect(isAuthFailure('API Error: 401 {"type":"error","error":{"type":"authentication_error","message":"작업 토큰이 없거나 만료됐어요. 새 턴을 시작하면 새 토큰을 받아요."}}')).toBe(false);
  });

  it("다른 실패는 거짓", () => {
    for (const s of [
      "error_max_turns",
      "No conversation found with session ID: abc",
      'API Error: 429 {"type":"error","error":{"type":"rate_limit_error"}}',
      "API Error: 529 overloaded_error",
      "워커가 1800000ms 안에 응답하지 않았어요(턴 결과 없음).",
      "",
    ]) expect(isAuthFailure(s)).toBe(false);
  });
});

describe("shouldAlertOwner — 6시간에 한 번", () => {
  const now = 10 * AUTH_ALERT_COOLDOWN_MS;
  it("보낸 적이 없으면 보낸다", () => {
    expect(shouldAlertOwner(null, now)).toBe(true);
  });
  it("주기 안이면 보내지 않는다", () => {
    expect(shouldAlertOwner(now - 60 * 60 * 1000, now)).toBe(false);
  });
  it("주기가 지나면 다시 보낸다", () => {
    expect(shouldAlertOwner(now - AUTH_ALERT_COOLDOWN_MS, now)).toBe(true);
  });
});

describe("안내 문구", () => {
  const raw = "Failed to authenticate. API Error: 401 OAuth access token has been revoked.";
  it("부원에게는 운영자에게 알렸다고 말하고 원문은 싣지 않는다", () => {
    const t = authFailureUserNotice(false, raw);
    expect(t).toMatch(/운영자에게 알렸/);
    expect(t).not.toContain("API Error");
  });
  it("소유자에게는 조치와 원문을 함께 준다", () => {
    const t = authFailureUserNotice(true, raw);
    expect(t).toContain("CLAUDE_CODE_OAUTH_TOKEN");
    expect(t).toContain("revoked");
    const alert = authFailureOwnerAlert(raw);
    expect(alert).toContain("CLAUDE_CODE_OAUTH_TOKEN");
    expect(alert).toContain("claude setup-token");
    expect(alert).toContain("revoked");
  });
  it("원문이 길면 자른다", () => {
    expect(authFailureOwnerAlert(`${raw} ${"z".repeat(2000)}`).length).toBeLessThan(800);
  });
});
