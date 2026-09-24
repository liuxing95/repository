import type {
  PublicationDependency,
  PublicationPreview,
  SourcePolicy,
  WikiPage,
} from "@kb/contracts";
import type { Connection } from "../connection";

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, text = "") => {
  const node = document.createElement(tag);
  node.textContent = text;
  return node;
};

export function renderPublication(root: HTMLElement, connection: Connection) {
  root.className = "kb-ingestion kb-publication";
  root.append(
    el("h2", "15 / 公开副本"),
    el(
      "p",
      "仅导出选中的当前 Wiki 修订。先处理每条链接和附件，再核对最终站点文件并单独批准。当前只发布到本机应用数据的静态站点目录，不会上传互联网。",
    ),
  );
  const status = el("p"),
    pages = el("div"),
    dependencies = el("div"),
    preview = el("div"),
    releases = el("div");
  root.append(status);
  const routeLabel = el(
    "label",
    "发布路线 ID（需先在策略中按来源授权 publish）",
  );
  const route = el("input");
  route.setAttribute("aria-label", "发布路线 ID");
  routeLabel.append(route);
  root.append(routeLabel);
  const selected = new Map<string, HTMLInputElement>();
  let discovered: PublicationDependency[] = [];
  let decisionControls: {
    token: string;
    select: HTMLSelectElement;
    replacement: HTMLInputElement;
  }[] = [];
  let current: PublicationPreview | null = null;
  let buildOperationId = crypto.randomUUID();
  let releaseOperationId = crypto.randomUUID();
  let busy = false;
  const action = (
    name: string,
    parent: HTMLElement,
    fn: () => Promise<unknown>,
  ) => {
    const button = el("button", name);
    button.type = "button";
    button.onclick = () => {
      if (busy) return;
      busy = true;
      root.querySelectorAll("button").forEach((b) => {
        b.disabled = true;
      });
      status.textContent = "处理中…";
      void fn()
        .then(() => {
          status.textContent = "操作完成。";
        })
        .catch((error: unknown) => {
          const e = error as { code?: string; message?: string };
          status.textContent = `操作未完成：${e.code ?? e.message ?? "请求失败"}。请刷新后核对。`;
        })
        .finally(() => {
          busy = false;
          root.querySelectorAll("button").forEach((b) => {
            b.disabled =
              (b.dataset.confirmation === "true" &&
                !preview.querySelector<HTMLInputElement>(
                  'input[aria-label="批准固定公开副本"]',
                )?.checked) ||
              (b.dataset.release === "true" && !current?.approvedBy);
          });
        });
    };
    parent.append(button);
    return button;
  };
  const revisions = () =>
    [...selected.entries()]
      .filter(([, checkbox]) => checkbox.checked)
      .map(([id]) => id);
  action("读取已审核 Wiki", root, async () => {
    const available = await connection.request<WikiPage[]>("/v1/wiki/pages");
    selected.clear();
    pages.replaceChildren();
    dependencies.replaceChildren();
    preview.replaceChildren();
    current = null;
    for (const page of available) {
      if (page.review !== "reviewed") continue;
      const label = el("label", `${page.title} · ${page.revisionId}`),
        checkbox = el("input");
      checkbox.type = "checkbox";
      checkbox.setAttribute("aria-label", `选择公开 ${page.title}`);
      label.prepend(checkbox);
      pages.append(label);
      selected.set(page.revisionId, checkbox);
    }
    if (!selected.size) pages.append(el("p", "暂无可选择的已审核 Wiki。"));
  });
  root.append(pages);
  action("检查直接依赖", root, async () => {
    await connection.refresh();
    const result = await connection.request<{
      pages: { title: string; sourceIds: string[] }[];
      dependencies: PublicationDependency[];
    }>("/v1/publications/inspect", "POST", { revisionIds: revisions() });
    discovered = result.dependencies;
    buildOperationId = crypto.randomUUID();
    decisionControls = [];
    dependencies.replaceChildren(el("h3", "将要公开的页面与依赖"));
    for (const page of result.pages)
      dependencies.append(
        el("p", `${page.title}；正式来源：${page.sourceIds.join("、")}`),
      );
    if (connection.principal?.role === "admin") {
      for (const sourceId of new Set(
        result.pages.flatMap((page) => page.sourceIds),
      )) {
        const row = el("div", `来源 ${sourceId}：`);
        action("允许此来源用于本机发布", row, async () => {
          const settings = await connection.settings();
          if (
            !settings.routes.some(
              (r) =>
                r.id === route.value && r.purpose === "publish" && r.enabled,
            )
          )
            throw new Error("请先在预算与路线中配置并启用 publish 路线");
          const policy = await connection.request<SourcePolicy>(
            `/v1/source-policy/${sourceId}`,
          );
          if (policy.retracted) throw new Error("来源已撤回，不能重新放行");
          if (!policy.routes.publish.includes(route.value)) {
            await connection.refresh();
            await connection.request("/v1/source-policy", "PUT", {
              ...policy,
              routes: {
                ...policy.routes,
                publish: [...policy.routes.publish, route.value],
              },
            });
            await connection.refresh();
            current = null;
            preview.replaceChildren(
              el("p", "来源策略已变化；请重新构建并审核副本。"),
            );
          }
        });
        dependencies.append(row);
      }
    }
    for (const dep of discovered) {
      const block = el("div"),
        label = el("p", `${dep.kind}：${dep.token}`),
        select = el("select"),
        replacement = el("input");
      select.setAttribute("aria-label", `处理 ${dep.token}`);
      for (const [value, text] of [
        ["blocked", "阻断"],
        ["remove", "移除"],
        ["replace", "替换为公开 HTTPS 链接"],
        ...(dep.kind === "external"
          ? [["retain", "保留这条 HTTPS 裸链接"]]
          : []),
        ...(dep.kind === "attachment" ? [["include", "纳入受控文本附件"]] : []),
      ] as const) {
        const option = el("option", text);
        option.value = value;
        select.append(option);
      }
      replacement.setAttribute("aria-label", `替换链接 ${dep.token}`);
      replacement.placeholder = "https://example.org/public";
      block.append(label, select, replacement);
      dependencies.append(block);
      decisionControls.push({ token: dep.token, select, replacement });
    }
    if (!discovered.length)
      dependencies.append(
        el("p", "没有直接链接或附件依赖。仍需核对全文和最终文件。"),
      );
  });
  root.append(dependencies);
  action("隔离构建并预览最终文件", root, async () => {
    if (decisionControls.some((d) => d.select.value === "blocked"))
      throw new Error("仍有未处理依赖");
    await connection.refresh();
    const decisions = Object.fromEntries(
      decisionControls.map((d) => [
        d.token,
        d.select.value === "remove"
          ? { action: "remove" }
          : d.select.value === "include"
            ? { action: "include" }
            : d.select.value === "retain"
              ? { action: "retain" }
              : { action: "replace", url: d.replacement.value },
      ]),
    );
    const result = await connection.request<PublicationPreview>(
      "/v1/publications/previews",
      "POST",
      {
        operationId: buildOperationId,
        revisionIds: revisions(),
        routeId: route.value,
        decisions,
      },
    );
    current = result;
    buildOperationId = crypto.randomUUID();
    releaseOperationId = crypto.randomUUID();
    preview.replaceChildren(
      el("h3", "最终文件预览"),
      el(
        "p",
        `清单摘要：${result.manifest.digest}；产物摘要：${result.manifest.outputDigest}；目标：本机静态站点`,
      ),
    );
    for (const file of result.files) {
      const details = el("details"),
        summary = el(
          "summary",
          `${file.path} · ${result.manifest.output.find((o) => o.path === file.path)?.hash}`,
        );
      details.append(summary, el("pre", file.content));
      preview.append(details);
    }
    const label = el(
        "label",
        "我已核对全部页面、链接、搜索数据与最终文件，批准此固定副本",
      ),
      confirm = el("input");
    confirm.type = "checkbox";
    confirm.setAttribute("aria-label", "批准固定公开副本");
    label.prepend(confirm);
    preview.append(label);
    const approve = action("批准此公开副本", preview, async () => {
      if (!confirm.checked || !current) throw new Error("请先核对并勾选确认");
      await connection.refresh();
      await connection.request(
        `/v1/publications/previews/${current.manifest.id}/approve`,
        "POST",
        {
          manifestDigest: current.manifest.digest,
          outputDigest: current.manifest.outputDigest,
        },
      );
      current.approvedBy = connection.principal?.id ?? null;
      preview.append(
        el("p", "这份固定副本已批准；发布前仍会重新核对权限与字节。"),
      );
    });
    approve.dataset.confirmation = "true";
    approve.disabled = true;
    confirm.onchange = () => {
      approve.disabled = busy || !confirm.checked;
    };
    const publish = action("发布到本机静态站点", preview, async () => {
      if (!current?.approvedBy) throw new Error("请先批准固定副本");
      await connection.refresh();
      const release = await connection.request<{ id: string; state: string }>(
        `/v1/publications/previews/${current.manifest.id}/release`,
        "POST",
        {
          operationId: releaseOperationId,
          manifestDigest: current.manifest.digest,
          outputDigest: current.manifest.outputDigest,
        },
      );
      preview.append(
        el(
          "p",
          `发布记录 ${release.id}：${release.state}。仅本机目录，未向公网发送。`,
        ),
      );
    });
    publish.dataset.release = "true";
    publish.disabled = true;
  });
  action("只读导出草稿（无 Docker 可用）", root, async () => {
    if (decisionControls.some((d) => d.select.value === "blocked"))
      throw new Error("仍有未处理依赖");
    await connection.refresh();
    const decisions = Object.fromEntries(
      decisionControls.map((d) => [
        d.token,
        d.select.value === "remove"
          ? { action: "remove" }
          : d.select.value === "include"
            ? { action: "include" }
            : d.select.value === "retain"
              ? { action: "retain" }
              : { action: "replace", url: d.replacement.value },
      ]),
    );
    const result = await connection.request<{
      pages: { title: string; body: string; bodyHash: string }[];
      attachments: { path: string; hash: string; content: string }[];
    }>("/v1/publications/draft", "POST", {
      operationId: crypto.randomUUID(),
      revisionIds: revisions(),
      routeId: route.value,
      decisions,
    });
    current = null;
    preview.replaceChildren(
      el("h3", "只读导出草稿"),
      el("p", "此草稿未隔离构建和扫描，不能批准或发布。"),
    );
    for (const page of result.pages)
      preview.append(
        el("h4", `${page.title} · ${page.bodyHash}`),
        el("pre", page.body),
      );
    for (const file of result.attachments)
      preview.append(
        el("h4", `${file.path} · ${file.hash}`),
        el("pre", file.content),
      );
  });
  root.append(preview);
  action("读取发布记录", root, async () => {
    const records = await connection.request<
      {
        id: string;
        state: string;
        sourceIds: string[];
        unconfirmed: string[];
        localPresent: boolean;
      }[]
    >("/v1/publications/releases");
    releases.replaceChildren(
      ...records.map((r) =>
        el(
          "p",
          `${r.id} · ${r.state} · 本机文件${r.localPresent ? "存在" : "缺失"} · 来源 ${r.sourceIds.join("、")} · 未确认文件 ${r.unconfirmed.join("、") || "无"}`,
        ),
      ),
    );
  });
  root.append(releases);
}
