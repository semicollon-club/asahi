import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { checkPath } from "../src/remote/roots.js";

describe("checkPath — 워커 루트 검사", () => {
  let root: string;
  beforeEach(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "asahi-roots-")));
    fs.mkdirSync(path.join(root, "proj"), { recursive: true });
    fs.writeFileSync(path.join(root, "proj", "a.txt"), "hello");
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it("루트 안의 기존 파일은 허용하고 realpath 를 돌려준다", () => {
    const r = checkPath(path.join(root, "proj", "a.txt"), [root]);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.path).toBe(path.join(root, "proj", "a.txt"));
  });

  it("아직 없는 파일도 조상이 루트 안이면 허용한다(새로 쓸 파일)", () => {
    const r = checkPath(path.join(root, "proj", "new.txt"), [root]);
    expect(r.ok).toBe(true);
  });

  it("루트 밖 경로는 거부한다", () => {
    const r = checkPath(path.join(os.tmpdir(), "elsewhere.txt"), [root]);
    expect(r.ok).toBe(false);
  });

  it("'..' 로 루트를 벗어나면 거부한다", () => {
    const r = checkPath(path.join(root, "proj", "..", "..", "escape.txt"), [root]);
    expect(r.ok).toBe(false);
  });

  it("루트 목록이 비어 있으면 거부한다", () => {
    expect(checkPath(path.join(root, "proj", "a.txt"), []).ok).toBe(false);
  });

  it("여러 루트 중 하나에만 속해도 허용한다", () => {
    const other = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "asahi-roots2-")));
    try {
      expect(checkPath(path.join(root, "proj", "a.txt"), [other, root]).ok).toBe(true);
    } finally {
      fs.rmSync(other, { recursive: true, force: true });
    }
  });
});
