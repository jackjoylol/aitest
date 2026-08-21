// db.js — local audit database (SQLite via better-sqlite3).
//
// Hearthkeeper's persistence story has three layers:
//   1. The Mind's Soul (platform-side memory) — the agent remembers
//      norms, users and past rulings across sessions.
//   2. The conversation history (platform-side, stable alias) — the
//      full transcript of every review, escalation and digest.
//   3. This local SQLite audit log — the creator-facing record of every
//      post, verdict, override and report, so the dashboard works even
//      when the platform is unreachable, and decisions are never lost.

import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'ok',     -- ok | warned | restricted | banned
  violations  INTEGER NOT NULL DEFAULT 0,
  first_seen  TEXT NOT NULL,
  last_seen   TEXT NOT NULL,
  notes       TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS posts (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL,
  user_name   TEXT NOT NULL,
  channel     TEXT NOT NULL DEFAULT 'general',
  text        TEXT NOT NULL,
  posted_at   TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'pending', -- pending | approved | flagged | removed | escalated
  action      TEXT,                            -- allow | flag | remove
  severity    TEXT,                            -- none | low | medium | high
  category    TEXT,                            -- spam | harassment | hate | nsfw | off-topic | misinfo | self-promo | other | none
  reason      TEXT,
  reviewed_by TEXT,                            -- mind | creator | system
  decided_at  TEXT,
  seen        INTEGER NOT NULL DEFAULT 0,      -- 已读标记: 0 未读 | 1 已读
  recalled    INTEGER NOT NULL DEFAULT 0       -- 撤回: 1 已撤回(原消息已删)
);
CREATE TABLE IF NOT EXISTS decisions (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  post_id    TEXT NOT NULL,
  action     TEXT NOT NULL,
  severity   TEXT NOT NULL,
  category   TEXT NOT NULL,
  reason     TEXT NOT NULL,
  source     TEXT NOT NULL,                    -- mind | creator-override | system
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS reports (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  kind       TEXT NOT NULL,                    -- digest | escalation
  title      TEXT NOT NULL,
  body       TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_posts_status ON posts(status);
CREATE INDEX IF NOT EXISTS idx_posts_user   ON posts(user_id);
CREATE INDEX IF NOT EXISTS idx_decisions_created ON decisions(created_at);
`;

export function openDb(dbPath) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.exec(SCHEMA);
  migrate(db);
  return db;
}

/** Add newly-introduced columns to an existing database. */
function migrate(db) {
  const cols = db.prepare("PRAGMA table_info(posts)").all().map((r) => r.name);
  if (!cols.includes("seen")) db.exec("ALTER TABLE posts ADD COLUMN seen INTEGER NOT NULL DEFAULT 0");
  if (!cols.includes("recalled")) db.exec("ALTER TABLE posts ADD COLUMN recalled INTEGER NOT NULL DEFAULT 0");
}

// ── users ───────────────────────────────────────────────────────────

export function upsertUser(db, { id, name }) {
  const row = db.prepare("SELECT * FROM users WHERE id = ?").get(id);
  const now = new Date().toISOString();
  if (row) {
    db.prepare("UPDATE users SET name = ?, last_seen = ? WHERE id = ?").run(name, now, id);
  } else {
    db.prepare("INSERT INTO users (id, name, first_seen, last_seen) VALUES (?, ?, ?, ?)").run(id, name, now, now);
  }
  return db.prepare("SELECT * FROM users WHERE id = ?").get(id);
}

export function listUsers(db, { withViolationsOnly = false } = {}) {
  const sql = withViolationsOnly
    ? "SELECT * FROM users WHERE violations > 0 ORDER BY violations DESC, last_seen DESC"
    : "SELECT * FROM users ORDER BY last_seen DESC";
  return db.prepare(sql).all();
}

/**
 * Recompute violation counts from the posts' CURRENT rulings
 * (source of truth), so overrides and re-verdicts stay consistent.
 */
export function recomputeViolations(db) {
  db.prepare("UPDATE users SET violations = 0").run();
  db.prepare(`
    UPDATE users SET violations = (
      SELECT COUNT(*) FROM posts
      WHERE posts.user_id = users.id AND posts.status IN ('flagged', 'removed')
    )
  `).run();
}

export function setUserStatus(db, userId, status, note = "") {
  const user = db.prepare("SELECT * FROM users WHERE id = ?").get(userId);
  const notes = user?.notes
    ? `${user.notes}\n[${status}] ${note}`
    : `[${status}] ${note}`;
  db.prepare("UPDATE users SET status = ?, notes = ? WHERE id = ?").run(status, notes, userId);
}

// ── posts ───────────────────────────────────────────────────────────

export function addPost(db, { id, userId, userName, channel = "general", text, postedAt = new Date().toISOString() }) {
  upsertUser(db, { id: userId, name: userName });
  // Idempotent: webhook retries with the same id must not reset a
  // post that was already ruled on.
  db.prepare(`
    INSERT INTO posts (id, user_id, user_name, channel, text, posted_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO NOTHING
  `).run(id, userId, userName, channel, text, postedAt);
  return getPost(db, id);
}

export function getPost(db, id) {
  return db.prepare("SELECT * FROM posts WHERE id = ?").get(id);
}

export function pendingPosts(db, limit = 50) {
  return db.prepare("SELECT * FROM posts WHERE status = 'pending' ORDER BY posted_at ASC LIMIT ?").all(limit);
}

export function listPosts(db, { status = null, limit = 100 } = {}) {
  const rows = status
    ? db.prepare("SELECT * FROM posts WHERE status = ? ORDER BY posted_at DESC LIMIT ?").all(status, limit)
    : db.prepare("SELECT * FROM posts ORDER BY posted_at DESC LIMIT ?").all(limit);
  return rows;
}

/** Apply a Mind/creator verdict to a post and log it in the audit trail. */
export function applyDecision(db, { postId, action, severity, category, reason, source }) {
  const post = getPost(db, postId);
  if (!post) return null;
  const status = { allow: "approved", flag: "flagged", remove: "removed" }[action] ?? "flagged";
  db.prepare(`
    UPDATE posts SET status = ?, action = ?, severity = ?, category = ?, reason = ?, reviewed_by = ?, decided_at = ?
    WHERE id = ?
  `).run(status, action, severity, category, reason, source, new Date().toISOString(), postId);
  db.prepare(`
    INSERT INTO decisions (post_id, action, severity, category, reason, source, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(postId, action, severity, category, reason, source, new Date().toISOString());
  recomputeViolations(db);
  return getPost(db, postId);
}

export function listDecisions(db, limit = 100) {
  return db.prepare(`
    SELECT d.*, p.user_name, p.user_id, p.text, p.seen, p.recalled FROM decisions d
    JOIN posts p ON p.id = d.post_id
    ORDER BY d.created_at DESC LIMIT ?
  `).all(limit);
}

/** Mark a post as "read" (seen by a moderator). Returns the post. */
export function markRead(db, postId) {
  db.prepare("UPDATE posts SET seen = 1 WHERE id = ?").run(postId);
  return getPost(db, postId);
}

/** Mark a post as "recalled" (原消息已删). Returns the post. */
export function markRecalled(db, postId) {
  db.prepare("UPDATE posts SET recalled = 1, status = 'removed' WHERE id = ?").run(postId);
  return getPost(db, postId);
}

export function decisionsInWindow(db, { sinceIso }) {
  return db.prepare("SELECT * FROM decisions WHERE created_at >= ? ORDER BY created_at ASC").all(sinceIso);
}

// ── reports ─────────────────────────────────────────────────────────

export function addReport(db, { kind, title, body }) {
  const info = db.prepare("INSERT INTO reports (kind, title, body, created_at) VALUES (?, ?, ?, ?)")
    .run(kind, title, body, new Date().toISOString());
  return db.prepare("SELECT * FROM reports WHERE id = ?").get(info.lastInsertRowid);
}

export function listReports(db, limit = 20) {
  return db.prepare("SELECT * FROM reports ORDER BY created_at DESC LIMIT ?").all(limit);
}

// ── meta / counters ─────────────────────────────────────────────────

export function getMeta(db, key, fallback = null) {
  const row = db.prepare("SELECT value FROM meta WHERE key = ?").get(key);
  return row ? row.value : fallback;
}

export function setMeta(db, key, value) {
  db.prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
}

export function counts(db) {
  const row = db.prepare(`
    SELECT
      (SELECT COUNT(*) FROM posts WHERE status = 'pending')  AS pending,
      (SELECT COUNT(*) FROM posts WHERE status = 'approved') AS approved,
      (SELECT COUNT(*) FROM posts WHERE status = 'flagged')  AS flagged,
      (SELECT COUNT(*) FROM posts WHERE status = 'removed')  AS removed,
      (SELECT COUNT(*) FROM posts)                           AS total,
      (SELECT COUNT(*) FROM decisions)                       AS decisions
  `).get();
  return row;
}

export function wipe(db) {
  // NOTE: meta (norms_sha etc.) is intentionally KEPT — wiping review
  // data must not trigger an accidental norms re-teach (a cognition
  // turn). Use the dashboard "Re-teach norms" button for that.
  db.exec("DELETE FROM decisions; DELETE FROM reports; DELETE FROM posts; DELETE FROM users;");
}
