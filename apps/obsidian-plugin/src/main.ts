import { TaskNotesAdapter } from "./tasknotes/adapter";
import { renderToday } from "./views/today";
import { renderPlanReview } from "./views/plan-review";
import { syncPlanNotes } from "./views/plan-notes";
import { renderResearch } from "./views/research";
import { renderReview, syncWikiObservations } from "./views/review";
import { renderSearch } from "./views/search";
import { renderIngestion } from "./views/ingestion";
import { obsidianHost } from "./writer/apply";
import {
  FileSystemAdapter,
  Plugin,
  PluginSettingTab,
  requestUrl,
} from "obsidian";
import { Connection } from "./connection";
import { renderSettings } from "./views/settings";
import { renderLearning } from "./views/learning";
import { renderReminders } from "./views/reminders";
export default class KnowledgeTaskPlugin extends Plugin {
  connection!: Connection;
  tasks!: TaskNotesAdapter;
  drafts = { budget: "" };
  searchDraft = { query: "", version: "", collection: "" };
  ingestionDraft = {
    fields: {},
    previewId: crypto.randomUUID(),
    signature: "",
  };
  async onload() {
    if (!(this.app.vault.adapter instanceof FileSystemAdapter)) return;
    const data = (await this.loadData()) as { deviceId?: string } | null;
    const deviceId =
      data?.deviceId && /^[a-f0-9-]{36}$/.test(data.deviceId)
        ? data.deviceId
        : crypto.randomUUID();
    await this.saveData({ deviceId });
    this.connection = new Connection(
      async (url, options) => {
        const response = await requestUrl({ url, ...options, throw: false });
        return { status: response.status, json: response.json };
      },
      this.app.vault.adapter.getBasePath(),
      deviceId,
    );
    this.tasks = new TaskNotesAdapter(this.app, this.connection);
    this.registerEvent(this.app.vault.on("create", () => this.tasks.changed()));
    this.registerEvent(this.app.vault.on("modify", () => this.tasks.changed()));
    this.registerEvent(this.app.vault.on("delete", () => this.tasks.changed()));
    this.registerEvent(this.app.vault.on("rename", () => this.tasks.changed()));
    this.registerInterval(
      window.setInterval(() => {
        void this.tasks.sync();
      }, 1500),
    );
    let projectingPlan = false;
    this.registerInterval(
      window.setInterval(() => {
        if (
          projectingPlan ||
          !this.connection.principal ||
          this.connection.workspace?.deviceId !== this.connection.deviceId
        )
          return;
        projectingPlan = true;
        void syncPlanNotes(
          this.connection,
          obsidianHost(this.app, this.connection.vaultPath),
        )
          .catch(() => {})
          .finally(() => {
            projectingPlan = false;
          });
      }, 15000),
    );
    this.addSettingTab(new GovernanceSettings(this));
    this.registerInterval(
      window.setInterval(() => {
        if (this.connection.principal)
          void this.connection.heartbeat().catch(() => {});
      }, 15_000),
    );
    let observing = false;
    this.registerInterval(
      window.setInterval(() => {
        if (
          observing ||
          !this.connection.principal ||
          this.connection.workspace?.deviceId !== this.connection.deviceId
        )
          return;
        observing = true;
        void syncWikiObservations(
          this.connection,
          obsidianHost(this.app, this.connection.vaultPath),
        )
          .catch(() => {})
          .finally(() => {
            observing = false;
          });
      }, 15000),
    );
    this.addCommand({
      id: "open-governance",
      name: "打开运行治理",
      callback: () => {
        const settings = this.app as unknown as {
          setting: { open: () => void; openTabById: (id: string) => void };
        };
        settings.setting.open();
        settings.setting.openTabById(this.manifest.id);
      },
    });
  }
  onunload() {
    if (this.connection?.principal)
      void this.connection.disconnect().catch(() => {});
  }
}
class GovernanceSettings extends PluginSettingTab {
  constructor(private plugin: KnowledgeTaskPlugin) {
    super(plugin.app, plugin);
  }
  display() {
    renderSettings(
      this.containerEl,
      this.plugin.connection,
      this.plugin.drafts,
    );
    const ingestion = document.createElement("section");
    this.containerEl.append(ingestion);
    const search = document.createElement("section");
    renderIngestion(
      ingestion,
      this.plugin.connection,
      obsidianHost(this.app, this.plugin.connection.vaultPath),
      this.plugin.ingestionDraft,
    );
    this.containerEl.append(search);
    renderSearch(search, this.plugin.connection, this.plugin.searchDraft);
    const review = document.createElement("section");
    this.containerEl.append(review);
    const research = document.createElement("section");
    this.containerEl.append(research);
    renderResearch(research, this.plugin.connection);
    const learning = document.createElement("section");
    this.containerEl.append(learning);
    const learningView = renderLearning(learning, this.plugin.connection);
    const today = document.createElement("section");
    this.containerEl.append(today);
    renderToday(
      today,
      this.plugin.connection,
      this.plugin.tasks,
      learningView.resume,
    );
    const planning = document.createElement("section");
    this.containerEl.append(planning);
    renderPlanReview(planning, this.plugin.connection, this.plugin.tasks);
    const reminders = document.createElement("section");
    this.containerEl.append(reminders);
    renderReminders(reminders, this.plugin.connection);
    renderReview(
      review,
      this.plugin.connection,
      obsidianHost(this.app, this.plugin.connection.vaultPath),
    );
  }
}
