# AI Call Center

A HighLevel Marketplace app (Target User: **Agency**) that turns an agency's own Twilio, Vapi and OpenAI accounts into a white-label AI call center for every client:

- **One-click deploy per client.** It creates a Twilio subaccount and local number, three AI agents (Receptionist, Sales Closer, Support), a Vapi Squad that routes calls between them, and AI custom fields in the client's HighLevel sub-account.
- **Live Command Deck.** Every active call appears on one screen, with the transcript as it happens. Supervisors can listen in, **whisper** instructions to the AI, make it **say** a line, mute it, transfer the call to a phone, end it, or **take over** the call in their browser.
- **Shadow QA and CRM sync.** Every call is graded (score, sentiment, outcome, summary, next steps, coaching) and written to the HighLevel contact: fields, a note with the transcript and recording link, and tags. The opportunity moves to the pipeline stage mapped to the outcome.
- **White-label portal.** Agencies set their own name, logo, colors and custom domain. Client users only ever see their own business.
- **Bring your own keys.** All usage is billed to the agency's own Twilio, Vapi and OpenAI accounts. Keys are checked live and stored encrypted with AES-256-GCM.
- **Speed-to-lead.** A HighLevel workflow sends each new lead to a webhook, and an Outbound AI agent calls them back within seconds to qualify and book. It only calls during the client's calling hours, retries no-answers, caps calls per day, ignores duplicates, and marks anyone who says "stop calling" as Do Not Disturb.
- **SMS follow-up.** After each call, a text goes out through the client's own HighLevel number: booking confirmation, "sorry we missed you", lead nurture, or ticket received.
- **Live alerts.** Watched keywords (refund, lawyer, cancel…), unhappy callers and low QA scores flash in the Command Deck with a sound and a browser notification.
- **ROI report and CSV export.** A white-labeled, printable report per client: calls, bookings, estimated revenue, return on AI cost, after-hours calls, staff hours saved, outcomes, busiest hours and speed-to-lead stats.
- **Industry templates.** HVAC, plumbing, roofing, dental, med spa, legal intake, real estate and solar fill a client's setup in one click.
- **Spanish and bilingual agents.** English, Spanish, or automatic English/Spanish switching.

See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for how it works and why it is built this way.

## Try it locally (no accounts needed)

```bash
npm install
```

```bash
npm run demo
```

Open http://localhost:3000/login and sign in as `demo@example.com` with password `demo-password`. The demo simulates Twilio, Vapi, HighLevel and OpenAI. It deploys a sample client and plays a scripted live call every 45 seconds, so you can watch the deck, whisper, and see the QA grade and CRM sync appear. Listen and takeover need a real call.

## Speed-to-lead setup (per client)

1. In the client's deploy form, tick the consent box (leads must have agreed to be called), turn on speed-to-lead, set calling hours, attempts and a daily cap, and deploy or click **Save and update agents only**.
2. Copy the **Webhook URL** shown in that section.
3. In the client's HighLevel workflow (for example, trigger "Form submitted"), add the action **Custom Webhook**, method POST, with that URL. HighLevel sends the contact's phone, name and id automatically. Add custom data `interest` (for example "{{contact.service}}") to tell the AI what the lead asked about.
4. Use **Test speed-to-lead** to have the agent call your own phone.

