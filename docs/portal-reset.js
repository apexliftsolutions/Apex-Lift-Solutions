/* ── Password-reset redirect shim (Surface E) ──────────────────────────────
   Externalised from portal-reset.html, byte-for-byte in behaviour.

   Supabase redirects here after the emailed link is opened. The destination is
   a FIXED same-origin relative path — it is never read from the URL — so there
   is no open redirect. The recovery state is forwarded as-is: the hash when
   present, otherwise the query string. Nothing is logged: the recovery token
   must never reach the console. */
(function () {
  'use strict';
  var dest = 'portal-forgot.html';
  if (window.location.hash) dest += window.location.hash;
  else if (window.location.search) dest += window.location.search;
  window.location.replace(dest);
})();
