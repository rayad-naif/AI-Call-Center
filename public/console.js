/* Company console: overview, BYOK keys, client deployments, branding, team, activity. */
(function () {
  'use strict';
  const { api, h, toast, fmtTime, busy } = window.ACC;
  const root = document.getElementById('console');
  const TABS = [['overview', 'Overview'], ['keys', 'Keys'], ['clients', 'Clients'], ['branding', 'Branding'], ['team', 'Team'], ['api', 'API'], ['activity', 'Activity']];
  const OUTCOME_LABEL = {
    appointment_booked: 'Appointment booked', qualified_lead: 'Qualified lead', support_resolved: 'Support resolved',
    support_ticket: 'Support ticket', not_interested: 'Not interested', spam: 'Spam / robocall', voicemail: 'Voicemail', other: 'Other'
  };
  let state = { agency: null, tab: (location.hash.slice(1) || 'overview').split('/')[0] };

  const field = (label, input, hint) => h('label', label, input, hint ? h('span.hint', hint) : null);
  const input = (name, value, attrs) => h('input', Object.assign({ name, value: value == null ? '' : value }, attrs || {}));
  const textarea = (name, value, attrs) => h('textarea', Object.assign({ name, rows: 4 }, attrs || {}), value || '');
  const select = (name, options, value) => h('select', { name }, options.map(([v, l]) => h('option', { value: v, selected: v === value }, l)));
  const badge = (status) => h('span.badge.' + status, status === 'none' ? 'not deployed' : status);
  function formData(form) {
    const o = {};
    form.querySelectorAll('[name]').forEach((el) => {
      if (el.type === 'checkbox') o[el.name] = el.checked;
      else o[el.name] = el.value;
    });
    return o;
  }

  async function load() {
    state.agency = await api('GET', '/api/agency');
    render();
  }

  // A single account that installed the app for itself manages only itself.
  const single = () => state.agency && state.agency.mode === 'account';
  function render() {
    root.innerHTML = '';
    const nav = h('nav.tabs', TABS.map(([k, l]) => [k, k === 'clients' && single() ? 'Call center' : l]).map(([k, l]) => h('a', { href: '#' + k, class: state.tab === k ? 'active' : '' }, l)));
    const body = h('section.tab-body');
    root.append(h('div.console-head', h('div', h('h1', state.agency.name), h('p.muted', 'License: ', badge(state.agency.status))), h('div.row', h('a.btn', { href: '/report' }, 'ROI report'), h('a.btn.primary', { href: '/deck' }, 'Open Command Deck'))), nav, body);
    ({ overview, keys, clients, branding, team, api: apiTab, activity })[state.tab](body);
  }
  window.addEventListener('hashchange', () => { state.tab = (location.hash.slice(1) || 'overview').split('/')[0]; if (TABS.some(([k]) => k === state.tab)) render(); });

  /* ---------- overview ---------- */
  async function overview(body) {
    const k = state.agency.keys;
    const ready = k.twilioSid.set && k.twilioToken.set && k.vapiKey.set && k.openaiKey.set;
    const steps = [
      ['Add your provider keys', ready, '#keys'],
      [single() ? 'Set up your call center' : 'Deploy your first client', false, '#clients'],
      ['Brand the client portal', !!state.agency.branding.name || !!state.agency.branding.logoUrl, '#branding'],
      ['Invite your team or clients', false, '#team']
    ];
    const statsBox = h('div.stats', h('div.spinner'));
    body.append(
      h('div.card', h('h2', 'Setup checklist'), h('ol.checklist', steps.map(([t, done, href]) => h('li', { class: done ? 'done' : '' }, h('a', { href }, t))))),
      h('div.card', h('h2', 'Last 7 days'), statsBox),
      state.agency.support ? h('div.card', h('h2', 'Support'), h('p', state.agency.support.name + ' · ', h('a', { href: 'mailto:' + state.agency.support.email }, state.agency.support.email))) : ''
    );
    const [s, deps] = await Promise.all([api('GET', '/api/live/stats'), api('GET', '/api/deployments')]);
    if (deps.deployments.some((d) => d.status === 'live')) body.querySelectorAll('.checklist li')[1].classList.add('done');
    statsBox.innerHTML = '';
    statsBox.append(
      single() ? null : stat('Live clients', deps.deployments.filter((d) => d.status === 'live').length),
      stat('Calls', s.calls7d), stat('Minutes', s.minutes7d), stat('Booked', s.booked7d),
      stat('Avg QA score', s.avgScore == null ? '—' : s.avgScore), stat('Vapi cost', '$' + s.cost7d.toFixed(2))
    );
  }
  const stat = (label, value) => h('div.stat', h('div.stat-v', String(value)), h('div.stat-l', label));

  /* ---------- keys ---------- */
  function keys(body) {
    const k = state.agency.keys;
    const st = k.status || {};
    const status = (name) => st[name] ? h('span.badge.' + (st[name].ok ? 'live' : 'failed'), st[name].ok ? 'Connected' : 'Failed', ' · ', st[name].detail) : h('span.badge.none', 'not checked');
    const secretInput = (name, f) => input(name, '', { type: 'password', autocomplete: 'off', placeholder: f.set ? 'Saved (' + f.hint + '). Leave blank to keep.' : 'Paste key' });
    const form = h('form.card.form-grid',
      h('h2', 'Bring your own keys'),
      h('p.muted', 'Usage is billed to your own accounts. Keys are checked live when saved and stored encrypted (AES-256-GCM). Keys that fail the check are not saved.'),
      h('fieldset', h('legend', 'Twilio ', status('twilio')),
        field('Account SID', input('twilioSid', '', { placeholder: k.twilioSid.set ? k.twilioSid.hint : 'AC…', autocomplete: 'off' })),
        field('Auth Token', secretInput('twilioToken', k.twilioToken), 'Console → Account info. Used to create an account and number per client.')),
      h('fieldset', h('legend', 'Vapi ', status('vapi')),
        field('Private API key', secretInput('vapiKey', k.vapiKey), 'Vapi dashboard → API Keys → Private key.')),
      h('fieldset', h('legend', 'OpenAI ', status('openai')),
        field('API key', secretInput('openaiKey', k.openaiKey), 'Powers the AI agents (through Vapi) and the call grader.')),
      h('button.btn.primary', { type: 'submit' }, 'Check and save keys')
    );
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const data = formData(form);
      try {
        const r = await busy(form.querySelector('button'), () => api('PUT', '/api/agency/keys', data));
        state.agency.keys = r.keys;
        const failed = Object.entries(r.keys.status).filter(([, v]) => !v.ok);
        toast(failed.length ? 'Some keys failed: ' + failed.map(([n]) => n).join(', ') : 'Keys saved', failed.length ? 'err' : 'ok');
        render();
      } catch (err) { toast(err.message, 'err'); }
    });
    const setup = state.agency.setup;
    body.append(form, h('div.card', h('h2', 'Company resources'), h('ul.kv',
      h('li', h('span', 'OpenAI key linked to Vapi'), h('strong', setup.vapiCredential ? 'Yes' : 'On first deploy')),
      h('li', h('span', 'Browser takeover'), h('strong', setup.browserCalling ? 'Ready' : 'On first deploy')),
      h('li', h('span', 'Takeover line'), h('strong', setup.takeoverNumber || '—')))));
  }

  /* ---------- clients ---------- */
  async function clients(body) {
    if (single()) return editor(body, state.agency.locationId);
    const sub = location.hash.split('/')[1];
    if (sub) return editor(body, decodeURIComponent(sub));
    const list = h('div.card', h('div.spinner'));
    body.append(list);
    try {
      const r = await api('GET', '/api/locations');
      list.innerHTML = '';
      const q = input('q', '', { placeholder: 'Search accounts…', type: 'search' });
      const table = h('table.table');
      const draw = () => {
        const term = q.value.toLowerCase();
        table.innerHTML = '';
        table.append(h('thead', h('tr', h('th', 'Account'), h('th', 'Status'), h('th', 'AI number'), h('th', ''))));
        const tb = h('tbody');
        r.locations.filter((l) => !term || (l.name || '').toLowerCase().includes(term)).forEach((l) => tb.append(h('tr',
          h('td', h('strong', l.name), h('div.muted.small', [l.city, l.state].filter(Boolean).join(', '))),
          h('td', badge(l.status), l.appInstalled === false ? h('div.small.warn', r.edition === 'agency' ? 'CRM not connected yet' : 'App not installed in this account yet') : null), h('td', l.phoneNumber || '—'),
          h('td.right', h('a.btn.small' + (l.status === 'none' ? '.primary' : ''), { href: '#clients/' + encodeURIComponent(l.id) }, l.status === 'none' ? 'Set up' : 'Manage')))));
        table.append(tb);
      };
      q.addEventListener('input', draw);
      list.append(h('div.row-between', h('h2', 'Clients (' + r.locations.length + ' accounts)'), q), table);
      draw();
    } catch (err) { list.innerHTML = ''; list.append(h('p.error', err.message)); }
  }

  /* CRM connection: a Private Integration token from the client's account.
     Required for companies on the company app; optional on the account app
     (for an account where that app is not installed). */
  const PIT_SCOPES = 'View/Edit Contacts, View/Edit Opportunities, View Calendars, View/Edit Calendar Events, View/Edit Custom Fields, View/Edit Conversations, View/Edit Conversation Messages, View Locations, View Users';
  async function crmConnection(locationId, failing, reload) {
    const st = await api('GET', '/api/locations/' + encodeURIComponent(locationId) + '/crm-token').catch(() => ({ connected: false, edition: state.agency.edition }));
    const agencyEd = st.edition === 'agency';
    if (!agencyEd && !st.connected && !failing) return h('span');
    const tok = input('token', '', { type: 'password', placeholder: st.connected ? 'Connected. Paste a new token to replace it' : 'pit-…', autocomplete: 'off' });
    const save = h('button.btn.primary', { type: 'button' }, st.connected ? 'Replace token' : 'Connect');
    const remove = st.connected ? h('button.btn', { type: 'button' }, 'Disconnect') : null;
    save.addEventListener('click', async () => {
      try { const r = await busy(save, () => api('PUT', '/api/locations/' + encodeURIComponent(locationId) + '/crm-token', { token: tok.value })); toast('Connected' + (r.name ? ' to ' + r.name : ''), 'ok'); reload(); } catch (err) { toast(err.message, 'err'); }
    });
    if (remove) remove.addEventListener('click', async () => {
      if (!confirm('Disconnect this account from the CRM? Calls keep working, but CRM sync, booking and texts stop until you connect again.')) return;
      try { await api('DELETE', '/api/locations/' + encodeURIComponent(locationId) + '/crm-token'); toast('Disconnected', 'ok'); reload(); } catch (err) { toast(err.message, 'err'); }
    });
    return h('div.card' + (st.connected ? '' : '.needs-connect'),
      h('h2', 'CRM connection ', h('span.badge.' + (st.connected ? 'live' : 'pending'), st.connected ? 'connected' : 'not connected')),
      h('p.muted.small', agencyEd
        ? 'Each client account connects with its own Private Integration token. In the client\'s account open Settings > Private Integrations, create an integration with these scopes, and paste the token here: '
        : 'The app is not installed in this account. You can connect it with a Private Integration token from the account instead (Settings > Private Integrations) with these scopes: ', h('strong', PIT_SCOPES), '.'),
      h('div.row', tok, save, remove));
  }

  async function editor(body, locationId) {
    if (!single()) body.append(h('p', h('a', { href: '#clients' }, '← All clients')));
    const box = h('div', h('div.spinner'));
    body.append(box);
    const [crm, existing] = await Promise.all([
      api('GET', '/api/locations/' + encodeURIComponent(locationId) + '/crm').catch((e) => ({ error: e.message, pipelines: [], calendars: [], location: { id: locationId } })),
      api('GET', '/api/deployments/' + encodeURIComponent(locationId)).catch(() => null)
    ]);
    const dep = existing && existing.deployment;
    const a = (dep && dep.agent) || { businessName: crm.location.name, timezone: crm.location.timezone || 'America/New_York', voiceId: 'Elliot', appointmentMinutes: 60, extra: {}, recordCalls: true };
    const opt = (dep && dep.options) || { country: 'US', areaCode: '', useSubaccount: true };
    const pipe = (dep && dep.pipeline) || { pipelineId: '', stages: {} };
    box.innerHTML = '';
    if (!single()) box.append(await crmConnection(locationId, !!crm.error, () => { body.innerHTML = ''; editor(body, locationId); }));
    if (crm.error) box.append(h('p.note.err', 'Could not read this account from the CRM: ' + crm.error));

    const form = h('form.form-grid');
    // Industry template: fills the business and agent fields in one click.
    const tplSel = h('select', h('option', { value: '' }, 'Choose an industry…'));
    api('GET', '/api/templates').then((r) => { state.templates = r.templates; r.templates.forEach((t) => tplSel.append(h('option', { value: t.id }, t.label))); }).catch(() => {});
    const applyTemplate = () => {
      const t = (state.templates || []).find((x) => x.id === tplSel.value);
      if (!t) return;
      const filled = [...form.querySelectorAll('[name]')].some((el) => ['services', 'faq'].includes(el.name) && el.value.trim());
      if (filled && !confirm('Replace the services, FAQ and agent instructions with the ' + t.label + ' template?')) return;
      Object.entries(t.agent).forEach(([k, v]) => {
        if (k === 'extra') Object.entries(v).forEach(([r, txt]) => { const el = form.querySelector('[name="extra.' + r + '"]'); if (el) el.value = txt; });
        else { const el = form.querySelector('[name="' + k + '"]'); if (el) el.value = v; }
      });
      toast(t.label + ' template applied. Review it, then deploy.', 'ok');
    };
    form.append(h('div.card.template-bar', field('Start from an industry template', tplSel, 'HVAC, plumbing, roofing, dental, med spa, legal, real estate, solar'), h('button.btn', { type: 'button', on: { click: applyTemplate } }, 'Apply template')));
    // Business
    form.append(h('fieldset.card', h('legend', '1. Business'),
      field('Business name', input('businessName', a.businessName, { required: true })),
      field('Industry', input('industry', a.industry, { placeholder: 'e.g. plumbing' })),
      field('Services offered', textarea('services', a.services, { placeholder: 'One per line, e.g. Water heater installation' })),
      field('Service area', input('serviceArea', a.serviceArea)),
      field('Business hours', input('hours', a.hours)),
      field('Time zone', input('timezone', a.timezone, { placeholder: 'America/New_York' })),
      field('Pricing the AI may share', textarea('pricing', a.pricing, { placeholder: 'e.g. Service call: $89, waived if work is booked' })),
      field('Support FAQ', textarea('faq', a.faq, { rows: 6, placeholder: 'Q: … A: …' })),
      field('Average job value ($)', input('avgJobValue', a.avgJobValue || '', { type: 'number', min: 0, placeholder: 'e.g. 450' }), 'Used for the estimated revenue in the client ROI report.')));
    // Agents
    form.append(h('fieldset.card', h('legend', '2. AI agents'),
      field('Greeting', input('greeting', a.greeting, { placeholder: 'Thanks for calling …, who am I speaking with?' })),
      field('Language', select('language', state.agency.languages.map((l) => [l.id, l.label]), a.language || 'en'), 'Spanish and bilingual agents use multilingual neural voices (the voice choice below applies to English).'),
      field('Voice', select('voiceId', state.agency.voices.map((v) => [v, v]), a.voiceId)),
      field('Tone', input('tone', a.tone)),
      field('Human transfer number', input('transferNumber', a.transferNumber, { placeholder: '+15551234567' }), 'The AI transfers here when a caller asks for a person or it is an emergency.'),
      h('label.row', h('input', { type: 'checkbox', name: 'recordCalls', checked: a.recordCalls !== false }), ' Record calls (recording link goes to the CRM)'),
      h('details', h('summary', 'Extra instructions per agent'),
        field('Receptionist', textarea('extra.receptionist', (a.extra || {}).receptionist)),
        field('Sales', textarea('extra.sales', (a.extra || {}).sales)),
        field('Support', textarea('extra.support', (a.extra || {}).support)),
        field('Outbound (speed-to-lead)', textarea('extra.outbound', (a.extra || {}).outbound))),
      h('button.btn.small', { type: 'button', on: { click: () => previewPrompts(form) } }, 'Preview prompts')));
    // CRM
    const calSel = select('calendarId', [['', 'No booking (collect preferred times)']].concat(crm.calendars.map((c) => [c.id, c.name])), a.calendarId || '');
    const pipeSel = select('pipelineId', [['', 'Don\'t move opportunities']].concat(crm.pipelines.map((p) => [p.id, p.name])), pipe.pipelineId);
    const stageBox = h('div.stage-map');
    const drawStages = () => {
      stageBox.innerHTML = '';
      const p = crm.pipelines.find((x) => x.id === pipeSel.value);
      if (!p) return;
      state.agency.outcomes.forEach((o) => stageBox.append(field(OUTCOME_LABEL[o] || o, select('stage.' + o, [['', '— leave as is —']].concat(p.stages.map((s) => [s.id, s.name])), (pipe.stages || {})[o] || ''))));
    };
    pipeSel.addEventListener('change', drawStages);
    form.append(h('fieldset.card', h('legend', '3. Calendar and pipeline'),
      field('Booking calendar (Sales agent)', calSel),
      field('Appointment length (minutes)', input('appointmentMinutes', a.appointmentMinutes, { type: 'number', min: 15, max: 480 })),
      field('Pipeline for call outcomes', pipeSel, 'The CRM\'s API cannot create pipelines; pick one from your snapshot.'),
      stageBox));
    drawStages();
    // Number
    form.append(h('fieldset.card', h('legend', '4. Phone number'),
      dep && dep.phoneNumber ? h('p', 'Number: ', h('strong', dep.phoneNumber)) : null,
      field('Country', input('country', opt.country, { maxlength: 2 })),
      field('Preferred area code', input('areaCode', opt.areaCode, { maxlength: 3, placeholder: 'e.g. 512' })),
      h('label.row', h('input', { type: 'checkbox', name: 'useSubaccount', checked: opt.useSubaccount !== false, disabled: !!(dep && dep.phoneNumber) }), ' Separate Twilio account for this client')));

    // 5. Speed-to-lead
    const D = state.agency.defaults;
    const ob = (dep && dep.outbound) || D.outbound;
    const dayBoxes = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'].map((d) => h('label.row', h('input', { type: 'checkbox', name: 'ob.day.' + d, checked: (ob.days || []).includes(d) }), ' ' + d[0].toUpperCase() + d.slice(1)));
    const hookBox = h('div');
    if (ob.webhookUrl) {
      const urlIn = h('input', { value: ob.webhookUrl, readonly: true });
      hookBox.append(field('Webhook URL for your CRM workflow', h('div.copy-row', urlIn, h('button.btn.small', { type: 'button', on: { click: () => { urlIn.select(); navigator.clipboard && navigator.clipboard.writeText(urlIn.value); toast('Copied', 'ok'); } } }, 'Copy')),
        'In the client\'s workflow (trigger: form submitted / new lead), add the action "Custom Webhook", method POST, this URL. Contact fields are sent automatically; add custom data "interest" to tell the AI what they asked about.'));
    } else hookBox.append(h('p.muted.small', 'Save or deploy to get the webhook URL.'));
    form.append(h('fieldset.card', h('legend', '5. Speed-to-lead (AI calls new leads)'),
      h('p.muted.small', 'When a lead comes in, the Outbound agent calls them within seconds, qualifies them and books the appointment. Leads who say "stop calling" are marked Do Not Disturb.'),
      h('label.row', h('input', { type: 'checkbox', name: 'ob.consent', checked: !!ob.consent }), ' Leads have given consent to be called (e.g. a form with a call-consent checkbox). Required by TCPA and similar laws.'),
      h('label.row', h('input', { type: 'checkbox', name: 'ob.enabled', checked: !!ob.enabled }), ' Turn on speed-to-lead calling'),
      h('div.row', field('Calling hours from', input('ob.start', ob.start, { type: 'time' })), field('to', input('ob.end', ob.end, { type: 'time' }))),
      h('div.row', dayBoxes),
      h('div.row', field('Attempts per lead', select('ob.maxAttempts', [['1', '1'], ['2', '2'], ['3', '3']], String(ob.maxAttempts))),
        field('Retry after (minutes)', input('ob.retryMinutes', ob.retryMinutes, { type: 'number', min: 10 })),
        field('Max calls per day', input('ob.dailyCap', ob.dailyCap, { type: 'number', min: 1 }))),
      hookBox));

    // 6. SMS follow-up
    const fu = (dep && dep.followUp) || D.followUp;
    form.append(h('fieldset.card', h('legend', '6. SMS follow-up after calls'),
      h('p.muted.small', 'Sent through the account\'s own CRM phone number, so replies land in CRM Conversations. Variables: {first_name} {business} {appointment_time} {phone}'),
      h('label.row', h('input', { type: 'checkbox', name: 'fu.enabled', checked: !!fu.enabled }), ' Send follow-up texts'),
      field('Appointment booked', textarea('fu.booked', fu.booked, { rows: 2 })),
      field('Missed call / voicemail', textarea('fu.missed', fu.missed, { rows: 2 })),
      field('Qualified lead (not booked yet)', textarea('fu.lead', fu.lead, { rows: 2 })),
      field('Support ticket created', textarea('fu.ticket', fu.ticket, { rows: 2 }))));

    // 7. Alerts
    const al = (dep && dep.alerts) || D.alerts;
    form.append(h('fieldset.card', h('legend', '7. Live alerts'),
      h('p.muted.small', 'Alerts flash in the Command Deck with a sound and a browser notification.'),
      h('label.row', h('input', { type: 'checkbox', name: 'al.enabled', checked: al.enabled !== false }), ' Alerts on'),
      field('Alert when the caller says', textarea('al.keywords', (al.keywords || []).join(', '), { rows: 2 }), 'Comma separated'),
      h('div.row', field('Alert when QA score is below', input('al.minScore', al.minScore, { type: 'number', min: 0, max: 100 })),
        h('label.row', h('input', { type: 'checkbox', name: 'al.negative', checked: al.negative !== false }), ' Alert on unhappy callers'))));

    const save = async () => {
      const d = formData(form);
      const agent = { extra: {} };
      ['businessName', 'industry', 'services', 'serviceArea', 'hours', 'timezone', 'pricing', 'faq', 'greeting', 'voiceId', 'language', 'tone', 'transferNumber', 'recordCalls', 'calendarId', 'appointmentMinutes', 'avgJobValue'].forEach((k) => { agent[k] = d[k]; });
      ['receptionist', 'sales', 'support', 'outbound'].forEach((r) => { agent.extra[r] = d['extra.' + r]; });
      const outbound = { consent: d['ob.consent'], enabled: d['ob.enabled'], start: d['ob.start'], end: d['ob.end'], maxAttempts: d['ob.maxAttempts'], retryMinutes: d['ob.retryMinutes'], dailyCap: d['ob.dailyCap'], days: ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'].filter((x) => d['ob.day.' + x]) };
      if (outbound.enabled && !outbound.consent) throw new Error('Confirm that leads have consented to be called before turning on speed-to-lead.');
      const followUp = { enabled: d['fu.enabled'], booked: d['fu.booked'], missed: d['fu.missed'], lead: d['fu.lead'], ticket: d['fu.ticket'] };
      const alerts = { enabled: d['al.enabled'], keywords: d['al.keywords'], minScore: d['al.minScore'], negative: d['al.negative'] };
      const stages = {};
      state.agency.outcomes.forEach((o) => { if (d['stage.' + o]) stages[o] = d['stage.' + o]; });
      return api('PUT', '/api/deployments/' + encodeURIComponent(locationId), {
        name: d.businessName, agent, pipeline: { pipelineId: d.pipelineId, stages }, outbound, followUp, alerts,
        options: { country: (d.country || 'US').toUpperCase(), areaCode: d.areaCode, useSubaccount: d.useSubaccount }
      });
    };

    const stepsBox = h('div.card.steps');
    const drawSteps = (dp) => {
      stepsBox.innerHTML = '';
      if (!dp) return;
      stepsBox.append(...[h('div.row-between', h('h2', 'Deployment ', badge(dp.status)), dp.status === 'live' ? h('a.btn.small', { href: '/deck?location=' + encodeURIComponent(locationId) }, 'Open deck') : null),
        dp.lastError ? h('p.note.err', dp.lastError) : null,
        h('ol.step-list', dp.steps.map((s) => h('li.' + s.status, h('span.dot'), h('span', s.label), h('span.muted.small', s.detail || '')))),
        dp.status === 'live' ? h('ul.kv',
          h('li', h('span', 'AI phone number'), h('strong', dp.phoneNumber)),
          h('li', h('span', 'Client deck URL'), h('code', dp.portalUrl)),
          h('li', h('span', 'Vapi squad'), h('code', dp.vapi.squadId || '—'))) : null].filter(Boolean));
    };
    drawSteps(dep);

    const deployBtn = h('button.btn.primary', { type: 'button' }, dep && dep.status === 'live' ? 'Redeploy everything' : (dep && dep.status === 'failed' ? 'Resume deployment' : 'Deploy call center'));
    const updateBtn = h('button.btn', { type: 'button', hidden: !(dep && dep.status === 'live') }, 'Save and update agents only');
    const testBtn = h('button.btn', { type: 'button', hidden: !(dep && dep.status === 'live') }, 'Test call my phone');
    const leadBtn = h('button.btn', { type: 'button', hidden: !(dep && dep.status === 'live') }, 'Test speed-to-lead');
    leadBtn.addEventListener('click', async () => {
      const n = prompt('Send a test lead: your phone number (e.g. +15551234567). The Outbound agent will call it.');
      if (!n) return;
      try {
        await save();
        await api('POST', '/api/deployments/' + encodeURIComponent(locationId) + '/agents', {});
        const r = await busy(leadBtn, () => api('POST', '/api/deployments/' + encodeURIComponent(locationId) + '/test-lead', { phone: n, name: 'Test' }));
        toast(r.status === 'calling' ? 'Calling ' + n + ' now…' : 'Lead ' + r.status + (r.reason ? ': ' + r.reason : ' (calls at ' + new Date(r.callAt).toLocaleString() + ')'), r.status === 'calling' ? 'ok' : 'err');
      } catch (err) { toast(err.message, 'err'); }
    });
    const removeBtn = h('button.btn.danger', { type: 'button', hidden: !(dep && ['live', 'failed'].includes(dep.status)) }, 'Remove…');

    deployBtn.addEventListener('click', () => busy(deployBtn, async () => {
      if (!form.reportValidity()) return;
      try {
        await save();
        deployBtn.textContent = 'Deploying…';
        // Poll progress while the (blocking) deploy request runs.
        const poll = setInterval(async () => { const r = await api('GET', '/api/deployments/' + encodeURIComponent(locationId)).catch(() => null); if (r) drawSteps(r.deployment); }, 1200);
        try {
          const r = await api('POST', '/api/deployments/' + encodeURIComponent(locationId) + '/deploy', {});
          drawSteps(r.deployment);
          toast('Call center is live on ' + r.deployment.phoneNumber, 'ok');
          updateBtn.hidden = testBtn.hidden = leadBtn.hidden = removeBtn.hidden = false;
        } catch (err) {
          if (err.data && err.data.deployment) drawSteps(err.data.deployment);
          toast(err.message, 'err');
          removeBtn.hidden = false;
        } finally { clearInterval(poll); }
      } catch (err) { toast(err.message, 'err'); }
    }));
    updateBtn.addEventListener('click', () => busy(updateBtn, async () => {
      try {
        await save();
        await api('POST', '/api/deployments/' + encodeURIComponent(locationId) + '/agents', {});
        toast('Agents updated', 'ok');
      } catch (err) { toast(err.message, 'err'); }
    }));
    testBtn.addEventListener('click', async () => {
      const n = prompt('Your phone number (international format, e.g. +15551234567)');
      if (!n) return;
      try { await api('POST', '/api/deployments/' + encodeURIComponent(locationId) + '/test-call', { number: n }); toast('Calling ' + n + '…', 'ok'); } catch (err) { toast(err.message, 'err'); }
    });
    removeBtn.addEventListener('click', async () => {
      if (!confirm('Remove this call center? The AI agents are deleted and the phone number is released (it cannot be recovered).')) return;
      const close = confirm('Also close the client\'s Twilio account?');
      try {
        const r = await busy(removeBtn, () => api('POST', '/api/deployments/' + encodeURIComponent(locationId) + '/teardown', { closeSubaccount: close }));
        toast(r.errors.length ? 'Removed with errors: ' + r.errors.join('; ') : 'Removed', r.errors.length ? 'err' : 'ok');
        location.hash = '#clients';
      } catch (err) { toast(err.message, 'err'); }
    });
    box.append(h('div.editor', form, h('aside', stepsBox, h('div.card.actions', deployBtn, updateBtn, testBtn, leadBtn,
      dep && dep.reportUrl ? h('a.btn', { href: dep.reportUrl }, 'Client ROI report') : null, removeBtn,
      h('p.muted.small', 'Deploying creates a Twilio number (billed to your Twilio account), four Vapi assistants (three in the inbound squad plus the speed-to-lead caller), a squad, and CRM fields.')))));
  }

  async function previewPrompts(form) {
    const d = formData(form);
    const r = await api('POST', '/api/agents/preview', { agent: Object.assign({}, d, { extra: { receptionist: d['extra.receptionist'], sales: d['extra.sales'], support: d['extra.support'], outbound: d['extra.outbound'] } }) });
    const dlg = h('dialog.modal', h('h2', 'Generated prompts'), Object.entries(r.prompts).map(([role, p]) => [h('h3', role), h('pre.prompt', p)]), h('form', { method: 'dialog' }, h('button.btn', 'Close')));
    document.body.append(dlg);
    dlg.addEventListener('close', () => dlg.remove());
    dlg.showModal();
  }

  /* ---------- branding ---------- */
  function branding(body) {
    const b = state.agency.branding;
    const form = h('form.card.form-grid',
      h('h2', 'White-label portal'),
      h('p.muted', 'Your clients see this name, logo and colors in the Command Deck and on the sign-in page.'),
      field('Brand name', input('name', b.name, { placeholder: 'Acme Voice' })),
      field('Logo URL (https)', input('logoUrl', b.logoUrl, { placeholder: 'https://…/logo.png' })),
      h('div.row', field('Primary color', input('primary', b.primary, { type: 'color' })), field('Accent color', input('accent', b.accent, { type: 'color' }))),
      h('label.row', h('input', { type: 'checkbox', name: 'hidePoweredBy', checked: !!b.hidePoweredBy }), ' Hide footer links'),
      field('Custom domain', input('domain', b.domain, { placeholder: 'calls.youragency.com' }), 'Create a CNAME record pointing to ' + state.agency.appHost + ', save, then verify.'),
      h('div.row', h('button.btn.primary', { type: 'submit' }, 'Save branding'),
        b.domain ? h('button.btn', { type: 'button', on: { click: verify } }, state.agency.domainVerified ? 'Re-check domain' : 'Verify domain') : null,
        b.domain ? h('span.badge.' + (state.agency.domainVerified ? 'live' : 'pending'), state.agency.domainVerified ? 'verified' : 'not verified') : null));
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      try { await busy(form.querySelector('[type=submit]'), () => api('PUT', '/api/agency/branding', formData(form))); toast('Saved', 'ok'); await load(); } catch (err) { toast(err.message, 'err'); }
    });
    async function verify(e) {
      try { const r = await busy(e.target, () => api('POST', '/api/agency/domain/verify', {})); toast(r.message, r.verified ? 'ok' : 'err'); await load(); } catch (err) { toast(err.message, 'err'); }
    }
    body.append(form);
  }

  /* ---------- team ---------- */
  async function team(body) {
    const [u, d] = await Promise.all([api('GET', '/api/users'), api('GET', '/api/deployments')]);
    const live = d.deployments.filter((x) => x.status === 'live' || x.status === 'failed');
    const names = Object.fromEntries(d.deployments.map((x) => [x.locationId, x.name]));
    const table = h('table.table', h('thead', h('tr', h('th', 'User'), h('th', 'Access'), h('th', 'Last sign-in'), h('th', ''))),
      h('tbody', u.users.map((x) => h('tr',
        h('td', h('strong', x.name || x.email), h('div.muted.small', x.email)),
        h('td', x.kind === 'client' ? 'Client ' + x.role + ': ' + (x.locationIds || []).map((id) => names[id] || id).join(', ') : 'Company ' + x.role, x.disabled ? h('span.badge.failed', 'disabled') : null),
        h('td', fmtTime(x.lastLoginAt) || '—'),
        h('td.right', x.role === 'owner' ? null : [
          h('button.btn.small', { on: { click: async () => { await api('PATCH', '/api/users/' + x.id, { disabled: !x.disabled }); team(clear(body)); } } }, x.disabled ? 'Enable' : 'Disable'), ' ',
          h('button.btn.small.danger', { on: { click: async () => { if (confirm('Delete ' + x.email + '?')) { await api('DELETE', '/api/users/' + x.id); team(clear(body)); } } } }, 'Delete')
        ])))));
    const kindSel = select('kind', [['client', 'Client (one business)'], ['agency', 'Company staff']], 'client');
    const roleSel = select('role', [['viewer', 'Viewer (read only)'], ['manager', 'Manager (whisper, takeover)'], ['admin', 'Admin (company only)']], 'manager');
    const locSel = h('select', { name: 'locationIds', multiple: true, size: Math.min(6, Math.max(2, live.length)) }, live.map((x) => h('option', { value: x.locationId }, x.name)));
    const locField = field('Sub-accounts', locSel);
    kindSel.addEventListener('change', () => { locField.hidden = kindSel.value !== 'client'; });
    const form = h('form.card.form-grid', h('h2', 'Add a login'),
      h('div.row', field('Name', input('name', '')), field('Email', input('email', '', { type: 'email', required: true }))),
      h('div.row', field('Type', kindSel), field('Role', roleSel)), locField,
      field('Password', input('password', '', { type: 'text', placeholder: 'Leave blank to generate one', autocomplete: 'off' })),
      h('button.btn.primary', { type: 'submit' }, 'Create login'), h('div.created'));
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const data = formData(form);
      data.locationIds = [...locSel.selectedOptions].map((o) => o.value);
      try {
        const r = await busy(form.querySelector('[type=submit]'), () => api('POST', '/api/users', data));
        const out = form.querySelector('.created');
        out.innerHTML = '';
        out.append(h('div.note.ok', 'Login created. Send these details securely: ', h('br'), 'Sign in: ', h('code', r.loginUrl), h('br'), 'Email: ', h('code', r.user.email), r.password ? [h('br'), 'Password: ', h('code', r.password)] : null));
        const fresh = await api('GET', '/api/users');
        table.querySelector('tbody').replaceWith(h('tbody', fresh.users.map((x) => h('tr', h('td', x.email), h('td', x.kind + ' ' + x.role), h('td', '—'), h('td')))));
      } catch (err) { toast(err.message, 'err'); }
    });
    body.append(h('div.card', h('h2', 'Team and client logins'), table), form,
      h('p.muted.small', 'Inside the CRM, users are signed in automatically from the sidebar: company admins get this console, and anyone opening the app inside an account sees only that client\'s deck.'));
  }
  const clear = (n) => { n.innerHTML = ''; return n; };

  /* ---------- API: this company's keys, webhooks and reference ---------- */
  async function apiTab(body) {
    const opts = { base: '/api/company', reload: () => render(),
      intro: 'Connect your other apps and automations (Zapier, Make, your own software) to this call center. Keys only ever see your own accounts, calls and leads. Read keys can only read; write keys can also send leads for the AI to call.' };
    const sub = h('nav.subtabs', [['keys', 'Keys'], ['webhooks', 'Webhooks'], ['reference', 'Reference']].map(([k, l]) => h('a', { href: '#api/' + k, class: (location.hash.split('/')[1] || 'keys') === k ? 'active' : '' }, l)));
    const box = h('div', h('div.spinner'));
    body.append(sub, box);
    const which = location.hash.split('/')[1] || 'keys';
    box.innerHTML = '';
    try {
      if (which === 'webhooks') await window.ACCApiUI.webhooks(box, opts);
      else if (which === 'reference') await window.ACCApiUI.reference(box, opts);
      else await window.ACCApiUI.keys(box, opts);
    } catch (e) { box.append(h('p.error', e.message)); }
  }

  /* ---------- activity ---------- */
  async function activity(body) {
    const r = await api('GET', '/api/events');
    body.append(h('div.card', h('h2', 'Activity'), h('table.table', h('tbody', r.events.map((e) => h('tr', h('td.nowrap', fmtTime(e.at)), h('td', h('code', e.type)), h('td', e.detail)))))));
  }

  load().catch((e) => { root.innerHTML = ''; root.append(h('p.error', e.message)); });
})();
