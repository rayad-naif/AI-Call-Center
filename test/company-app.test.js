'use strict';
/* Company edition: company-level listing; each client account connects with its
   own account Private Integration token instead of a minted location token. */
const test = require('node:test');
const assert = require('node:assert/strict');
const { setup, client } = require('./helpers');
const config = require('../server/config');

// app: 'company' installs through the company app, otherwise the account app.
async function installed(t, app) {
  const e = await setup();
  t.after(() => e.server.close());
  const c = client(e.base);
  const r = await c.req('GET', app === 'agency' ? '/oauth/company/callback?code=abc' : '/oauth/callback?code=abc');
  await c.req('POST', '/api/auth/setup', { t: decodeURIComponent(r.location.split('t=')[1]), email: 'o@acme.com', password: 'longpassword1' });
  return Object.assign(e, { owner: c });
}

test('one deployment, two apps: the company app asks only for company-level scopes', () => {
  const cfg = config.load({ GHL_CLIENT_ID: 'a-1', GHL_AGENCY_CLIENT_ID: 'b-2', BASE_URL: 'https://x.test' });
  assert.equal(cfg.apps.agency.scopes, config.AGENCY_SCOPES);
  assert.doesNotMatch(cfg.apps.agency.scopes, /contacts|oauth\.write|conversations/);
  assert.equal(cfg.apps.standard.scopes, config.DEFAULT_SCOPES);
  assert.equal(cfg.apps.agency.redirectUri, 'https://x.test/oauth/company/callback');
  assert.equal(cfg.apps.standard.redirectUri, 'https://x.test/oauth/callback');
  assert.equal(cfg.apps.agency.appId, 'b');
  // Either app alone is a valid configuration.
  const base = { SESSION_SECRET: 's'.repeat(40), ENCRYPTION_KEY: 'e'.repeat(40), ADMIN_PASSWORD: 'x'.repeat(12) };
  assert.deepEqual(config.validate(config.load(Object.assign({ GHL_AGENCY_CLIENT_ID: 'b-2', GHL_AGENCY_CLIENT_SECRET: 's' }, base))), []);
  assert.equal(config.validate(config.load(base)).length, 1);
});

