const Database = require('better-sqlite3');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const DATA_DIR = path.join(ROOT, 'data');
const DB_PATH = process.env.DB_PATH || path.join(DATA_DIR, 'sri-square.db');

fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    display_name TEXT NOT NULL,
    email TEXT NOT NULL UNIQUE COLLATE NOCASE,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('admin', 'staff')),
    is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS domain_events (
    event_id TEXT PRIMARY KEY,
    aggregate_type TEXT NOT NULL,
    aggregate_id TEXT NOT NULL,
    event_type TEXT NOT NULL,
    actor_id TEXT REFERENCES users(id),
    occurred_at TEXT NOT NULL,
    request_id TEXT,
    source TEXT NOT NULL DEFAULT 'ui',
    payload TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_events_aggregate
    ON domain_events(aggregate_type, aggregate_id, occurred_at, event_id);
  CREATE INDEX IF NOT EXISTS idx_events_time
    ON domain_events(occurred_at DESC, event_id DESC);
`);

// Existing local databases predate the single-owner model. Keep historical users
// for audit attribution, but mark any non-owner identity inactive instead of deleting it.
if (!db.prepare(`PRAGMA table_info(users)`).all().some((column) => column.name === 'is_active')) {
  db.exec(`ALTER TABLE users ADD COLUMN is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1))`);
}

function isoNow() {
  return new Date().toISOString();
}

function id(prefix) {
  return `${prefix}_${crypto.randomUUID()}`;
}

function seedOwner({ displayName, email }) {
  const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
  if (existing) return existing.id;
  const userId = id('usr');
  db.prepare(`INSERT INTO users (id, display_name, email, password_hash, role, is_active, created_at)
    VALUES (?, ?, ?, ?, ?, 1, ?)`)
    .run(userId, displayName, email, 'authentication-disabled', 'admin', isoNow());
  appendEvent({
    aggregateType: 'user',
    aggregateId: userId,
    eventType: 'user.seeded',
    actorId: null,
    source: 'system',
    payload: { displayName, email, role: 'owner' }
  });
  return userId;
}

function appendEvent({ aggregateType, aggregateId, eventType, actorId = null, requestId = null, source = 'ui', payload = {} }) {
  const event = {
    eventId: id('evt'),
    aggregateType,
    aggregateId,
    eventType,
    actorId,
    occurredAt: isoNow(),
    requestId,
    source,
    payload
  };
  db.prepare(`INSERT INTO domain_events
    (event_id, aggregate_type, aggregate_id, event_type, actor_id, occurred_at, request_id, source, payload)
    VALUES (@eventId, @aggregateType, @aggregateId, @eventType, @actorId, @occurredAt, @requestId, @source, @payload)`)
    .run({ ...event, payload: JSON.stringify(payload) });
  return event;
}

function readEvents({ aggregateType, aggregateId, limit = 500 } = {}) {
  let sql = `SELECT e.*, u.display_name AS actor_name FROM domain_events e
    LEFT JOIN users u ON u.id = e.actor_id`;
  const clauses = [];
  const params = [];
  if (aggregateType) {
    clauses.push('e.aggregate_type = ?');
    params.push(aggregateType);
  }
  if (aggregateId) {
    clauses.push('e.aggregate_id = ?');
    params.push(aggregateId);
  }
  if (clauses.length) sql += ` WHERE ${clauses.join(' AND ')}`;
  sql += ' ORDER BY e.occurred_at ASC, e.event_id ASC LIMIT ?';
  params.push(Math.min(Number(limit) || 500, 100000));
  return db.prepare(sql).all(...params).map((row) => ({
    eventId: row.event_id,
    aggregateType: row.aggregate_type,
    aggregateId: row.aggregate_id,
    eventType: row.event_type,
    actorId: row.actor_id,
    actorName: row.actor_name || 'System',
    occurredAt: row.occurred_at,
    requestId: row.request_id,
    source: row.source,
    payload: JSON.parse(row.payload)
  }));
}

function eventExport() {
  return readEvents({ limit: 100000 });
}

const existingOwner = db.prepare(`SELECT id FROM users WHERE role = 'admin' ORDER BY created_at ASC, id ASC LIMIT 1`).get();
const ownerId = existingOwner?.id || seedOwner({
  displayName: 'Sri Square Owner',
  email: 'owner@srisquare.local'
});

db.transaction(() => {
  db.prepare(`UPDATE users SET display_name = ?, is_active = 1 WHERE id = ?`).run('Sri Square Owner', ownerId);
  db.prepare(`UPDATE users SET is_active = 0 WHERE id <> ?`).run(ownerId);
})();

function ownerIdentity() {
  const owner = db.prepare(`SELECT id, display_name, email FROM users WHERE id = ?`).get(ownerId);
  return { id: owner.id, displayName: owner.display_name, email: owner.email, role: 'owner' };
}

module.exports = {
  db,
  ROOT,
  DATA_DIR,
  DB_PATH,
  id,
  isoNow,
  ownerIdentity,
  appendEvent,
  readEvents,
  eventExport
};
