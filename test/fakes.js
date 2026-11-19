'use strict';
/* In-memory fakes for Twilio, Vapi, HighLevel and OpenAI, served through an
   injected fetch so tests exercise the real request code. */

function createFakes() {
  const log = [];
  const state = {
    vapi: { assistants: {}, squads: {}, numbers: {}, credentials: [], controls: [], calls: [] },
    twilio: { subaccounts: {}, numbers: {}, keys: 0, apps: 0 },
    ghl: { fields: [], contacts: {}, notes: [], opportunities: [], appointments: [], tags: [], sms: [], dnd: {} },
    openaiCalls: 0
  };
  let id = 0;
  const nid = (p) => p + (++id);

  const json = (status, body) => ({
    ok: status >= 200 && status < 300, status,
    text: async () => (body === undefined ? '' : JSON.stringify(body)),
    json: async () => body
  });

  async function fetch(url, init) {
    init = init || {};
    const u = new URL(url);
    const method = (init.method || 'GET').toUpperCase();
    const body = init.body ? (/json/.test((init.headers || {})['Content-Type'] || '') ? JSON.parse(init.body) : Object.fromEntries(new URLSearchParams(init.body))) : null;
    log.push({ method, host: u.host, path: u.pathname, body, headers: init.headers || {} });
    const p = u.pathname;

    /* ---- Twilio ---- */
    if (u.host === 'api.twilio.com') {
      const auth = Buffer.from(((init.headers || {}).Authorization || '').replace('Basic ', ''), 'base64').toString();
      if (!auth.startsWith('ACmain:goodtoken')) return json(401, { message: 'Authenticate', code: 20003 });
      let m;
      if (method === 'GET' && p === '/2010-04-01/Accounts/ACmain.json') return json(200, { sid: 'ACmain', friendly_name: 'Agency', type: 'Full', status: 'active' });
      if (method === 'POST' && p === '/2010-04-01/Accounts.json') { const sid = nid('ACsub'); state.twilio.subaccounts[sid] = body; return json(201, { sid, auth_token: 'subtoken-' + sid }); }
      if ((m = p.match(/^\/2010-04-01\/Accounts\/(\w+)\/AvailablePhoneNumbers\/(\w+)\/Local\.json$/))) return json(200, { available_phone_numbers: [{ phone_number: '+1512555' + String(1000 + id).slice(-4) }] });
      if ((m = p.match(/^\/2010-04-01\/Accounts\/(\w+)\/IncomingPhoneNumbers\.json$/)) && method === 'POST') { const sid = nid('PN'); state.twilio.numbers[sid] = Object.assign({ account: m[1] }, body); return json(201, { sid, phone_number: body.PhoneNumber }); }
      if ((m = p.match(/^\/2010-04-01\/Accounts\/(\w+)\/IncomingPhoneNumbers\/(\w+)\.json$/)) && method === 'DELETE') { delete state.twilio.numbers[m[2]]; return json(204); }
      if (p === '/2010-04-01/Accounts/ACmain/Keys.json') { state.twilio.keys++; return json(201, { sid: 'SKkey1', secret: 'keysecret' }); }
      if (p === '/2010-04-01/Accounts/ACmain/Applications.json') { state.twilio.apps++; return json(201, { sid: 'APapp1' }); }
      if ((m = p.match(/^\/2010-04-01\/Accounts\/(\w+)\.json$/)) && method === 'POST') return json(200, { sid: m[1], status: body.Status });
      return json(404, { message: 'no route ' + p });
    }

    /* ---- Vapi ---- */
    if (u.host === 'api.vapi.ai') {
      if ((init.headers || {}).Authorization !== 'Bearer vapi-good') return json(401, { message: 'Invalid Key' });
      let m;
      if (p === '/assistant' && method === 'GET') return json(200, []);
      if (p === '/assistant' && method === 'POST') { const a = Object.assign({ id: nid('asst_') }, body); state.vapi.assistants[a.id] = a; return json(201, a); }
      if ((m = p.match(/^\/assistant\/(.+)$/))) {
        if (!state.vapi.assistants[m[1]]) return json(404, { message: 'not found' });
        if (method === 'PATCH') { Object.assign(state.vapi.assistants[m[1]], body); return json(200, state.vapi.assistants[m[1]]); }
        if (method === 'DELETE') { delete state.vapi.assistants[m[1]]; return json(200, {}); }
      }
      if (p === '/squad' && method === 'POST') { const s = Object.assign({ id: nid('squad_') }, body); state.vapi.squads[s.id] = s; return json(201, s); }
      if ((m = p.match(/^\/squad\/(.+)$/))) { if (method === 'PATCH') { Object.assign(state.vapi.squads[m[1]], body); return json(200, {}); } delete state.vapi.squads[m[1]]; return json(200, {}); }
      if (p === '/phone-number' && method === 'POST') { const n = Object.assign({ id: nid('pn_') }, body); state.vapi.numbers[n.id] = n; return json(201, n); }
      if ((m = p.match(/^\/phone-number\/(.+)$/))) { if (method === 'DELETE') delete state.vapi.numbers[m[1]]; else Object.assign(state.vapi.numbers[m[1]], body); return json(200, {}); }
      if (p === '/credential' && method === 'POST') { state.vapi.credentials.push(body); return json(201, { id: 'cred_1' }); }
      if (p === '/call' && method === 'POST') { state.vapi.calls.push(body); return json(201, { id: 'call_out_' + state.vapi.calls.length }); }
      return json(404, { message: 'no route ' + p });
    }
    if (u.host === 'control.vapi.test') { state.vapi.controls.push({ path: p, body }); return json(200, { ok: true }); }

    /* ---- OpenAI ---- */
    if (u.host === 'api.openai.com') {
      if ((init.headers || {}).Authorization !== 'Bearer sk-good') return json(401, { error: { message: 'Incorrect API key' } });
      if (p === '/v1/models') return json(200, { data: [] });
      if (p === '/v1/chat/completions') {
        state.openaiCalls++;
        return json(200, { choices: [{ message: { content: JSON.stringify({ score: 88, sentiment: 'positive', outcome: 'appointment_booked', summary: 'Jane booked a water heater estimate.', nextSteps: ['Send confirmation'], coaching: ['Confirm address earlier'], callerName: 'Jane Doe', callerEmail: 'jane@example.com', flags: ['none'] }) } }] });
      }
    }

    /* ---- HighLevel ---- */
    if (u.host === 'services.leadconnectorhq.com') {
      let m;
      if (p === '/oauth/token') {
        return json(200, { access_token: 'agency-at', refresh_token: 'agency-rt', expires_in: 86399, userType: 'Company', companyId: 'comp1', userId: 'user1', scope: 'x' });
      }
      if (p === '/oauth/locationToken') return json(200, { access_token: 'loc-at-' + body.locationId, expires_in: 86399 });
      if (p === '/companies/comp1') return json(200, { company: { name: 'Acme Agency' } });
      if (p === '/locations/search') return json(200, { locations: [{ id: 'loc1aaaaaaaa', name: 'Bob Plumbing' }, { id: 'loc2bbbbbbbb', name: 'Other Co' }] });
      if ((m = p.match(/^\/locations\/(\w+)\/customFields$/))) {
        if (method === 'GET') return json(200, { customFields: state.ghl.fields.filter((f) => f.locationId === m[1]) });
        const f = Object.assign({ id: nid('cf_'), locationId: m[1] }, body); state.ghl.fields.push(f); return json(201, { customField: f });
      }
      if ((m = p.match(/^\/locations\/(\w+)$/))) return json(200, { location: { id: m[1], name: 'Bob Plumbing', timezone: 'America/Chicago' } });
      if (p === '/opportunities/pipelines') return json(200, { pipelines: [{ id: 'pipe1', name: 'Sales', stages: [{ id: 'st_new', name: 'New' }, { id: 'st_booked', name: 'Booked' }] }] });
      if (p === '/calendars/') return json(200, { calendars: [{ id: 'cal1', name: 'Estimates' }] });
      if (p === '/calendars/cal1/free-slots') return json(200, { '2030-01-07': { slots: ['2030-01-07T09:00:00-06:00', '2030-01-07T10:00:00-06:00'] }, traceId: 'x' });
      if (p === '/calendars/events/appointments') { state.ghl.appointments.push(body); return json(201, { id: 'appt1' }); }
      if (p === '/contacts/upsert') { const cid = 'contact_' + (body.phone || 'x'); state.ghl.contacts[cid] = Object.assign(state.ghl.contacts[cid] || {}, body); return json(200, { contact: { id: cid } }); }
      if (p === '/contacts/search/duplicate') return json(200, { contact: { id: 'contact_x', firstName: 'Jane', lastName: 'Doe' } });
      if ((m = p.match(/^\/contacts\/(\w+[^/]*)\/notes$/))) { state.ghl.notes.push({ contactId: m[1], body: body.body }); return json(201, {}); }
      if ((m = p.match(/^\/contacts\/(\w+[^/]*)\/tags$/))) { state.ghl.tags.push({ contactId: m[1], tags: body.tags }); return json(201, {}); }
      if (p === '/conversations/messages' && method === 'POST') { state.ghl.sms.push(body); return json(201, { messageId: 'm' + state.ghl.sms.length }); }
      if ((m = p.match(/^\/contacts\/([^/]+)$/)) && m[1] !== 'upsert') {
        if (method === 'PUT') { if (body.dnd !== undefined) state.ghl.dnd[m[1]] = body.dnd; return json(200, { contact: { id: m[1] } }); }
        return json(200, { contact: { id: m[1], dnd: !!state.ghl.dnd[m[1]], tags: [] } });
      }
      if (p === '/opportunities/upsert') { state.ghl.opportunities.push(body); return json(200, { opportunity: { id: 'opp1' } }); }
      return json(404, { message: 'no route ' + p });
    }
    return json(404, { message: 'unknown host ' + u.host });
  }

  return { fetch, log, state };
}

module.exports = { createFakes };
