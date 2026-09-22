import type { WikiChangeSet, WikiPage } from "@kb/contracts";
import type { Connection } from "../connection";
import { applyChange, type WriterHost } from "../writer/apply";
const el = <K extends keyof HTMLElementTagNameMap>(tag: K, text = "") => {
  const e = document.createElement(tag);
  e.textContent = text;
  return e;
};
// Show changed lines with bounded context; full before/after bytes remain below for approval.
function lineDiff(before: string | null, after: string) {
  const a = before?.split("\n") ?? [],
    b = after.split("\n");
  let start = 0,
    end = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  while (
    end < a.length - start &&
    end < b.length - start &&
    a[a.length - 1 - end] === b[b.length - 1 - end]
  )
    end++;
  return [
    ...a.slice(Math.max(0, start - 2), start).map((x) => `  ${x}`),
    ...a.slice(start, a.length - end).map((x) => `- ${x}`),
    ...b.slice(start, b.length - end).map((x) => `+ ${x}`),
    ...b.slice(b.length - end, b.length - end + 2).map((x) => `  ${x}`),
  ].join("\n");
}
export async function syncWikiObservations(
  connection: Connection,
  host: WriterHost,
) {
  const pages = await connection.request<WikiPage[]>("/v1/wiki/pages");
  for (const page of pages) {
    // Open editor buffers must never be treated as a stable disk observation.
    if (host.isEditing(page.path)) continue;
    const { guardPath } = await import("../writer/guard");
    await guardPath(host.root, page.path);
    const content = await host.read(page.path);
    if (host.isEditing(page.path)) continue;
    await connection.request("/v1/wiki/observations", "POST", {
      pageId: page.pageId,
      content,
    });
  }
}
export function renderReview(
  root: HTMLElement,
  connection: Connection,
  host: WriterHost,
) {
  root.className = "kb-ingestion kb-review";
  root.append(
    el("h2", "07 / Wiki 候选与审核"),
    el(
      "p",
      "候选区保存和 Wiki 提升分别审核。文件应用、业务提交、索引就绪是不同状态。",
    ),
  );
  const status = el("p"),
    list = el("div"),
    detail = el("div");
  status.className = "kb-review-status";
  detail.className = "kb-review-detail";
  const field = (name: string, parent: HTMLElement = root) => {
    const label = el("label", name),
      input = el("input");
    input.setAttribute("aria-label", name);
    label.append(input);
    parent.append(label);
    return input;
  };
  const title = field("Wiki 页面标题");
  const kind = el("select");
  kind.setAttribute("aria-label", "Wiki 页面类型");
  for (const [value, text] of [
    ["concept", "概念"],
    ["system", "系统"],
    ["comparison", "比较"],
    ["decision", "决定"],
  ]) {
    const o = el("option", text);
    o.value = value!;
    kind.append(o);
  }
  root.append(kind);
  const decision = field("决定页：本人明确确认的决定");
  let busy = false;
  const action = (
    name: string,
    parent: HTMLElement,
    fn: () => Promise<unknown>,
  ) => {
    const b = el("button", name);
    b.type = "button";
    b.disabled = busy;
    b.onclick = () => {
      if (busy) return;
      busy = true;
      for (const button of root.querySelectorAll("button"))
        button.disabled = true;
      status.textContent = "处理中…";
      void fn()
        .then(() => {
          status.textContent = "操作完成。";
        })
        .catch((e: unknown) => {
          const err = e as { code?: string; message?: string };
          status.textContent = `提交未完成：${err.code ?? err.message ?? "请求失败"}。保留人工内容，核对后恢复。`;
        })
        .finally(() => {
          busy = false;
          for (const button of root.querySelectorAll("button"))
            button.disabled =
              button.dataset.confirmation === "true" &&
              !detail.querySelector<HTMLInputElement>('input[type="checkbox"]')
                ?.checked;
        });
    };
    parent.append(b);
    return b;
  };
  let visibleId: string | undefined;
  let visiblePages: string[] = [];
  const show = (c: WikiChangeSet) => {
    visibleId = c.id;
    detail.replaceChildren(
      el("h3", c.purpose),
      el(
        "p",
        `状态：${c.state}；已回执 ${c.receipts.length}/${c.patches.length}；摘要 ${c.digest}`,
      ),
    );
    detail.append(
      el(
        "p",
        c.destination === "candidate"
          ? "预计影响：仅保存候选投影，不进入正式知识检索。"
          : `预计影响：完整提交后切换 ${c.patches.length} 个页面的当前版本；保留历史，重新核对 ${c.evidence.length} 条原始证据。`,
      ),
    );
    detail.dataset.changeId = c.id;
    detail.dataset.state = c.state;
    if (c.state === "committed")
      detail.append(
        el(
          "p",
          c.destination === "wiki"
            ? "业务提交完成，正式 Wiki 索引就绪。"
            : "候选区提交完成；可创建新的 Wiki 提升提案。",
        ),
      );
    if (
      c.state === "committed" &&
      c.destination === "wiki" &&
      c.patches.every((p) => p.beforeContent !== null)
    )
      action("生成反向提案（重新审核）", detail, async () => {
        await connection.refresh();
        await syncWikiObservations(connection, host);
        show(
          await connection.request<WikiChangeSet>(
            `/v1/wiki/changes/${c.id}/reverse`,
            "POST",
            { operationId: crypto.randomUUID() },
          ),
        );
      });
    for (const patch of c.patches) {
      const block = el("details");
      block.open = true;
      block.append(
        el(
          "summary",
          `${patch.beforeHash === null ? "新建" : "更新"}：${patch.path}`,
        ),
      );
      block.append(
        el(
          "p",
          `beforeHash: ${patch.beforeHash ?? "不存在"} → afterHash: ${patch.afterHash}`,
        ),
      );
      block.append(
        el("h4", "逐行差异（- 删除，+ 新增）"),
        el("pre", lineDiff(patch.beforeContent, patch.content)),
        el("h4", "修改前（完整内容）"),
        el("pre", patch.beforeContent ?? "文件不存在"),
        el("h4", "修改后（完整内容）"),
        el("pre", patch.content),
      );
      detail.append(block);
    }
    detail.append(
      el(
        "p",
        `依据：${c.evidence.map((e) => e.id).join(", ") || "无来源证据"}`,
      ),
      el("p", c.deferred.join("；")),
    );
    for (const e of c.evidence) {
      const d = el("details");
      d.append(
        el("summary", `原文依据：${e.title}`),
        el(
          "pre",
          `${e.text}\n\n条件：${JSON.stringify(e.profile.scope)}\n定位：${JSON.stringify(e.locator)}\n缺口：${e.gaps.join("；")}`,
        ),
      );
      detail.append(d);
    }
    if (["prepared", "approved"].includes(c.state)) {
      const label = el(
          "label",
          "我已核对所有文件、条件与证据，批准这份固定变更",
        ),
        confirm = el("input");
      confirm.type = "checkbox";
      confirm.setAttribute("aria-label", "确认本次固定变更");
      label.prepend(confirm);
      detail.append(label);
      const approve = action("批准并应用本次变更", detail, async () => {
        if (!confirm.checked) throw new Error("请先核对并勾选确认");
        await connection.refresh();
        const approved = await connection.request<WikiChangeSet>(
          `/v1/wiki/changes/${c.id}/approve`,
          "POST",
          { digest: c.digest },
        );
        await applyChange(host, connection, approved, "/v1/wiki/changes");
        show(
          await connection.request<WikiChangeSet>(`/v1/wiki/changes/${c.id}`),
        );
      });
      approve.dataset.confirmation = "true";
      approve.disabled = true;
      confirm.onchange = () => {
        approve.disabled = busy || !confirm.checked;
      };
      const reason = field("拒绝原因", detail);
      action("拒绝本次提案", detail, async () =>
        show(
          await connection.request<WikiChangeSet>(
            `/v1/wiki/changes/${c.id}/reject`,
            "POST",
            { digest: c.digest, reason: reason.value },
          ),
        ),
      );
    }
  };
  const propose = async (
    candidateId: string,
    destination: "wiki" | "candidate",
  ) => {
    visibleId = undefined;
    detail.replaceChildren(el("p", "正在生成新的固定提案…"));
    await connection.refresh();
    await syncWikiObservations(connection, host);
    show(
      await connection.request<WikiChangeSet>("/v1/wiki/changes", "POST", {
        operationId: crypto.randomUUID(),
        candidateId,
        destination,
        title: title.value,
        kind: kind.value,
        ...(decision.value ? { confirmedDecision: decision.value } : {}),
      }),
    );
  };
  action("读取待审核候选", root, async () => {
    const candidates = await connection.request<
      { id: string; title: string; status: string }[]
    >("/v1/wiki/candidates");
    list.replaceChildren();
    if (!candidates.length)
      list.append(el("p", "暂无可用候选；先在检索区整理原文并保存候选。"));
    for (const c of candidates) {
      const row = el("div");
      row.append(el("p", `${c.id} · ${c.title} · ${c.status}`));
      action("审核保存到候选区", row, () => propose(c.id, "candidate"));
      action("审核提升为 Wiki", row, () => propose(c.id, "wiki"));
      list.append(row);
    }
  });
  action("读取提案与恢复记录", root, async () => {
    const changes =
      await connection.request<
        { id: string; purpose: string; state: string }[]
      >("/v1/wiki/changes");
    list.replaceChildren();
    for (const c of changes)
      action(`${c.purpose} · ${c.state}`, list, async () =>
        show(
          await connection.request<WikiChangeSet>(`/v1/wiki/changes/${c.id}`),
        ),
      );
  });
  const query = field("搜索正式 Wiki");
  action("检索已提交 Wiki", root, async () => {
    const pages = await connection.request<WikiPage[]>(
      "/v1/wiki/search",
      "POST",
      { query: query.value },
    );
    list.replaceChildren();
    visiblePages = pages.map((p) => p.revisionId);
    for (const page of pages) {
      const d = el("details");
      d.append(
        el("summary", `${page.title} · ${page.review} · ${page.revisionId}`),
        el("pre", page.content),
      );
      list.append(d);
    }
    if (!pages.length)
      list.append(
        el("p", "没有匹配的已提交 Wiki。候选和部分应用文件不参与正式检索。"),
      );
  });
  action("扫描人工修改与影响", root, async () => {
    await connection.refresh();
    await syncWikiObservations(connection, host);
    list.replaceChildren(
      el(
        "pre",
        JSON.stringify(await connection.request("/v1/wiki/impact"), null, 2),
      ),
    );
  });
  root.append(status, list, detail);
  const timer = setInterval(() => {
    if (!root.isConnected) {
      clearInterval(timer);
      return;
    }
    const pages = visiblePages;
    if (pages.length)
      void Promise.all(
        pages.map((id) => connection.request(`/v1/wiki/pages/${id}`)),
      ).catch(() => {
        if (pages === visiblePages) {
          list.replaceChildren(el("p", "Wiki 依据权限已变化，请重新检索。"));
          visiblePages = [];
        }
      });
    const id = visibleId;
    if (!id) return;
    void connection.request(`/v1/wiki/changes/${id}`).catch(() => {
      if (id === visibleId) {
        detail.replaceChildren(el("p", "权限或依据已变化，请重新读取提案。"));
        visibleId = undefined;
      }
    });
  }, 5000);
}
