import { research } from "./migrations/005-research";
import { tasks } from "./migrations/007-tasks";
import { planning } from "./migrations/008-planning";
import { reminders } from "./migrations/009-reminders";
import { learning } from "./migrations/006-learning";
import { createHash, randomUUID } from "node:crypto";
import { sources } from "./migrations/002-sources";
import { changesets } from "./migrations/004-changesets";
import { evidence } from "./migrations/003-evidence";
import Database from "better-sqlite3";
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { AppError } from "../errors";
import { dirname, join, resolve } from "node:path";
import { foundation } from "./migrations/001-foundation";

export function matchesSchema(db: Database.Database, version: number) {
  const expected = new Database(":memory:");
  const schema = (connection: Database.Database) =>
    connection
      .prepare(
        "SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name",
      )
      .all();
  try {
    expected.exec(foundation);
    if (version >= 2) expected.exec(sources);
    if (version >= 3) expected.exec(evidence);
    if (version >= 4) expected.exec(changesets);
    if (version >= 5) expected.exec(research);
    if (version >= 6) expected.exec(learning);
    if (version >= 7) expected.exec(tasks);
    if (version >= 8) expected.exec(planning);
    if (version >= 9) expected.exec(reminders);
    return JSON.stringify(schema(db)) === JSON.stringify(schema(expected));
  } finally {
    expected.close();
  }
}

