import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

export class Store {
  constructor(filename, maxQueued = 1000) {
    mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(filename);
    this.maxQueued = maxQueued;
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS auth (type TEXT NOT NULL, id TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY(type,id));
      CREATE TABLE IF NOT EXISTS posts (
        id TEXT PRIMARY KEY, chat TEXT NOT NULL, message INTEGER NOT NULL, payload TEXT NOT NULL,
        wa_id TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0,
        next_at INTEGER NOT NULL DEFAULT 0, created INTEGER NOT NULL, sent INTEGER, error TEXT,
        converted TEXT);
      CREATE INDEX IF NOT EXISTS posts_ready ON posts(state,next_at,created);`);
  }
  get(key, fallback = null) {
    const row = this.db.prepare('SELECT value FROM settings WHERE key=?').get(key);
    return row ? JSON.parse(row.value) : fallback;
  }
  set(key, value) { this.db.prepare('INSERT OR REPLACE INTO settings VALUES (?,?)').run(key, JSON.stringify(value)); }
  enqueue(chat, message, payload) {
    const id = `${chat}:${message}`;
    if (this.db.prepare('SELECT id FROM posts WHERE id=?').get(id)) return false;
    if (this.db.prepare("SELECT COUNT(*) AS n FROM posts WHERE state IN ('pending','failed')").get().n >= this.maxQueued) {
      throw new Error('Outbox full: source cursor retained for recovery');
    }
    const waId = '3EB0' + createHash('sha256').update(id).digest('hex').slice(0, 28).toUpperCase();
    this.db.prepare('INSERT INTO posts(id,chat,message,payload,wa_id,created) VALUES (?,?,?,?,?,?)')
      .run(id, chat, message, JSON.stringify(payload), waId, Date.now());
    return true;
  }
  next(now = Date.now()) {
    const row = this.db.prepare("SELECT * FROM posts WHERE state='pending' AND next_at<=? ORDER BY created,message LIMIT 1").get(now);
    return row ? { ...row, payload: JSON.parse(row.payload) } : null;
  }
  converted(id, text) { this.db.prepare('UPDATE posts SET converted=? WHERE id=?').run(text, id); }
  delivered(id) { this.db.prepare("UPDATE posts SET state='sent',sent=?,error=NULL,payload='{}' WHERE id=?").run(Date.now(), id); }
  skipped(id, reason) { this.db.prepare("UPDATE posts SET state='skipped',sent=?,error=?,payload='{}' WHERE id=?").run(Date.now(), reason, id); }
  failed(id, error, retryAfterMs = 0) {
    const row = this.db.prepare('SELECT attempts FROM posts WHERE id=?').get(id);
    const attempts = row.attempts + 1;
    const delay = Math.max(retryAfterMs, Math.min(300000, 2000 * 2 ** (attempts - 1)));
    this.db.prepare('UPDATE posts SET attempts=?,next_at=?,error=?,state=? WHERE id=?')
      .run(attempts, Date.now() + delay, String(error).slice(0, 300), attempts >= 8 ? 'failed' : 'pending', id);
  }
  retryFailed() { return this.db.prepare("UPDATE posts SET state='pending',attempts=0,next_at=0 WHERE state='failed'").run().changes; }
  stats() {
    const counts = { pending: 0, sent: 0, failed: 0, skipped: 0 };
    for (const row of this.db.prepare('SELECT state,COUNT(*) AS n FROM posts GROUP BY state').all()) counts[row.state] = row.n;
    return { ...counts, recent: this.db.prepare('SELECT id,state,attempts,error,created,sent FROM posts ORDER BY created DESC LIMIT 12').all() };
  }
  prune() {
    // Retain 30 days of delivered IDs; an entire reconnect never replays older history.
    this.db.prepare("DELETE FROM posts WHERE state IN ('sent','skipped') AND sent<?").run(Date.now() - 30 * 86400000);
    this.db.exec('PRAGMA wal_checkpoint(PASSIVE)');
  }
  authGet(type, id) { return this.db.prepare('SELECT value FROM auth WHERE type=? AND id=?').get(type, id)?.value; }
  authSetMany(entries) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const [type, id, value] of entries) {
        if (value === null) this.db.prepare('DELETE FROM auth WHERE type=? AND id=?').run(type, id);
        else this.db.prepare('INSERT OR REPLACE INTO auth VALUES (?,?,?)').run(type, id, value);
      }
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  close() { this.db.close(); }
}
