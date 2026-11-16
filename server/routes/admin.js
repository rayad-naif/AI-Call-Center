'use strict';
/* Super Admin (you, the app owner): every agency license at a glance. */
const { h, csrf } = require('./util');
const { safeEqual } = require('../security');
const views = require('../views/pages');

module.exports = function (app, ctx) {
  const { store, cfg, auth } = ctx;
  const guard = (req, res, next) => (req.isAdmin ? next() : res.status(401).json({ error: 'Admin sign-in required' }));

  app.get('/admin/login', (req, res) => res.type('html').send(views.adminLogin(req)));
  app.post('/api/admin/login', csrf, (req, res) => {
    if (!ctx.limits.login('admin:' + req.ip)) return res.status(429).json({ error: 'Too many attempts' });
    if (!safeEqual(String(req.body.password || ''), cfg.adminPassword)) return res.status(401).json({ error: 'Wrong password' });
    auth.setAdmin(res);
    res.json({ ok: true, redirect: '/admin' });
  });
  app.post('/api/admin/logout', csrf, (req, res) => { auth.clearAdmin(res); res.json({ ok: true, redirect: '/admin/login' }); });

  app.get('/admin', (req, res) => (req.isAdmin ? res.type('html').send(views.admin(req)) : res.redirect('/admin/login')));

  app.get('/api/admin/agencies', guard, h(async (req, res) => {
    const agencies = await store.find('agencies', {}, { sort: { createdAt: -1 } });
    const deps = await store.find('deployments', {});
    const count = {};
    deps.forEach((d) => { if (d.status === 'live') count[d.companyId] = (count[d.companyId] || 0) + 1; });
    res.json({
      agencies: agencies.map((a) => ({
        id: a._id, name: a.name, status: a.status, installed: !!a.installed, installedAt: a.installedAt,
        live: count[a._id] || 0, keys: Object.keys(a.keyStatus || {}).filter((k) => a.keyStatus[k].ok),
        domain: (a.branding && a.branding.domain) || ''
      }))
    });
  }));

  app.post('/api/admin/agencies/:id/status', csrf, guard, h(async (req, res) => {
    const status = ['active', 'pending', 'suspended'].includes(req.body.status) ? req.body.status : null;
    if (!status) return res.status(400).json({ error: 'Bad status' });
    const a = await store.patch('agencies', req.params.id, { status });
    if (!a) return res.status(404).json({ error: 'Not found' });
    await store.log(a._id, 'license.' + status, 'by super admin');
    res.json({ ok: true });
  }));

  app.get('/api/admin/events', guard, h(async (req, res) => res.json({ events: await store.events({}, 200) })));
};
