'use strict';
/* End-to-end: install -> keys -> deploy -> live call -> tools -> controls ->
   takeover -> end-of-call QA + CRM sync, against faked providers. */
const test = require('node:test');
const assert = require('node:assert/strict');
const { twilioSignature, encryptGhlSso } = require('../server/security');
const { setup, client, rawRequest } = require('./helpers');

test('full call center lifecycle', async (t) => {
  const env = await setup();
  t.after(() => env.server.close());
  const { base, fakes, ctx } = env;
  const owner = client(base);

  // 1. Install via OAuth
  let r = await owner.req('GET', '/oauth/callback?code=abc');
  assert.equal(r.status, 302);
  assert.match(r.location, /^\/app\/setup\?t=/);
  const agency = await ctx.store.get('agencies', 'comp1');
  assert.equal(agency.name, 'Acme Agency');
  assert.ok(agency.ghl.accessToken.startsWith('v1:'), 'GHL token encrypted');

  // 2. Owner login
  const t1 = decodeURIComponent(r.location.split('t=')[1]);
  r = await owner.req('POST', '/api/auth/setup', { t: t1, email: 'Owner@Acme.com', password: 'longpassword1', name: 'Olivia' });
  assert.equal(r.status, 200, r.text);
  r = await owner.req('POST', '/api/auth/setup', { t: t1, email: 'x@acme.com', password: 'longpassword1' });
  assert.equal(r.status, 409, 'second owner refused');

  // CSRF header required for writes
  r = await owner.req('PUT', '/api/agency/keys', { vapiKey: 'x' }, { 'X-ACC': '' });
  assert.equal(r.status, 403);

  // 3. Keys: bad ones are rejected and not stored
  r = await owner.req('PUT', '/api/agency/keys', { twilioSid: 'ACmain', twilioToken: 'badtoken', vapiKey: 'vapi-bad', openaiKey: 'sk-bad' });
  assert.equal(r.status, 200);
  assert.equal(r.json.keys.status.twilio.ok, false);
  assert.equal(r.json.keys.vapiKey.set, false);
  r = await owner.req('PUT', '/api/agency/keys', { twilioSid: 'ACmain', twilioToken: 'goodtoken', vapiKey: 'vapi-good', openaiKey: 'sk-good' });
  assert.ok(r.json.keys.status.twilio.ok && r.json.keys.status.vapi.ok && r.json.keys.status.openai.ok, JSON.stringify(r.json.keys.status));
  assert.equal(r.json.keys.vapiKey.hint, '••••good');
  const stored = JSON.stringify(await ctx.store.get('agencies', 'comp1'));
  assert.ok(!stored.includes('vapi-good') && !stored.includes('sk-good') && !stored.includes('goodtoken'), 'keys encrypted at rest');

  // 4. Sub-accounts + CRM data
  r = await owner.req('GET', '/api/locations');
  assert.equal(r.json.locations.length, 2);
  r = await owner.req('GET', '/api/locations/loc1aaaaaaaa/crm');
  assert.equal(r.json.pipelines[0].stages.length, 2);

  // 5. Deploy
  r = await owner.req('PUT', '/api/deployments/loc1aaaaaaaa', {
    name: 'Bob Plumbing',
    agent: { businessName: 'Bob Plumbing', services: 'Water heaters', calendarId: 'cal1', timezone: 'America/Chicago', transferNumber: '+1 (512) 555-0000' },
    pipeline: { pipelineId: 'pipe1', stages: { appointment_booked: 'st_booked', qualified_lead: 'st_new' } },
    options: { areaCode: '512' }
  });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.deployment.agent.transferNumber, '+15125550000');
  r = await owner.req('POST', '/api/deployments/loc1aaaaaaaa/deploy', {});
  assert.equal(r.status, 200, r.text);
  const dep = r.json.deployment;
  assert.equal(dep.status, 'live');
  assert.ok(dep.steps.every((s) => s.status === 'done'), JSON.stringify(dep.steps));
  assert.match(dep.phoneNumber, /^\+1512/);

  const vs = fakes.state.vapi;
  assert.equal(Object.keys(vs.assistants).length, 4); // 3 squad members + outbound
  assert.equal(vs.credentials[0].provider, 'openai');
  const squad = Object.values(vs.squads)[0];
  assert.equal(squad.members.length, 3);
  const names = Object.values(vs.assistants).map((a) => a.name);
  squad.members.forEach((m) => m.assistantDestinations.forEach((d) => assert.ok(names.includes(d.assistantName), 'destination names match members')));
  const sales = Object.values(vs.assistants).find((a) => a.metadata.role === 'sales');
  assert.deepEqual(sales.model.tools.map((x) => x.function ? x.function.name : x.type), ['check_availability', 'book_appointment', 'transferCall']);
  assert.deepEqual(sales.monitorPlan, { listenEnabled: true, controlEnabled: true });
  const vnum = Object.values(vs.numbers)[0];
  assert.equal(vnum.squadId, squad.id);
  assert.match(vnum.twilioAccountSid, /^ACsub/);
  assert.equal(vnum.server.url, base + '/webhooks/vapi/loc1aaaaaaaa');
  assert.equal(fakes.state.ghl.fields.length, 7);
  assert.equal(fakes.state.twilio.keys, 1);

  // Redeploy is idempotent: nothing new is created.
  r = await owner.req('POST', '/api/deployments/loc1aaaaaaaa/deploy', {});
  assert.equal(r.status, 200, r.text);
  assert.equal(Object.keys(vs.assistants).length, 4); // 3 squad members + outbound
  assert.equal(Object.keys(vs.squads).length, 1);
  assert.equal(fakes.state.ghl.fields.length, 7);
  assert.equal(Object.keys(fakes.state.twilio.subaccounts).length, 1);

  // 6. Live call via Vapi webhooks
  const depDoc = await ctx.store.get('deployments', 'loc1aaaaaaaa');
  const secret = ctx.sec.decrypt(depDoc.serverSecret);
  const hook = (message, s) => fetch(base + '/webhooks/vapi/loc1aaaaaaaa', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-vapi-secret': s === undefined ? secret : s }, body: JSON.stringify({ message }) }).then(async (x) => ({ status: x.status, json: await x.json() }));
  const call = { id: 'call_1', type: 'inboundPhoneCall', customer: { number: '+15125551234' }, monitor: { listenUrl: 'wss://listen.vapi.test/call_1', controlUrl: 'https://control.vapi.test/call_1' } };

  assert.equal((await hook({ type: 'status-update', status: 'in-progress', call }, 'wrong')).status, 401);
  await hook({ type: 'status-update', status: 'in-progress', call });
  await hook({ type: 'transcript', role: 'assistant', transcriptType: 'final', transcript: 'Thanks for calling Bob Plumbing!', call, assistant: { name: 'Bob Plumbing - Receptionist' } });
  await hook({ type: 'transcript', role: 'user', transcriptType: 'partial', transcript: 'I need a new wat', call });
  await hook({ type: 'transcript', role: 'user', transcriptType: 'final', transcript: 'I need a new water heater.', call });
  await hook({ type: 'transcript', role: 'assistant', transcriptType: 'final', transcript: 'Let me check times.', call, assistant: { name: 'Bob Plumbing - Sales' } });

  r = await owner.req('GET', '/api/live/calls');
  assert.equal(r.json.calls.length, 1);
  assert.equal(r.json.calls[0].agent, 'Sales');
  r = await owner.req('GET', '/api/live/calls/call_1?after=1');
  assert.equal(r.json.total, 3);
  assert.equal(r.json.lines.length, 2);
  assert.equal(r.json.lines[0].role, 'caller');
  assert.equal(r.json.canListen, true);
  assert.ok(!JSON.stringify(r.json).includes('control.vapi.test'), 'control URL never sent to browser');

  // Tools
  const tc = await hook({ type: 'tool-calls', call, toolCallList: [
    { id: 'tc1', function: { name: 'check_availability', arguments: { days: 3 } } },
    { id: 'tc2', function: { name: 'book_appointment', arguments: JSON.stringify({ start_time: '2030-01-07T09:00:00-06:00', name: 'Jane Doe', email: 'jane@example.com' }) } }
  ] });
  assert.equal(tc.status, 200);
  assert.match(tc.json.results[0].result, /2030-01-07T09:00:00-06:00/);
  assert.match(tc.json.results[1].result, /^Booked for/);
  assert.equal(fakes.state.ghl.appointments[0].calendarId, 'cal1');
  assert.equal(fakes.state.ghl.appointments[0].endTime, '2030-01-07T16:00:00.000Z');

  // Controls
  r = await owner.req('POST', '/api/live/calls/call_1/whisper', { text: 'Offer 10% off' });
  assert.equal(r.status, 200, r.text);
  assert.equal(vs.controls[0].body.type, 'add-message');
  assert.equal(vs.controls[0].body.triggerResponseEnabled, false);
  assert.match(vs.controls[0].body.message.content, /Offer 10% off/);
  r = await owner.req('POST', '/api/live/calls/call_1/listen', {});
  assert.equal(r.json.url, 'wss://listen.vapi.test/call_1');

  // Voice token + takeover
  r = await owner.req('GET', '/api/live/voice-token');
  assert.equal(r.json.enabled, true);
  const payload = JSON.parse(Buffer.from(r.json.token.split('.')[1], 'base64url').toString());
  assert.equal(payload.iss, 'SKkey1');
  assert.equal(payload.grants.identity, r.json.identity);
  r = await owner.req('POST', '/api/live/calls/call_1/takeover', {});
  assert.equal(r.status, 200, r.text);
  const transfer = vs.controls.find((c) => c.body.type === 'transfer');
  const line = (await ctx.store.get('agencies', 'comp1')).setup.takeoverNumber;
  assert.equal(transfer.body.destination.number, line);

  // Twilio rings the takeover line: unsigned is refused, signed is bridged to the browser.
  const params = { To: line, From: '+15125551234', CallSid: 'CA1', AccountSid: 'ACmain' };
  const url = base + '/twilio/voice/takeover';
  let tw = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(params) });
  assert.equal(tw.status, 403);
  tw = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Twilio-Signature': twilioSignature('goodtoken', url, params) }, body: new URLSearchParams(params) });
  const xml = await tw.text();
  assert.match(xml, new RegExp('<Client>' + payload.grants.identity + '</Client>'));
  r = await owner.req('GET', '/api/live/calls/call_1');
  assert.equal(r.json.takeover.state, 'live');

  // 7. End of call -> QA grade + CRM sync
  await hook({ type: 'end-of-call-report', call, endedReason: 'customer-ended-call', durationSeconds: 95, recordingUrl: 'https://rec.test/1.wav',
    artifact: { transcript: 'AI: Thanks for calling\nUser: I need a new water heater', messages: [{ role: 'bot', message: 'Thanks for calling' }, { role: 'user', message: 'I need a new water heater' }] } });
  await Promise.all(env.pending);
  const ended = await ctx.store.get('calls', 'call_1');
  assert.equal(ended.status, 'ended');
  assert.equal(ended.grade.score, 88);
  assert.deepEqual(ended.grade.flags, []);
  assert.equal(ended.sync.state, 'done', JSON.stringify(ended.sync));
  const contact = fakes.state.ghl.contacts['contact_+15125551234'];
  assert.equal(contact.firstName, 'Jane');
  assert.equal(contact.email, 'jane@example.com');
  assert.ok(contact.customFields.some((f) => f.field_value === 88));
  assert.match(fakes.state.ghl.notes.at(-1).body, /QA score: 88\/100/);
  assert.equal(fakes.state.ghl.opportunities[0].pipelineStageId, 'st_booked');
  r = await owner.req('GET', '/api/live/calls');
  assert.equal(r.json.calls.length, 0, 'ended call leaves the live grid');
  r = await owner.req('POST', '/api/live/calls/call_1/whisper', { text: 'hi' });
  assert.equal(r.status, 409);

  // 8. Client login sees only their location
  r = await owner.req('POST', '/api/users', { email: 'bob@plumbing.com', kind: 'client', role: 'viewer', locationIds: ['loc1aaaaaaaa'], password: 'bobpassword1' });
  assert.equal(r.status, 200, r.text);
  const bob = client(base);
  r = await bob.req('POST', '/api/auth/login', { email: 'bob@plumbing.com', password: 'bobpassword1' });
  assert.equal(r.json.redirect, '/deck');
  r = await bob.req('GET', '/api/live/history');
  assert.equal(r.json.calls.length, 1);
  r = await bob.req('GET', '/api/live/history?location=loc2bbbbbbbb');
  assert.equal(r.status, 403);
  r = await bob.req('GET', '/api/agency');
  assert.equal(r.status, 403);
  r = await bob.req('POST', '/api/live/calls/call_1/listen', {});
  assert.equal(r.status, 403, 'viewer cannot listen');
  r = await bob.req('GET', '/api/deployments');
  assert.deepEqual(Object.keys(r.json.deployments[0]).sort(), ['locationId', 'name', 'phoneNumber', 'status']);

  // Disabling a user signs them out
  const users = (await owner.req('GET', '/api/users')).json.users;
  await owner.req('PATCH', '/api/users/' + users.find((u) => u.email === 'bob@plumbing.com').id, { disabled: true });
  r = await bob.req('GET', '/api/live/history');
  assert.equal(r.status, 401);

  // 9. Teardown
  r = await owner.req('POST', '/api/deployments/loc1aaaaaaaa/teardown', { closeSubaccount: true });
  assert.deepEqual(r.json.errors, []);
  assert.equal(Object.keys(vs.assistants).length, 0);
  assert.equal(Object.keys(vs.numbers).length, 0);
});

