import type { Db } from "./db.js";

export type CharacterImage = { id: number; emotion: string; url: string };
type Row = { id: number | string; emotion: string; url: string };

// 캐릭터 표정 이미지 카탈로그. 파일 자체는 Supabase Storage 에 있고 여기엔 URL 만 있다.
export class CharacterImagesRepo {
  constructor(private db: Db) {}

  // 카탈로그에 실제로 이미지가 있는 감정만 돌려준다 — 빈 폴더가 프롬프트에 새어들어
  // 모델이 없는 표정을 부르는 걸 막는다.
  async emotions(): Promise<string[]> {
    const r = await this.db.query("SELECT DISTINCT emotion FROM character_images ORDER BY emotion");
    return (r.rows as { emotion: string }[]).map((x) => x.emotion);
  }

  async urlsFor(emotion: string): Promise<string[]> {
    const r = await this.db.query("SELECT url FROM character_images WHERE emotion = $1 ORDER BY id", [emotion]);
    return (r.rows as { url: string }[]).map((x) => x.url);
  }

  // 동기화 스크립트 전용: 카탈로그를 통째로 갈아끼운다. 부분 갱신을 두지 않는 이유는
  // 폴더에서 지운 이미지가 카탈로그에 남는 걸 막기 위해서다.
  async replaceAll(rows: Array<{ emotion: string; url: string }>, ts: number): Promise<void> {
    await this.db.query("DELETE FROM character_images");
    for (const row of rows) {
      await this.db.query(
        "INSERT INTO character_images (emotion, url, created_ts) VALUES ($1, $2, $3)",
        [row.emotion, row.url, ts],
      );
    }
  }
}
