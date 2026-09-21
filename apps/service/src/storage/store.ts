import Database from "better-sqlite3";
import { chmodSync, existsSync, lstatSync } from "node:fs";
import { AppError } from "../errors";
import { foundation, schemaVersion } from "./migrations/001-foundation";

function matchesFoundation(db: Database.Database) {
  const expected = new Database(":memory:");
  const schema = (connection: Database.Database) =>
    connection
      .prepare(
        "SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name",
      )
      .all();
  try {
    expected.exec(foundation);
    return JSON.stringify(schema(db)) === JSON.stringify(schema(expected));
  } finally {
    expected.close();
  }
}

export class Store {
  readonly db: Database.Database;
  readonly readOnly: boolean;
  readonly sqliteVersion: string;
  constructor(path: string) {
    if (existsSync(path) && lstatSync(path).isSymbolicLink())
      throw new AppError("FORBIDDEN");
    this.db = new Database(path);
    const version = this.db.pragma("user_version", { simple: true }) as number;
    const tables = this.db
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all();
    this.readOnly =
      ![0, schemaVersion].includes(version) ||
      (version === 0 && tables.length > 0) ||
      (version === schemaVersion && !matchesFoundation(this.db));
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
    if (version === 0)
      this.db.transaction(() => this.db.exec(foundation)).immediate();
  }
  writable() {
    if (this.readOnly) throw new AppError("SCHEMA");
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
