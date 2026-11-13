// Job workers executed by the Node.js backend on behalf of the Camunda process.
//
//  - Service tasks:   fmv-check, finance-payment-notification, deliver-audit-trail
//  - Task listeners:  audit-user-task (fires when a user task is CREATED and when it is COMPLETING)
//
// Because the task listeners run inside the engine's lifecycle, every human decision is
// validated and written to the audit trail no matter which UI was used (this portal or
// Camunda Tasklist). A listener can also *deny* a completion, which is how business rules
// such as "fee must respect FMV" and segregation of duties are enforced.
const crypto = require('crypto');
const camunda = require('./camunda');
const db = require('./db');
const config = require('./config');

const WORKER = 'hcp-portal-worker';

const TASKS = {
  ComplianceReview: { label: 'Compliance review', role: 'compliance', status: 'PENDING_COMPLIANCE_REVIEW' },
  ReviseFee: { label: 'Revise speaker fee', role: 'marketing', status: 'RETURNED_TO_MARKETING' },
  PrepareLogistics: { label: 'Prepare venue & materials', role: 'coordinator', status: 'APPROVED_LOGISTICS_IN_PROGRESS' },
  ConfirmEventCompletion: { label: 'Confirm event took place', role: 'coordinator', status: 'READY_FOR_EVENT' },
};
const ROLE_LABEL = { marketing: 'Medical Marketing', compliance: 'Compliance', coordinator: 'Event Coordination', finance: 'Finance' };

const eur = (n) => '€' + Number(n).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
const roleOf = (username) => (config.personas[username] ? config.personas[username].role : 'unknown');

async function setStatus(requestId, status, extra = {}) {
  const sets = ['status = $2', 'updated_at = now()'];
  const vals = [requestId, status];
  for (const [col, v] of Object.entries(extra)) {
    vals.push(v);
    sets.push(`${col} = $${vals.length}`);
  }
  await db.pool.query(`UPDATE speaker_event SET ${sets.join(', ')} WHERE request_id = $1`, vals);
}

async function notify(recipientRole, requestId, message) {
  await db.pool.query('INSERT INTO notification (recipient, request_id, message) VALUES ($1,$2,$3)',
    [recipientRole, requestId, message]);
}

async function getRequest(requestId) {
  const { rows } = await db.pool.query('SELECT * FROM speaker_event WHERE request_id = $1', [requestId]);
  return rows[0];
}

// ---------------------------------------------------------------- service tasks

async function fmvCheck(job) {
  const v = job.variables;
  const limit = config.fmvLimits[v.speakerTier] ?? 1000;
  const fee = Number(v.proposedFee);
  const exceeded = fee > limit;
  await setStatus(v.requestId, 'PENDING_COMPLIANCE_REVIEW', { fmv_limit: limit });
  await db.appendAudit({
    requestId: v.requestId,
    processInstanceKey: job.processInstanceKey,
    actor: 'fmv-engine',
    actorRole: 'system',
    action: 'FMV_CHECK',
    summary: exceeded
      ? `FMV pre-check: proposed fee ${eur(fee)} EXCEEDS the ${v.speakerTier} limit of ${eur(limit)}`
      : `FMV pre-check: proposed fee ${eur(fee)} is within the ${v.speakerTier} limit of ${eur(limit)}`,
    details: { speakerTier: v.speakerTier, proposedFee: fee, fmvLimit: limit, fmvExceeded: exceeded },
  });
  // reset the previous decision so a resubmission always needs a fresh review
  return { variables: { fmvLimit: limit, fmvExceeded: exceeded, complianceDecision: null } };
}

async function financePaymentNotification(job) {
  const v = job.variables;
  const req = await getRequest(v.requestId);
  const amount = Number(req.proposed_fee);
  await db.pool.query(
    `INSERT INTO payment_notification (request_id, payee, amount, currency)
     VALUES ($1,$2,$3,$4) ON CONFLICT (request_id) DO NOTHING`,
    [v.requestId, req.speaker_name, amount, req.currency]);
  await notify('finance', v.requestId,
    `Release honorarium of ${eur(amount)} to ${req.speaker_name} for "${req.event_title}" (${v.requestId})`);
  await setStatus(v.requestId, 'COMPLETED_PAYMENT_RELEASE_PENDING');
  await db.appendAudit({
    requestId: v.requestId,
    processInstanceKey: job.processInstanceKey,
    actor: 'camunda-engine',
    actorRole: 'system',
    action: 'PAYMENT_NOTIFICATION_SENT',
    summary: `Finance notified to release the honorarium of ${eur(amount)} to ${req.speaker_name}`,
    details: { payee: req.speaker_name, amount, currency: req.currency },
  });
  return { variables: { paymentNotified: true, approvedFee: amount } };
}

