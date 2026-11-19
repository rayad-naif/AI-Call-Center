'use strict';
/* Shared test helpers: app with faked providers + a cookie-keeping client. */
const os = require('os');
const path = require('path');
const fs = require('fs');
const config = require('../server/config');
const { createApp } = require('../server/app');
const { createFakes } = require('./fakes');

function setup(extraEnv) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'acc-'));
  const cfg = config.load(Object.assign({
    SESSION_SECRET: 's'.repeat(40), ENCRYPTION_KEY: 'e'.repeat(40), ADMIN_PASSWORD: 'admin-password-1',
    GHL_CLIENT_ID: 'app1-abc', GHL_CLIENT_SECRET: 'secret', GHL_SSO_KEY: 'sso-key', DATA_DIR: dir, CRON_SECRET: 'cron',
    GHL_AGENCY_CLIENT_ID: 'app2-xyz', GHL_AGENCY_CLIENT_SECRET: 'secret2', GHL_AGENCY_SSO_KEY: 'sso-key-2',
    BASE_URL: 'http://127.0.0.1:0', SWEEP_INTERVAL_SEC: '0'
  }, process.env.TEST_MONGODB_URI ? { MONGODB_URI: process.env.TEST_MONGODB_URI, MONGODB_DB: 'acc_test_' + Date.now() + '_' + Math.floor(Math.random() * 1e6) } : {}, extraEnv || {}));
  const fakes = createFakes();
  const pending = [];
  const app = createApp(cfg, { fetch: fakes.fetch, background: (label, fn) => { const p = Promise.resolve().then(fn); pending.push(p); return p; }, resolveCname: async () => ['127.0.0.1'] });
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => {
      const base = 'http://127.0.0.1:' + server.address().port;
      // BASE_URL must match the real port for Twilio signatures.
      cfg.baseUrl = base; cfg.baseHost = new URL(base).host; cfg.redirectUri = base + '/oauth/callback'; cfg.apps.standard.redirectUri = base + '/oauth/callback'; cfg.apps.agency.redirectUri = base + '/oauth/agency/callback';
      const close = server.close.bind(server);
      // Close the store too (MongoDB keeps the process alive otherwise).
      server.close = () => { close(); return app.locals.store.close(); };
      resolve({ cfg, app, server, base, fakes, pending, ctx: app.locals.ctx });
    });
  });
}

// fetch() cannot override Host, so custom-domain requests use node:http.
function rawRequest(base, method, pathName, headers, body) {
  const u = new URL(base);
  return new Promise((resolve, reject) => {
    const rq = require('http').request({ host: u.hostname, port: u.port, method, path: pathName, headers }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    rq.on('error', reject);
    rq.end(body);
  });
}

function client(base) {
  const jar = {};
  async function req(method, url, body, headers) {
    const res = await fetch(base + url, {
      method, redirect: 'manual',
      headers: Object.assign({ cookie: Object.entries(jar).map(([k, v]) => k + '=' + v).join('; '), 'X-ACC': '1' }, body !== undefined ? { 'Content-Type': 'application/json' } : {}, headers || {}),
      body: body !== undefined ? JSON.stringify(body) : undefined
    });
    (res.headers.getSetCookie ? res.headers.getSetCookie() : []).forEach((c) => {
      const [kv] = c.split(';');
      const i = kv.indexOf('=');
      const v = kv.slice(i + 1);
      if (v) jar[kv.slice(0, i)] = v; else delete jar[kv.slice(0, i)];
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch (e) { /* html */ }
    return { status: res.status, json, text, location: res.headers.get('location') };
  }
  return { req, jar };
}


module.exports = { setup, client, rawRequest };
