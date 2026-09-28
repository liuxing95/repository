import type { AnswerResult, EvidenceRead, SearchResult, WritingDraft } from "@kb/contracts";
import { Connection } from "../connection";
import { OperationState } from "../ui/operation-state";
const node = <K extends keyof HTMLElementTagNameMap>(tag: K, text?: string) => {
  const n = document.createElement(tag);
  if (text) n.textContent = text;
  return n;
};
export function renderSearch(
  root: HTMLElement,
  connection: Connection,
  draft: { query: string; version: string; collection: string },
) {
  root.className = "kb-search";
  root.append(
    node("h3", "06 / 证据检索与问答"),
    node(
      "p",
      "搜索已正式提交的资料。没有模型密钥也可查看固定原文；整理证据不会自动写入 Wiki。",
    ),
  );
  const status = node("div");
  const state = new OperationState(status);
  root.append(status);
  const field = (key: keyof typeof draft, label: string) => {
    const wrap = node("label", label);
    const input = node("input");
    input.setAttribute("aria-label", label);
    input.value = draft[key];
    input.addEventListener("input", () => {
      draft[key] = input.value;
    });
    wrap.append(input);
    root.append(wrap);
    return input;
  };
  field("query", "问题、中文短词或代码符号");
  field("version", "软件版本（留空不限）");
  field("collection", "集合（留空不限）");
  const reviewLabel = node("label", "审核状态");
  const review = node("select");
  for (const [value, text] of [
    ["", "全部"],
    ["unreviewed", "未审核"],
    ["reviewed", "已审核"],
  ]) {
    const o = node("option", text);
    o.value = value!;
    review.append(o);
  }
  reviewLabel.append(review);
  root.append(reviewLabel);
  const sourceLabel = node("label", "来源类型（留空不限）");
  const sourceType = node("select");
  for (const [value, text] of [
    ["", "全部"],
    ["text", "文本"],
    ["html", "本地 HTML"],
    ["web", "网页"],
    ["collection", "文档集合"],
    ["repository", "代码"],
    ["pdf", "PDF"],
  ]) {
    const option = node("option", text);
    option.value = value!;
    sourceType.append(option);
  }
  sourceLabel.append(sourceType);
  root.append(sourceLabel);
  const historicalLabel = node(
    "label",
    "历史时点（ISO 时间，可选；排除公开时间未知的资料）",
  );
  const historical = node("input");
  historical.placeholder = "2026-09-01T00:00:00Z";
  historicalLabel.append(historical);
  root.append(historicalLabel);
  const output = node("div");
  const detail = node("div");
  let result: SearchResult | undefined;
  const selected = new Set<string>();
  let inputRevision = 0;
  for (const input of root.querySelectorAll("input, select"))
    input.addEventListener("input", () => {
      inputRevision++;
      result = undefined;
      selected.clear();
      output.replaceChildren();
      detail.replaceChildren(node("p", "检索条件已变化，请重新搜索。"));
    });
  const action = (name: string, fn: () => Promise<unknown>, parent = root) => {
    const button = node("button", name);
    button.type = "button";
    button.addEventListener("click", () => {
      void state.run(fn).catch(() => { /* Keep the selection and user input for correction. */ });
    });
    parent.append(button);
  };
  const showEvidence = (e: EvidenceRead) => {
    detail.replaceChildren(
      node("h4", e.title),
      node("p", `来源修订 ${e.revisionId} · 解析 ${e.parseId}`),
      node(
        "p",
        `适用范围：${JSON.stringify(e.profile.scope)} · 来源家族 ${e.familyId}`,
      ),
      node(
        "p",
        `抓取：${new Date(e.fetchedAt).toISOString()} · 声明公开：${e.declaredPublishedAt ?? "未知"} · 确认公开：${e.confirmedPublishedAt ?? "未知"}`,
      ),
      node("p", `UTF-16 [${e.start}, ${e.end}) · ${JSON.stringify(e.locator)}`),
      node("pre", e.text),
      node("h4", "相邻上下文"),
      node("pre", e.context),
      node("p", e.gaps.join("；") || "文本可用，语义仍需核对。"),
    );
  };
  action("搜索原文", async () => {
    const revision = inputRevision;
    detail.replaceChildren();
    output.replaceChildren();
    result = undefined;
    selected.clear();
    const found = await connection.request<SearchResult>("/v1/search", "POST", {
      query: draft.query,
      scope: {
        version: draft.version || null,
        sourceType: sourceType.value || null,
      },
      ...(historical.value ? { asOf: historical.value } : {}),
      ...(draft.collection ? { collection: draft.collection } : {}),
      ...(review.value ? { review: review.value } : {}),
      limit: 30,
    });
    if (revision !== inputRevision) return;
    result = found;
    output.append(
      node(
        "p",
        `问题：${result.snapshot.input.query} · 快照 ${result.snapshot.id} · 索引 ${result.index.state === "complete" ? "已完成" : "部分完成"} · ${result.index.blocks} 个检索片段 · ${result.hits.length} 条证据 / ${new Set(result.hits.map((hit) => hit.familyId)).size} 个来源家族`,
      ),
    );
    for (const warning of result.warnings) output.append(node("p", warning));
    if (!result.hits.length)
      output.append(
        node(
          "p",
          "本次未命中；请检查范围、索引状态及资料覆盖，不能据此断言不存在。",
        ),
      );
    for (const hit of result.hits) {
      const row = node("details");
      row.append(
        node(
          "summary",
          `${hit.title} · [${hit.start}, ${hit.end}) · ${hit.profile.scope.version ?? "版本未知"} · ${hit.profile.scope.sourceType ?? "类型未知"} · ${hit.profile.review}`,
        ),
        node("pre", hit.text),
        node("p", hit.gaps.join("；")),
      );
      const choose = node("label", "用于本机写作"), box = node("input");
      box.type = "checkbox";
      box.setAttribute("aria-label", `写作证据 ${hit.id}`);
      box.checked = selected.size < 5 && ["original", "mirror", "reprint"].includes(hit.profile.kind);
      if (box.checked) selected.add(hit.id);
      box.onchange = () => { if (box.checked) selected.add(hit.id); else selected.delete(hit.id); };
      choose.prepend(box);
      choose.onclick = (event) => event.stopPropagation();
      row.querySelector("summary")!.prepend(choose);
      action(
        "回读固定原文",
        async () =>
          showEvidence(
            await connection.request<EvidenceRead>(`/v1/evidence/${hit.id}`),
          ),
        row,
      );
      output.append(row);
    }
  });
  action("重建本地索引", async () => {
    const report = await connection.request("/v1/search/rebuild", "POST");
    detail.replaceChildren(node("pre", JSON.stringify(report, null, 2)));
  });
  const answer = (routeId?: string) => async () => {
    if (!result)
      throw {
        message: "先搜索并取得查询快照。",
        nextStep: "输入问题后点击搜索原文。",
      };
    const answer = await connection.request<AnswerResult>(
      "/v1/answers",
      "POST",
      {
        snapshotId: result.snapshot.id,
        operationId: crypto.randomUUID(),
        ...(routeId ? { routeId } : {}),
      },
    );
    detail.replaceChildren(
      node(
        "h4",
        answer.status === "conflict"
          ? "证据冲突"
          : answer.status === "supported"
            ? answer.mode === "model"
              ? "已找到引用，结论待核对"
              : "有原文支持的证据"
            : "证据不足",
      ),
      node(
        "p",
        `${answer.mode === "extractive" ? "原文整理，未生成综合结论" : "模型结果"} · ${answer.familyCount} 个来源家族 · 语义尚未人工审核`,
      ),
    );
    for (const claim of answer.claims) {
      detail.append(
        node("p", `${claim.kind} · ${JSON.stringify(claim.scope)}`),
        node("pre", claim.text),
      );
      for (const id of claim.evidenceIds)
        action(
          "核对这条引用",
          async () =>
            showEvidence(
              await connection.request<EvidenceRead>(`/v1/evidence/${id}`),
            ),
          detail,
        );
    }
    for (const gap of answer.gaps) detail.append(node("p", gap));
    action(
      "保存为待审核候选",
      async () => {
        await connection.request(`/v1/answers/${answer.id}/candidate`, "POST");
        detail.replaceChildren(
          node("p", "已保存固定候选；等待场景 04 审核，不会直接写入 Wiki。"),
        );
      },
      detail,
    );
  };
  action("整理本次原文证据", answer());
  const writing = node("fieldset");
  writing.append(node("legend", "本机写作"), node("p", "先限定集合并搜索，再勾选最多 8 条原文。检索词用于找资料，写作要求用于组织正文；生成不会覆盖已有草稿。"));
  const titleLabel = node("label", "生成草稿标题"), writingTitle = node("input");
  writingTitle.setAttribute("aria-label", "生成草稿标题"); titleLabel.append(writingTitle);
  const instructionLabel = node("label", "写作要求"), instruction = node("textarea");
  instruction.setAttribute("aria-label", "写作要求");
  instruction.value = "根据选定资料写一篇约 500 字的简介，介绍定位、适合的读者、核心内容与入门顺序。用自然段叙述；没有依据的内容列为缺口。";
  instructionLabel.append(instruction); writing.append(titleLabel, instructionLabel); root.append(writing);
  const writingSelection = () => {
    if (!result || selected.size < 1 || selected.size > 8)
      throw { code: "VALIDATION", message: "请先搜索并勾选 1—8 条原文证据。" };
    return { snapshotId: result.snapshot.id, evidenceIds: [...selected] };
  };
  action("授权选定资料用于本机模型", async () => {
    const input = writingSelection(), searchInput = result!.snapshot.input, revision = inputRevision;
    result = undefined;
    await connection.refresh();
    await connection.request("/v1/answers/local-setup", "POST", input);
    await connection.refresh();
    const found = await connection.request<SearchResult>("/v1/search", "POST", { ...searchInput, snapshotId: undefined });
    if (revision !== inputRevision) return;
    result = found;
    detail.replaceChildren(node("p", "已配置零费用本机路线，并仅授权选定证据所属来源。其他模型路线和来源权限保留。现在可以生成草稿。"));
  }, writing);
  action("本机生成可编辑草稿", async () => {
    const selection = writingSelection(), title = writingTitle.value.trim(), writingInstruction = instruction.value.trim();
    if (!title || !writingInstruction) throw { code: "VALIDATION", message: "请填写草稿标题和写作要求。" };
    const options = await connection.request<{ routes: { id: string; localOnly?: boolean }[] }>("/v1/answers/options");
    if (!options.routes.some((r) => r.id === "local-ollama" && r.localOnly))
      throw { code: "UNAVAILABLE", message: "本机模型未启用，点击“查看模型状态”查看启动说明。" };
    detail.replaceChildren(node("p", "本机模型正在生成，最多等待 3 分钟。请勿重复提交；生成结果会保存为独立草稿。"));
    const saved = await connection.request<WritingDraft>("/v1/writing", "POST", {
      ...selection, title, routeId: "local-ollama", operationId: crypto.randomUUID(), writingInstruction,
    });
    const answer = saved.answer;
    detail.replaceChildren(node("h4", saved.title), node("p", `已保存草稿 ${saved.id}，模型 ${answer.model}。到下方“07 / 正文草稿”读取并编辑，核对引用后再提交审核。`),
      ...saved.paragraphs.map((p) => node("p", p.text)), ...answer.gaps.map((gap) => node("p", gap)));
  }, writing);
  action("查看模型状态", async () => {
    const options = await connection.request<{
      message: string;
      routes: { id: string; model: string }[];
    }>("/v1/answers/options");
    detail.replaceChildren(node("p", options.message));
    for (const route of options.routes)
      action(`使用 ${route.model} 回答`, answer(route.id), detail);
  });
  action("检查知识与引用", async () => {
    const report = await connection.request("/v1/knowledge-health");
    detail.replaceChildren(node("pre", JSON.stringify(report, null, 2)));
  });
  root.append(output, detail);
  // Visible material expires quickly and is cleared on revocation/session loss, including idle views.
  const recheck = window.setInterval(() => {
    if (!root.isConnected) {
      window.clearInterval(recheck);
      return;
    }
    const checking = result;
    if (checking)
      void connection
        .request("/v1/search", "POST", {
          ...checking.snapshot.input,
          snapshotId: checking.snapshot.id,
        })
        .catch(() => {
          if (result?.snapshot.id !== checking.snapshot.id) return;
          result = undefined;
          output.replaceChildren();
          detail.replaceChildren(
            node("p", "来源或会话权限已变化，请重新搜索。"),
          );
        });
  }, 5000);
}
