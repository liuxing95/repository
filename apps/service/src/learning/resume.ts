import { type Principal } from "@kb/contracts";
import { LearningStore } from "./goals";
import { Attempts } from "./attempts";
import { sourceImpact } from "./impact";
import { evidenceView } from "./evidence-view";
import { choice } from "./units";
export function resume(
  db: LearningStore,
  goalId: string,
  unitId: string,
  p: Principal,
) {
  db.read(p);
  const goal = db.goal(goalId),
    baseline = db.baseline(goal.baselineId),
    unit = db.unit(baseline, unitId),
    attempts = new Attempts(db);
  const history = attempts.list(goalId, unitId),
    latest = history.at(-1);
  return {
    goal,
    baseline,
    unit,
    choice: choice(db, goalId, unitId),
    firstStart: !latest,
    message: latest
      ? "继续上次活动；历史尝试的版本和当前目标可能不同。"
      : "首次开始：先阅读必要资料，再记录自己的实际尝试。",
    sources: sourceImpact(db, baseline, unitId),
    latestAttempt: latest ? attempts.visible(latest) : null,
    attempts: history.slice(-50).map((a) => attempts.visible(a)),
    historyTruncated: history.length > 50,
    progress: evidenceView(db, baseline),
    taskLinks: (
      db.store.db
        .prepare(
          "SELECT value FROM learning_task_intents WHERE json_extract(value,'$.goalId')=? AND json_extract(value,'$.unitId')=?",
        )
        .all(goalId, unitId) as { value: string }[]
    ).map((r) => JSON.parse(r.value)),
    boundaries: {
      materials: "资料收录按收录清单核对",
      tasks: "任务状态由 TaskNotes 核对；本视图不另设完成勾选",
      learning: "按固定基线展示尝试和评价",
      knowledge: "知识审核仍从 07 / Wiki 候选与审核读取",
    },
  };
}
