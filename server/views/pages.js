'use strict';
const { page, esc } = require('./layout');

const TWILIO_SDK = 'https://cdn.jsdelivr.net/npm/@twilio/voice-sdk@2.18.5/dist/twilio.min.js';

const message = (req, title, text) => page(req, { title, body: '<div class="center card narrow"><h1>' + esc(title) + '</h1><p>' + esc(text) + '</p></div>' });

function login(req) {
  const installed = req.query && req.query.installed;
  return page(req, {
    title: 'Sign in',
    body: '<div class="center"><form class="card narrow" data-form="/api/auth/login">' +
      '<h1>Sign in</h1>' +
      (installed ? '<p class="note ok">The app is installed. Sign in with the login you created.</p>' : '') +
      '<label>Email<input name="email" type="email" autocomplete="username" required></label>' +
      '<label>Password<input name="password" type="password" autocomplete="current-password" required></label>' +
      '<label class="row"><input type="checkbox" name="remember" value="1"> Keep me signed in for 7 days</label>' +
      '<button class="btn primary wide" type="submit">Sign in</button><p class="form-error" role="alert"></p>' +
      '<p class="muted small">Inside your CRM, open it from the left menu instead: it signs you in automatically.</p>' +
      '</form></div>'
  });
}

function setup(req, token) {
  return page(req, {
    title: 'Create your login',
    body: '<div class="center"><form class="card narrow" data-form="/api/auth/setup">' +
      '<h1>Create the owner login</h1><p class="muted">You will use this to open the console outside your CRM.</p>' +
      '<input type="hidden" name="t" value="' + esc(token) + '">' +
      '<label>Your name<input name="name" autocomplete="name"></label>' +
      '<label>Email<input name="email" type="email" autocomplete="username" required></label>' +
      '<label>Password (10+ characters)<input name="password" type="password" minlength="10" autocomplete="new-password" required></label>' +
      '<button class="btn primary wide" type="submit">Create login</button><p class="form-error" role="alert"></p></form></div>'
  });
}

const embed = (req) => page(req, {
  title: 'Loading', bare: true, footer: false,
  body: '<div class="center"><div class="card narrow" id="sso"><div class="spinner"></div><p>Signing you in…</p></div></div>',
  scripts: ['/static/embed.js']
});

const consolePage = (req) => page(req, {
  title: 'Company console', mainClass: 'shell',
  nav: '<a href="/deck">Command Deck</a><button class="link" data-logout>Sign out</button>',
  body: '<div id="console"><div class="spinner"></div></div>',
  scripts: ['/static/api-ui.js', '/static/console.js']
});

const deck = (req, opts) => page(req, {
  title: 'Command Deck', mainClass: 'deck-shell', bodyClass: 'deck',
  nav: (opts.agency ? '<a href="/app">Company console</a>' : '') + '<a href="/report' + (opts.location ? '?location=' + encodeURIComponent(opts.location) : '') + '" id="report-link">Report</a><span id="voice-status" class="pill" hidden></span><button class="link" data-logout>Sign out</button>',
  body: '<div id="deck"><div class="spinner"></div></div>',
  footer: false,
  data: { voiceSdk: TWILIO_SDK, voiceGlobal: 'Twilio', location: opts.location || '' },
  scripts: ['/static/audio.js', '/static/deck.js']
});

const report = (req, opts) => page(req, {
  title: 'Call center report', mainClass: 'container report-page', bodyClass: 'report',
  nav: (opts.agency ? '<a href="/app">Company console</a>' : '') + '<a href="/deck">Command Deck</a><button class="link" data-print>Print / PDF</button>',
  body: '<div id="report"><div class="spinner"></div></div>',
  data: { location: opts.location, days: opts.days },
  scripts: ['/static/report.js']
});

const adminLogin = (req) => page(req, {
  title: 'Super Admin',
  body: '<div class="center"><form class="card narrow" data-form="/api/admin/login"><h1>Super Admin</h1>' +
    '<label>Password<input name="password" type="password" required></label>' +
    '<button class="btn primary wide">Sign in</button><p class="form-error" role="alert"></p></form></div>'
});

const admin = (req) => page(req, {
  mainClass: 'shell',
  title: 'Super Admin', nav: '<button class="link" data-logout="/api/admin/logout">Sign out</button>',
  body: '<div id="admin"><div class="spinner"></div></div>', scripts: ['/static/api-ui.js', '/static/admin.js']
});

