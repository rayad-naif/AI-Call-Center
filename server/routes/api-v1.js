'use strict';
/* Public REST API (/api/v1) for connecting your other apps, plus the Super
   Admin endpoints that manage API keys and outgoing webhooks.

   Auth: "Authorization: Bearer acc_…" (keys are created in Super Admin > API
   and stored only as a SHA-256 hash), or the Super Admin session cookie (the
   admin portal itself uses this API; writes then need the X-ACC header).
   Scopes: read, write. A key can be limited to one company. */
const { h, httpError } = require('./util');
const { randomToken, sha256 } = require('../security');
const spec = require('../api-spec');

module.exports = function (app, ctx) {
  const { store, platform, cfg } = ctx;
  const VERSION = '1.0.0';

  /* ---------- API keys ---------- */
  function publicKey(k) {
    return { id: k.prefix, name: k.name, scopes: k.scopes, companyId: k.companyId || null, createdAt: k.createdAt, lastUsedAt: k.lastUsedAt || null, revoked: !!k.revoked };
  }

  async function authenticate(req) {
    const m = String(req.headers.authorization || '').match(/^Bearer\s+(acc_[A-Za-z0-9_-]{20,})$/);
    if (m) {
      const key = await store.get('apiKeys', sha256(m[1]));
      if (!key || key.revoked) return null;
      if (!key.lastUsedAt || Date.parse(key.lastUsedAt) < Date.now() - 60e3) store.patch('apiKeys', key._id, { lastUsedAt: new Date().toISOString() }).catch(() => {});
      return { kind: 'key', name: key.name, scopes: key.scopes, companyId: key.companyId || null, keyId: key.prefix };
    }
    if (req.isAdmin) return { kind: 'admin', name: 'Super Admin', scopes: ['read', 'write'], companyId: null };
    return null;
  }

  const need = (scope) => h(async (req, res, next) => {
    const who = await authenticate(req);
    if (!who) return res.status(401).json({ error: 'Send "Authorization: Bearer <API key>". Create keys in Super Admin > API.' });
    if (who.kind === 'admin' && req.method !== 'GET' && req.headers['x-acc'] !== '1') return res.status(403).json({ error: 'Missing request header' });
    if (!who.scopes.includes(scope)) return res.status(403).json({ error: 'This key does not have the "' + scope + '" scope' });
    if (!ctx.limits.api('api:' + (who.keyId || 'admin'))) return res.status(429).json({ error: 'Rate limit: 600 requests per minute' });
    req.api = who;
    next();
  });
  const scopeOf = (req) => ({ companyId: req.api.companyId });

  // CORS: the API is for server-to-server use with Bearer keys (no cookies cross-site).
  app.use('/api/v1', (req, res, next) => {
    res.set('Access-Control-Allow-Origin', '*');
    res.set('Access-Control-Allow-Headers', 'Authorization, Content-Type');
    res.set('Access-Control-Allow-Methods', 'GET, POST, PATCH, OPTIONS');
    if (req.method === 'OPTIONS') return res.status(204).end();
    next();
  });

  app.get('/api/v1/openapi.json', (req, res) => res.json(spec.openapi(cfg.baseUrl, ctx.webhooksOut.EVENT_TYPES)));

  app.get('/api/v1/health', need('read'), (req, res) => res.json({ ok: true, version: VERSION, time: new Date().toISOString(), key: { name: req.api.name, scopes: req.api.scopes, companyId: req.api.companyId } }));
  app.get('/api/v1/stats', need('read'), h(async (req, res) => res.json(await platform.stats(scopeOf(req), req.query))));

  app.get('/api/v1/companies', need('read'), h(async (req, res) => res.json({ data: await platform.listCompanies(scopeOf(req), req.query) })));
  app.get('/api/v1/companies/:id', need('read'), h(async (req, res) => res.json(await platform.getCompany(scopeOf(req), req.params.id))));
  app.patch('/api/v1/companies/:id', need('write'), h(async (req, res) => res.json(await platform.setCompanyStatus(scopeOf(req), req.params.id, (req.body || {}).status))));

  app.get('/api/v1/accounts', need('read'), h(async (req, res) => res.json({ data: await platform.listAccounts(scopeOf(req), req.query) })));
  app.get('/api/v1/accounts/:id', need('read'), h(async (req, res) => res.json(await platform.getAccount(scopeOf(req), req.params.id))));

  app.get('/api/v1/calls', need('read'), h(async (req, res) => res.json(await platform.listCalls(scopeOf(req), req.query))));
  app.get('/api/v1/calls/:id', need('read'), h(async (req, res) => res.json(await platform.getCall(scopeOf(req), req.params.id))));

  app.get('/api/v1/leads', need('read'), h(async (req, res) => res.json(await platform.listLeads(scopeOf(req), req.query))));
  app.get('/api/v1/leads/:id', need('read'), h(async (req, res) => res.json(await platform.getLead(scopeOf(req), req.params.id))));
  app.post('/api/v1/leads', need('write'), h(async (req, res) => {
    const r = await platform.createLead(scopeOf(req), req.body || {});
    res.status(r.duplicate ? 200 : 201).json(r);
  }));

  app.get('/api/v1/events', need('read'), h(async (req, res) => res.json(await platform.listEvents(scopeOf(req), req.query))));
  app.get('/api/v1/webhook-events', need('read'), (req, res) => res.json({ data: ctx.webhooksOut.EVENT_TYPES }));

  app.use('/api/v1', (req, res) => res.status(404).json({ error: 'Unknown endpoint. See /api/v1/openapi.json' }));

  /* ---------- Super Admin: keys, webhooks, reference ---------- */
  const admin = (req, res, next) => {
    if (!req.isAdmin) return res.status(401).json({ error: 'Admin sign-in required' });
    if (req.method !== 'GET' && req.headers['x-acc'] !== '1') return res.status(403).json({ error: 'Missing request header' });
    next();
  };

  app.get('/api/admin/api-keys', admin, h(async (req, res) => {
    res.json({ data: (await store.find('apiKeys', {}, { sort: { createdAt: -1 } })).map(publicKey) });
  }));
  app.post('/api/admin/api-keys', admin, h(async (req, res) => {
    const b = req.body || {};
    const name = String(b.name || '').trim().slice(0, 60);
    if (!name) throw httpError(400, 'Name the key after the app that will use it');
    const scopes = ['read'].concat(b.write ? ['write'] : []);
    const companyId = b.companyId ? String(b.companyId) : null;
    if (companyId && !(await store.get('agencies', companyId))) throw httpError(404, 'Company not found');
    const key = 'acc_' + randomToken(30);
    const prefix = key.slice(0, 12);
    await store.put('apiKeys', { _id: sha256(key), prefix, name, scopes, companyId, createdAt: new Date().toISOString() });
    await store.log(companyId, 'api.key_created', name + ' (' + scopes.join('+') + ')');
    res.json({ key, apiKey: { id: prefix, name, scopes, companyId } });
  }));
  app.delete('/api/admin/api-keys/:prefix', admin, h(async (req, res) => {
    const k = (await store.find('apiKeys', { prefix: req.params.prefix }, { limit: 1 }))[0];
    if (!k) throw httpError(404, 'Key not found');
    await store.patch('apiKeys', k._id, { revoked: true, revokedAt: new Date().toISOString() });
    await store.log(k.companyId, 'api.key_revoked', k.name);
    res.json({ ok: true });
  }));

  app.get('/api/admin/webhooks', admin, h(async (req, res) => res.json({ data: await ctx.webhooksOut.list(), eventTypes: ctx.webhooksOut.EVENT_TYPES })));
  app.post('/api/admin/webhooks', admin, h(async (req, res) => res.json(await ctx.webhooksOut.create(req.body || {}))));
  app.patch('/api/admin/webhooks/:id', admin, h(async (req, res) => res.json(await ctx.webhooksOut.update(req.params.id, req.body || {}))));
  app.delete('/api/admin/webhooks/:id', admin, h(async (req, res) => { await ctx.webhooksOut.remove(req.params.id); res.json({ ok: true }); }));
  app.post('/api/admin/webhooks/:id/test', admin, h(async (req, res) => res.json(await ctx.webhooksOut.sendTest(req.params.id))));
  app.get('/api/admin/webhook-deliveries', admin, h(async (req, res) => res.json({ data: await ctx.webhooksOut.deliveries(req.query.hookId, Number(req.query.limit) || 50) })));

  app.get('/api/admin/api-reference', admin, (req, res) => res.json({ baseUrl: cfg.baseUrl, endpoints: spec.ENDPOINTS, shapes: spec.SHAPES, eventTypes: ctx.webhooksOut.EVENT_TYPES }));
};