async function deliverAuditTrail(job) {
  const v = job.variables;
  const req = await getRequest(v.requestId);
  const entries = await db.getAuditTrail(v.requestId);
  const chain = db.verifyChain(entries);
  const report = {
    reportType: 'HCP Speaker Engagement - Regulatory Audit Trail',
    generatedAt: new Date().toISOString(),
    request: req,
    hashChain: { algorithm: 'SHA-256', valid: chain.valid, brokenAt: chain.brokenAt, entries: entries.length },
    entries,
  };
  const reportHash = crypto.createHash('sha256').update(JSON.stringify(report)).digest('hex');
  await db.pool.query(
    `INSERT INTO audit_report (request_id, delivered_to, chain_valid, report)
     VALUES ($1,$2,$3,$4) ON CONFLICT (request_id) DO NOTHING`,
    [v.requestId, ['finance', 'compliance'], chain.valid, report]);
  for (const r of ['finance', 'compliance']) {
    await notify(r, v.requestId, `Audit trail for ${v.requestId} delivered (${entries.length} entries, hash chain ${chain.valid ? 'valid' : 'BROKEN'})`);
  }
  await setStatus(v.requestId, 'CLOSED');
  await db.appendAudit({
    requestId: v.requestId,
    processInstanceKey: job.processInstanceKey,
    actor: 'camunda-engine',
    actorRole: 'system',
    action: 'AUDIT_TRAIL_DELIVERED',
    summary: `Complete audit trail (${entries.length} entries) delivered to Finance and Compliance; case closed`,
    details: { deliveredTo: ['finance', 'compliance'], chainValid: chain.valid, reportSha256: reportHash },
  });
  return { variables: { auditTrailDelivered: true } };
}

// ---------------------------------------------------------------- user task listener

function validateCompletion(elementId, v, actor) {
  const meta = TASKS[elementId];
  if (meta && roleOf(actor) !== meta.role) {
    return `Segregation of duties: "${meta.label}" can only be completed by ${ROLE_LABEL[meta.role]} (user "${actor || 'unassigned'}" is ${roleOf(actor)})`;
  }
  switch (elementId) {
    case 'ComplianceReview':
      if (!['APPROVED', 'REJECTED'].includes(v.complianceDecision)) return 'A compliance decision (APPROVED / REJECTED) is required';
      if (!v.complianceComment || !String(v.complianceComment).trim()) return 'A justification comment is required for every compliance decision';
      if (v.complianceDecision === 'APPROVED' && v.fmvExceeded) {
        return `Policy violation: the proposed fee ${eur(v.proposedFee)} exceeds the FMV limit of ${eur(v.fmvLimit)} and cannot be approved. Reject it and request an adjustment.`;
      }
      return null;
    case 'ReviseFee':
      if (!(Number(v.proposedFee) > 0)) return 'A valid revised fee is required';
      if (!v.revisionComment || !String(v.revisionComment).trim()) return 'Please add a change note explaining the revision';
      return null;
    case 'PrepareLogistics':
      if (v.venueConfirmed !== true || v.materialsReady !== true) return 'Venue and materials must both be confirmed before marking logistics as ready';
      return null;
    case 'ConfirmEventCompletion':
      if (v.eventHeld !== true) return 'Please confirm that the event took place';
      if (!(Number(v.attendees) >= 0)) return 'Number of attendees is required';
      return null;
    default:
      return null;
  }
}

