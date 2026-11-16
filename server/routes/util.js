'use strict';
/* Route helpers: async error forwarding, auth guards, CSRF header check. */

// Express 4 does not catch rejected promises; forward them to the error handler.
const h = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

const httpError = (status, message) => Object.assign(new Error(message), { status });

// State-changing API calls must carry X-ACC (set by our fetch wrapper).
function csrf(req, res, next) {
  if (req.method === 'GET' || req.method === 'HEAD') return next();
  if (req.headers['x-acc'] !== '1') return res.status(403).json({ error: 'Missing request header' });
  next();
}

function requireSession(ctx, role, opts) {
  opts = opts || {};
  return (req, res, next) => {
    const s = req.session;
    if (!s) return res.status(401).json({ error: 'Please sign in again' });
    if (opts.agencyOnly && s.kind !== 'agency') return res.status(403).json({ error: 'Agency access only' });
    if (role && !ctx.auth.can(s, role)) return res.status(403).json({ error: 'Your role cannot do this' });
    next();
  };
}

// Loads the session's agency and refuses unlicensed/suspended ones.
function withAgency(ctx) {
  return h(async (req, res, next) => {
    req.agency = await ctx.agencySvc.requireActive(req.session.companyId);
    next();
  });
}

module.exports = { h, httpError, csrf, requireSession, withAgency };
