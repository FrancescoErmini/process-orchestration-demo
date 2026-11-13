// Minimal client for the Camunda 8 Orchestration Cluster REST API (v2).
// No SDK needed: Node's built-in fetch / FormData are enough for the demo.
const fs = require('fs');
const path = require('path');
const config = require('./config');

class CamundaError extends Error {
  constructor(status, body) {
    super((body && (body.detail || body.title)) || `Camunda request failed with HTTP ${status}`);
    this.status = status;
    this.body = body;
  }
}

function basicAuth(user, password) {
  return 'Basic ' + Buffer.from(`${user}:${password}`).toString('base64');
}

const serviceCreds = { username: config.camunda.serviceUser, password: config.camunda.servicePassword };

async function call(method, urlPath, { body, creds = serviceCreds, form, timeoutMs = 30000 } = {}) {
  const headers = { Authorization: basicAuth(creds.username, creds.password), Accept: 'application/json' };
  let payload;
  if (form) payload = form;
  else if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  const res = await fetch(config.camunda.restUrl + urlPath, {
    method,
    headers,
    body: payload,
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  let json;
  try { json = text ? JSON.parse(text) : undefined; } catch { json = { detail: text }; }
  if (!res.ok) throw new CamundaError(res.status, json);
  return json;
}

module.exports = {
  CamundaError,

  topology: () => call('GET', '/v2/topology'),

  // Validates the credentials of a portal user against Camunda's identity
  whoAmI: (creds) => call('GET', '/v2/authentication/me', { creds }),

  async deployDirectory(dir) {
    const form = new FormData();
    const files = [];
    const walk = (d) => {
      for (const f of fs.readdirSync(d)) {
        const p = path.join(d, f);
        if (fs.statSync(p).isDirectory()) walk(p);
        else if (/\.(bpmn|form|dmn)$/.test(f)) files.push(p);
      }
    };
    walk(dir);
    for (const p of files) {
      form.append('resources', new Blob([fs.readFileSync(p)]), path.basename(p));
    }
    const res = await call('POST', '/v2/deployments', { form });
    return { files: files.map((f) => path.basename(f)), res };
  },

  startProcess: (processDefinitionId, variables, creds) =>
    call('POST', '/v2/process-instances', { body: { processDefinitionId, variables }, creds }),

  searchUserTasks: (filter, creds) =>
    call('POST', '/v2/user-tasks/search', {
      body: { filter, sort: [{ field: 'creationDate', order: 'DESC' }], page: { limit: 100 } },
      creds,
    }),

  getUserTask: (key, creds) => call('GET', `/v2/user-tasks/${key}`, { creds }),

  async getUserTaskVariables(key, creds) {
    const res = await call('POST', `/v2/user-tasks/${key}/variables/search`, {
      body: { page: { limit: 200 } },
      creds,
    });
    const vars = {};
    for (const v of res.items || []) {
      try { vars[v.name] = JSON.parse(v.value); } catch { vars[v.name] = v.value; }
    }
    return vars;
  },

  assignUserTask: (key, assignee, creds) =>
    call('POST', `/v2/user-tasks/${key}/assignment`, { body: { assignee, allowOverride: true }, creds }),

  completeUserTask: (key, variables, creds) =>
    call('POST', `/v2/user-tasks/${key}/completion`, { body: { variables, action: 'complete' }, creds }),

  activateJobs: (type, worker, max = 10) =>
    call('POST', '/v2/jobs/activation', {
      body: { type, worker, timeout: 60000, maxJobsToActivate: max, requestTimeout: 10000 },
      timeoutMs: 20000,
    }),

  completeJob: (jobKey, variables, result) =>
    call('POST', `/v2/jobs/${jobKey}/completion`, { body: { variables: variables || {}, ...(result ? { result } : {}) } }),

  failJob: (jobKey, retries, errorMessage) =>
    call('POST', `/v2/jobs/${jobKey}/failure`, { body: { retries, errorMessage, retryBackOff: 5000 } }),

  createGroup: (groupId, name) => call('POST', '/v2/groups', { body: { groupId, name } }),
  addUserToGroup: (groupId, username) => call('PUT', `/v2/groups/${groupId}/users/${username}`),
};