function landing(req, cfg) {
  if (req.brandCompanyId) return login(req); // custom portal domain: straight to sign-in
  const install = cfg.brand.marketplaceUrl || '/install';
  return page(req, {
    marketing: true,
    nav: '<a href="/docs">Docs</a><a href="/login">Sign in</a>',
    body: '<section class="hero"><h1>Your company\'s own AI call center</h1>' +
      '<p class="lead">Plug in your Twilio, Vapi and OpenAI keys once. Deploy a receptionist, a sales closer and a support agent to any client in minutes, watch every call live, step in when it matters, and have every call graded and logged in your CRM.</p>' +
      '<p><a class="btn primary" href="' + esc(install) + '">Install from the CRM Marketplace</a> <a class="btn" href="/docs">How it works</a></p></section>' +
      '<section class="grid3">' +
      feature('One-click deploy', 'Twilio account and number, three AI agents with switchboard routing, CRM fields and pipeline mapping, all in one click per client.') +
      feature('Live Command Deck', 'Every active call on one screen. Read the transcript as it happens, listen in, whisper instructions, or take the call over from your browser.') +
      feature('Shadow QA + CRM sync', 'Each call is scored, summarized and written to the contact in your CRM, with the opportunity moved to the right stage.') +
      feature('White-label portal', 'Your logo, colors and domain. Clients only ever see their own calls and agents.') +
      feature('Bring your own keys', 'Usage is billed to your own Twilio, Vapi and OpenAI accounts at wholesale cost. Keys are encrypted at rest.') +
      feature('Built for your CRM', 'Installs at company level, signs users in from the CRM sidebar, and works inside every account.') +
      '</section>'
  });
}
const feature = (t, d) => '<div class="card"><h3>' + esc(t) + '</h3><p class="muted">' + esc(d) + '</p></div>';

function docs(req, cfg) {
  const base = cfg.baseUrl;
  const step = (t, d) => '<li><strong>' + esc(t) + '</strong><br>' + d + '</li>';
  return page(req, {
    title: 'Documentation', marketing: true, nav: '<a href="/login">Sign in</a>',
    body: '<article class="prose"><h1>Documentation</h1>' +
      '<h2>Getting started</h2><ol>' +
      step('Install', 'Install the app from the CRM Marketplace. A company can install it for its accounts (one, several or all) and manage them from one console, or a single account can install it for itself. Then create your owner login.') +
      step('Add your keys', 'In <em>Keys</em>, paste your Twilio Account SID and Auth Token, Vapi private key and OpenAI key. Each is checked live and stored encrypted.') +
      step('Deploy a client', 'In <em>Clients</em>, pick an account, describe the business (services, hours, FAQ, pricing), choose a booking calendar and map call outcomes to pipeline stages, then click <em>Deploy</em>.') +
      step('Go live', 'The client gets a local number answered by the AI switchboard. Forward their existing line to it, or publish it.') +
      step('Watch and step in', 'Open the <em>Command Deck</em>. Click a call to see the transcript, <em>Listen</em> to the audio, <em>Whisper</em> an instruction to the AI, or <em>Take over</em> the call in your browser.') +
      '</ol>' +
      '<h2>What gets created</h2><ul>' +
      '<li><strong>Twilio:</strong> an account per client and a local number in it. Once per company: an API key, a TwiML app and a "takeover line" number for browser takeover.</li>' +
      '<li><strong>Vapi:</strong> your OpenAI key as a provider credential, three assistants (Receptionist, Sales, Support), a Squad that hands calls between them, and the imported phone number.</li>' +
      '<li><strong>CRM:</strong> contact custom fields (AI Call Summary, AI Sentiment, AI Call Score, AI Call Outcome, AI Next Steps, Last AI Call Recording, Last AI Call). Pipelines cannot be created through the CRM API, so map outcomes onto an existing pipeline (include one in your snapshot).</li>' +
      '</ul>' +
      '<h2>Speed-to-lead</h2><p>Turn it on in a client\'s deploy form (leads must have consented to be called), then add a <em>Custom Webhook</em> action to the client\'s CRM workflow using the URL shown there. The Outbound agent calls each new lead within seconds during calling hours, retries no-answers, and marks anyone who asks not to be called as Do Not Disturb.</p>' +
      '<h2>SMS follow-up and alerts</h2><p>After a call, the client\'s CRM number can text a booking confirmation, a missed-call note, a lead nurture message or a ticket receipt. Keywords, unhappy callers and low QA scores raise alerts in the Command Deck.</p>' +
      '<h2>Reports</h2><p>Every client has a white-labeled ROI report (calls, bookings, estimated revenue, return on AI cost, after-hours calls) that can be printed to PDF, plus a CSV export of every call.</p>' +
      '<h2>After every call</h2><p>The call is graded with your OpenAI key (score, sentiment, outcome, summary, next steps, coaching). The contact is found or created by caller ID, the AI fields are filled in, a note with the summary, recording link and transcript is added, outcome tags are applied, and the opportunity moves to the stage mapped to the outcome. Failed syncs retry automatically.</p>' +
      '<h2>Client access</h2><p>Add the app as a custom menu link in accounts: inside an account the app signs the user in to that location only. You can also create client logins under <em>Team</em>, and serve the portal from your own domain under <em>Branding</em> (CNAME to <code>' + esc(cfg.baseHost) + '</code>).</p>' +
      '<h2>Roles</h2><ul><li><strong>Owner / Admin:</strong> keys, deployments, branding, team.</li><li><strong>Manager:</strong> command deck with listen, whisper and takeover.</li><li><strong>Viewer:</strong> command deck, read only.</li></ul>' +
      '<h2>CRM app settings</h2><ul>' +
      '<li>Redirect URL: <code>' + esc(base) + '/oauth/callback</code></li>' +
      '<li>Webhook URL: <code>' + esc(base) + '/webhooks/crm</code> (INSTALL, UNINSTALL)</li>' +
      '<li>Custom page / SSO URL: <code>' + esc(base) + '/embed</code></li>' +
      '<li>Account app (Target User: Account): redirect <code>' + esc(cfg.apps.standard.redirectUri) + '</code>, scopes <code>' + esc(cfg.apps.standard.scopes) + '</code></li>' +
      '<li>Company app (Target User: Company): redirect <code>' + esc(cfg.apps.agency.redirectUri) + '</code>, scopes <code>' + esc(cfg.apps.agency.scopes) + '</code>. Each client account is connected with a Private Integration token from that account.</li></ul>' +
      '<h2>Support</h2><p>' + esc(cfg.brand.supportName) + ': <a href="mailto:' + esc(cfg.brand.supportEmail) + '">' + esc(cfg.brand.supportEmail) + '</a></p></article>'
  });
}

