'use strict';
/* Agency-level helpers: BYOK keys (encrypted at rest), GHL tokens with
   refresh, and location tokens cached per deployment. */
const { mask } = require('../security');

const KEY_FIELDS = ['twilioSid', 'twilioToken', 'vapiKey', 'openaiKey'];
const SECRET_FIELDS = { twilioToken: 1, vapiKey: 1, openaiKey: 1 };

function createAgencyService(ctx) {
  const { store, sec, ghl } = ctx;

  function keys(agency) {
    const k = (agency && agency.keys) || {};
    return {
      twilioSid: k.twilioSid || '',
      twilioToken: sec.decrypt(k.twilioToken),
      vapiKey: sec.decrypt(k.vapiKey),
      openaiKey: sec.decrypt(k.openaiKey)
    };
  }

  // What the UI may see: never a secret, only whether it is set + last 4.
  function publicKeys(agency) {
    const k = keys(agency);
    const out = {};
    KEY_FIELDS.forEach((f) => { out[f] = { set: !!k[f], hint: SECRET_FIELDS[f] ? mask(k[f]) : k[f] }; });
    out.status = (agency && agency.keyStatus) || {};
    return out;
  }

  function encryptKeys(input, existing) {
    const out = Object.assign({}, existing || {});
    KEY_FIELDS.forEach((f) => {
      if (typeof input[f] !== 'string') return;
      const v = input[f].trim();
      if (!v) return; // blank = keep current
      out[f] = SECRET_FIELDS[f] ? sec.encrypt(v) : v;
    });
    return out;
  }

  /* ---- HighLevel tokens ---- */
  async function agencyToken(agency) {
    const t = agency.ghl || {};
    const access = sec.decrypt(t.accessToken);
    if (access && t.expiresAt && Date.now() < t.expiresAt - 120e3) return access;
    const refreshToken = sec.decrypt(t.refreshToken);
    if (!refreshToken) throw new Error('The CRM is not connected for this company. Reinstall the app.');
    let r;
    try {
      r = await ghl.refresh(refreshToken);
    } catch (e) {
      // HighLevel refresh tokens are single-use. If a parallel request (another
      // serverless instance) refreshed first, use the token it saved.
      const fresh = await store.get('agencies', agency._id);
      const ft = (fresh && fresh.ghl) || {};
      if (ft.refreshToken !== t.refreshToken && sec.decrypt(ft.accessToken) && ft.expiresAt > Date.now() + 60e3) {
        agency.ghl = ft;
        return sec.decrypt(ft.accessToken);
      }
      if (e.status === 400 || e.status === 401) {
        throw Object.assign(new Error('CRM access was revoked or expired. Reinstall the app from the Marketplace to reconnect.'), { status: 409 });
      }
      throw e;
    }
    const ghlDoc = {
      accessToken: sec.encrypt(r.access_token),
      refreshToken: sec.encrypt(r.refresh_token || refreshToken),
      expiresAt: Date.now() + (Number(r.expires_in) || 86399) * 1000,
      scope: r.scope || t.scope || ''
    };
    await store.patch('agencies', agency._id, { ghl: ghlDoc });
    agency.ghl = ghlDoc;
    return r.access_token;
  }

  async function agencyApi(agency) { return ghl.api(await agencyToken(agency)); }

  // Location token, cached on the deployment (falls back to a per-process cache).
  const memo = new Map();
  async function locationApi(agency, locationId) {
    const dep = await store.get('deployments', locationId);
    const cached = dep && dep.ghlToken;
    let token = cached && cached.expiresAt > Date.now() + 120e3 ? sec.decrypt(cached.accessToken) : '';
    if (!token) {
      const m = memo.get(locationId);
      if (m && m.expiresAt > Date.now() + 120e3) token = m.token;
    }
    if (!token) {
      const agencyAccess = await agencyToken(agency);
      let r;
      try {
        r = await ghl.locationToken(agencyAccess, agency._id, locationId);
      } catch (e) {
        if (e.status >= 400 && e.status < 500) {
          throw Object.assign(new Error('The app is not installed in this account yet. In the CRM, open the app in the Marketplace and install it to this account (or enable it for all accounts), then try again.'), { status: 409, provider: 'CRM' });
        }
        throw e;
      }
      token = r.access_token;
      const expiresAt = Date.now() + (Number(r.expires_in) || 86399) * 1000;
      memo.set(locationId, { token, expiresAt });
      if (dep) await store.patch('deployments', locationId, { ghlToken: { accessToken: sec.encrypt(token), expiresAt } });
    }
    return ghl.api(token);
  }

  async function requireActive(companyId) {
    const a = await store.get('agencies', companyId);
    if (!a || !a.installed) throw Object.assign(new Error('This company has not installed the app.'), { status: 403 });
    if (a.status === 'suspended') throw Object.assign(new Error('This license is suspended. Contact support.'), { status: 403 });
    if (a.status === 'pending') throw Object.assign(new Error('This license is waiting for approval.'), { status: 403 });
    return a;
  }

  return { keys, publicKeys, encryptKeys, agencyToken, agencyApi, locationApi, requireActive };
}

module.exports = { createAgencyService, KEY_FIELDS };
