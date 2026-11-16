'use strict';
/* HighLevel API v2. The marketplace app installs at agency (Company) level;
   location-scoped calls use a location token minted from the agency token
   (POST /oauth/locationToken), so the agency never pastes a GHL API key. */
const crypto = require('crypto');
const { createHttp, ApiError } = require('./http');

function createGhl(cfg, fetchImpl) {
  const g = cfg.ghl;
  const http = createHttp('HighLevel', fetchImpl);

  function authorizeUrl(state) {
    const u = new URL(g.authUrl);
    u.searchParams.set('response_type', 'code');
    u.searchParams.set('redirect_uri', cfg.redirectUri);
    u.searchParams.set('client_id', g.clientId);
    u.searchParams.set('scope', g.scopes);
    if (state) u.searchParams.set('state', state);
    return u.toString();
  }

  const tokenRequest = (params) => http(g.apiBase + '/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams(Object.assign({ client_id: g.clientId, client_secret: g.clientSecret, user_type: 'Company' }, params)).toString()
  });

  async function exchangeCode(code) {
    const t = await tokenRequest({ grant_type: 'authorization_code', code, redirect_uri: cfg.redirectUri });
    if (!t || t.userType !== 'Company' || !t.companyId) {
      throw new ApiError('HighLevel', 'This app must be installed by an agency (got a ' + ((t && t.userType) || 'unknown') + ' level token).', 400, t);
    }
    return t;
  }
  const refresh = (refreshToken) => tokenRequest({ grant_type: 'refresh_token', refresh_token: refreshToken });

  // Location token from an agency token (needs oauth.write).
  const locationToken = (agencyToken, companyId, locationId) => http(g.apiBase + '/oauth/locationToken', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + agencyToken, Version: g.apiVersion, 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams({ companyId, locationId }).toString()
  });

  function api(token) {
    const call = (method, path, body, query) => {
      let url = g.apiBase + path;
      if (query) {
        const q = new URLSearchParams(Object.entries(query).filter(([, v]) => v !== undefined && v !== null && v !== '')).toString();
        if (q) url += '?' + q;
      }
      return http(url, {
        method,
        headers: Object.assign({ Authorization: 'Bearer ' + token, Version: g.apiVersion, Accept: 'application/json' }, body ? { 'Content-Type': 'application/json' } : {}),
        body: body ? JSON.stringify(body) : undefined
      });
    };
    return {
      raw: call,
      // Agency token
      getCompany: async (companyId) => { const j = await call('GET', '/companies/' + encodeURIComponent(companyId)); return (j && j.company) || j; },
      searchLocations: async (companyId, skip) => ((await call('GET', '/locations/search', null, { companyId, limit: 100, skip: skip || 0 })) || {}).locations || [],
      getLocation: async (locationId) => { const j = await call('GET', '/locations/' + encodeURIComponent(locationId)); return (j && j.location) || j; },
      // Location token
      listCustomFields: async (locationId) => ((await call('GET', '/locations/' + encodeURIComponent(locationId) + '/customFields', null, { model: 'contact' })) || {}).customFields || [],
      createCustomField: async (locationId, f) => { const j = await call('POST', '/locations/' + encodeURIComponent(locationId) + '/customFields', f); return (j && j.customField) || j; },
      listPipelines: async (locationId) => ((await call('GET', '/opportunities/pipelines', null, { locationId })) || {}).pipelines || [],
      listCalendars: async (locationId) => ((await call('GET', '/calendars/', null, { locationId })) || {}).calendars || [],
      freeSlots: (calendarId, startMs, endMs, timezone) => call('GET', '/calendars/' + encodeURIComponent(calendarId) + '/free-slots', null, { startDate: startMs, endDate: endMs, timezone }),
      bookAppointment: (a) => call('POST', '/calendars/events/appointments', a),
      upsertContact: async (c) => { const j = await call('POST', '/contacts/upsert', c); return (j && j.contact) || j; },
      getContact: async (id) => { const j = await call('GET', '/contacts/' + encodeURIComponent(id)); return (j && j.contact) || j; },
      updateContact: (id, c) => call('PUT', '/contacts/' + encodeURIComponent(id), c),
      addTags: (id, tags) => call('POST', '/contacts/' + encodeURIComponent(id) + '/tags', { tags }),
      addNote: (id, body) => call('POST', '/contacts/' + encodeURIComponent(id) + '/notes', { body }),
      upsertOpportunity: (o) => call('POST', '/opportunities/upsert', o)
    };
  }

  /* Webhook signatures. true = valid, false = invalid, null = no keys configured. */
  function verifyWebhook(rawBody, headers) {
    const ed = headers['x-ghl-signature'];
    const rsa = headers['x-wh-signature'];
    if (!g.webhookEd25519Key && !g.webhookRsaKey) return null;
    try {
      if (ed && g.webhookEd25519Key) return crypto.verify(null, rawBody, g.webhookEd25519Key, Buffer.from(ed, 'base64'));
      if (rsa && g.webhookRsaKey) return crypto.verify('sha256', rawBody, g.webhookRsaKey, Buffer.from(rsa, 'base64'));
    } catch (e) { return false; }
    return false;
  }

  return { authorizeUrl, exchangeCode, refresh, locationToken, api, verifyWebhook };
}

module.exports = { createGhl };
