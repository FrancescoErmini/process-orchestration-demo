/* HCP Speaker Governance portal - vanilla JS single page app */
(() => {
  const $app = document.getElementById('app');
  const state = { me: null, config: null, notifOpen: false, timer: null };

  // ------------------------------------------------------------ helpers
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const eur = (n) => (n === null || n === undefined || n === '' ? '-' : '€' + Number(n).toLocaleString('en-US', { maximumFractionDigits: 2 }));
  const dt = (s) => new Date(s).toLocaleString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const ago = (s) => {
    const sec = Math.round((Date.now() - new Date(s)) / 1000);
    if (sec < 60) return `${sec}s ago`;
    if (sec < 3600) return `${Math.round(sec / 60)} min ago`;
    return dt(s);
  };

  async function api(path, opts = {}) {
    const res = await fetch(path, {
      method: opts.method || 'GET',
      headers: opts.body ? { 'Content-Type': 'application/json' } : {},
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (res.status === 401 && !['/api/login', '/api/me'].includes(path)) { state.me = null; render(); throw new Error('Session expired'); }
    if (!res.ok) { const e = new Error(data.error || `HTTP ${res.status}`); e.data = data; throw e; }
    return data;
  }

  function toast(msg, kind = '') {
    const t = document.getElementById('toast');
    t.textContent = msg;
    t.className = `toast ${kind}`;
    clearTimeout(t._h);
    t._h = setTimeout(() => t.classList.add('hidden'), 6000);
  }

  const STATUS = {
    SUBMITTED: ['Submitted', ''],
    PENDING_COMPLIANCE_REVIEW: ['Pending compliance review', ''],
    RETURNED_TO_MARKETING: ['Returned to Marketing', 'warn'],
    RESUBMITTED: ['Resubmitted', ''],
    APPROVED_LOGISTICS_IN_PROGRESS: ['Approved · logistics in progress', 'ok'],
    READY_FOR_EVENT: ['Ready for event', 'ok'],
    COMPLETED_PAYMENT_RELEASE_PENDING: ['Completed · payment pending', 'ok'],
    CLOSED: ['Closed · audit delivered', 'grey'],
  };
  const statusBadge = (s) => { const [l, k] = STATUS[s] || [s, '']; return `<span class="badge ${k}">${esc(l)}</span>`; };

  const STEPS = ['Submitted', 'FMV pre-check', 'Compliance review', 'Logistics', 'Event held', 'Payment & audit', 'Closed'];
  const STEP_OF = { SUBMITTED: 1, RESUBMITTED: 1, PENDING_COMPLIANCE_REVIEW: 2, RETURNED_TO_MARKETING: 2, APPROVED_LOGISTICS_IN_PROGRESS: 3, READY_FOR_EVENT: 4, COMPLETED_PAYMENT_RELEASE_PENDING: 5, CLOSED: 7 };
  function stepper(status) {
    const cur = STEP_OF[status] ?? 0;
    return `<div class="stepper">${STEPS.map((s, i) => {
      let cls = i < cur ? 'done' : i === cur ? 'current' : '';
      let label = s;
      if (i === cur && status === 'RETURNED_TO_MARKETING') { cls = 'returned'; label = 'Returned for fee change'; }
      return `<div class="step ${cls}"><span class="dot"></span>${esc(label)}</div>`;
    }).join('')}</div>`;
  }

  const ACTION_CLASS = {
    REQUEST_SUBMITTED: '', FEE_REVISED: 'warn', COMPLIANCE_APPROVED: 'ok', COMPLIANCE_REJECTED: 'bad',
    COMPLETION_BLOCKED: 'bad', LOGISTICS_CONFIRMED: 'ok', EVENT_COMPLETED: 'ok',
  };
  const ROLE_LABEL = { marketing: 'Medical Marketing', compliance: 'Compliance', coordinator: 'Event Coordinator', finance: 'Finance', system: 'System', admin: 'Admin' };

  function timeline(entries) {
    if (!entries.length) return '<p class="muted">No entries yet.</p>';
    return `<ul class="timeline">${entries.map((a) => {
      const cls = a.action === 'FMV_CHECK' ? (a.details.fmvExceeded ? 'warn' : 'sys') : (ACTION_CLASS[a.action] ?? 'sys');
      const comment = a.details.comment || a.details.notes;
      return `<li class="${a.actor_role === 'system' && !ACTION_CLASS[a.action] && a.action !== 'FMV_CHECK' ? 'sys' : cls}">
        <div class="meta"><strong>${esc(dt(a.occurred_at))}</strong>
          <span class="badge ${a.actor_role === 'system' ? 'sys' : ''}">${esc(a.actor)} · ${esc(ROLE_LABEL[a.actor_role] || a.actor_role)}</span>
          <span class="badge grey">${esc(a.action)}</span></div>
        <div class="sum">${esc(a.summary)}</div>
        ${comment ? `<div class="comment">"${esc(comment)}"</div>` : ''}
        <div class="hash" title="prev: ${esc(a.prev_hash)}">#${esc(a.hash.slice(0, 16))}…</div>
      </li>`;
    }).join('')}</ul>`;
  }

  function feeHistory(entries) {
    const fees = [];
    for (const a of entries) {
      if (a.action === 'REQUEST_SUBMITTED') fees.push({ fee: a.details.proposedFee, who: a.actor, when: a.occurred_at });
      if (a.action === 'FEE_REVISED') fees.push({ fee: a.details.newFee, who: a.actor, when: a.occurred_at, why: a.details.comment });
    }
    if (!fees.length) return '';
    return `<div class="fee-history">${fees.map((f, i) =>
      `${i ? '<span class="muted">→</span>' : ''}<span class="fee ${i === fees.length - 1 ? 'current' : 'old'}" title="${esc(f.who)} · ${esc(dt(f.when))}${f.why ? ' · ' + esc(f.why) : ''}">${eur(f.fee)}</span>`
    ).join('')}</div>`;
  }

  function requestSummary(v) {
    return `<dl class="kv">
      <dt>Request</dt><dd>${esc(v.requestId)}</dd>
      <dt>Event</dt><dd>${esc(v.eventTitle)}</dd>
      <dt>Date / venue</dt><dd>${esc(v.eventDate)} · ${esc(v.venue)}</dd>
      <dt>Speaker</dt><dd>${esc(v.speakerName)} <span class="muted">(${esc(v.speakerSpecialty)})</span></dd>
      <dt>Speaker tier</dt><dd>${esc(v.speakerTier)}</dd>
      <dt>Proposed fee</dt><dd><strong>${eur(v.proposedFee)}</strong></dd>
      ${v.fmvLimit !== undefined ? `<dt>FMV limit</dt><dd>${eur(v.fmvLimit)} ${v.fmvExceeded ? '<span class="badge bad">exceeded</span>' : '<span class="badge ok">within limit</span>'}</dd>` : ''}
      <dt>Requested by</dt><dd>${esc(v.requestedBy)}</dd>
      ${v.justification ? `<dt>Justification</dt><dd>${esc(v.justification)}</dd>` : ''}
    </dl>`;
  }

  // ------------------------------------------------------------ login
  function renderLogin() {
    const personas = state.config.personas;
    $app.innerHTML = `
      <div class="login">
        <h1>HCP Speaker Event Governance</h1>
        <p class="muted">Demo portal orchestrated by Camunda 8. Choose a persona to sign in (credentials are Camunda users).</p>
        <div class="persona-grid">${personas.map((p) => `
          <button class="persona" data-user="${esc(p.username)}">
            <div class="name">${esc(p.username)}</div>
            <div class="muted">${esc(p.title)}</div>
            <div class="cred">user: ${esc(p.username)} · pwd: ${esc(p.username)}</div>
          </button>`).join('')}
        </div>
        <div class="card" style="max-width:420px">
          <form id="loginForm">
            <label>Username</label><input type="text" name="username" autocomplete="username" required />
            <label>Password</label><input type="password" name="password" autocomplete="current-password" required />
            <div class="btn-row"><button class="btn" type="submit">Sign in</button></div>
          </form>
        </div>
        <p class="muted">Camunda web apps: <a href="${esc(state.config.camundaUrl)}/tasklist" target="_blank">Tasklist</a> ·
          <a href="${esc(state.config.camundaUrl)}/operate" target="_blank">Operate</a> ·
          <a href="${esc(state.config.camundaUrl)}/admin" target="_blank">Admin</a></p>
      </div>`;
    const form = document.getElementById('loginForm');
    $app.querySelectorAll('.persona').forEach((b) => b.addEventListener('click', () => {
      form.username.value = b.dataset.user; form.password.value = b.dataset.user; form.requestSubmit();
    }));
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      try {
        state.me = await api('/api/login', { method: 'POST', body: { username: form.username.value, password: form.password.value } });
        location.hash = defaultRoute();
        render();
      } catch (err) { toast(err.message, 'bad'); }
    });
  }

  const defaultRoute = () => (state.me.role === 'marketing' ? '#requests' : state.me.role === 'finance' ? '#payments' : '#tasks');

  // ------------------------------------------------------------ shell
  function tabsFor(role) {
    const t = [];
    if (role !== 'finance') t.push(['#tasks', 'My tasks']);
    t.push(['#requests', 'Speaker events']);
    if (role === 'marketing' || role === 'admin') t.push(['#new', '+ New request']);
    if (['finance', 'compliance', 'admin'].includes(role)) t.push(['#payments', 'Payments & audit reports']);
    return t;
  }

  async function renderShell() {
    const me = state.me;
    const route = location.hash || defaultRoute();
    $app.innerHTML = `
      <div class="topbar">
        <div class="brand"><span class="logo">✚</span> HCP Speaker Governance</div>
        <a href="${esc(state.config.camundaUrl)}/tasklist" target="_blank">Camunda Tasklist ↗</a>
        <a href="${esc(state.config.camundaUrl)}/operate" target="_blank">Camunda Operate ↗</a>
        <div class="spacer"></div>
        <button class="bell" id="bell" title="Notifications">🔔<span class="count hidden" id="notifCount"></span></button>
        <span class="userchip">${esc(me.username)} · ${esc(me.title)}</span>
        <a href="#" id="logout">Sign out</a>
        <div class="notif-panel hidden" id="notifPanel"></div>
      </div>
      <nav class="tabs">${tabsFor(me.role).map(([h, l]) =>
        `<button data-href="${h}" class="${route.startsWith(h) ? 'active' : ''}">${l}${h === '#tasks' ? ' <span class="badge hidden" id="taskCount"></span>' : ''}</button>`).join('')}</nav>
      <main id="view"><p class="muted">Loading…</p></main>`;
    $app.querySelectorAll('.tabs button').forEach((b) => b.addEventListener('click', () => { location.hash = b.dataset.href; }));
    document.getElementById('logout').addEventListener('click', async (e) => {
      e.preventDefault(); await api('/api/logout', { method: 'POST' }); state.me = null; location.hash = ''; render();
    });
    document.getElementById('bell').addEventListener('click', () => {
      state.notifOpen = !state.notifOpen;
      document.getElementById('notifPanel').classList.toggle('hidden', !state.notifOpen);
    });
    refreshBadges();
    await renderRoute(route);
  }

  async function refreshBadges() {
    try {
      const notifs = await api('/api/notifications');
      const c = document.getElementById('notifCount');
      const p = document.getElementById('notifPanel');
      if (!c) return;
      c.textContent = notifs.length; c.classList.toggle('hidden', !notifs.length);
      p.innerHTML = notifs.length
        ? notifs.map((n) => `<div class="item"><div>${esc(n.message)}</div><div class="when">${esc(ago(n.created_at))} · <a href="#request/${esc(n.request_id)}">${esc(n.request_id)}</a></div></div>`).join('')
        : '<div class="item muted">No notifications</div>';
      if (state.me.role !== 'finance') {
        const tasks = await api('/api/tasks');
        const t = document.getElementById('taskCount');
        if (t) { t.textContent = tasks.length; t.classList.toggle('hidden', !tasks.length); }
      }
    } catch { /* ignore */ }
  }

  // Auto-refresh helper: only the most recently rendered view may own the refresh timer
  function every(gen, fn) {
    if (gen !== state.gen) return;
    clearInterval(state.timer);
    state.timer = setInterval(() => { if (gen === state.gen) fn(); }, 5000);
  }

  async function renderRoute(route) {
    const view = document.getElementById('view');
    clearInterval(state.timer);
    state.gen = (state.gen || 0) + 1;
    try {
      if (route.startsWith('#task/')) return await viewTask(view, route.slice(6));
      if (route.startsWith('#request/')) return await viewRequest(view, decodeURIComponent(route.slice(9)));
      if (route === '#requests') return await viewRequests(view);
      if (route === '#new') return viewNewRequest(view);
      if (route === '#payments') return await viewPayments(view);
      return await viewTasks(view);
    } catch (e) {
      view.innerHTML = `<div class="alert bad">${esc(e.message)}</div>`;
    }
  }

  // ------------------------------------------------------------ views
  async function viewTasks(view) {
    const gen = state.gen;
    const draw = async () => {
      const tasks = await api('/api/tasks');
      view.innerHTML = `<h1>My tasks</h1>
        <p class="muted">Work items routed by Camunda to <strong>${esc(state.me.group || 'all groups')}</strong>. The list refreshes automatically.</p>
        <div class="task-list">${tasks.length ? tasks.map((t) => `
          <div class="task" data-key="${esc(t.key)}">
            <div>
              <div class="title">${esc(t.name)} · ${esc(t.variables.requestId)}</div>
              <div class="muted">${esc(t.variables.eventTitle)} — ${esc(t.variables.speakerName)} · fee ${eur(t.variables.proposedFee)}
                ${t.variables.fmvExceeded ? ' <span class="badge bad">FMV exceeded</span>' : ''}</div>
              <div class="muted" style="font-size:12px">Created ${esc(ago(t.created))}${t.assignee ? ' · assigned to ' + esc(t.assignee) : ''}</div>
            </div>
            <button class="btn">Open</button>
          </div>`).join('') : '<div class="card empty">🎉 No open tasks for you right now.</div>'}
        </div>`;
      view.querySelectorAll('.task').forEach((el) => el.addEventListener('click', () => { location.hash = '#task/' + el.dataset.key; }));
    };
    await draw();
    every(gen, () => { draw().catch(() => {}); refreshBadges(); });
  }

  async function viewRequests(view) {
    const gen = state.gen;
    const draw = async () => {
      const rows = await api('/api/requests');
      view.innerHTML = `<h1>Speaker events</h1>
        <div class="card table-wrap">${rows.length ? `<table>
          <thead><tr><th>Request</th><th>Event</th><th>Speaker</th><th>Fee</th><th>Status</th><th>Requested</th></tr></thead>
          <tbody>${rows.map((r) => `<tr class="click" data-id="${esc(r.request_id)}">
            <td><strong>${esc(r.request_id)}</strong></td>
            <td>${esc(r.event_title)}<div class="muted">${esc(r.event_date)} · ${esc(r.venue)}</div></td>
            <td>${esc(r.speaker_name)}<div class="muted">${esc(r.speaker_tier)}</div></td>
            <td>${eur(r.proposed_fee)}</td>
            <td>${statusBadge(r.status)}</td>
            <td>${esc(r.requested_by)}<div class="muted">${esc(ago(r.created_at))}</div></td>
          </tr>`).join('')}</tbody></table>` : `<div class="empty">No speaker events yet.${state.me.role === 'marketing' ? ' <a href="#new">Submit the first request →</a>' : ''}</div>`}
        </div>`;
      view.querySelectorAll('tr.click').forEach((tr) => tr.addEventListener('click', () => { location.hash = '#request/' + tr.dataset.id; }));
    };
    await draw();
    every(gen, () => { draw().catch(() => {}); refreshBadges(); });
  }

  async function viewRequest(view, id) {
    const gen = state.gen;
    const draw = async () => {
      const d = await api('/api/requests/' + encodeURIComponent(id));
      const r = d.request;
      const canReport = ['compliance', 'finance', 'admin'].includes(state.me.role) && d.report;
      view.innerHTML = `
        <p><a href="#requests">← All speaker events</a></p>
        <div class="card">
          <div style="display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap;align-items:center">
            <h1 style="margin:0">${esc(r.request_id)} · ${esc(r.event_title)}</h1>${statusBadge(r.status)}
          </div>
          ${stepper(r.status)}
        </div>
        <div class="grid2">
          <div>
            <div class="card"><h2>Engagement details</h2>
              ${requestSummary({ requestId: r.request_id, eventTitle: r.event_title, eventDate: r.event_date, venue: r.venue, speakerName: r.speaker_name,
                speakerSpecialty: r.speaker_specialty, speakerTier: r.speaker_tier, proposedFee: r.proposed_fee, requestedBy: r.requested_by, justification: r.justification })}
              <h3 style="margin-top:16px">Fee history</h3>${feeHistory(d.audit)}
              ${r.process_instance_key ? `<div class="btn-row"><a class="btn secondary" target="_blank" href="${esc(state.config.camundaUrl)}/operate/processes/${esc(r.process_instance_key)}">View process in Camunda Operate ↗</a></div>` : ''}
            </div>
            ${d.payment ? `<div class="card"><h2>Honorarium payment</h2><dl class="kv">
              <dt>Payee</dt><dd>${esc(d.payment.payee)}</dd><dt>Amount</dt><dd>${eur(d.payment.amount)}</dd>
              <dt>Status</dt><dd><span class="badge ok">${esc(d.payment.status)}</span></dd><dt>Notified</dt><dd>${esc(dt(d.payment.created_at))}</dd></dl></div>` : ''}
          </div>
          <div class="card">
            <div style="display:flex;justify-content:space-between;gap:8px;flex-wrap:wrap;align-items:center">
              <h2 style="margin:0">Audit trail</h2>
              ${d.chain.valid ? '<span class="badge ok">🔒 Hash chain verified</span>' : `<span class="badge bad">⚠ Hash chain broken at entry ${esc(d.chain.brokenAt)}</span>`}
            </div>
            <p class="muted">Append-only, SHA-256 chained record of every submission, change and decision.</p>
            <div class="btn-row" style="margin:0 0 16px">
              <a class="btn secondary" href="/api/requests/${esc(r.request_id)}/audit.csv">Export CSV</a>
              ${canReport ? `<a class="btn secondary" href="/api/requests/${esc(r.request_id)}/audit-report.json">Delivered audit report (JSON)</a>` : ''}
            </div>
            ${timeline(d.audit)}
          </div>
        </div>`;
    };
    await draw();
    every(gen, () => { draw().catch(() => {}); refreshBadges(); });
  }

  function viewNewRequest(view) {
    const tiers = Object.entries(state.config.fmvLimits);
    const inDays = (n) => new Date(Date.now() + n * 864e5).toISOString().slice(0, 10);
    view.innerHTML = `<h1>New speaker engagement request</h1>
      <div class="card" style="max-width:760px">
        <p class="muted">Pre-filled with the demo scenario. Submitting starts the Camunda process and routes the request to Compliance.</p>
        <form id="newForm">
          <label>Event title</label><input type="text" name="eventTitle" value="Advances in Heart Failure Management – Regional Symposium" required />
          <div class="grid2" style="gap:12px">
            <div><label>Event date</label><input type="date" name="eventDate" value="${inDays(30)}" required /></div>
            <div><label>Venue</label><input type="text" name="venue" value="Hotel Principe di Savoia, Milan" required /></div>
          </div>
          <div class="grid2" style="gap:12px">
            <div><label>Speaker (Key Opinion Leader)</label><input type="text" name="speakerName" value="Prof. Dr. Giulia Romano" required /></div>
            <div><label>Specialty</label><input type="text" name="speakerSpecialty" value="Cardiology" required /></div>
          </div>
          <div class="grid2" style="gap:12px">
            <div><label>Speaker tier</label><select name="speakerTier">${tiers.map(([t, l]) =>
              `<option value="${esc(t)}" ${t === 'National KOL' ? 'selected' : ''}>${esc(t)} (FMV limit ${eur(l)})</option>`).join('')}</select></div>
            <div><label>Proposed speaker fee (EUR)</label><input type="number" name="proposedFee" min="0" step="50" value="1500" required /></div>
          </div>
          <label>Scientific / business justification</label>
          <textarea name="justification">45-minute keynote on new HFrEF treatment guidelines for ~40 cardiologists and GPs.</textarea>
          <div class="btn-row"><button class="btn" type="submit">Submit for approval</button></div>
        </form>
      </div>`;
    const f = document.getElementById('newForm');
    f.addEventListener('submit', async (e) => {
      e.preventDefault();
      const body = Object.fromEntries(new FormData(f).entries());
      f.querySelector('button').disabled = true;
      try {
        const r = await api('/api/requests', { method: 'POST', body });
        toast(`${r.requestId} submitted – routed to Compliance`, 'ok');
        location.hash = '#request/' + r.requestId;
      } catch (err) { toast(err.message, 'bad'); f.querySelector('button').disabled = false; }
    });
  }

  async function viewPayments(view) {
    const gen = state.gen;
    const rows = await api('/api/payments');
    view.innerHTML = `<h1>Honorarium payments & audit reports</h1>
      <p class="muted">Payment notifications are created automatically by the process once the Event Coordinator confirms the event took place,
        together with the full audit trail delivered to Finance and Compliance.</p>
      <div class="card table-wrap">${rows.length ? `<table>
        <thead><tr><th>Request</th><th>Payee</th><th>Amount</th><th>Payment status</th><th>Audit report</th><th></th></tr></thead>
        <tbody>${rows.map((p) => `<tr>
          <td><a href="#request/${esc(p.request_id)}"><strong>${esc(p.request_id)}</strong></a><div class="muted">${esc(p.event_title)} · ${esc(p.event_date)}</div></td>
          <td>${esc(p.payee)}</td><td><strong>${eur(p.amount)}</strong></td>
          <td><span class="badge ok">${esc(p.status)}</span><div class="muted">${esc(dt(p.created_at))}</div></td>
          <td>${p.report_delivered_at ? `${p.chain_valid ? '<span class="badge ok">🔒 chain valid</span>' : '<span class="badge bad">chain broken</span>'}<div class="muted">${esc(dt(p.report_delivered_at))}</div>` : '<span class="badge grey">pending</span>'}</td>
          <td>${p.report_delivered_at ? `<a class="btn secondary" href="/api/requests/${esc(p.request_id)}/audit-report.json">Download</a>` : ''}</td>
        </tr>`).join('')}</tbody></table>` : '<div class="empty">No payment notifications yet.</div>'}</div>`;
    every(gen, refreshBadges);
  }

  // ------------------------------------------------------------ task forms
  function taskForm(t) {
    const v = t.variables;
    switch (t.elementId) {
      case 'ComplianceReview': {
        const reject = Boolean(v.fmvExceeded);
        return `
          ${v.fmvExceeded ? `<div class="alert bad"><strong>FMV pre-check failed:</strong> proposed fee ${eur(v.proposedFee)} exceeds the ${esc(v.speakerTier)} limit of ${eur(v.fmvLimit)}. Approval is blocked by policy.</div>`
            : `<div class="alert ok"><strong>FMV pre-check passed:</strong> ${eur(v.proposedFee)} is within the ${esc(v.speakerTier)} limit of ${eur(v.fmvLimit)}.</div>`}
          <label>Decision</label>
          <div class="radio-group">
            <label class="radio-card"><input type="radio" name="complianceDecision" value="APPROVED" ${reject ? '' : 'checked'} /> ✅ Approve engagement</label>
            <label class="radio-card"><input type="radio" name="complianceDecision" value="REJECTED" ${reject ? 'checked' : ''} /> ↩️ Reject fee – return to Marketing</label>
          </div>
          <div id="recFee"><label>Recommended fee (EUR)</label><input type="number" name="recommendedFee" value="${esc(v.fmvLimit)}" /></div>
          <label>Comment / justification (mandatory)</label>
          <textarea name="complianceComment">${reject
            ? `Proposed fee of ${eur(v.proposedFee)} exceeds the Fair Market Value limit for a ${v.speakerTier} (${eur(v.fmvLimit)}). Please adjust the fee to ${eur(v.fmvLimit)} and resubmit.`
            : 'Fee within FMV guidelines, speaker qualification and agenda verified. Engagement approved.'}</textarea>
          <div class="btn-row"><button class="btn" type="submit">Submit decision</button></div>`;
      }
      case 'ReviseFee':
        return `
          <div class="alert warn"><strong>Returned by Compliance.</strong> ${esc(v.complianceComment || '')}
            ${v.recommendedFee ? `<br/>Recommended fee: <strong>${eur(v.recommendedFee)}</strong>` : ''}</div>
          <label>Revised speaker fee (EUR)</label><input type="number" name="proposedFee" min="0" step="50" value="${esc(v.recommendedFee ?? v.proposedFee)}" required />
          <label>Change note (mandatory)</label>
          <textarea name="revisionComment">Fee adjusted to ${eur(v.recommendedFee ?? v.proposedFee)} as requested by Compliance; speaker has agreed to the revised honorarium.</textarea>
          <div class="btn-row"><button class="btn" type="submit">Resubmit to Compliance</button></div>`;
      case 'PrepareLogistics':
        return `
          <div class="alert ok">Approved by Compliance at <strong>${eur(v.proposedFee)}</strong>. You can now book the venue and prepare materials.</div>
          <label class="check"><input type="checkbox" name="venueConfirmed" checked /> Venue booked and confirmed (${esc(v.venue)})</label>
          <label class="check"><input type="checkbox" name="materialsReady" checked /> Slides / materials medically reviewed and ready</label>
          <label class="check"><input type="checkbox" name="travelArranged" checked /> Speaker travel & accommodation arranged</label>
          <label>Notes</label><textarea name="logisticsNotes">Room for 50 booked, AV check scheduled the day before.</textarea>
          <div class="btn-row"><button class="btn ok" type="submit">✔ Confirm everything is ready</button></div>`;
      case 'ConfirmEventCompletion':
        return `
          <label class="check"><input type="checkbox" name="eventHeld" checked /> I confirm the event took place as planned on ${esc(v.eventDate)}</label>
          <label>Number of HCP attendees</label><input type="number" name="attendees" min="0" value="42" required />
          <label>Notes</label><textarea name="completionNotes">Event delivered as per approved agenda; sign-in sheet archived.</textarea>
          <div class="btn-row"><button class="btn ok" type="submit">✔ Confirm event completed</button></div>`;
      default:
        return '<div class="btn-row"><button class="btn" type="submit">Complete</button></div>';
    }
  }

  function collect(form, elementId) {
    const fd = new FormData(form);
    const g = (k) => fd.get(k);
    switch (elementId) {
      case 'ComplianceReview': {
        const out = { complianceDecision: g('complianceDecision'), complianceComment: g('complianceComment') };
        if (out.complianceDecision === 'REJECTED' && g('recommendedFee')) out.recommendedFee = Number(g('recommendedFee'));
        return out;
      }
      case 'ReviseFee': return { proposedFee: Number(g('proposedFee')), revisionComment: g('revisionComment') };
      case 'PrepareLogistics': return {
        venueConfirmed: fd.has('venueConfirmed'), materialsReady: fd.has('materialsReady'),
        travelArranged: fd.has('travelArranged'), logisticsNotes: g('logisticsNotes'),
      };
      case 'ConfirmEventCompletion': return { eventHeld: fd.has('eventHeld'), attendees: Number(g('attendees')), completionNotes: g('completionNotes') };
      default: return {};
    }
  }

  async function viewTask(view, key) {
    const t = await api('/api/tasks/' + key);
    if (t.state !== 'CREATED') {
      view.innerHTML = `<p><a href="#tasks">← My tasks</a></p><div class="alert info">This task is already ${esc(t.state.toLowerCase())}.</div>`;
      return;
    }
    const v = t.variables;
    view.innerHTML = `
      <p><a href="#tasks">← My tasks</a></p>
      <div class="grid2">
        <div class="card">
          <h1>${esc(t.name)}</h1>
          <p class="muted">${esc(v.requestId)} · routed to <strong>${esc((t.candidateGroups || []).join(', '))}</strong> · created ${esc(ago(t.created))}</p>
          ${requestSummary(v)}
          <form id="taskForm" style="margin-top:16px">${taskForm(t)}</form>
        </div>
        <div class="card">
          <h2>Request history</h2>
          <h3>Fee history</h3>${feeHistory(t.audit)}
          <div style="margin-top:16px">${timeline(t.audit)}</div>
        </div>
      </div>`;
    const form = document.getElementById('taskForm');
    const rec = document.getElementById('recFee');
    if (rec) {
      const sync = () => rec.classList.toggle('hidden', form.complianceDecision.value !== 'REJECTED');
      form.querySelectorAll('input[name=complianceDecision]').forEach((r) => r.addEventListener('change', sync));
      sync();
    }
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const btn = form.querySelector('button[type=submit]');
      btn.disabled = true;
      try {
        await api(`/api/tasks/${key}/complete`, { method: 'POST', body: { variables: collect(form, t.elementId) } });
        toast(`"${t.name}" completed – the process moves on`, 'ok');
        location.hash = '#request/' + v.requestId;
      } catch (err) {
        toast((err.data && err.data.deniedByEngine ? '⛔ Blocked by process rule: ' : '') + err.message, 'bad');
        btn.disabled = false;
        // the attempt is in the audit trail: refresh the history panel
        const fresh = await api('/api/tasks/' + key).catch(() => null);
        if (fresh) view.querySelector('.grid2 > .card:last-child').innerHTML =
          `<h2>Request history</h2><h3>Fee history</h3>${feeHistory(fresh.audit)}<div style="margin-top:16px">${timeline(fresh.audit)}</div>`;
      }
    });
  }

  // ------------------------------------------------------------ boot
  async function render() {
    clearInterval(state.timer);
    if (!state.config) state.config = await api('/api/config');
    if (!state.me) {
      try { state.me = await api('/api/me'); } catch { /* not logged in */ }
    }
    if (!state.me) return renderLogin();
    return renderShell();
  }

  window.addEventListener('hashchange', () => { if (state.me) renderShell(); });
  render();
})();
