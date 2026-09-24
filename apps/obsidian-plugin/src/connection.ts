import type {
  Job,
  Principal,
  Settings,
  Workspace,
  Capability,
  Problem,
} from "@kb/contracts";
export type Transport = (
  url: string,
  options: { method: string; headers: Record<string, string>; body?: string },
) => Promise<{ status: number; json: unknown }>;
export class Connection {
  private token?: string;
  private operationKeys = new Map<string, string>();
  private selfCheckKey = crypto.randomUUID();
  private retryKeys = new Map<string, string>();
  principal?: Principal;
  workspace?: Workspace;
  capabilities: Capability[] = [];
  constructor(
    readonly transport: Transport,
    readonly vaultPath: string,
    readonly deviceId: string,
    readonly base = "http://127.0.0.1:27124",
  ) {
    const url = new URL(base);
    if (
      url.protocol !== "http:" ||
      url.hostname !== "127.0.0.1" ||
      url.pathname !== "/" ||
      url.search ||
      url.hash ||
      url.username ||
      url.password
    )
      throw new Error("仅连接本机回环服务。");
  }
  async request<T>(path: string, method = "GET", body?: unknown): Promise<T> {
    const mutation =
      method !== "GET" &&
      !path.startsWith("/v1/session/") &&
      path !== "/v1/pair" &&
      !path.endsWith("/reparse");
    const signature = `${method}:${path}:${JSON.stringify(body)}`;
    const key = this.operationKeys.get(signature) ?? crypto.randomUUID();
    if (mutation) this.operationKeys.set(signature, key);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const response = await Promise.race([
      this.transport(this.base + path, {
        method,
        headers: {
          ...(body !== undefined ? { "content-type": "application/json" } : {}),
          ...(mutation ? { "x-operation-key": key } : {}),
          ...(this.token ? { authorization: `Bearer ${this.token}` } : {}),
          ...(this.workspace
            ? { "x-policy-version": String(this.workspace.policyVersion) }
            : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      }),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error("CONNECTION_TIMEOUT")),
          path.startsWith("/v1/ingestion/") ||
            path === "/v1/search" ||
            path === "/v1/search/rebuild"
            ? 130_000
            : path === "/v1/publications/previews"
              ? 25_000
            : path === "/v1/answers"
              ? 35_000
              : 10_000,
        );
      }),
    ]).finally(() => {
      if (timer) clearTimeout(timer);
    });
    if (response.status >= 400) {
      if (response.status < 500) this.operationKeys.delete(signature);
      throw response.json as Problem;
    }
    this.operationKeys.delete(signature);
    return response.json as T;
  }
  async pair(code: string) {
    const result = await this.request<{ token: string; principal: Principal }>(
      "/v1/pair",
      "POST",
      { code, deviceId: this.deviceId, vaultPath: this.vaultPath },
    );
    this.token = result.token;
    this.principal = result.principal;
    await this.refresh();
  }
  async refresh() {
    await this.request("/v1/session/refresh", "POST");
    const result = await this.request<{
      workspace: Workspace;
      principal: Principal;
      capabilities: Capability[];
    }>("/v1/workspace");
    this.workspace = result.workspace;
    this.principal = result.principal;
    this.capabilities = result.capabilities;
    return result;
  }
  heartbeat() {
    return this.request("/v1/session/heartbeat", "POST");
  }
  async claim() {
    await this.request("/v1/master/claim", "POST", {
      epoch: this.workspace?.epoch,
    });
    await this.refresh();
  }
  async release() {
    await this.request("/v1/master/release", "POST");
    await this.refresh();
  }
  settings() {
    return this.request<Settings>("/v1/settings");
  }
  async saveSettings(settings: Settings) {
    await this.request("/v1/settings", "PUT", settings);
    await this.refresh();
  }
  jobs() {
    return this.request<Job[]>("/v1/jobs");
  }
  async createJob() {
    const job = await this.request<Job>("/v1/jobs", "POST", {
      operationKey: this.selfCheckKey,
      queue: "interactive",
      kind: "diagnostic-check",
    });
    this.selfCheckKey = crypto.randomUUID();
    return job;
  }
  cancel(id: string) {
    return this.request<Job>(
      `/v1/jobs/${encodeURIComponent(id)}/cancel`,
      "POST",
    );
  }
  async retryJob(parentId: string) {
    const operationKey = this.retryKeys.get(parentId) ?? crypto.randomUUID();
    this.retryKeys.set(parentId, operationKey);
    const job = await this.request<Job>("/v1/jobs", "POST", {
      operationKey,
      parentId,
      queue: "interactive",
      kind: "diagnostic-check",
    });
    this.retryKeys.delete(parentId);
    return job;
  }
  diagnostics() {
    return this.request<unknown>("/v1/diagnostics");
  }
  async disconnect() {
    this.principal = undefined;
    this.workspace = undefined;
    try {
      await this.request("/v1/session/revoke", "POST");
    } finally {
      this.token = undefined;
      this.principal = undefined;
      this.workspace = undefined;
    }
  }
}
