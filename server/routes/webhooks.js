'use strict';
/* Inbound webhooks: Vapi (call events + tool calls), Twilio (takeover line,
   browser outbound) and HighLevel (install / uninstall). */
const { h } = require('./util');
const { safeEqual, verifyTwilio } = require('../security');
const { twiml, say, dialClient, dialNumber } = require('../integrations/twilio');

module.exports = function (app, ctx) {
  const { store, sec, cfg } = ctx;

  /* ---------- Vapi ---------- */
  app.post('/webhooks/vapi/:locationId', h(async (req, res) => {
    const dep = await store.get('deployments', req.params.locationId);
    const secret = dep && sec.decrypt(dep.serverSecret);
    const got = req.headers['x-vapi-secret'] || '';
    if (!dep || !secret || !safeEqual(got, secret)) return res.status(401).json({ error: 'bad secret' });
    const msg = (req.body && req.body.message) || {};

    if (msg.type === 'tool-calls') {
      await ctx.calls.ingest(dep, msg).catch(() => null);
      return res.json(await ctx.tools.handle(dep, msg));
    }
    const r = await ctx.calls.ingest(dep, msg);
    res.json({ ok: true });
    if (r && r.ended) {
      ctx.background('qa ' + r.callId, async () => {
        const c = await store.get('calls', r.callId);
        if (c && c.leadId) await ctx.automation.leadCallEnded(c);
        await ctx.qa.processCall(r.callId);
      });
    }
  }));

  /* ---------- Twilio: takeover line (Vapi transfers the caller here) ---------- */
  async function agencyForTwilio(req, field) {
    const p = req.body || {};
    const agencies = await store.find('agencies', { ['setup.' + field]: field === 'takeoverNumber' ? p.To : p.ApplicationSid }, { limit: 1 });
    const agency = agencies[0];
    if (!agency) return null;
    const k = ctx.agencySvc.keys(agency);
    const url = cfg.baseUrl + req.originalUrl;
    if (!verifyTwilio(k.twilioToken, url, p, req.headers['x-twilio-signature'])) return null;
    return agency;
  }

  app.post('/twilio/voice/takeover', h(async (req, res) => {
    res.type('text/xml');
    const agency = await agencyForTwilio(req, 'takeoverNumber');
    if (!agency) return res.status(403).send(twiml(say('This line is not configured.') + '<Hangup/>'));
    const tk = await ctx.calls.claimTakeover(agency._id, req.body.From || '');
    if (tk) {
      await store.log(agency._id, 'takeover.bridged', tk.userName, { callId: tk.callId, locationId: tk.locationId });
      return res.send(twiml(dialClient(tk.identity, { timeout: 30, action: cfg.baseUrl + '/twilio/voice/takeover-done' })));
    }
    const dep = await store.find('deployments', { companyId: agency._id, status: 'live' }, { limit: 1 });
    const fallback = dep[0] && dep[0].agent && dep[0].agent.transferNumber;
    if (fallback) return res.send(twiml(dialNumber(fallback, { callerId: req.body.To })));
    res.send(twiml(say('Sorry, nobody is available right now. We will call you back shortly.') + '<Hangup/>'));
  }));

  // After the <Dial> to the browser ends: if nobody answered, apologise.
  app.post('/twilio/voice/takeover-done', h(async (req, res) => {
    res.type('text/xml');
    const agency = await agencyForTwilio(req, 'takeoverNumber');
    if (!agency) return res.send(twiml('<Hangup/>'));
    const st = req.body.DialCallStatus;
    if (st === 'completed') return res.send(twiml('<Hangup/>'));
    res.send(twiml(say('Sorry, our team member could not join. We will call you back shortly.') + '<Hangup/>'));
  }));

  // Browser "call back" from the Command Deck (TwiML app voice URL).
  app.post('/twilio/voice/outbound', h(async (req, res) => {
    res.type('text/xml');
    const agency = await agencyForTwilio(req, 'twimlAppSid');
    if (!agency || !/^client:acc_[a-f0-9]{24}$/.test(req.body.From || '')) return res.status(403).send(twiml(say('Not allowed.') + '<Hangup/>'));
    const to = String(req.body.To || '').replace(/[^\d+]/g, '');
    if (!/^\+\d{8,15}$/.test(to)) return res.send(twiml(say('That number is not valid.') + '<Hangup/>'));
    await store.log(agency._id, 'call.browser_outbound', to);
    res.send(twiml(dialNumber(to, { callerId: agency.setup.takeoverNumber })));
  }));

  /* ---------- HighLevel marketplace lifecycle ---------- */
  app.post('/webhooks/ghl', h(async (req, res) => {
    const verified = ctx.ghl.verifyWebhook(req.rawBody || Buffer.from(''), req.headers);
    if (verified === false) return res.status(401).json({ error: 'bad signature' });
    const b = req.body || {};
    const companyId = b.companyId;
    if (!companyId || !/^(INSTALL|UNINSTALL)$/.test(b.type || '')) return res.json({ ignored: true });
    if (b.appId && cfg.ghl.clientId && !cfg.ghl.clientId.startsWith(b.appId)) return res.json({ ignored: true });
    // Location-level events (a sub-account toggling the app) do not change the agency license.
    if (b.locationId && b.installType !== 'Company') return res.json({ ignored: true });
    const agency = await store.get('agencies', companyId);
    if (!agency) return res.json({ ok: true });

    if (b.type === 'UNINSTALL') {
      // Without signature keys, double-check by trying the refresh token.
      if (verified === null) {
        const stillValid = await ctx.agencySvc.agencyToken(agency).then(() => true, () => false);
        if (stillValid) return res.json({ ok: true, ignored: 'token still valid' });
      }
      await store.patch('agencies', companyId, { installed: false, uninstalledAt: new Date().toISOString() });
      await store.log(companyId, 'app.uninstalled', '');
    } else {
      await store.patch('agencies', companyId, { installed: true });
      await store.log(companyId, 'app.installed', 'webhook');
    }
    res.json({ ok: true });
  }));
};
