import { TFile, parseYaml, type App } from "obsidian";
import { TaskFact, Id, type TaskCommand, type TaskToday } from "@kb/contracts";
import { Connection } from "../connection";
export const TASKNOTES_VERSION = "4.13.4";
type NativeTask = {
  path: string;
  title: string;
  status: string;
  due?: string;
  timeEstimate?: number;
  timeEntries?: { startTime: string; endTime?: string }[];
  recurrence?: string;
  complete_instances?: string[];
  skipped_instances?: string[];
  recurrence_parent?: string;
  occurrence_date?: string;
  blockedBy?: { uid: string }[];
};
type Runtime = {
  settings: { snapshot: () => { fieldMapping: Record<string, string> } };
  apiVersion: number;
  hasCapability: (name: string) => boolean;
  lifecycle: { isReady: () => boolean };
  tasks: {
    list: () => Promise<NativeTask[]>;
    get: (path: string) => Promise<NativeTask | null>;
    create: (input: unknown, context: unknown) => Promise<NativeTask>;
  };
  catalog: { statuses: () => { value: string; isCompleted: boolean }[] };
};
export async function taskHash(value: string) {
  return [
    ...new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
    ),
  ]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
function frontmatter(body: string): Record<string, unknown> {
  const match = body.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  return match ? ((parseYaml(match[1]!) as Record<string, unknown>) ?? {}) : {};
}
export class TaskNotesAdapter {
  private running = false;
  private knownIds = new Set<string>();
  private identitiesLoaded = false;
  private revision = 0;
  private hints = new Set<string>();
  lastMessage = "尚未核对 TaskNotes。";
  constructor(
    readonly app: App,
    readonly connection: Connection,
  ) {}
  changed() {
    this.revision++;
    if (!this.hints.size) this.hints.add(crypto.randomUUID());
  }
  runtime() {
    const p = (
      this.app as App & {
        plugins: {
          plugins: Record<
            string,
            { manifest: { version: string }; api?: Runtime }
          >;
        };
      }
    ).plugins.plugins.tasknotes;
    if (
      !p?.api ||
      p.manifest.version !== TASKNOTES_VERSION ||
      p.api.apiVersion !== 1 ||
      !p.api.lifecycle.isReady() ||
      !p.api.hasCapability("tasks.read")
    )
      throw Error(
        "需要已加载且缓存就绪的 TaskNotes 4.13.4；其他版本保持只读且暂停核对。",
      );
    return p.api;
  }
  async inventory() {
    const api = this.runtime(),
      version = this.revision,
      rows = await api.tasks.list(),
      facts: TaskFact[] = [],
      contents = new Map<string, string>();
    if (rows.length > 10000) throw Error("任务超过清点上限。");
    const existingPaths = this.app.vault
      .getMarkdownFiles()
      .map((f) => f.path)
      .filter((p) => !p.split("/").some((s) => s.startsWith(".")))
      .sort();
    for (const row of rows) {
      const file = this.app.vault.getAbstractFileByPath(row.path);
      if (!(file instanceof TFile)) throw Error("任务正在移动，稍后核对。");
      if (file.stat.size > 20_000_000)
        throw Error("任务文件超过 20 MB，请缩小试点。");
      const body = await this.app.vault.read(file),
        fm = frontmatter(body);
      contents.set(row.path, body);
      const mapping = api.settings.snapshot().fieldMapping;
      // Cache must agree with source fields before an observation can cancel future work.
      for (const [native, key] of [
        ["status", "status"],
        ["due", "due"],
        ["timeEstimate", "timeEstimate"],
        ["recurrence", "recurrence"],
        ["complete_instances", "completeInstances"],
        ["skipped_instances", "skippedInstances"],
      ] as const) {
        const source = fm[mapping[key] ?? key] ?? null,
          cached = row[native] ?? null;
        if (JSON.stringify(source) !== JSON.stringify(cached))
          throw Error("TaskNotes 缓存尚未反映文件内容，稍后核对。");
      }
      const status = api.catalog.statuses().find((s) => s.value === row.status);
      const standard: Record<string, TaskFact["lifecycle"]> = {
        none: "inbox",
        open: "todo",
        "in-progress": "in-progress",
        blocked: "blocked",
        cancelled: "cancelled",
      };
      const lifecycle = status?.isCompleted
        ? "done"
        : status
          ? (standard[row.status] ?? "unmapped")
          : "unmapped";
      const nullable = (v: unknown) => (typeof v === "string" ? v : null);
      const id = Id.safeParse(fm.taskId),
        op = Id.safeParse(fm.kbOperationId);
      if (fm.taskId !== undefined && !id.success)
        throw Error("有任务的 taskId 格式无效，请先在 TaskNotes 中核对。");
      facts.push(
        TaskFact.parse({
          taskId: id.success ? id.data : null,
          operationId: op.success ? op.data : null,
          path: row.path,
          title: row.title,
          status: row.status,
          lifecycle,
          desiredDay: nullable(fm.kbDesiredDay),
          earliestDay: nullable(fm.kbEarliestDay),
          due: row.due ?? null,
          timezone:
            nullable(fm.kbTimezone) ??
            Intl.DateTimeFormat().resolvedOptions().timeZone,
          minutes: row.timeEstimate ?? null,
          timeEntries: (row.timeEntries ?? []).map((e) => ({
            startTime: e.startTime,
            ...(e.endTime ? { endTime: e.endTime } : {}),
          })),
          recurrence: row.recurrence ?? null,
          completeInstances: row.complete_instances ?? [],
          skippedInstances: row.skipped_instances ?? [],
          seriesPath:
            row.recurrence_parent
              ?.replace(/^\[\[|\]\]$/g, "")
              .replace(/(?<!\.md)$/u, ".md") ?? null,
          originalOccurrence: row.occurrence_date ?? null,
          dependencies: (row.blockedBy ?? [])
            .map((d) => d.uid.replace(/^\[\[|\]\]$/g, ""))
            .map((p) => (p.endsWith(".md") ? p : p + ".md")),
          contentHash: await taskHash(body),
        }),
      );
    }
    const missing = new Set(
      [...this.knownIds].filter((id) => !facts.some((f) => f.taskId === id)),
    );
    if (missing.size)
      for (const file of this.app.vault.getMarkdownFiles()) {
        if (contents.has(file.path)) continue;
        if (file.stat.size > 20_000_000)
          throw Error("遗漏身份清点遇到大文件，不能确认删除。");
        const body = await this.app.vault.read(file);
        contents.set(file.path, body);
        const id = frontmatter(body).taskId;
        if (typeof id === "string" && missing.has(id))
          throw Error("受管任务已移动但缓存尚未就绪，保留原身份并重新核对。");
      }
    // Second pass checks both TaskNotes cache and actual file bytes; changing/late caches block deletion.
    const latest = await api.tasks.list();
    if (JSON.stringify(rows) !== JSON.stringify(latest))
      throw Error("TaskNotes 缓存变化，等待下一轮核对。");
    for (const [path, body] of contents) {
      const f = this.app.vault.getAbstractFileByPath(path);
      if (!(f instanceof TFile) || (await this.app.vault.read(f)) !== body)
        throw Error("清点期间文件改变，等待重新核对。");
    }
    if (
      version !== this.revision ||
      JSON.stringify(existingPaths) !==
        JSON.stringify(
          this.app.vault
            .getMarkdownFiles()
            .map((f) => f.path)
            .filter((p) => !p.split("/").some((s) => s.startsWith(".")))
            .sort(),
        )
    )
      throw Error("清点期间发生变化，等待重新核对。");
    return { facts, existingPaths, revision: version };
  }
  async sync() {
    if (
      this.running ||
      !this.connection.principal ||
      this.connection.workspace?.deviceId !== this.connection.deviceId
    )
      return;
    this.running = true;
    try {
      this.runtime();
      if (!this.identitiesLoaded) {
        const previous =
          await this.connection.request<TaskToday>("/v1/tasks/today");
        this.knownIds = new Set(
          previous.tasks
            .filter((t) => t.sync !== "deleted")
            .map((t) => t.taskId),
        );
        this.identitiesLoaded = true;
      }
      for (const id of this.hints) {
        await this.connection.request("/v1/tasks/events", "POST", {
          id,
          kind: "vault",
        });
        this.hints.delete(id);
      }
      const snapshot = await this.inventory();
      const { id } = await this.connection.request<{ id: string }>(
        "/v1/tasks/inventories",
        "POST",
        {},
      );
      for (let start = 0; start < snapshot.facts.length; start += 10)
        await this.connection.request(
          `/v1/tasks/inventories/${id}/items`,
          "POST",
          snapshot.facts.slice(start, start + 10),
        );
      await this.connection.request(
        `/v1/tasks/inventories/${id}/finish`,
        "POST",
        {
          count: snapshot.facts.length,
          complete: snapshot.revision === this.revision,
          existingPaths: snapshot.existingPaths,
        },
      );
      if (snapshot.revision !== this.revision)
        throw Error("清点上传期间发生变化，下一轮重新核对。");
      this.knownIds = new Set(
        snapshot.facts.flatMap((f) => (f.taskId ? [f.taskId] : [])),
      );
      this.lastMessage = `已核对 ${snapshot.facts.length} 项 TaskNotes 事实。`;
      const command = await this.connection.request<TaskCommand | null>(
        "/v1/tasks/commands/claim",
        "POST",
        {},
      );
      if (command) {
        await this.connection.refresh();
        if (
          this.connection.workspace?.epoch !== command.epoch ||
          this.connection.workspace.policyVersion !== command.policyVersion ||
          this.connection.principal?.id !== command.actorId
        )
          throw Error("命令授权已变化，保持结果未知。");
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([
            this.create(command),
            new Promise<never>((_resolve, reject) => {
              timer = setTimeout(
                () =>
                  reject(Error("创建回执超时，保持未知并继续核对，不重发。")),
                8000,
              );
            }),
          ]);
        } finally {
          if (timer) clearTimeout(timer);
        }
        this.changed();
      }
    } catch (error) {
      this.lastMessage =
        error instanceof Error
          ? error.message
          : "TaskNotes 核对暂停，请检查主端与连接。";
    } finally {
      this.running = false;
    }
  }
  private async create(c: TaskCommand) {
    const api = this.runtime();
    if (!api.hasCapability("tasks.write"))
      throw Error("TaskNotes 创建接口不可用。");
    const inventory = await this.inventory();
    if (
      inventory.facts.some(
        (f) => f.taskId === c.taskId || f.operationId === c.id,
      )
    )
      return;
    const initial = api.catalog
      .statuses()
      .find((s) => s.value === "open" && !s.isCompleted);
    if (!initial)
      throw Error("TaskNotes open 状态未配置；命令保持未知，请人工核对。");
    // One upstream vault.create includes identity and operation marker. Never replay this call.
    await api.tasks.create(
      {
        title: c.input.title,
        status: initial.value,
        ...(c.input.deadlineDay ? { due: c.input.deadlineDay } : {}),
        ...(c.input.minutes ? { timeEstimate: c.input.minutes } : {}),
        details: c.input.details,
        customFrontmatter: {
          taskId: c.taskId,
          kbOperationId: c.id,
          kbDesiredDay: c.input.desiredDay,
          kbEarliestDay: c.input.earliestDay,
          kbTimezone: c.input.timezone,
        },
      },
      {
        source: "knowledge-task-center",
        correlationId: c.id,
        reason: "user-confirmed-create",
      },
    );
  }
  async adopt(fact: TaskFact) {
    this.runtime();
    await this.connection.request("/v1/tasks/adoption-check", "POST", {});
    const file = this.app.vault.getAbstractFileByPath(fact.path);
    if (!(file instanceof TFile)) throw Error("文件不存在，重新预览。");
    const expected = await this.app.vault.read(file);
    if (
      (await taskHash(expected)) !== fact.contentHash ||
      frontmatter(expected).taskId !== undefined
    )
      throw Error("文件已变化或已有身份，重新预览。");
    let editing = false;
    this.app.workspace.iterateAllLeaves((leaf) => {
      const view = leaf.view as typeof leaf.view & {
        file?: TFile;
        editor?: unknown;
      };
      if (view.file?.path === fact.path && view.editor) editing = true;
    });
    if (editing) throw Error("任务正在编辑，保存并关闭后再接管。");
    const id = crypto.randomUUID();
    await this.app.vault.process(file, (body) => {
      if (body !== expected) throw Error("文件已变化，未写入身份。");
      return body.replace(/^(---\r?\n)/, `$1taskId: ${id}\n`);
    });
    this.changed();
  }
  async open(path: string) {
    const f = this.app.vault.getAbstractFileByPath(path);
    if (!(f instanceof TFile)) throw Error("任务路径已变化，请重新核对。");
    await this.app.workspace.getLeaf(false).openFile(f);
  }
}
