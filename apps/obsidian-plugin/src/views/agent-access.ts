import type { Connection } from "../connection";

type Client = {
  id: string;
  name: string;
  sourceIds: string[];
  receiver: { kind: "local" } | { kind: "model"; routeId: string };
  expiresAt: number;
  revokedAt: number | null;
};

export function renderAgentAccess(root: HTMLElement, connection: Connection) {
  const el = <K extends keyof HTMLElementTagNameMap>(tag: K, text = "") => {
    const node = document.createElement(tag);
    node.textContent = text;
    return node;
  };
  root.append(
    el("h2", "14 / 外部 Agent"),
    el(
      "p",
      "只给已登记的本机客户端读取指定正式来源。客户端若会把正文发给外部模型，必须选择模型接收方并填写已授权路线。密钥只显示一次。",
    ),
  );
  const name = el("input"),
    sources = el("textarea"),
    route = el("input"),
    expiry = el("input");
  name.placeholder = "客户端名称";
  sources.placeholder = "正式来源 ID，每行一个";
  route.placeholder = "模型路线 ID；本机接收方留空";
  expiry.type = "number";
  expiry.value = "60";
  for (const [node, label] of [
    [name, "客户端名称"],
    [sources, "允许的正式来源 ID"],
    [route, "模型路线 ID"],
    [expiry, "有效分钟数"],
  ] as const)
    node.setAttribute("aria-label", label);
  const create = el("button", "创建只读客户端");
  const refresh = el("button", "刷新客户端");
  const status = el(
      "p",
      "创建后请立即把密钥存入本机系统凭据库；丢失后撤销并重建。",
    ),
    list = el("div");
  status.setAttribute("role", "status");
  root.append(name, sources, route, expiry, create, refresh, status, list);
  const fail = (error: unknown) => {
    status.textContent = `操作未完成：${(error as { code?: string }).code ?? "请检查连接与授权"}`;
  };
  const load = async () => {
    const clients = await connection.request<Client[]>("/v1/agents/clients");
    list.replaceChildren();
    for (const client of clients) {
      const row = el(
        "p",
        `${client.name} · ${client.id} · ${client.sourceIds.length} 个来源 · ${client.receiver.kind === "model" ? `模型 ${client.receiver.routeId}` : "本机处理"} · ${client.revokedAt ? "已撤销" : `有效至 ${new Date(client.expiresAt).toLocaleString()}`}`,
      );
      if (!client.revokedAt) {
        const revoke = el("button", "撤销");
        revoke.onclick = () => {
          void connection
            .request(`/v1/agents/clients/${client.id}/revoke`, "POST", {})
            .then(async () => {
              status.textContent = "客户端已撤销。";
              await load();
            })
            .catch(fail);
        };
        row.append(revoke);
      }
      list.append(row);
    }
  };
  refresh.onclick = () => {
    void load().catch(fail);
  };
  create.onclick = () => {
    const sourceIds = sources.value.split(/[\s,]+/).filter(Boolean);
    const receiver = route.value.trim()
      ? { kind: "model", routeId: route.value.trim() }
      : { kind: "local" };
    void connection
      .request<{ client: Client; secret: string | null }>(
        "/v1/agents/clients",
        "POST",
        {
          name: name.value.trim(),
          sourceIds,
          receiver,
          expiresInMinutes: Number(expiry.value),
        },
      )
      .then(async ({ client, secret }) => {
        status.replaceChildren(
          el(
            "span",
            `客户端 ID：${client.id}。${secret ? "密钥只显示一次：" : "这是相同请求的重试；密钥不再返回。请撤销并重建。"}`,
          ),
        );
        if (secret) {
          const output = el("textarea");
          output.value = secret;
          output.readOnly = true;
          output.setAttribute("aria-label", "一次性 Agent 密钥");
          status.append(output);
        }
        await load();
      })
      .catch(fail);
  };
  if (connection.principal?.role === "admin") void load().catch(fail);
}
