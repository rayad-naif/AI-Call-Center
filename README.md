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

Leads that arrive outside calling hours wait for the next opening. Retries and queued leads are placed by the sweep, which runs every 10 minutes on Vercel Pro and once a day on Hobby (`vercel.json`). Leads that arrive during calling hours are always called at once.

## Pages

| Page | URL |
| --- | --- |
| Landing (or sign-in on a custom domain) | `/` |
| Docs / Privacy / Terms | `/docs`, `/privacy`, `/terms` |
| Install (starts HighLevel OAuth) | `/install` |
| OAuth redirect URL (put in the GHL app) | `/oauth/callback` |
| Webhook URL (put in the GHL app) | `/webhooks/ghl` (INSTALL, UNINSTALL) |
| Custom page / custom menu link (SSO) | `/embed` |
| Agency console | `/app` |
| Command Deck | `/deck` (`?location=<locationId>` to open one client) |
| Email + password sign-in | `/login` |
| Super Admin | `/admin/login` (password = `ADMIN_PASSWORD`) |
| Vapi server URL (set automatically) | `/webhooks/vapi/<locationId>` |
| Twilio takeover line / TwiML app (set automatically) | `/twilio/voice/takeover`, `/twilio/voice/outbound` |
| Cron (Vercel, every 10 min) | `/api/cron/sweep` |
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

## HighLevel app settings

- Target user: **Agency**. Distribution: agency and sub-accounts.
- Redirect URL: `${BASE_URL}/oauth/callback`
- Webhook URL: `${BASE_URL}/webhooks/ghl` with INSTALL and UNINSTALL events
- SSO: generate the Shared Secret and set `GHL_SSO_KEY`. Add a custom page (or custom menu link for sub-accounts) pointing to `${BASE_URL}/embed`.
- Scopes (the default `GHL_SCOPES`):
  `companies.readonly locations.readonly oauth.readonly oauth.write contacts.readonly contacts.write opportunities.readonly opportunities.write calendars.readonly calendars/events.readonly calendars/events.write locations/customFields.readonly locations/customFields.write users.readonly conversations.readonly conversations/message.write`
- Pricing: a one-time install fee through Marketplace billing. `NEW_INSTALL_STATUS=pending` lets you approve each agency manually in Super Admin instead.

## Deploy (Vercel + MongoDB Atlas)

1. Create an Atlas cluster and allow Vercel's network (`0.0.0.0/0` or the Vercel integration).
2. Import this repo into Vercel and set the environment variables from `.env.example`. These are required: `BASE_URL`, `MONGODB_URI`, `MONGODB_DB`, `GHL_CLIENT_ID`, `GHL_CLIENT_SECRET`, `GHL_SSO_KEY`, `ADMIN_PASSWORD`, `SESSION_SECRET`, `ENCRYPTION_KEY`, `CRON_SECRET`.
3. Add your domain. `vercel.json` routes everything to `api/index.js` and runs the sweep cron every 10 minutes. That cron retries failed CRM syncs and closes calls that Vapi never reported as ended. Sub-daily crons need a Vercel Pro plan; on Hobby, change the schedule to daily.
4. Optional: to attach agencies' custom domains automatically, set `VERCEL_API_TOKEN` and `VERCEL_PROJECT_ID`. Without them, add each domain in Vercel yourself after the agency verifies its CNAME.
5. Run `npm run db:init` once, or let the indexes create themselves on first use.

`ENCRYPTION_KEY` must never change after launch: every stored key is encrypted with it.

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

With `MONGODB_URI` empty, data goes to `./data/store.json`. To run the tests against MongoDB as well, set `TEST_MONGODB_URI`.

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
