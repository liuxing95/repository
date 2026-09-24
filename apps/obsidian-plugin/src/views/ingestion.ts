import type {
  AcquisitionPlan,
  CollectionManifest,
  ChangeSet,
  ParseArtifact,
  SourceDetail,
} from "@kb/contracts";
import { Connection } from "../connection";
import { OperationState } from "../ui/operation-state";
import { applyChange, type WriterHost } from "../writer/apply";
function el<K extends keyof HTMLElementTagNameMap>(tag: K, text?: string) {
  const node = document.createElement(tag);
  if (text) node.textContent = text;
  return node;
}
export type IngestionDraft = {
  fields: Record<string, string>;
  previewId: string;
  signature: string;
};
export function renderIngestion(
  root: HTMLElement,
  connection: Connection,
  host: WriterHost,
  draft: IngestionDraft,
) {
  root.classList.add("kb-ingestion");
  root.append(
    el("h3", "05 / 资料收录"),
    el(
      "p",
      "先限定获取范围，再核对逐项结果，最后批准写入。收录成功不代表知识已审核；OCR 和浏览器脚本执行默认关闭。",
    ),
  );
  const status = el("div");
  const state = new OperationState(status);
  root.append(status);
  const action = (
    name: string,
    parent: HTMLElement,
    handler: () => Promise<unknown>,
  ) => {
    const button = el("button", name);
    button.type = "button";
    button.addEventListener("click", () => {
      void state
        .run(async () => {
          try {
            return await handler();
          } catch (error) {
            const key = error instanceof Error ? error.message : "";
            if (key.startsWith("WRITER_"))
              throw {
                code: key === "WRITER_EXPIRED" ? "AUTH" : "CONFLICT",
                message:
                  key === "WRITER_EDITING"
                    ? "目标文件正在编辑，写入已暂停。"
                    : key === "WRITER_EXPIRED"
                      ? "写入授权已过期或连接已变化。"
                      : "目标路径或内容与批准版本不一致，未覆盖人工内容。",
                impact: "已写入的文件保留，整个提交尚未完成。",
                nextStep:
                  "关闭目标编辑页并核对内容，再重新打开本批的导入审核。",
              };
            throw error;
          }
        })
        .catch(() => {});
    });
    parent.append(button);
    return button;
  };
  const form = el("div");
  form.className = "kb-ingestion-form";
  const field = (
    key: string,
    label: string,
    value: string,
    options?: [string, string][],
  ) => {
    const wrap = el("label", label);
    const input = options ? el("select") : el("input");
    if (options)
      for (const [id, text] of options) {
        const option = el("option", text);
        option.value = id;
        input.append(option);
      }
    input.value = draft.fields[key] ?? value;
    draft.fields[key] = input.value;
    input.addEventListener("input", () => {
      draft.fields[key] = input.value;
    });
    wrap.append(input);
    form.append(wrap);
    return input;
  };
  field("kind", "资料类型", "text", [
    ["text", "文本 / Markdown / 剪藏"],
    ["html", "本地 HTML 文件"],
    ["web", "单页网页"],
    ["collection", "文档集合"],
    ["repository", "代码 / 发布产物"],
    ["pdf", "PDF"],
  ]);
  field("entry", "入口 URL 或明确授权的本地文件 / 目录绝对路径", "");
  field("title", "显示标题（可选）", "");
  field("collection", "目标集合", "默认集合");
  field(
    "allowedHosts",
    "允许域名（逗号分隔；GitHub 需 api.github.com,raw.githubusercontent.com）",
    "",
  );
  field("allowedPaths", "允许 URL 路径（逗号分隔）", "/");
  field("language", "语言范围说明", "unknown");
  field("version", "版本范围说明", "unknown");
  field("maxPages", "最多选定资料数（1—100）", "30");
  field("maxBytes", "最大取得字节数（不超过 50000000）", "10000000");
  field("maxDepth", "发现深度（0—5）", "2");
  field("maxDurationMs", "发现时限（毫秒，最多 120000）", "60000");
  field("sourceType", "代码研究对象", "source", [
    ["source", "源码"],
    ["artifact", "发布产物（保留 dist / build）"],
  ]);
  field("ref", "代码分支 / 标签 / commit", "HEAD");
  field("encoding", "文字编码", "utf-8", [
    ["utf-8", "UTF-8"],
    ["utf-16le", "UTF-16 LE"],
    ["utf-16be", "UTF-16 BE"],
    ["gb18030", "GB18030"],
  ]);
  const clipLabel = el("label", "手工剪藏正文（可选；原链接填在入口中）");
  const clip = el("textarea");
  clip.rows = 4;
  clip.value = draft.fields.clip ?? "";
  clip.addEventListener("input", () => {
    draft.fields.clip = clip.value;
  });
  clipLabel.append(clip);
  form.append(clipLabel);
  const excerptLabel = el("label", "这份输入只是节选");
  const excerpt = el("input");
  excerpt.type = "checkbox";
  excerpt.checked = draft.fields.excerpt === "true";
  excerpt.addEventListener("change", () => {
    draft.fields.excerpt = String(excerpt.checked);
  });
  excerptLabel.append(excerpt);
  form.append(excerptLabel);
  root.append(form);
  const output = el("div");
  output.className = "kb-ingestion-output";
  const detail = el("div");
  detail.className = "kb-source-detail";
  const download = async (path: string, kind: string) => {
    const result = await connection.request<{ base64: string }>(path);
    const bytes = Uint8Array.from(atob(result.base64), (c) => c.charCodeAt(0));
    const url = URL.createObjectURL(
      new Blob([bytes], { type: "application/octet-stream" }),
    );
    const link = el("a", "保存原件");
    link.href = url;
    link.download = `${path.split("/").at(-1)}.${kind === "pdf" ? "pdf" : kind === "html" || kind === "web" || kind === "collection" ? "html" : "txt"}`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  const showParse = async (parseId: string) => {
    const parsed = await connection.request<ParseArtifact>(
      `/v1/parses/${parseId}`,
    );
    detail.replaceChildren(
      el("h4", "原文与定位"),
      el(
        "p",
        `${parsed.title} · ${parsed.parser} · ${parsed.committed ? "正式来源" : "取得但尚未提交"}`,
      ),
    );
    detail.append(el("p", parsed.gaps.join("\n") || "文本可用。"));
    if (parsed.pages) {
      const pages = el("details");
      pages.append(
        el("summary", `共 ${parsed.pages} 个物理页 · 页码对应`),
        el(
          "pre",
          (parsed.pageLabels ?? [])
            .slice(0, 200)
            .map((label, i) => `物理页 ${i + 1} → 印刷标签 ${label ?? "未知"}`)
            .join("\n"),
        ),
      );
      detail.append(pages);
    }
    detail.append(
      el(
        "p",
        `声明公开时间：${parsed.declaredPublishedAt ?? "未知"}；已确认公开时间：${parsed.confirmedPublishedAt ?? "未知"}。`,
      ),
    );
    for (const block of parsed.blocks) {
      const row = el("details");
      row.append(
        el(
          "summary",
          `${block.id} · ${JSON.stringify(block.locator)} · UTF-16 [${block.start}, ${block.end})`,
        ),
        el("pre", block.text),
      );
      detail.append(row);
    }
  };
  const showChange = (change: ChangeSet) => {
    detail.replaceChildren(
      el("h4", "正式导入预览"),
      el(
        "p",
        `${change.patches.length} 个文件；已登记 ${change.receipts.length} 个回执。摘要 ${change.digest}`,
      ),
    );
    for (const patch of change.patches) {
      const row = el("details");
      row.append(el("summary", `新建 ${patch.path}`), el("pre", patch.content));
      detail.append(row);
    }
    detail.append(
      el(
        "p",
        "批准仅适用于以上固定文件，10 分钟内有效。写入前若文件已存在且内容不同，或正在编辑，将停止并保留人工内容。",
      ),
    );
    if (change.state !== "committed") {
      action("批准以上文件并写入", detail, async () => {
        const approved = await connection.request<ChangeSet>(
          `/v1/changes/${change.id}/approve`,
          "POST",
          { digest: change.digest },
        );
        await applyChange(host, connection, approved);
        showBatch(
          await connection.request<CollectionManifest>(
            `/v1/ingestion/${change.batchId}`,
          ),
        );
        detail.replaceChildren(
          el(
            "p",
            "来源文件与业务提交已确认。索引事件已登记，检索由场景 03 接入。",
          ),
        );
      });
      if (change.state === "approved")
        action("继续已批准的写入", detail, async () => {
          await applyChange(host, connection, change);
          showBatch(
            await connection.request<CollectionManifest>(
              `/v1/ingestion/${change.batchId}`,
            ),
          );
          detail.replaceChildren(el("p", "来源提交已完成。"));
        });
    }
  };
  const showBatch = (batch: CollectionManifest) => {
    output.replaceChildren();
    detail.replaceChildren();
    const acquired = batch.entries.filter(
      (e) => e.selected && e.parseId,
    ).length;
    const committed = batch.entries.filter(
      (e) => e.selected && e.status === "committed",
    ).length;
    output.append(
      el(
        "h4",
        `${batch.plan.collection} · ${batch.state === "preview" ? "待确认范围" : batch.state === "running" ? "获取与解析中" : batch.state === "cancelled" ? "已取消" : "待核对结果"}`,
      ),
      el(
        "p",
        `发现 ${batch.entries.length} · 选定 ${batch.selectedCount} · 已解析 ${acquired} · 失败 ${batch.entries.filter((e) => e.status === "failed").length} · 已提交 ${committed}`,
      ),
      el(
        "p",
        `采集开始：${new Date(batch.createdAt).toLocaleString()}；结束：${batch.finishedAt ? new Date(batch.finishedAt).toLocaleString() : "尚未结束"}。集合不代表同一瞬间的上游快照。`,
      ),
    );
    for (const warning of batch.warnings) output.append(el("p", warning));
    for (const missing of batch.previousMissing)
      output.append(el("p", `本轮未发现，旧版本保留：${missing}`));
    const selected = new Set(
      batch.entries.filter((e) => e.selected).map((e) => e.id),
    );
    const labels = {
      excluded: "排除",
      pending: "待处理",
      acquired: "已取得",
      partial_parse: "部分可用",
      failed: "失败",
      pending_write: "等待写入",
      committed: "已提交",
    };
    for (const entry of batch.entries) {
      const row = el("div");
      row.className = "kb-ingestion-entry";
      if (batch.state === "preview" && entry.selected) {
        const label = el("label", "选入本次清单");
        const checkbox = el("input");
        checkbox.type = "checkbox";
        checkbox.checked = true;
        checkbox.addEventListener("change", () => {
          if (checkbox.checked) selected.add(entry.id);
          else selected.delete(entry.id);
        });
        label.append(checkbox);
        row.append(label);
      }
      row.append(
        el("strong", `${labels[entry.status]} · ${entry.original}`),
        el("p", `${entry.reason ?? ""} 发现依据：${entry.via.join("；")}`),
      );
      if (entry.metadata.commit || entry.kind === "repository")
        row.append(
          el(
            "p",
            `commit：${entry.metadata.commit ?? "无"} · 脏 / 非 Git 快照：${entry.metadata.dirty} · ${entry.metadata.sourceType}`,
          ),
        );
      if (entry.parseId)
        action("查看文字与定位", row, () => showParse(entry.parseId!));
      if (entry.objectHash)
        action("保存原件", row, () =>
          download(
            `/v1/ingestion/${batch.id}/original/${entry.id}`,
            entry.kind,
          ),
        );
      if (entry.parseId && batch.state === "ready") {
        const passwordLabel = el("label", "PDF 临时密码（仅本次重新解析使用）");
        const password = el("input");
        password.type = "password";
        password.autocomplete = "off";
        if (entry.kind === "pdf") {
          passwordLabel.append(password);
          row.append(passwordLabel);
        }
        action("重新解析原件", row, async () => {
          const secret = password.value;
          password.value = "";
          showBatch(
            await connection.request<CollectionManifest>(
              `/v1/ingestion/${batch.id}/reparse`,
              "POST",
              {
                entryId: entry.id,
                encoding: draft.fields.encoding,
                ...(secret ? { password: secret } : {}),
              },
            ),
          );
        });
      }
      output.append(row);
    }
    if (batch.state === "preview")
      action("确认清单并解析", output, async () =>
        showBatch(
          await connection.request<CollectionManifest>(
            `/v1/ingestion/${batch.id}/freeze`,
            "POST",
            { digest: batch.digest, selectedIds: [...selected] },
          ),
        ),
      );
    if (batch.state === "running")
      output.append(
        el("p", "解析在后台继续。稍后刷新本批；关闭插件会暂停后续处理。"),
      );
    action("刷新本批", output, async () =>
      showBatch(
        await connection.request<CollectionManifest>(
          `/v1/ingestion/${batch.id}`,
        ),
      ),
    );
    if (batch.state === "ready") {
      action("审核正式导入文件", output, async () =>
        showChange(
          await connection.request<ChangeSet>(
            `/v1/ingestion/${batch.id}/prepare`,
            "POST",
          ),
        ),
      );
      action("重试失败项", output, async () =>
        showBatch(
          await connection.request<CollectionManifest>(
            `/v1/ingestion/${batch.id}/retry`,
            "POST",
          ),
        ),
      );
    }
    if (!["preview", "cancelled"].includes(batch.state))
      action("取消本批后续处理", output, async () =>
        showBatch(
          await connection.request<CollectionManifest>(
            `/v1/ingestion/${batch.id}/cancel`,
            "POST",
          ),
        ),
      );
  };
  const preview = async () => {
    const fields = draft.fields;
    const input = {
      ...fields,
      excerpt: excerpt.checked,
      clip: clip.value || undefined,
      allowedHosts: fields
        .allowedHosts!.split(",")
        .map((s) => s.trim())
        .filter(Boolean),
      allowedPaths: fields
        .allowedPaths!.split(",")
        .map((s) => s.trim())
        .filter(Boolean),
      maxPages: Number(fields.maxPages),
      maxBytes: Number(fields.maxBytes),
      maxDepth: Number(fields.maxDepth),
      maxDurationMs: Number(fields.maxDurationMs),
    };
    const signature = JSON.stringify(input);
    if (signature !== draft.signature) {
      draft.previewId = crypto.randomUUID();
      draft.signature = signature;
    }
    const plan = { ...input, id: draft.previewId } as AcquisitionPlan;
    showBatch(
      await connection.request<CollectionManifest>(
        "/v1/ingestion/preview",
        "POST",
        plan,
      ),
    );
  };
  action("预览获取范围", root, preview);
  action("重新获取并生成新预览", root, async () => {
    draft.signature = "";
    await preview();
  });
  action("查看历史批次", root, async () => {
    const batches =
      await connection.request<CollectionManifest[]>("/v1/ingestion");
    output.replaceChildren();
    detail.replaceChildren();
    if (!batches.length) output.append(el("p", "暂无收录批次。"));
    for (const batch of batches)
      action(
        `${batch.plan.collection} · ${batch.plan.entry} · ${batch.state}`,
        output,
        async () => showBatch(batch),
      );
  });
  action("浏览正式来源", root, async () => {
    const sources = await connection.request<SourceDetail[]>("/v1/sources");
    output.replaceChildren();
    detail.replaceChildren();
    if (!sources.length)
      output.append(el("p", "暂无正式来源。取得资料后仍需审核并批准写入。"));
    for (const source of sources)
      for (const parse of source.parses)
        action(
          `${parse.title} · ${source.revision.fetchedAt} · ${parse.id}`,
          output,
          () => showParse(parse.id),
        );
  });
  root.append(output, detail);
  return state;
}
