'use strict';
/* Platform-wide read model shared by the REST API (/api/v1) and the Super
   Admin portal. Everything here returns public shapes only: no secrets, no
   tokens, no monitor URLs. `scope.companyId` (set for company-restricted API
   keys) limits every query to one company. */

const ACTIVE = ['queued', 'ringing', 'in-progress', 'forwarding'];
const MAX = 200;

const clampLimit = (n) => Math.min(MAX, Math.max(1, Number(n) || 50));
const iso = (v) => { const t = Date.parse(v); return Number.isFinite(t) ? new Date(t).toISOString() : null; };
const notFound = (what) => Object.assign(new Error(what + ' not found'), { status: 404 });

function createPlatform(ctx) {
  const { store } = ctx;

  /* ---------- shapes ---------- */
  function company(a, extra) {
    const ks = a.keyStatus || {};
    return Object.assign({
      id: a._id,
      name: a.name || '',
      type: a.mode === 'account' ? 'single_account' : 'company',
      apps: Object.keys(a.ghlApps || {}).length ? Object.keys(a.ghlApps).map(appName) : [appName(a.app)],
      primaryApp: appName(a.app),
      status: a.status || 'active',
      installed: !!a.installed,
      installedAt: a.installedAt || null,
      uninstalledAt: a.uninstalledAt || null,
      createdAt: a.createdAt || null,
      crmCompanyId: a.mode === 'account' ? a.ghlCompanyId || null : a._id,
      accountId: a.mode === 'account' ? a.locationId : null,
      providerKeys: { twilio: !!(ks.twilio && ks.twilio.ok), vapi: !!(ks.vapi && ks.vapi.ok), openai: !!(ks.openai && ks.openai.ok) },
      takeoverLine: (a.setup && a.setup.takeoverNumber) || null,
      branding: { name: (a.branding && a.branding.name) || '', domain: (a.branding && a.branding.domain) || '' }
    }, extra || {});
  }
  const appName = (k) => (k === 'agency' ? 'company_app' : 'account_app');

  function account(d) {
    return {
      id: d._id,
      companyId: d.companyId,
      name: d.name || '',
      status: d.status,
      phoneNumber: (d.twilio && d.twilio.phoneNumber) || null,
      lastError: d.lastError || null,
      createdAt: d.createdAt || null,
      deployedAt: d.deployedAt || null,
      business: d.agent ? { name: d.agent.businessName, industry: d.agent.industry, timezone: d.agent.timezone, language: d.agent.language || 'en', avgJobValue: d.agent.avgJobValue || 0 } : null,
      features: {
        speedToLead: !!(d.outbound && d.outbound.enabled),
        smsFollowUp: !!(d.followUp && d.followUp.enabled),
        alerts: !(d.alerts && d.alerts.enabled === false),
        booking: !!(d.agent && d.agent.calendarId),
        pipelineMapping: !!(d.pipeline && d.pipeline.pipelineId)
      },
      steps: Object.entries(d.steps || {}).map(([key, s]) => ({ key, status: s.status, detail: s.detail || '', at: s.at || null })),
      vapi: d.vapi ? { squadId: d.vapi.squadId || null, phoneNumberId: d.vapi.phoneNumberId || null } : null
    };
  }

  function call(c, full) {
    const out = {
      id: c._id,
      companyId: c.companyId,
      accountId: c.locationId,
      status: c.status,
      live: ACTIVE.includes(c.status),
      direction: c.direction || 'inbound',
      customer: { number: (c.customer && c.customer.number) || null, name: (c.customer && c.customer.name) || null },
      agent: c.agent || null,
      createdAt: c.createdAt || null,
      answeredAt: c.answeredAt || null,
      endedAt: c.endedAt || null,
      durationSec: c.durationSec || null,
      endedReason: c.endedReason || null,
      cost: typeof c.cost === 'number' ? c.cost : null,
      recordingUrl: c.recordingUrl || null,
      summary: (c.grade && c.grade.summary) || c.summary || null,
      grade: c.grade ? { score: c.grade.score, sentiment: c.grade.sentiment, outcome: c.grade.outcome, nextSteps: c.grade.nextSteps || [], coaching: c.grade.coaching || [], flags: c.grade.flags || [] } : null,
      booked: c.booked ? { at: c.booked.at, contactId: c.booked.contactId || null } : null,
      ticket: c.ticket || null,
      alerts: (c.alerts || []).map((a) => ({ kind: a.kind, text: a.text, at: a.at })),
      takeover: c.takeover ? { state: c.takeover.state, by: c.takeover.byName || null } : null,
      leadId: c.leadId || null,
      crmSync: c.sync ? { state: c.sync.state, attempts: c.sync.attempts || 0, contactId: c.sync.contactId || null, opportunityId: c.sync.opportunityId || null, sms: c.sync.sms || null, error: c.sync.error || null } : null
    };
    if (full) {
      out.transcript = (c.transcript || []).map((l) => ({ role: l.role, agent: l.agent || null, text: l.text, at: l.at || null }));
      out.whispers = (c.whispers || []).map((w) => ({ kind: w.kind, text: w.text, by: w.by, at: w.at }));
    }
    return out;
  }

  function lead(l) {
    return {
      id: l._id, companyId: l.companyId, accountId: l.locationId,
      phone: l.phone, name: l.name || null, interest: l.interest || null, crmContactId: l.contactId || null,
      status: l.status, attempts: l.attempts || 0, reason: l.reason || null,
      createdAt: l.createdAt, nextAt: l.nextAt || null, lastCallAt: l.lastCallAt || null, finishedAt: l.finishedAt || null,
      callIds: l.callIds || []
    };
  }

  const event = (e) => ({ at: e.at, companyId: e.companyId, type: e.type, detail: e.detail, accountId: e.locationId || null, callId: e.callId || null });

  /* ---------- scoping ---------- */
  function guardCompany(scope, companyId) {
    if (scope.companyId && companyId && scope.companyId !== companyId) throw Object.assign(new Error('This API key is limited to another company'), { status: 403 });
  }
  function baseFilter(scope, q) {
    const f = {};
    const companyId = scope.companyId || q.companyId;
    if (companyId) f.companyId = String(companyId);
    if (q.accountId) f.locationId = String(q.accountId);
    return f;
  }
  function page(docs, limit, field) {
    const more = docs.length > limit;
    const data = docs.slice(0, limit);
    return { data, nextBefore: more && data.length ? data[data.length - 1][field] : null };
  }

  /* ---------- companies ---------- */
  async function listCompanies(scope, q) {
    q = q || {};
    const f = {};
    if (scope.companyId) f._id = scope.companyId;
    if (q.status) f.status = String(q.status);
    if (q.type === 'single_account') f.mode = 'account';
    let docs = await store.find('agencies', f, { sort: { createdAt: -1 } });
    if (q.type === 'company') docs = docs.filter((a) => a.mode !== 'account');
    if (q.installed !== undefined) docs = docs.filter((a) => !!a.installed === (q.installed === true || q.installed === 'true'));
    if (q.q) { const t = String(q.q).toLowerCase(); docs = docs.filter((a) => (a.name || '').toLowerCase().includes(t) || a._id.toLowerCase().includes(t) || ((a.branding && a.branding.domain) || '').includes(t)); }
    const deps = await store.find('deployments', scope.companyId ? { companyId: scope.companyId } : {});
    const counts = {};
    deps.forEach((d) => { const c = counts[d.companyId] = counts[d.companyId] || { total: 0, live: 0, failed: 0 }; if (d.status !== 'removed') c.total++; if (d.status === 'live') c.live++; if (d.status === 'failed') c.failed++; });
    return docs.map((a) => company(a, { accounts: counts[a._id] || { total: 0, live: 0, failed: 0 } }));
  }

  async function getCompany(scope, id) {
    guardCompany(scope, id);
    const a = await store.get('agencies', id);
    if (!a) throw notFound('Company');
    const [deps, users, crmTokens] = await Promise.all([
      store.find('deployments', { companyId: id }, { sort: { createdAt: -1 } }),
      store.find('users', { companyId: id }),
      store.find('crmTokens', { companyId: id })
    ]);
    const connected = new Set(crmTokens.filter((t) => t.token).map((t) => t._id));
    return company(a, {
      accounts: deps.map((d) => Object.assign(account(d), { crmConnected: connected.has(d._id) || undefined })),
      users: users.map((u) => ({ id: u._id, email: u.email, name: u.name || '', kind: u.kind === 'client' ? 'client' : 'staff', role: u.role, accountIds: u.locationIds || null, disabled: !!u.disabled, lastLoginAt: u.lastLoginAt || null }))
    });
  }

  async function setCompanyStatus(scope, id, status) {
    guardCompany(scope, id);
    if (!['active', 'pending', 'suspended'].includes(status)) throw Object.assign(new Error('status must be active, pending or suspended'), { status: 400 });
    const a = await store.patch('agencies', id, { status });
    if (!a) throw notFound('Company');
    await store.log(id, 'license.' + status, 'via API');
    return company(a);
  }

  /* ---------- accounts (deployed call centers) ---------- */
  async function listAccounts(scope, q) {
    const f = baseFilter(scope, q || {});
    if (f.locationId) { f._id = f.locationId; delete f.locationId; }
    if (q && q.status) f.status = String(q.status);
    return (await store.find('deployments', f, { sort: { createdAt: -1 } })).map(account);
  }
  async function getAccount(scope, id) {
    const d = await store.get('deployments', id);
    if (!d) throw notFound('Account');
    guardCompany(scope, d.companyId);
    return account(d);
  }

  /* ---------- calls ---------- */
  async function listCalls(scope, q) {
    q = q || {};
    const f = baseFilter(scope, q);
    if (q.status === 'live') f.status = { $in: ACTIVE };
    else if (q.status) f.status = String(q.status);
    if (q.direction) f.direction = String(q.direction);
    if (q.outcome) f['grade.outcome'] = String(q.outcome);
    if (q.leadId) f.leadId = String(q.leadId);
    const range = {};
    if (iso(q.since)) range.$gte = iso(q.since);
    if (iso(q.until)) range.$lt = iso(q.until);
    if (iso(q.before)) range.$lt = iso(q.before);
    if (Object.keys(range).length) f.createdAt = range;
    const limit = clampLimit(q.limit);
    const docs = await store.find('calls', f, { sort: { createdAt: -1 }, limit: limit + 1 });
    let out = docs;
    if (q.alerts === 'true' || q.alerts === true) out = out.filter((c) => (c.alerts || []).length);
    if (q.syncState) out = out.filter((c) => c.sync && c.sync.state === q.syncState);
    const p = page(out.map((c) => call(c)), limit, 'createdAt');
    return p;
  }
  async function getCall(scope, id) {
    const c = await store.get('calls', id);
    if (!c) throw notFound('Call');
    guardCompany(scope, c.companyId);
    return call(c, true);
  }

  /* ---------- leads ---------- */
  async function listLeads(scope, q) {
    q = q || {};
    const f = baseFilter(scope, q);
    if (q.status) f.status = String(q.status);
    const range = {};
    if (iso(q.since)) range.$gte = iso(q.since);
    if (iso(q.before)) range.$lt = iso(q.before);
    if (Object.keys(range).length) f.createdAt = range;
    const limit = clampLimit(q.limit);
    return page((await store.find('leads', f, { sort: { createdAt: -1 }, limit: limit + 1 })).map(lead), limit, 'createdAt');
  }
  async function getLead(scope, id) {
    const l = await store.get('leads', id);
    if (!l) throw notFound('Lead');
    guardCompany(scope, l.companyId);
    return lead(l);
  }
  async function createLead(scope, body) {
    const accountId = String((body && body.accountId) || '');
    const d = await store.get('deployments', accountId);
    if (!d) throw notFound('Account');
    guardCompany(scope, d.companyId);
    if (d.status !== 'live') throw Object.assign(new Error('This account is not live'), { status: 409 });
    const r = await ctx.automation.receiveLead(d, { phone: body.phone, first_name: body.name, contact_id: body.crmContactId, customData: { interest: body.interest } });
    if (r.error) throw Object.assign(new Error(r.error), { status: r.status });
    if (r.callNow) ctx.background('lead ' + r.lead._id, () => ctx.automation.placeCall(r.lead._id));
    return { lead: lead(r.lead), duplicate: !!r.duplicate };
  }

  /* ---------- events ---------- */
  async function listEvents(scope, q) {
    q = q || {};
    const f = {};
    if (scope.companyId || q.companyId) f.companyId = scope.companyId || String(q.companyId);
    if (q.type) f.type = String(q.type);
    if (q.accountId) f.locationId = String(q.accountId);
    const limit = clampLimit(q.limit);
    let docs = await store.events(f, 2000);
    if (iso(q.since)) docs = docs.filter((e) => e.at >= iso(q.since));
    if (iso(q.before)) docs = docs.filter((e) => e.at < iso(q.before));
    return page(docs.slice(0, limit + 1).map(event), limit, 'at');
  }

  /* ---------- stats ---------- */
  async function stats(scope, q) {
    q = q || {};
    const days = Math.min(365, Math.max(1, Number(q.days) || 30));
    const since = new Date(Date.now() - days * 86400e3).toISOString();
    const f = baseFilter(scope, q);
    const calls = await store.find('calls', Object.assign({}, f, { createdAt: { $gte: since } }), { limit: 50000 });
    const leads = await store.find('leads', Object.assign({}, f, { createdAt: { $gte: since } }), { limit: 50000 });
    const daily = {};
    for (let i = days - 1; i >= 0; i--) daily[new Date(Date.now() - i * 86400e3).toISOString().slice(0, 10)] = { calls: 0, booked: 0 };
    const outcomes = {};
    const perCompany = {};
    let minutes = 0, cost = 0, scoreSum = 0, graded = 0, booked = 0, live = 0, alerts = 0, syncFailed = 0, syncQueued = 0;
    calls.forEach((c) => {
      const k = String(c.createdAt).slice(0, 10);
      const isBooked = !!(c.booked || (c.grade && c.grade.outcome === 'appointment_booked'));
      if (daily[k]) { daily[k].calls++; if (isBooked) daily[k].booked++; }
      if (ACTIVE.includes(c.status)) live++;
      minutes += (c.durationSec || 0) / 60;
      cost += c.cost || 0;
      if (c.grade) { graded++; scoreSum += c.grade.score; outcomes[c.grade.outcome] = (outcomes[c.grade.outcome] || 0) + 1; }
      if (isBooked) booked++;
      if ((c.alerts || []).length) alerts++;
      if (c.sync && c.sync.state === 'failed') syncFailed++;
      if (c.sync && (c.sync.state === 'queued' || c.sync.state === 'running')) syncQueued++;
      const pc = perCompany[c.companyId] = perCompany[c.companyId] || { calls: 0, booked: 0, minutes: 0 };
      pc.calls++; if (isBooked) pc.booked++; pc.minutes += (c.durationSec || 0) / 60;
    });
    const leadStatus = {};
    leads.forEach((l) => { leadStatus[l.status] = (leadStatus[l.status] || 0) + 1; });
    return {
      days, since,
      calls: { total: calls.length, live, minutes: Math.round(minutes), cost: Math.round(cost * 100) / 100, booked, alerts, avgScore: graded ? Math.round(scoreSum / graded) : null, outcomes },
      crmSync: { failed: syncFailed, pending: syncQueued },
      leads: { total: leads.length, byStatus: leadStatus },
      daily: Object.entries(daily).map(([date, v]) => Object.assign({ date }, v)),
      topCompanies: Object.entries(perCompany).sort((a, b) => b[1].calls - a[1].calls).slice(0, 10)
        .map(([companyId, v]) => ({ companyId, calls: v.calls, booked: v.booked, minutes: Math.round(v.minutes) }))
    };
  }

  return { company, account, call, lead, event, listCompanies, getCompany, setCompanyStatus, listAccounts, getAccount, listCalls, getCall, listLeads, getLead, createLead, listEvents, stats };
}

module.exports = { createPlatform };
