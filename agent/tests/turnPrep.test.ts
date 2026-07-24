import { describe, it, expect, beforeEach } from "vitest";
import { openTestDb, type Db } from "../src/store/db.js";
import { MemoriesRepo } from "../src/store/memoriesRepo.js";
import { SummariesRepo } from "../src/store/summariesRepo.js";
import { MessagesRepo } from "../src/store/messagesRepo.js";
import { ConversationsRepo } from "../src/store/conversationsRepo.js";
import { buildContextBlock, CHARACTER_FACT_LIMIT } from "../src/core/turnPrep.js";

describe("buildContextBlock — 흉내 방지 안내", () => {
  let db: Db;
  beforeEach(async () => { db = await openTestDb(); });

  it("최근 대화 기록이 참고용이며 이전 답변 말투를 흉내내지 말고 캐릭터 지침을 따르라는 안내를 포함한다", async () => {
    const convs = new ConversationsRepo(db);
    await convs.create({ kind: "dm", discordChannelId: "c", primaryUserId: "u", isPrivate: true, lastActiveTs: 1 });
    const conv = (await convs.getByChannelId("c"))!;
    const repos = { memories: new MemoriesRepo(db), summaries: new SummariesRepo(db), messages: new MessagesRepo(db) };

    const block = await buildContextBlock(repos, conv, -1);
    expect(block).toMatch(/흉내/);
    expect(block).toMatch(/캐릭터|시스템 지침/);
    expect(block).toMatch(/참고용/);
  });
});

describe("buildContextBlock — 캐릭터 확정 설정 주입", () => {
  let db: Db;
  let memories: MemoriesRepo;
  let conv: Awaited<ReturnType<ConversationsRepo["getByChannelId"]>>;

  beforeEach(async () => {
    db = await openTestDb();
    const convs = new ConversationsRepo(db);
    await convs.create({ kind: "dm", discordChannelId: "c", primaryUserId: "u", isPrivate: true, lastActiveTs: 1 });
    conv = await convs.getByChannelId("c");
    memories = new MemoriesRepo(db);
  });

  const build = async () =>
    buildContextBlock({ memories, summaries: new SummariesRepo(db), messages: new MessagesRepo(db) }, conv!, -1);

  it("설정이 없으면 '(설정 없음)' 으로 표시한다", async () => {
    const block = await build();
    expect(block).toMatch(/## 내 설정/);
    expect(block).toMatch(/\(설정 없음\)/);
  });

  it("저장된 캐릭터 설정을 [제목] 내용 형식으로 주입한다", async () => {
    await memories.insert({ userId: "u", scope: "character", title: "학년", content: "2학년" });
    const block = await build();
    expect(block).toMatch(/\[학년\] 2학년/);
    expect(block).not.toMatch(/\(설정 없음\)/);
  });

  it("실제 기억(user/shared)은 캐릭터 설정 섹션과 섞이지 않는다", async () => {
    await memories.insert({ userId: "u", scope: "character", title: "학년", content: "2학년" });
    await memories.insert({ userId: "u", scope: "user", title: "고양이", content: "두 마리" });
    const block = await build();
    const factSection = block.slice(block.indexOf("## 내 설정"), block.indexOf("## 기억"));
    expect(factSection).toMatch(/2학년/);
    expect(factSection).not.toMatch(/고양이/);
  });

  it("상한을 넘으면 오래된 설정을 우선 남긴다", async () => {
    for (let i = 0; i < CHARACTER_FACT_LIMIT + 5; i++) {
      await memories.insert({ userId: "u", scope: "character", title: `설정${i}`, content: `내용${i}` });
    }
    const block = await build();
    expect(block).toMatch(/\[설정0\] 내용0/);
    expect(block).not.toMatch(/\[설정41\]/);
  });
});
