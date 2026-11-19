/* Super Admin portal: the whole platform. It reads through the same public
   REST API (/api/v1) your other apps use, with the admin session. */
(function () {
  'use strict';
  const { api, h, toast, fmtTime, fmtDur, busy } = window.ACC;
  const root = document.getElementById('admin');
  const TABS = [['dashboard', 'Dashboard'], ['companies', 'Companies'], ['calls', 'Calls'], ['leads', 'Leads'], ['activity', 'Activity'], ['webhooks', 'Webhooks'], ['api', 'API'], ['setup', 'Setup']];
  const OUT = { appointment_booked: 'Booked', qualified_lead: 'Qualified lead', support_resolved: 'Resolved', support_ticket: 'Ticket', not_interested: 'Not interested', spam: 'Spam', voicemail: 'Voicemail', other: 'Other' };
  const S = { companies: null };

  const qs = (o) => { const p = new URLSearchParams(); Object.entries(o).forEach(([k, v]) => { if (v !== '' && v != null) p.set(k, v); }); const s = p.toString(); return s ? '?' + s : ''; };
  const badge = (text, kind) => h('span.badge.' + (kind || 'none'), text);
  const statusKind = (s) => ({ active: 'live', live: 'live', connected: 'live', delivered: 'live', done: 'live', ok: 'live', pending: 'pending', queued: 'pending', calling: 'pending', deploying: 'pending', retrying: 'pending', running: 'pending', draft: 'pending', suspended: 'failed', failed: 'failed', error: 'failed', unreached: 'failed', removed: 'none' }[s] || 'none');
  const stat = (label, value, sub) => h('div.stat', h('div.stat-v', String(value)), h('div.stat-l', label), sub ? h('div.stat-sub', sub) : null);
  const table = (head, rows, onRow) => h('table.table', h('thead', h('tr', head.map((x) => h('th', x)))),
    h('tbody', rows.length ? rows.map((r) => { const tr = h('tr', { class: onRow ? 'click' : '' }, r.cells); if (onRow) tr.addEventListener('click', () => onRow(r.item)); return tr; }) : h('tr', h('td.muted', { colspan: head.length }, 'Nothing yet.'))));
  const copyBtn = (text) => h('button.btn.small', { type: 'button', on: { click: () => { navigator.clipboard && navigator.clipboard.writeText(text); toast('Copied', 'ok'); } } }, 'Copy');
  const companyName = (id) => { const c = (S.companies || []).find((x) => x.id === id); return c ? c.name : id; };
  async function companies() { if (!S.companies) S.companies = (await api('GET', '/api/v1/companies')).data; return S.companies; }
  function companySelect(value, allLabel) {
    const sel = h('select', h('option', { value: '' }, allLabel || 'All companies'));
    (S.companies || []).forEach((c) => sel.append(h('option', { value: c.id, selected: c.id === value }, c.name + (c.type === 'single_account' ? ' (single account)' : ''))));
    return sel;
  }

  function bars(daily) {
    const W = 760, H = 140, max = Math.max(1, ...daily.map((d) => d.calls)), bw = W / daily.length;
    const ns = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('viewBox', '0 0 ' + W + ' ' + (H + 18)); svg.setAttribute('class', 'chart');
    daily.forEach((d, i) => {
      [['bar', d.calls], ['bar booked', d.booked]].forEach(([cls, v]) => {
        const r = document.createElementNS(ns, 'rect');
        const hh = (v / max) * (H - 6);
        r.setAttribute('x', i * bw + bw * 0.15); r.setAttribute('width', bw * 0.7); r.setAttribute('y', H - hh); r.setAttribute('height', hh); r.setAttribute('rx', 2); r.setAttribute('class', cls);
        const t = document.createElementNS(ns, 'title'); t.textContent = d.date + ': ' + d.calls + ' calls, ' + d.booked + ' booked'; r.append(t);
        svg.append(r);
      });
      if (i % Math.ceil(daily.length / 8) === 0) { const tx = document.createElementNS(ns, 'text'); tx.setAttribute('x', i * bw + bw / 2); tx.setAttribute('y', H + 14); tx.setAttribute('class', 'axis'); tx.setAttribute('text-anchor', 'middle'); tx.textContent = d.date.slice(5); svg.append(tx); }
    });
    return svg;
  }

  function modal(title, body) {
    const dlg = h('dialog.modal', h('div.row-between', h('h2', title), h('form', { method: 'dialog' }, h('button.btn.small', 'Close'))), body);
    document.body.append(dlg);
    dlg.addEventListener('close', () => dlg.remove());
    dlg.showModal();
  }

  /* ---------- router ---------- */
  async function route() {
    const [tab, sub] = (location.hash.slice(1) || 'dashboard').split('/');
    root.innerHTML = '';
    root.append(h('nav.tabs', TABS.map(([k, l]) => h('a', { href: '#' + k, class: k === tab ? 'active' : '' }, l))));
    const body = h('section.tab-body', h('div.spinner'));
    root.append(body);
    try {
      await companies();
      body.innerHTML = '';
      await ({ dashboard, companies: sub ? (b) => companyDetail(b, decodeURIComponent(sub)) : companiesTab, calls: callsTab, leads: leadsTab, activity: activityTab, webhooks: webhooksTab, api: apiTab, setup: setupTab }[tab] || dashboard)(body);
    } catch (e) { body.innerHTML = ''; body.append(h('p.error', e.message)); }
  }
  window.addEventListener('hashchange', route);

  /* ---------- dashboard ---------- */
  async function dashboard(body) {
    const [s, setup] = await Promise.all([api('GET', '/api/v1/stats?days=30'), api('GET', '/api/admin/setup')]);
    const cs = S.companies;
    const count = (f) => cs.filter(f).length;
    const accounts = cs.reduce((n, c) => n + c.accounts.live, 0);
    const failing = cs.reduce((n, c) => n + c.accounts.failed, 0);
    const warnings = setup.checks.filter((c) => !c.ok).concat(...setup.apps.filter((a) => a.configured).map((a) => a.checks.filter((c) => !c.ok)));
    body.append(
      h('div.stats',
        stat('Companies', count((c) => c.installed && c.type === 'company'), count((c) => c.status === 'pending') + ' pending · ' + count((c) => c.status === 'suspended') + ' suspended'),
        stat('Single accounts', count((c) => c.installed && c.type === 'single_account')),
        stat('Live call centers', accounts, failing ? failing + ' failed deploys' : 'no failed deploys'),
        stat('Live calls now', s.calls.live),
        stat('Calls (30d)', s.calls.total, s.calls.minutes + ' minutes'),
        stat('Booked (30d)', s.calls.booked),
        stat('Avg QA', s.calls.avgScore == null ? '—' : s.calls.avgScore, s.calls.alerts + ' calls with alerts'),
        stat('Voice cost (30d)', '$' + s.calls.cost.toFixed(2)),
        stat('Leads (30d)', s.leads.total, (s.leads.byStatus.connected || 0) + ' connected'),
        stat('CRM sync', s.crmSync.failed ? s.crmSync.failed + ' failed' : 'healthy', s.crmSync.pending + ' pending')),
      h('div.card', h('h2', 'Calls per day (30 days)'), h('p.legend', h('span.sw'), ' calls ', h('span.sw.booked'), ' booked'), bars(s.daily)),
      h('div.report-grid',
        h('div.card', h('h2', 'Top companies (30d)'), table(['Company', 'Calls', 'Booked', 'Minutes'], s.topCompanies.map((t) => ({ item: t, cells: [h('td', companyName(t.companyId)), h('td', String(t.calls)), h('td', String(t.booked)), h('td', String(t.minutes))] })), (t) => { location.hash = '#companies/' + encodeURIComponent(t.companyId); })),
        h('div.card', h('h2', 'Needs attention'),
          warnings.length || failing || s.crmSync.failed
            ? h('ul.alert-list', warnings.map((w) => h('li', w.name + ': ' + w.detail)), failing ? h('li', failing + ' call center deploys failed (see Companies)') : null, s.crmSync.failed ? h('li', s.crmSync.failed + ' calls failed to sync to the CRM (Calls > filter "sync failed")') : null)
            : h('p.muted', 'All good.'))));
  }

  /* ---------- companies ---------- */
  async function companiesTab(body) {
    S.companies = null; await companies();
    const q = h('input', { type: 'search', placeholder: 'Search name, id or domain…' });
    const st = h('select', ['', 'active', 'pending', 'suspended'].map((v) => h('option', { value: v }, v || 'Any license')));
    const ty = h('select', [['', 'Any type'], ['company', 'Companies'], ['single_account', 'Single accounts']].map(([v, l]) => h('option', { value: v }, l)));
    const box = h('div');
    const draw = () => {
      const t = q.value.toLowerCase();
      const rows = S.companies.filter((c) => (!t || (c.name + ' ' + c.id + ' ' + c.branding.domain).toLowerCase().includes(t)) && (!st.value || c.status === st.value) && (!ty.value || c.type === ty.value));
      box.innerHTML = '';
      box.append(table(['Company', 'Apps', 'License', 'Installed', 'Call centers', 'Provider keys', 'Domain'], rows.map((c) => ({ item: c, cells: [
        h('td', h('strong', c.name), h('div.muted.small', (c.type === 'single_account' ? 'Single account · ' : 'Company · ') + c.id)),
        h('td.small', c.installed ? c.apps.map((a) => (a === 'company_app' ? 'Company app' : 'Account app')).join(' + ') : badge('uninstalled', 'failed')),
        h('td', badge(c.status, statusKind(c.status))),
        h('td.small', fmtTime(c.installedAt)),
        h('td', c.accounts.live + ' live' + (c.accounts.failed ? ' · ' : ''), c.accounts.failed ? badge(c.accounts.failed + ' failed', 'failed') : null),
        h('td.small', ['twilio', 'vapi', 'openai'].map((k) => (c.providerKeys[k] ? '✓ ' : '✗ ') + k).join('  ')),
        h('td.small', c.branding.domain || '—')] })), (c) => { location.hash = '#companies/' + encodeURIComponent(c.id); }));
    };
    [q, st, ty].forEach((el) => el.addEventListener('input', draw));
    body.append(h('div.card', h('div.row-between', h('h2', 'Companies (' + S.companies.length + ')'), h('div.row', q, st, ty)), box));
    draw();
  }

  async function companyDetail(body, id) {
    const [c, calls, leads, events, st] = await Promise.all([
      api('GET', '/api/v1/companies/' + encodeURIComponent(id)),
      api('GET', '/api/v1/calls' + qs({ companyId: id, limit: 20 })),
      api('GET', '/api/v1/leads' + qs({ companyId: id, limit: 20 })),
      api('GET', '/api/v1/events' + qs({ companyId: id, limit: 30 })),
      api('GET', '/api/v1/stats' + qs({ companyId: id, days: 30 }))
    ]);
    const lic = h('select', ['active', 'pending', 'suspended'].map((s) => h('option', { value: s, selected: s === c.status }, s)));
    lic.addEventListener('change', async () => {
      try { await api('PATCH', '/api/v1/companies/' + encodeURIComponent(id), { status: lic.value }); S.companies = null; toast('License ' + lic.value, 'ok'); } catch (e) { toast(e.message, 'err'); }
    });
    body.append(
      h('p', h('a', { href: '#companies' }, '← All companies')),
      h('div.card', h('div.row-between', h('div', h('h1', c.name), h('p.muted', (c.type === 'single_account' ? 'Single account' : 'Company') + ' · ' + c.id)), h('label', 'License', lic)),
        h('ul.kv',
          h('li', h('span', 'Apps installed'), h('strong', c.installed ? c.apps.map((a) => (a === 'company_app' ? 'Company app' : 'Account app')).join(' + ') : 'Uninstalled' + (c.uninstalledAt ? ' (' + fmtTime(c.uninstalledAt) + ')' : ''))),
          h('li', h('span', 'Installed'), h('strong', fmtTime(c.installedAt) || '—')),
          h('li', h('span', 'CRM company id'), h('code', c.crmCompanyId || '—')),
          c.accountId ? h('li', h('span', 'CRM account id'), h('code', c.accountId)) : null,
          h('li', h('span', 'Provider keys'), h('strong', ['twilio', 'vapi', 'openai'].map((k) => (c.providerKeys[k] ? '✓ ' : '✗ ') + k).join('   '))),
          h('li', h('span', 'Takeover line'), h('strong', c.takeoverLine || '—')),
          h('li', h('span', 'Brand / domain'), h('strong', (c.branding.name || '—') + ' / ' + (c.branding.domain || '—'))))),
      h('div.stats', stat('Calls (30d)', st.calls.total, st.calls.minutes + ' min'), stat('Booked', st.calls.booked), stat('Avg QA', st.calls.avgScore == null ? '—' : st.calls.avgScore), stat('Voice cost', '$' + st.calls.cost.toFixed(2)), stat('Leads', st.leads.total), stat('CRM sync failed', st.crmSync.failed)),
      h('div.card', h('h2', 'Call centers (' + c.accounts.length + ')'), table(['Account', 'Status', 'Number', 'Features', 'Deployed', 'Last error'], c.accounts.map((a) => ({ item: a, cells: [
        h('td', h('strong', a.name || a.id), h('div.muted.small', a.id)), h('td', badge(a.status, statusKind(a.status))), h('td', a.phoneNumber || '—'),
        h('td.small', Object.entries(a.features).filter(([, v]) => v).map(([k]) => k).join(', ') || '—'), h('td.small', fmtTime(a.deployedAt) || '—'), h('td.small.warn', a.lastError || '')] })), (a) => modal(a.name || a.id, h('div', h('ul.kv', a.steps.map((s) => h('li', h('span', s.key), h('span', badge(s.status, statusKind(s.status)), ' ', h('span.small', s.detail))))), h('pre.prompt', JSON.stringify(a, null, 2)))))),
      h('div.card', h('h2', 'Users (' + c.users.length + ')'), table(['User', 'Type', 'Role', 'Last sign-in', ''], c.users.map((u) => ({ item: u, cells: [h('td', h('strong', u.name || u.email), h('div.muted.small', u.email)), h('td', u.kind), h('td', u.role), h('td.small', fmtTime(u.lastLoginAt) || '—'), h('td', u.disabled ? badge('disabled', 'failed') : '')] })))),
      h('div.card', h('div.row-between', h('h2', 'Recent calls'), h('a.btn.small', { href: '#calls', on: { click: () => { S.callFilter = { companyId: id }; } } }, 'All calls')), callTable(calls.data)),
      h('div.card', h('h2', 'Recent leads'), leadTable(leads.data)),
      h('div.card', h('h2', 'Activity'), eventTable(events.data)));
  }

  /* ---------- calls ---------- */
  function callTable(rows) {
    return table(['When', 'Company', 'Caller', 'Direction', 'Agent', 'Duration', 'Outcome', 'QA', 'CRM sync'], rows.map((c) => ({ item: c, cells: [
      h('td.small.nowrap', fmtTime(c.createdAt)), h('td.small', companyName(c.companyId)), h('td', c.customer.name || c.customer.number || '—'),
      h('td.small', c.direction), h('td.small', c.agent || '—'), h('td.small', c.live ? badge('live', 'live') : fmtDur(c.durationSec || 0)),
      h('td.small', c.grade ? OUT[c.grade.outcome] || c.grade.outcome : '—', c.alerts.length ? h('span.badge.alert', '⚠ ' + c.alerts.length) : null),
      h('td', c.grade ? String(c.grade.score) : '—'), h('td', c.crmSync ? badge(c.crmSync.state, statusKind(c.crmSync.state)) : '—')] })), showCall);
  }
  async function showCall(c) {
    const d = await api('GET', '/api/v1/calls/' + encodeURIComponent(c.id));
    modal((d.customer.name || d.customer.number || 'Call') + ' · ' + fmtTime(d.createdAt), h('div',
      h('ul.kv', h('li', h('span', 'Company / account'), h('span', companyName(d.companyId) + ' / ' + d.accountId)), h('li', h('span', 'Status'), h('span', d.status + (d.endedReason ? ' (' + d.endedReason + ')' : ''))),
        h('li', h('span', 'QA'), h('span', d.grade ? d.grade.score + '/100 · ' + d.grade.sentiment + ' · ' + (OUT[d.grade.outcome] || d.grade.outcome) : '—')),
        h('li', h('span', 'CRM sync'), h('span', d.crmSync ? d.crmSync.state + (d.crmSync.error ? ': ' + d.crmSync.error : '') + (d.crmSync.sms ? ' · SMS ' + d.crmSync.sms : '') : '—')),
        d.recordingUrl ? h('li', h('span', 'Recording'), h('audio', { controls: true, preload: 'none', src: d.recordingUrl })) : null),
      d.summary ? h('p', d.summary) : null,
      d.alerts.length ? h('ul.alert-list', d.alerts.map((a) => h('li', '⚠ ' + a.text))) : null,
      h('div.transcript.modal-transcript', d.transcript.map((l) => h('div.line.' + l.role, h('span.who', l.role === 'caller' ? 'Caller' : (l.agent || 'AI')), h('span.text', l.text)))),
      h('p.muted.small', 'API: GET /api/v1/calls/' + d.id)));
  }
  async function callsTab(body) {
    const f = Object.assign({ companyId: '', status: '', outcome: '', direction: '', syncState: '', alerts: '', since: '' }, S.callFilter || {});
    S.callFilter = null;
    const comp = companySelect(f.companyId);
    const status = h('select', [['', 'Any status'], ['live', 'Live now'], ['ended', 'Ended']].map(([v, l]) => h('option', { value: v, selected: v === f.status }, l)));
    const outcome = h('select', [['', 'Any outcome']].concat(Object.entries(OUT)).map(([v, l]) => h('option', { value: v }, l)));
    const direction = h('select', [['', 'In + out'], ['inbound', 'Inbound'], ['outbound', 'Outbound']].map(([v, l]) => h('option', { value: v }, l)));
    const sync = h('select', [['', 'Any sync'], ['failed', 'Sync failed'], ['queued', 'Sync queued'], ['done', 'Synced']].map(([v, l]) => h('option', { value: v }, l)));
    const alerts = h('select', [['', 'Any'], ['true', 'With alerts']].map(([v, l]) => h('option', { value: v }, l)));
    const box = h('div');
    let before = null;
    const load = async (more) => {
      if (!more) { before = null; box.innerHTML = ''; }
      const r = await api('GET', '/api/v1/calls' + qs({ companyId: comp.value, status: status.value, outcome: outcome.value, direction: direction.value, syncState: sync.value, alerts: alerts.value, limit: 50, before }));
      box.querySelector('.more') && box.querySelector('.more').remove();
      box.append(callTable(r.data));
      before = r.nextBefore;
      if (before) box.append(h('button.btn.more', { on: { click: () => load(true) } }, 'Load more'));
    };
    [comp, status, outcome, direction, sync, alerts].forEach((el) => el.addEventListener('change', () => load()));
    body.append(h('div.card', h('div.row-between', h('h2', 'Calls'), h('div.row.filters', comp, status, outcome, direction, sync, alerts)), box));
    await load();
  }

  /* ---------- leads ---------- */
  function leadTable(rows) {
    return table(['Received', 'Company', 'Lead', 'Interest', 'Status', 'Attempts', 'Next call', 'Note'], rows.map((l) => ({ item: l, cells: [
      h('td.small.nowrap', fmtTime(l.createdAt)), h('td.small', companyName(l.companyId)), h('td', h('strong', l.name || '—'), h('div.muted.small', l.phone)), h('td.small', l.interest || '—'),
      h('td', badge(l.status, statusKind(l.status))), h('td', String(l.attempts)), h('td.small', l.status === 'queued' ? fmtTime(l.nextAt) : '—'), h('td.small', l.reason || '')] })));
  }
  async function leadsTab(body) {
    const comp = companySelect('');
    const status = h('select', ['', 'queued', 'calling', 'connected', 'unreached', 'skipped', 'failed'].map((v) => h('option', { value: v }, v || 'Any status')));
    const box = h('div');
    const load = async () => { box.innerHTML = ''; box.append(leadTable((await api('GET', '/api/v1/leads' + qs({ companyId: comp.value, status: status.value, limit: 100 }))).data)); };
    [comp, status].forEach((el) => el.addEventListener('change', load));
    body.append(h('div.card', h('div.row-between', h('h2', 'Speed-to-lead'), h('div.row.filters', comp, status)), box));
    await load();
  }

  /* ---------- activity ---------- */
  function eventTable(rows) {
    return table(['When', 'Company', 'Event', 'Detail'], rows.map((e) => ({ item: e, cells: [h('td.small.nowrap', fmtTime(e.at)), h('td.small', e.companyId ? companyName(e.companyId) : '—'), h('td', h('code', e.type)), h('td.small', e.detail)] })));
  }
  async function activityTab(body) {
    const comp = companySelect('');
    const type = h('input', { placeholder: 'Event type, e.g. deploy.failed' });
    const box = h('div');
    let before = null;
    const load = async (more) => {
      if (!more) { before = null; box.innerHTML = ''; }
      const r = await api('GET', '/api/v1/events' + qs({ companyId: comp.value, type: type.value.trim(), limit: 100, before }));
      box.querySelector('.more') && box.querySelector('.more').remove();
      box.append(eventTable(r.data));
      before = r.nextBefore;
      if (before) box.append(h('button.btn.more', { on: { click: () => load(true) } }, 'Load more'));
    };
    comp.addEventListener('change', () => load());
    type.addEventListener('change', () => load());
    body.append(h('div.card', h('div.row-between', h('h2', 'Activity log'), h('div.row.filters', comp, type)), box));
    await load();
  }

  /* ---------- webhooks ---------- */
  async function webhooksTab(body) {
    const [w, d] = await Promise.all([api('GET', '/api/admin/webhooks'), api('GET', '/api/admin/webhook-deliveries?limit=50')]);
    const url = h('input', { type: 'url', placeholder: 'https://your-other-app.com/hooks/call-center', required: true });
    const desc = h('input', { placeholder: 'Description (e.g. "Attendly sync")' });
    const comp = companySelect('', 'All companies');
    const evBoxes = w.eventTypes.map((t) => h('label.row', h('input', { type: 'checkbox', value: t }), ' ', h('code', t)));
    const all = h('input', { type: 'checkbox', checked: true });
    const out = h('div');
    const create = h('button.btn.primary', { type: 'button' }, 'Add webhook');
    create.addEventListener('click', () => busy(create, async () => {
      try {
        const events = all.checked ? ['*'] : evBoxes.map((l) => l.querySelector('input')).filter((i) => i.checked).map((i) => i.value);
        const r = await api('POST', '/api/admin/webhooks', { url: url.value, description: desc.value, companyId: comp.value || null, events });
        out.innerHTML = '';
        out.append(h('div.note.ok', 'Webhook added. Signing secret (shown once): ', h('code', r.secret), ' ', copyBtn(r.secret)));
        setTimeout(() => route(), 15000);
      } catch (e) { toast(e.message, 'err'); }
    }));
    body.append(
      h('div.card', h('h2', 'Webhooks (' + w.data.length + ')'), table(['URL', 'Events', 'Company', 'Last delivery', 'Active', ''], w.data.map((x) => ({ item: x, cells: [
        h('td', h('code', x.url), x.description ? h('div.muted.small', x.description) : null), h('td.small', x.events.join(', ')), h('td.small', x.companyId ? companyName(x.companyId) : 'All'),
        h('td.small', x.lastAt ? badge(x.lastStatus, statusKind(x.lastStatus)) : '—', x.lastAt ? ' ' + fmtTime(x.lastAt) : '', x.failures ? ' · ' + x.failures + ' failing' : ''),
        h('td', x.active ? 'yes' : 'paused'),
        h('td.right.nowrap',
          h('button.btn.small', { on: { click: async (e) => { e.stopPropagation(); const r = await api('POST', '/api/admin/webhooks/' + x.id + '/test', {}).catch((err) => ({ ok: false, error: err.message })); toast(r.ok ? 'Test delivered (HTTP ' + r.code + ')' : 'Test failed: ' + (r.error || 'HTTP ' + r.code), r.ok ? 'ok' : 'err'); route(); } } }, 'Send test'), ' ',
          h('button.btn.small', { on: { click: async (e) => { e.stopPropagation(); await api('PATCH', '/api/admin/webhooks/' + x.id, { active: !x.active }); route(); } } }, x.active ? 'Pause' : 'Resume'), ' ',
          h('button.btn.small.danger', { on: { click: async (e) => { e.stopPropagation(); if (confirm('Delete this webhook?')) { await api('DELETE', '/api/admin/webhooks/' + x.id); route(); } } } }, 'Delete'))] })))),
      h('div.card.form-grid', h('h2', 'Add a webhook'),
        h('label', 'Endpoint URL (https)', url), h('label', 'Description', desc), h('label', 'Company', comp),
        h('label.row', all, ' All events'), h('details', h('summary', 'Or choose events'), h('div.event-grid', evBoxes)),
        create, out),
      h('div.card', h('h2', 'Recent deliveries'), table(['When', 'Event', 'Webhook', 'Status', 'Attempts', 'Response'], d.data.map((x) => ({ item: x, cells: [
        h('td.small.nowrap', fmtTime(x.createdAt)), h('td', h('code', x.type)), h('td.small', (w.data.find((y) => y.id === x.hookId) || {}).url || x.hookId), h('td', badge(x.status, statusKind(x.status))),
        h('td', String(x.attempts)), h('td.small', x.lastError || (x.lastCode ? 'HTTP ' + x.lastCode : '—'))] })))),
      h('div.card', h('h2', 'Verifying deliveries'), h('p.muted', 'Each request carries X-ACC-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256 of "t.rawBody" with your signing secret>. Reject it if the HMAC does not match or t is more than 5 minutes old.'),
        h('pre.prompt', [
          "const crypto = require('crypto');",
          'function verify(rawBody, header, secret) {',
          "  const { t, v1 } = Object.fromEntries(header.split(',').map((p) => p.split('=')));",
          "  const want = crypto.createHmac('sha256', secret).update(t + '.' + rawBody).digest('hex');",
          '  const fresh = Math.abs(Date.now() / 1000 - Number(t)) < 300;',
          "  return fresh && crypto.timingSafeEqual(Buffer.from(want), Buffer.from(v1 || ''));",
          '}'].join('\n'))));
  }

  /* ---------- API: keys + reference ---------- */
  async function apiTab(body) {
    const [keys, ref] = await Promise.all([api('GET', '/api/admin/api-keys'), api('GET', '/api/admin/api-reference')]);
    const name = h('input', { placeholder: 'Name, e.g. "Attendly" or "Zapier"' });
    const write = h('input', { type: 'checkbox' });
    const comp = companySelect('', 'All companies');
    const out = h('div');
    const create = h('button.btn.primary', { type: 'button' }, 'Create key');
    create.addEventListener('click', () => busy(create, async () => {
      try {
        const r = await api('POST', '/api/admin/api-keys', { name: name.value, write: write.checked, companyId: comp.value || null });
        out.innerHTML = '';
        out.append(h('div.note.ok', 'Key created. Copy it now: it is shown only once. ', h('br'), h('code', r.key), ' ', copyBtn(r.key)));
      } catch (e) { toast(e.message, 'err'); }
    }));
    const base = ref.baseUrl;
    const groups = {};
    ref.endpoints.forEach((e) => { (groups[e.group] = groups[e.group] || []).push(e); });
    const curl = (e) => {
      const path = e.path.replace(/\{(\w+)\}/g, (m, k) => '<' + k + '>');
      return 'curl' + (e.method !== 'GET' ? ' -X ' + e.method : '') + ' "' + base + path + '"' + ' \\\n  -H "Authorization: Bearer $ACC_API_KEY"' +
        (e.body ? ' \\\n  -H "Content-Type: application/json" \\\n  -d \'' + e.body.replace(/"active" \| "pending" \| "suspended"/, '"suspended"') + '\'' : '');
    };
    body.append(
      h('div.card', h('h2', 'API keys'), h('p.muted', 'Give each of your apps its own key. Read keys can only read; write keys can also send leads and change licenses. A key can be limited to one company.'),
        table(['Name', 'Key', 'Scopes', 'Company', 'Created', 'Last used', ''], keys.data.map((k) => ({ item: k, cells: [
          h('td', h('strong', k.name)), h('td', h('code', k.id + '…')), h('td', k.scopes.join(' + ')), h('td.small', k.companyId ? companyName(k.companyId) : 'All'),
          h('td.small', fmtTime(k.createdAt)), h('td.small', fmtTime(k.lastUsedAt) || 'never'),
          h('td', k.revoked ? badge('revoked', 'failed') : h('button.btn.small.danger', { on: { click: async () => { if (confirm('Revoke "' + k.name + '"? Apps using it stop working immediately.')) { await api('DELETE', '/api/admin/api-keys/' + encodeURIComponent(k.id)); route(); } } } }, 'Revoke'))] }))),
        h('div.row', h('label', 'Name', name), h('label', 'Company', comp), h('label.row', write, ' Allow writes'), create), out),
      h('div.card', h('div.row-between', h('h2', 'API reference'), h('div.row', h('a.btn.small', { href: '/api/v1/openapi.json', target: '_blank' }, 'OpenAPI JSON'), copyBtn(base + '/api/v1/openapi.json'))),
        h('ul.kv',
          h('li', h('span', 'Base URL'), h('code', base + '/api/v1')),
          h('li', h('span', 'Authentication'), h('code', 'Authorization: Bearer acc_…')),
          h('li', h('span', 'Format'), h('span', 'JSON. Times are ISO 8601 UTC. Errors: { "error": "message" } with HTTP 400/401/403/404/409/429.')),
          h('li', h('span', 'Pagination'), h('span', 'Lists return { data, nextBefore }. Pass ?before=<nextBefore> for the next page.')),
          h('li', h('span', 'Rate limit'), h('span', '600 requests per minute per key')),
          h('li', h('span', 'Push instead of poll'), h('span', 'Webhooks tab: events ', h('code', ref.eventTypes.join(', '))))),
        Object.entries(groups).map(([g, list]) => h('div.api-group', h('h3', g), list.map((e) => h('details.api-ep',
          h('summary', h('span.method.m-' + e.method.toLowerCase(), e.method), ' ', h('code', e.path), ' ', h('span.muted.small', e.summary), ' ', h('span.badge.none', e.scope)),
          e.params && e.params.length ? h('table.table.small', h('tbody', e.params.map((p) => h('tr', h('td', h('code', p.name)), h('td', p.desc))))) : null,
          e.body ? h('div', h('h4', 'Body'), h('pre.prompt', e.body)) : null,
          h('h4', 'Returns'), h('pre.prompt', e.returns),
          h('h4', 'Example'), h('div.row', h('pre.prompt.grow', curl(e)), copyBtn(curl(e))))))),
        h('h3', 'Objects'), Object.entries(ref.shapes).map(([k, v]) => h('div', h('h4', k), h('pre.prompt', v)))));
  }

  /* ---------- setup ---------- */
  async function setupTab(body) {
    const s = await api('GET', '/api/admin/setup');
    const checkRows = (list) => h('table.table', h('tbody', list.map((c) => h('tr', h('td', c.ok ? '✅' : '⚠️'), h('td', h('strong', c.name)), h('td.small', c.detail)))));
    body.append(h('div.card', h('h2', 'Platform'), checkRows(s.checks)));
    s.apps.forEach((a) => {
      const testOut = h('span.small');
      const test = h('button.btn.small', { disabled: !a.configured, on: { click: async () => {
        test.disabled = true;
        const t = await api('POST', '/api/admin/setup/test', { app: a.key }).catch((err) => ({ ok: false, detail: err.message }));
        test.disabled = false;
        testOut.textContent = (t.ok ? '✓ ' : '✗ ') + t.detail;
        testOut.className = 'small ' + (t.ok ? '' : 'warn');
      } } }, 'Test Client ID / Secret');
      body.append(h('div.card',
        h('div.row-between', h('h2', a.label, ' ', badge(a.configured ? 'configured' : 'not configured', a.configured ? 'live' : 'pending')), h('div.row', testOut, test)),
        checkRows(a.checks),
        h('h3', 'Paste into this app\'s settings'),
        h('ul.kv', Object.entries(a.paste).map(([k, v]) => h('li', h('span', k), h('span.row', h('code', v), copyBtn(v)))))));
    });
  }

  route();
})();
