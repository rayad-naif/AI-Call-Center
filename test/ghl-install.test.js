'use strict';
/* HighLevel OAuth (agency + sub-account installs), SSO variants, token refresh. */
const test = require('node:test');
const assert = require('node:assert/strict');
const { setup, client } = require('./helpers');
const { encryptGhlSso } = require('../server/security');

async function installed(t) {
  const env = await setup();
  t.after(() => env.server.close());
  const c = client(env.base);
  const r = await c.req('GET', '/oauth/callback?code=abc');
  await c.req('POST', '/api/auth/setup', { t: decodeURIComponent(r.location.split('t=')[1]), email: 'o@acme.com', password: 'longpassword1' });
  return Object.assign(env, { owner: c });
}

test('sub-account install token is accepted and tracked', async (t) => {
  const env = await setup();
  t.after(() => env.server.close());
  const c = client(env.base);
  env.fakes.state.ghl.nextInstall = 'Location';
  // Before the agency installs: explain the missing step instead of failing.
  let r = await c.req('GET', '/oauth/callback?code=xyz');
  assert.equal(r.status, 200);
  assert.match(r.text, /agency has not installed it yet/);
  assert.equal((await env.ctx.store.get('locationInstalls', 'loc2bbbbbbbb')).installed, true);

  env.fakes.state.ghl.nextInstall = 'Company';
  r = await c.req('GET', '/oauth/callback?code=abc');
  assert.match(r.location, /^\/app\/setup/);
  env.fakes.state.ghl.nextInstall = 'Location';
  r = await c.req('GET', '/oauth/callback?code=xyz');
  assert.match(r.text, /Installed for this sub-account/);
  assert.equal((await env.ctx.store.get('agencies', 'comp1')).ghl.installerUserId, 'user1', 'agency token untouched by a location install');
});

test('location install webhooks and installed-location check', async (t) => {
  const env = await installed(t);
  const hook = (b) => fetch(env.base + '/webhooks/ghl', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) }).then((x) => x.json());
  await hook({ type: 'INSTALL', appId: 'app1', companyId: 'comp1', locationId: 'loc2bbbbbbbb', installType: 'Location' });
  assert.equal((await env.ctx.store.get('locationInstalls', 'loc2bbbbbbbb')).installed, true);
  assert.equal((await env.ctx.store.get('agencies', 'comp1')).installed, true);
  await hook({ type: 'UNINSTALL', appId: 'app1', companyId: 'comp1', locationId: 'loc2bbbbbbbb', installType: 'Location' });
  assert.equal((await env.ctx.store.get('locationInstalls', 'loc2bbbbbbbb')).installed, false);
  assert.equal((await env.ctx.store.get('agencies', 'comp1')).installed, true, 'agency license unaffected');

  const r = await env.owner.req('GET', '/api/locations');
  assert.equal(r.json.installCheck, true);
  const byId = Object.fromEntries(r.json.locations.map((l) => [l.id, l]));
  assert.equal(byId.loc1aaaaaaaa.appInstalled, true);
  assert.equal(byId.loc2bbbbbbbb.appInstalled, false);

  // Deploying to a sub-account without the app gives a clear message.
  env.fakes.state.ghl.blockLocationToken.add('loc2bbbbbbbb');
  await env.owner.req('PUT', '/api/agency/keys', { twilioSid: 'ACmain', twilioToken: 'goodtoken', vapiKey: 'vapi-good', openaiKey: 'sk-good' });
  const crm = await env.owner.req('GET', '/api/locations/loc2bbbbbbbb/crm');
  assert.equal(crm.status, 409);
  assert.match(crm.json.error, /not installed in this sub-account/);
});

