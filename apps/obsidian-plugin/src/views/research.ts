import type {
  Research,
  ResearchBrief,
  ResearchSnapshot,
  ResearchCoverage,
  ResearchChapter,
  ResearchReport,
} from "@kb/contracts";
import { Connection } from "../connection";
type Detail = Research & {
  snapshot: ResearchSnapshot | null;
  coverage: ResearchCoverage[];
  chapters: ResearchChapter[];
  reports: { id: string; version: number; snapshotId: string }[];
  usage: { calls: number; actual: number; reserved: number };
};
const el = <K extends keyof HTMLElementTagNameMap>(tag: K, text = "") => {
  const n = document.createElement(tag);
  n.textContent = text;
  return n;
};
export function renderResearch(root: HTMLElement, connection: Connection) {
  root.className = "kb-research";
  root.append(
    el("h2", "08 / 课题研究与报告"),
    el(
      "p",
      "先确认问题与范围，再固定证据、逐章整理。报告先停在候选，保存和提升沿用审核流程。",
    ),
  );
  const field = (
    label: string,
    value = "",
    multiline = false,
    parent: HTMLElement = root,
  ) => {
    const l = el("label", label),
      input = multiline ? el("textarea") : el("input");
    input.setAttribute("aria-label", label);
    input.value = value;
    l.append(input);
    parent.append(l);
    return input;
  };
  const select = (
    label: string,
    items: [string, string][],
    parent: HTMLElement = root,
  ) => {
    const l = el("label", label),
      s = el("select");
    s.setAttribute("aria-label", label);
    for (const [value, text] of items) {
      const o = el("option", text);
      o.value = value;
      s.append(o);
    }
    l.append(s);
    parent.append(l);
    return s;
  };
  const topic = field("研究课题"),
    audience = field("目标读者"),
    outputType = select("报告类型", [
      ["overview", "学习概览"],
      ["comparison", "版本比较"],
      ["project", "具体项目"],
    ]);
  const questions = field("必答问题（每行一个，可修改建议）", "", true);
  const types = field(
    "必要证据类型（逗号分隔，与来源范围中的 sourceType 对应）",
    "documentation",
  );
  const version = field("软件版本（概览可留空）"),
    channel = field("分发范围（如普通包、预览包）"),
    stage = field("运行阶段（如开发、生产）");
  const time = select("时间意图", [
      ["current", "截至库内资料的当前状态"],
      ["version", "指定软件版本"],
      ["evolution", "版本演进"],
      ["historical", "历史时点：当时已知什么"],
    ]),
    cutoff = field("历史截止时间（带时区，如 2025-01-01T00:00:00Z）");
  const project = field("项目依据 Evidence ID（具体项目必填，逗号分隔）");
  const mode = select("研究来源", [
    ["library_only", "仅使用库内资料"],
    ["fill_gaps", "允许从确认范围手动补充缺口"],
  ]);
  const hosts = field("补采允许域名（逗号分隔）"),
    paths = field("补采允许路径（逗号分隔）", "/");
  const cost = field("根费用上限（微美元；无模型填 0）", "0"),
    calls = field("模型调用上限", "0"),
    materials = field("材料上限", "10");
  const route = select("章节生成方式", [["", "整理完整原文，不调用模型"]]);
  const status = el("p"),
    draftBox = el("div"),
    list = el("div"),
    detail = el("div"),
    reportBox = el("div");
  status.setAttribute("role", "status");
  let draftEpoch = 0;
  let busy = false,
    currentId: string | undefined,
    visibleReportId: string | undefined;
  const action = (
    label: string,
    parent: HTMLElement,
    fn: () => Promise<unknown> | void,
    cancel = false,
  ) => {
    const b = el("button", label);
    b.dataset.cancel = String(cancel);
    parent.append(b);
    b.onclick = () => {
      if (busy && !cancel) return;
      if (!cancel) {
        busy = true;
        for (const n of root.querySelectorAll("button"))
          if (n.dataset.cancel !== "true") n.disabled = true;
      }
      status.textContent = "处理中…";
      Promise.resolve()
        .then(fn)
        .catch((e: unknown) => {
          status.textContent = `未完成：${e instanceof Error ? e.message : "请求失败"}。已生成章节与费用记录保留，可重新读取研究。`;
        })
        .finally(() => {
          if (!cancel) {
            busy = false;
            for (const n of root.querySelectorAll("button"))
              n.disabled =
                n.dataset.confirmation === "true" &&
                !n.parentElement?.querySelector<HTMLInputElement>(
                  'input[type="checkbox"]',
                )?.checked;
          }
        });
    };
    return b;
  };
  const confirmButton = (
    label: string,
    parent: HTMLElement,
    fn: () => Promise<unknown>,
  ) => {
    const box = el("div"),
      check = el("input"),
      l = el("label", "我已核对这份固定清单");
    check.type = "checkbox";
    check.setAttribute("aria-label", label + "确认");
    l.prepend(check);
    box.append(l);
    parent.append(box);
    const b = action(label, box, () => {
      if (!check.checked) throw new Error("请先核对并确认");
      return fn();
    });
    b.dataset.confirmation = "true";
    b.disabled = true;
    check.onchange = () => {
      b.disabled = busy || !check.checked;
    };
  };
  const values = (s: string) =>
    s
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  const scope = () => ({
    topic: null,
    version: version.value.trim() || null,
    channel: channel.value.trim() || null,
    stage: stage.value.trim() || null,
    configuration: null,
    modality: null,
    sourceType: null,
  });
  action("建议问题草案", root, () => {
    questions.value = [
      `${topic.value} 的适用版本和基本行为是什么？`,
      `${topic.value} 有哪些限制、例外和反证？`,
      `${topic.value} 对具体项目仍缺少哪些验证？`,
    ].join("\n");
    draftBox.replaceChildren();
    status.textContent = "请修改问题和检索范围，再预览课题清单。";
  });
  action("预览课题清单", root, async () => {
    const epoch = ++draftEpoch;
    draftBox.replaceChildren();
    const brief = {
      topic: topic.value,
      audience: audience.value,
      outputType: outputType.value,
      questions: questions.value
        .split("\n")
        .map((q) => q.trim())
        .filter(Boolean)
        .map((q) => ({
          id: crypto.randomUUID(),
          question: q,
          query: q,
          counterQuery: `${q} 限制 例外`,
          scope: scope(),
          requiredTypes: values(types.value),
        })),
      scopes: [scope()],
      timeIntent: time.value,
      cutoff: cutoff.value || null,
      mode: mode.value,
      projectEvidenceIds: values(project.value),
      acquisitionScope: {
        hosts: values(hosts.value),
        paths: values(paths.value),
      },
      limits: {
        cost: Number(cost.value),
        calls: Number(calls.value),
        discoveries: mode.value === "fill_gaps" ? 2 : 0,
        materials: Number(materials.value),
        chapters: 10,
      },
    };
    const d = await connection.request<{
      brief: ResearchBrief;
      ready: boolean;
      digest: string;
      missing: string[];
    }>("/v1/research/draft", "POST", brief);
    if (epoch !== draftEpoch) {
      status.textContent = "输入已变化，请重新预览课题清单。";
      return;
    }
    draftBox.append(
      el("pre", JSON.stringify(d.brief, null, 2)),
      el("p", d.missing.join("；")),
    );
    if (d.ready)
      confirmButton("确认课题与根预算", draftBox, async () => {
        await connection.refresh();
        const r = await connection.request<Research>("/v1/research", "POST", {
          operationId: crypto.randomUUID(),
          brief: d.brief,
          digest: d.digest,
        });
        currentId = r.id;
        draftBox.replaceChildren();
        await refresh();
      });
    status.textContent = d.ready
      ? "清单可确认；确认后该研究范围固定。"
      : "请补齐缺少的字段。";
  });
  for (const input of [
    topic,
    audience,
    outputType,
    questions,
    types,
    version,
    channel,
    stage,
    time,
    cutoff,
    project,
    mode,
    hosts,
    paths,
    cost,
    calls,
    materials,
  ])
    input.addEventListener("input", () => {
      draftEpoch++;
      draftBox.replaceChildren();
    });
  action("读取研究记录", root, async () => {
    const rows =
      await connection.request<{ id: string; topic: string; state: string }[]>(
        "/v1/research",
      );
    list.replaceChildren();
    for (const r of rows)
      action(`${r.topic} · ${r.state}`, list, async () => {
        currentId = r.id;
        visibleReportId = undefined;
        reportBox.replaceChildren();
        await refresh();
      });
    status.textContent = `读取到 ${rows.length} 项研究。`;
  });
  action("读取研究模型路线", root, async () => {
    const options = await connection.request<{
      routes: { id: string; model: string }[];
    }>("/v1/research/options");
    route.replaceChildren(el("option", "整理完整原文，不调用模型"));
    route.options[0]!.value = "";
    for (const r of options.routes) {
      const o = el("option", r.model);
      o.value = r.id;
      route.append(o);
    }
    status.textContent = options.routes.length
      ? "仅列出已安装的受信路线，仍需预算与来源授权。"
      : "未配置真实模型，可使用原文整理。";
  });
  const showReport = async (id: string) => {
    const r = await connection.request<ResearchReport>(
      `/v1/research-reports/${id}`,
    );
    visibleReportId = id;
    reportBox.replaceChildren(
      el("h3", `报告候选 v${r.version}`),
      el(
        "p",
        `快照 ${r.snapshotId}；机械检查 ${r.checks.mechanical}；语义审阅 ${r.checks.semantic}`,
      ),
      el("pre", r.content),
    );
    action("送入待审核候选", reportBox, async () => {
      await connection.request(
        `/v1/research-reports/${r.id}/candidate`,
        "POST",
        {},
      );
      status.textContent =
        "已登记固定报告候选，尚未写文件。进入 07 / Wiki 候选与审核，先审核保存到候选区。";
    });
  };
  const refresh = async () => {
    if (!currentId) return;
    const r = await connection.request<Detail>(`/v1/research/${currentId}`);
    detail.replaceChildren(
      el("h3", r.brief.topic),
      el(
        "p",
        `状态：${r.state}；根作业：${r.rootId}；已结算 ${r.usage.actual}，待结算预占 ${r.usage.reserved} 微美元；调用 ${r.usage.calls}/${r.brief.limits.calls}`,
      ),
    );
    if (r.state === "active") {
      action("准备研究快照差异", detail, async () => {
        const s = await connection.request<ResearchSnapshot>(
            `/v1/research/${r.id}/snapshots`,
            "POST",
            {},
          ),
          box = el("div");
        detail.append(box);
        box.append(
          el("h4", "待确认的研究快照"),
          el(
            "p",
            `新增 ${s.added.length}，移除 ${s.removed.length}，需重新核验问题 ${s.affectedQuestions.length}。`,
          ),
          el(
            "pre",
            JSON.stringify(
              {
                id: s.id,
                added: s.added,
                removed: s.removed,
                affectedQuestions: s.affectedQuestions,
                questions: s.questions,
              },
              null,
              2,
            ),
          ),
        );
        for (const e of s.evidence) {
          const d = el("details");
          d.append(
            el("summary", e.title),
            el("pre", `${e.text}\n${JSON.stringify(e.profile)}`),
          );
          box.append(d);
        }
        confirmButton("确认推进研究快照", box, async () => {
          await connection.request(`/v1/research/${r.id}/advance`, "POST", {
            snapshotId: s.id,
            digest: s.digest,
          });
          reportBox.replaceChildren();
          visibleReportId = undefined;
          await refresh();
        });
      });
      action(
        "取消后续研究",
        detail,
        async () => {
          await connection.request(`/v1/research/${r.id}/cancel`, "POST", {});
          status.textContent =
            "已取消后续步骤；可重新读取已生成章节并冻结部分报告。";
          await refresh();
        },
        true,
      );
    }
    for (const q of r.brief.questions) {
      const row = el("details");
      row.open = true;
      row.append(el("summary", q.question));
      const c = r.coverage.find((c) => c.questionId === q.id);
      row.append(
        el("p", `覆盖：${c?.state ?? "unsearched"}`),
        el("pre", (c?.gaps ?? ["请先确认研究快照"]).join("\n")),
      );
      for (const ref of c?.evidence ?? []) {
        const e = r.snapshot!.evidence.find((e) => e.id === ref.id)!;
        const d = el("details");
        d.append(
          el(
            "summary",
            `${e.title} · ${ref.role}${ref.counterLead ? " · 反证检索线索" : ""}`,
          ),
          el(
            "pre",
            `${e.text}\n证据 ${e.id}\n条件 ${JSON.stringify(e.profile.scope)}`,
          ),
        );
        row.append(d);
      }
      const chapter = r.chapters.find((c) => c.questionId === q.id);
      if (chapter)
        row.append(el("pre", chapter.claims.map((c) => c.text).join("\n\n")));
      if (r.snapshot && r.state === "active") {
        action("生成本章候选", row, async () => {
          await connection.request(
            `/v1/research/${r.id}/chapters/${q.id}`,
            "POST",
            {
              operationId: crypto.randomUUID(),
              snapshotId: r.snapshot!.id,
              ...(route.value ? { routeId: route.value } : {}),
            },
          );
          await refresh();
          status.textContent = "章节已保存在账本，尚未写文件。";
        });
        const state = select(
            "人工覆盖判断",
            [
              ["partial", "部分覆盖"],
              ["supported", "足够支持"],
              ["conflict", "存在冲突"],
              ["unanswerable", "不可回答"],
            ],
            row,
          ),
          support = field("支持证据 ID（逗号分隔）", "", false, row),
          opposing = field("反证 ID（逗号分隔）", "", false, row),
          note = field("覆盖判断与条件说明", "", true, row),
          checked = el("input"),
          label = el("label", "已阅读反证检索结果并核对条件");
        checked.type = "checkbox";
        label.prepend(checked);
        row.append(label);
        action("保存人工覆盖判断", row, async () => {
          await connection.request(
            `/v1/research/${r.id}/coverage/${q.id}`,
            "POST",
            {
              snapshotId: r.snapshot!.id,
              assessment: {
                state: state.value,
                supportingIds: values(support.value),
                opposingIds: values(opposing.value),
                counterChecked: checked.checked,
                note: note.value,
              },
            },
          );
          await refresh();
        });
        if (r.brief.mode === "fill_gaps") {
          const entry = field("围绕此缺口补采的入口 URL", "", false, row);
          action("预览单页补采范围", row, async () => {
            const batch = await connection.request<{ id: string }>(
              `/v1/research/${r.id}/acquisition`,
              "POST",
              {
                operationId: crypto.randomUUID(),
                questionId: q.id,
                entry: entry.value,
                maxPages: 1,
              },
            );
            status.textContent = `补采预览 ${batch.id}。去 05 / 资料收录点击“查看历史批次”、解析并审核正式提交，再回来准备新快照。`;
          });
        }
      }
      detail.append(row);
    }
    if (r.snapshot)
      action("冻结报告候选", detail, async () => {
        const report = await connection.request<ResearchReport>(
          `/v1/research/${r.id}/reports`,
          "POST",
          {},
        );
        await showReport(report.id);
        status.textContent = "已冻结报告候选；未完成问题与语义待核验项已保留。";
      });
    for (const report of r.reports)
      action(`查看报告 v${report.version}`, detail, () =>
        showReport(report.id),
      );
  };
  root.append(status, draftBox, list, detail, reportBox);
  const timer = setInterval(() => {
    if (!root.isConnected) {
      clearInterval(timer);
      return;
    }
    const id = currentId,
      reportId = visibleReportId;
    if (id)
      void connection.request(`/v1/research/${id}`).catch(() => {
        if (currentId === id) {
          detail.replaceChildren(el("p", "权限或依据变化，请重新读取研究。"));
          reportBox.replaceChildren();
        }
      });
    if (reportId)
      void connection.request(`/v1/research-reports/${reportId}`).catch(() => {
        if (visibleReportId === reportId) {
          reportBox.replaceChildren(
            el("p", "报告依据权限或范围已变化，暂不可显示。"),
          );
          visibleReportId = undefined;
        }
      });
  }, 5000);
}
