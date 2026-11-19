'use strict';
const config = require('./config');
const { createApp } = require('./app');

const cfg = config.load();
const problems = config.validate(cfg);
if (problems.length) {
  console.error('Configuration problems:\n - ' + problems.join('\n - ') + '\nSee .env.example');
  process.exit(1);
}

const app = createApp(cfg);
const server = app.listen(cfg.port, () => {
  console.log('AI Call Center listening on :' + cfg.port);
  console.log('OAuth redirect URL:      ' + cfg.redirectUri);
  console.log('HighLevel webhook URL:   ' + cfg.baseUrl + '/webhooks/ghl');
  console.log('Custom page (SSO) URL:   ' + cfg.baseUrl + '/embed');
});

// Long-running servers (Railway, Render, a VPS) sweep themselves every minute.
setInterval(() => { app.locals.sweep('timer').catch((e) => console.error('sweep failed', e)); }, 60e3).unref();

function shutdown() {
  server.close(() => Promise.resolve(app.locals.store.close()).finally(() => process.exit(0)));
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