async function auditUserTask(job) {
  const v = job.variables;
  const meta = TASKS[job.elementId] || { label: job.elementId, role: 'unknown', status: 'IN_PROGRESS' };
  const base = { requestId: v.requestId, processInstanceKey: job.processInstanceKey };

  if (job.listenerEventType === 'CREATING') {
    await setStatus(v.requestId, meta.status);
    await notify(meta.role, v.requestId, `New task "${meta.label}" for ${v.requestId} - ${v.eventTitle}`);
    await db.appendAudit({
      ...base,
      actor: 'camunda-engine',
      actorRole: 'system',
      action: 'TASK_ROUTED',
      summary: `Task "${meta.label}" created and routed to ${ROLE_LABEL[meta.role] || meta.role}`,
      details: { task: job.elementId, candidateGroups: job.userTask && job.userTask.candidateGroups },
    });
    return {};
  }

  // COMPLETING
  const actor = job.userTask && job.userTask.assignee;
  const deniedReason = validateCompletion(job.elementId, v, actor);
  if (deniedReason) {
    await db.appendAudit({
      ...base,
      actor: actor || 'unknown',
      actorRole: roleOf(actor),
      action: 'COMPLETION_BLOCKED',
      summary: `Completion of "${meta.label}" blocked: ${deniedReason}`,
      details: { task: job.elementId, reason: deniedReason },
    });
    return { result: { type: 'userTask', denied: true, deniedReason } };
  }

  const who = { ...base, actor, actorRole: roleOf(actor) };
  switch (job.elementId) {
    case 'ComplianceReview': {
      const approved = v.complianceDecision === 'APPROVED';
      await db.appendAudit({
        ...who,
        action: approved ? 'COMPLIANCE_APPROVED' : 'COMPLIANCE_REJECTED',
        summary: approved
          ? `Compliance APPROVED the engagement at ${eur(v.proposedFee)}`
          : `Compliance REJECTED the fee of ${eur(v.proposedFee)}` +
            (v.recommendedFee ? ` and requested an adjustment to ${eur(v.recommendedFee)}` : ''),
        details: {
          decision: v.complianceDecision,
          comment: v.complianceComment,
          reviewedFee: Number(v.proposedFee),
          recommendedFee: approved ? null : v.recommendedFee ?? null,
          fmvLimit: v.fmvLimit,
        },
      });
      if (approved) await notify('marketing', v.requestId, `${v.requestId} approved by Compliance at ${eur(v.proposedFee)}`);
      else await notify('marketing', v.requestId, `${v.requestId} returned by Compliance: ${v.complianceComment}`);
      break;
    }
    case 'ReviseFee': {
      const req = await getRequest(v.requestId);
      const previousFee = Number(req.proposed_fee);
      const newFee = Number(v.proposedFee);
      await setStatus(v.requestId, 'RESUBMITTED', { proposed_fee: newFee });
      await db.appendAudit({
        ...who,
        action: 'FEE_REVISED',
        summary: `Speaker fee changed from ${eur(previousFee)} to ${eur(newFee)} and resubmitted`,
        details: { previousFee, newFee, comment: v.revisionComment, requestedByCompliance: v.recommendedFee ?? null },
      });
      break;
    }
    case 'PrepareLogistics':
      await db.appendAudit({
        ...who,
        action: 'LOGISTICS_CONFIRMED',
        summary: 'Venue, materials and travel confirmed as ready',
        details: {
          venueConfirmed: v.venueConfirmed,
          materialsReady: v.materialsReady,
          travelArranged: v.travelArranged ?? false,
          notes: v.logisticsNotes ?? null,
        },
      });
      break;
    case 'ConfirmEventCompletion':
      await db.appendAudit({
        ...who,
        action: 'EVENT_COMPLETED',
        summary: `Event confirmed as held (${v.attendees} HCP attendees)`,
        details: { eventHeld: v.eventHeld, attendees: Number(v.attendees), notes: v.completionNotes ?? null },
      });
      break;
    default:
      await db.appendAudit({ ...who, action: 'TASK_COMPLETED', summary: `Task "${meta.label}" completed`, details: {} });
  }
  return { result: { type: 'userTask', denied: false } };
}

// ---------------------------------------------------------------- polling loop

const HANDLERS = {
  'fmv-check': fmvCheck,
  'finance-payment-notification': financePaymentNotification,
  'deliver-audit-trail': deliverAuditTrail,
  'audit-user-task': auditUserTask,
};

async function runJob(type, handler, job) {
  try {
    const out = (await handler(job)) || {};
    await camunda.completeJob(job.jobKey, out.variables, out.result);
    console.log(`[worker] ${type} ${job.listenerEventType || ''} ${job.elementId} (${job.variables.requestId}) done`);
  } catch (e) {
    console.error(`[worker] ${type} job ${job.jobKey} failed:`, e.message);
    try { await camunda.failJob(job.jobKey, Math.max((job.retries || 1) - 1, 0), e.message); } catch { /* ignore */ }
  }
}

function start() {
  for (const [type, handler] of Object.entries(HANDLERS)) {
    (async function loop() {
      for (;;) {
        try {
          const { jobs = [] } = await camunda.activateJobs(type, WORKER);
          await Promise.all(jobs.map((job) => runJob(type, handler, job)));
        } catch (e) {
          console.error(`[worker] polling ${type} failed: ${e.message}`);
          await new Promise((r) => setTimeout(r, 3000));
        }
      }
    })();
  }
  console.log(`[worker] polling job types: ${Object.keys(HANDLERS).join(', ')}`);
}

module.exports = { start, TASKS };
