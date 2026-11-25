'use strict';
/* Local demo with simulated Twilio / Vapi / CRM / OpenAI.
   No real accounts or credit needed: it installs a demo company, deploys a
   client, and plays a scripted live call every 45 seconds so you can try the
   Command Deck (transcript, whisper, takeover buttons, QA grading).

     npm run demo   ->  http://localhost:3000/login   demo@example.com / demo-password */
const path = require('path');
const os = require('os');
const fs = require('fs');
const config = require('../server/config');
const { createApp } = require('../server/app');
const { createFakes } = require('../test/fakes');
const { hashPassword } = require('../server/security');

const port = Number(process.env.PORT || 3000);
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'acc-demo-'));
const cfg = config.load({
  SESSION_SECRET: 'demo-session-secret-'.repeat(3), ENCRYPTION_KEY: 'demo-encryption-key-'.repeat(3), ADMIN_PASSWORD: 'demo-admin-password',
  GHL_CLIENT_ID: 'demo-app', GHL_CLIENT_SECRET: 'demo', DATA_DIR: dir, BASE_URL: 'http://localhost:' + port, PORT: String(port),
  BRAND_NAME: process.env.BRAND_NAME || 'AI Call Center'
});
const fakes = createFakes();
const app = createApp(cfg, { fetch: fakes.fetch });
const ctx = app.locals.ctx;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function seed() {
  const { store, sec } = ctx;
  await store.put('agencies', {
    _id: 'comp1', name: 'Acme Growth Company', installed: true, status: 'active', createdAt: new Date().toISOString(),
    ghl: { accessToken: sec.encrypt('agency-at'), refreshToken: sec.encrypt('agency-rt'), expiresAt: Date.now() + 86e6 },
    keys: { twilioSid: 'ACmain', twilioToken: sec.encrypt('goodtoken'), vapiKey: sec.encrypt('vapi-good'), openaiKey: sec.encrypt('sk-good') },
    keyStatus: { twilio: { ok: true, detail: 'Demo account' }, vapi: { ok: true, detail: 'Connected' }, openai: { ok: true, detail: 'Connected' } },
    setup: {}, branding: { name: 'Acme Voice', primary: '#6d5efc', accent: '#14b8a6' }
  });
  await store.put('users', { _id: 'u_demo', email: 'demo@example.com', name: 'Demo Owner', companyId: 'comp1', kind: 'agency', role: 'owner', passwordHash: await hashPassword('demo-password'), sessionVersion: 0, createdAt: new Date().toISOString() });
  const agency = await store.get('agencies', 'comp1');
  await ctx.provisioner.createDeployment(agency, {
    locationId: 'loc1aaaaaaaa', name: 'Bob\'s Plumbing',
    agent: { businessName: 'Bob\'s Plumbing', industry: 'plumbing', services: 'Water heaters\nDrain cleaning\nLeak repair', calendarId: 'cal1', timezone: 'America/Chicago', transferNumber: '+15125550000', avgJobValue: 450 },
    outbound: { consent: true, enabled: true, days: ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'], start: '00:00', end: '23:59' },
    followUp: { enabled: true },
    pipeline: { pipelineId: 'pipe1', stages: { appointment_booked: 'st_booked', qualified_lead: 'st_new' } },
    options: { areaCode: '512' }
  });
  await ctx.provisioner.deploy(await store.get('agencies', 'comp1'), 'loc1aaaaaaaa');
}

const SCRIPT = [
  ['assistant', 'Receptionist', 'Thanks for calling Bob\'s Plumbing, this is the virtual assistant. Who do I have the pleasure of speaking with?'],
  ['user', null, 'Hi, this is Jane. My water heater is leaking and I need someone to take a look.'],
  ['assistant', 'Receptionist', 'Sorry to hear that, Jane. Let me get you to our scheduling team.'],
  ['assistant', 'Sales', 'Hi Jane, I can get a technician out. What is the address?'],
  ['user', null, '1200 Oak Street, Austin. And if this goes like last time I want a refund.'],
  ['assistant', 'Sales', 'Thanks. I have Tuesday at 9 AM or 10 AM open. Which works better?'],
  ['user', null, 'Nine works.'],
  ['assistant', 'Sales', 'You are booked for Tuesday at 9 AM. You will get a confirmation text shortly. Anything else?'],
  ['user', null, 'No, that is all. Thanks!']
];

async function playCall(n) {
  const dep = await ctx.store.get('deployments', 'loc1aaaaaaaa');
  const secret = ctx.sec.decrypt(dep.serverSecret);
  const id = 'demo_call_' + n + '_' + Date.now();
  const call = { id, type: 'inboundPhoneCall', customer: { number: '+1512555' + String(1000 + (n % 9000)).padStart(4, '0') }, monitor: { listenUrl: 'wss://listen.vapi.test/' + id, controlUrl: 'https://control.vapi.test/' + id } };
  const send = (message) => fetch(cfg.baseUrl + '/webhooks/vapi/loc1aaaaaaaa', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-vapi-secret': secret }, body: JSON.stringify({ message: Object.assign({ call }, message) }) }).catch(() => {});
  await send({ type: 'status-update', status: 'in-progress' });
  for (const [role, agent, text] of SCRIPT) {
    const words = text.split(' ');
    for (let i = 3; i < words.length; i += 4) { await send({ type: 'transcript', role, transcriptType: 'partial', transcript: words.slice(0, i).join(' '), assistant: agent ? { name: 'Bob\'s Plumbing - ' + agent } : undefined }); await sleep(350); }
    await send({ type: 'transcript', role, transcriptType: 'final', transcript: text, assistant: agent ? { name: 'Bob\'s Plumbing - ' + agent } : undefined });
    await sleep(1800);
  }
  await send({ type: 'end-of-call-report', endedReason: 'customer-ended-call', durationSeconds: 70, artifact: { transcript: SCRIPT.map(([r, , t]) => (r === 'user' ? 'User: ' : 'AI: ') + t).join('\n') } });
}

(async () => {
  await seed();
  app.listen(port, () => {
    console.log('\nDemo running (simulated providers, nothing is billed)');
    console.log('  Company console: http://localhost:' + port + '/login   demo@example.com / demo-password');
    console.log('  Super admin:    http://localhost:' + port + '/admin/login   demo-admin-password\n');
  });
  let n = 0;
  const loop = async () => { n++; await playCall(n).catch((e) => console.error(e)); };
  setTimeout(loop, 3000);
  setInterval(loop, 45000);
})();
