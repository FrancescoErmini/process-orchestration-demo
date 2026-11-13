// PostgreSQL persistence for business data and the tamper-evident audit trail.
const crypto = require('crypto');
const { Pool, types } = require('pg');

// Return DATE columns as plain 'YYYY-MM-DD' strings (no timezone shifting)
types.setTypeParser(1082, (v) => v);
const config = require('./config');

const pool = new Pool({ connectionString: config.db.connectionString });

const SCHEMA = `
CREATE TABLE IF NOT EXISTS speaker_event (
  id                   SERIAL PRIMARY KEY,
  request_id           TEXT UNIQUE NOT NULL,
  process_instance_key TEXT,
  event_title          TEXT NOT NULL,
  event_date           DATE NOT NULL,
  venue                TEXT NOT NULL,
  speaker_name         TEXT NOT NULL,
  speaker_specialty    TEXT NOT NULL,
  speaker_tier         TEXT NOT NULL,
  proposed_fee         NUMERIC(10,2) NOT NULL,
  fmv_limit            NUMERIC(10,2),
  currency             TEXT NOT NULL DEFAULT 'EUR',
  justification        TEXT,
  status               TEXT NOT NULL,
  requested_by         TEXT NOT NULL,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Append-only audit trail. Each entry is chained to the previous one of the same
-- request through a SHA-256 hash, so any later modification is detectable.
CREATE TABLE IF NOT EXISTS audit_log (
  id                   BIGSERIAL PRIMARY KEY,
  request_id           TEXT NOT NULL REFERENCES speaker_event(request_id),
  process_instance_key TEXT,
  occurred_at          TIMESTAMPTZ NOT NULL,
  actor                TEXT NOT NULL,
  actor_role           TEXT NOT NULL,
  action               TEXT NOT NULL,
  summary              TEXT NOT NULL,
  details              JSONB NOT NULL DEFAULT '{}'::jsonb,
  prev_hash            TEXT NOT NULL,
  hash                 TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS audit_log_request_idx ON audit_log(request_id, id);

CREATE OR REPLACE FUNCTION audit_log_immutable() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'audit_log is append-only: % is not allowed', TG_OP;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS audit_log_no_change ON audit_log;
CREATE TRIGGER audit_log_no_change BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION audit_log_immutable();

CREATE TABLE IF NOT EXISTS notification (
  id          BIGSERIAL PRIMARY KEY,
  recipient   TEXT NOT NULL,           -- portal role: marketing / compliance / coordinator / finance
  request_id  TEXT NOT NULL,
  message     TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS payment_notification (
  id           BIGSERIAL PRIMARY KEY,
  request_id   TEXT UNIQUE NOT NULL REFERENCES speaker_event(request_id),
  payee        TEXT NOT NULL,
  amount       NUMERIC(10,2) NOT NULL,
  currency     TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'READY_FOR_RELEASE',
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS audit_report (
  id            BIGSERIAL PRIMARY KEY,
  request_id    TEXT UNIQUE NOT NULL REFERENCES speaker_event(request_id),
  delivered_to  TEXT[] NOT NULL,
  chain_valid   BOOLEAN NOT NULL,
  report        JSONB NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
`;

async function init() {
  for (let attempt = 1; ; attempt++) {
    try {
      await pool.query(SCHEMA);
      return;
    } catch (e) {
      if (attempt >= 30) throw e;
      console.log(`[db] waiting for PostgreSQL (${e.message})`);
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
}

// Deterministic JSON (sorted keys) - JSONB does not preserve key order.
function stableStringify(v) {
  if (Array.isArray(v)) return '[' + v.map(stableStringify).join(',') + ']';
  if (v && typeof v === 'object' && !(v instanceof Date)) {
    return '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + stableStringify(v[k])).join(',') + '}';
  }
  return JSON.stringify(v === undefined ? null : v);
}

function computeHash(prevHash, e) {
  const canonical = stableStringify([
    prevHash, e.request_id, new Date(e.occurred_at).toISOString(), e.actor, e.actor_role, e.action, e.summary, e.details,
  ]);
  return crypto.createHash('sha256').update(canonical).digest('hex');
}

/** Appends an entry to the hash-chained audit log of a request (serialised per request). */
async function appendAudit({ requestId, processInstanceKey, actor, actorRole, action, summary, details = {} }) {
  details = JSON.parse(JSON.stringify(details)); // normalise exactly as it will be stored
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Lock the request row so entries for the same request are chained strictly in order
    await client.query('SELECT 1 FROM speaker_event WHERE request_id = $1 FOR UPDATE', [requestId]);
    const last = await client.query(
      'SELECT hash FROM audit_log WHERE request_id = $1 ORDER BY id DESC LIMIT 1', [requestId]);
    const prevHash = last.rows[0] ? last.rows[0].hash : 'GENESIS';
    const entry = {
      request_id: requestId,
      occurred_at: new Date(),
      actor,
      actor_role: actorRole,
      action,
      summary,
      details,
    };
    const hash = computeHash(prevHash, entry);
    const { rows } = await client.query(
      `INSERT INTO audit_log (request_id, process_instance_key, occurred_at, actor, actor_role, action, summary, details, prev_hash, hash)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [requestId, processInstanceKey || null, entry.occurred_at, actor, actorRole, action, summary, details, prevHash, hash]);
    await client.query('COMMIT');
    return rows[0];
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

async function getAuditTrail(requestId) {
  const { rows } = await pool.query('SELECT * FROM audit_log WHERE request_id = $1 ORDER BY id', [requestId]);
  return rows;
}

/** Recomputes the hash chain; returns { valid, brokenAt }. */
function verifyChain(entries) {
  let prev = 'GENESIS';
  for (const e of entries) {
    if (e.prev_hash !== prev || computeHash(prev, e) !== e.hash) return { valid: false, brokenAt: e.id };
    prev = e.hash;
  }
  return { valid: true, brokenAt: null };
}

async function nextRequestId() {
  const year = new Date().getFullYear();
  const { rows } = await pool.query(
    "SELECT count(*)::int AS n FROM speaker_event WHERE request_id LIKE $1", [`HCP-${year}-%`]);
  return `HCP-${year}-${String(rows[0].n + 1).padStart(4, '0')}`;
}

module.exports = { pool, init, appendAudit, getAuditTrail, verifyChain, nextRequestId };
