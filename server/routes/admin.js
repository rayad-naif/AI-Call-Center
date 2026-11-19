'use strict';
/* Super Admin (you, the app owner): every agency license at a glance. */
const { h, csrf } = require('./util');
const { safeEqual } = require('../security');
const views = require('../views/pages');

module.exports = function (app, ctx) {
  const { store, cfg, auth } = ctx;
  const guard = (req, res, next) => (req.isAdmin ? next() : res.status(401).json({ error: 'Admin sign-in required' }));

  app.get('/admin/login', (req, res) => res.type('html').send(views.adminLogin(req)));
  app.post('/api/admin/login', csrf, (req, res) => {
    if (!ctx.limits.login('admin:' + req.ip)) return res.status(429).json({ error: 'Too many attempts' });
    if (!safeEqual(String(req.body.password || ''), cfg.adminPassword)) return res.status(401).json({ error: 'Wrong password' });
    auth.setAdmin(res);
    res.json({ ok: true, redirect: '/admin' });
  });
  app.post('/api/admin/logout', csrf, (req, res) => { auth.clearAdmin(res); res.json({ ok: true, redirect: '/admin/login' }); });

  app.get('/admin', (req, res) => (req.isAdmin ? res.type('html').send(views.admin(req)) : res.redirect('/admin/login')));

  app.get('/api/admin/agencies', guard, h(async (req, res) => {
    const agencies = await store.find('agencies', {}, { sort: { createdAt: -1 } });
    const deps = await store.find('deployments', {});
    const count = {};
    deps.forEach((d) => { if (d.status === 'live') count[d.companyId] = (count[d.companyId] || 0) + 1; });
    res.json({
      agencies: agencies.map((a) => ({
        id: a._id, name: a.name, status: a.status, installed: !!a.installed, installedAt: a.installedAt,
        live: count[a._id] || 0, keys: Object.keys(a.keyStatus || {}).filter((k) => a.keyStatus[k].ok),
        domain: (a.branding && a.branding.domain) || ''
      }))
    });
  }));

  app.post('/api/admin/agencies/:id/status', csrf, guard, h(async (req, res) => {
    const status = ['active', 'pending', 'suspended'].includes(req.body.status) ? req.body.status : null;
    if (!status) return res.status(400).json({ error: 'Bad status' });
    const a = await store.patch('agencies', req.params.id, { status });
    if (!a) return res.status(404).json({ error: 'Not found' });
    await store.log(a._id, 'license.' + status, 'by super admin');
    res.json({ ok: true });
  }));

  /* Setup check: is the HighLevel app configuration ready? */
  app.get('/api/admin/setup', guard, h(async (req, res) => {
    const g = cfg.ghl;
    const https = /^https:\/\//.test(cfg.baseUrl) && !/localhost|127\.0\.0\.1/.test(cfg.baseUrl);
    const checks = [
      ['Public HTTPS URL (BASE_URL)', https, https ? cfg.baseUrl : 'Set BASE_URL to your public https domain. Cookies inside the HighLevel iframe need HTTPS.'],
      ['Client ID (GHL_CLIENT_ID)', !!g.clientId, g.clientId ? 'App id: ' + (g.appId || '?') : 'Copy it from your app > Advanced Settings > Auth > Client Keys.'],
      ['Client Secret (GHL_CLIENT_SECRET)', !!g.clientSecret, g.clientSecret ? 'Set' : 'Shown once when you create the client key.'],
      ['SSO key (GHL_SSO_KEY)', !!g.ssoKey, g.ssoKey ? 'Set' : 'Generate it in Advanced Settings > Auth > SSO. Needed for the sidebar page.'],
      ['Webhook signature keys', !!(g.webhookEd25519Key || g.webhookRsaKey), g.webhookEd25519Key || g.webhookRsaKey ? 'Set' : 'Optional. Without them, uninstalls are confirmed by checking the token.'],
      ['Database', ctx.store.kind === 'mongo', ctx.store.kind === 'mongo' ? 'MongoDB' : 'Local file (development only). Set MONGODB_URI.'],
      ['Separate ENCRYPTION_KEY', !!process.env.ENCRYPTION_KEY && process.env.ENCRYPTION_KEY !== cfg.sessionSecret, 'Use a different value from SESSION_SECRET and never change it after launch.'],
      ['Cron secret (CRON_SECRET)', !!cfg.cronSecret, cfg.cronSecret ? 'Set' : 'Needed for CRM sync retries and speed-to-lead retries.']
    ].map(([name, ok, detail]) => ({ name, ok, detail }));
    // Background jobs: when did the sweep last run, and is anything waiting?
    const sw = await store.get('meta', 'sweep');
    const overdue = await store.find('leads', { status: 'queued', nextAt: { $lt: new Date(Date.now() - 15 * 60e3).toISOString() } }, { limit: 1 });
    const ago = sw ? Math.round((Date.now() - Date.parse(sw.lastAt)) / 60e3) : null;
    checks.push({
      name: 'Background jobs (sweep)',
      ok: !!sw && !overdue.length,
      detail: (sw ? 'Last run ' + ago + ' min ago (' + sw.source + ').' : 'Has not run yet.') +
        (overdue.length ? ' Some speed-to-lead calls are waiting more than 15 minutes: add the free external pinger from the README so overnight leads and retries go out on time.' : '')
    });
    res.json({
      checks,
      paste: {
        'Redirect URL': cfg.redirectUri,
        'Webhook URL (events: INSTALL, UNINSTALL)': cfg.baseUrl + '/webhooks/ghl',
        'Custom page URL (sidebar, agency + sub-account)': cfg.baseUrl + '/embed',
        'Scopes': g.scopes,
        'Install link': cfg.baseUrl + '/install'
      }
    });
  }));

  // Proves the client id/secret pair without an install: HighLevel answers a
  // fake refresh token with invalid_grant when the client is valid.
  app.post('/api/admin/setup/test', csrf, guard, h(async (req, res) => {
    if (!cfg.ghl.clientId || !cfg.ghl.clientSecret) return res.json({ ok: false, detail: 'Client ID and secret are not set' });
    try {
      await ctx.ghl.refresh('acc-credential-check');
      res.json({ ok: true, detail: 'Unexpected success' });
    } catch (e) {
      const text = JSON.stringify(e.body || e.message).toLowerCase();
      if (/invalid_client|client.*(not found|invalid)|unauthorized_client/.test(text)) return res.json({ ok: false, detail: 'HighLevel rejected the Client ID / Client Secret: ' + e.message });
      if (/invalid_grant|refresh.?token/.test(text)) return res.json({ ok: true, detail: 'Client ID and Client Secret are valid.' });
      res.json({ ok: false, detail: 'Could not verify: ' + e.message });
    }
  }));

  app.get('/api/admin/events', guard, h(async (req, res) => res.json({ events: await store.events({}, 200) })));
};
