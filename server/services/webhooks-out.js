'use strict';
/* Outgoing webhooks: push platform events to your other apps.

   Every activity-log entry with a mapped type becomes an event. Each
   subscription receives POST <url> with JSON
     { id, type, createdAt, companyId, data }
   and headers
     X-ACC-Event: <type>
     X-ACC-Delivery: <delivery id>
     X-ACC-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256(secret, t + "." + rawBody)>
   A 2xx answer is success. Failures retry after 1 min, 5 min, 30 min, 2 h,
   12 h (6 attempts in total), run by the background sweep. */
const crypto = require('crypto');
const { randomToken } = require('../security');

// Activity-log type -> public event type.
const EVENT_MAP = {
  'app.installed': 'company.installed',
  'app.reinstalled': 'company.installed',
  'app.uninstalled': 'company.uninstalled',
  'license.active': 'company.status_changed',
  'license.pending': 'company.status_changed',
  'license.suspended': 'company.status_changed',
  'deploy.done': 'account.deployed',
  'deploy.failed': 'account.deploy_failed',
  'deploy.removed': 'account.removed',
  'crm.connected': 'account.crm_connected',
  'call.start': 'call.started',
  'call.end': 'call.ended',
  'call.synced': 'call.graded',
  'call.alert': 'call.alert',
  'call.takeover': 'call.takeover',
  'lead.received': 'lead.received',
  'lead.called': 'lead.called',
  'lead.finished': 'lead.finished',
  'sms.sent': 'sms.sent'
};
const EVENT_TYPES = Array.from(new Set(Object.values(EVENT_MAP))).sort();
const BACKOFF_MIN = [1, 5, 30, 120, 720];
const MAX_ATTEMPTS = BACKOFF_MIN.length + 1;

function sign(secret, body, t) {
  t = t || Math.floor(Date.now() / 1000);
  return 't=' + t + ',v1=' + crypto.createHmac('sha256', secret).update(t + '.' + body).digest('hex');
}

function validUrl(raw) {
  let u;
  try { u = new URL(String(raw || '')); } catch (e) { return ''; }
  if (u.protocol !== 'https:') return '';
  // No internal addresses (keeps the server from being used to probe its network).
  if (/^(localhost|127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|0\.|\[?::1\]?$|.*\.internal$|.*\.local$)/i.test(u.hostname)) return '';
  return u.toString();
}

