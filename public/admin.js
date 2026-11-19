/* Super Admin: agency licenses. */
(function () {
  'use strict';
  const { api, h, toast, fmtTime } = window.ACC;
  const root = document.getElementById('admin');

  async function load() {
    const r = await api('GET', '/api/admin/agencies');
    root.innerHTML = '';
    const rows = r.agencies.map((a) => {
      const sel = h('select', { on: { change: async () => { try { await api('POST', '/api/admin/agencies/' + a.id + '/status', { status: sel.value }); toast('Updated', 'ok'); } catch (e) { toast(e.message, 'err'); } } } },
        ['active', 'pending', 'suspended'].map((s) => h('option', { value: s, selected: s === a.status }, s)));
      return h('tr', h('td', h('strong', a.name), h('div.muted.small', (a.mode === 'account' ? 'Single account · ' : 'Company · ') + a.id)), h('td', a.installed ? (a.apps || []).map((x) => (x === 'agency' ? 'Company app' : 'Account app')).join(' + ') : 'Uninstalled'),
        h('td', fmtTime(a.installedAt)), h('td', String(a.live)), h('td', a.keys.join(', ') || '—'), h('td', a.domain || '—'), h('td', sel));
    });
    const s = await api('GET', '/api/admin/setup');
    const checkRows = (list) => h('table.table', h('tbody', list.map((c) => h('tr', h('td', c.ok ? '✅' : '⚠️'), h('td', h('strong', c.name)), h('td.small', c.detail)))));
    root.append(h('div.card', h('h2', 'Setup'), checkRows(s.checks)));
    s.apps.forEach((a) => {
      const testOut = h('span.small');
      const test = h('button.btn.small', { disabled: !a.configured, on: { click: async () => {
        test.disabled = true;
        const t = await api('POST', '/api/admin/setup/test', { app: a.key }).catch((err) => ({ ok: false, detail: err.message }));
        test.disabled = false;
        testOut.textContent = (t.ok ? '✓ ' : '✗ ') + t.detail;
        testOut.className = 'small ' + (t.ok ? '' : 'warn');
      } } }, 'Test Client ID / Secret');
      root.append(h('div.card',
        h('div.row-between', h('h2', a.label, ' ', h('span.badge.' + (a.configured ? 'live' : 'pending'), a.configured ? 'configured' : 'not configured')), h('div.row', testOut, test)),
        checkRows(a.checks),
        h('h3', 'Paste into this app\'s settings'),
        h('ul.kv', Object.entries(a.paste).map(([k, v]) => h('li', h('span', k), h('code', v))))));
    });
    root.append(h('h1', 'Companies (' + r.agencies.length + ')'), h('div.card', h('table.table',
      h('thead', h('tr', ['Company', 'App', 'Installed', 'Live clients', 'Keys OK', 'Domain', 'License'].map((t) => h('th', t)))), h('tbody', rows))));
    const ev = await api('GET', '/api/admin/events');
    root.append(h('div.card', h('h2', 'Recent activity'), h('table.table', h('tbody', ev.events.map((e) => h('tr', h('td.nowrap', fmtTime(e.at)), h('td.small', e.companyId || ''), h('td', h('code', e.type)), h('td', e.detail)))))));
  }
  load().catch((e) => { root.innerHTML = ''; root.append(h('p.error', e.message)); });
})();
