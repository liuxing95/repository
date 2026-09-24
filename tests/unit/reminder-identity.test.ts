import { expect, test } from "vitest";
import {
  deliveryKey,
  inQuietHours,
  reminderKey,
  resolveWall,
} from "../../apps/service/src/reminders/identity";

test("逻辑身份与投递身份分离；晨间文案变化不生成新投递", () => {
  const key = reminderKey("device", "rule", "2026-09-24");
  expect(reminderKey("device", "rule", "2026-09-24")).toBe(key);
  expect(reminderKey("device", "rule", "2026-09-25")).not.toBe(key);
  expect(deliveryKey(key, 1, false)).toBe(deliveryKey(key, 2, false));
  expect(deliveryKey(key, 2, true)).not.toBe(deliveryKey(key, 1, true));
});

test("夏令时缺失小时跳过，重复小时选择第一次；跨午夜勿扰", () => {
  expect(resolveWall("2026-03-08", "02:30", "America/New_York")).toBeNull();
  expect(resolveWall("2026-11-01", "01:30", "America/New_York")).toBe(
    Date.parse("2026-11-01T05:30:00Z"),
  );
  expect(inQuietHours("23:00", "22:00", "07:00")).toBe(true);
  expect(inQuietHours("06:30", "22:00", "07:00")).toBe(true);
  expect(inQuietHours("12:00", "22:00", "07:00")).toBe(false);
});
