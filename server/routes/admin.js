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
        id: a._id, name: a.name, mode: a.mode === 'account' ? 'account' : 'company', apps: Object.keys(a.ghlApps || {}).length ? Object.keys(a.ghlApps) : [a.app === 'agency' ? 'agency' : 'standard'], status: a.status, installed: !!a.installed, installedAt: a.installedAt,
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

  /* Setup check: shared settings + each of the two Marketplace apps. */
  const APP_ENV = {
    standard: { id: 'GHL_CLIENT_ID', secret: 'GHL_CLIENT_SECRET', sso: 'GHL_SSO_KEY', target: 'Sub-account (distribution: Agency and Sub-account)' },
    agency: { id: 'GHL_AGENCY_CLIENT_ID', secret: 'GHL_AGENCY_CLIENT_SECRET', sso: 'GHL_AGENCY_SSO_KEY', target: 'Agency' }
  };
  app.get('/api/admin/setup', guard, h(async (req, res) => {
    const g = cfg.ghl;
    const https = /^https:\/\//.test(cfg.baseUrl) && !/localhost|127\.0\.0\.1/.test(cfg.baseUrl);
    const checks = [
      ['Public HTTPS URL (BASE_URL)', https, https ? cfg.baseUrl : 'Set BASE_URL to your public https domain. Cookies inside the CRM iframe need HTTPS.'],
      ['Webhook signature keys', !!(g.webhookEd25519Key || g.webhookRsaKey), g.webhookEd25519Key || g.webhookRsaKey ? 'Set' : 'Optional. Without them, uninstalls are confirmed by checking the token.'],
      ['Database', ctx.store.kind === 'mongo', ctx.store.kind === 'mongo' ? 'MongoDB' : 'Local file (development only). Set AI_CALL_CENTER_PLUS_MONGODB_URI.'],
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
    const apps = Object.values(cfg.apps).map((a) => {
      const e = APP_ENV[a.key];
      return {
        key: a.key, label: a.label, configured: !!(a.clientId && a.clientSecret),
        checks: [
          [e.id, !!a.clientId, a.clientId ? 'App id: ' + (a.appId || '?') : 'Copy it from this app > Advanced Settings > Auth > Client Keys.'],
          [e.secret, !!a.clientSecret, a.clientSecret ? 'Set' : 'Shown once when you create the client key.'],
          [e.sso, !!a.ssoKey, a.ssoKey ? 'Set' : 'Generate it in Advanced Settings > Auth > SSO. Needed for the sidebar page.']
        ].map(([name, ok, detail]) => ({ name, ok, detail })),
        paste: {
          'Target User': e.target,
          'Redirect URL': a.redirectUri,
          'Webhook URL (events: INSTALL, UNINSTALL)': cfg.baseUrl + '/webhooks/crm',
          'Custom page URL (sidebar)': cfg.baseUrl + '/embed',
          'Scopes': a.scopes,
          'Install link': cfg.baseUrl + a.installPath
        }
      };
    });
    res.json({ checks, apps, paste: apps[0].paste });
  }));

  // Proves an app's client id/secret pair without an install: the CRM answers
  // a fake refresh token with invalid_grant when the client is valid.
  app.post('/api/admin/setup/test', csrf, guard, h(async (req, res) => {
    const key = req.body && req.body.app === 'agency' ? 'agency' : 'standard';
    const a = cfg.apps[key];
    if (!a.clientId || !a.clientSecret) return res.json({ ok: false, detail: 'Client ID and secret are not set' });
    try {
      await ctx.ghl.refresh('acc-credential-check', 'Company', key);
      res.json({ ok: true, detail: 'Unexpected success' });
    } catch (e) {
      const text = JSON.stringify(e.body || e.message).toLowerCase();
      if (/invalid_client|client.*(not found|invalid)|unauthorized_client/.test(text)) return res.json({ ok: false, detail: 'The CRM rejected the Client ID / Client Secret: ' + e.message });
      if (/invalid_grant|refresh.?token/.test(text)) return res.json({ ok: true, detail: 'Client ID and Client Secret are valid.' });
      res.json({ ok: false, detail: 'Could not verify: ' + e.message });
    }
  }));

  app.get('/api/admin/events', guard, h(async (req, res) => res.json({ events: await store.events({}, 200) })));
};
