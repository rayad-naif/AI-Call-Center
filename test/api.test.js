'use strict';
/* Public REST API (/api/v1), API keys and outgoing webhooks. */
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { setup, client } = require('./helpers');

async function platform(t) {
  const env = await setup();
  t.after(() => env.server.close());
  const owner = client(env.base);
  const r = await owner.req('GET', '/oauth/callback?code=abc');
  await owner.req('POST', '/api/auth/setup', { t: decodeURIComponent(r.location.split('t=')[1]), email: 'o@acme.com', password: 'longpassword1' });
  await owner.req('PUT', '/api/agency/keys', { twilioSid: 'ACmain', twilioToken: 'goodtoken', vapiKey: 'vapi-good', openaiKey: 'sk-good' });
  await owner.req('PUT', '/api/deployments/loc1aaaaaaaa', { name: 'Bob Plumbing', agent: { businessName: 'Bob Plumbing', timezone: 'America/Chicago' },
    outbound: { consent: true, enabled: true, days: ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'], start: '00:00', end: '23:59' } });
  await owner.req('POST', '/api/deployments/loc1aaaaaaaa/deploy', {});
  await env.ctx.store.put('agencies', { _id: 'comp2', name: 'Other Co', installed: true, status: 'active', createdAt: new Date().toISOString() });
  await env.ctx.store.put('calls', { _id: 'c_other', companyId: 'comp2', locationId: 'locXother000', status: 'ended', createdAt: new Date().toISOString(), customer: { number: '+1' }, transcript: [] });
  const admin = client(env.base);
  await admin.req('POST', '/api/admin/login', { password: 'admin-password-1' });
  const settle = () => Promise.all(env.pending.splice(0));
  return Object.assign(env, { owner, admin, settle });
}
const bearer = (base, key) => (method, path, body) => fetch(base + path, { method, headers: Object.assign({ Authorization: 'Bearer ' + key }, body ? { 'Content-Type': 'application/json' } : {}), body: body ? JSON.stringify(body) : undefined })
  .then(async (r) => ({ status: r.status, json: await r.json().catch(() => null) }));

test('API keys: auth, scopes, company limits; keys stored hashed', async (t) => {
  const env = await platform(t);
  const { admin, base, ctx } = env;

  assert.equal((await fetch(base + '/api/v1/companies')).status, 401);
  assert.equal((await bearer(base, 'acc_' + 'x'.repeat(30))('GET', '/api/v1/health')).status, 401);
  // Only the super admin manages keys; a company owner cannot.
  assert.equal((await env.owner.req('POST', '/api/admin/api-keys', { name: 'x' })).status, 401);

  let r = await admin.req('POST', '/api/admin/api-keys', { name: 'Attendly' });
  const readKey = r.json.key;
  assert.match(readKey, /^acc_/);
  const stored = await ctx.store.find('apiKeys', {});
  assert.ok(!JSON.stringify(stored).includes(readKey), 'only a hash is stored');
  const rd = bearer(base, readKey);

  r = await rd('GET', '/api/v1/health');
  assert.deepEqual(r.json.key.scopes, ['read']);
  r = await rd('GET', '/api/v1/companies');
  assert.deepEqual(r.json.data.map((c) => c.id).sort(), ['comp1', 'comp2']);
  assert.ok(!JSON.stringify(r.json).match(/accessToken|refreshToken|vapi-good|goodtoken|sk-good/), 'no secrets in the API');
  r = await rd('GET', '/api/v1/companies/comp1');
  assert.equal(r.json.accounts[0].id, 'loc1aaaaaaaa');
  assert.equal(r.json.accounts[0].status, 'live');
  assert.equal(r.json.users[0].email, 'o@acme.com');
  assert.ok(!('passwordHash' in r.json.users[0]));
  assert.equal((await rd('PATCH', '/api/v1/companies/comp1', { status: 'suspended' })).status, 403, 'read key cannot write');
  assert.equal((await rd('POST', '/api/v1/leads', { accountId: 'loc1aaaaaaaa', phone: '+15125550123' })).status, 403);

  // Company-limited write key.
  r = await admin.req('POST', '/api/admin/api-keys', { name: 'Bob CRM sync', write: true, companyId: 'comp1' });
  const wr = bearer(base, r.json.key);
  r = await wr('GET', '/api/v1/companies');
  assert.deepEqual(r.json.data.map((c) => c.id), ['comp1']);
  assert.equal((await wr('GET', '/api/v1/companies/comp2')).status, 403);
  assert.equal((await wr('GET', '/api/v1/calls/c_other')).status, 403);
  r = await wr('GET', '/api/v1/calls?companyId=comp2');
  assert.ok(r.json.data.every((c) => c.companyId === 'comp1'), 'company filter cannot be widened');

  // Send a lead from another app: the outbound agent calls it.
  r = await wr('POST', '/api/v1/leads', { accountId: 'loc1aaaaaaaa', phone: '(512) 555-0199', name: 'Pat', interest: 'drain cleaning' });
  assert.equal(r.status, 201, JSON.stringify(r.json));
  await env.settle();
  assert.equal(env.fakes.state.vapi.calls.at(-1).customer.number, '+15125550199');
  r = await wr('GET', '/api/v1/leads');
  assert.equal(r.json.data[0].name, 'Pat');
  assert.equal((await wr('GET', '/api/v1/leads/' + r.json.data[0].id)).json.interest, 'drain cleaning');

  r = await wr('PATCH', '/api/v1/companies/comp1', { status: 'pending' });
  assert.equal(r.json.status, 'pending');
  assert.equal((await wr('PATCH', '/api/v1/companies/comp1', { status: 'nope' })).status, 400);

  // Revoke.
  const prefix = (await admin.req('GET', '/api/admin/api-keys')).json.data.find((k) => k.name === 'Attendly').id;
  await admin.req('DELETE', '/api/admin/api-keys/' + prefix);
  assert.equal((await rd('GET', '/api/v1/health')).status, 401);
});

test('API: calls with transcript, filters, pagination, stats, events, OpenAPI', async (t) => {
  const env = await platform(t);
  const { admin, base, ctx } = env;
  const now = Date.now();
  for (let i = 0; i < 5; i++) {
    await ctx.store.put('calls', { _id: 'c' + i, companyId: 'comp1', locationId: 'loc1aaaaaaaa', status: i === 0 ? 'in-progress' : 'ended', direction: 'inbound',
      createdAt: new Date(now - i * 60e3).toISOString(), customer: { number: '+1512555000' + i }, transcript: [{ role: 'caller', text: 'hi ' + i }],
      grade: i === 1 ? { score: 90, sentiment: 'positive', outcome: 'appointment_booked', summary: 'Booked', nextSteps: [], coaching: [], flags: [] } : undefined,
      sync: { state: i === 2 ? 'failed' : 'done', error: i === 2 ? 'boom' : undefined }, durationSec: 60 });
  }
  const key = (await admin.req('POST', '/api/admin/api-keys', { name: 'BI' })).json.key;
  const api = bearer(base, key);
  let r = await api('GET', '/api/v1/calls?companyId=comp1&limit=2');
  assert.equal(r.json.data.length, 2);
  assert.ok(r.json.nextBefore);
  r = await api('GET', '/api/v1/calls?companyId=comp1&limit=2&before=' + encodeURIComponent(r.json.nextBefore));
  assert.deepEqual(r.json.data.map((c) => c.id), ['c2', 'c3']);
  assert.deepEqual((await api('GET', '/api/v1/calls?status=live')).json.data.map((c) => c.id), ['c0']);
  assert.deepEqual((await api('GET', '/api/v1/calls?outcome=appointment_booked')).json.data.map((c) => c.id), ['c1']);
  assert.deepEqual((await api('GET', '/api/v1/calls?syncState=failed')).json.data.map((c) => c.id), ['c2']);
  r = await api('GET', '/api/v1/calls/c1');
  assert.equal(r.json.transcript[0].text, 'hi 1');
  assert.equal(r.json.grade.score, 90);
  assert.ok(!('monitor' in r.json));
  r = await api('GET', '/api/v1/stats?days=7');
  assert.equal(r.json.calls.total, 6);
  assert.equal(r.json.calls.booked, 1);
  assert.equal(r.json.crmSync.failed, 1);
  assert.equal(r.json.daily.length, 7);
  r = await api('GET', '/api/v1/events?companyId=comp1&type=deploy.done');
  assert.equal(r.json.data[0].type, 'deploy.done');
  r = await api('GET', '/api/v1/accounts/loc1aaaaaaaa');
  assert.equal(r.json.features.speedToLead, true);
  assert.equal((await api('GET', '/api/v1/nope')).status, 404);

  const spec = await (await fetch(base + '/api/v1/openapi.json')).json();
  assert.equal(spec.openapi, '3.0.3');
  assert.ok(spec.paths['/api/v1/calls/{callId}'].get);
  assert.ok(spec.paths['/api/v1/leads'].post.requestBody);
  // The admin portal uses the same API with its session.
  assert.equal((await admin.req('GET', '/api/v1/companies')).status, 200);
  r = await admin.req('GET', '/api/admin/api-reference');
  assert.ok(r.json.endpoints.length >= 14);
});

test('outgoing webhooks: signed deliveries, filters, retries, test ping', async (t) => {
  const env = await platform(t);
  const { admin, ctx, fakes } = env;
  assert.equal((await admin.req('POST', '/api/admin/webhooks', { url: 'http://insecure.example.com/x' })).status, 400);
  assert.equal((await admin.req('POST', '/api/admin/webhooks', { url: 'https://127.0.0.1/x' })).status, 400);

  let r = await admin.req('POST', '/api/admin/webhooks', { url: 'https://hooks.example.test/acc', events: ['call.ended', 'lead.received'] });
  const secret = r.json.secret;
  assert.match(secret, /^whsec_/);
  const down = (await admin.req('POST', '/api/admin/webhooks', { url: 'https://down.example.test/x', companyId: 'comp1' })).json.webhook.id;
  await admin.req('POST', '/api/admin/webhooks', { url: 'https://hooks.example.test/other-company', companyId: 'comp2' });

  // A call ends -> call.ended to the matching hooks only.
  const dep = await ctx.store.get('deployments', 'loc1aaaaaaaa');
  const vapiSecret = ctx.sec.decrypt(dep.serverSecret);
  const call = { id: 'call_w1', type: 'inboundPhoneCall', customer: { number: '+15125551234' } };
  const hook = (message) => fetch(env.base + '/webhooks/vapi/loc1aaaaaaaa', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-vapi-secret': vapiSecret }, body: JSON.stringify({ message }) });
  await hook({ type: 'status-update', status: 'in-progress', call });
  await hook({ type: 'end-of-call-report', call, endedReason: 'customer-ended-call' });
  await env.settle(); await env.settle();
  const got = (fakes.state.hooks || []).filter((x) => JSON.parse(x.body).type === 'call.ended');
  assert.equal(got.length, 1, 'only the subscribed, matching hook');
  const d = got[0];
  const evt = JSON.parse(d.body);
  assert.equal(evt.companyId, 'comp1');
  assert.equal(evt.data.call.id, 'call_w1');
  assert.equal(evt.data.account.id, 'loc1aaaaaaaa');
  // Signature verifies with the secret shown at creation.
  const { t: ts, v1 } = Object.fromEntries(d.headers['X-ACC-Signature'].split(',').map((p) => p.split('=')));
  assert.equal(crypto.createHmac('sha256', secret).update(ts + '.' + d.body).digest('hex'), v1);
  assert.equal(d.headers['X-ACC-Event'], 'call.ended');

  // The failing endpoint is retried with backoff, then marked failed.
  let dl = (await admin.req('GET', '/api/admin/webhook-deliveries?hookId=' + down)).json.data;
  assert.ok(dl.length >= 1);
  assert.equal(dl[0].status, 'retrying');
  assert.equal(dl[0].lastCode, 500);
  for (let i = 0; i < 6; i++) {
    for (const x of await ctx.store.find('webhookDeliveries', { hookId: down })) await ctx.store.patch('webhookDeliveries', x._id, { nextAt: new Date(Date.now() - 1000).toISOString() });
    await env.app.locals.sweep('test');
  }
  dl = (await admin.req('GET', '/api/admin/webhook-deliveries?hookId=' + down)).json.data;
  assert.ok(dl.every((x) => x.status === 'failed' && x.attempts === 6), JSON.stringify(dl.map((x) => [x.status, x.attempts])));

  // Test ping + pause.
  const okHook = (await admin.req('GET', '/api/admin/webhooks')).json.data.find((x) => x.url === 'https://hooks.example.test/acc');
  r = await admin.req('POST', '/api/admin/webhooks/' + okHook.id + '/test', {});
  assert.equal(r.json.ok, true);
  await admin.req('PATCH', '/api/admin/webhooks/' + okHook.id, { active: false });
  const before = (fakes.state.hooks || []).length;
  await ctx.store.log('comp1', 'lead.received', 'x', { locationId: 'loc1aaaaaaaa' });
  await env.settle();
  assert.equal((fakes.state.hooks || []).length, before, 'paused hooks get nothing');
});

test('personal API access: every user has their own keys and webhooks, limited to what they can see', async (t) => {
  const env = await platform(t);
  const { owner, admin, base, ctx } = env;
  // A second account in the same company, and three more people.
  const dep = await ctx.store.get('deployments', 'loc1aaaaaaaa');
  await ctx.store.put('deployments', Object.assign({}, dep, { _id: 'loc2bbbbbbbb', name: 'Other Co' }));
  await ctx.store.put('calls', { _id: 'c_loc2', companyId: 'comp1', locationId: 'loc2bbbbbbbb', status: 'ended', createdAt: new Date().toISOString(), customer: { number: '+1' }, transcript: [] });
  await ctx.store.put('calls', { _id: 'c_loc1', companyId: 'comp1', locationId: 'loc1aaaaaaaa', status: 'ended', createdAt: new Date().toISOString(), customer: { number: '+2' }, transcript: [] });
  await owner.req('POST', '/api/users', { email: 'bob@plumbing.com', kind: 'client', role: 'manager', locationIds: ['loc1aaaaaaaa'], password: 'bobpassword1' });
  await owner.req('POST', '/api/users', { email: 'vic@plumbing.com', kind: 'client', role: 'viewer', locationIds: ['loc1aaaaaaaa'], password: 'vicpassword1' });
  await owner.req('POST', '/api/users', { email: 'sam@acme.com', kind: 'agency', role: 'manager', password: 'sampassword1' });
  const login = async (email, password) => { const c = client(base); await c.req('POST', '/api/auth/login', { email, password }); return c; };
  const bob = await login('bob@plumbing.com', 'bobpassword1');
  const vic = await login('vic@plumbing.com', 'vicpassword1');
  const sam = await login('sam@acme.com', 'sampassword1');

  // Bob (client manager, one account): his key only sees that account.
  let r = await bob.req('POST', '/api/company/api-keys', { name: 'Bob sheet', write: true, companyId: 'comp2' });
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(r.json.apiKey.accountIds, ['loc1aaaaaaaa']);
  assert.equal(r.json.apiKey.companyId, 'comp1');
  const bk = bearer(base, r.json.key);
  r = await bk('GET', '/api/v1/calls');
  assert.deepEqual(r.json.data.map((c) => c.accountId).sort(), ['loc1aaaaaaaa']);
  assert.equal((await bk('GET', '/api/v1/calls/c_loc2')).status, 403);
  assert.equal((await bk('GET', '/api/v1/calls?accountId=loc2bbbbbbbb')).status, 403);
  assert.equal((await bk('GET', '/api/v1/accounts/loc2bbbbbbbb')).status, 403);
  assert.deepEqual((await bk('GET', '/api/v1/accounts')).json.data.map((a) => a.id), ['loc1aaaaaaaa']);
  r = await bk('GET', '/api/v1/companies/comp1');
  assert.deepEqual(r.json.accounts.map((a) => a.id), ['loc1aaaaaaaa']);
  assert.deepEqual(r.json.users, [], 'no user list for account-limited keys');
  assert.equal((await bk('POST', '/api/v1/leads', { accountId: 'loc2bbbbbbbb', phone: '+15125550101' })).status, 403);
  assert.equal((await bk('POST', '/api/v1/leads', { accountId: 'loc1aaaaaaaa', phone: '+15125550102' })).status, 201);
  assert.equal((await bk('PATCH', '/api/v1/companies/comp1', { status: 'active' })).status, 403, 'never licenses');

  // Vic (viewer): read-only keys only.
  assert.equal((await vic.req('POST', '/api/company/api-keys', { name: 'x', write: true })).status, 403);
  r = await vic.req('POST', '/api/company/api-keys', { name: 'Vic read' });
  const vk = bearer(base, r.json.key);
  assert.deepEqual((await vk('GET', '/api/v1/health')).json.key.scopes, ['read']);
  r = await vic.req('GET', '/api/company/api-reference');
  assert.ok(!r.json.endpoints.some((e) => e.scope === 'write'), 'viewers do not see write endpoints');

  // Sam (company staff, manager): whole company, but only his own keys in the list.
  r = await sam.req('POST', '/api/company/api-keys', { name: 'Sam BI', write: true });
  const sk = bearer(base, r.json.key);
  assert.deepEqual((await sk('GET', '/api/v1/calls')).json.data.map((c) => c.accountId).sort().filter((v, i, a) => a.indexOf(v) === i), ['loc1aaaaaaaa', 'loc2bbbbbbbb']);
  assert.deepEqual((await sam.req('GET', '/api/company/api-keys')).json.data.map((k) => k.name), ['Sam BI']);
  assert.deepEqual((await bob.req('GET', '/api/company/api-keys')).json.data.map((k) => k.name), ['Bob sheet']);
  const bobPrefix = (await bob.req('GET', '/api/company/api-keys')).json.data[0].id;
  assert.equal((await sam.req('DELETE', '/api/company/api-keys/' + bobPrefix)).status, 404, 'not his key');

  // Owner (company admin) sees everyone's keys with their owner, and can revoke any.
  r = await owner.req('GET', '/api/company/api-keys');
  assert.deepEqual(r.json.data.map((k) => k.owner.email).sort(), ['bob@plumbing.com', 'sam@acme.com', 'vic@plumbing.com']);
  await admin.req('POST', '/api/admin/api-keys', { name: 'Platform BI' });
  assert.ok(!(await owner.req('GET', '/api/company/api-keys')).json.data.some((k) => k.name === 'Platform BI'), 'platform keys stay private');

  // Access follows the person: role drop removes writes, disabling stops the key.
  const users = (await owner.req('GET', '/api/users')).json.users;
  const bobId = users.find((u) => u.email === 'bob@plumbing.com').id;
  await owner.req('PATCH', '/api/users/' + bobId, { role: 'viewer' });
  assert.deepEqual((await bk('GET', '/api/v1/health')).json.key.scopes, ['read']);
  assert.equal((await bk('POST', '/api/v1/leads', { accountId: 'loc1aaaaaaaa', phone: '+15125550103' })).status, 403);
  await owner.req('PATCH', '/api/users/' + bobId, { disabled: true });
  assert.equal((await bk('GET', '/api/v1/health')).status, 401);
  // Suspending the company stops all company and personal keys.
  await ctx.store.patch('agencies', 'comp1', { status: 'suspended' });
  assert.equal((await sk('GET', '/api/v1/health')).status, 401);
  await ctx.store.patch('agencies', 'comp1', { status: 'active' });
  assert.equal((await sk('GET', '/api/v1/health')).status, 200);
  await owner.req('DELETE', '/api/company/api-keys/' + (await sam.req('GET', '/api/company/api-keys')).json.data[0].id);
  assert.equal((await sk('GET', '/api/v1/health')).status, 401, 'company admin revoked it');
});

test('personal webhooks: owners, account filtering, admin overview', async (t) => {
  const env = await platform(t);
  const { owner, base, ctx, fakes } = env;
  const dep = await ctx.store.get('deployments', 'loc1aaaaaaaa');
  await ctx.store.put('deployments', Object.assign({}, dep, { _id: 'loc2bbbbbbbb', name: 'Other Co' }));
  await owner.req('POST', '/api/users', { email: 'bob@plumbing.com', kind: 'client', role: 'manager', locationIds: ['loc1aaaaaaaa'], password: 'bobpassword1' });
  const bob = client(base);
  await bob.req('POST', '/api/auth/login', { email: 'bob@plumbing.com', password: 'bobpassword1' });

  let r = await bob.req('POST', '/api/company/webhooks', { url: 'https://hooks.example.test/bob', companyId: 'comp2' });
  assert.equal(r.json.webhook.companyId, 'comp1');
  assert.deepEqual(r.json.webhook.accountIds, ['loc1aaaaaaaa']);
  const bobHook = r.json.webhook.id;
  const ownerHook = (await owner.req('POST', '/api/company/webhooks', { url: 'https://hooks.example.test/owner' })).json.webhook.id;

  await ctx.store.log('comp1', 'lead.received', 'a', { locationId: 'loc2bbbbbbbb' });
  await ctx.store.log('comp1', 'lead.received', 'b', { locationId: 'loc1aaaaaaaa' });
  await ctx.store.log('comp1', 'company.status_changed', 'c');
  await env.settle(); await env.settle();
  const got = (fakes.state.hooks || []).map((x) => ({ to: x.headers['X-ACC-Delivery'], body: JSON.parse(x.body) }));
  const bobs = (await bob.req('GET', '/api/company/webhook-deliveries')).json.data;
  assert.deepEqual(bobs.map((d) => d.hookId).filter((v, i, a) => a.indexOf(v) === i), [bobHook]);
  assert.equal(bobs.length, 1, 'only the event of his own account');
  assert.equal(got.filter((g) => g.body.data.detail === 'b').length, 2, 'owner and Bob both get his account');
  assert.equal(got.filter((g) => g.body.data.detail === 'a').length, 1, 'only the owner gets the other account');

  // Visibility and control.
  assert.deepEqual((await bob.req('GET', '/api/company/webhooks')).json.data.map((w) => w.id), [bobHook]);
  assert.equal((await bob.req('DELETE', '/api/company/webhooks/' + ownerHook)).status, 404);
  r = await owner.req('GET', '/api/company/webhooks');
  assert.deepEqual(r.json.data.map((w) => w.id).sort(), [bobHook, ownerHook].sort());
  assert.equal(r.json.data.find((w) => w.id === bobHook).owner.email, 'bob@plumbing.com');

  // A disabled owner's webhook stops delivering.
  const bobId = (await owner.req('GET', '/api/users')).json.users.find((u) => u.email === 'bob@plumbing.com').id;
  await owner.req('PATCH', '/api/users/' + bobId, { disabled: true });
  await ctx.store.log('comp1', 'lead.received', 'd', { locationId: 'loc1aaaaaaaa' });
  await env.settle(); await env.settle();
  const d = (await owner.req('GET', '/api/company/webhook-deliveries?hookId=' + bobHook)).json.data[0];
  assert.equal(d.status, 'cancelled');
});
