/* Personal API access: this user's own keys, webhooks and reference. */
(function () {
  'use strict';
  const { h } = window.ACC;
  const root = document.getElementById('developer');
  const opts = { base: '/api/company', reload: () => draw(),
    intro: 'Connect your own tools (Zapier, Make, spreadsheets, your software) to your call center data. Each key belongs to you and has exactly your access.' };

  async function draw() {
    const which = (location.hash.slice(1) || 'keys');
    root.innerHTML = '';
    root.append(h('h1', 'API access'),
      h('nav.subtabs', [['keys', 'Keys'], ['webhooks', 'Webhooks'], ['reference', 'Reference']].map(([k, l]) => h('a', { href: '#' + k, class: which === k ? 'active' : '' }, l))));
    const box = h('div', h('div.spinner'));
    root.append(box);
    try {
      box.innerHTML = '';
      if (which === 'webhooks') await window.ACCApiUI.webhooks(box, opts);
      else if (which === 'reference') await window.ACCApiUI.reference(box, opts);
      else await window.ACCApiUI.keys(box, opts);
    } catch (e) { box.innerHTML = ''; box.append(h('p.error', e.message)); }
  }
  window.addEventListener('hashchange', draw);
  draw();
})();
