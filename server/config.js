'use strict';
const fs = require('fs');
const path = require('path');

// Minimal .env loader (no dependency). Real env vars win over the file.
(function loadDotEnv() {
  const file = path.join(__dirname, '..', '.env');
  if (!fs.existsSync(file)) return;
  fs.readFileSync(file, 'utf8').split(/\r?\n/).forEach((line) => {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!m || process.env[m[1]] !== undefined) return;
    let v = m[2];
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    process.env[m[1]] = v.replace(/\\n/g, '\n');
  });
})();

// Every scope the app uses. Install fails loudly in GHL if the app is missing one.
const DEFAULT_SCOPES = [
  'companies.readonly',
  'locations.readonly',
  'oauth.readonly',
  'oauth.write',
  'contacts.readonly',
  'contacts.write',
  'opportunities.readonly',
  'opportunities.write',
  'calendars.readonly',
  'calendars/events.readonly',
  'calendars/events.write',
  'locations/customFields.readonly',
  'locations/customFields.write',
  'users.readonly',
  'conversations.readonly',
  'conversations/message.write'
].join(' ');

function load(env) {
  env = env || process.env;
  const vercelUrl = env.VERCEL_PROJECT_PRODUCTION_URL ? 'https://' + env.VERCEL_PROJECT_PRODUCTION_URL : '';
  const baseUrl = (env.BASE_URL || vercelUrl || 'http://localhost:' + (env.PORT || 3000)).replace(/\/+$/, '');
  return {
    port: Number(env.PORT || 3000),
    baseUrl,
    baseHost: new URL(baseUrl).host,
    secureCookies: baseUrl.startsWith('https://'),
    dataDir: path.resolve(env.DATA_DIR || path.join(__dirname, '..', 'data')),
    mongoUri: env.MONGODB_URI || '',
    mongoDb: env.MONGODB_DB || 'AICallCenter',
    cronSecret: env.CRON_SECRET || '',
    serverless: !!env.VERCEL,
    newInstallStatus: env.NEW_INSTALL_STATUS === 'pending' ? 'pending' : 'active',
    adminPassword: env.ADMIN_PASSWORD || '',
    sessionSecret: env.SESSION_SECRET || '',
    // Separate key for customer API keys at rest (falls back to SESSION_SECRET).
    encryptionKey: env.ENCRYPTION_KEY || env.SESSION_SECRET || '',
    ghl: {
      clientId: env.GHL_CLIENT_ID || '',
      clientSecret: env.GHL_CLIENT_SECRET || '',
      scopes: env.GHL_SCOPES || DEFAULT_SCOPES,
      authUrl: env.GHL_AUTH_URL || 'https://marketplace.gohighlevel.com/oauth/chooselocation',
      apiBase: (env.GHL_API_BASE || 'https://services.leadconnectorhq.com').replace(/\/+$/, ''),
      apiVersion: env.GHL_API_VERSION || '2021-07-28',
      webhookEd25519Key: env.GHL_WEBHOOK_ED25519_KEY || '',
      webhookRsaKey: env.GHL_WEBHOOK_RSA_KEY || '',
      ssoKey: env.GHL_SSO_KEY || ''
    },
    twilio: { apiBase: (env.TWILIO_API_BASE || 'https://api.twilio.com').replace(/\/+$/, '') },
    vapi: { apiBase: (env.VAPI_API_BASE || 'https://api.vapi.ai').replace(/\/+$/, '') },
    openai: {
      apiBase: (env.OPENAI_API_BASE || 'https://api.openai.com/v1').replace(/\/+$/, ''),
      graderModel: env.GRADER_MODEL || 'gpt-4o-mini',
      agentModel: env.AGENT_MODEL || 'gpt-4o'
    },
    // Optional: lets agencies map custom portal domains automatically.
    vercel: {
      token: env.VERCEL_API_TOKEN || '',
      projectId: env.VERCEL_PROJECT_ID || '',
      teamId: env.VERCEL_TEAM_ID || ''
    },
    // How the browser gets live updates: polling works everywhere (incl. Vercel).
    livePollMs: Math.max(800, Number(env.LIVE_POLL_MS || 1500)),
    redirectUri: baseUrl + '/oauth/callback',
    brand: {
      name: env.BRAND_NAME || 'AI Call Center',
      supportEmail: env.SUPPORT_EMAIL || 'support@example.com',
      legalName: env.LEGAL_NAME || env.BRAND_NAME || 'AI Call Center',
      legalUpdated: env.LEGAL_UPDATED || 'November 16, 2026',
      marketplaceUrl: env.MARKETPLACE_URL || ''
    }
  };
}

function validate(cfg) {
  const problems = [];
  if (!cfg.sessionSecret || cfg.sessionSecret.length < 32) problems.push('SESSION_SECRET must be at least 32 characters');
  if (!cfg.encryptionKey || cfg.encryptionKey.length < 32) problems.push('ENCRYPTION_KEY must be at least 32 characters');
  if (!cfg.adminPassword || cfg.adminPassword.length < 10) problems.push('ADMIN_PASSWORD must be at least 10 characters');
  if (cfg.serverless && !cfg.mongoUri) problems.push('MONGODB_URI is required on Vercel (its filesystem is not persistent)');
  if (!cfg.ghl.clientId || !cfg.ghl.clientSecret) problems.push('GHL_CLIENT_ID and GHL_CLIENT_SECRET are required');
  return problems;
}

module.exports = { load, validate, DEFAULT_SCOPES };