function createOutgoingWebhooks(ctx, deps) {
  const { store, sec } = ctx;
  const doFetch = (deps && deps.fetch) || ((...a) => fetch(...a));
  let cache = null;

  async function hooks() {
    if (!cache || cache.at < Date.now() - 30e3) cache = { at: Date.now(), list: await store.find('webhooks', { active: true }) };
    return cache.list;
  }
  const invalidate = () => { cache = null; };

  function publicHook(w) {
    return { id: w._id, url: w.url, events: w.events, companyId: w.companyId || null, active: !!w.active, description: w.description || '', createdAt: w.createdAt, lastStatus: w.lastStatus || null, lastAt: w.lastAt || null, failures: w.failures || 0 };
  }

  async function create(input) {
    const url = validUrl(input.url);
    if (!url) throw Object.assign(new Error('Use a public https:// URL'), { status: 400 });
    let events = Array.isArray(input.events) ? input.events.map(String) : ['*'];
    events = events.filter((e) => e === '*' || EVENT_TYPES.includes(e));
    if (!events.length) events = ['*'];
    const secret = 'whsec_' + randomToken(24);
    const w = { _id: 'wh_' + randomToken(10), url, events, companyId: input.companyId ? String(input.companyId) : null, description: String(input.description || '').slice(0, 120), secret: sec.encrypt(secret), active: true, createdAt: new Date().toISOString(), failures: 0 };
    await store.put('webhooks', w);
    invalidate();
    return { webhook: publicHook(w), secret };
  }

  async function update(id, input) {
    const w = await store.get('webhooks', id);
    if (!w) throw Object.assign(new Error('Webhook not found'), { status: 404 });
    const set = {};
    if (input.active !== undefined) set.active = !!input.active;
    if (input.url !== undefined) { const u = validUrl(input.url); if (!u) throw Object.assign(new Error('Use a public https:// URL'), { status: 400 }); set.url = u; }
    if (Array.isArray(input.events)) set.events = input.events.filter((e) => e === '*' || EVENT_TYPES.includes(e));
    if (input.description !== undefined) set.description = String(input.description).slice(0, 120);
    const out = await store.patch('webhooks', id, set);
    invalidate();
    return publicHook(out);
  }

  async function remove(id) { await store.remove('webhooks', id); invalidate(); }
  async function list() { return (await store.find('webhooks', {}, { sort: { createdAt: -1 } })).map(publicHook); }
  async function deliveries(hookId, limit) {
    const f = hookId ? { hookId } : {};
    return (await store.find('webhookDeliveries', f, { sort: { createdAt: -1 }, limit: Math.min(200, limit || 50) }))
      .map((d) => ({ id: d._id, hookId: d.hookId, type: d.type, status: d.status, attempts: d.attempts, lastCode: d.lastCode || null, lastError: d.lastError || null, createdAt: d.createdAt, nextAt: d.nextAt || null }));
  }

  // Builds the event payload, adding the related object when there is one.
  async function payload(type, companyId, detail, extra) {
    const p = ctx.platform;
    const data = { detail: detail || '' };
    try {
      if (extra && extra.callId) { const c = await store.get('calls', extra.callId); if (c) data.call = p.call(c); }
      if (extra && extra.leadId) { const l = await store.get('leads', extra.leadId); if (l) data.lead = p.lead(l); }
      if (extra && extra.locationId) { const d = await store.get('deployments', extra.locationId); if (d) data.account = p.account(d); }
      if (/^company\./.test(type) && companyId) { const a = await store.get('agencies', companyId); if (a) data.company = p.company(a); }
    } catch (e) { /* best effort */ }
    return { id: 'evt_' + randomToken(12), type, createdAt: new Date().toISOString(), companyId: companyId || null, data };
  }

  async function attempt(deliveryId) {
    const d = await store.get('webhookDeliveries', deliveryId);
    if (!d || d.status === 'delivered' || d.status === 'failed') return d;
    const w = await store.get('webhooks', d.hookId);
    if (!w || !w.active) return store.patch('webhookDeliveries', deliveryId, { status: 'cancelled' });
    const body = d.body;
    let code = 0, error = '';
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 10000);
      const r = await doFetch(w.url, {
        method: 'POST', signal: ctrl.signal,
        headers: { 'Content-Type': 'application/json', 'User-Agent': 'AI-Call-Center-Webhooks/1', 'X-ACC-Event': d.type, 'X-ACC-Delivery': d._id, 'X-ACC-Signature': sign(sec.decrypt(w.secret), body) },
        body
      }).finally(() => clearTimeout(timer));
      code = r.status;
      if (!(r.status >= 200 && r.status < 300)) error = 'HTTP ' + r.status;
    } catch (e) { error = e.name === 'AbortError' ? 'timeout' : e.message; }
    const attempts = (d.attempts || 0) + 1;
    const ok = !error;
    const status = ok ? 'delivered' : (attempts >= MAX_ATTEMPTS ? 'failed' : 'retrying');
    const next = ok || status === 'failed' ? null : new Date(Date.now() + BACKOFF_MIN[attempts - 1] * 60e3).toISOString();
    await store.patch('webhookDeliveries', deliveryId, { status, attempts, lastCode: code || null, lastError: error || null, nextAt: next, at: new Date().toISOString() });
    await store.patch('webhooks', w._id, { lastStatus: ok ? 'ok' : 'error', lastAt: new Date().toISOString(), failures: ok ? 0 : (w.failures || 0) + 1 });
    return { ok, code, error };
  }

  // Called for every activity-log entry.
  async function onLog(companyId, logType, detail, extra) {
    const type = EVENT_MAP[logType];
    if (!type) return;
    const targets = (await hooks()).filter((w) => (!w.companyId || w.companyId === companyId) && (w.events.includes('*') || w.events.includes(type)));
    if (!targets.length) return;
    const evt = await payload(type, companyId, detail, extra);
    const body = JSON.stringify(evt);
    for (const w of targets) {
      const d = { _id: 'dlv_' + randomToken(10), hookId: w._id, eventId: evt.id, type, body, status: 'pending', attempts: 0, createdAt: new Date().toISOString(), nextAt: new Date().toISOString() };
      await store.put('webhookDeliveries', d);
      ctx.background('webhook ' + d._id, () => attempt(d._id));
    }
  }

  async function sendTest(id) {
    const w = await store.get('webhooks', id);
    if (!w) throw Object.assign(new Error('Webhook not found'), { status: 404 });
    const evt = { id: 'evt_test_' + randomToken(8), type: 'ping', createdAt: new Date().toISOString(), companyId: w.companyId || null, data: { message: 'Test delivery from AI Call Center' } };
    const d = { _id: 'dlv_' + randomToken(10), hookId: w._id, eventId: evt.id, type: 'ping', body: JSON.stringify(evt), status: 'pending', attempts: MAX_ATTEMPTS - 1, createdAt: new Date().toISOString() };
    await store.put('webhookDeliveries', d);
    return attempt(d._id);
  }

  // Background sweep: retry due deliveries.
  async function retryDue(limit) {
    const now = new Date().toISOString();
    const due = (await store.find('webhookDeliveries', { status: { $in: ['retrying', 'pending'] } }, { limit: (limit || 50) * 2 }))
      .filter((d) => !d.nextAt || d.nextAt <= now).filter((d) => d.status === 'retrying' || Date.parse(d.createdAt) < Date.now() - 60e3).slice(0, limit || 50);
    for (const d of due) await attempt(d._id);
    return due.length;
  }

  return { create, update, remove, list, deliveries, onLog, sendTest, retryDue, attempt, EVENT_TYPES };
}

module.exports = { createOutgoingWebhooks, EVENT_MAP, EVENT_TYPES, sign, validUrl };
