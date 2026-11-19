'use strict';
const path = require('path');
const express = require('express');

const { createStore } = require('./store');
const { createSecurity, rateLimiter, safeEqual } = require('./security');
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
  /* The sweep places queued speed-to-lead calls, retries failed CRM syncs and
     closes stuck calls. It runs from three places, so it works on Vercel's free
     plan (one cron a day):
       1. normal traffic: Vapi webhooks, lead webhooks and open Command Decks
          start it in the background, at most once per SWEEP_INTERVAL_SEC;
       2. the daily Vercel cron (vercel.json);
       3. an optional external pinger (GitHub Actions, cron-job.org) calling
          /api/cron/sweep with the CRON_SECRET, for exact timing overnight. */
  // One sweep serves every agency and sub-account. It works in batches until
  // the backlog is empty or ~40s have passed (the function limit is 60s), so a
  // single daily cron can clear a whole night of leads across all clients.
  app.locals.sweep = async (source) => {
    const deadline = Date.now() + (cfg.sweepBudgetMs || 40e3);
    const stale = await ctx.calls.sweepStale();
    let leads = 0, synced = 0, n;
    do { n = await ctx.automation.processDueLeads(25); leads += n; } while (n === 25 && Date.now() < deadline);
    do { n = await ctx.qa.retryQueued(25); synced += n; } while (n >= 25 && Date.now() < deadline);
    const result = { stale, synced, leads };
    await ctx.store.put('meta', { _id: 'sweep', lastAt: new Date().toISOString(), source: source || 'manual', result });
    return result;
  };
  let lastLocalCheck = 0;
  function sweepOnTraffic() {
    const every = cfg.sweepIntervalSec * 1000;
    if (!every || Date.now() - lastLocalCheck < every) return;
    lastLocalCheck = Date.now();
    ctx.background('sweep', async () => {
      if (await ctx.store.claim('sweep', every)) await app.locals.sweep('traffic');
    });
  }

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

  // Opportunistic sweep on the busy, machine-driven routes.
  app.use((req, res, next) => {
    if (/^\/(webhooks\/vapi|hooks\/lead|api\/live\/calls$)/.test(req.path)) sweepOnTraffic();
    next();
  });

  require('./routes/webhooks')(app, ctx);
  require('./routes/oauth')(app, ctx);
  require('./routes/agency')(app, ctx);
  require('./routes/live')(app, ctx);
  require('./routes/automation')(app, ctx);
  require('./routes/admin')(app, ctx);
  require('./routes/pages')(app, ctx);

  // Vercel Cron sends GET with "Authorization: Bearer CRON_SECRET". External
  // pingers may use GET or POST, with that header or X-Cron-Secret.
  app.all('/api/cron/sweep', async (req, res, next) => {
    try {
      const given = (req.headers.authorization || '').replace(/^Bearer /, '') || req.headers['x-cron-secret'] || '';
      if (!cfg.cronSecret || !safeEqual(given, cfg.cronSecret)) return res.status(401).json({ error: 'unauthorized' });
      const src = req.headers['user-agent'] && /vercel-cron/i.test(req.headers['user-agent']) ? 'vercel-cron' : 'cron';
      res.json(await app.locals.sweep(src));
    } catch (e) { next(e); }
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
