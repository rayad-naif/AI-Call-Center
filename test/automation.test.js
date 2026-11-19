'use strict';
/* Speed-to-lead, SMS follow-up, live alerts, reports, templates, languages. */
const test = require('node:test');
const assert = require('node:assert/strict');
const { setup, client } = require('./helpers');
const auto = require('../server/services/automation');
const agents = require('../server/services/agents');

const ALL_DAY = { consent: true, enabled: true, days: ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'], start: '00:00', end: '23:59', maxAttempts: 2, retryMinutes: 15 };

async function deployed(t, overrides) {
  const env = await setup();
  t.after(() => env.server.close());
  const owner = client(env.base);
  const r1 = await owner.req('GET', '/oauth/callback?code=abc');
  await owner.req('POST', '/api/auth/setup', { t: decodeURIComponent(r1.location.split('t=')[1]), email: 'o@acme.com', password: 'longpassword1' });
  await owner.req('PUT', '/api/agency/keys', { twilioSid: 'ACmain', twilioToken: 'goodtoken', vapiKey: 'vapi-good', openaiKey: 'sk-good' });
  let r = await owner.req('PUT', '/api/deployments/loc1aaaaaaaa', Object.assign({
    name: 'Bob Plumbing',
    agent: { businessName: 'Bob Plumbing', calendarId: 'cal1', timezone: 'America/Chicago', avgJobValue: 400, language: 'es' },
    pipeline: { pipelineId: 'pipe1', stages: { appointment_booked: 'st_booked' } },
    outbound: ALL_DAY,
    followUp: { enabled: true },
    alerts: { keywords: 'refund, lawyer', minScore: 90 }
  }, overrides || {}));
  assert.equal(r.status, 200, r.text);
  r = await owner.req('POST', '/api/deployments/loc1aaaaaaaa/deploy', {});
  assert.equal(r.status, 200, r.text);
  const dep = await env.ctx.store.get('deployments', 'loc1aaaaaaaa');
  const secret = env.ctx.sec.decrypt(dep.serverSecret);
  const hook = (message) => fetch(env.base + '/webhooks/vapi/loc1aaaaaaaa', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-vapi-secret': secret }, body: JSON.stringify({ message }) }).then((x) => x.json());
  const settle = () => Promise.all(env.pending.splice(0));
  return Object.assign(env, { owner, dep, hook, settle, deployment: r.json.deployment });
}

test('speed-to-lead: webhook -> outbound call -> retry on no answer -> connected', async (t) => {
  const env = await deployed(t);
  const { owner, fakes, ctx, base } = env;
  const vs = fakes.state.vapi;

  // Outbound agent exists, Spanish language applied to every assistant.
  const outbound = Object.values(vs.assistants).find((a) => a.metadata.role === 'outbound');
  assert.ok(outbound);
  assert.deepEqual(outbound.model.tools.map((x) => (x.function ? x.function.name : x.type)), ['check_availability', 'book_appointment', 'mark_do_not_call']);
  assert.match(outbound.firstMessage, /\{\{name\}\}/);
  Object.values(vs.assistants).forEach((a) => { assert.equal(a.transcriber.language, 'es'); assert.equal(a.voice.provider, 'azure'); });

  const url = env.deployment.outbound.webhookUrl;
  assert.ok(url.startsWith(base + '/hooks/lead/loc1aaaaaaaa/'));
  const post = (u, body) => fetch(u, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then(async (x) => ({ status: x.status, json: await x.json() }));

  assert.equal((await post(base + '/hooks/lead/loc1aaaaaaaa/wrongkey', { phone: '5125557777' })).status, 404);
  assert.equal((await post(url, { first_name: 'Sam' })).status, 400, 'no phone');

  // GoHighLevel workflow "Custom Webhook" body shape.
  let r = await post(url, { contact_id: 'c1', first_name: 'Sam', full_name: 'Sam Lee', phone: '(512) 555-7777', customData: { interest: 'a roof repair' } });
  assert.equal(r.status, 202, JSON.stringify(r.json));
  await env.settle();
  assert.equal(vs.calls.length, 1);
  const c1 = vs.calls[0];
  assert.equal(c1.assistantId, outbound.id);
  assert.equal(c1.customer.number, '+15125557777');
  assert.equal(c1.assistantOverrides.variableValues.name, 'Sam');
  assert.equal(c1.assistantOverrides.variableValues.interest, 'a roof repair');
  const leadId = c1.metadata.leadId;

  // Same phone within 24h is ignored.
  r = await post(url, { phone: '+15125557777' });
  assert.equal(r.json.status, 'duplicate');
  assert.equal(vs.calls.length, 1);

  // No answer -> queued for retry.
  const call = { id: 'call_out_1', type: 'outboundPhoneCall', customer: { number: '+15125557777' }, metadata: { leadId } };
  await env.hook({ type: 'status-update', status: 'in-progress', call });
  await env.hook({ type: 'end-of-call-report', call, endedReason: 'customer-did-not-answer' });
  await env.settle();
  let lead = await ctx.store.get('leads', leadId);
  assert.equal(lead.status, 'queued');
  assert.equal(lead.attempts, 1);
  assert.ok(Date.parse(lead.nextAt) > Date.now(), 'retry is in the future');
  assert.equal((await ctx.store.get('calls', 'call_out_1')).direction, 'outbound');

  // Sweep after the retry time places attempt 2.
  await ctx.store.patch('leads', leadId, { nextAt: new Date(Date.now() - 1000).toISOString() });
  r = await fetch(base + '/api/cron/sweep', { headers: { authorization: 'Bearer cron' } }).then((x) => x.json());
  assert.equal(r.leads, 1);
  assert.equal(vs.calls.length, 2);
  const call2 = { id: 'call_out_2', type: 'outboundPhoneCall', customer: { number: '+15125557777' }, metadata: { leadId } };
  await env.hook({ type: 'transcript', role: 'user', transcriptType: 'final', transcript: 'Yes this is Sam', call: call2 });
  await env.hook({ type: 'end-of-call-report', call: call2, endedReason: 'customer-ended-call' });
  await env.settle();
  lead = await ctx.store.get('leads', leadId);
  assert.equal(lead.status, 'connected');
  assert.equal(lead.attempts, 2);

  // Do-Not-Disturb contacts are never dialed.
  fakes.state.ghl.dnd.c9 = true;
  r = await post(url, { contact_id: 'c9', phone: '+15125550009' });
  await env.settle();
  assert.equal(vs.calls.length, 2);
  assert.equal((await ctx.store.get('leads', r.json.leadId)).status, 'skipped');

  // Manager-visible lead list + test lead button.
  r = await owner.req('GET', '/api/leads');
  assert.equal(r.json.leads.length, 2);
  r = await owner.req('POST', '/api/deployments/loc1aaaaaaaa/test-lead', { phone: '+15125550123' });
  assert.equal(r.json.status, 'calling', JSON.stringify(r.json));
  assert.equal(vs.calls.length, 3);
});

test('speed-to-lead respects calling hours and needs consent', async (t) => {
  const env = await deployed(t, { outbound: { consent: false, enabled: true } });
  assert.equal(env.dep.outbound.enabled, false, 'cannot enable without consent');
  const r = await fetch(env.deployment.outbound.webhookUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ phone: '+15125557777' }) });
  assert.equal(r.status, 409);

  // Window logic: Monday 10:00 Chicago is open, Sunday is closed -> next open Monday 08:00.
  const o = auto.normalizeOutbound({ consent: true, enabled: true, days: ['mon', 'tue', 'wed', 'thu', 'fri'], start: '08:00', end: '18:00' });
  assert.equal(auto.inWindow(o, 'America/Chicago', new Date('2030-01-07T16:00:00Z')), true); // Mon 10:00 CST
  assert.equal(auto.inWindow(o, 'America/Chicago', new Date('2030-01-06T16:00:00Z')), false); // Sun
  assert.equal(new Date(auto.nextOpen(o, 'America/Chicago', Date.parse('2030-01-06T16:00:00Z'))).toISOString(), '2030-01-07T14:00:00.000Z');
  assert.equal(auto.e164('(512) 555-1234'), '+15125551234');
  assert.equal(auto.e164('+44 20 7946 0958'), '+442079460958');
  assert.equal(auto.e164('123'), '');
});

