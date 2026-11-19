'use strict';
/* Single source of truth for the public REST API: drives the API reference in
   the Super Admin portal and /api/v1/openapi.json. */

const P = (name, desc, extra) => Object.assign({ name, in: 'query', desc }, extra || {});
const PAGE = [P('limit', 'Max items, 1-200 (default 50)'), P('before', 'Cursor: pass nextBefore from the previous page')];

const ENDPOINTS = [
  { group: 'Platform', method: 'GET', path: '/api/v1/health', scope: 'read', summary: 'Check the API and your key', returns: '{ ok, version, key: { name, scopes, companyId } }' },
  { group: 'Platform', method: 'GET', path: '/api/v1/stats', scope: 'read', summary: 'Totals and a daily series for calls, bookings, minutes, cost, QA and leads',
    params: [P('days', '1-365 (default 30)'), P('companyId', 'Limit to one company'), P('accountId', 'Limit to one account')],
    returns: '{ days, calls: { total, live, minutes, cost, booked, alerts, avgScore, outcomes }, crmSync: { failed, pending }, leads: { total, byStatus }, daily: [{ date, calls, booked }], topCompanies: [...] }' },

  { group: 'Companies', method: 'GET', path: '/api/v1/companies', scope: 'read', summary: 'List companies and single-account workspaces',
    params: [P('q', 'Search name, id or custom domain'), P('status', 'active | pending | suspended'), P('type', 'company | single_account'), P('installed', 'true | false')],
    returns: '{ data: [Company] }' },
  { group: 'Companies', method: 'GET', path: '/api/v1/companies/{companyId}', scope: 'read', summary: 'One company with its accounts and users', returns: 'Company & { accounts: [Account], users: [User] }' },
  { group: 'Companies', method: 'PATCH', path: '/api/v1/companies/{companyId}', scope: 'write', summary: 'Change the license status', body: '{ "status": "active" | "pending" | "suspended" }', returns: 'Company' },

  { group: 'Accounts', method: 'GET', path: '/api/v1/accounts', scope: 'read', summary: 'List deployed call centers (one per CRM account)',
    params: [P('companyId', 'Limit to one company'), P('status', 'draft | deploying | live | failed | removed')], returns: '{ data: [Account] }' },
  { group: 'Accounts', method: 'GET', path: '/api/v1/accounts/{accountId}', scope: 'read', summary: 'One call center: number, status, deploy steps, features', returns: 'Account' },

  { group: 'Calls', method: 'GET', path: '/api/v1/calls', scope: 'read', summary: 'List calls, newest first',
    params: [P('companyId', 'Limit to one company'), P('accountId', 'Limit to one account'), P('status', 'live | ended | in-progress …'), P('direction', 'inbound | outbound'),
      P('outcome', 'appointment_booked | qualified_lead | support_resolved | support_ticket | not_interested | spam | voicemail | other'), P('since', 'ISO date-time'), P('until', 'ISO date-time'),
      P('alerts', 'true = only calls with alerts'), P('syncState', 'queued | running | done | failed'), P('leadId', 'Calls placed for a speed-to-lead lead')].concat(PAGE),
    returns: '{ data: [Call], nextBefore }' },
  { group: 'Calls', method: 'GET', path: '/api/v1/calls/{callId}', scope: 'read', summary: 'One call with transcript, whispers, QA grade and CRM sync', returns: 'Call & { transcript: [{ role, agent, text, at }], whispers: [...] }' },

  { group: 'Leads', method: 'GET', path: '/api/v1/leads', scope: 'read', summary: 'Speed-to-lead queue and results',
    params: [P('companyId', 'Limit to one company'), P('accountId', 'Limit to one account'), P('status', 'queued | calling | connected | unreached | skipped | failed'), P('since', 'ISO date-time')].concat(PAGE),
    returns: '{ data: [Lead], nextBefore }' },
  { group: 'Leads', method: 'GET', path: '/api/v1/leads/{leadId}', scope: 'read', summary: 'One lead', returns: 'Lead' },
  { group: 'Leads', method: 'POST', path: '/api/v1/leads', scope: 'write', summary: 'Send a lead from another app: the AI calls it back (calling hours, retries, de-dupe and Do-Not-Disturb apply)',
    body: '{ "accountId": "loc123", "phone": "+15125550123", "name": "Jane", "interest": "a water heater quote", "crmContactId": "optional" }', returns: '{ lead: Lead, duplicate }' },

  { group: 'Activity', method: 'GET', path: '/api/v1/events', scope: 'read', summary: 'Activity log (installs, deploys, calls, syncs, leads, logins, settings)',
    params: [P('companyId', 'Limit to one company'), P('accountId', 'Limit to one account'), P('type', 'e.g. call.end, deploy.failed'), P('since', 'ISO date-time')].concat(PAGE),
    returns: '{ data: [{ at, companyId, type, detail, accountId, callId }], nextBefore }' },

  { group: 'Webhooks', method: 'GET', path: '/api/v1/webhook-events', scope: 'read', summary: 'Event types you can subscribe to', returns: '{ data: [string] }' }
];

