'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const sec = require('../server/security');
const { createFileStore } = require('../server/store/file');
const agents = require('../server/services/agents');
const { normalizeBranding, normalizeHost } = require('../server/services/branding');
const { twiml, dialClient } = require('../server/integrations/twilio');

test('secrets round-trip and tamper detection', () => {
  const s = sec.createSecurity('a'.repeat(40), 'b'.repeat(40));
  const enc = s.encrypt('sk-secret');
  assert.notEqual(enc, 'sk-secret');
  assert.equal(s.decrypt(enc), 'sk-secret');
  assert.equal(s.decrypt(enc.slice(0, -2) + 'AA'), '');
  assert.equal(s.encrypt(''), '');
  const tok = s.sign({ a: 1, exp: Date.now() + 1000 });
  assert.deepEqual(s.unsign(tok).a, 1);
  assert.equal(s.unsign(tok.replace(/.$/, 'x')), null);
  assert.equal(s.unsign(s.sign({ exp: Date.now() - 1 })), null);
  // A different encryption key cannot read the data.
  assert.equal(sec.createSecurity('a'.repeat(40), 'c'.repeat(40)).decrypt(enc), '');
});

test('passwords', async () => {
  const hsh = await sec.hashPassword('correct horse');
  assert.equal(await sec.verifyPassword('correct horse', hsh), true);
  assert.equal(await sec.verifyPassword('wrong', hsh), false);
  assert.equal(await sec.verifyPassword('x', undefined), false);
});

test('Twilio access token is a valid HS256 JWT', () => {
  const t = sec.twilioAccessToken({ accountSid: 'AC1', apiKeySid: 'SK1', apiKeySecret: 'shh', identity: 'acc_x', twimlAppSid: 'AP1' });
  const [hd, pl, sig] = t.split('.');
  assert.equal(crypto.createHmac('sha256', 'shh').update(hd + '.' + pl).digest('base64url'), sig);
  const header = JSON.parse(Buffer.from(hd, 'base64url'));
  assert.equal(header.cty, 'twilio-fpa;v=1');
  const p = JSON.parse(Buffer.from(pl, 'base64url'));
  assert.equal(p.sub, 'AC1');
  assert.equal(p.grants.voice.incoming.allow, true);
  assert.equal(p.grants.voice.outgoing.application_sid, 'AP1');
});

test('Twilio signature check', () => {
  const params = { To: '+1', From: '+2' };
  const sig = sec.twilioSignature('tok', 'https://x.test/a', params);
  assert.equal(sec.verifyTwilio('tok', 'https://x.test/a', params, sig), true);
  assert.equal(sec.verifyTwilio('tok', 'https://x.test/a', { To: '+1', From: '+3' }, sig), false);
  assert.equal(sec.verifyTwilio('', 'https://x.test/a', params, sig), false);
});

test('GHL SSO payload round-trip', () => {
  const p = sec.encryptGhlSso({ userId: 'u', companyId: 'c' }, 'k');
  assert.deepEqual(sec.decryptGhlSso(p, 'k'), { userId: 'u', companyId: 'c' });
  assert.equal(sec.decryptGhlSso(p, 'other'), null);
});

test('file store: filters, push with slice, inc, nested set', async () => {
  const st = createFileStore(null);
  await st.put('calls', { _id: 'a', companyId: 'c', status: 'ended', n: 1, transcript: [], sync: { state: 'queued' } });
  await st.put('calls', { _id: 'b', companyId: 'c', status: 'in-progress', n: 5, transcript: [] });
  assert.equal((await st.find('calls', { status: { $in: ['in-progress'] } })).length, 1);
  assert.equal((await st.find('calls', { n: { $gte: 2 } }))[0]._id, 'b');
  assert.equal((await st.find('calls', { 'sync.state': 'queued' }))[0]._id, 'a');
  for (let i = 0; i < 5; i++) await st.patch('calls', 'a', {}, { push: { transcript: { each: [i], slice: -3 } }, inc: { seq: 1 } });
  const a = await st.get('calls', 'a');
  assert.deepEqual(a.transcript, [2, 3, 4]);
  assert.equal(a.seq, 5);
  await st.patch('calls', 'a', { 'sync.state': 'done' });
  assert.equal((await st.get('calls', 'a')).sync.state, 'done');
  assert.equal(await st.patch('calls', 'zzz', { x: 1 }), null);
  assert.equal((await st.find('calls', {}, { sort: { n: -1 }, limit: 1 }))[0]._id, 'b');
});

test('agent settings are normalized and prompts are built', () => {
  const a = agents.normalizeAgent({ businessName: 'Bob Plumbing', voiceId: 'NotAVoice', transferNumber: '555', appointmentMinutes: 5, faq: 'Q: hours? A: 8-5' });
  assert.equal(a.voiceId, 'Elliot');
  assert.equal(a.transferNumber, '');
  assert.equal(a.appointmentMinutes, 15);
  assert.match(agents.systemPrompt('support', a), /Q: hours\? A: 8-5/);
  assert.match(agents.systemPrompt('receptionist', a), /Bob Plumbing/);
  const long = agents.normalizeAgent({ businessName: 'An Extremely Long Business Name For Plumbing And Heating LLC' });
  agents.ROLES.forEach((r) => assert.ok(agents.memberName(r, long).length <= 40));
  // No transfer number: no transferCall tool.
  const tools = agents.toolsFor('sales', a, { url: 'x' });
  assert.ok(!tools.some((t) => t.type === 'transferCall'));
});

test('branding input is sanitized', () => {
  const b = normalizeBranding({ name: 'X', logoUrl: 'http://insecure/logo.png', primary: 'red', accent: '#00ff00' });
  assert.equal(b.logoUrl, '');
  assert.equal(b.primary, '#6d5efc');
  assert.equal(b.accent, '#00ff00');
  assert.equal(normalizeHost('https://Calls.Agency.com/path'), 'calls.agency.com');
  assert.equal(normalizeHost('not a host'), '');
});

test('TwiML escapes identities', () => {
  assert.equal(twiml(dialClient('a<b')), '<?xml version="1.0" encoding="UTF-8"?><Response><Dial answerOnBridge="true" timeout="25"><Client>a&lt;b</Client></Dial></Response>');
});
