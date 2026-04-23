// SQLite database layer for mcp-registry-mcp
// DB location: ~/.mcp-registry-mcp/registry.db

import Database from 'better-sqlite3';
import { mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const DB_DIR = join(homedir(), '.mcp-registry-mcp');
const DB_PATH = join(DB_DIR, 'registry.db');

let _db = null;

export function getDb() {
  if (_db) return _db;

  if (!existsSync(DB_DIR)) {
    mkdirSync(DB_DIR, { recursive: true });
  }

  _db = new Database(DB_PATH);

  // WAL mode for better concurrent read performance
  _db.pragma('journal_mode = WAL');
  _db.pragma('foreign_keys = ON');

  _db.exec(`
    CREATE TABLE IF NOT EXISTS servers (
      server_id    TEXT PRIMARY KEY,
      name         TEXT NOT NULL,
      url          TEXT NOT NULL,
      transport    TEXT NOT NULL DEFAULT 'stdio',
      description  TEXT NOT NULL DEFAULT '',
      org_id       TEXT NOT NULL DEFAULT 'default',
      version      TEXT NOT NULL DEFAULT '',
      status       TEXT NOT NULL DEFAULT 'unknown',
      last_check   TEXT,
      health_json  TEXT NOT NULL DEFAULT '{}',
      registered_at TEXT NOT NULL,
      tags_json    TEXT NOT NULL DEFAULT '[]'
    );

    CREATE TABLE IF NOT EXISTS health_checks (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      server_id   TEXT NOT NULL,
      status      TEXT NOT NULL,
      latency_ms  REAL,
      checked_at  TEXT NOT NULL,
      error       TEXT
    );

    CREATE TABLE IF NOT EXISTS duplicates (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      server_a         TEXT NOT NULL,
      server_b         TEXT NOT NULL,
      similarity_score REAL NOT NULL,
      detected_at      TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_servers_server_id      ON servers(server_id);
    CREATE INDEX IF NOT EXISTS idx_servers_org_id         ON servers(org_id);
    CREATE INDEX IF NOT EXISTS idx_servers_url            ON servers(url);
    CREATE INDEX IF NOT EXISTS idx_health_checks_server_id ON health_checks(server_id);
    CREATE INDEX IF NOT EXISTS idx_health_checks_checked_at ON health_checks(checked_at);
    CREATE INDEX IF NOT EXISTS idx_duplicates_server_a    ON duplicates(server_a);
    CREATE INDEX IF NOT EXISTS idx_duplicates_server_b    ON duplicates(server_b);
  `);

  return _db;
}

// Close the DB connection (useful for tests)
export function closeDb() {
  if (_db) {
    _db.close();
    _db = null;
  }
}

// Override DB path for testing
export function setDbPath(customPath) {
  closeDb();
  const dir = customPath.replace(/\/[^/]+$/, '');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  _db = new Database(customPath);
  _db.pragma('journal_mode = WAL');
  _db.pragma('foreign_keys = ON');
  _db.exec(`
    CREATE TABLE IF NOT EXISTS servers (
      server_id    TEXT PRIMARY KEY,
      name         TEXT NOT NULL,
      url          TEXT NOT NULL,
      transport    TEXT NOT NULL DEFAULT 'stdio',
      description  TEXT NOT NULL DEFAULT '',
      org_id       TEXT NOT NULL DEFAULT 'default',
      version      TEXT NOT NULL DEFAULT '',
      status       TEXT NOT NULL DEFAULT 'unknown',
      last_check   TEXT,
      health_json  TEXT NOT NULL DEFAULT '{}',
      registered_at TEXT NOT NULL,
      tags_json    TEXT NOT NULL DEFAULT '[]'
    );

    CREATE TABLE IF NOT EXISTS health_checks (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      server_id   TEXT NOT NULL,
      status      TEXT NOT NULL,
      latency_ms  REAL,
      checked_at  TEXT NOT NULL,
      error       TEXT
    );

    CREATE TABLE IF NOT EXISTS duplicates (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      server_a         TEXT NOT NULL,
      server_b         TEXT NOT NULL,
      similarity_score REAL NOT NULL,
      detected_at      TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_servers_server_id      ON servers(server_id);
    CREATE INDEX IF NOT EXISTS idx_servers_org_id         ON servers(org_id);
    CREATE INDEX IF NOT EXISTS idx_servers_url            ON servers(url);
    CREATE INDEX IF NOT EXISTS idx_health_checks_server_id ON health_checks(server_id);
    CREATE INDEX IF NOT EXISTS idx_health_checks_checked_at ON health_checks(checked_at);
    CREATE INDEX IF NOT EXISTS idx_duplicates_server_a    ON duplicates(server_a);
    CREATE INDEX IF NOT EXISTS idx_duplicates_server_b    ON duplicates(server_b);
  `);
  return _db;
}
