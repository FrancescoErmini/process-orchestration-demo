// HCP Speaker Event Governance portal: role-based UI + REST API on top of Camunda 8.
const crypto = require('crypto');
const path = require('path');
const express = require('express');
const config = require('./config');
const camunda = require('./camunda');
const db = require('./db');
const workers = require('./workers');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

// ------------------------------------------------------------------ sessions (in-memory, demo only)
const sessions = new Map();

function readSid(req) {
  const m = /(?:^|;\s*)sid=([a-f0-9]+)/.exec(req.headers.cookie || '');
  return m && m[1];
}

function auth(req, res, next) {
  const s = sessions.get(readSid(req));
  if (!s) return res.status(401).json({ error: 'Not logged in' });
  req.user = s;
  next();
}

function requireRole(...roles) {
  return (req, res, next) =>
    roles.includes(req.user.role) || req.user.role === 'admin'
      ? next()
      : res.status(403).json({ error: `This action requires role: ${roles.join(' / ')}` });
}

const wrap = (fn) => (req, res) =>
  fn(req, res).catch((e) => {
    console.error(`[api] ${req.method} ${req.path}:`, e.message);
    res.status(e.status && e.status < 600 ? e.status : 500).json({ error: e.message });
  });

app.post('/api/login', wrap(async (req, res) => {
  const { username, password } = req.body || {};
  const persona = config.personas[username];
  if (!persona) return res.status(401).json({ error: 'Unknown demo user' });
  try {
    await camunda.whoAmI({ username, password }); // credentials are verified by Camunda identity
  } catch (e) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }
  const sid = crypto.randomBytes(24).toString('hex');
  sessions.set(sid, { username, password, ...persona });
  res.setHeader('Set-Cookie', `sid=${sid}; HttpOnly; Path=/; SameSite=Lax`);
  res.json({ username, ...persona });
}));

app.post('/api/logout', (req, res) => {
  sessions.delete(readSid(req));
  res.setHeader('Set-Cookie', 'sid=; Path=/; Max-Age=0');
  res.json({ ok: true });
});

app.get('/api/config', (req, res) => {
  res.json({
    camundaUrl: config.camunda.publicUrl,
    fmvLimits: config.fmvLimits,
    personas: Object.entries(config.personas).map(([username, p]) => ({ username, ...p })),
  });
});

app.get('/api/me', auth, (req, res) => {
  const { password, ...u } = req.user;
  res.json(u);
});

const creds = (req) => ({ username: req.user.username, password: req.user.password });

// ------------------------------------------------------------------ requests

app.get('/api/requests', auth, wrap(async (req, res) => {
  const { rows } = await db.pool.query('SELECT * FROM speaker_event ORDER BY id DESC');
  res.json(rows);
}));

app.get('/api/requests/:id', auth, wrap(async (req, res) => {
  const { rows } = await db.pool.query('SELECT * FROM speaker_event WHERE request_id = $1', [req.params.id]);
  if (!rows[0]) return res.status(404).json({ error: 'Request not found' });
  const audit = await db.getAuditTrail(req.params.id);
  const payment = (await db.pool.query('SELECT * FROM payment_notification WHERE request_id = $1', [req.params.id])).rows[0] || null;
  const report = (await db.pool.query('SELECT id, delivered_to, chain_valid, created_at FROM audit_report WHERE request_id = $1', [req.params.id])).rows[0] || null;
  res.json({ request: rows[0], audit, chain: db.verifyChain(audit), payment, report });
}));

app.post('/api/requests', auth, requireRole('marketing'), wrap(async (req, res) => {
  const b = req.body || {};
  const required = ['eventTitle', 'eventDate', 'venue', 'speakerName', 'speakerSpecialty', 'speakerTier', 'proposedFee'];
  const missing = required.filter((k) => b[k] === undefined || b[k] === '');
  if (missing.length) return res.status(400).json({ error: `Missing fields: ${missing.join(', ')}` });
  if (!config.fmvLimits[b.speakerTier]) return res.status(400).json({ error: 'Unknown speaker tier' });
  const fee = Number(b.proposedFee);
  if (!(fee > 0)) return res.status(400).json({ error: 'Proposed fee must be a positive number' });

  const requestId = await db.nextRequestId();
  await db.pool.query(
    `INSERT INTO speaker_event (request_id, event_title, event_date, venue, speaker_name, speaker_specialty,
       speaker_tier, proposed_fee, justification, status, requested_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'SUBMITTED',$10)`,
    [requestId, b.eventTitle, b.eventDate, b.venue, b.speakerName, b.speakerSpecialty, b.speakerTier, fee,
      b.justification || null, req.user.username]);
  await db.appendAudit({
    requestId,
    actor: req.user.username,
    actorRole: req.user.role,
    action: 'REQUEST_SUBMITTED',
    summary: `Speaker engagement request submitted for ${b.speakerName} with a proposed fee of €${fee.toLocaleString('en-US')}`,
    details: { ...b, proposedFee: fee },
  });

  const variables = {
    requestId,
    eventTitle: b.eventTitle,
    eventDate: b.eventDate,
    venue: b.venue,
    speakerName: b.speakerName,
    speakerSpecialty: b.speakerSpecialty,
    speakerTier: b.speakerTier,
    proposedFee: fee,
    currency: 'EUR',
    justification: b.justification || '',
    requestedBy: req.user.username,
  };
  const pi = await camunda.startProcess(config.processId, variables, creds(req));
  await db.pool.query('UPDATE speaker_event SET process_instance_key = $2 WHERE request_id = $1',
    [requestId, String(pi.processInstanceKey)]);
  res.status(201).json({ requestId, processInstanceKey: pi.processInstanceKey });
}));

