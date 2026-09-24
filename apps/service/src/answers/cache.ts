import type { AnswerResult, Principal } from "@kb/contracts";
import { SearchService } from "../search/search";
import { AppError } from "../errors";
export class AnswerCache {
  constructor(readonly search: SearchService) {}
  validate(answer: AnswerResult, p: Principal) {
    const snapshot = this.search.snapshot(answer.snapshotId, p);
    this.search.validate(snapshot, p);
    // Re-read every original, including origins traced from generated pages.
    for (const e of answer.evidence) {
      const current = this.search.evidence.read(e.id);
      if (
        JSON.stringify(current.profile) !== JSON.stringify(e.profile) ||
        current.familyId !== e.familyId
      )
        throw new AppError("BASELINE");
    }
    return answer;
  }
  get(key: string, p: Principal) {
    const row = this.search.store.db
      .prepare("SELECT value FROM answer_cache WHERE key=?")
      .get(key) as { value: string } | undefined;
    return row
      ? this.validate(JSON.parse(row.value) as AnswerResult, p)
      : undefined;
  }
  put(key: string, answer: AnswerResult) {
    this.search.store.db
      .prepare(
        "INSERT INTO answer_cache VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      )
      .run(key, JSON.stringify(answer));
  }
}
