'use strict';
/* Agency console API: BYOK keys, sub-accounts, deployments, branding, users. */
const { h, csrf, requireSession, withAgency, httpError } = require('./util');
const { randomToken, hashPassword } = require('../security');
const { ROLES } = require('../auth');
const { STEPS, AGENCY_STEPS, STEP_LABEL, OUTCOMES, normalizePipeline } = require('../services/provisioner');
const agents = require('../services/agents');
const { normalizeOutbound, normalizeFollowUp, normalizeAlerts } = require('../services/automation');

const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,255}\.[^\s@]{2,}$/;

module.exports = function (app, ctx) {
  const { store, cfg, agencySvc, provisioner, branding } = ctx;
  const admin = [csrf, requireSession(ctx, 'admin', { agencyOnly: true }), withAgency(ctx)];
  const member = [csrf, requireSession(ctx, 'viewer'), withAgency(ctx)];

  function publicDeployment(d) {
    if (!d) return null;
    return {
      locationId: d._id, name: d.name, status: d.status, lastError: d.lastError || '',
      phoneNumber: (d.twilio && d.twilio.phoneNumber) || '',
      twilioSubaccount: (d.twilio && d.twilio.accountSid) || '',
      vapi: d.vapi ? { squadId: d.vapi.squadId || '', assistantIds: d.vapi.assistantIds || {}, phoneNumberId: d.vapi.phoneNumberId || '' } : {},
      agent: d.agent, options: d.options, pipeline: d.pipeline || { pipelineId: '', stages: {} },
      outbound: d.outbound ? Object.assign({}, d.outbound, { key: undefined, webhookUrl: cfg.baseUrl + '/hooks/lead/' + encodeURIComponent(d._id) + '/' + d.outbound.key }) : null,
      followUp: d.followUp || null, alerts: d.alerts || null,
      reportUrl: cfg.baseUrl + '/report?location=' + encodeURIComponent(d._id),
      fieldIds: d.fieldIds || {},
      steps: [].concat(AGENCY_STEPS, STEPS).map((k) => Object.assign({ key: k, label: STEP_LABEL[k] }, (d.steps || {})[k] || { status: 'pending' })),
      portalUrl: cfg.baseUrl + '/deck?location=' + encodeURIComponent(d._id),
      deployedAt: d.deployedAt || '', createdAt: d.createdAt
    };
  }

  app.get('/api/me', h(async (req, res) => {
    const s = req.session;
    if (!s) return res.status(401).json({ error: 'Please sign in' });
    const b = req.brandCompanyId ? req.brand : await branding.forCompany(s.companyId);
    res.json({ user: { name: s.name, email: s.email, role: s.role, kind: s.kind, locationIds: s.locationIds || null }, brand: b, pollMs: cfg.livePollMs });
  }));

  /* ---------- overview + keys ---------- */
  app.get('/api/agency', ...admin, h(async (req, res) => {
    const a = req.agency;
    res.json({
      id: a._id, name: a.name, status: a.status, mode: a.mode === 'account' ? 'account' : 'company', locationId: a.locationId || '',
      edition: agencySvc.edition(req.agency),
      keys: agencySvc.publicKeys(a),
      setup: { takeoverNumber: (a.setup && a.setup.takeoverNumber) || '', browserCalling: !!(a.setup && a.setup.twimlAppSid), vapiCredential: !!(a.setup && a.setup.vapiCredentialId) },
      branding: Object.assign({}, branding.normalizeBranding({}, a.branding || {}), { domain: (a.branding && a.branding.domain) || '' }),
      domainVerified: !!(a.branding && a.branding.domain && ((await store.get('domains', a.branding.domain)) || {}).verified),
      appHost: cfg.baseHost,
      voices: agents.VOICES, outcomes: OUTCOMES,
      languages: Object.entries(agents.LANGUAGES).map(([id, l]) => ({ id, label: l.label })),
      defaults: { outbound: normalizeOutbound({}), followUp: normalizeFollowUp({}), alerts: normalizeAlerts({}) }
    });
  }));

  // Save keys after checking each one live against its provider.
  app.put('/api/agency/keys', ...admin, h(async (req, res) => {
    const a = req.agency;
    const body = req.body || {};
    const merged = agencySvc.encryptKeys(body, a.keys);
    const k = agencySvc.keys({ keys: merged });
    const status = Object.assign({}, a.keyStatus || {});
    const check = async (name, fn) => {
      try { const detail = await fn(); status[name] = { ok: true, detail: detail || 'Connected', at: new Date().toISOString() }; } catch (e) { status[name] = { ok: false, detail: e.message.replace(/^\w+: /, ''), at: new Date().toISOString() }; }
    };
    const changed = (f) => typeof body[f] === 'string' && body[f].trim();
    if ((changed('twilioSid') || changed('twilioToken')) && k.twilioSid && k.twilioToken) {
      await check('twilio', async () => { const acc = await ctx.twilio.client(k.twilioSid, k.twilioToken).getAccount(); return (acc.friendly_name || 'Account') + ' (' + acc.type + ', ' + acc.status + ')'; });
    }
    if (changed('vapiKey')) await check('vapi', async () => { await ctx.vapi.client(k.vapiKey).listAssistants(1); return 'Connected'; });
    if (changed('openaiKey')) await check('openai', async () => { await ctx.openai.client(k.openaiKey).listModels(); return 'Connected'; });
    // Keys that failed validation are not saved.
    const save = Object.assign({}, a.keys || {});
    if (status.twilio && status.twilio.ok) { save.twilioSid = merged.twilioSid; save.twilioToken = merged.twilioToken; }
    if (status.vapi && status.vapi.ok && changed('vapiKey')) save.vapiKey = merged.vapiKey;
    if (status.openai && status.openai.ok && changed('openaiKey')) {
      save.openaiKey = merged.openaiKey;
      // New OpenAI key: re-link it to Vapi on the next deploy.
      await store.patch('agencies', a._id, { 'setup.vapiCredentialId': '' });
    }
    await store.patch('agencies', a._id, { keys: save, keyStatus: status });
    await store.log(a._id, 'keys.updated', Object.keys(status).filter((n) => status[n].ok).join(', '));
    res.json({ keys: agencySvc.publicKeys(Object.assign({}, a, { keys: save, keyStatus: status })) });
  }));

  /* ---------- sub-accounts ---------- */
  app.get('/api/locations', ...admin, h(async (req, res) => {
    // Single-account workspace: the only account it manages is itself.
    if (req.agency.mode === 'account') {
      const id = req.agency.locationId;
      let loc = {};
      try { loc = await (await agencySvc.locationApi(req.agency, id)).getLocation(id); } catch (e) { /* name only */ }
      const d = await store.get('deployments', id);
      return res.json({ installCheck: true, single: true, locations: [{ id, name: loc.name || req.agency.name, city: loc.city || '', state: loc.state || '', timezone: loc.timezone || '', status: d ? d.status : 'none', phoneNumber: d && d.twilio ? d.twilio.phoneNumber || '' : '', appInstalled: true }] });
    }
    const api = await agencySvc.agencyApi(req.agency);
    const locs = [];
    for (let skip = 0; skip < 2000; skip += 100) {
      const page = await api.searchLocations(req.agency._id, skip);
      locs.push(...page);
      if (page.length < 100) break;
    }
    const deps = await store.find('deployments', { companyId: req.agency._id });
    const byId = new Map(deps.map((d) => [d._id, d]));
    // Company app: accounts connect with Private Integration tokens instead.
    const agencyEdition = agencySvc.edition(req.agency) === 'agency';
    // Which accounts have the account app installed (needed for location tokens).
    let installed = null;
    if (!agencyEdition && cfg.apps.standard.appId) {
      try { installed = new Set((await api.installedLocations(req.agency._id, cfg.apps.standard.appId)).map((l) => l._id || l.id)); } catch (e) { installed = null; }
    }
    const tracked = new Map((await store.find('locationInstalls', { companyId: req.agency._id })).map((x) => [x._id, x.installed]));
    const tokens = await agencySvc.crmTokenIds(req.agency);
    res.json({
      installCheck: installed !== null || agencyEdition,
      edition: agencySvc.edition(req.agency),
      locations: locs.map((l) => {
        const id = l.id || l._id;
        const d = byId.get(id);
        const crmToken = tokens.has(id);
        // Company app: an account is reachable once its token is saved.
        const appInstalled = agencyEdition ? crmToken : (crmToken || (installed ? installed.has(id) : (tracked.has(id) ? tracked.get(id) : null)));
        return { id, name: l.name, city: l.city || '', state: l.state || '', timezone: l.timezone || '', status: d ? d.status : 'none', phoneNumber: d && d.twilio ? d.twilio.phoneNumber || '' : '', appInstalled, crmToken };
      }).sort((x, y) => (x.status === 'none') - (y.status === 'none') || String(x.name).localeCompare(String(y.name)))
    });
  }));

  /* Sub-account Private Integration token (agency edition; also a fallback for
     accounts where the app is not installed). Checked live before saving. */
  app.get('/api/locations/:id/crm-token', ...admin, h(async (req, res) => {
    res.json({ connected: await agencySvc.hasCrmToken(req.agency, req.params.id), edition: agencySvc.edition(req.agency) });
  }));
  app.put('/api/locations/:id/crm-token', ...admin, h(async (req, res) => {
    if (req.agency.mode === 'account') throw httpError(400, 'This workspace already has CRM access.');
    const r = await agencySvc.setCrmToken(req.agency, req.params.id, (req.body || {}).token);
    await store.log(req.agency._id, 'crm.connected', r.name || req.params.id);
    res.json({ connected: true, name: r.name });
  }));
  app.delete('/api/locations/:id/crm-token', ...admin, h(async (req, res) => {
    await agencySvc.clearCrmToken(req.agency, req.params.id);
    await store.log(req.agency._id, 'crm.disconnected', req.params.id);
    res.json({ connected: false });
  }));

  // Pipelines + calendars of one sub-account, for the deploy wizard.
  app.get('/api/locations/:id/crm', ...admin, h(async (req, res) => {
    const id = req.params.id;
    const api = await agencySvc.locationApi(req.agency, id);
    const [pipelines, calendars, location] = await Promise.all([
      api.listPipelines(id).catch(() => []),
      api.listCalendars(id).catch(() => []),
      api.getLocation(id).catch(() => ({}))
    ]);
    res.json({
      location: { id, name: location.name || '', timezone: location.timezone || '', phone: location.phone || '', website: location.website || '', address: [location.city, location.state].filter(Boolean).join(', ') },
      pipelines: pipelines.map((p) => ({ id: p.id, name: p.name, stages: (p.stages || []).map((s) => ({ id: s.id, name: s.name })) })),
      calendars: calendars.map((c) => ({ id: c.id, name: c.name }))
    });
  }));

  /* ---------- deployments ---------- */
  app.get('/api/deployments', ...member, h(async (req, res) => {
    const f = { companyId: req.agency._id };
    const scope = ctx.auth.scope(req.session);
    if (scope.locationId) f._id = scope.locationId;
    else if (scope.locationIds) f._id = { $in: scope.locationIds };
    const deps = (await store.find('deployments', f, { sort: { createdAt: -1 } })).filter((d) => d.status !== 'removed' || req.session.kind === 'agency');
    const isAdmin = ctx.auth.can(req.session, 'admin') && req.session.kind === 'agency';
    res.json({ deployments: deps.map((d) => (isAdmin ? publicDeployment(d) : { locationId: d._id, name: d.name, status: d.status, phoneNumber: (d.twilio && d.twilio.phoneNumber) || '' })) });
  }));

  app.get('/api/deployments/:id', ...admin, h(async (req, res) => {
    const d = await store.get('deployments', req.params.id);
    if (!d || d.companyId !== req.agency._id) throw httpError(404, 'Not found');
    res.json({ deployment: publicDeployment(d) });
  }));

  // Create or update the draft (agent settings, pipeline mapping, number prefs).
  app.put('/api/deployments/:id', ...admin, h(async (req, res) => {
    const d = await provisioner.createDeployment(req.agency, Object.assign({}, req.body, { locationId: req.params.id }));
    res.json({ deployment: publicDeployment(d) });
  }));

  // Run (or resume) the provisioning chain. Long: up to ~30s.
  app.post('/api/deployments/:id/deploy', ...admin, h(async (req, res) => {
    const d = await store.get('deployments', req.params.id);
    if (!d || d.companyId !== req.agency._id) throw httpError(404, 'Not found');
    if (d.status === 'deploying' && Date.parse(d.deployStartedAt || 0) > Date.now() - 90e3) throw httpError(409, 'A deployment is already running');
    try {
      const out = await provisioner.deploy(req.agency, req.params.id, { browserCalling: req.body.browserCalling !== false });
      res.json({ deployment: publicDeployment(out) });
    } catch (e) {
      const fresh = await store.get('deployments', req.params.id);
      res.status(e.status && e.status < 500 ? e.status : 502).json({ error: e.message, step: e.step, deployment: publicDeployment(fresh) });
    }
  }));

  app.post('/api/deployments/:id/agents', ...admin, h(async (req, res) => {
    const d = await store.get('deployments', req.params.id);
    if (!d || d.companyId !== req.agency._id) throw httpError(404, 'Not found');
    if (req.body.agent) await store.patch('deployments', d._id, { agent: agents.normalizeAgent(req.body.agent, d.agent) });
    if (req.body.pipeline) await store.patch('deployments', d._id, { pipeline: normalizePipeline(req.body.pipeline) });
    if (req.body.outbound) await store.patch('deployments', d._id, { outbound: normalizeOutbound(req.body.outbound, d.outbound) });
    if (req.body.followUp) await store.patch('deployments', d._id, { followUp: normalizeFollowUp(req.body.followUp, d.followUp) });
    if (req.body.alerts) await store.patch('deployments', d._id, { alerts: normalizeAlerts(req.body.alerts, d.alerts) });
    await provisioner.updateAgents(req.agency, d._id);
    res.json({ deployment: publicDeployment(await store.get('deployments', d._id)) });
  }));

  app.post('/api/deployments/:id/teardown', ...admin, h(async (req, res) => {
    const r = await provisioner.teardown(req.agency, req.params.id, { releaseNumber: req.body.releaseNumber !== false, closeSubaccount: !!req.body.closeSubaccount });
    res.json(r);
  }));

  // Preview the generated system prompts.
  app.post('/api/agents/preview', ...admin, (req, res) => {
    const a = agents.normalizeAgent(req.body.agent || {});
    res.json({ prompts: Object.fromEntries(agents.ROLES.map((r) => [r, agents.systemPrompt(r, a)])) });
  });

  // Outbound test call from the client's number, answered by the squad.
  app.post('/api/deployments/:id/test-call', ...admin, h(async (req, res) => {
    const d = await store.get('deployments', req.params.id);
    if (!d || d.companyId !== req.agency._id || d.status !== 'live') throw httpError(400, 'Deploy this client first');
    const number = String(req.body.number || '').replace(/[^\d+]/g, '');
    if (!/^\+\d{8,15}$/.test(number)) throw httpError(400, 'Use international format, e.g. +15551234567');
    const v = ctx.vapi.client(agencySvc.keys(req.agency).vapiKey);
    const call = await v.createCall({ phoneNumberId: d.vapi.phoneNumberId, squadId: d.vapi.squadId, customer: { number } });
    await store.log(req.agency._id, 'call.test', number, { locationId: d._id });
    res.json({ ok: true, callId: call.id });
  }));

  /* ---------- branding / white-label ---------- */
  app.put('/api/agency/branding', ...admin, h(async (req, res) => {
    const b = branding.normalizeBranding(req.body || {}, req.agency.branding || {});
    await store.patch('agencies', req.agency._id, { branding: Object.assign(b, { domain: (req.agency.branding && req.agency.branding.domain) || '' }) });
    let domain = null;
    if (req.body.domain !== undefined) domain = await branding.setDomain(Object.assign({}, req.agency, { branding: b }), req.body.domain);
    res.json({ ok: true, branding: b, domain });
  }));

  app.post('/api/agency/domain/verify', ...admin, h(async (req, res) => {
    const a = await store.get('agencies', req.agency._id);
    res.json(await branding.verifyDomain(a));
  }));

  /* ---------- users (agency staff + client logins) ---------- */
  const publicUser = (u) => ({ id: u._id, email: u.email, name: u.name, kind: u.kind, role: u.role, locationIds: u.locationIds || null, disabled: !!u.disabled, lastLoginAt: u.lastLoginAt || '' });

  app.get('/api/users', ...admin, h(async (req, res) => {
    const users = await store.find('users', { companyId: req.agency._id }, { sort: { createdAt: 1 } });
    res.json({ users: users.map(publicUser) });
  }));

  app.post('/api/users', ...admin, h(async (req, res) => {
    const b = req.body || {};
    const email = String(b.email || '').trim().toLowerCase();
    if (!EMAIL.test(email)) throw httpError(400, 'Enter a valid email');
    if ((await store.find('users', { email }, { limit: 1 })).length) throw httpError(409, 'That email already has a login');
    const kind = b.kind === 'client' ? 'client' : 'agency';
    const role = ROLES.includes(b.role) && b.role !== 'owner' ? b.role : 'viewer';
    if (kind === 'agency' && role === 'admin' && req.session.role !== 'owner') throw httpError(403, 'Only the owner can add admins');
    let locationIds = null;
    if (kind === 'client') {
      const ids = [].concat(b.locationIds || []).map(String);
      const deps = await store.find('deployments', { companyId: req.agency._id, _id: { $in: ids } });
      locationIds = deps.map((d) => d._id);
      if (!locationIds.length) throw httpError(400, 'Pick at least one deployed account');
      if (role === 'admin') throw httpError(400, 'Client users can be manager or viewer');
    }
    const password = String(b.password || '') || randomToken(9);
    if (password.length < 10) throw httpError(400, 'Use at least 10 characters');
    const u = { _id: 'u_' + randomToken(10), email, name: String(b.name || '').slice(0, 80), companyId: req.agency._id, kind, role, locationIds, passwordHash: await hashPassword(password), createdAt: new Date().toISOString(), sessionVersion: 0 };
    await store.put('users', u);
    await store.log(req.agency._id, 'user.created', email + ' (' + kind + ' ' + role + ')');
    const domain = req.agency.branding && req.agency.branding.domain;
    res.json({ user: publicUser(u), password: b.password ? undefined : password, loginUrl: (domain ? 'https://' + domain : cfg.baseUrl) + '/login' });
  }));

  app.patch('/api/users/:id', ...admin, h(async (req, res) => {
    const u = await store.get('users', req.params.id);
    if (!u || u.companyId !== req.agency._id) throw httpError(404, 'Not found');
    if (u.role === 'owner' && u._id !== req.session.uid) throw httpError(403, 'The owner login can only be changed by the owner');
    const set = {};
    if (req.body.disabled !== undefined && u.role !== 'owner') { set.disabled = !!req.body.disabled; }
    if (req.body.password) {
      if (String(req.body.password).length < 10) throw httpError(400, 'Use at least 10 characters');
      set.passwordHash = await hashPassword(String(req.body.password));
    }
    if (req.body.role && u.role !== 'owner' && ROLES.includes(req.body.role) && req.body.role !== 'owner') set.role = req.body.role;
    // Any change signs that user out everywhere.
    await store.patch('users', u._id, set, { inc: { sessionVersion: u._id === req.session.uid ? 0 : 1 } });
    res.json({ user: publicUser(await store.get('users', u._id)) });
  }));

  app.delete('/api/users/:id', ...admin, h(async (req, res) => {
    const u = await store.get('users', req.params.id);
    if (!u || u.companyId !== req.agency._id) throw httpError(404, 'Not found');
    if (u.role === 'owner') throw httpError(403, 'The owner login cannot be deleted');
    await store.remove('users', u._id);
    await store.log(req.agency._id, 'user.deleted', u.email);
    res.json({ ok: true });
  }));

  app.get('/api/events', ...admin, h(async (req, res) => {
    res.json({ events: await store.events({ companyId: req.agency._id }, 100) });
  }));

  app.locals.publicDeployment = publicDeployment;
};