app.get('/api/requests/:id/audit.csv', auth, wrap(async (req, res) => {
  const rows = await db.getAuditTrail(req.params.id);
  const esc = (s) => `"${String(s ?? '').replace(/"/g, '""')}"`;
  const lines = ['timestamp,actor,role,action,summary,details,prev_hash,hash'];
  for (const r of rows) {
    lines.push([r.occurred_at.toISOString(), r.actor, r.actor_role, r.action, r.summary, JSON.stringify(r.details), r.prev_hash, r.hash].map(esc).join(','));
  }
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', `attachment; filename="${req.params.id}-audit-trail.csv"`);
  res.send(lines.join('\n'));
}));

app.get('/api/requests/:id/audit-report.json', auth, requireRole('compliance', 'finance'), wrap(async (req, res) => {
  const { rows } = await db.pool.query('SELECT report FROM audit_report WHERE request_id = $1', [req.params.id]);
  if (!rows[0]) return res.status(404).json({ error: 'Audit report not delivered yet (process not closed)' });
  res.setHeader('Content-Disposition', `attachment; filename="${req.params.id}-audit-report.json"`);
  res.json(rows[0].report);
}));

// ------------------------------------------------------------------ user tasks (Camunda)

function taskView(t, vars) {
  return {
    key: t.userTaskKey,
    elementId: t.elementId,
    name: t.name,
    assignee: t.assignee,
    candidateGroups: t.candidateGroups,
    created: t.creationDate,
    processInstanceKey: t.processInstanceKey,
    variables: vars,
  };
}

app.get('/api/tasks', auth, wrap(async (req, res) => {
  const filter = { state: 'CREATED', processDefinitionId: config.processId };
  if (req.user.role !== 'admin') {
    if (!req.user.group) return res.json([]);
    filter.candidateGroup = req.user.group;
  }
  const result = await camunda.searchUserTasks(filter);
  const tasks = await Promise.all((result.items || []).map(async (t) =>
    taskView(t, await camunda.getUserTaskVariables(t.userTaskKey))));
  res.json(tasks);
}));

app.get('/api/tasks/:key', auth, wrap(async (req, res) => {
  const t = await camunda.getUserTask(req.params.key);
  const vars = await camunda.getUserTaskVariables(req.params.key);
  const audit = vars.requestId ? await db.getAuditTrail(vars.requestId) : [];
  res.json({ ...taskView(t, vars), state: t.state, audit });
}));

app.post('/api/tasks/:key/complete', auth, wrap(async (req, res) => {
  const variables = (req.body && req.body.variables) || {};
  // Claim the task for the logged-in user, then complete it with *their* Camunda credentials
  await camunda.assignUserTask(req.params.key, req.user.username, creds(req));
  try {
    await camunda.completeUserTask(req.params.key, variables, creds(req));
  } catch (e) {
    // A task listener denial (business rule / segregation of duties) comes back as an error
    const m = /Reason to deny: '([\s\S]*)'/.exec(e.message);
    return res.status(409).json({ error: m ? m[1] : e.message, deniedByEngine: Boolean(m) });
  }
  res.json({ ok: true });
}));

// ------------------------------------------------------------------ notifications & finance

app.get('/api/notifications', auth, wrap(async (req, res) => {
  const { rows } = req.user.role === 'admin'
    ? await db.pool.query('SELECT * FROM notification ORDER BY id DESC LIMIT 30')
    : await db.pool.query('SELECT * FROM notification WHERE recipient = $1 ORDER BY id DESC LIMIT 30', [req.user.role]);
  res.json(rows);
}));

app.get('/api/payments', auth, requireRole('finance', 'compliance'), wrap(async (req, res) => {
  const { rows } = await db.pool.query(
    `SELECT p.*, e.event_title, e.event_date, r.chain_valid, r.created_at AS report_delivered_at
       FROM payment_notification p
       JOIN speaker_event e ON e.request_id = p.request_id
       LEFT JOIN audit_report r ON r.request_id = p.request_id
      ORDER BY p.id DESC`);
  res.json(rows);
}));

app.get('/health', (req, res) => res.json({ ok: true, ready: state.ready }));

// ------------------------------------------------------------------ bootstrap

const state = { ready: false };

async function bootstrap() {
  await db.init();
  console.log('[boot] database schema ready');

  for (let attempt = 1; ; attempt++) {
    try {
      await camunda.topology();
      const { files } = await camunda.deployDirectory(config.processDir);
      console.log(`[boot] deployed to Camunda: ${files.join(', ')}`);
      break;
    } catch (e) {
      console.log(`[boot] waiting for Camunda (attempt ${attempt}): ${e.message}`);
      await new Promise((r) => setTimeout(r, 5000));
    }
  }

  // Groups mirror the BPMN candidate groups so Camunda Tasklist/Admin show the same organisation
  for (const [username, p] of Object.entries(config.personas)) {
    if (!p.group) continue;
    try { await camunda.createGroup(p.group, p.group); } catch { /* exists */ }
    try { await camunda.addUserToGroup(p.group, username); } catch { /* exists */ }
  }

  workers.start();
  state.ready = true;
  console.log(`[boot] HCP portal ready on http://localhost:${config.port}`);
}

app.listen(config.port, () => console.log(`[boot] listening on ${config.port}`));
bootstrap().catch((e) => {
  console.error('[boot] fatal', e);
  process.exit(1);
});