test('HighLevel SSO: sub-account users get the client deck, agency admins the console', async (t) => {
  const env = await setup();
  t.after(() => env.server.close());
  const c = client(env.base);
  await c.req('GET', '/oauth/callback?code=abc');
  await env.ctx.store.put('deployments', { _id: 'loc1aaaaaaaa', companyId: 'comp1', status: 'live', name: 'Bob' });

  let r = await c.req('POST', '/api/auth/sso', { payload: 'garbage' });
  assert.equal(r.status, 401);
  r = await c.req('POST', '/api/auth/sso', { payload: encryptGhlSso({ userId: 'u1', companyId: 'comp1', role: 'admin', type: 'agency', email: 'a@x.com', activeLocation: 'loc1aaaaaaaa' }, 'sso-key') });
  assert.equal(r.json.redirect, '/deck');
  r = await c.req('GET', '/api/live/history?location=loc2bbbbbbbb');
  assert.equal(r.status, 403);
  r = await c.req('GET', '/api/live/history');
  assert.equal(r.status, 200);

  const a = client(env.base);
  r = await a.req('POST', '/api/auth/sso', { payload: encryptGhlSso({ userId: 'u2', companyId: 'comp1', role: 'admin', type: 'agency', email: 'b@x.com' }, 'sso-key') });
  assert.equal(r.json.redirect, '/app');
  r = await a.req('GET', '/api/agency');
  assert.equal(r.status, 200);

  r = await a.req('POST', '/api/auth/sso', { payload: encryptGhlSso({ userId: 'u3', companyId: 'other', role: 'admin', type: 'agency' }, 'sso-key') });
  assert.equal(r.status, 403);
});

