/* ── Homepage tracking hooks (Surface E) ───────────────────────────────────
   consent.js decides otherwise, so nothing here can send analytics on its own
   and no GA code is embedded. consent.js remains the only authority.

   The contactForm submit hook is kept: it fires on SUBMIT, whereas
   public-forms.js fires on SUCCESS. That difference existed before this move
   and is preserved rather than quietly collapsed. */
(function () {
  'use strict';

  document.addEventListener('click', function (e) {
    var el = e.target.closest('[data-track]');
    if (el && window.ApexConsent && typeof window.ApexConsent.track === 'function') window.ApexConsent.track(el.getAttribute('data-track'), {});
  });

  // The contactForm submit hook was removed: public-forms.js emits the attempt
  // and success events itself, and a second listener here double-counted.
})();
