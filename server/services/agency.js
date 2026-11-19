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
      r = await ghl.refresh(refreshToken, agency.mode === 'account' ? 'Location' : 'Company', edition(agency));
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
    // Keep the per-app copy in step (a workspace can have both apps installed).
    await store.patch('agencies', agency._id, { ghl: ghlDoc, ['ghlApps.' + edition(agency)]: ghlDoc });
    agency.ghl = ghlDoc;
    return r.access_token;
  }

  // Which Marketplace app this workspace runs on: 'standard' or 'agency'.
  function edition(agency) { return agency && agency.app === 'agency' ? 'agency' : 'standard'; }

  async function agencyApi(agency) { return ghl.api(await agencyToken(agency)); }

  // Location token, cached on the deployment (falls back to a per-process cache).
  const memo = new Map();

  /* Sub-account Private Integration token (agency edition, or any account where
     the app is not installed). Stored encrypted, one per sub-account. */
  async function crmTokenDoc(agency, locationId) {
    const doc = await store.get('crmTokens', locationId);
    return doc && doc.companyId === agency._id && doc.token ? doc : null;
  }
  async function hasCrmToken(agency, locationId) { return !!(await crmTokenDoc(agency, locationId)); }
  async function crmTokenIds(agency) {
    return new Set((await store.find('crmTokens', { companyId: agency._id })).filter((d) => d.token).map((d) => d._id));
  }
  // Checks the token against the account before saving it.
  async function setCrmToken(agency, locationId, token) {
    token = String(token || '').trim();
    if (!/^[\w.-]{20,4096}$/.test(token)) throw Object.assign(new Error('Paste the full Private Integration token from the account.'), { status: 400 });
    const api = ghl.api(token);
    let loc;
    try { loc = await api.getLocation(locationId); } catch (e) {
      throw Object.assign(new Error(e.status === 401 || e.status === 403
        ? 'The CRM rejected this token for this account. Create it inside this account (Settings > Private Integrations) with the scopes listed in the CRM connection box.'
        : 'Could not check the token: ' + e.message.replace(/^\w+: /, '')), { status: 400 });
    }
    const id = loc && (loc.id || loc._id);
    if (id && id !== locationId) throw Object.assign(new Error('This token belongs to a different account.'), { status: 400 });
    // Contacts access is the minimum the call center needs.
    try { await api.raw('GET', '/contacts/', null, { locationId, limit: 1 }); } catch (e) {
      if (e.status === 401 || e.status === 403) throw Object.assign(new Error('The token is missing contact access. Give it every scope listed in the CRM connection box.'), { status: 400 });
    }
    await store.put('crmTokens', { _id: locationId, companyId: agency._id, token: sec.encrypt(token), name: (loc && loc.name) || '', updatedAt: new Date().toISOString() });
    memo.delete(locationId);
    const dep = await store.get('deployments', locationId);
    if (dep && dep.ghlToken) await store.patch('deployments', locationId, { ghlToken: null });
    return { name: (loc && loc.name) || '' };
  }
  async function clearCrmToken(agency, locationId) {
    const doc = await crmTokenDoc(agency, locationId);
    if (doc) await store.put('crmTokens', { _id: locationId, companyId: agency._id, token: '', updatedAt: new Date().toISOString() });
    memo.delete(locationId);
  }

  async function locationApi(agency, locationId) {
    // Single-account workspace: its own install token is already a location token.
    if (agency.mode === 'account') {
      if (locationId !== agency.locationId) throw Object.assign(new Error('This workspace can only manage its own account.'), { status: 403 });
      return ghl.api(await agencyToken(agency));
    }
    // A Private Integration token for this sub-account wins over minted tokens.
    const pit = await crmTokenDoc(agency, locationId);
    if (pit) {
      const token = sec.decrypt(pit.token);
      if (token) return ghl.api(token);
    }
    if (edition(agency) === 'agency') {
      throw Object.assign(new Error('Connect this account first: paste a Private Integration token from the account in its CRM connection box.'), { status: 409, provider: 'CRM' });
    }
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

  return { keys, publicKeys, encryptKeys, agencyToken, agencyApi, locationApi, requireActive, hasCrmToken, crmTokenIds, setCrmToken, clearCrmToken, edition };
}

module.exports = { createAgencyService, KEY_FIELDS };
