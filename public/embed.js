/* CRM custom page: ask the parent CRM frame for the encrypted user
   context, exchange it for a session, then open the right view.
   If the CRM never answers (for example the page was added as a plain menu
   link instead of the app's Custom Page), offer email sign-in in place. */
(function () {
  'use strict';
  const box = document.getElementById('sso');
  let done = false;
  let tries = 0;

  function fail(msg, install) {
    done = true;
    box.innerHTML = '';
    box.append(ACC.h('h1', 'Sign in'), ACC.h('p', msg),
      install
        ? ACC.h('p', ACC.h('a.btn.primary', { href: install, target: '_top' }, 'Install the app'))
        : ACC.h('p', ACC.h('a.btn.primary', { href: '/login' }, 'Sign in with email'), ' ', ACC.h('a.btn', { href: '/embed?sso=1' }, 'Try again')));
  }

  // The CRM has sent this in a few shapes over time: an object, a JSON
  // string, or the payload nested under data.
  function payloadOf(raw) {
    let d = raw;
    if (typeof d === 'string') { try { d = JSON.parse(d); } catch (e) { return null; } }
    if (!d || typeof d !== 'object') return null;
    if (d.message !== 'REQUEST_USER_DATA_RESPONSE') return null;
    return d.payload || (d.data && d.data.payload) || null;
  }

  window.addEventListener('message', async (e) => {
    const payload = payloadOf(e.data);
    if (done || !payload) return;
    done = true;
    try {
      const r = await ACC.api('POST', '/api/auth/sso', { payload });
      location.replace(r.redirect || '/deck');
    } catch (err) { fail(err.message, err.data && err.data.install); }
  });

  if (window.parent === window) return fail('Open this page from the left menu of your CRM, or sign in with your email.');
  // Ask again a few times: the CRM frame may not be listening yet on first load.
  const ask = () => { if (done) return; tries++; window.parent.postMessage({ message: 'REQUEST_USER_DATA' }, '*'); if (tries < 6) setTimeout(ask, 1200); };
  ask();
  setTimeout(() => { if (!done) fail('The CRM did not send your sign-in details. This happens when the page is added as a menu link instead of the app\'s Custom Page. You can sign in with your email instead.'); }, 9000);
})();
