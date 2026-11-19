'use strict';
/* Speed-to-lead webhook, leads, templates, ROI reports and CSV export. */
const { h, csrf, requireSession, withAgency, httpError } = require('./util');
const { safeEqual } = require('../security');
const { createReports } = require('../services/reports');
const { TEMPLATES } = require('../services/templates');
const views = require('../views/pages');

module.exports = function (app, ctx) {
  const { store, auth, automation } = ctx;
  const reports = createReports(ctx);
  ctx.reports = reports;
  const viewer = [csrf, requireSession(ctx, 'viewer'), withAgency(ctx)];
  const manager = [csrf, requireSession(ctx, 'manager'), withAgency(ctx)];
  const admin = [csrf, requireSession(ctx, 'admin', { agencyOnly: true }), withAgency(ctx)];

  function scopeOf(req) {
    const s = auth.scope(req.session, req.query.location || undefined);
    if (!s) throw httpError(403, 'You do not have access to that account');
    return s;
  }

  /* ---------- speed-to-lead: HighLevel workflow -> Custom Webhook ---------- */
  app.post('/hooks/lead/:locationId/:key', h(async (req, res) => {
    if (!ctx.limits.api('lead:' + req.params.locationId)) return res.status(429).json({ error: 'Too many leads' });
    const dep = await store.get('deployments', req.params.locationId);
    const key = dep && dep.outbound && dep.outbound.key;
    if (!dep || !key || !safeEqual(req.params.key, key)) return res.status(404).json({ error: 'Unknown webhook' });
    const agency = await store.get('agencies', dep.companyId);
    if (!agency || !agency.installed || agency.status !== 'active' || dep.status !== 'live') return res.status(409).json({ error: 'This call center is not live' });
    const r = await automation.receiveLead(dep, req.body);
    if (r.error) return res.status(r.status).json({ error: r.error });
    res.status(r.duplicate ? 200 : 202).json({ ok: true, leadId: r.lead._id, status: r.duplicate ? 'duplicate' : r.lead.status, callAt: r.lead.nextAt });
    if (r.callNow) ctx.background('lead ' + r.lead._id, () => automation.placeCall(r.lead._id));
  }));

  app.get('/api/leads', ...manager, h(async (req, res) => {
    const s = scopeOf(req);
    const f = { companyId: s.companyId };
    if (s.locationId) f.locationId = s.locationId; else if (s.locationIds) f.locationId = { $in: s.locationIds };
    const leads = await store.find('leads', f, { sort: { createdAt: -1 }, limit: 100 });
    res.json({ leads: leads.map((l) => ({ id: l._id, locationId: l.locationId, name: l.name, phone: l.phone, interest: l.interest, status: l.status, attempts: l.attempts, reason: l.reason || '', createdAt: l.createdAt, nextAt: l.nextAt, lastCallAt: l.lastCallAt || '' })) });
  }));

  // Fire a test lead at a number (the agency's own phone) to hear the outbound agent.
  app.post('/api/deployments/:id/test-lead', ...admin, h(async (req, res) => {
    const dep = await store.get('deployments', req.params.id);
    if (!dep || dep.companyId !== req.agency._id) throw httpError(404, 'Not found');
    if (dep.status !== 'live') throw httpError(400, 'Deploy this client first');
    const r = await automation.receiveLead(dep, { phone: req.body.phone, first_name: req.body.name || 'Test', customData: { interest: req.body.interest || 'a quote' } });
    if (r.error) throw httpError(r.status, r.error);
    if (r.duplicate) throw httpError(409, 'This number already had a lead in the last 24 hours');
    if (r.callNow) await automation.placeCall(r.lead._id);
    const lead = await store.get('leads', r.lead._id);
    res.json({ ok: true, status: lead.status, reason: lead.reason || '', callAt: lead.nextAt });
  }));

  /* ---------- templates ---------- */
  app.get('/api/templates', ...admin, (req, res) => res.json({ templates: TEMPLATES }));

  /* ---------- reports ---------- */
  app.get('/api/reports/summary', ...viewer, h(async (req, res) => {
    res.json(await reports.summary(scopeOf(req), { days: req.query.days }));
  }));

  app.get('/api/reports/calls.csv', ...viewer, h(async (req, res) => {
    const body = await reports.csv(scopeOf(req), { days: req.query.days });
    res.set('Content-Type', 'text/csv; charset=utf-8');
    res.set('Content-Disposition', 'attachment; filename="calls-' + new Date().toISOString().slice(0, 10) + '.csv"');
    res.send(body);
  }));

  app.get('/report', h(async (req, res) => {
    if (!req.session) return res.redirect('/login');
    if (!req.brandCompanyId) req.brand = await ctx.branding.forCompany(req.session.companyId);
    res.type('html').send(views.report(req, { location: String(req.query.location || ''), days: Number(req.query.days) || 30, agency: req.session.kind === 'agency' }));
  }));
};
