import { describe, it, expect } from "vitest";
import {
  JOB_TOKEN_TTL_MS, newJobTokenSecret, newJobId, mintJobToken, verifyJobToken, makeJobTokenMinter,
  type JobTokenClaims,
} from "../src/core/jobToken.js";

// 작업 토큰(풀 하네스 설계 §4.2, 0단계 0.1). 봇이 발급하고 봇만 검증한다 — 비밀은 부팅마다 난수라
// 설정이 없다. 워커(나중엔 세션 계정)는 이 값을 뜯어볼 수 없고 `POST /files` 에 그대로 실어 보낼 뿐이다.
// 토큰이 말하는 것은 "어느 부원의 어느 대화(채널)에서 발급됐고 언제 만료되는가" — /files 가 첨부를
// 어느 채널로 보낼지를 오직 이 값으로 정하므로, 변조·만료·다른 비밀로 서명된 토큰은 전부 null 이어야 한다.
const claims: JobTokenClaims = { jobId: "j1", userId: "u1", conversationId: 7, channelRef: "c-77", exp: 10_000 };

describe("작업 토큰 — mint/verify", () => {
  it("발급한 토큰을 같은 비밀로 검증하면 클레임이 그대로 돌아온다", () => {
    const secret = newJobTokenSecret();
    const token = mintJobToken(secret, claims);
    expect(verifyJobToken(secret, token, 9_999)).toEqual(claims);
  });

  it("토큰 문자열에 클레임이 평문으로 보여도 서명 없이는 쓸 수 없다 — 클레임 한 글자를 바꾸면 거절한다", () => {
    const secret = newJobTokenSecret();
    const token = mintJobToken(secret, claims);
    // 형식은 <접두>.<payload>.<sig> 다. payload 를 다른 채널로 바꿔 끼운다.
    const [prefix, , sig] = token.split(".");
    const forged = Buffer.from(JSON.stringify({ ...claims, channelRef: "c-evil" })).toString("base64url");
    expect(verifyJobToken(secret, `${prefix}.${forged}.${sig}`, 0)).toBeNull();
  });

  it("서명 한 글자를 바꾸면 거절한다", () => {
    const secret = newJobTokenSecret();
    const token = mintJobToken(secret, claims);
    const flipped = token.slice(0, -1) + (token.endsWith("A") ? "B" : "A");
    expect(verifyJobToken(secret, flipped, 0)).toBeNull();
  });

  it("다른 비밀(다른 부팅)로 서명된 토큰은 거절한다", () => {
    const token = mintJobToken(newJobTokenSecret(), claims);
    expect(verifyJobToken(newJobTokenSecret(), token, 0)).toBeNull();
  });

  it("만료 시각이 지나면 거절한다(만료 시각 자체는 아직 유효)", () => {
    const secret = newJobTokenSecret();
    const token = mintJobToken(secret, claims);
    expect(verifyJobToken(secret, token, 9_999)).not.toBeNull();
    expect(verifyJobToken(secret, token, 10_000)).toBeNull();
    expect(verifyJobToken(secret, token, 10_001)).toBeNull();
  });

  it("형식이 어긋난 문자열은 예외 없이 null 이다", () => {
    const secret = newJobTokenSecret();
    for (const junk of ["", "abc", "a.b", "a.b.c.d", "asahi-job.!!!.???", "Bearer x", mintJobToken(secret, claims).replace("asahi-job", "other")]) {
      expect(verifyJobToken(secret, junk, 0)).toBeNull();
    }
  });

  it("payload 가 JSON 이지만 클레임 모양이 아니면 거절한다(서명이 맞아도)", () => {
    // 서명은 payload 문자열에 대한 것이라, 모양이 틀린 payload 도 같은 비밀로 서명하면 서명 검사는 통과한다 —
    // 그 뒤의 모양 검사가 따로 있어야 한다.
    const secret = newJobTokenSecret();
    const bogus = mintJobToken(secret, { ...claims, conversationId: "7" as unknown as number });
    expect(verifyJobToken(secret, bogus, 0)).toBeNull();
  });

  it("jobId 는 호출마다 다르다", () => {
    const ids = new Set(Array.from({ length: 50 }, () => newJobId()));
    expect(ids.size).toBe(50);
  });
});

describe("makeJobTokenMinter — 발급과 검증을 한 비밀로 묶는다", () => {
  it("기본 수명은 2시간이고, 부원·대화·채널을 실어 발급하며 같은 인스턴스가 검증한다", () => {
    let now = 1_000;
    const minter = makeJobTokenMinter(newJobTokenSecret(), { now: () => now });
    const token = minter.mint({ userId: "u1", conversationId: 3, channelRef: "c-3" });
    const got = minter.verify(token);
    expect(got).toMatchObject({ userId: "u1", conversationId: 3, channelRef: "c-3", exp: 1_000 + JOB_TOKEN_TTL_MS });
    expect(typeof got?.jobId).toBe("string");
    expect(JOB_TOKEN_TTL_MS).toBe(2 * 60 * 60 * 1000);
    now = 1_000 + JOB_TOKEN_TTL_MS;
    expect(minter.verify(token)).toBeNull();
  });

  it("수명을 주입할 수 있다", () => {
    let now = 0;
    const minter = makeJobTokenMinter(newJobTokenSecret(), { now: () => now, ttlMs: 50 });
    const token = minter.mint({ userId: "u", conversationId: 1, channelRef: "c" });
    now = 49;
    expect(minter.verify(token)).not.toBeNull();
    now = 50;
    expect(minter.verify(token)).toBeNull();
  });
});