export class Store {
  readonly db: Database.Database;
  readonly readOnly: boolean;
  readonly sqliteVersion: string;
  readonly reminderFencePath: string;
  readonly reminderAnchorPath: string;
  readonly restoreHoldPath: string;
  reminderPaused = false;
  constructor(path: string) {
    if (existsSync(path) && lstatSync(path).isSymbolicLink())
      throw new AppError("FORBIDDEN");
    this.db = new Database(path);
    this.restoreHoldPath = `${path}.restore-hold`;
    this.reminderFencePath = `${path}.reminder-fence`;
    this.reminderAnchorPath = join(
      dirname(dirname(resolve(path))),
      `.kb-reminder-anchor-${createHash("sha256").update(resolve(path)).digest("hex").slice(0, 24)}`,
    );
    const version = this.db.pragma("user_version", { simple: true }) as number;
    const tables = this.db
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all();
    this.readOnly =
      ![0, 1, 2, 3, 4, 5, 6, 7, 8, 9].includes(version) ||
      (version === 0 && tables.length > 0) ||
      (version > 0 && !matchesSchema(this.db, version));
    this.sqliteVersion = (
      this.db.prepare("SELECT sqlite_version() AS v").get() as { v: string }
    ).v;
    const [major = 0, minor = 0, patch = 0] = this.sqliteVersion
      .split(".")
      .map(Number);
    if (
      major < 3 ||
      (major === 3 && (minor < 51 || (minor === 51 && patch < 3)))
    ) {
      this.db.close();
      throw new AppError("SQLITE_VERSION");
    }
    if (this.readOnly) {
      this.db.pragma("query_only = ON");
      return;
    }
    chmodSync(path, 0o600);
    this.db.pragma("foreign_keys = ON");
    this.db.pragma("busy_timeout = 3000");
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("synchronous = FULL");
    if (version === 1) {
      const backup = `${path}.before-v2-${randomUUID()}`;
      this.db.prepare("VACUUM INTO ?").run(backup);
      chmodSync(backup, 0o600);
    }
    if (version < 2)
      this.db
        .transaction(() => {
          if (version === 0) this.db.exec(foundation);
          this.db.exec(sources);
        })
        .immediate();
    if (version > 0 && version < 3) {
      const backup = `${path}.before-v3-${randomUUID()}`;
      this.db.prepare("VACUUM INTO ?").run(backup);
      chmodSync(backup, 0o600);
    }
    if (version < 3)
      this.db.transaction(() => this.db.exec(evidence)).immediate();
    if (version > 0 && version < 4) {
      const backup = `${path}.before-v4-${randomUUID()}`;
      this.db.prepare("VACUUM INTO ?").run(backup);
      chmodSync(backup, 0o600);
    }
    if (version < 4)
      this.db.transaction(() => this.db.exec(changesets)).immediate();
    if (version > 0 && version < 5) {
      const backup = `${path}.before-v5-${randomUUID()}`;
      this.db.prepare("VACUUM INTO ?").run(backup);
      chmodSync(backup, 0o600);
    }
    if (version < 5)
      this.db.transaction(() => this.db.exec(research)).immediate();
    if (version > 0 && version < 6) {
      const backup = `${path}.before-v6-${randomUUID()}`;
      this.db.prepare("VACUUM INTO ?").run(backup);
      chmodSync(backup, 0o600);
    }
    if (version < 6)
      this.db.transaction(() => this.db.exec(learning)).immediate();
    if (version > 0 && version < 7) {
      const backup = `${path}.before-v7-${randomUUID()}`;
      this.db.prepare("VACUUM INTO ?").run(backup);
      chmodSync(backup, 0o600);
    }
    if (version < 7) this.db.transaction(() => this.db.exec(tasks)).immediate();
    if (version > 0 && version < 8) {
      const backup = `${path}.before-v8-${randomUUID()}`;
      this.db.prepare("VACUUM INTO ?").run(backup);
      chmodSync(backup, 0o600);
    }
    if (version < 8)
      this.db.transaction(() => this.db.exec(planning)).immediate();
    if (version > 0 && version < 9) {
      const backup = `${path}.before-v9-${randomUUID()}`;
      this.db.prepare("VACUUM INTO ?").run(backup);
      chmodSync(backup, 0o600);
    }
    if (version < 9)
      this.db.transaction(() => this.db.exec(reminders)).immediate();
    this.checkReminderFence();
  }
  private fenceOnDisk(path: string) {
    if (!existsSync(path)) return 0;
    if (lstatSync(path).isSymbolicLink()) return NaN;
    const raw = readFileSync(path, "utf8");
    const n = Number(raw);
    return /^\d+$/.test(raw) && Number.isSafeInteger(n) ? n : NaN;
  }
  private checkReminderFence() {
    const dbValue = Number(
      (
        this.db
          .prepare("SELECT value FROM reminder_meta WHERE key='fence'")
          .get() as { value: string }
      ).value,
    );
    const diskValue = this.fenceOnDisk(this.reminderFencePath);
    const anchorValue = this.fenceOnDisk(this.reminderAnchorPath);
    this.reminderPaused =
      !Number.isSafeInteger(diskValue) ||
      !Number.isSafeInteger(anchorValue) ||
      diskValue !== dbValue ||
      anchorValue !== dbValue;
  }
  advanceReminderFence() {
    this.writable();
    if (this.reminderPaused)
      throw new AppError(
        "CONFLICT",
        409,
        "提醒账本比外部发送栅栏旧；暂停发送，先人工核对恢复。",
      );
    const dbValue = Number(
      (
        this.db
          .prepare("SELECT value FROM reminder_meta WHERE key='fence'")
          .get() as { value: string }
      ).value,
    );
    const diskValue = this.fenceOnDisk(this.reminderFencePath);
    const anchorValue = this.fenceOnDisk(this.reminderAnchorPath);
    if (diskValue !== dbValue || anchorValue !== dbValue) {
      this.reminderPaused = true;
      throw new AppError(
        "CONFLICT",
        409,
        "提醒账本、发送栅栏与本机锚点不一致；暂停提醒。",
      );
    }
    const next = dbValue + 1;
    this.persistFence(this.reminderFencePath, next);
    this.persistFence(this.reminderAnchorPath, next);
    this.db
      .prepare("UPDATE reminder_meta SET value=? WHERE key='fence'")
      .run(String(next));
  }
  private persistFence(path: string, next: number) {
    const tmp = `${path}.${randomUUID()}`;
    writeFileSync(tmp, String(next), { mode: 0o600, flag: "wx" });
    const fd = openSync(tmp, "r");
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, path);
    const directory = openSync(dirname(path), "r");
    try {
      fsyncSync(directory);
    } finally {
      closeSync(directory);
    }
  }
  writable() {
    if (this.readOnly) throw new AppError("SCHEMA");
    if (this.restoreHeld)
      throw new AppError(
        "CONFLICT",
        409,
        "恢复副本仍在维护核对中，写入和发送已暂停。",
      );
  }
  get restoreHeld() {
    return existsSync(this.restoreHoldPath);
  }
  tx<T>(fn: () => T): T {
    this.writable();
    return this.db.transaction(fn).immediate();
  }
  get(key: string): unknown {
    const row = this.db.prepare("SELECT value FROM kv WHERE key=?").get(key) as
      { value: string } | undefined;
    return row ? JSON.parse(row.value) : undefined;
  }
  set(key: string, value: unknown) {
    this.writable();
    this.db
      .prepare(
        "INSERT INTO kv VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      )
      .run(key, JSON.stringify(value));
  }
  event(kind: string, entityId: string, now = Date.now()) {
    this.writable();
    this.db
      .prepare("INSERT INTO events(kind,entity_id,at) VALUES (?,?,?)")
      .run(kind, entityId, now);
  }
  close() {
    this.db.close();
  }
}
