'use strict';
const path = require('path');
const express = require('express');

const { createStore } = require('./store');
const { createSecurity, rateLimiter } = require('./security');
const { createTwilio } = require('./integrations/twilio');
const { createVapi } = require('./integrations/vapi');
const { createGhl } = require('./integrations/ghl');
const { createOpenAI } = require('./integrations/openai');
const { createAgencyService } = require('./services/agency');
const { createProvisioner } = require('./services/provisioner');
const { createCallService } = require('./services/calls');
const { createQaService } = require('./services/qa');
const { createToolService } = require('./services/tools');
const { createBranding } = require('./services/branding');
const { createAutomation } = require('./services/automation');
const { createAuth } = require('./auth');

/* Run work after the response is sent. On Vercel, waitUntil keeps the
   function alive for it; elsewhere the process simply carries on. */
function backgroundRunner() {
  let waitUntil = null;
  try { waitUntil = require('@vercel/functions').waitUntil; } catch (e) { /* not on Vercel */ }
  return (label, fn) => {
    const p = Promise.resolve().then(fn).catch((e) => console.error('[bg] ' + label + ' failed: ' + e.message));
    if (waitUntil) { try { waitUntil(p); } catch (e) { /* outside a request */ } }
    return p;
  };
}

function createApp(cfg, deps) {
  deps = deps || {};
  const ctx = { cfg };
  ctx.store = deps.store || createStore(cfg);
  ctx.sec = createSecurity(cfg.sessionSecret, cfg.encryptionKey);
  ctx.twilio = createTwilio(cfg, deps.fetch);
  ctx.vapi = createVapi(cfg, deps.fetch);
  ctx.ghl = createGhl(cfg, deps.fetch);
  ctx.openai = createOpenAI(cfg, deps.fetch);
  ctx.agencySvc = createAgencyService(ctx);
  ctx.provisioner = createProvisioner(ctx);
  ctx.calls = createCallService(ctx);
  ctx.qa = createQaService(ctx);
  ctx.tools = createToolService(ctx);
  ctx.branding = createBranding(ctx, deps);
  ctx.automation = createAutomation(ctx);
  ctx.auth = createAuth(cfg, ctx);
  ctx.background = deps.background || backgroundRunner();
  ctx.limits = {
    login: rateLimiter(10, 15 * 60e3),
    api: rateLimiter(600, 60e3),
    control: rateLimiter(60, 60e3)
  };

  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', true);
  app.locals.store = ctx.store;
  app.locals.ctx = ctx;
  app.locals.sweep = async () => {
    const stale = await ctx.calls.sweepStale();
    const synced = await ctx.qa.retryQueued(25);
    const leads = await ctx.automation.processDueLeads(25);
    return { stale, synced, leads };
  };

  // Security headers. Pages must be frameable: HighLevel (and every
  // white-label CRM domain) embeds them as custom pages.
  app.use((req, res, next) => {
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.set('Permissions-Policy', 'microphone=(self), camera=()');
    next();
  });

  // Raw body for webhook signature checks, JSON/form parsing for everything else.
  app.use(express.json({ limit: '2mb', verify: (req, res, buf) => { req.rawBody = buf; } }));
  app.use(express.urlencoded({ extended: false, limit: '200kb' }));

  app.use('/static', express.static(path.join(__dirname, '..', 'public'), { maxAge: cfg.serverless ? '1h' : 0, index: false }));

  // White-label: resolve branding from the Host header, then the session.
  app.use(async (req, res, next) => {
    try {
      await ctx.branding.resolve(req);
      await ctx.auth.load(req);
      next();
    } catch (e) { next(e); }
  });

  require('./routes/webhooks')(app, ctx);
  require('./routes/oauth')(app, ctx);
  require('./routes/agency')(app, ctx);
  require('./routes/live')(app, ctx);
  require('./routes/automation')(app, ctx);
  require('./routes/admin')(app, ctx);
  require('./routes/pages')(app, ctx);

  app.get('/api/cron/sweep', async (req, res) => {
    const auth = req.headers.authorization || '';
    if (!cfg.cronSecret || auth !== 'Bearer ' + cfg.cronSecret) return res.status(401).json({ error: 'unauthorized' });
    res.json(await app.locals.sweep());
  });

  app.get('/healthz', (req, res) => res.json({ ok: true, store: ctx.store.kind }));

  app.use((req, res) => {
    if (req.path.startsWith('/api/')) return res.status(404).json({ error: 'Not found' });
    res.status(404).type('html').send(require('./views/layout').page(req, { title: 'Not found', body: '<div class="center"><h1>Page not found</h1><p><a href="/">Go home</a></p></div>' }));
  });

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    const status = err.status && err.status >= 400 && err.status < 600 ? err.status : (err.provider ? 502 : 500);
    if (status >= 500) console.error('[error] ' + req.method + ' ' + req.path + ': ' + (err.stack || err.message));
    const message = status >= 500 && !err.provider ? 'Something went wrong. Please try again.' : err.message;
    if (req.path.startsWith('/api/') || req.path.startsWith('/webhooks/')) return res.status(status).json({ error: message, step: err.step });
    res.status(status).type('html').send(require('./views/layout').page(req, { title: 'Error', body: '<div class="center"><h1>Something went wrong</h1><p>' + require('./views/layout').esc(message) + '</p></div>' }));
  });

  return app;
}

module.exports = { createApp };
