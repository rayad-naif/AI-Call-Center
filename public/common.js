/* Shared browser helpers: API calls (with the X-ACC CSRF header), tiny DOM
   builder, toasts, form + sign-out wiring. */
(function () {
  'use strict';

  async function api(method, url, body) {
    const res = await fetch(url, {
      method,
      credentials: 'same-origin',
      headers: Object.assign({ 'X-ACC': '1', Accept: 'application/json' }, body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      body: body !== undefined ? JSON.stringify(body) : undefined
    });
    let data = {};
    try { data = await res.json(); } catch (e) { /* empty */ }
    if (res.status === 401 && !/\/api\/auth\//.test(url)) { location.href = '/login'; throw new Error('Signed out'); }
    if (!res.ok) { const err = new Error(data.error || ('Request failed (' + res.status + ')')); err.data = data; err.status = res.status; throw err; }
    return data;
  }

  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  // h('div.card#id', {attrs, on:{click}}, children...)
  function h(tag, attrs, ...kids) {
    const m = tag.match(/^([a-z0-9]+)?((?:[.#][\w-]+)*)$/i);
    const node = document.createElement((m && m[1]) || 'div');
    ((m && m[2]) || '').replace(/([.#])([\w-]+)/g, (_, t, v) => { if (t === '.') node.classList.add(v); else node.id = v; });
    if (attrs && (typeof attrs !== 'object' || attrs instanceof Node || Array.isArray(attrs))) { kids.unshift(attrs); attrs = null; }
    Object.entries(attrs || {}).forEach(([k, v]) => {
      if (v == null || v === false) return;
      if (k === 'on') Object.entries(v).forEach(([ev, fn]) => node.addEventListener(ev, fn));
      else if (k === 'class') node.className += ' ' + v;
      else if (k === 'html') node.innerHTML = v;
      else if (k in node && typeof v !== 'string') node[k] = v;
      else node.setAttribute(k, v === true ? '' : v);
    });
    kids.flat(Infinity).forEach((k) => { if (k != null && k !== false) node.append(k instanceof Node ? k : document.createTextNode(String(k))); });
    return node;
  }

  function toast(msg, kind) {
    let box = document.getElementById('toasts');
    if (!box) { box = h('div#toasts', { 'aria-live': 'polite' }); document.body.append(box); }
    const t = h('div.toast' + (kind ? '.' + kind : ''), msg);
    box.append(t);
    setTimeout(() => t.classList.add('out'), 4200);
    setTimeout(() => t.remove(), 4800);
  }

  const fmtTime = (iso) => (iso ? new Date(iso).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '');
  function fmtDur(sec) {
    sec = Math.max(0, Math.round(sec || 0));
    const m = Math.floor(sec / 60), s = sec % 60;
    return m + ':' + String(s).padStart(2, '0');
  }
  const since = (iso) => (iso ? (Date.now() - Date.parse(iso)) / 1000 : 0);

  async function busy(btn, fn) {
    const label = btn && btn.textContent;
    if (btn) { btn.disabled = true; btn.classList.add('busy'); }
    try { return await fn(); } finally { if (btn) { btn.disabled = false; btn.classList.remove('busy'); btn.textContent = label; } }
  }

  // <form data-form="/api/..."> -> JSON POST, redirect on success.
  document.addEventListener('submit', async (e) => {
    const f = e.target.closest('form[data-form]');
    if (!f) return;
    e.preventDefault();
    const out = f.querySelector('.form-error');
    if (out) out.textContent = '';
    const body = {};
    new FormData(f).forEach((v, k) => { body[k] = v; });
    try {
      const r = await busy(f.querySelector('button[type=submit],button:not([type])'), () => api('POST', f.dataset.form, body));
      if (r.redirect) location.href = r.redirect;
    } catch (err) { if (out) out.textContent = err.message; }
  });

  document.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-logout]');
    if (!b) return;
    const r = await api('POST', b.dataset.logout || '/api/auth/logout', {}).catch(() => ({ redirect: '/login' }));
    location.href = r.redirect || '/login';
  });

  const boot = () => { const n = document.getElementById('boot'); try { return n ? JSON.parse(n.textContent) : {}; } catch (e) { return {}; } };

  window.ACC = { api, h, esc, toast, fmtTime, fmtDur, since, busy, boot };
})();