test('company edition: accounts need a Private Integration token; it is checked, encrypted and used for CRM calls', async (t) => {
  const env = await installed(t, 'agency');
  const o = env.owner;
  const loc = 'loc1aaaaaaaa';

  let r = await o.req('GET', '/api/agency');
  assert.equal(r.json.edition, 'agency');
  r = await o.req('GET', '/api/locations');
  assert.equal(r.json.edition, 'agency');
  assert.equal(r.json.locations.find((l) => l.id === loc).appInstalled, false, 'not connected yet');

  // No token: clear message, and no location token is minted.
  r = await o.req('GET', '/api/locations/' + loc + '/crm');
  assert.equal(r.status, 409);
  assert.match(r.json.error, /Private Integration token/);
  assert.ok(!env.fakes.state.ghl.auth.some((x) => x.path === '/oauth/locationToken'));

  // Bad, short and wrong-account tokens are refused and not saved.
  r = await o.req('PUT', '/api/locations/' + loc + '/crm-token', { token: 'pit-bad-0000000000000000000000' });
  assert.equal(r.status, 400); assert.match(r.json.error, /rejected/);
  r = await o.req('PUT', '/api/locations/' + loc + '/crm-token', { token: 'short' });
  assert.equal(r.status, 400);
  r = await o.req('PUT', '/api/locations/' + loc + '/crm-token', { token: 'pit-other-000000000000000000000' });
  assert.equal(r.status, 400); assert.match(r.json.error, /different account/);
  assert.equal((await o.req('GET', '/api/locations/' + loc + '/crm-token')).json.connected, false);

  // Good token: saved encrypted, account shows as connected, CRM calls use it.
  const pit = 'pit-good-1111111111111111111111';
  r = await o.req('PUT', '/api/locations/' + loc + '/crm-token', { token: pit });
  assert.equal(r.status, 200); assert.equal(r.json.connected, true);
  const stored = await env.ctx.store.get('crmTokens', loc);
  assert.ok(stored.token && !String(stored.token).includes(pit), 'stored encrypted');
  r = await o.req('GET', '/api/locations');
  assert.equal(r.json.locations.find((l) => l.id === loc).appInstalled, true);
  assert.equal(r.json.locations.find((l) => l.id === loc).crmToken, true);

  env.fakes.state.ghl.auth.length = 0;
  r = await o.req('GET', '/api/locations/' + loc + '/crm');
  assert.equal(r.status, 200);
  assert.equal(r.json.location.name, 'Bob Plumbing');
  const used = env.fakes.state.ghl.auth.filter((x) => /pipelines|calendars|locations\//.test(x.path));
  assert.ok(used.length && used.every((x) => x.auth === 'Bearer ' + pit), 'CRM calls use the Private Integration token');
  assert.ok(!env.fakes.state.ghl.auth.some((x) => x.path === '/oauth/locationToken'));

  // Another company cannot read or use it.
  assert.equal((await env.ctx.agencySvc.hasCrmToken({ _id: 'otheragency' }, loc)), false);

  // Disconnect.
  r = await o.req('DELETE', '/api/locations/' + loc + '/crm-token');
  assert.equal(r.json.connected, false);
  r = await o.req('GET', '/api/locations/' + loc + '/crm');
  assert.equal(r.status, 409);
});

test('standard edition: a Private Integration token also works where the app is not installed', async (t) => {
  const env = await installed(t);
  const loc = 'loc2bbbbbbbb';
  env.fakes.state.ghl.blockLocationToken.add(loc);
  let r = await env.owner.req('GET', '/api/locations/' + loc + '/crm');
  assert.equal(r.status, 409);
  r = await env.owner.req('PUT', '/api/locations/' + loc + '/crm-token', { token: 'pit-good-2222222222222222222222' });
  assert.equal(r.status, 200);
  r = await env.owner.req('GET', '/api/locations/' + loc + '/crm');
  assert.equal(r.status, 200);
  r = await env.owner.req('GET', '/api/locations');
  assert.equal(r.json.locations.find((l) => l.id === loc).appInstalled, true);
});

test('company app install uses its own client keys; SSO works with its own key', async (t) => {
  const env = await installed(t, 'agency');
  const { ctx, fakes, base } = env;
  const ws = await ctx.store.get('agencies', 'comp1');
  assert.equal(ws.app, 'agency');
  assert.ok(ws.ghlApps.agency);
  assert.equal(fakes.state.ghl.tokenClients.at(-1), 'app2-xyz');
  await ctx.store.patch('agencies', 'comp1', { 'ghl.expiresAt': Date.now() - 1000 });
  await ctx.agencySvc.agencyToken(await ctx.store.get('agencies', 'comp1'));
  assert.equal(fakes.state.ghl.tokenClients.at(-1), 'app2-xyz', 'refresh uses the company app client');

  const { encryptGhlSso } = require('../server/security');
  const r = await client(base).req('POST', '/api/auth/sso', { payload: encryptGhlSso({ userId: 'u', companyId: 'comp1', type: 'agency', role: 'admin' }, 'sso-key-2') });
  assert.equal(r.json.redirect, '/app');
  const me = await env.owner.req('GET', '/api/agency');
  assert.equal(me.json.edition, 'agency');
});

test('a company with both apps: account app stays in charge; uninstalling one keeps the other', async (t) => {
  const env = await installed(t, 'agency');
  const { ctx, base } = env;
  const hook = (b) => fetch(base + '/webhooks/crm', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) }).then((x) => x.json());

  // Account app installed later at company level: it takes over (full scopes).
  await env.owner.req('GET', '/oauth/callback?code=abc');
  let ws = await ctx.store.get('agencies', 'comp1');
  assert.equal(ws.app, 'standard');
  assert.deepEqual(Object.keys(ws.ghlApps).sort(), ['agency', 'standard']);
  // Reinstalling the company app does not downgrade it.
  await env.owner.req('GET', '/oauth/agency/callback?code=abc');
  assert.equal((await ctx.store.get('agencies', 'comp1')).app, 'standard');

  // Events from an unknown app are ignored.
  assert.equal((await hook({ type: 'UNINSTALL', appId: 'someoneelse', companyId: 'comp1' })).ignored, true);

  // Uninstall the account app (signature keys absent: confirmed via the revoked token).
  ctx.cfg.ghl.webhookEd25519Key = '';
  const cur = await ctx.store.get('agencies', 'comp1');
  env.fakes.state.ghl.usedRefresh.add(ctx.sec.decrypt(cur.ghl.refreshToken));
  await ctx.store.patch('agencies', 'comp1', { 'ghl.expiresAt': Date.now() - 1000 });
  await hook({ type: 'UNINSTALL', appId: 'app1', companyId: 'comp1', installType: 'Company' });
  ws = await ctx.store.get('agencies', 'comp1');
  assert.equal(ws.installed, true, 'still running on the company app');
  assert.equal(ws.app, 'agency');
  assert.deepEqual(Object.keys(ws.ghlApps), ['agency']);

  // Then the company app too: the workspace is uninstalled.
  env.fakes.state.ghl.usedRefresh.add(ctx.sec.decrypt(ws.ghl.refreshToken));
  await ctx.store.patch('agencies', 'comp1', { 'ghl.expiresAt': Date.now() - 1000 });
  await hook({ type: 'UNINSTALL', appId: 'app2', companyId: 'comp1', installType: 'Company' });
  assert.equal((await ctx.store.get('agencies', 'comp1')).installed, false);
});
