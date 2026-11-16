'use strict';
/* Command Deck API: live grid, transcripts, listen URL, human controls,
   Twilio Voice SDK token for browser takeover. */
const { h, csrf, requireSession, withAgency, httpError } = require('./util');
const { twilioAccessToken } = require('../security');

module.exports = function (app, ctx) {
  const { calls, auth, store, sec, agencySvc } = ctx;
  const viewer = [csrf, requireSession(ctx, 'viewer'), withAgency(ctx)];
  const manager = [csrf, requireSession(ctx, 'manager'), withAgency(ctx)];

  function scopeOf(req) {
    const loc = req.query.location || (req.body && req.body.location) || '';
    const s = auth.scope(req.session, loc || undefined);
    if (!s) throw httpError(403, 'You do not have access to that sub-account');
    return s;
  }

  // Rate limit live polling per user (generous: several tabs at 1.5s).
  function polled(req, res, next) {
    if (!ctx.limits.api('u:' + req.session.uid)) return res.status(429).json({ error: 'Slow down' });
    next();
  }

  app.get('/api/live/calls', ...viewer, polled, h(async (req, res) => {
    const scope = scopeOf(req);
    res.json({ calls: await calls.active(scope), at: new Date().toISOString() });
  }));

  app.get('/api/live/history', ...viewer, h(async (req, res) => {
    const scope = scopeOf(req);
    res.json({ calls: await calls.recent(scope, { before: req.query.before, limit: Number(req.query.limit) || 30 }) });
  }));

  app.get('/api/live/stats', ...viewer, h(async (req, res) => {
    const scope = scopeOf(req);
    const since = new Date(Date.now() - 7 * 86400e3).toISOString();
    const f = { companyId: scope.companyId, createdAt: { $gte: since } };
    if (scope.locationId) f.locationId = scope.locationId; else if (scope.locationIds) f.locationId = { $in: scope.locationIds };
    const docs = await store.find('calls', f, { limit: 5000 });
    const graded = docs.filter((c) => c.grade);
    const outcomes = {};
    graded.forEach((c) => { outcomes[c.grade.outcome] = (outcomes[c.grade.outcome] || 0) + 1; });
    res.json({
      calls7d: docs.length,
      minutes7d: Math.round(docs.reduce((n, c) => n + (c.durationSec || 0), 0) / 60),
      avgScore: graded.length ? Math.round(graded.reduce((n, c) => n + c.grade.score, 0) / graded.length) : null,
      booked7d: docs.filter((c) => c.booked || (c.grade && c.grade.outcome === 'appointment_booked')).length,
      cost7d: Math.round(docs.reduce((n, c) => n + (c.cost || 0), 0) * 100) / 100,
      outcomes
    });
  }));

  app.get('/api/live/calls/:id', ...viewer, polled, h(async (req, res) => {
    const d = await calls.detail(scopeOf(req), req.params.id, req.query.after);
    if (!d) throw httpError(404, 'Call not found');
    res.json(d);
  }));

  // The listen URL is a bearer credential for the audio: managers only, fetched on demand.
  app.post('/api/live/calls/:id/listen', ...manager, h(async (req, res) => {
    const url = await calls.listenUrl(scopeOf(req), req.params.id);
    if (url === null) throw httpError(404, 'Call not found');
    if (!url) throw httpError(409, 'Live audio is not available for this call');
    await store.log(req.session.companyId, 'call.listen', req.session.name || req.session.email || '', { callId: req.params.id });
    res.json({ url });
  }));

  app.post('/api/live/calls/:id/takeover', ...manager, h(async (req, res) => {
    if (!ctx.limits.control('u:' + req.session.uid)) throw httpError(429, 'Slow down');
    const r = await calls.takeover(scopeOf(req), req.params.id, req.agency, req.session, auth.voiceIdentity(req.session));
    res.json(r);
  }));

  app.post('/api/live/calls/:id/:action(whisper|say|mute|unmute|end|transfer)', ...manager, h(async (req, res) => {
    if (!ctx.limits.control('u:' + req.session.uid)) throw httpError(429, 'Slow down');
    res.json(await calls.act(scopeOf(req), req.params.id, req.params.action, req.body, req.session));
  }));

  // Re-run QA + CRM sync for an ended call.
  app.post('/api/live/calls/:id/resync', ...manager, h(async (req, res) => {
    const c = await calls.get(scopeOf(req), req.params.id);
    if (!c) throw httpError(404, 'Call not found');
    await store.patch('calls', c._id, { 'sync.state': 'queued', 'sync.attempts': 0, grade: req.body.regrade ? null : c.grade });
    res.json(await ctx.qa.processCall(c._id));
  }));

  // Twilio Voice SDK token so this browser can receive the takeover leg.
  app.get('/api/live/voice-token', ...manager, h(async (req, res) => {
    const a = req.agency;
    const st = a.setup || {};
    if (!st.apiKeySid || !st.twimlAppSid) return res.json({ enabled: false, reason: 'Browser takeover is set up during the first deployment.' });
    const k = agencySvc.keys(a);
    const identity = auth.voiceIdentity(req.session);
    const token = twilioAccessToken({ accountSid: k.twilioSid, apiKeySid: st.apiKeySid, apiKeySecret: sec.decrypt(st.apiKeySecret), identity, twimlAppSid: st.twimlAppSid, ttl: 3600 });
    res.json({ enabled: true, token, identity, ttl: 3600 });
  }));
};