function legal(req, cfg, kind) {
  const n = esc(cfg.brand.legalName);
  const body = kind === 'privacy'
    ? '<h1>Privacy Policy</h1><p class="muted">Last updated ' + esc(cfg.brand.legalUpdated) + '</p>' +
      '<p>' + n + ' ("we") provides software that companies install to run AI phone agents for their clients.</p>' +
      '<h2>What we store</h2><ul><li>Account details from the connected CRM (company id and name) and OAuth tokens, encrypted.</li><li>API keys the company provides (Twilio, Vapi, OpenAI), encrypted with AES-256-GCM.</li><li>Call records: caller number, transcript, summary, QA grade, recording link (the recording itself stays with Vapi), and sync status.</li><li>Login emails and salted password hashes.</li></ul>' +
      '<h2>How it is used</h2><p>Only to run the service: provisioning, live monitoring, grading with the company\'s own OpenAI key, and syncing results to the connected CRM account. We do not sell data or use it to train models.</p>' +
      '<h2>Processors</h2><p>Call audio and AI processing are handled by Twilio, Vapi and OpenAI under the company\'s own accounts and their terms. Data is hosted on our cloud provider and MongoDB Atlas.</p>' +
      '<h2>Retention</h2><p>Call records are deleted automatically after 12 months, activity logs after 180 days. Uninstalling stops all processing; ask us to delete everything at any time.</p>' +
      '<h2>Call recording consent</h2><p>Companies and their clients are responsible for caller disclosures and consent required where they operate.</p>' +
      '<h2>Contact</h2><p>' + esc(cfg.brand.supportName) + ', <a href="mailto:' + esc(cfg.brand.supportEmail) + '">' + esc(cfg.brand.supportEmail) + '</a></p>'
    : '<h1>Terms of Service</h1><p class="muted">Last updated ' + esc(cfg.brand.legalUpdated) + '</p>' +
      '<p>By installing or using ' + n + ' you agree to these terms.</p>' +
      '<h2>License</h2><p>Your purchase grants your company a non-transferable license to use the software for your own and your clients\' businesses while the app is installed.</p>' +
      '<h2>Your accounts and costs</h2><p>The service runs on your own Twilio, Vapi and OpenAI accounts. All usage charges from those providers are yours. Keep your keys valid and your accounts in good standing.</p>' +
      '<h2>Acceptable use</h2><p>You must comply with telemarketing, robocall, privacy and call-recording laws (for example TCPA and local consent rules) and the providers\' policies. No unlawful, deceptive or unsolicited automated calling.</p>' +
      '<h2>AI output</h2><p>AI agents can make mistakes. You are responsible for reviewing their configuration and outcomes.</p>' +
      '<h2>Warranty and liability</h2><p>The software is provided "as is". Our total liability is limited to the amount you paid for the license.</p>' +
      '<h2>Termination</h2><p>We may suspend licenses used in breach of these terms.</p>' +
      '<h2>Contact</h2><p>' + esc(cfg.brand.supportName) + ', <a href="mailto:' + esc(cfg.brand.supportEmail) + '">' + esc(cfg.brand.supportEmail) + '</a></p>';
  return page(req, { title: kind === 'privacy' ? 'Privacy' : 'Terms', marketing: true, body: '<article class="prose">' + body + '</article>' });
}

module.exports = { message, login, setup, embed, consolePage, deck, report, adminLogin, admin, landing, docs, legal, TWILIO_SDK };
