/* ── Public contact forms (Surface E) ──────────────────────────────────────
   Externalised from three near-identical inline blocks in index.html,
   contact.html and careers.html. index and contact were byte-identical; careers
   differed only in the form element, the form type and the success panel, so
   the behaviour is now declared once as data and shared.

   Everything the inline versions did is preserved exactly: the same endpoint,
   the same form type strings, the same field normalisation, the _gotcha
   honeypot passed through untouched, the same button states, the same success
   the same success panel, the same retry state and the same phone fallback.

   public-contact WAS changed later, in the authorised P0 pass, to widen its
   field allow-list and handle insert failures. This module was not the cause
   of that and did not change with it.

   No inline handler is reintroduced — this attaches with addEventListener. */
(function () {
  'use strict';

  var ENDPOINT = 'https://cjtezsgfdfijmdxzzbiq.supabase.co/functions/v1/public-contact';

  // formId -> { type, successId }. The only things that ever differed.
  // Each form owns its own event names. A careers application is not a service
  // request, so it must never be counted as one — and an ATTEMPT is never a
  // conversion: the success event fires only after the server said r.ok.
  var FORMS = {
    contactForm: { type: 'request_service', successId: 'formSuccess',
                   attemptEvent: 'request_submit_attempt', successEvent: 'request_submit' },
    applyForm:   { type: 'careers',         successId: 'applySuccess',
                   attemptEvent: 'job_application_submit_attempt', successEvent: 'job_application_submit' }
  };
  function track(name, meta) {
    if (window.ApexConsent && typeof window.ApexConsent.track === 'function') window.ApexConsent.track(name, meta || {});
  }

  function normalise(fd, type) {
    var body = { form: type };
    fd.forEach(function (v, k) {
      // The honeypot keeps its exact name; the server checks for it verbatim.
      if (k === '_gotcha') { body._gotcha = v; return; }
      body[k.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '')] = v;
    });
    return body;
  }

  function wire(formId, cfg) {
    var f = document.getElementById(formId);
    if (!f || f.dataset.apexFormWired === '1') return;
    f.dataset.apexFormWired = '1';

    f.addEventListener('submit', async function (e) {
      e.preventDefault();
      track(cfg.attemptEvent, { form: cfg.type });          // attempt — not a conversion
      var btn = f.querySelector('.form-submit, [type=submit]');
      if (btn) { btn.disabled = true; btn.textContent = 'Sending…'; }
      try {
        var r = await fetch(ENDPOINT, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(normalise(new FormData(f), cfg.type))
        });
        if (!r.ok) throw new Error(r.status);
        f.reset();
        var ok = document.getElementById(cfg.successId);
        if (ok) ok.style.display = 'block';
        // The conversion. Fires once, only after the server confirmed the
        // submission — see index-tracking.js for the attempt-time counterpart.
        track(cfg.successEvent, { form: cfg.type });        // conversion — only after r.ok
        if (btn) btn.textContent = 'Sent ✓';
      } catch (err) {
        if (btn) { btn.disabled = false; btn.textContent = 'Try Again'; }
        alert('Could not send. Please call (516) 644-7187.');
      }
    });
  }

  function init() {
    for (var id in FORMS) {
      if (Object.prototype.hasOwnProperty.call(FORMS, id)) wire(id, FORMS[id]);
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
