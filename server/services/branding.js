'use strict';
/* White-label branding and custom portal domains.

   An agency sets a name, logo and colors, and can map a domain such as
   calls.agency.com (CNAME -> this app's host). Requests on that host load the
   agency's branding and only accept that agency's logins. */
const dns = require('dns').promises;

const DEFAULT = { name: '', logoUrl: '', primary: '#6d5efc', accent: '#22c55e', hidePoweredBy: false };
const HEX = /^#[0-9a-fA-F]{6}$/;
const HOST = /^(?=.{4,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

function normalizeBranding(input, base) {
  const b = Object.assign({}, DEFAULT, base || {});
  if (input.name !== undefined) b.name = String(input.name).trim().slice(0, 60);
  if (input.logoUrl !== undefined) {
    const u = String(input.logoUrl).trim();
    b.logoUrl = /^https:\/\/[^\s"'<>]{4,500}$/.test(u) ? u : '';
  }
  if (input.primary !== undefined && HEX.test(input.primary)) b.primary = input.primary;
  if (input.accent !== undefined && HEX.test(input.accent)) b.accent = input.accent;
  if (input.hidePoweredBy !== undefined) b.hidePoweredBy = !!input.hidePoweredBy;
  return b;
}

function normalizeHost(h) {
  const host = String(h || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/:\d+$/, '');
  return HOST.test(host) ? host : '';
}

function createBranding(ctx, deps) {
  const { store, cfg } = ctx;
  const resolveCname = (deps && deps.resolveCname) || ((h) => dns.resolveCname(h));
  const cache = new Map();

  async function forHost(host) {
    if (!host || host === cfg.baseHost) return null;
    const hit = cache.get(host);
    if (hit && hit.at > Date.now() - 60e3) return hit.v;
    const d = await store.get('domains', host);
    const v = d && d.verified ? d : null;
    cache.set(host, { v, at: Date.now() });
    return v;
  }

  // Sets req.brand (always) and req.brandCompanyId (custom domains only).
  async function resolve(req) {
    const host = normalizeHost(req.headers.host);
    const d = await forHost(host);
    let brand = Object.assign({}, DEFAULT, { name: cfg.brand.name });
    if (d) {
      const agency = await store.get('agencies', d.companyId);
      if (agency) { brand = Object.assign(brand, agency.branding || {}); req.brandCompanyId = agency._id; }
    }
    if (!brand.name) brand.name = cfg.brand.name;
    req.brand = brand;
  }

  // Branding for a signed-in user on the main host (their agency's look).
  async function forCompany(companyId) {
    const agency = companyId && await store.get('agencies', companyId);
    const b = Object.assign({}, DEFAULT, (agency && agency.branding) || {});
    if (!b.name) b.name = cfg.brand.name;
    return b;
  }

  async function setDomain(agency, rawHost) {
    const host = normalizeHost(rawHost);
    const old = agency.branding && agency.branding.domain;
    if (old && old !== host) { await store.remove('domains', old); cache.delete(old); }
    if (!host) {
      await store.patch('agencies', agency._id, { 'branding.domain': '' });
      return { domain: '', verified: false };
    }
    if (host === cfg.baseHost) throw Object.assign(new Error('Use your own domain'), { status: 400 });
    const taken = await store.get('domains', host);
    if (taken && taken.companyId !== agency._id) throw Object.assign(new Error('That domain is already used by another company'), { status: 409 });
    await store.put('domains', { _id: host, companyId: agency._id, verified: !!(taken && taken.verified), createdAt: (taken && taken.createdAt) || new Date().toISOString() });
    await store.patch('agencies', agency._id, { 'branding.domain': host });
    cache.delete(host);
    return { domain: host, verified: !!(taken && taken.verified) };
  }

  // DNS check (CNAME to our host), then optional automatic Vercel attach.
  async function verifyDomain(agency) {
    const host = agency.branding && agency.branding.domain;
    if (!host) throw Object.assign(new Error('Add a domain first'), { status: 400 });
    let records = [];
    try { records = await resolveCname(host); } catch (e) { /* NXDOMAIN or no CNAME */ }
    const ok = records.map((r) => r.toLowerCase().replace(/\.$/, '')).some((r) => r === cfg.baseHost || r === 'cname.vercel-dns.com');
    if (!ok) {
      return { verified: false, message: 'Add a CNAME record: ' + host + ' -> ' + cfg.baseHost + ' (found: ' + (records.join(', ') || 'none') + '). DNS changes can take a few minutes.' };
    }
    let vercel = null;
    if (cfg.vercel.token && cfg.vercel.projectId) vercel = await attachToVercel(host);
    await store.patch('domains', host, { verified: true, verifiedAt: new Date().toISOString() });
    cache.delete(host);
    await store.log(agency._id, 'domain.verified', host);
    return { verified: true, message: 'Verified' + (vercel ? ' and added to hosting (' + vercel + ')' : '. Make sure the domain is added to your hosting project.') };
  }

  async function attachToVercel(host) {
    const doFetch = (deps && deps.fetch) || fetch;
    const q = cfg.vercel.teamId ? '?teamId=' + encodeURIComponent(cfg.vercel.teamId) : '';
    const r = await doFetch('https://api.vercel.com/v10/projects/' + encodeURIComponent(cfg.vercel.projectId) + '/domains' + q, {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + cfg.vercel.token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: host })
    });
    if (r.ok) return 'added';
    const j = await r.json().catch(() => ({}));
    if (j.error && /already|exists/i.test(j.error.code + ' ' + j.error.message)) return 'already added';
    throw Object.assign(new Error('Hosting rejected the domain: ' + ((j.error && j.error.message) || r.status)), { status: 502 });
  }

  return { resolve, forCompany, setDomain, verifyDomain, normalizeBranding };
}

module.exports = { createBranding, normalizeBranding, normalizeHost, DEFAULT };