test('SSO accepts payload variants and maps roles', async (t) => {
  const env = await installed(t);
  await env.ctx.store.put('deployments', { _id: 'loc1aaaaaaaa', companyId: 'comp1', status: 'live', name: 'Bob' });
  const sso = async (u) => { const c = client(env.base); const r = await c.req('POST', '/api/auth/sso', { payload: encryptGhlSso(u, 'sso-key') }); return { r, c }; };

  let { r } = await sso({ userId: 'u1', companyId: 'comp1', role: 'user', type: 'location', locationId: 'loc1aaaaaaaa', name: 'Pat' });
  assert.equal(r.json.redirect, '/deck');
  ({ r } = await sso({ userId: 'u2', companyId: 'comp1', role: 'user', isAgencyOwner: true }));
  assert.equal(r.json.redirect, '/app', 'agency owner without type field gets the console');
  ({ r } = await sso({ userId: 'u3', companyId: 'comp1', role: 'user', type: 'agency' }));
  assert.equal(r.json.redirect, '/deck', 'agency non-admin gets the deck');
  ({ r } = await sso({ userId: 'u4', companyId: 'comp1', type: 'location', activeLocation: 'loc2bbbbbbbb' }));
  assert.equal(r.status, 404, 'sub-account without a deployment');
  const c = client(env.base);
  r = await c.req('POST', '/api/auth/sso', { payload: encryptGhlSso({ userId: 'u', companyId: 'comp1' }, 'wrong-key') });
  assert.equal(r.status, 401);
});

test('refresh tokens: single-use race and credential check', async (t) => {
  const env = await installed(t);
  const { ctx, fakes } = env;
  // Expire the access token, then refresh twice in parallel from stale copies.
  await ctx.store.patch('agencies', 'comp1', { 'ghl.expiresAt': Date.now() - 1000 });
  const a1 = await ctx.store.get('agencies', 'comp1');
  const a2 = await ctx.store.get('agencies', 'comp1');
  const tok1 = await ctx.agencySvc.agencyToken(a1);
  const tok2 = await ctx.agencySvc.agencyToken(a2); // its refresh token was already used
  assert.equal(fakes.state.ghl.refreshes, 1);
  assert.equal(tok1, tok2);

  // Super admin setup check + live client credential test.
  const admin = client(env.base);
  await admin.req('POST', '/api/admin/login', { password: 'admin-password-1' });
  let r = await admin.req('GET', '/api/admin/setup');
  assert.ok(r.json.checks.length >= 7);
  assert.equal(r.json.paste['Custom page URL (sidebar, agency + sub-account)'], env.base + '/embed');
  r = await admin.req('POST', '/api/admin/setup/test', {});
  assert.equal(r.json.ok, true, r.json.detail);
  env.cfg.ghl.clientSecret = 'nope';
  r = await admin.req('POST', '/api/admin/setup/test', {});
  assert.equal(r.json.ok, false);
});

test('sweep runs from traffic (Vercel free plan), once per interval, and from the cron', async (t) => {
  const env = await setup({ SWEEP_INTERVAL_SEC: '60' });
  t.after(() => env.server.close());
  const { ctx, base } = env;
  // Two leases in the same window: only the first wins.
  assert.equal(await ctx.store.claim('x', 60e3), true);
  assert.equal(await ctx.store.claim('x', 60e3), false);

  // A Vapi webhook (even a rejected one) starts a background sweep.
  await fetch(base + '/webhooks/vapi/nope', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  await Promise.all(env.pending.splice(0));
  const m = await ctx.store.get('meta', 'sweep');
  assert.equal(m.source, 'traffic');
  // Within the interval, more traffic does not sweep again.
  await fetch(base + '/webhooks/vapi/nope', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(env.pending.length, 0);

  // Cron: Vercel style (GET + Bearer) and external pinger style (POST + header).
  let r = await fetch(base + '/api/cron/sweep', { headers: { authorization: 'Bearer cron', 'user-agent': 'vercel-cron/1.0' } });
  assert.equal(r.status, 200);
  assert.equal((await ctx.store.get('meta', 'sweep')).source, 'vercel-cron');
  r = await fetch(base + '/api/cron/sweep', { method: 'POST', headers: { 'x-cron-secret': 'cron' } });
  assert.equal(r.status, 200);
  r = await fetch(base + '/api/cron/sweep', { method: 'POST', headers: { 'x-cron-secret': 'wrong' } });
  assert.equal(r.status, 401);
});
