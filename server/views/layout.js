'use strict';
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const HEX = /^#[0-9a-fA-F]{6}$/;

function page(req, o) {
  const b = (o.brand || req.brand || {});
  const primary = HEX.test(b.primary) ? b.primary : '#6d5efc';
  const accent = HEX.test(b.accent) ? b.accent : '#22c55e';
  const name = b.name || 'AI Call Center';
  const logo = b.logoUrl ? '<img src="' + esc(b.logoUrl) + '" alt="" class="brand-logo">' : '<span class="brand-mark" aria-hidden="true"></span>';
  const scripts = (o.scripts || []).map((s) => '<script src="' + esc(s) + '"' + (s.startsWith('/static/') ? ' defer' : ' defer crossorigin="anonymous"') + '></script>').join('');
  const data = o.data ? '<script id="boot" type="application/json">' + JSON.stringify(o.data).replace(/</g, '\\u003c') + '</script>' : '';
  return '<!doctype html><html lang="en"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">' +
    '<title>' + esc(o.title ? o.title + ' · ' + name : name) + '</title>' +
    '<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 24 24%22%3E%3Cpath fill=%22' + encodeURIComponent(primary) + '%22 d=%22M6.6 10.8a15.1 15.1 0 0 0 6.6 6.6l2.2-2.2c.3-.3.7-.4 1-.2 1.1.4 2.3.6 3.6.6.6 0 1 .4 1 1V20c0 .6-.4 1-1 1A17 17 0 0 1 3 4c0-.6.4-1 1-1h3.5c.6 0 1 .4 1 1 0 1.3.2 2.5.6 3.6.1.3 0 .7-.2 1z%22/%3E%3C/svg%3E">' +
    '<link rel="stylesheet" href="/static/app.css">' +
    '<style>:root{--brand:' + primary + ';--accent:' + accent + '}</style>' +
    '</head><body class="' + esc(o.bodyClass || '') + '">' +
    (o.bare ? '' : '<header class="topbar"><a class="brand" href="/">' + logo + '<span>' + esc(name) + '</span></a><nav id="topnav">' + (o.nav || '') + '</nav></header>') +
    '<main id="main" class="' + esc(o.mainClass || 'container') + '">' + o.body + '</main>' +
    (o.footer === false || b.hidePoweredBy ? '' : '<footer class="foot"><a href="/docs">Docs</a><a href="/privacy">Privacy</a><a href="/terms">Terms</a></footer>') +
    data + '<script src="/static/common.js" defer></script>' + scripts +
    '</body></html>';
}

module.exports = { page, esc };
