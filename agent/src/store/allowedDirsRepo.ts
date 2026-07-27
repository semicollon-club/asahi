import type { Db } from "./db.js";
import { normalizeDir } from "../core/paths.js";

// 워커별로 원격 개발 작업을 허용한 폴더 목록. 실제 fs 존재 검증은 하지 않는다(도구 계층의 몫).
// 예전에는 user_id 키였다 — "한 사람 = 한 대"가 성립할 때만 맞는 전제였다. 공용 워커(예: 동아리방
// 공용 PC)가 소유자의 노트북과 나란히 붙을 수 있게 되면서, 허용 폴더는 사람이 아니라 그 폴더가
// 실제로 존재하는 기계(워커)에 속한다는 사실에 맞춰 worker_id 키로 바꿨다. 옛 user_id 행의 값
// 자체는 옮기지 않는다 — 옛 행은 소유자 폴더 몇 개뿐이라, 워커를 등록한 뒤 allow_dir 로 다시
// 등록하는 편이 이관 코드를 작성·검증하는 것보다 싸다. 다만 "옮기지 않는다"가 "옛 컬럼 그대로
// 방치한다"는 아니다 — db.ts 의 convertLegacyAllowedDirs 가 부팅마다 옛 모양을 감지해 이 테이블을
// 자동으로 새 모양으로 바꾼다(최종 pre-merge 리뷰 FIX1). 그 변환 없이는 이 클래스의 모든 쿼리가
// worker_id 컬럼이 없다는 드라이버 오류로 깨진다.
export class AllowedDirsRepo {
  constructor(private db: Db) {}

  async list(workerId: string): Promise<string[]> {
    const r = await this.db.query("SELECT dir FROM allowed_dirs WHERE worker_id = $1 ORDER BY dir", [workerId]);
    return (r.rows as { dir: string }[]).map((row) => row.dir);
  }

  async add(workerId: string, dir: string): Promise<void> {
    const norm = normalizeDir(dir);
    await this.db.query(
      "INSERT INTO allowed_dirs (worker_id, dir) VALUES ($1, $2) ON CONFLICT (worker_id, dir) DO NOTHING",
      [workerId, norm],
    );
  }

  async remove(workerId: string, dir: string): Promise<void> {
    const norm = normalizeDir(dir);
    await this.db.query("DELETE FROM allowed_dirs WHERE worker_id = $1 AND dir = $2", [workerId, norm]);
  }
}
