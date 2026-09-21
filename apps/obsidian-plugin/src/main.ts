import {
  FileSystemAdapter,
  Plugin,
  PluginSettingTab,
  requestUrl,
} from "obsidian";
import { Connection } from "./connection";
import { renderSettings } from "./views/settings";
export default class KnowledgeTaskPlugin extends Plugin {
  connection!: Connection;
  drafts = { budget: "" };
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
    this.addSettingTab(new GovernanceSettings(this));
    this.registerInterval(
      window.setInterval(() => {
        if (this.connection.principal)
          void this.connection.heartbeat().catch(() => {});
      }, 15_000),
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
  }
}