test('alerts, SMS follow-up, ROI report and CSV', async (t) => {
  const env = await deployed(t);
  const { owner, fakes, ctx } = env;
  const call = { id: 'call_in_1', type: 'inboundPhoneCall', customer: { number: '+15125551234' }, monitor: { listenUrl: 'wss://l', controlUrl: 'https://control.vapi.test/x' } };
  await env.hook({ type: 'status-update', status: 'in-progress', call });
  await env.hook({ type: 'transcript', role: 'user', transcriptType: 'final', transcript: 'This is ridiculous, I want a REFUND now!', call });
  await env.hook({ type: 'transcript', role: 'user', transcriptType: 'final', transcript: 'A refund, please.', call });
  let r = await owner.req('GET', '/api/live/calls');
  assert.equal(r.json.calls[0].alerts.length, 1, 'one alert per keyword');
  assert.match(r.json.calls[0].alerts[0].text, /^"refund"/);

  await env.hook({ type: 'tool-calls', call, toolCallList: [{ id: 't1', function: { name: 'book_appointment', arguments: { start_time: '2030-01-07T09:00:00-06:00', name: 'Jane Doe' } } }] });
  await env.hook({ type: 'end-of-call-report', call, endedReason: 'customer-ended-call', durationSeconds: 120, artifact: { transcript: 'User: I want a refund\nAI: ok' } });
  await env.settle();
  const c = await ctx.store.get('calls', 'call_in_1');
  assert.equal(c.sync.state, 'done', JSON.stringify(c.sync));
  assert.equal(c.sync.sms, 'booked');
  const sms = fakes.state.ghl.sms[0];
  assert.equal(sms.type, 'SMS');
  assert.match(sms.message, /^Hi Jane, you are confirmed with Bob Plumbing for Monday, January 7/);
  // minScore 90 > graded 88 -> QA alert added after the call.
  assert.ok(c.alerts.some((a) => a.kind === 'qa' && /Low QA score: 88/.test(a.text)));

  // Spanish "missed call" path: no caller speech -> missed template.
  const m = { id: 'call_in_2', type: 'inboundPhoneCall', customer: { number: '+15125550000' } };
  await env.hook({ type: 'end-of-call-report', call: m, endedReason: 'customer-ended-call' });
  await env.settle();
  assert.equal((await ctx.store.get('calls', 'call_in_2')).sync.sms, 'missed');

  r = await owner.req('GET', '/api/reports/summary?days=30');
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.totals.calls, 2);
  assert.equal(r.json.totals.booked, 1);
  assert.equal(r.json.totals.estRevenue, 400);
  assert.equal(r.json.daily.length, 30);
  assert.equal(r.json.hours.length, 24);

  await ctx.store.patch('calls', 'call_in_1', { 'grade.summary': '=HYPERLINK("http://evil")' });
  r = await owner.req('GET', '/api/reports/calls.csv');
  const lines = r.text.trim().split('\r\n');
  assert.match(lines[0], /^date,client,direction,caller/);
  assert.equal(lines.length, 3);
  assert.ok(r.text.includes(`"'=HYPERLINK(""http://evil"")"`), 'formula neutralized');

  r = await owner.req('GET', '/api/templates');
  assert.equal(r.json.templates.length, 8);
  r = await owner.req('GET', '/report');
  assert.equal(r.status, 200);
});

test('helpers', () => {
  assert.equal(auto.fill('Hi {first_name}, see you {appointment_time}.', { appointment_time: 'Monday' }), 'Hi there, see you Monday.');
  const a = auto.normalizeAlerts({ keywords: 'Refund,  LAWYER ,', minScore: 150 });
  assert.deepEqual(a.keywords, ['refund', 'lawyer']);
  assert.equal(a.minScore, 100);
  assert.equal(agents.normalizeAgent({ language: 'klingon' }).language, 'en');
});
