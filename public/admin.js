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
      return h('tr', h('td', h('strong', a.name), h('div.muted.small', a.id)), h('td', a.installed ? 'Installed' : 'Uninstalled'),
        h('td', fmtTime(a.installedAt)), h('td', String(a.live)), h('td', a.keys.join(', ') || '—'), h('td', a.domain || '—'), h('td', sel));
    });
    root.append(h('h1', 'Agencies (' + r.agencies.length + ')'), h('div.card', h('table.table',
      h('thead', h('tr', ['Agency', 'App', 'Installed', 'Live clients', 'Keys OK', 'Domain', 'License'].map((t) => h('th', t)))), h('tbody', rows))));
    const ev = await api('GET', '/api/admin/events');
    root.append(h('div.card', h('h2', 'Recent activity'), h('table.table', h('tbody', ev.events.map((e) => h('tr', h('td.nowrap', fmtTime(e.at)), h('td.small', e.companyId || ''), h('td', h('code', e.type)), h('td', e.detail)))))));
  }
  load().catch((e) => { root.innerHTML = ''; root.append(h('p.error', e.message)); });
})();