Leads that arrive during calling hours are called at once. Leads that arrive after hours, and retries, are placed by the background sweep: see [Background jobs on Vercel's free plan](#background-jobs-on-vercels-free-plan).

## Pages

| Page | URL |
| --- | --- |
| Landing (or sign-in on a custom domain) | `/` |
| Docs / Privacy / Terms | `/docs`, `/privacy`, `/terms` |
| Install, account app / company app | `/install`, `/install/agency` |
| OAuth redirect URL, account app | `/oauth/callback` |
| OAuth redirect URL, company app | `/oauth/agency/callback` |
| Webhook URL (put in the CRM app) | `/webhooks/crm` (INSTALL, UNINSTALL; `/webhooks/ghl` also works) |
| Custom page / custom menu link (SSO) | `/embed` |
| Agency console | `/app` |
| Command Deck | `/deck` (`?location=<locationId>` to open one client) |
| Email + password sign-in | `/login` |
| Super Admin | `/admin/login` (password = `ADMIN_PASSWORD`) |
| Vapi server URL (set automatically) | `/webhooks/vapi/<locationId>` |
| Twilio takeover line / TwiML app (set automatically) | `/twilio/voice/takeover`, `/twilio/voice/outbound` |
| Background sweep (Vercel cron daily + traffic + optional pinger) | `/api/cron/sweep` |
| Speed-to-lead webhook (shown per client) | `/hooks/lead/<locationId>/<key>` |
| ROI report / CSV | `/report?location=…&days=30`, `/api/reports/calls.csv` |

## How agencies use it

1. **Install** from the Marketplace as an agency admin, then create the owner email and password.
2. **Keys:** paste the Twilio Account SID and Auth Token, the Vapi private key and the OpenAI key. Each key is checked against its provider before it is saved.
3. **Clients:** pick a sub-account and describe the business: services, hours, pricing the AI may share, a support FAQ, the greeting, voice, a human transfer number, a booking calendar, and which pipeline stage each call outcome moves to. Then click **Deploy call center**. Progress shows step by step, and a failed deploy can be resumed.
4. **Go live:** the client gets a local number answered by the AI switchboard. They can forward their existing line to it.
5. **Command Deck:** watch calls, listen, whisper, or take over. **Team** creates client logins (manager or viewer). Inside HighLevel, the app signs users in automatically: inside a sub-account they see only that client.

### What a deploy creates

| Provider | Created |
| --- | --- |
| Twilio (once per agency) | API key, TwiML app and a "takeover line" number, used for browser takeover |
| Twilio (per client) | Subaccount and a local number (preferred area code) |
| Vapi (once per agency) | The agency's OpenAI key as a provider credential, so LLM usage bills to them |
| Vapi (per client) | Receptionist, Sales and Support assistants, a Squad with handoff routes, the imported number pointing at the Squad, and an Outbound (speed-to-lead) assistant |
| HighLevel (per client) | Contact custom fields: AI Call Summary, AI Sentiment, AI Call Score, AI Call Outcome, AI Next Steps, Last AI Call Recording, Last AI Call |

HighLevel's API cannot create pipelines, so put a voice pipeline in your snapshot and map outcomes onto it in the deploy form.

**Redeploy** updates the agents in place without creating anything new. **Save and update agents only** just pushes prompt and voice changes. **Remove** deletes the agents and Squad, releases the number, and can close the subaccount.

### The agents

- **Receptionist** answers, gets the caller's name and hands off to Sales (new work, quotes, booking) or Support (existing jobs, billing, complaints).
- **Sales** qualifies the caller, finds real open times (`check_availability` → HighLevel calendar free slots) and books (`book_appointment` → HighLevel appointment).
- **Support** looks the caller up (`lookup_customer`), answers from the FAQ, and logs a ticket (`create_support_ticket` → contact note and tags).
- All three can transfer to a human (Vapi `transferCall`) when a transfer number is set.

## HighLevel app settings (step by step)

One repo and one Vercel project serve **two Marketplace apps**. Both use the same domain, database, webhook URL and sidebar page; each has its own client keys and redirect URL:

| | Account app | Company app |
| --- | --- | --- |
| Target User | Sub-account (distribution: Agency and Sub-account) | Agency |
| Redirect URL | `${BASE_URL}/oauth/callback` | `${BASE_URL}/oauth/agency/callback` |
| Webhook URL | `${BASE_URL}/webhooks/crm` | `${BASE_URL}/webhooks/crm` (same; events are told apart by `appId`) |
| Custom page | `${BASE_URL}/embed` | `${BASE_URL}/embed` (same; either app's SSO key is accepted) |
| Scopes | the full list below | `companies.readonly locations.readonly users.readonly` |
| Env vars | `GHL_CLIENT_ID`, `GHL_CLIENT_SECRET`, `GHL_SSO_KEY` | `GHL_AGENCY_CLIENT_ID`, `GHL_AGENCY_CLIENT_SECRET`, `GHL_AGENCY_SSO_KEY` |
| CRM access per client | location tokens minted automatically | a Private Integration token pasted per client account |

You can publish either app alone or both. After deploying, **Super Admin** shows a card for each app with every value to paste, flags missing settings, and has a **Test Client ID / Secret** button per app.

### Account app

1. **Basic info:** Target User **Sub-account**. Distribution: **Agency and Sub-account**, so an agency can install it for its sub-accounts (one, several or all) and a sub-account can also install it for itself.
2. **Auth → Scopes:** add every scope below (the default `GHL_SCOPES`):
   `companies.readonly locations.readonly oauth.readonly oauth.write contacts.readonly contacts.write opportunities.readonly opportunities.write calendars.readonly calendars/events.readonly calendars/events.write locations/customFields.readonly locations/customFields.write users.readonly conversations.readonly conversations/message.write`
3. **Auth → Redirect URL:** `${BASE_URL}/oauth/callback`
4. **Auth → Client Keys:** create a key. Put the Client ID in `GHL_CLIENT_ID` and the Client Secret in `GHL_CLIENT_SECRET` (the secret is shown only once). The app id is read from the part of the Client ID before the first "-". Set `GHL_APP_ID` only if yours differs.
5. **Auth → SSO:** generate the SSO key and put it in `GHL_SSO_KEY`.
6. **Webhooks:** URL `${BASE_URL}/webhooks/crm`, events **INSTALL** and **UNINSTALL**. Optionally add HighLevel's webhook public key to `GHL_WEBHOOK_ED25519_KEY`.
7. **Modules → Custom Page:** URL `${BASE_URL}/embed`. HighLevel opens it in the left sidebar and the app signs the user in with SSO:
   - an agency admin in Agency view gets the agency console;
   - other agency users get the Command Deck;
   - anyone inside a sub-account gets that sub-account's deck only (once it is deployed).
8. **Pricing:** a one-time install fee through Marketplace billing. `NEW_INSTALL_STATUS=pending` lets you approve each agency manually in Super Admin instead.

### Company app

1. **Basic info:** Target User **Agency**.
2. **Auth → Scopes:** `companies.readonly`, `locations.readonly`, `users.readonly`. HighLevel offers only agency-level scopes to Agency apps, so there is no contacts, calendars, conversations or `oauth.write` access here.
3. **Auth → Redirect URL:** `${BASE_URL}/oauth/agency/callback`
4. **Auth → Client Keys:** put them in `GHL_AGENCY_CLIENT_ID` and `GHL_AGENCY_CLIENT_SECRET`. Set `GHL_AGENCY_APP_ID` only if the app id is not the part of the Client ID before the first "-".
5. **Auth → SSO:** generate the key and put it in `GHL_AGENCY_SSO_KEY`.
6. **Webhooks:** the same `${BASE_URL}/webhooks/crm`, events INSTALL and UNINSTALL.
7. **Modules → Custom Page:** the same `${BASE_URL}/embed`.
8. **Connecting each client:** in the client's sub-account, open **Settings → Private Integrations → Create new integration** with these scopes, then paste the token into **Clients → (client) → CRM connection**:
   - View/Edit Contacts, View/Edit Opportunities
   - View Calendars, View/Edit Calendar Events
   - View/Edit Custom Fields
   - View/Edit Conversations, View/Edit Conversation Messages
   - View Locations, View Users

   The token is checked live: it must belong to that sub-account and be able to read contacts. It is stored encrypted and used for every CRM call for that client. Until a client is connected, its CRM steps answer "Connect this account first".

**If a company installs both apps:** the account app is in charge, because its scopes are fuller. The company app is kept alongside it. Uninstalling either app leaves the company running on the other; uninstalling both switches the workspace off. On the account app, the same CRM connection box appears for any sub-account where that app isn't installed, as a fallback.

### How installs work

The app is a sub-account app that an agency can install for its sub-accounts. Both ways of installing work:

- **The agency installs it for its sub-accounts** (HighLevel's bulk install returns an Agency-level token). This creates a **company workspace**: the installer creates the owner login, and the company console lists the agency's sub-accounts so it can set up a call center for each one. Location tokens are minted per sub-account, and HighLevel only issues them where the app is installed. The list therefore shows "App not installed in this account yet" where needed, using HighLevel's installed-locations API. Inside a deployed sub-account, users see only that account's deck.
- **A sub-account installs it for itself** (a Location-level token). If its agency already runs the app, the install is just recorded and the agency manages that account. Otherwise the sub-account gets its own **single-account workspace**:
  - its own owner login, keys, call center, team, branding and reports;
  - it can only manage itself;
  - its token refreshes as a Location token;
  - inside the CRM, that sub-account's admins get the console and other users get the deck.
- **Installs and uninstalls are tracked per sub-account** (INSTALL/UNINSTALL webhooks with a `locationId`). Uninstalling from a single-account workspace disables it. Without webhook signature keys, the uninstall is first confirmed by checking that the account's token was revoked.
- **Super Admin** shows each workspace as *Company* or *Single account*.
- **Token refresh:** HighLevel refresh tokens are single-use. When two requests refresh at once, the second reuses the token the first saved. A revoked token shows "Reinstall the app" instead of failing silently.
- **Iframe sign-in:** session cookies are `SameSite=None; Secure; Partitioned`, so `BASE_URL` must be HTTPS. Pages are never blocked from framing, because white-label CRM domains vary.

## Super Admin portal

`/admin` (password `ADMIN_PASSWORD`) covers the whole platform:

| Tab | What it shows |
| --- | --- |
| Dashboard | Companies, single accounts, live call centers, live calls, calls, minutes, bookings, QA, voice cost, leads, CRM sync health, a daily chart, top companies and a "needs attention" list |
| Companies | Search and filter every company; open one to see its apps, license (change it there), provider keys, call centers (with deploy steps and errors), users, 30-day stats, recent calls, leads and activity |
| Calls | Every call across the platform, filtered by company, status, outcome, direction, CRM sync and alerts; click one for the transcript, grade, recording and sync result |
| Leads | The speed-to-lead queue and results |
| Activity | The full activity log, filtered by company and event type |
| Webhooks | Push events to your other apps, with a delivery log, test pings and pause/resume |
| API | API keys and the full API reference with copyable curl examples |
| Setup | Platform checks, plus a card for each Marketplace app with every value to paste and a credential test |

## REST API and webhooks (connect your other apps)

- **Base URL:** `${BASE_URL}/api/v1`. The machine-readable spec is at `${BASE_URL}/api/v1/openapi.json` (OpenAPI 3).
- **Auth:** `Authorization: Bearer acc_…`. Create one key per app in **Super Admin → API**:
  - a **read** key reads data; a **write** key can also send leads and change licenses;
  - a key can be limited to one company;
  - keys are stored only as a SHA-256 hash and can be revoked at any time.
- **Endpoints:**
  - `GET /health`, `GET /stats`
  - `GET /companies`, `GET|PATCH /companies/{id}`
  - `GET /accounts`, `GET /accounts/{id}`
  - `GET /calls`, `GET /calls/{id}` (with transcript)
  - `GET /leads`, `GET /leads/{id}`, `POST /leads` (the AI calls the lead back)
  - `GET /events`, `GET /webhook-events`
- **Conventions:** lists return `{ data, nextBefore }`, and you pass `?before=` for the next page. The limit is 600 requests per minute per key. Errors look like `{ "error": "…" }`.
- **Webhooks:** **Super Admin → Webhooks** sends events to any public `https://` URL, optionally for a single company only.
  - **Events:** `company.installed`, `company.uninstalled`, `company.status_changed`, `account.deployed`, `account.deploy_failed`, `account.removed`, `account.crm_connected`, `call.started`, `call.ended`, `call.graded`, `call.alert`, `call.takeover`, `lead.received`, `lead.called`, `lead.finished`, `sms.sent`.
  - **Body:** `{ id, type, createdAt, companyId, data }`. `data` includes the related call, lead, account or company.
  - **Signature:** `X-ACC-Signature: t=<unix>,v1=<hex HMAC-SHA256(secret, t + "." + body)>`. The verification code is in the Webhooks tab.
  - **Retries:** failed deliveries retry after 1 min, 5 min, 30 min, 2 h and 12 h.

## Deploy (Vercel + MongoDB Atlas)

1. Create an Atlas cluster and allow Vercel's network (`0.0.0.0/0` or the Vercel integration).
2. Import this repo into Vercel and set the environment variables from `.env.example`. These are required: `BASE_URL`, `AI_CALL_CENTER_PLUS_MONGODB_URI` (added automatically by Vercel's MongoDB Atlas integration; a plain `MONGODB_URI` also works; the database name is taken from the URI, or `MONGODB_DB` if you set it, else `AICallCenter`), `ADMIN_PASSWORD`, `SESSION_SECRET`, `ENCRYPTION_KEY`, `CRON_SECRET`, plus the keys for each app you publish: `GHL_CLIENT_ID` / `GHL_CLIENT_SECRET` / `GHL_SSO_KEY` (account app) and `GHL_AGENCY_CLIENT_ID` / `GHL_AGENCY_CLIENT_SECRET` / `GHL_AGENCY_SSO_KEY` (company app).
3. Add your domain. `vercel.json` routes everything to `api/index.js` and has one daily cron. That fits Vercel's free Hobby plan, which allows only daily crons.
4. Optional: to attach agencies' custom domains automatically, set `VERCEL_API_TOKEN` and `VERCEL_PROJECT_ID`. Without them, add each domain in Vercel yourself after the agency verifies its CNAME.
5. Run `npm run db:init` once, or let the indexes create themselves on first use.

`ENCRYPTION_KEY` must never change after launch: every stored key is encrypted with it.

## Background jobs on Vercel's free plan

The sweep places speed-to-lead calls that are waiting, retries unanswered leads and failed CRM syncs, and closes calls Vapi never reported as ended. Vercel's Hobby plan allows only **one cron a day**, so the sweep runs from three places:

1. **Normal traffic (automatic).** Vapi call webhooks, lead webhooks and every open Command Deck start the sweep in the background, at most once a minute (`SWEEP_INTERVAL_SEC`, default 60). A database lease makes sure only one instance runs it at a time. While calls are coming in or anyone has the deck open, retries go out within about a minute.
2. **Daily Vercel cron** (`vercel.json`, 13:00 UTC, about 8–9 AM US Eastern). This catches up on anything waiting overnight, such as leads that came in after hours. Vercel may run it at any point within that hour.
3. **Optional free pinger, for exact timing at quiet hours.** Use either one:
   - **GitHub Actions** (included, `.github/workflows/sweep.yml`): add the repository secrets `APP_URL` and `CRON_SECRET`. It calls the sweep every 10 minutes. GitHub can delay scheduled runs a little at busy times.
   - **cron-job.org** (free): create a job for `POST https://YOUR-DOMAIN/api/cron/sweep` with header `X-Cron-Secret: <CRON_SECRET>`, every 5 minutes.

Super Admin → **HighLevel app setup** shows when the sweep last ran and from where. It warns if speed-to-lead calls have been waiting more than 15 minutes, which means you need the pinger. On Vercel Pro you can simply set the cron in `vercel.json` to `*/10 * * * *` instead. On a long-running server (`npm start` on Railway, Render or a VPS), the app sweeps itself every minute.

## Development

```bash
npm install
```

```bash
cp .env.example .env
```

```bash
npm start
```

```bash
npm test
```

Without a MongoDB URI, data goes to `./data/store.json`. To run the tests against MongoDB as well, set `TEST_MONGODB_URI`.

### Code map

- `server/integrations/`: thin REST clients for Twilio, Vapi, HighLevel and OpenAI (no vendor SDKs)
- `server/services/provisioner.js`: the idempotent deploy chain, redeploy and teardown
- `server/services/agents.js`: prompt templates, tools and Squad routing
- `server/services/calls.js`: Vapi event ingestion, live state, controls and takeover
- `server/services/qa.js`: the grader and HighLevel sync, with retries
- `server/services/tools.js`: calendar, booking, lookup and ticket tools for the agents
- `server/services/branding.js`: white-label branding and custom domains
- `server/services/automation.js`: speed-to-lead, SMS follow-up and live alerts
- `server/services/reports.js`: ROI report and CSV export
- `server/services/templates.js`: industry templates
- `server/auth.js`: sessions, roles and data scoping
- `server/routes/`: HTTP routes. `server/views/`: server-rendered shells
- `public/`: browser apps (`console.js`, `deck.js`, `audio.js`, `embed.js`, `admin.js`)
- `scripts/demo.js`: local demo with simulated providers
- `test/`: end-to-end tests against faked providers, plus unit tests

## Things to verify with live accounts before launch

The provider APIs are exercised here against faithful fakes. A few behaviours depend on account settings and should be checked once with real keys:

- **Listen audio format.** Vapi's listen socket sends raw 16-bit PCM. The deck defaults to 16 kHz mono, and the format picker next to **Listen** switches it if audio sounds too fast or slow.
- **Takeover caller ID.** Vapi's transfer reaches the takeover line with the caller's number when Vapi passes it through. Otherwise the most recent pending takeover is used, which only matters if two supervisors take over within the same few seconds.
- **Third-party cookies.** Inside the HighLevel iframe, the session cookie is `SameSite=None; Secure; Partitioned`. Browsers that block all iframe cookies need the standalone `/login`.
- **Compliance.** Call recording consent and TCPA rules are the agency's responsibility. The Terms page says so. Speed-to-lead cannot be turned on without the consent checkbox.
- **SMS.** Follow-up texts go through the sub-account's HighLevel phone, so that sub-account needs SMS (LC Phone or Twilio) set up in HighLevel. Existing installs must re-authorize to grant the new `conversations/message.write` scope.
- **Spanish voices.** Spanish and bilingual agents use Azure neural voices through Vapi. Confirm they're enabled on your Vapi account.
