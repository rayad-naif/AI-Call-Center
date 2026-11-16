'use strict';
/* Install (HighLevel OAuth), owner setup, email/password login and
   HighLevel custom-page SSO. */
const { h, csrf } = require('./util');
const { randomToken, hashPassword, verifyPassword, decryptGhlSso } = require('../security');
const views = require('../views/pages');

const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,255}\.[^\s@]{2,}$/;

module.exports = function (app, ctx) {
  const { store, sec, cfg, ghl, auth } = ctx;

  app.get('/install', (req, res) => {
    const state = randomToken(16);
    res.append('Set-Cookie', 'acc_state=' + state + '; Path=/; HttpOnly; Max-Age=600; ' + (cfg.secureCookies ? 'Secure; SameSite=None' : 'SameSite=Lax'));
    res.redirect(ghl.authorizeUrl(state));
  });

  app.get('/oauth/callback', h(async (req, res) => {
    const code = String(req.query.code || '');
    if (!code) return res.status(400).type('html').send(views.message(req, 'Install cancelled', 'HighLevel did not send an authorization code.'));
    const t = await ghl.exchangeCode(code);
    let company = {};
    try { company = await ghl.api(t.access_token).getCompany(t.companyId); } catch (e) { /* name is optional */ }
    const existing = await store.get('agencies', t.companyId);
    const agency = Object.assign(existing || {
      _id: t.companyId,
      createdAt: new Date().toISOString(),
      status: cfg.newInstallStatus,
      keys: {},
      setup: {},
      branding: {}
    }, {
      name: company.name || (existing && existing.name) || 'Agency ' + t.companyId.slice(-6),
      installed: true,
      installedAt: (existing && existing.installedAt) || new Date().toISOString(),
      ghl: {
        accessToken: sec.encrypt(t.access_token),
        refreshToken: sec.encrypt(t.refresh_token),
        expiresAt: Date.now() + (Number(t.expires_in) || 86399) * 1000,
        scope: t.scope || '',
        installerUserId: t.userId || ''
      }
    });
    await store.put('agencies', agency);
    await store.log(agency._id, existing ? 'app.reinstalled' : 'app.installed', agency.name);

    const owner = (await store.find('users', { companyId: agency._id, role: 'owner' }, { limit: 1 }))[0];
    // One-time setup token so only the installer can claim the owner login.
    const setup = sec.sign({ setup: agency._id, exp: Date.now() + 30 * 60e3 });
    if (!owner) return res.redirect('/app/setup?t=' + encodeURIComponent(setup));
    res.redirect('/login?installed=1');
  }));

  app.get('/app/setup', h(async (req, res) => {
    const s = sec.unsign(String(req.query.t || ''));
    if (!s || !s.setup) return res.status(400).type('html').send(views.message(req, 'Link expired', 'Open the app from HighLevel again to finish setup.'));
    res.type('html').send(views.setup(req, String(req.query.t)));
  }));

  app.post('/api/auth/setup', csrf, h(async (req, res) => {
    const s = sec.unsign(String(req.body.t || ''));
    if (!s || !s.setup) return res.status(400).json({ error: 'This setup link expired. Open the app from HighLevel again.' });
    const email = String(req.body.email || '').trim().toLowerCase();
    const password = String(req.body.password || '');
    const name = String(req.body.name || '').trim().slice(0, 80);
    if (!EMAIL.test(email)) return res.status(400).json({ error: 'Enter a valid email' });
    if (password.length < 10) return res.status(400).json({ error: 'Use at least 10 characters' });
    const owner = (await store.find('users', { companyId: s.setup, role: 'owner' }, { limit: 1 }))[0];
    if (owner) return res.status(409).json({ error: 'An owner login already exists. Sign in instead.' });
    const taken = (await store.find('users', { email }, { limit: 1 }))[0];
    if (taken) return res.status(409).json({ error: 'That email is already used' });
    const u = { _id: 'u_' + randomToken(10), email, name, companyId: s.setup, kind: 'agency', role: 'owner', passwordHash: await hashPassword(password), createdAt: new Date().toISOString(), sessionVersion: 0 };
    await store.put('users', u);
    await store.log(s.setup, 'user.owner_created', email);
    auth.setSession(res, auth.sessionFromUser(u), { remember: true });
    res.json({ ok: true, redirect: '/app' });
  }));

  app.get('/login', (req, res) => {
    if (req.session) return res.redirect(req.session.kind === 'agency' && !req.query.deck ? '/app' : '/deck');
    res.type('html').send(views.login(req));
  });

  app.post('/api/auth/login', csrf, h(async (req, res) => {
    const email = String(req.body.email || '').trim().toLowerCase();
    if (!ctx.limits.login('ip:' + req.ip) || !ctx.limits.login('em:' + email)) return res.status(429).json({ error: 'Too many attempts. Try again in 15 minutes.' });
    const u = (await store.find('users', { email }, { limit: 1 }))[0];
    const ok = await verifyPassword(String(req.body.password || ''), u && u.passwordHash);
    if (!ok || u.disabled) return res.status(401).json({ error: 'Wrong email or password' });
    // On a custom portal domain, only that agency's users may sign in.
    if (req.brandCompanyId && u.companyId !== req.brandCompanyId) return res.status(401).json({ error: 'Wrong email or password' });
    const agency = await store.get('agencies', u.companyId);
    if (!agency || !agency.installed || agency.status === 'suspended') return res.status(403).json({ error: 'This account is not active. Contact your provider.' });
    auth.setSession(res, auth.sessionFromUser(u), { remember: !!req.body.remember });
    await store.patch('users', u._id, { lastLoginAt: new Date().toISOString() });
    res.json({ ok: true, redirect: u.kind === 'agency' ? '/app' : '/deck' });
  }));

  app.post('/api/auth/logout', csrf, (req, res) => { auth.clearSession(res); res.json({ ok: true, redirect: '/login' }); });

  /* HighLevel custom page. The page asks its parent frame for the encrypted
     user context (REQUEST_USER_DATA) and posts it here. */
  app.get('/embed', (req, res) => res.type('html').send(views.embed(req)));

  app.post('/api/auth/sso', csrf, h(async (req, res) => {
    if (!cfg.ghl.ssoKey) return res.status(500).json({ error: 'SSO is not configured (GHL_SSO_KEY)' });
    if (!ctx.limits.login('sso:' + req.ip)) return res.status(429).json({ error: 'Too many attempts' });
    const u = decryptGhlSso(req.body.payload, cfg.ghl.ssoKey);
    if (!u || !u.userId || !u.companyId) return res.status(401).json({ error: 'HighLevel sign-in failed. Reload the page.' });
    const agency = await store.get('agencies', u.companyId);
    if (!agency || !agency.installed) return res.status(403).json({ error: 'Your agency has not installed this app yet.', install: '/install' });
    if (agency.status === 'suspended') return res.status(403).json({ error: 'This license is suspended.' });

    const locationId = u.activeLocation || '';
    const base = { uid: 'ghl:' + u.userId, companyId: u.companyId, name: u.userName || '', email: (u.email || '').toLowerCase() };
    if (locationId) {
      // Inside a sub-account: the client view of that location only.
      const dep = await store.get('deployments', locationId);
      if (!dep || dep.companyId !== u.companyId || dep.status === 'removed') {
        return res.status(404).json({ error: 'The AI call center is not set up for this sub-account yet. Ask your agency to deploy it.' });
      }
      const role = u.type === 'agency' || u.role === 'admin' ? 'manager' : 'viewer';
      auth.setSession(res, Object.assign(base, { kind: 'client', role, locationIds: [locationId], locationId }));
      return res.json({ ok: true, redirect: '/deck' });
    }
    if (u.type !== 'agency') return res.status(403).json({ error: 'Open this page from a sub-account.' });
    const role = u.role === 'admin' ? 'admin' : 'manager';
    auth.setSession(res, Object.assign(base, { kind: 'agency', role }));
    res.json({ ok: true, redirect: role === 'admin' ? '/app' : '/deck' });
  }));
};
