'use strict';
/* Install (CRM OAuth), owner setup, email/password login and
   CRM custom-page SSO. */
const { h, csrf } = require('./util');
const { randomToken, hashPassword, verifyPassword, decryptGhlSso } = require('../security');
const views = require('../views/pages');

// Workspace id for an account that installed the app on its own.
const accountWorkspaceId = (locationId) => 'acct_' + locationId;

const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,255}\.[^\s@]{2,}$/;

module.exports = function (app, ctx) {
  const { store, sec, cfg, ghl, auth } = ctx;

  /* One deployment, two Marketplace apps (cfg.apps):
       standard  /install          -> /oauth/callback          (Target User: Account)
       agency     /install/company   -> /oauth/company/callback   (company app; internal key 'agency') */
  const install = (appKey) => (req, res) => {
    if (!cfg.apps[appKey].clientId) return res.status(404).type('html').send(views.message(req, 'Not available', 'This app is not configured.'));
    const state = randomToken(16);
    res.append('Set-Cookie', 'acc_state=' + state + '; Path=/; HttpOnly; Max-Age=600; ' + (cfg.secureCookies ? 'Secure; SameSite=None' : 'SameSite=Lax'));
    res.redirect(ghl.authorizeUrl(state, appKey));
  };
  app.get('/install', install('standard'));
  app.get(['/install/company', '/install/agency'], install('agency'));
  app.get('/oauth/callback', h((req, res) => callback('standard', req, res)));
  // /oauth/company/callback is the address shown everywhere; the older /oauth/agency/callback stays as an alias.
  app.get(['/oauth/company/callback', '/oauth/agency/callback'], h((req, res) => callback('agency', req, res)));

  async function callback(appKey, req, res) {
    const code = String(req.query.code || '');
    if (!code) return res.status(400).type('html').send(views.message(req, 'Install cancelled', 'The CRM did not send an authorization code.'));
    if (!cfg.apps[appKey].clientId) return res.status(404).type('html').send(views.message(req, 'Not available', 'This app is not configured.'));
    const t = await ghl.exchangeCode(code, appKey, cfg.baseUrl + req.path);
    if (appKey === 'agency' && t.userType !== 'Company') {
      return res.status(400).type('html').send(views.message(req, 'Install at company level', 'This app is installed by the company, not inside a single account.'));
    }

    /* Single-account install (userType "Location"). Two cases:
       - the account's company already runs the app for its accounts (bulk
         install): just record it, the company manages this account;
       - otherwise the account gets its own workspace ("account mode"): its
         own login, keys, call center and portal, managing only itself. */
    if (t.userType === 'Location') {
      await store.put('locationInstalls', { _id: t.locationId, companyId: t.companyId, installed: true, installedAt: new Date().toISOString() });
      await store.log(t.companyId, 'app.location_installed', t.locationId, { locationId: t.locationId });
      const ag = await store.get('agencies', t.companyId);
      const managed = await store.get('deployments', t.locationId);
      if (ag && ag.installed && (!managed || managed.companyId === ag._id)) {
        return res.type('html').send(views.message(req, 'Installed',
          managed && managed.status === 'live' ? 'Your AI call center is live. Open it from the left menu.' : 'The app is ready for this account. Your administrator can now set up the AI call center; once it is live, open it from the left menu.'));
      }
      const wid = accountWorkspaceId(t.locationId);
      let loc = {};
      try { loc = await ghl.api(t.access_token).getLocation(t.locationId); } catch (e) { /* name is optional */ }
      const prev = await store.get('agencies', wid);
      const ws = Object.assign(prev || { _id: wid, createdAt: new Date().toISOString(), status: cfg.newInstallStatus, keys: {}, setup: {}, branding: {} }, {
        mode: 'account', app: 'standard', locationId: t.locationId, ghlCompanyId: t.companyId,
        name: loc.name || (prev && prev.name) || 'Account ' + t.locationId.slice(-6),
        installed: true, installedAt: (prev && prev.installedAt) || new Date().toISOString(),
        ghl: { accessToken: sec.encrypt(t.access_token), refreshToken: sec.encrypt(t.refresh_token), expiresAt: Date.now() + (Number(t.expires_in) || 86399) * 1000, scope: t.scope || '', installerUserId: t.userId || '' }
      });
      await store.put('agencies', ws);
      await store.log(wid, prev ? 'app.reinstalled' : 'app.installed', ws.name + ' (single account)', { locationId: t.locationId });
      const owner = (await store.find('users', { companyId: wid, role: 'owner' }, { limit: 1 }))[0];
      if (!owner) return res.redirect('/app/setup?t=' + encodeURIComponent(sec.sign({ setup: wid, exp: Date.now() + 30 * 60e3 })));
      return res.redirect('/login?installed=1');
    }

    let company = {};
    try { company = await ghl.api(t.access_token).getCompany(t.companyId); } catch (e) { /* name is optional */ }
    const existing = await store.get('agencies', t.companyId);
    const tokens = {
      accessToken: sec.encrypt(t.access_token),
      refreshToken: sec.encrypt(t.refresh_token),
      expiresAt: Date.now() + (Number(t.expires_in) || 86399) * 1000,
      scope: t.scope || '',
      installerUserId: t.userId || ''
    };
    const base = existing || { _id: t.companyId, createdAt: new Date().toISOString(), status: cfg.newInstallStatus, keys: {}, setup: {}, branding: {} };
    const ghlApps = Object.assign({}, base.ghlApps || {}, { [appKey]: tokens });
    // A company can install both apps. The account app (full scopes, minted
    // account tokens) stays in charge; the company app is kept alongside it.
    const keepStandard = appKey === 'agency' && existing && existing.installed && existing.app !== 'agency';
    const agency = Object.assign(base, {
      name: company.name || (existing && existing.name) || 'Company ' + t.companyId.slice(-6),
      installed: true,
      installedAt: (existing && existing.installedAt) || new Date().toISOString(),
      ghlApps
    }, keepStandard ? {} : { app: appKey, ghl: tokens });
    await store.put('agencies', agency);
    await store.log(agency._id, existing ? 'app.reinstalled' : 'app.installed', agency.name + (appKey === 'agency' ? ' (company app)' : ''));

    const owner = (await store.find('users', { companyId: agency._id, role: 'owner' }, { limit: 1 }))[0];
    // One-time setup token so only the installer can claim the owner login.
    const setup = sec.sign({ setup: agency._id, exp: Date.now() + 30 * 60e3 });
    if (!owner) return res.redirect('/app/setup?t=' + encodeURIComponent(setup));
    res.redirect('/login?installed=1');
  }

  app.get('/app/setup', h(async (req, res) => {
    const s = sec.unsign(String(req.query.t || ''));
    if (!s || !s.setup) return res.status(400).type('html').send(views.message(req, 'Link expired', 'Open the app from your CRM again to finish setup.'));
    res.type('html').send(views.setup(req, String(req.query.t)));
  }));

  app.post('/api/auth/setup', csrf, h(async (req, res) => {
    const s = sec.unsign(String(req.body.t || ''));
    if (!s || !s.setup) return res.status(400).json({ error: 'This setup link expired. Open the app from your CRM again.' });
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
    // On a custom portal domain, only that company's users may sign in.
    if (req.brandCompanyId && u.companyId !== req.brandCompanyId) return res.status(401).json({ error: 'Wrong email or password' });
    const agency = await store.get('agencies', u.companyId);
    if (!agency || !agency.installed || agency.status === 'suspended') return res.status(403).json({ error: 'This account is not active. Contact your provider.' });
    auth.setSession(res, auth.sessionFromUser(u), { remember: !!req.body.remember });
    await store.patch('users', u._id, { lastLoginAt: new Date().toISOString() });
    res.json({ ok: true, redirect: u.kind === 'agency' ? '/app' : '/deck' });
  }));

  app.post('/api/auth/logout', csrf, (req, res) => { auth.clearSession(res); res.json({ ok: true, redirect: '/login' }); });

  /* CRM custom page. The page asks its parent frame for the encrypted
     user context (REQUEST_USER_DATA) and posts it here. */
  // Already signed in (same as opening /app): go straight in, no CRM handshake.
  // ?sso=1 forces a fresh CRM sign-in (e.g. to switch user or account).
  app.get('/embed', (req, res) => {
    const s = req.session;
    if (s && req.query.sso !== '1') return res.redirect(s.kind === 'agency' && ctx.auth.can(s, 'admin') ? '/app' : '/deck');
    res.type('html').send(views.embed(req));
  });

  app.post('/api/auth/sso', csrf, h(async (req, res) => {
    // Either app can open the sidebar page; try each app's SSO key.
    const keys = Object.values(cfg.apps).map((a) => a.ssoKey).filter(Boolean);
    if (!keys.length) return res.status(500).json({ error: 'SSO is not configured (CRM_SSO_KEY / CRM_COMPANY_SSO_KEY)' });
    if (!ctx.limits.login('sso:' + req.ip)) return res.status(429).json({ error: 'Too many attempts' });
    let u = null;
    for (const k of keys) { u = decryptGhlSso(req.body.payload, k); if (u) break; }
    if (!u || !u.userId || !u.companyId) {
      // Usually the SSO key in the env vars does not match the app's key. Visible in Super Admin > Activity.
      await store.log(null, 'sso.failed', 'Could not decrypt the CRM user data: check CRM_SSO_KEY / CRM_COMPANY_SSO_KEY match the apps\' SSO keys');
      return res.status(401).json({ error: 'Sign-in failed (code SSO-KEY). Reload the page, or sign in with email.', code: 'sso_key' });
    }
    // Field names differ slightly between CRM versions; accept both.
    const locationId = u.activeLocation || u.locationId || '';
    const base = { uid: 'ghl:' + u.userId, name: u.userName || u.name || '', email: (u.email || '').toLowerCase() };
    const agency = await store.get('agencies', u.companyId);
    const companyRuns = agency && agency.installed;

    if (locationId) {
      const dep = await store.get('deployments', locationId);
      const managedByCompany = companyRuns && dep && dep.companyId === agency._id && dep.status !== 'removed';
      // Account that installed the app for itself: its admins get the console.
      const ws = !managedByCompany && await store.get('agencies', accountWorkspaceId(locationId));
      if (ws && ws.installed) {
        if (ws.status === 'suspended') return res.status(403).json({ error: 'This service is paused.' });
        const role = u.role === 'admin' || u.type === 'agency' ? 'admin' : 'viewer';
        auth.setSession(res, Object.assign(base, { companyId: ws._id, kind: 'agency', role }));
        return res.json({ ok: true, redirect: role === 'admin' ? '/app' : '/deck' });
      }
      if (!companyRuns) return res.status(403).json({ error: 'This app is not installed for your account yet. Install it from the Marketplace.' });
      if (agency.status === 'suspended') return res.status(403).json({ error: 'This service is paused. Contact your account manager.' });
      // Account managed by its company: the client view of that account only.
      if (!managedByCompany) {
        return res.status(404).json({ error: 'Your AI call center is not set up yet. Contact your account manager to turn it on.' });
      }
      base.companyId = u.companyId;
      const role = u.type === 'agency' || u.role === 'admin' ? 'manager' : 'viewer';
      auth.setSession(res, Object.assign(base, { kind: 'client', role, locationIds: [locationId], locationId }));
      return res.json({ ok: true, redirect: '/deck' });
    }
    if (!companyRuns) return res.status(403).json({ error: 'This app is not installed for your company yet.', install: '/install' });
    if (agency.status === 'suspended') return res.status(403).json({ error: 'This license is paused.' });
    if (u.type && u.type !== 'agency') return res.status(403).json({ error: 'Open this page from an account.' });
    const role = u.role === 'admin' || u.isAgencyOwner ? 'admin' : 'manager';
    auth.setSession(res, Object.assign(base, { companyId: u.companyId, kind: 'agency', role }));
    res.json({ ok: true, redirect: role === 'admin' ? '/app' : '/deck' });
  }));
};
