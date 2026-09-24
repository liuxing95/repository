import { expect, test } from "vitest";
import { copyFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../../apps/service/src/storage/store";
import { ReminderDispatcher } from "../../apps/service/src/reminders/dispatcher";

test("数据库及同目录栅栏一起回滚时，外部锚点仍阻止旧提醒重发", async () => {
  const root = await mkdtemp(join(tmpdir(), "kb-reminder-restore-"));
  const data = join(root, "data");
  await mkdir(data);
  const path = join(data, "state.db");
  try {
    const store = new Store(path);
    store.tx(() => store.advanceReminderFence());
    store.db.prepare("VACUUM INTO ?").run(join(root, "old.db"));
    await copyFile(store.reminderFencePath, join(root, "old-fence"));
    store.tx(() => store.advanceReminderFence());
    store.close();
    const matching = new Store(path);
    expect(matching.reminderPaused).toBe(false);
    matching.close();
    await copyFile(join(root, "old.db"), path);
    await copyFile(join(root, "old-fence"), store.reminderFencePath);
    const restored = new Store(path);
    try {
      expect(restored.reminderPaused).toBe(true);
      expect(() => restored.advanceReminderFence()).toThrow();
      let calls = 0;
      await new ReminderDispatcher(restored, async () => {
        calls++;
        return "accepted";
      }).tick();
      expect(calls).toBe(0);
    } finally {
      restored.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
