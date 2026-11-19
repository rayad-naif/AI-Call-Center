/* White-labeled ROI report: printable, one client or all clients. */
(function () {
  'use strict';
  const { api, h, boot } = window.ACC;
  const root = document.getElementById('report');
  const B = boot();
  const S = { location: B.location || '', days: B.days || 30, deps: [] };
  const OUT = { appointment_booked: 'Booked', qualified_lead: 'Qualified lead', support_resolved: 'Resolved', support_ticket: 'Ticket', not_interested: 'Not interested', spam: 'Spam', voicemail: 'Voicemail', other: 'Other' };
  const money = (n) => '$' + Math.round(n).toLocaleString();
  const svg = (tag, attrs, ...kids) => {
    const n = document.createElementNS('http://www.w3.org/2000/svg', tag);
    Object.entries(attrs || {}).forEach(([k, v]) => n.setAttribute(k, v));
    kids.forEach((k) => n.append(k));
    return n;
  };

  document.addEventListener('click', (e) => { if (e.target.closest('[data-print]')) window.print(); });

  // Daily calls (bars) with booked calls overlaid.
  function dailyChart(daily) {
    const W = 720, H = 180, pad = 24;
    const max = Math.max(1, ...daily.map((d) => d.calls));
    const bw = (W - pad) / daily.length;
    const g = svg('svg', { viewBox: '0 0 ' + W + ' ' + (H + 22), class: 'chart', role: 'img', 'aria-label': 'Calls per day' });
    [0, 0.5, 1].forEach((f) => g.append(svg('line', { x1: pad, x2: W, y1: H - f * (H - 10), y2: H - f * (H - 10), class: 'grid' }), svg('text', { x: 0, y: H - f * (H - 10) + 4, class: 'axis' }, String(Math.round(max * f)))));
    daily.forEach((d, i) => {
      const x = pad + i * bw + bw * 0.15, w = bw * 0.7;
      const hc = (d.calls / max) * (H - 10), hb = (d.booked / max) * (H - 10);
      const bar = svg('rect', { x, y: H - hc, width: w, height: hc, rx: 2, class: 'bar' });
      bar.append(svg('title', {}, d.date + ': ' + d.calls + ' calls, ' + d.booked + ' booked'));
      g.append(bar, svg('rect', { x, y: H - hb, width: w, height: hb, rx: 2, class: 'bar booked' }));
      if (daily.length <= 14 || i % Math.ceil(daily.length / 10) === 0) g.append(svg('text', { x: x + w / 2, y: H + 16, class: 'axis', 'text-anchor': 'middle' }, d.date.slice(5)));
    });
    return g;
  }

  function hoursChart(hours) {
    const max = Math.max(1, ...hours);
    return h('div.hours', hours.map((n, i) => h('div.hour', { title: i + ':00 · ' + n + ' calls', style: '--v:' + (n / max).toFixed(2) }, h('span', i % 3 === 0 ? String(i) : ''))));
  }

  const kpi = (label, value, sub) => h('div.stat', h('div.stat-v', value), h('div.stat-l', label), sub ? h('div.stat-sub', sub) : null);

  async function draw() {
    root.innerHTML = '';
    root.append(h('div.spinner'));
    const q = new URLSearchParams({ days: S.days });
    if (S.location) q.set('location', S.location);
    let r;
    try { r = await api('GET', '/api/reports/summary?' + q); } catch (e) { root.innerHTML = ''; root.append(h('p.error', e.message)); return; }
    const t = r.totals;
    const title = S.location ? ((r.clients[0] && r.clients[0].name) || 'Client') : 'All clients';
    const daysSel = h('select', { on: { change: () => { S.days = Number(daysSel.value); draw(); } } }, [7, 30, 90, 365].map((d) => h('option', { value: d, selected: d === S.days }, 'Last ' + d + ' days')));
    const locSel = S.deps.length > 1 ? h('select', { on: { change: () => { S.location = locSel.value; draw(); } } }, h('option', { value: '' }, 'All clients'), S.deps.map((d) => h('option', { value: d.locationId, selected: d.locationId === S.location }, d.name))) : null;
    const outcomes = Object.entries(r.outcomes).sort((a, b) => b[1] - a[1]);
    const totalOutcomes = outcomes.reduce((n, [, v]) => n + v, 0) || 1;

    root.innerHTML = '';
    root.append(...[
      h('div.report-head', h('div', h('h1', 'AI call center report'), h('p.muted', title + ' · last ' + r.days + ' days · ' + r.timezone)),
        h('div.row.no-print', locSel, daysSel, h('a.btn.small', { href: '/api/reports/calls.csv?' + q }, 'Export CSV'))),
      h('div.stats', kpi('Calls handled', String(t.calls), t.answered + ' conversations'),
        kpi('Appointments booked', String(t.booked), t.bookingRate + '% of conversations'),
        kpi('Est. revenue booked', t.estRevenue ? money(t.estRevenue) : '—', t.estRevenue ? 'from avg job value' : 'set avg job value'),
        kpi('Return on AI cost', t.roi ? t.roi + '×' : '—', 'AI cost ' + money(t.cost)),
        kpi('After-hours calls', String(t.afterHours), 'answered, not missed'),
        kpi('Staff hours saved', String(t.staffHoursSaved), t.minutes + ' talk minutes'),
        kpi('Avg QA score', t.avgScore == null ? '—' : String(t.avgScore), t.alerts + ' calls flagged')),
      h('div.card', h('h2', 'Calls per day'), h('p.legend', h('span.sw'), ' calls ', h('span.sw.booked'), ' booked'), dailyChart(r.daily)),
      h('div.report-grid',
        h('div.card', h('h2', 'Call outcomes'), outcomes.length ? h('ul.bars', outcomes.map(([k, v]) => h('li', h('span', OUT[k] || k), h('span.track', h('span.fill', { style: 'width:' + Math.round((v / totalOutcomes) * 100) + '%' })), h('strong', String(v))))) : h('p.muted', 'No graded calls yet.')),
        h('div.card', h('h2', 'When people call'), hoursChart(r.hours), h('p.muted.small', 'Calls by hour of day (' + r.timezone + ')'))),
      r.leads.received ? h('div.card', h('h2', 'Speed-to-lead'), h('div.stats',
        kpi('New leads called', String(r.leads.received)), kpi('Reached', String(r.leads.connected)), kpi('Not reached', String(r.leads.unreached)),
        kpi('Avg time to call', r.leads.avgSpeedSec == null ? '—' : (r.leads.avgSpeedSec < 90 ? r.leads.avgSpeedSec + ' s' : Math.round(r.leads.avgSpeedSec / 60) + ' min')))) : null,
      h('div.card', h('h2', 'Handled by'), h('p', Object.entries(r.agents).map(([k, v]) => h('span.badge.agent', k + ': ' + v))))
    ].filter(Boolean));
  }

  (async () => {
    const d = await api('GET', '/api/deployments').catch(() => ({ deployments: [] }));
    S.deps = d.deployments.filter((x) => x.status !== 'removed');
    if (!S.location && S.deps.length === 1) S.location = S.deps[0].locationId;
    draw();
  })();
})();
