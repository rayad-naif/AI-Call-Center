'use strict';
const { h } = require('./util');
const views = require('../views/pages');

module.exports = function (app, ctx) {
  const { cfg, branding } = ctx;

  // Signed-in pages on the main host use the agency's own branding.
  async function brandFor(req) {
    if (!req.brandCompanyId && req.session) req.brand = await branding.forCompany(req.session.companyId);
  }

  app.get('/', h(async (req, res) => {
    if (req.session && req.brandCompanyId) return res.redirect('/deck');
    res.type('html').send(views.landing(req, cfg));
  }));
  app.get('/docs', (req, res) => res.type('html').send(views.docs(req, cfg)));
  app.get('/privacy', (req, res) => res.type('html').send(views.legal(req, cfg, 'privacy')));
  app.get('/terms', (req, res) => res.type('html').send(views.legal(req, cfg, 'terms')));

  app.get('/app', h(async (req, res) => {
    const s = req.session;
    if (!s) return res.redirect('/login');
    if (s.kind !== 'agency' || !ctx.auth.can(s, 'admin')) return res.redirect('/deck');
    await brandFor(req);
    res.type('html').send(views.consolePage(req));
  }));

  app.get('/deck', h(async (req, res) => {
    const s = req.session;
    if (!s) return res.redirect('/login?deck=1');
    await brandFor(req);
    res.type('html').send(views.deck(req, { agency: s.kind === 'agency' && ctx.auth.can(s, 'admin'), location: String(req.query.location || '') }));
  }));
};
