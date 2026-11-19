/* API keys, webhooks and API reference screens, shared by the Super Admin
   portal (base '/api/admin', all companies) and the company console (base
   '/api/company', that company only). */
(function () {
  'use strict';
  const { api, h, toast, fmtTime, busy } = window.ACC;

  const badge = (text, kind) => h('span.badge.' + (kind || 'none'), text);
  const kindOf = (s) => ({ ok: 'live', delivered: 'live', error: 'failed', failed: 'failed', retrying: 'pending', pending: 'pending', cancelled: 'none' }[s] || 'none');
  const copyBtn = (text) => h('button.btn.small', { type: 'button', on: { click: () => { navigator.clipboard && navigator.clipboard.writeText(text); toast('Copied', 'ok'); } } }, 'Copy');
  const table = (head, rows) => h('table.table', h('thead', h('tr', head.map((x) => h('th', x)))),
    h('tbody', rows.length ? rows : h('tr', h('td.muted', { colspan: head.length }, 'Nothing yet.'))));

  /* opts: { base, reload, companyPicker?: () => <select>, companyName?: (id) => string, intro? } */
  async function keys(body, opts) {
    const r = await api('GET', opts.base + '/api-keys');
    const name = h('input', { placeholder: 'Name, e.g. "Zapier" or "Reporting app"' });
    const write = h('input', { type: 'checkbox' });
    const picker = opts.companyPicker ? opts.companyPicker() : null;
    const out = h('div');
    const create = h('button.btn.primary', { type: 'button' }, 'Create key');
    create.addEventListener('click', () => busy(create, async () => {
      try {
        const res = await api('POST', opts.base + '/api-keys', { name: name.value, write: write.checked, companyId: picker ? picker.value || null : undefined });
        out.innerHTML = '';
        out.append(h('div.note.ok', 'Key created. Copy it now: it is shown only once.', h('br'), h('code', res.key), ' ', copyBtn(res.key), ' ', h('button.btn.small', { type: 'button', on: { click: opts.reload } }, 'Done')));
        name.value = '';
      } catch (e) { toast(e.message, 'err'); }
    }));
    const head = ['Name', 'Key', 'Access'].concat(opts.companyName ? ['Company'] : []).concat(['Created', 'Last used', '']);
    body.append(h('div.card', h('h2', 'API keys'),
      h('p.muted', opts.intro || 'Give each app its own key. Read keys can only read; write keys can also send leads.'),
      table(head, r.data.map((k) => h('tr',
        h('td', h('strong', k.name)), h('td', h('code', k.id + '…')), h('td', k.scopes.includes('write') ? 'read + write' : 'read'),
        opts.companyName ? h('td.small', k.companyId ? opts.companyName(k.companyId) : 'All') : null,
        h('td.small', fmtTime(k.createdAt)), h('td.small', fmtTime(k.lastUsedAt) || 'never'),
        h('td', k.revoked ? badge('revoked', 'failed') : h('button.btn.small.danger', { on: { click: async () => {
          if (!confirm('Revoke "' + k.name + '"? Apps using it stop working immediately.')) return;
          await api('DELETE', opts.base + '/api-keys/' + encodeURIComponent(k.id)); opts.reload();
        } } }, 'Revoke'))))),
      h('div.row', h('label', 'Name', name), picker ? h('label', 'Company', picker) : null, h('label.row', write, ' Allow writes (send leads)'), create), out));
  }

  async function webhooks(body, opts) {
    const [w, d] = await Promise.all([api('GET', opts.base + '/webhooks'), api('GET', opts.base + '/webhook-deliveries?limit=50')]);
    const url = h('input', { type: 'url', placeholder: 'https://your-app.com/hooks/calls' });
    const desc = h('input', { placeholder: 'Description' });
    const picker = opts.companyPicker ? opts.companyPicker() : null;
    const evBoxes = w.eventTypes.map((t) => h('label.row', h('input', { type: 'checkbox', value: t }), ' ', h('code', t)));
    const all = h('input', { type: 'checkbox', checked: true });
    const out = h('div');
    const create = h('button.btn.primary', { type: 'button' }, 'Add webhook');
    create.addEventListener('click', () => busy(create, async () => {
      try {
        const events = all.checked ? ['*'] : evBoxes.map((l) => l.querySelector('input')).filter((i) => i.checked).map((i) => i.value);
        const res = await api('POST', opts.base + '/webhooks', { url: url.value, description: desc.value, companyId: picker ? picker.value || null : undefined, events });
        out.innerHTML = '';
        out.append(h('div.note.ok', 'Webhook added. Signing secret (shown once): ', h('code', res.secret), ' ', copyBtn(res.secret), ' ', h('button.btn.small', { type: 'button', on: { click: opts.reload } }, 'Done')));
      } catch (e) { toast(e.message, 'err'); }
    }));
    const head = ['URL', 'Events'].concat(opts.companyName ? ['Company'] : []).concat(['Last delivery', 'Active', '']);
    body.append(
      h('div.card', h('h2', 'Webhooks (' + w.data.length + ')'), h('p.muted', 'Events are sent to your URL as they happen: no polling needed.'),
        table(head, w.data.map((x) => h('tr',
          h('td', h('code', x.url), x.description ? h('div.muted.small', x.description) : null), h('td.small', x.events.join(', ')),
          opts.companyName ? h('td.small', x.companyId ? opts.companyName(x.companyId) : 'All') : null,
          h('td.small', x.lastAt ? badge(x.lastStatus, kindOf(x.lastStatus)) : '—', x.lastAt ? ' ' + fmtTime(x.lastAt) : '', x.failures ? ' · ' + x.failures + ' failing' : ''),
          h('td', x.active ? 'yes' : 'paused'),
          h('td.right.nowrap',
            h('button.btn.small', { on: { click: async () => { const res = await api('POST', opts.base + '/webhooks/' + x.id + '/test', {}).catch((err) => ({ ok: false, error: err.message })); toast(res.ok ? 'Test delivered (HTTP ' + res.code + ')' : 'Test failed: ' + (res.error || 'HTTP ' + res.code), res.ok ? 'ok' : 'err'); opts.reload(); } } }, 'Send test'), ' ',
            h('button.btn.small', { on: { click: async () => { await api('PATCH', opts.base + '/webhooks/' + x.id, { active: !x.active }); opts.reload(); } } }, x.active ? 'Pause' : 'Resume'), ' ',
            h('button.btn.small.danger', { on: { click: async () => { if (confirm('Delete this webhook?')) { await api('DELETE', opts.base + '/webhooks/' + x.id); opts.reload(); } } } }, 'Delete')))))),
      h('div.card.form-grid', h('h2', 'Add a webhook'),
        h('label', 'Endpoint URL (https)', url), h('label', 'Description', desc), picker ? h('label', 'Company', picker) : null,
        h('label.row', all, ' All events'), h('details', h('summary', 'Or choose events'), h('div.event-grid', evBoxes)),
        create, out),
      h('div.card', h('h2', 'Recent deliveries'), table(['When', 'Event', 'Webhook', 'Status', 'Attempts', 'Response'], d.data.map((x) => h('tr',
        h('td.small.nowrap', fmtTime(x.createdAt)), h('td', h('code', x.type)), h('td.small', (w.data.find((y) => y.id === x.hookId) || {}).url || x.hookId),
        h('td', badge(x.status, kindOf(x.status))), h('td', String(x.attempts)), h('td.small', x.lastError || (x.lastCode ? 'HTTP ' + x.lastCode : '—')))))),
      h('div.card', h('h2', 'Verifying deliveries'),
        h('p.muted', 'Each request carries X-ACC-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256 of "t.rawBody" with your signing secret>. Reject it if the HMAC does not match or t is more than 5 minutes old. X-ACC-Event names the event.'),
        h('pre.prompt', [
          "const crypto = require('crypto');",
          'function verify(rawBody, header, secret) {',
          "  const { t, v1 } = Object.fromEntries(header.split(',').map((p) => p.split('=')));",
          "  const want = crypto.createHmac('sha256', secret).update(t + '.' + rawBody).digest('hex');",
          '  const fresh = Math.abs(Date.now() / 1000 - Number(t)) < 300;',
          "  return fresh && crypto.timingSafeEqual(Buffer.from(want), Buffer.from(v1 || ''));",
          '}'].join('\n'))));
  }

  async function reference(body, opts) {
    const ref = await api('GET', opts.base + '/api-reference');
    const base = ref.baseUrl;
    const groups = {};
    ref.endpoints.forEach((e) => { (groups[e.group] = groups[e.group] || []).push(e); });
    const sample = (b) => b.replace(/"active" \| "pending" \| "suspended"/, '"suspended"');
    const curl = (e) => 'curl' + (e.method !== 'GET' ? ' -X ' + e.method : '') + ' "' + base + e.path.replace(/\{(\w+)\}/g, (m, k) => (k === 'companyId' && ref.companyId ? ref.companyId : '<' + k + '>')) + '"' +
      ' \\\n  -H "Authorization: Bearer $API_KEY"' + (e.body ? ' \\\n  -H "Content-Type: application/json" \\\n  -d \'' + sample(e.body) + '\'' : '');
    body.append(h('div.card',
      h('div.row-between', h('h2', 'API reference'), h('div.row', h('a.btn.small', { href: base + '/api/v1/openapi.json', target: '_blank' }, 'OpenAPI JSON'), copyBtn(base + '/api/v1/openapi.json'))),
      h('ul.kv',
        h('li', h('span', 'Base URL'), h('span.row', h('code', base + '/api/v1'), copyBtn(base + '/api/v1'))),
        ref.companyId ? h('li', h('span', 'Your company id'), h('span.row', h('code', ref.companyId), copyBtn(ref.companyId))) : null,
        h('li', h('span', 'Authentication'), h('code', 'Authorization: Bearer <API key>')),
        ref.companyId ? h('li', h('span', 'Data access'), h('span', 'Keys created here only ever see your own company, accounts, calls and leads.')) : null,
        h('li', h('span', 'Format'), h('span', 'JSON. Times are ISO 8601 UTC. Errors: { "error": "message" } with HTTP 400/401/403/404/409/429.')),
        h('li', h('span', 'Pagination'), h('span', 'Lists return { data, nextBefore }. Pass ?before=<nextBefore> for the next page.')),
        h('li', h('span', 'Rate limit'), h('span', '600 requests per minute per key')),
        h('li', h('span', 'Webhook events'), h('code', ref.eventTypes.join(', ')))),
      Object.entries(groups).map(([g, list]) => h('div.api-group', h('h3', g), list.map((e) => h('details.api-ep',
        h('summary', h('span.method.m-' + e.method.toLowerCase(), e.method), ' ', h('code', e.path), ' ', h('span.muted.small', e.summary), ' ', h('span.badge.none', e.scope)),
        e.params && e.params.length ? h('table.table.small', h('tbody', e.params.map((p) => h('tr', h('td', h('code', p.name)), h('td', p.desc))))) : null,
        e.body ? h('div', h('h4', 'Body'), h('pre.prompt', e.body)) : null,
        h('h4', 'Returns'), h('pre.prompt', e.returns),
        h('h4', 'Example'), h('div.row', h('pre.prompt.grow', curl(e)), copyBtn(curl(e))))))),
      h('h3', 'Objects'), Object.entries(ref.shapes).map(([k, v]) => h('div', h('h4', k), h('pre.prompt', v)))));
  }

  window.ACCApiUI = { keys, webhooks, reference };
})();
