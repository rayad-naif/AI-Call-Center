/* Live Command Deck: live grid, real-time transcript, listen, whisper,
   say, mute, transfer, browser takeover (Twilio Voice SDK), history + QA. */
(function () {
  'use strict';
  const { api, h, toast, fmtTime, fmtDur, since, busy, boot } = window.ACC;
  const root = document.getElementById('deck');
  const B = boot();
  const OUT = { appointment_booked: 'Booked', qualified_lead: 'Qualified lead', support_resolved: 'Resolved', support_ticket: 'Ticket', not_interested: 'Not interested', spam: 'Spam', voicemail: 'Voicemail', other: 'Other' };

  const S = {
    me: null, deployments: [], location: B.location || '', view: 'live',
    calls: [], selected: null, detail: null, lines: [], listener: null,
    device: null, activeCall: null, pollMs: 1500, timers: [],
    seenAlerts: null, sound: true
  };
  const canControl = () => S.me && ['manager', 'admin', 'owner'].includes(S.me.user.role);
  const q = () => (S.location ? '?location=' + encodeURIComponent(S.location) : '');
  const qa = (extra) => (S.location ? '?location=' + encodeURIComponent(S.location) + '&' : '?') + extra;
  const depName = (id) => (S.deployments.find((d) => d.locationId === id) || {}).name || '';

  /* ---------- layout ---------- */
  const el = {};
  function layout() {
    root.innerHTML = '';
    el.locSel = h('select.loc', { on: { change: () => { S.location = el.locSel.value; S.selected = null; refreshGrid(); drawDetail(); if (S.view === 'history') drawHistory(); } } });
    el.tabs = h('div.seg', ['live', 'history'].map((v) => h('button', { 'data-v': v, on: { click: () => { S.view = v; drawTabs(); } } }, v === 'live' ? 'Live' : 'History')));
    el.stats = h('div.stats.compact');
    el.grid = h('div.grid-list', { role: 'list' });
    el.history = h('div.grid-list', { hidden: true });
    el.detail = h('section.detail');
    root.append(
      h('div.deck-head', h('div.row', h('h1', 'Command Deck'), h('span.live-dot', { title: 'Live' })), h('div.row', alertToggle(), S.deployments.length > 1 ? el.locSel : null, el.tabs)),
      el.stats,
      h('div.deck-body', h('aside.calls', el.grid, el.history), el.detail)
    );
    el.locSel.append(h('option', { value: '' }, 'All clients'), S.deployments.map((d) => h('option', { value: d.locationId, selected: d.locationId === S.location }, d.name || d.locationId)));
    drawTabs();
    drawDetail();
  }
  function drawTabs() {
    el.tabs.querySelectorAll('button').forEach((b) => b.classList.toggle('active', b.dataset.v === S.view));
    el.grid.hidden = S.view !== 'live';
    el.history.hidden = S.view !== 'history';
    if (S.view === 'history') drawHistory();
  }

  /* ---------- live grid ---------- */
  /* ---------- alerts: sound + browser notification for new ones ---------- */
  function alertToggle() {
    const perm = window.Notification ? Notification.permission : 'denied';
    const b = h('button.btn.small', { title: 'Alerts for keywords, unhappy callers and low QA scores', on: { click: async () => {
      if (window.Notification && Notification.permission === 'default') await Notification.requestPermission();
      S.sound = !S.sound || (window.Notification && Notification.permission === 'granted');
      b.textContent = S.sound ? '🔔 Alerts on' : '🔕 Alerts muted';
    } } }, S.sound ? (perm === 'granted' ? '🔔 Alerts on' : '🔔 Enable alert pop-ups') : '🔕 Alerts muted');
    return b;
  }
  function beep() {
    try {
      const a = new (window.AudioContext || window.webkitAudioContext)();
      [0, 0.18].forEach((t) => { const o = a.createOscillator(); const g = a.createGain(); o.frequency.value = 880; g.gain.value = 0.08; o.connect(g); g.connect(a.destination); o.start(a.currentTime + t); o.stop(a.currentTime + t + 0.12); });
      setTimeout(() => a.close(), 600);
    } catch (e) { /* no audio */ }
  }
  function checkAlerts(calls) {
    const first = !S.seenAlerts;
    if (first) S.seenAlerts = new Set();
    calls.forEach((c) => (c.alerts || []).forEach((al) => {
      if (S.seenAlerts.has(al.id)) return;
      S.seenAlerts.add(al.id);
      if (first || !S.sound) return;
      beep();
      const who = c.customer.name || c.customer.number || 'Caller';
      toast('⚠ ' + who + ': ' + al.text, 'err');
      if (window.Notification && Notification.permission === 'granted' && document.hidden) {
        const n = new Notification('Call alert: ' + who, { body: al.text, tag: al.id });
        n.onclick = () => { window.focus(); select(c.id); n.close(); };
      }
    }));
  }

  async function refreshGrid() {
    try {
      const r = await api('GET', '/api/live/calls' + q());
      S.calls = r.calls;
      checkAlerts(r.calls);
      drawGrid();
    } catch (e) { /* transient */ }
  }
  function card(c, onClick) {
    const dur = c.endedAt ? (c.durationSec || (Date.parse(c.endedAt) - Date.parse(c.answeredAt || c.createdAt)) / 1000) : since(c.answeredAt || c.createdAt);
    const alerting = (c.alerts || []).length > 0;
    return h('button.call-card', { class: (S.selected === c.id ? 'sel ' : '') + (alerting && c.status !== 'ended' ? 'alerting' : ''), role: 'listitem', on: { click: onClick } },
      h('div.row-between', h('strong', c.customer.name || c.customer.number || 'Unknown caller'), h('span.mono', fmtDur(dur))),
      h('div.row', h('span.badge.agent', c.agent || 'AI'), c.takeover ? h('span.badge.takeover', c.takeover.state === 'live' ? 'Human: ' + c.takeover.by : 'Takeover ' + c.takeover.state) : null,
        c.muted ? h('span.badge.pending', 'AI muted') : null, alerting ? h('span.badge.alert', '⚠ ' + c.alerts.length) : null,
        c.leadId ? h('span.badge.none', 'Lead callback') : null, c.grade ? h('span.badge.score', c.grade.score + ' · ' + (OUT[c.grade.outcome] || c.grade.outcome)) : null,
        !S.location && depName(c.locationId) ? h('span.muted.small', depName(c.locationId)) : null),
      c.lastLine ? h('p.last', (c.lastLine.role === 'caller' ? 'Caller: ' : 'AI: ') + c.lastLine.text) : h('p.last.muted', c.status === 'ringing' ? 'Ringing…' : 'Connecting…'),
      c.warning ? h('p.small.warn', c.warning) : null);
  }
  function drawGrid() {
    const liveNow = el.stats.querySelector('[data-live-now]');
    if (liveNow) liveNow.textContent = String(S.calls.length);
    el.grid.innerHTML = '';
    if (!S.calls.length) el.grid.append(h('div.empty', h('p', 'No live calls right now.'), h('p.muted.small', 'New calls appear here automatically.')));
    S.calls.forEach((c) => el.grid.append(card(c, () => select(c.id))));
  }

  async function drawHistory() {
    el.history.innerHTML = '';
    el.history.append(h('div.spinner'));
    const r = await api('GET', '/api/live/history' + q()).catch(() => ({ calls: [] }));
    el.history.innerHTML = '';
    if (!r.calls.length) el.history.append(h('div.empty', 'No calls yet.'));
    r.calls.forEach((c) => el.history.append(h('div', h('div.muted.small', fmtTime(c.createdAt)), card(c, () => select(c.id)))));
  }

  async function refreshStats() {
    const s = await api('GET', '/api/live/stats' + q()).catch(() => null);
    if (!s) return;
    el.stats.innerHTML = '';
    const st = (l, v) => h('div.stat', h('div.stat-v', String(v)), h('div.stat-l', l));
    const live = st('Live now', S.calls.length);
    live.firstChild.setAttribute('data-live-now', '');
    el.stats.append(live, st('Calls (7d)', s.calls7d), st('Booked (7d)', s.booked7d), st('Avg QA', s.avgScore == null ? '—' : s.avgScore), st('Minutes (7d)', s.minutes7d));
  }

  /* ---------- call detail ---------- */
  function select(id) {
    if (S.selected === id) return;
    stopListening();
    S.selected = id; S.detail = null; S.lines = []; S.draft = '';
    drawGrid();
    drawDetail();
    refreshDetail();
  }

  async function refreshDetail() {
    if (!S.selected) return;
    const id = S.selected;
    try {
      const d = await api('GET', '/api/live/calls/' + encodeURIComponent(id) + qa('after=' + S.lines.length));
      if (id !== S.selected) return;
      // Final report replaces the live lines: reload all when the total shrinks.
      if (d.total < S.lines.length + d.lines.length && d.lines.length !== d.total) {
        const full = await api('GET', '/api/live/calls/' + encodeURIComponent(id) + qa('after=0'));
        S.lines = full.lines;
      } else S.lines = S.lines.concat(d.lines);
      const statusChanged = !S.detail || S.detail.status !== d.status || JSON.stringify(S.detail.takeover) !== JSON.stringify(d.takeover) || S.detail.muted !== d.muted || !!S.detail.grade !== !!d.grade || (S.detail.sync || {}).state !== (d.sync || {}).state || (S.detail.alerts || []).length !== (d.alerts || []).length;
      S.detail = d;
      if (statusChanged) drawDetail(); else drawTranscript();
    } catch (e) { if (e.status === 404) { S.selected = null; drawDetail(); } }
  }

  function drawDetail() {
    el.detail.innerHTML = '';
    if (!S.selected) { el.detail.append(h('div.empty.big', h('h2', 'Select a call'), h('p.muted', 'Click a live call to watch the transcript, listen in, whisper to the AI or take over.'))); return; }
    const d = S.detail;
    if (!d) { el.detail.append(h('div.spinner')); return; }
    const live = d.status !== 'ended';
    el.transcript = h('div.transcript', { 'aria-live': 'polite' });
    el.detail.append(
      h('div.detail-head',
        h('div', h('h2', d.customer.name || d.customer.number || 'Unknown caller'),
          h('p.muted.small', [depName(d.locationId), d.direction, fmtTime(d.createdAt), live ? 'live' : 'ended' + (d.endedReason ? ' (' + d.endedReason + ')' : '')].filter(Boolean).join(' · '))),
        h('div.row', h('span.badge.agent', d.agent || 'AI'), live ? h('span.badge.live', 'LIVE') : h('span.badge.none', 'ended'))),
      h('div.detail-body', el.transcript, live && canControl() ? controls(d) : (live ? h('aside.controls', h('p.muted', 'View only. Ask your admin for manager access to step in.')) : postCall(d))));
    drawTranscript();
  }

  function drawTranscript() {
    const t = el.transcript;
    if (!t) return;
    const atBottom = t.scrollHeight - t.scrollTop - t.clientHeight < 60;
    t.innerHTML = '';
    if (!S.lines.length) t.append(h('p.muted', 'Waiting for the first words…'));
    const whispers = (S.detail && S.detail.whispers) || [];
    const items = S.lines.map((l) => ({ at: l.at || '', node: h('div.line.' + l.role, h('span.who', l.role === 'caller' ? 'Caller' : (l.agent || 'AI')), h('span.text', l.text)) }))
      .concat(whispers.map((w) => ({ at: w.at, node: h('div.line.whisper', h('span.who', (w.kind === 'say' ? 'Said via AI' : 'Whisper') + ' · ' + w.by), h('span.text', w.text)) })));
    items.sort((a, b) => (a.at && b.at ? a.at.localeCompare(b.at) : 0)).forEach((i) => t.append(i.node));
    const p = S.detail && S.detail.partial;
    if (p && S.detail.status !== 'ended') t.append(h('div.line.typing.' + p.role, h('span.who', p.role === 'caller' ? 'Caller' : (p.agent || 'AI')), h('span.text', p.text, h('span.caret'))));
    if (atBottom) t.scrollTop = t.scrollHeight;
  }

  /* ---------- controls ---------- */
  function controls(d) {
    const id = d.id;
    const act = (action, body) => api('POST', '/api/live/calls/' + encodeURIComponent(id) + '/' + action + q(), body || {});
    // The draft survives re-renders (status changes redraw the panel).
    const whisperIn = h('textarea', { rows: 3, placeholder: 'e.g. Offer 10% off if they book today', maxlength: 600, on: { input: () => { S.draft = whisperIn.value; } } });
    whisperIn.value = S.draft || '';
    const send = (kind) => async (e) => {
      const text = whisperIn.value.trim();
      if (!text) return whisperIn.focus();
      try { await busy(e.target, () => act(kind, { text })); whisperIn.value = ''; S.draft = ''; toast(kind === 'say' ? 'The AI is saying it now' : 'Whisper sent: the AI will use it in its next reply', 'ok'); refreshDetail(); } catch (err) { toast(err.message, 'err'); }
    };
    whisperIn.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) send('whisper')({ target: e.target }); });

    const listenBtn = h('button.btn', { on: { click: () => toggleListen(listenBtn) } }, S.listener ? 'Stop listening' : '🎧 Listen');
    const fmtSel = h('select.small', { title: 'Audio format', on: { change: () => { window.ACCAudio.setFormat(fmtSel.value); if (S.listener) { stopListening(); toggleListen(listenBtn); } } } },
      Object.entries(window.ACCAudio.FORMATS).map(([k, v]) => h('option', { value: k, selected: k === window.ACCAudio.savedFormat() }, v.label)));
    const takeoverState = d.takeover && d.takeover.state;
    const takeBtn = h('button.btn.primary.big', { disabled: !!takeoverState || !S.device, title: S.device ? '' : 'Browser calling is not available', on: { click: (e) => takeover(e.target, id) } },
      takeoverState === 'live' ? 'You are on the call' : takeoverState ? 'Takeover: ' + takeoverState : '🎙 Take over call');

    return h('aside.controls', alertBox(d),
      h('div.ctl', h('h3', 'Listen'), h('div.row', listenBtn, fmtSel), h('p.muted.small', 'Audio streams directly from the call to your browser.')),
      h('div.ctl', h('h3', 'Whisper to the AI'), whisperIn,
        h('div.row', h('button.btn.primary', { on: { click: send('whisper') } }, 'Whisper'), h('button.btn', { on: { click: send('say') }, title: 'The AI says this text out loud, word for word' }, 'Say it now')),
        h('p.muted.small', 'Whisper: the AI works it into its next reply. Ctrl+Enter sends.')),
      h('div.ctl', h('h3', 'Take over'), takeBtn,
        h('p.muted.small', S.device ? 'The AI hands the caller to your browser. Use a headset.' : (S.voiceReason || 'Browser takeover is unavailable.')),
        h('div.row',
          h('button.btn.small', { on: { click: async (e) => { try { await busy(e.target, () => act(d.muted ? 'unmute' : 'mute')); refreshDetail(); } catch (err) { toast(err.message, 'err'); } } } }, d.muted ? 'Unmute AI' : 'Mute AI'),
          h('button.btn.small', { on: { click: async () => { const n = prompt('Transfer the caller to (e.g. +15551234567)'); if (!n) return; try { await act('transfer', { number: n }); toast('Transferring…', 'ok'); } catch (err) { toast(err.message, 'err'); } } } }, 'Transfer to phone'),
          h('button.btn.small.danger', { on: { click: async () => { if (!confirm('End this call for the caller?')) return; try { await act('end'); toast('Ending call', 'ok'); } catch (err) { toast(err.message, 'err'); } } } }, 'End call'))),
      S.activeCall ? inCallBar() : null);
  }

  const alertBox = (d) => ((d.alerts || []).length ? h('div.ctl', h('h3', 'Alerts'), h('ul.alert-list', d.alerts.map((a) => h('li', '⚠ ' + a.text)))) : null);

  function postCall(d) {
    const g = d.grade;
    const sync = d.sync || {};
    return h('aside.controls', alertBox(d),
      h('div.ctl', h('h3', 'QA grade'),
        g ? [h('div.score-big', String(g.score), h('span', '/100')),
          h('p', h('span.badge.' + (g.sentiment === 'positive' ? 'live' : g.sentiment === 'negative' ? 'failed' : 'none'), g.sentiment), ' ', h('span.badge.score', OUT[g.outcome] || g.outcome)),
          h('p', g.summary),
          g.nextSteps && g.nextSteps.length ? [h('h4', 'Next steps'), h('ul', g.nextSteps.map((s) => h('li', s)))] : null,
          g.coaching && g.coaching.length ? [h('h4', 'Coaching for the AI'), h('ul', g.coaching.map((s) => h('li', s)))] : null,
          g.flags && g.flags.length ? h('p', g.flags.map((f) => h('span.badge.failed', f.replace(/_/g, ' ')))) : null]
          : h('p.muted', sync.state === 'failed' ? 'Grading failed.' : 'Grading in progress…')),
      d.recordingUrl ? h('div.ctl', h('h3', 'Recording'), h('audio', { controls: true, preload: 'none', src: d.recordingUrl })) : null,
      h('div.ctl', h('h3', 'CRM sync'),
        h('p', h('span.badge.' + (sync.state === 'done' ? 'live' : sync.state === 'failed' ? 'failed' : 'pending'), sync.state || 'pending'), sync.skipped ? ' ' + sync.skipped : ''),
        sync.sms && !/^error/.test(sync.sms) ? h('p.small', '✉ Follow-up text sent (' + sync.sms + ')') : (sync.sms ? h('p.small.warn', 'Follow-up text failed: ' + sync.sms.replace(/^error: /, '')) : null),
        sync.error ? h('p.small.warn', sync.error) : null,
        canControl() ? h('button.btn.small', { on: { click: async (e) => { try { await busy(e.target, () => api('POST', '/api/live/calls/' + encodeURIComponent(d.id) + '/resync' + q(), { regrade: e.shiftKey })); toast('Synced', 'ok'); refreshDetail(); } catch (err) { toast(err.message, 'err'); } } }, title: 'Shift+click to regrade too' }, 'Sync again') : null));
  }

  /* ---------- listen ---------- */
  async function toggleListen(btn) {
    if (S.listener) { stopListening(); btn.textContent = '🎧 Listen'; return; }
    try {
      const r = await busy(btn, () => api('POST', '/api/live/calls/' + encodeURIComponent(S.selected) + '/listen' + q(), {}));
      S.listener = window.ACCAudio.createListener(r.url, { onClose: () => { S.listener = null; btn.textContent = '🎧 Listen'; } });
      btn.textContent = 'Stop listening';
    } catch (err) { toast(err.message, 'err'); }
  }
  function stopListening() { if (S.listener) { S.listener.close(); S.listener = null; } }

  /* ---------- takeover (Twilio Voice SDK in the browser) ---------- */
  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = src; s.crossOrigin = 'anonymous'; s.onload = resolve; s.onerror = () => reject(new Error('Could not load the calling library'));
      document.head.append(s);
    });
  }
  const voicePill = (text, kind) => { const p = document.getElementById('voice-status'); if (!p) return; p.hidden = !text; p.textContent = text; p.className = 'pill ' + (kind || ''); };

  async function setupVoice() {
    if (!canControl()) return;
    try {
      const t = await api('GET', '/api/live/voice-token');
      if (!t.enabled) { S.voiceReason = t.reason; return; }
      await loadScript(B.twilioSdk);
      const device = new window.Twilio.Device(t.token, { closeProtection: true, codecPreferences: ['opus', 'pcmu'] });
      device.on('registered', () => voicePill('Takeover ready', 'ok'));
      device.on('error', (e) => { voicePill('Calling error', 'err'); console.warn('Twilio Device error', e); });
      device.on('tokenWillExpire', async () => { const n = await api('GET', '/api/live/voice-token').catch(() => null); if (n && n.token) device.updateToken(n.token); });
      device.on('incoming', (call) => {
        // Only accept calls we asked for (a takeover from this browser).
        if (!S.expectingTakeover || Date.now() - S.expectingTakeover > 120e3) { call.reject(); return; }
        S.expectingTakeover = 0;
        call.accept();
        S.activeCall = call;
        voicePill('On call', 'live');
        toast('You are live with the caller', 'ok');
        call.on('disconnect', () => { S.activeCall = null; voicePill('Takeover ready', 'ok'); drawDetail(); });
        drawDetail();
      });
      await device.register();
      S.device = device;
      if (S.detail) drawDetail();
    } catch (e) { S.voiceReason = e.message; voicePill('Calling unavailable', 'err'); }
  }

  async function takeover(btn, id) {
    if (!S.device) return toast(S.voiceReason || 'Browser calling is not ready', 'err');
    try {
      // Ask for the microphone first so the bridge connects instantly.
      await navigator.mediaDevices.getUserMedia({ audio: true }).then((s) => s.getTracks().forEach((t) => t.stop()));
      S.expectingTakeover = Date.now();
      stopListening();
      await busy(btn, () => api('POST', '/api/live/calls/' + encodeURIComponent(id) + '/takeover' + q(), {}));
      toast('Connecting the caller to you…', 'ok');
      refreshDetail();
    } catch (err) { S.expectingTakeover = 0; toast(err.message, 'err'); }
  }

  function inCallBar() {
    const c = S.activeCall;
    const muteBtn = h('button.btn', { on: { click: () => { c.mute(!c.isMuted()); muteBtn.textContent = c.isMuted() ? 'Unmute mic' : 'Mute mic'; } } }, c.isMuted() ? 'Unmute mic' : 'Mute mic');
    return h('div.ctl.incall', h('h3', 'You are on the call'), h('div.row', muteBtn, h('button.btn.danger', { on: { click: () => c.disconnect() } }, 'Hang up')));
  }

  /* ---------- polling loop ---------- */
  function every(ms, fn) { const t = setInterval(() => { if (!document.hidden) fn(); }, ms); S.timers.push(t); }

  async function start() {
    const [me, deps] = await Promise.all([api('GET', '/api/me'), api('GET', '/api/deployments')]);
    S.me = me;
    S.pollMs = me.pollMs || 1500;
    S.deployments = deps.deployments.filter((d) => d.status !== 'removed');
    if (S.location && !S.deployments.some((d) => d.locationId === S.location)) S.location = '';
    if (!S.location && S.deployments.length === 1) S.location = S.deployments[0].locationId;
    layout();
    await refreshGrid();
    refreshStats();
    every(S.pollMs, refreshGrid);
    every(S.pollMs, refreshDetail);
    every(30000, refreshStats);
    every(1000, () => { if (S.view === 'live' && S.calls.length) drawGrid(); });
    document.addEventListener('visibilitychange', () => { if (!document.hidden) { refreshGrid(); refreshDetail(); } });
    window.addEventListener('beforeunload', () => { stopListening(); if (S.device) S.device.destroy(); });
    setupVoice();
  }

  start().catch((e) => { root.innerHTML = ''; root.append(h('div.empty.big', h('h2', 'Could not load the deck'), h('p', e.message))); });
})();