test('white-label domain only serves its own agency', async (t) => {
  const env = await setup();
  t.after(() => env.server.close());
  const c = client(env.base);
  await c.req('GET', '/oauth/callback?code=abc');
  await env.ctx.store.put('users', { _id: 'u_x', email: 'o@a.com', companyId: 'comp1', kind: 'agency', role: 'owner', passwordHash: await require('../server/security').hashPassword('ownerpass12') });
  await c.req('POST', '/api/auth/login', { email: 'o@a.com', password: 'ownerpass12' });
  let r = await c.req('PUT', '/api/agency/branding', { name: 'Acme Voice', primary: '#ff0000', domain: 'calls.acme.com', logoUrl: 'javascript:alert(1)' });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.branding.logoUrl, '');
  r = await c.req('POST', '/api/agency/domain/verify', {});
  assert.equal(r.json.verified, false);
  // Simulate the CNAME being in place.
  await env.ctx.store.patch('domains', 'calls.acme.com', { verified: true });

  r = await rawRequest(env.base, 'GET', '/login', { host: 'calls.acme.com' });
  const html = r.body;
  assert.match(html, /Acme Voice/);
  assert.match(html, /--brand:#ff0000/);
  // Another agency's user cannot sign in on this domain.
  await env.ctx.store.put('agencies', { _id: 'comp2', installed: true, status: 'active' });
  await env.ctx.store.put('users', { _id: 'u_y', email: 'z@b.com', companyId: 'comp2', kind: 'agency', role: 'owner', passwordHash: await require('../server/security').hashPassword('otherpass12') });
  r = await rawRequest(env.base, 'POST', '/api/auth/login', { host: 'calls.acme.com', 'Content-Type': 'application/json', 'X-ACC': '1' }, JSON.stringify({ email: 'z@b.com', password: 'otherpass12' }));
  assert.equal(r.status, 401);
  r = await rawRequest(env.base, 'POST', '/api/auth/login', { host: 'calls.acme.com', 'Content-Type': 'application/json', 'X-ACC': '1' }, JSON.stringify({ email: 'o@a.com', password: 'ownerpass12' }));
  assert.equal(r.status, 200);
});

test('cron sweep requires the secret and retries queued syncs', async (t) => {
  const env = await setup();
  t.after(() => env.server.close());
  let r = await fetch(env.base + '/api/cron/sweep');
  assert.equal(r.status, 401);
  r = await fetch(env.base + '/api/cron/sweep', { headers: { authorization: 'Bearer cron' } });
  assert.deepEqual(await r.json(), { stale: 0, synced: 0, leads: 0, webhooks: 0 });
});
