'use strict';
const { h } = require('./util');
const views = require('../views/pages');

module.exports = function (app, ctx) {
  const { cfg, branding } = ctx;

  // Signed-in pages on the main host use the company's own branding.
  async function brandFor(req) {
    if (!req.brandCompanyId && req.session) req.brand = await branding.forCompany(req.session.companyId);
  }

  // Signed-in users never land on the vendor's marketing page.
  app.get('/', h(async (req, res) => {
    if (req.session) return res.redirect(req.session.kind === 'agency' && ctx.auth.can(req.session, 'admin') ? '/app' : '/deck');
    res.type('html').send(views.landing(req, cfg));
  }));
  // The vendor's docs and legal pages describe the platform underneath, so a
  // white-label portal domain never serves them.
  const vendorOnly = (fn) => (req, res) => (req.brandCompanyId ? res.redirect('/login') : fn(req, res));
  app.get('/docs', vendorOnly((req, res) => res.type('html').send(views.docs(req, cfg))));
  app.get('/privacy', vendorOnly((req, res) => res.type('html').send(views.legal(req, cfg, 'privacy'))));
  app.get('/terms', vendorOnly((req, res) => res.type('html').send(views.legal(req, cfg, 'terms'))));

  app.get('/app', h(async (req, res) => {
    const s = req.session;
    if (!s) return res.redirect('/login');
    if (s.kind !== 'agency' || !ctx.auth.can(s, 'admin')) return res.redirect('/deck');
    await brandFor(req);
    res.type('html').send(views.consolePage(req));
  }));

  app.get('/developer', h(async (req, res) => {
    const s = req.session;
    if (!s) return res.redirect('/login');
    await brandFor(req);
    res.type('html').send(views.developer(req, { agency: s.kind === 'agency' && ctx.auth.can(s, 'admin') }));
  }));

  app.get('/deck', h(async (req, res) => {
    const s = req.session;
    if (!s) return res.redirect('/login?deck=1');
    await brandFor(req);
    res.type('html').send(views.deck(req, { agency: s.kind === 'agency' && ctx.auth.can(s, 'admin'), location: String(req.query.location || '') }));
  }));
};
