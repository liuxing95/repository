import type { DraftListItem, WritingDraft } from "@kb/contracts";
import type { Connection } from "../connection";
const el = <K extends keyof HTMLElementTagNameMap>(tag: K, text = "") => {
  const node = document.createElement(tag);
  node.textContent = text;
  return node;
};
export function renderDrafts(root: HTMLElement, connection: Connection) {
  root.className = "kb-research kb-drafts";
  root.append(
    el("h2", "07 / 正文草稿"),
    el(
      "p",
      "在检索区生成草稿后，到这里编辑。保存草稿只保存到本机服务；提交审核后仍需核对候选文件并单独批准。正文按普通文字排版，引用由系统生成。",
    ),
  );
  const status = el("p"),
    list = el("div"),
    editor = el("div");
  status.setAttribute("role", "status");
  let current: WritingDraft | undefined,
    dirty = false,
    busy = false;
  let title: HTMLInputElement;
  let paragraphs: WritingDraft["paragraphs"] = [];
  let invalid = false;
  const action = (
    label: string,
    parent: HTMLElement,
    fn: () => Promise<void>,
  ) => {
    const button = el("button", label);
    button.type = "button";
    button.onclick = () => {
      if (busy) return;
      busy = true;
      root.querySelectorAll("button").forEach((b) => (b.disabled = true));
      status.textContent = "处理中…";
      void fn()
        .catch((error: { code?: string; message?: string }) => {
          status.textContent = `${error.message ?? error.code ?? "操作失败"}；编辑内容仍保留。`;
        })
        .finally(() => {
          busy = false;
          root.querySelectorAll("button").forEach((b) => (b.disabled = false));
        });
    };
    parent.append(button);
  };
  const changed = () => {
    dirty = true;
    status.textContent = "有未保存的修改。保存后旧审核提案失效。";
  };
  const open = (d: WritingDraft) => {
    if (dirty) throw new Error("请先保存当前编辑，再打开其他草稿");
    current = d;
    invalid = false;
    editor.replaceChildren();
    editor.dataset.draftId = d.id;
    editor.dataset.revision = String(d.revision);
    const label = el("label", "草稿标题");
    title = el("input");
    title.value = d.title;
    title.setAttribute("aria-label", "草稿标题");
    title.oninput = changed;
    label.append(title);
    editor.append(label);
    paragraphs = structuredClone(d.paragraphs);
    const body = el("div");
    editor.append(body);
    const renderParagraphs = () => {
      body.replaceChildren();
      paragraphs.forEach((p, index) => {
        const section = el("fieldset"),
          text = el("textarea");
        section.append(el("legend", `段落 ${index + 1}`));
        text.value = p.text;
        text.setAttribute("aria-label", `段落 ${index + 1} 正文`);
        text.oninput = () => {
          p.text = text.value;
          changed();
        };
        section.append(text);
        const refs = el("details");
        refs.append(el("summary", "选择本段引用并核对原文"));
        for (const e of d.answer.evidence) {
          const label = el(
              "label",
              `${e.title} · ${e.locator.heading?.join(" / ") ?? ""}`,
            ),
            box = el("input");
          box.type = "checkbox";
          box.checked = p.evidenceIds.includes(e.id);
          box.setAttribute("aria-label", `段落 ${index + 1} 引用 ${e.id}`);
          box.onchange = () => {
            p.evidenceIds = box.checked
              ? [...new Set([...p.evidenceIds, e.id])]
              : p.evidenceIds.filter((id) => id !== e.id);
            changed();
          };
          label.prepend(box);
          refs.append(label, el("pre", e.text));
        }
        section.append(refs);
        action("删除此段", section, async () => {
          paragraphs.splice(index, 1);
          changed();
          renderParagraphs();
        });
        body.append(section);
      });
    };
    renderParagraphs();
    action("添加段落", editor, async () => {
      if (paragraphs.length >= 20) throw new Error("最多 20 段，请拆分草稿");
      paragraphs.push({ text: "", evidenceIds: [] });
      changed();
      renderParagraphs();
    });
    action("保存草稿", editor, async () => {
      if (invalid) throw new Error("依据权限已变化，请重新检索");
      const sent = {
        title: title.value,
        paragraphs: structuredClone(paragraphs),
        revision: current!.revision,
      };
      const fingerprint = JSON.stringify({ title: title.value, paragraphs });
      await connection.refresh();
      const saved = await connection.request<WritingDraft>(
        `/v1/drafts/${d.id}`,
        "PUT",
        sent,
      );
      current = saved;
      dirty =
        fingerprint !== JSON.stringify({ title: title.value, paragraphs });
      editor.dataset.revision = String(saved.revision);
      status.textContent = dirty
        ? "已保存提交时的内容；之后的编辑仍未保存。"
        : `草稿已保存，修订 ${saved.revision}。可继续编辑或提交审核。`;
    });
    action("提交当前草稿审核", editor, async () => {
      if (dirty) throw new Error("请先保存修改，再提交审核");
      if (invalid) throw new Error("依据权限已变化，请重新检索");
      await connection.refresh();
      const frozen = await connection.request<{ id: string }>(
        `/v1/drafts/${d.id}/candidate`,
        "POST",
        { revision: current!.revision },
      );
      status.textContent = `已提交固定候选 ${frozen.id}。在下方“Wiki 候选与审核”读取待审核候选，核对后保存。`;
    });
    const comparison = el("div");
    editor.append(comparison);
    action("查看已保存版本（保留当前编辑）", editor, async () => {
      const saved = await connection.request<WritingDraft>(
        `/v1/drafts/${d.id}`,
      );
      comparison.replaceChildren(
        el("h4", `服务端修订 ${saved.revision}：${saved.title}`),
        ...saved.paragraphs.map((p) => el("pre", p.text)),
      );
    });
    action("载入已保存版本（放弃未保存修改）", editor, async () => {
      const before = JSON.stringify({ title: title.value, paragraphs });
      const saved = await connection.request<WritingDraft>(
        `/v1/drafts/${d.id}`,
      );
      if (before !== JSON.stringify({ title: title.value, paragraphs }))
        throw new Error("读取期间又有编辑，已保留输入，请重新核对");
      dirty = false;
      open(saved);
    });
    status.textContent = `已打开修订 ${d.revision}；模型：${d.answer.model}。所有段落仍需人工核对。`;
  };
  action("读取草稿", root, async () => {
    const drafts = await connection.request<DraftListItem[]>("/v1/drafts");
    list.replaceChildren();
    for (const d of drafts)
      action(`${d.title} · 修订 ${d.revision}`, list, async () => {
        if (dirty) throw new Error("请先保存当前编辑，再打开其他草稿");
        open(await connection.request<WritingDraft>(`/v1/drafts/${d.id}`));
      });
    status.textContent = drafts.length
      ? "选择要继续编辑的草稿。"
      : "暂无草稿，先在检索区生成，或把待审核候选转为编辑草稿。";
  });
  root.append(status, list, editor);
  const timer = setInterval(() => {
    if (!root.isConnected) {
      clearInterval(timer);
      return;
    }
    const checking = current;
    if (!checking || invalid) return;
    void connection
      .request<WritingDraft>(`/v1/drafts/${checking.id}`)
      .then((latest) => {
        if (current !== checking || latest.revision === checking.revision)
          return;
        status.textContent =
          "另一处已保存新版本；当前输入保留，保存时不会覆盖新版本。点击“查看已保存版本”比较，保留需要的文字后再决定是否载入。";
      })
      .catch((error: { code?: string }) => {
        if (current !== checking) return;
        // Network failures retain edits; revoked content must disappear from an idle view.
        if (["AUTH", "FORBIDDEN", "BASELINE"].includes(error.code ?? "")) {
          invalid = true;
          dirty = false;
          current = undefined;
          paragraphs = [];
          editor.replaceChildren();
          list.replaceChildren();
          status.textContent =
            "会话或来源权限已变化，已清除显示；重新连接或检索后继续。";
        }
      });
  }, 5000);
}
