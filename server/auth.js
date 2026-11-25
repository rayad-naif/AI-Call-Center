'use strict';
/* Sessions, roles and data scoping.

   kind 'agency'   (internal value) company owner/staff: every client of their company.
   kind 'client'  the company's client (e.g. the plumber): exactly one location.

   Roles: owner > admin > manager > viewer.
     owner/admin  keys, deployments, branding, users
     manager      command deck incl. whisper / takeover
     viewer       command deck read-only

   Cookies are SameSite=None because the app runs inside the CRM iframe;
   every state-changing API call must send the X-ACC header (a cross-site form
   cannot), which is the CSRF defence. */
const { sha256 } = require('./security');

const COOKIE = 'acc_s';
const ADMIN_COOKIE = 'acc_admin';
const RANK = { viewer: 1, manager: 2, admin: 3, owner: 4 };
const ROLES = Object.keys(RANK);

function parseCookies(header) {
  const out = {};
  String(header || '').split(';').forEach((p) => {
    const i = p.indexOf('=');
    if (i > 0) { try { out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim()); } catch (e) { /* bad cookie */ } }
  });
  return out;
}

function createAuth(cfg, ctx) {
  const { sec, store } = ctx;

  function cookieAttrs(maxAgeSec) {
    const a = ['Path=/', 'HttpOnly'];
    // Partitioned (CHIPS) keeps the cookie working inside the CRM iframe
    // in browsers that block third-party cookies.
    if (cfg.secureCookies) a.push('Secure', 'SameSite=None', 'Partitioned'); else a.push('SameSite=Lax');
    if (maxAgeSec !== undefined) a.push('Max-Age=' + maxAgeSec);
    return a.join('; ');
  }

  function setSession(res, s, opts) {
    opts = opts || {};
    const ttl = opts.remember ? 7 * 86400e3 : 12 * 3600e3;
    const token = sec.sign(Object.assign({}, s, { exp: Date.now() + ttl }));
    res.append('Set-Cookie', COOKIE + '=' + encodeURIComponent(token) + '; ' + cookieAttrs(opts.remember ? ttl / 1000 : undefined));
  }
  function clearSession(res) { res.append('Set-Cookie', COOKIE + '=; ' + cookieAttrs(0)); }

  function setAdmin(res) {
    res.append('Set-Cookie', ADMIN_COOKIE + '=' + encodeURIComponent(sec.sign({ admin: true, exp: Date.now() + 8 * 3600e3 })) + '; ' + cookieAttrs());
  }
  function clearAdmin(res) { res.append('Set-Cookie', ADMIN_COOKIE + '=; ' + cookieAttrs(0)); }

  // Loads req.session (and validates that the user still exists / session not revoked).
  async function load(req) {
    const c = parseCookies(req.headers.cookie);
    req.isAdmin = !!(c[ADMIN_COOKIE] && sec.unsign(c[ADMIN_COOKIE]));
    const s = c[COOKIE] && sec.unsign(c[COOKIE]);
    if (!s) return null;
    if (s.uid && !s.uid.startsWith('ghl:')) {
      const u = await store.get('users', s.uid);
      if (!u || u.disabled || (u.sessionVersion || 0) !== (s.ver || 0)) return null;
      s.name = u.name || s.name; s.role = u.role; s.locationIds = u.locationIds || null;
    }
    // A custom portal domain only accepts sessions of the company that owns it.
    if (req.brandCompanyId && req.brandCompanyId !== s.companyId) return null;
    req.session = s;
    return s;
  }

  function sessionFromUser(u) {
    return { uid: u._id, kind: u.kind, companyId: u.companyId, role: u.role, name: u.name || '', email: u.email, ver: u.sessionVersion || 0 };
  }

  // Data scope for call queries.
  function scope(s, locationId) {
    if (!s) return null;
    if (s.kind === 'client') {
      const allowed = s.locationIds || (s.locationId ? [s.locationId] : []);
      if (!allowed.length) return null;
      if (locationId && !allowed.includes(locationId)) return null;
      return locationId ? { companyId: s.companyId, locationId } : (allowed.length === 1 ? { companyId: s.companyId, locationId: allowed[0] } : { companyId: s.companyId, locationIds: allowed });
    }
    return locationId ? { companyId: s.companyId, locationId } : { companyId: s.companyId };
  }

  const can = (s, role) => !!s && (RANK[s.role] || 0) >= RANK[role];

  // Stable, non-guessable Voice SDK identity per user.
  const voiceIdentity = (s) => 'acc_' + sha256(s.companyId + ':' + s.uid).slice(0, 24);

  return { load, setSession, clearSession, setAdmin, clearAdmin, sessionFromUser, scope, can, voiceIdentity, parseCookies };
}

module.exports = { createAuth, ROLES, RANK };
