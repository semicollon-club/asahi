import { describe, it, expect, beforeEach } from "vitest";
import path from "node:path";
import { openTestDb } from "../src/store/db.js";
import { AllowedDirsRepo } from "../src/store/allowedDirsRepo.js";

describe("AllowedDirsRepo", () => {
  let repo: AllowedDirsRepo;

  beforeEach(async () => {
    repo = new AllowedDirsRepo(await openTestDb());
  });

  it("초기 상태는 빈 배열", async () => {
    expect(await repo.list("owner-laptop")).toEqual([]);
  });

  it("add 하면 정규화된 절대경로로 저장되고 list 에 나타난다", async () => {
    await repo.add("owner-laptop", "C:\\proj\\a\\");
    expect(await repo.list("owner-laptop")).toEqual([path.win32.resolve("C:\\proj\\a")]);
  });

  it("중복 add 는 무시한다(같은 경로를 다른 표기로 넣어도)", async () => {
    await repo.add("owner-laptop", "C:\\proj\\a");
    await repo.add("owner-laptop", "C:\\proj\\a\\"); // 후행 슬래시만 다름 → 정규화 후 동일
    expect(await repo.list("owner-laptop")).toEqual([path.win32.resolve("C:\\proj\\a")]);
  });

  it("여러 폴더를 add 하면 모두 누적된다", async () => {
    await repo.add("owner-laptop", "C:\\proj\\a");
    await repo.add("owner-laptop", "C:\\proj\\b");
    expect((await repo.list("owner-laptop")).sort()).toEqual([path.win32.resolve("C:\\proj\\a"), path.win32.resolve("C:\\proj\\b")].sort());
  });

  it("remove 하면 목록에서 제거된다", async () => {
    await repo.add("owner-laptop", "C:\\proj\\a");
    await repo.add("owner-laptop", "C:\\proj\\b");
    await repo.remove("owner-laptop", "C:\\proj\\a\\"); // 후행 슬래시 다르게 줘도 정규화되어 제거됨
    expect(await repo.list("owner-laptop")).toEqual([path.win32.resolve("C:\\proj\\b")]);
  });

  it("존재하지 않는 dir 을 remove 해도 안전하다", async () => {
    await repo.add("owner-laptop", "C:\\proj\\a");
    await repo.remove("owner-laptop", "C:\\nope");
    expect(await repo.list("owner-laptop")).toEqual([path.win32.resolve("C:\\proj\\a")]);
  });

  it("서로 다른 워커는 서로 격리된다(한쪽 add/remove 가 다른쪽에 영향 없음)", async () => {
    await repo.add("owner-laptop", "C:\\proj\\a");
    await repo.add("semicolon-shared", "C:\\proj\\b");
    expect(await repo.list("owner-laptop")).toEqual([path.win32.resolve("C:\\proj\\a")]);
    expect(await repo.list("semicolon-shared")).toEqual([path.win32.resolve("C:\\proj\\b")]);

    await repo.remove("owner-laptop", "C:\\proj\\a");
    expect(await repo.list("owner-laptop")).toEqual([]);
    expect(await repo.list("semicolon-shared")).toEqual([path.win32.resolve("C:\\proj\\b")]); // 영향 없음
  });

  it("같은 경로라도 워커가 다르면 독립적으로 저장된다", async () => {
    await repo.add("owner-laptop", "C:\\proj\\shared");
    await repo.add("semicolon-shared", "C:\\proj\\shared");
    expect(await repo.list("owner-laptop")).toEqual([path.win32.resolve("C:\\proj\\shared")]);
    expect(await repo.list("semicolon-shared")).toEqual([path.win32.resolve("C:\\proj\\shared")]);
    await repo.remove("owner-laptop", "C:\\proj\\shared");
    expect(await repo.list("owner-laptop")).toEqual([]);
    expect(await repo.list("semicolon-shared")).toEqual([path.win32.resolve("C:\\proj\\shared")]);
  });

  it("서로 다른 워커의 목록은 섞이지 않는다", async () => {
    await repo.add("owner-laptop", "C:\\dev");
    await repo.add("semicolon-shared", "C:\\workspace");
    expect(await repo.list("owner-laptop")).toEqual(["C:\\dev"]);
    expect(await repo.list("semicolon-shared")).toEqual(["C:\\workspace"]);
  });
});
