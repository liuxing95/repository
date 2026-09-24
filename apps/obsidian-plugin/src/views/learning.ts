import type {
  LearningBaseline,
  LearningGoalInput,
  LearningSettings,
  ReviewSuggestion,
} from "@kb/contracts";
import type { resume } from "../../../service/src/learning/resume";
import type { evidenceView } from "../../../service/src/learning/evidence-view";
import { Connection } from "../connection";
const el = <K extends keyof HTMLElementTagNameMap>(tag: K, text = "") => {
  const n = document.createElement(tag);
  n.textContent = text;
  return n;
};
type Resume = ReturnType<typeof resume>;
type GoalDetail = {
  baseline: LearningBaseline;
  goal: { id: string; state: "active" | "paused" };
  units: (LearningGoalInput["units"][number] & {
    choice: { state: string; rank: number; reason: string };
  })[];
  progress: ReturnType<typeof evidenceView>[];
  suggestions: (ReviewSuggestion & { restricted: boolean })[];
};
export function renderLearning(root: HTMLElement, connection: Connection) {
  root.className = "kb-learning";
  root.append(
    el("h2", "09 / 学习、尝试与复习"),
    el(
      "p",
      "资料是参考库。只选择当前要做的单元，记录自己的解释、产物和遗留问题；任务完成不等于能力已验证。",
    ),
  );
  const field = (
    label: string,
    value = "",
    parent = root,
    multiline = false,
  ) => {
    const l = el("label", label),
      input = multiline ? el("textarea") : el("input");
    input.value = value;
    input.disabled = busy;
    input.setAttribute("aria-label", label);
    l.append(input);
    parent.append(l);
    return input;
  };
  const select = (
    label: string,
    options: [string, string][],
    parent: HTMLElement,
  ) => {
    const l = el("label", label),
      s = el("select");
    s.setAttribute("aria-label", label);
    s.disabled = busy;
    for (const [value, title] of options) {
      const o = el("option", title);
      o.value = value;
      s.append(o);
    }
    l.append(s);
    parent.append(l);
    return s;
  };
  const status = el("p"),
    form = el("div"),
    draftBox = el("div"),
    list = el("div"),
    detail = el("div"),
    activity = el("div");
  status.setAttribute("role", "status");
  root.append(status, form, draftBox, list, detail, activity);
  let busy = false,
    epoch = 0,
    current: GoalDetail | undefined,
    activeUnit: string | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  const action = (
    label: string,
    parent: HTMLElement,
    fn: () => Promise<unknown> | void,
  ) => {
    const button = el("button", label);
    button.disabled = busy;
    parent.append(button);
    button.onclick = () => {
      if (busy) return;
      busy = true;
      status.textContent = "处理中…";
      for (const b of root.querySelectorAll<
        | HTMLButtonElement
        | HTMLInputElement
        | HTMLSelectElement
        | HTMLTextAreaElement
      >("button,input,select,textarea"))
        b.disabled = true;
      Promise.resolve()
        .then(fn)
        .catch((e: unknown) => {
          status.textContent = `未完成：${e instanceof Error ? e.message : "请求失败"}`;
        })
        .finally(() => {
          busy = false;
          for (const b of root.querySelectorAll<
            | HTMLButtonElement
            | HTMLInputElement
            | HTMLSelectElement
            | HTMLTextAreaElement
          >("button,input,select,textarea"))
            b.disabled =
              b.dataset.confirm === "true" &&
              !draftBox.querySelector<HTMLInputElement>(
                'input[type="checkbox"]',
              )?.checked;
        });
    };
    return button;
  };
  const ability = field("希望能解释、验证或完成什么", "", form),
    version = field("学习目标版本", "", form),
    conditions = field("适用条件", "", form);
  const completion = field("可观察的完成证据", "", form),
    misconceptions = field("常见误区（每行一个）", "", form, true);
  const rowsBox = el("div");
  form.append(rowsBox);
  let base: LearningBaseline | undefined;
  const rows: {
    id: string;
    title: HTMLInputElement | HTMLTextAreaElement;
    necessary: HTMLInputElement | HTMLTextAreaElement;
    optional: HTMLInputElement | HTMLTextAreaElement;
    criteria: HTMLInputElement | HTMLTextAreaElement;
    prerequisites: HTMLInputElement | HTMLTextAreaElement;
    original?: LearningGoalInput["units"][number];
  }[] = [];
  const lines = (s: string) =>
    s
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);
  const ids = (s: string) => s.split(/[,\s]+/).filter(Boolean);
  const addUnit = (u?: LearningGoalInput["units"][number]) => {
    const box = el("fieldset"),
      number = rows.length + 1,
      id = u?.id ?? crypto.randomUUID();
    box.append(el("legend", `学习单元 ${number}`));
    rowsBox.append(box);
    box.append(el("small", `单元 ID：${id}`));
    rows.push({
      id,
      original: u,
      title: field(`单元 ${number} 标题`, u?.title ?? "", box),
      necessary: field(
        `单元 ${number} 必要 Evidence ID（逗号分隔）`,
        u?.necessary.join(",") ?? "",
        box,
      ),
      optional: field(
        `单元 ${number} 可选 Evidence ID`,
        u?.optional.join(",") ?? "",
        box,
      ),
      prerequisites: field(
        `单元 ${number} 先修建议 ID`,
        u?.prerequisites.join(",") ?? "",
        box,
      ),
      criteria: field(
        `单元 ${number} 叶子验收项（每行 描述|权重，可留空）`,
        u?.criteria.map((c) => `${c.description}|${c.weight}`).join("\n") ?? "",
        box,
        true,
      ),
    });
  };
  addUnit();
  const invalidateDraft = () => {
    epoch++;
    draftBox.replaceChildren();
  };
  form.addEventListener("input", invalidateDraft);
  action("增加一个必要单元", form, () => {
    invalidateDraft();
    addUnit();
  });
  action("新建另一目标", form, () => {
    base = undefined;
    ability.value = "";
    version.value = "";
    conditions.value = "";
    completion.value = "";
    misconceptions.value = "";
    rows.length = 0;
    rowsBox.replaceChildren();
    addUnit();
    invalidateDraft();
  });
  const input = (): LearningGoalInput => ({
    ability: ability.value,
    scope: {
      topic: null,
      version: version.value || null,
      configuration: conditions.value || null,
      channel: base?.input.scope.channel ?? null,
      stage: base?.input.scope.stage ?? null,
      modality: base?.input.scope.modality ?? null,
      sourceType: base?.input.scope.sourceType ?? null,
    },
    completionEvidence: completion.value,
    misconceptions: lines(misconceptions.value),
    units: rows.map((r) => ({
      id: r.id,
      title: r.title.value,
      necessary: ids(r.necessary.value),
      optional: ids(r.optional.value),
      prerequisites: ids(r.prerequisites.value),
      criteria: lines(r.criteria.value).map((s, i) => {
        const [description, weight] = s.split("|");
        return {
          id: r.original?.criteria[i]?.id ?? crypto.randomUUID(),
          description: description ?? "",
          weight: Number(weight ?? "1"),
        };
      }),
    })),
  });
  action("预览学习目标与固定基线", form, async () => {
    const requestEpoch = epoch,
      prior = base;
    const d = await connection.request<{
      ready: boolean;
      input: LearningGoalInput;
      digest: string;
      missing: string[];
    }>("/v1/learning/draft", "POST", input());
    if (requestEpoch !== epoch) {
      status.textContent = "表单已修改，请重新预览。";
      return;
    }
    draftBox.replaceChildren(
      el("pre", JSON.stringify(d.ready ? d.input : d.missing, null, 2)),
    );
    if (!d.ready) return;
    const check = el("input");
    check.type = "checkbox";
    check.disabled = busy;
    check.setAttribute("aria-label", "确认学习基线");
    const label = el("label", "我已核对能力、资料和固定叶子验收项");
    label.prepend(check);
    draftBox.append(label);
    const confirmationId = crypto.randomUUID();
    const button = action("确认学习基线", draftBox, async () => {
      if (!check.checked || requestEpoch !== epoch)
        throw new Error("请重新确认当前草案");
      const result = await connection.request<LearningBaseline>(
        "/v1/learning/goals",
        "POST",
        {
          operationId: confirmationId,
          input: d.input,
          digest: d.digest,
          ...(prior ? { goalId: prior.goalId, previousId: prior.id } : {}),
        },
      );
      draftBox.replaceChildren();
      await loadGoal(result.goalId);
      status.textContent = "学习基线已保存；单元先进入参考库，不创建任务。";
    });
    button.dataset.confirm = "true";
    button.disabled = true;
    check.onchange = () => {
      button.disabled = !check.checked || busy;
    };
  });
  const cfg = el("details");
  cfg.append(el("summary", "复习规则与容量（未配置时不猜测）"));
  root.append(cfg);
  const wip = field("同时进行任务上限", "", cfg),
    minutes = field("每日复习分钟上限", "", cfg),
    timezone = field("容量时区", "", cfg),
    interval = field("复习间隔天数", "", cfg),
    window = field("复习窗口天数", "", cfg),
    duration = field("单次复习预计分钟", "", cfg);
  const settingsNote = el("p");
  cfg.append(settingsNote);
  action("读取学习设置", cfg, async () => {
    const r = await connection.request<{
      settings: LearningSettings;
      taskAdapterEnabled: boolean;
    }>("/v1/learning/settings");
    wip.value = String(r.settings.capacity?.wip ?? "");
    minutes.value = String(r.settings.capacity?.dayMinutes ?? "");
    timezone.value = r.settings.capacity?.timezone ?? "";
    interval.value = String(r.settings.review?.intervalDays ?? "");
    window.value = String(r.settings.review?.windowDays ?? "");
    duration.value = String(r.settings.review?.minutes ?? "");
    settingsNote.textContent = r.taskAdapterEnabled
      ? "任务适配器已安装，创建时仍需完整容量快照。"
      : "TaskNotes / Today 尚未接入，当前只保留建议和学习记录。";
  });
  action("保存学习设置", cfg, async () => {
    await connection.request("/v1/learning/settings", "POST", {
      capacity:
        wip.value || minutes.value || timezone.value
          ? {
              wip: Number(wip.value),
              dayMinutes: Number(minutes.value),
              timezone: timezone.value,
            }
          : null,
      review:
        interval.value || window.value || duration.value
          ? {
              intervalDays: Number(interval.value),
              windowDays: Number(window.value),
              minutes: Number(duration.value),
            }
          : null,
    });
    status.textContent = "设置已保存，不自动创建任务。";
  });
  action("读取学习目标", root, async () => {
    const goals =
      await connection.request<{ id: string; ability: string }[]>(
        "/v1/learning/goals",
      );
    list.replaceChildren();
    for (const g of goals)
      action(`打开目标：${g.ability}`, list, () => loadGoal(g.id));
  });
  async function loadGoal(id: string) {
    const r = await connection.request<GoalDetail>(`/v1/learning/goals/${id}`);
    current = r;
    activeUnit = undefined;
    detail.replaceChildren();
    activity.replaceChildren();
    detail.append(
      el("h3", r.baseline.input.ability),
      el("p", `目标状态：${r.goal.state}；固定基线：${r.baseline.id}`),
    );
    action(
      r.goal.state === "active" ? "暂停学习目标" : "恢复学习目标",
      detail,
      async () => {
        await connection.request(`/v1/learning/goals/${id}/state`, "POST", {
          state: r.goal.state === "active" ? "paused" : "active",
        });
        await loadGoal(id);
      },
    );
    action("编辑为新范围基线", detail, () => {
      base = r.baseline;
      ability.value = base.input.ability;
      version.value = base.input.scope.version ?? "";
      conditions.value = base.input.scope.configuration ?? "";
      completion.value = base.input.completionEvidence;
      misconceptions.value = base.input.misconceptions.join("\n");
      rows.length = 0;
      rowsBox.replaceChildren();
      base.input.units.forEach(addUnit);
      invalidateDraft();
      status.textContent = "可以增加范围；已有叶子项和权重保留，旧基线不修改。";
    });
    for (const progress of r.progress)
      detail.append(
        el(
          "p",
          `${progress.baselineId === r.baseline.id ? "当前" : "历史"}基线 ${progress.scope.version ?? "未指定版本"}：${progress.totalWeight ? `证据通过权重 ${progress.passedWeight}/${progress.totalWeight}` : "无叶子验收项，不计算百分比"}；新增叶子项 ${progress.addedCriteria.length}，尝试 ${progress.attemptCount} 次。`,
        ),
      );
    detail.append(
      el(
        "p",
        "材料收录、任务执行、学习证据和知识审核分别查看；本页没有任务完成勾选。",
      ),
    );
    for (const u of [...r.units].sort(
      (a, b) => a.choice.rank - b.choice.rank,
    )) {
      const box = el("div");
      detail.append(box);
      box.append(el("h4", u.title));
      const state = select(
        `单元选择：${u.title}`,
        [
          ["reference", "参考库"],
          ["selected", "当前学习"],
          ["skipped", "跳过熟悉内容"],
          ["paused", "暂停"],
          ["cancelled", "取消（保留分母）"],
        ],
        box,
      );
      state.value = u.choice.state;
      const rank = field(`单元顺序：${u.title}`, String(u.choice.rank), box),
        reason = field(`选择说明：${u.title}`, u.choice.reason, box);
      action(`保存选择：${u.title}`, box, async () => {
        await connection.request(
          `/v1/learning/goals/${id}/units/${u.id}`,
          "POST",
          {
            state: state.value,
            rank: Number(rank.value),
            reason: reason.value,
          },
        );
        await loadGoal(id);
      });
      action(`继续学习：${u.title}`, box, () => loadUnit(id, u.id));
    }
    action("生成少量复习建议", detail, async () => {
      const result = await connection.request<{ reason: string }>(
        `/v1/learning/goals/${id}/reviews`,
        "POST",
      );
      await loadGoal(id);
      status.textContent = result.reason;
    });
    for (const s of r.suggestions) {
      const box = el("div");
      detail.append(box);
      if (s.restricted) {
        box.append(el("p", "复习关联资料不可读，暂不展示正文。"));
        continue;
      }
      box.append(
        el(
          "p",
          `${s.reason}｜${s.state}｜${s.minutes} 分钟｜${new Date(s.dueAt).toLocaleString()} — ${new Date(s.endAt).toLocaleString()}`,
        ),
      );
      const why = field("复习选择说明", "", box),
        until = field("延后至（带时区 ISO 时间）", "", box);
      for (const [state, label] of [
        ["skipped", "跳过建议"],
        ["paused", "暂停建议"],
        ["suggested", "恢复建议"],
        ["deferred", "延后建议"],
      ])
        action(label!, box, async () => {
          await connection.request(
            `/v1/learning/reviews/${s.id}/choice`,
            "POST",
            {
              state,
              reason: why.value,
              ...(state === "deferred"
                ? { dueAt: Date.parse(until.value) }
                : {}),
            },
          );
          await loadGoal(id);
        });
      action("确认创建复习任务", box, async () => {
        const result = await connection.request(
          `/v1/learning/reviews/${s.id}/task`,
          "POST",
        );
        await loadGoal(id);
        status.textContent = JSON.stringify(result);
      });
    }
    if (timer) clearInterval(timer);
    let checking = false;
    timer = setInterval(() => {
      if (!root.isConnected) {
        clearInterval(timer);
        return;
      }
      if (!current || checking || busy) return;
      checking = true;
      const goal = current.goal.id,
        unit = activeUnit;
      void connection
        .request<GoalDetail>(`/v1/learning/goals/${goal}`)
        .then(async () => {
          if (unit) {
            const r = await connection.request<Resume>(
              `/v1/learning/goals/${goal}/units/${unit}/resume`,
            );
            if (
              r.sources.some((s) => s.restricted) ||
              r.attempts.some((a) => a.restricted)
            ) {
              activity.replaceChildren(
                el(
                  "p",
                  "来源权限变化，已清空活动正文；重新继续学习可查看受限关联。",
                ),
              );
              activeUnit = undefined;
            }
          }
        })
        .catch(() => {
          detail.replaceChildren();
          activity.replaceChildren();
          current = undefined;
          activeUnit = undefined;
        })
        .finally(() => {
          checking = false;
        });
    }, 5000);
  }
  async function loadUnit(goalId: string, unitId: string) {
    const r = await connection.request<Resume>(
      `/v1/learning/goals/${goalId}/units/${unitId}/resume`,
    );
    activeUnit = unitId;
    activity.replaceChildren();
    const context = el("div");
    context.className = "kb-learning-context";
    activity.append(context);
    context.append(
      el("h3", r.unit.title),
      el("p", r.message),
      el(
        "p",
        `当前版本：${r.baseline.input.scope.version ?? "未指定"}；验收：${r.unit.criteria.map((c) => c.description).join("；") || "仅记录活动"}`,
      ),
    );
    for (const s of r.sources) {
      context.append(
        el(
          "p",
          `${s.necessary ? "必要资料" : "可选参考"} ${s.id}：${s.message}`,
        ),
      );
      if (!s.restricted) context.append(el("pre", s.evidence.text));
    }
    for (const a of r.attempts)
      context.append(
        el(
          "pre",
          a.restricted
            ? `${new Date(a.createdAt).toLocaleString()} ${a.kind}：${a.message}`
            : `实际尝试 ${new Date(a.createdAt).toLocaleString()}｜提示层级 ${a.hintLevel}\n当次目标版本：${a.scope.version ?? "未指定"}；条件：${a.scope.configuration ?? "未指定"}\n${a.expression}\n用户自报：${a.selfReport || "未填写"}\n产物：${a.artifacts.join("；") || "未提供"}\n遗留：${a.unresolved.join("；") || "未填写"}\n${a.evaluations.map((e) => `${{ human: "人工评价", program: "程序检查", model: "模型评分（不计通过）" }[e.origin]}：${{ passed: "通过", failed: "未通过", uncertain: "尚未验证" }[e.outcome]}；依据：${e.rationale}；规则：${e.ruleVersion}${e.model ? `；模型：${e.model}；提示版本：${e.promptVersion}` : ""}`).join("\n") || "尚无独立评价"}\n记录 ID：${a.id}；所属基线：${a.baselineId}`,
        ),
      );
    const kind = select(
      "本次活动",
      [
        ["explain", "解释"],
        ["example", "示例"],
        ["recall", "回忆"],
        ["variation", "变式验证"],
        ["correction", "纠错"],
      ],
      activity,
    );
    const expression = field("我的实际表达", "", activity, true),
      hint = select(
        "已使用提示层级",
        [
          ["0", "0 无提示"],
          ["1", "1 方向提示"],
          ["2", "2 关键步骤"],
          ["3", "3 完整示例"],
        ],
        activity,
      ),
      refs = field(
        "本次引用 Evidence ID",
        r.unit.necessary.join(","),
        activity,
      ),
      artifacts = field(
        "实际产物引用（每行一个，不自动执行）",
        "",
        activity,
        true,
      ),
      selfReport = field("我报告的结果", "", activity),
      unresolved = field("遗留问题（每行一个）", "", activity, true);
    const operationId = crypto.randomUUID();
    action("保存我的实际尝试", activity, async () => {
      await connection.request(
        `/v1/learning/goals/${goalId}/attempts`,
        "POST",
        {
          operationId,
          attempt: {
            baselineId: r.baseline.id,
            unitId,
            kind: kind.value,
            expression: expression.value,
            hintLevel: Number(hint.value),
            evidenceIds: ids(refs.value),
            artifacts: lines(artifacts.value),
            selfReport: selfReport.value,
            unresolved: lines(unresolved.value),
          },
        },
      );
      await loadUnit(goalId, unitId);
      status.textContent = "尝试已保存，自报不自动计为验收通过。";
    });
    const latest = r.latestAttempt;
    if (latest && !latest.restricted)
      for (const c of r.baseline.id === latest.baselineId
        ? r.unit.criteria
        : []) {
        const box = el("div");
        activity.append(box);
        box.append(el("h4", `人工核对：${c.description}`));
        const outcome = select(
            "人工核对结果",
            [
              ["uncertain", "尚未验证"],
              ["passed", "已核对通过"],
              ["failed", "未通过"],
            ],
            box,
          ),
          rationale = field("人工核对依据", "", box),
          rule = field("验收规则版本", "", box);
        const evaluationId = crypto.randomUUID();
        action("保存人工评价", box, async () => {
          await connection.request(
            `/v1/learning/attempts/${latest.id}/evaluations`,
            "POST",
            {
              operationId: evaluationId,
              evaluation: {
                criterionId: c.id,
                outcome: outcome.value,
                rationale: rationale.value,
                ruleVersion: rule.value,
              },
            },
          );
          await loadUnit(goalId, unitId);
        });
      }
    if (r.sources.some((s) => !s.restricted && s.supplementCandidate)) {
      const reason = field("新版本实质差异与补学理由", "", activity);
      action("确认补学建议", activity, async () => {
        await connection.request(
          `/v1/learning/goals/${goalId}/supplement`,
          "POST",
          { unitId, reason: reason.value },
        );
        await loadGoal(goalId);
      });
    }
    for (const link of r.taskLinks) {
      activity.append(
        el("p", `同一任务 ${link.taskId}｜创建状态 ${link.state}`),
      );
      if (["reserved", "unknown"].includes(link.state))
        action("核对任务创建结果", activity, async () => {
          await connection.request(
            `/v1/learning/task-intents/${link.id}/reconcile`,
            "POST",
          );
          await loadUnit(goalId, unitId);
        });
    }
  }
  return {
    resume: async (goalId: string, unitId: string) => {
      await loadGoal(goalId);
      await loadUnit(goalId, unitId);
      root.scrollIntoView({ block: "start" });
    },
  };
}