const SHAPES = {
  Company: '{ id, name, type: "company" | "single_account", apps: ["account_app" | "company_app"], primaryApp, status, installed, installedAt, createdAt, crmCompanyId, accountId, providerKeys: { twilio, vapi, openai }, takeoverLine, branding: { name, domain }, accounts: { total, live, failed } }',
  Account: '{ id, companyId, name, status, phoneNumber, lastError, createdAt, deployedAt, business: { name, industry, timezone, language, avgJobValue }, features: { speedToLead, smsFollowUp, alerts, booking, pipelineMapping }, steps: [{ key, status, detail, at }], vapi: { squadId, phoneNumberId } }',
  Call: '{ id, companyId, accountId, status, live, direction, customer: { number, name }, agent, createdAt, answeredAt, endedAt, durationSec, endedReason, cost, recordingUrl, summary, grade: { score, sentiment, outcome, nextSteps, coaching, flags }, booked: { at, contactId }, ticket, alerts: [{ kind, text, at }], takeover, leadId, crmSync: { state, attempts, contactId, opportunityId, sms, error } }',
  Lead: '{ id, companyId, accountId, phone, name, interest, crmContactId, status, attempts, reason, createdAt, nextAt, lastCallAt, finishedAt, callIds }',
  User: '{ id, email, name, kind: "staff" | "client", role, accountIds, disabled, lastLoginAt }'
};

function openapi(baseUrl, eventTypes) {
  const paths = {};
  ENDPOINTS.forEach((e) => {
    const p = paths[e.path] = paths[e.path] || {};
    const op = {
      tags: [e.group], summary: e.summary,
      description: 'Scope: ' + e.scope + '. Returns ' + e.returns,
      security: [{ bearer: [] }],
      parameters: ((e.path.match(/\{(\w+)\}/g) || []).map((m) => ({ name: m.slice(1, -1), in: 'path', required: true, schema: { type: 'string' } })))
        .concat((e.params || []).map((x) => ({ name: x.name, in: 'query', required: false, description: x.desc, schema: { type: 'string' } }))),
      responses: { 200: { description: e.returns }, 401: { description: 'Missing or invalid API key' }, 403: { description: 'Key lacks the scope or is limited to another company' }, 404: { description: 'Not found' } }
    };
    if (e.body) op.requestBody = { required: true, content: { 'application/json': { schema: { type: 'object' }, example: JSON.parse(e.body.replace(/"active" \| "pending" \| "suspended"/, '"suspended"')) } } };
    p[e.method.toLowerCase()] = op;
  });
  return {
    openapi: '3.0.3',
    info: { title: 'AI Call Center API', version: '1.0.0', description: 'Read companies, call centers, calls, leads and activity, send leads, and change licenses. Authenticate with "Authorization: Bearer <API key>" (create keys in Super Admin > API). Webhook event types: ' + eventTypes.join(', ') + '.' },
    servers: [{ url: baseUrl }],
    components: { securitySchemes: { bearer: { type: 'http', scheme: 'bearer' } } },
    paths
  };
}

module.exports = { ENDPOINTS, SHAPES, openapi };
