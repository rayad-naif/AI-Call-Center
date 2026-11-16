# Architecture

## Goal

Sell a one-time license without paying for anyone's call traffic. The server never carries audio or runs LLM inference. Twilio and Vapi do the heavy work on the agency's own accounts. This app only provisions resources, stores small text state, and relays control requests, so it runs on one serverless function plus MongoDB Atlas.

```
            caller ──PSTN──► Twilio number (client subaccount)
                                  │  imported into Vapi
                                  ▼
                     Vapi Squad: Receptionist ⇄ Sales ⇄ Support
                      │ server messages           ▲ live control (add-message, say,
                      │ (status, transcript,      │ mute, transfer, end-call)
                      │  tool-calls, report)      │
                      ▼                           │
    ┌──────────── this app (Vercel function + MongoDB) ────────────┐
    │ provisioning · call state · tools · QA grader · CRM sync     │
    └───────▲───────────────────────┬──────────────────────────────┘
            │ polling (1.5 s)       │ HighLevel API (location tokens)
            │                       ▼
   Command Deck (browser) ◄── audio WebSocket direct from Vapi (listen)
            ▲
            └── Twilio Voice SDK (WebRTC) ◄── takeover line ◄── Vapi transfer
```

## Changes from the original blueprint

| Blueprint | Built as | Why |
| --- | --- | --- |
| Agency pastes a GHL Agency API key | Marketplace OAuth at agency level, plus per-location tokens from `/oauth/locationToken` | No key to paste or leak. Install, uninstall and billing come from the Marketplace. |
| Receptionist uses `transfer` to reach other AIs | Vapi **Squad** with `assistantDestinations` | This is Vapi's native multi-agent handoff. The conversation carries over, and no phone leg is added. |
| "Inject a snapshot" through the GHL API | Create custom fields through the API, and map outcomes onto an existing pipeline | The public API cannot load snapshots into an existing sub-account or create pipelines. |
| SIP trunking | Import the Twilio number into Vapi | Vapi configures the number's voice webhook itself. SIP adds nothing here. |
| Listen and barge-in through the Twilio SDK | **Listen:** Vapi `listenUrl` WebSocket straight to the browser. **Whisper:** `add-message`. **Takeover:** Vapi transfer to a takeover line, which rings the supervisor's browser through the Twilio Voice SDK | Once Vapi answers, the audio runs between Twilio and Vapi, and a browser cannot join that media stream directly. |
| WebSockets for live transcripts | Short polling (1.5 s, configurable) | It works on serverless with no extra service. For sub-second updates, Pusher or Ably could be added later. |

## Data

MongoDB collections (the JSON file store mirrors them for development):

- `agencies` (`_id` = companyId): GHL tokens (encrypted), BYOK keys (encrypted), key check status, agency-wide Twilio and Vapi resources (`setup`), branding.
- `deployments` (`_id` = locationId): agent settings, pipeline mapping, Twilio/Vapi/GHL resource ids, step status, Vapi webhook secret (encrypted), cached location token.
- `calls` (`_id` = Vapi call id): status, current agent, transcript (last 600 lines), partial line, whispers, monitor URLs (encrypted), takeover state, recording link, grade, sync state. A TTL index removes calls after `CALL_RETENTION_DAYS`.
- `users`: agency staff and client logins (scrypt hashes, `sessionVersion` for revocation).
- `takeovers`: pending takeovers, with a 2-minute TTL.
- `domains`: custom portal host → companyId.
- `events`: activity log, with a 180-day TTL.

## Security

- Customer API keys, OAuth tokens, Vapi webhook secrets and per-call monitor URLs are encrypted with AES-256-GCM using `ENCRYPTION_KEY`. The UI only ever sees the last 4 characters of a key.
- Vapi webhooks are checked with a per-deployment secret (`x-vapi-secret`). Twilio webhooks are checked with `X-Twilio-Signature` using the agency's auth token. GHL webhooks are checked with signature keys when configured; otherwise an uninstall is confirmed by trying the refresh token.
- The call's `controlUrl` never leaves the server. The `listenUrl` is handed to managers only, on demand, and the request is logged.
- Sessions are HMAC-signed cookies (`SameSite=None; Secure; Partitioned`, so they work inside the HighLevel iframe). Every state-changing request needs an `X-ACC` header, which a cross-site form cannot send.
- Data scoping happens on the server for every query. Client users are limited to their own `locationIds`, and a custom domain only accepts its own agency's logins.
- Login, SSO, polling and control calls are rate limited.

## Reliability

- Every deploy step is idempotent and records its status, so a failed deploy resumes where it stopped and a redeploy updates resources in place.
- The end-of-call report is acknowledged at once. Grading and sync then run in the background (`waitUntil` on Vercel). Failures are kept on the call, and the cron sweep retries them up to 5 times.
- The sweep also closes calls that Vapi never reported as ended, after 3 hours.
