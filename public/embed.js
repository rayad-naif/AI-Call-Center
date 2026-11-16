/* HighLevel custom page: ask the parent CRM frame for the encrypted user
   context, exchange it for a session, then open the right view. */
(function () {
  'use strict';
  const box = document.getElementById('sso');
  let done = false;

  function fail(msg, install) {
    done = true;
    box.innerHTML = '';
    box.append(ACC.h('h1', 'Could not sign you in'), ACC.h('p', msg),
      install ? ACC.h('p', ACC.h('a.btn.primary', { href: install, target: '_top' }, 'Install the app')) : ACC.h('p.muted.small', 'You can also sign in at ', ACC.h('a', { href: '/login', target: '_blank' }, location.host + '/login')));
  }

  window.addEventListener('message', async (e) => {
    const d = e.data;
    if (done || !d || d.message !== 'REQUEST_USER_DATA_RESPONSE' || !d.payload) return;
    done = true;
    try {
      const r = await ACC.api('POST', '/api/auth/sso', { payload: d.payload });
      location.replace(r.redirect || '/deck');
    } catch (err) { fail(err.message, err.data && err.data.install); }
  });

  if (window.parent === window) return fail('Open this page from the HighLevel sidebar.');
  window.parent.postMessage({ message: 'REQUEST_USER_DATA' }, '*');
  setTimeout(() => { if (!done) fail('HighLevel did not respond. Reload the page.'); }, 10000);
})();
