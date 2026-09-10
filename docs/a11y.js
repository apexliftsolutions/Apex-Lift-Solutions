/* ============================================================================
   Apex — accessibility helper (Group 3)
   2026-09-09.v25.0

   Dialog semantics, focus management and Escape handling for every modal in
   both portals.

   WHY IT IS AN OBSERVER RATHER THAN A REWRITE
   ---------------------------------------------------------------------------
   The portals open modals in two different ways: the newer service-plan and
   subscription dialogs toggle the `hidden` attribute, the older quote/invoice
   /payment dialogs toggle an `open` class. Editing ~30 call sites — several of
   which sit inside refund and payment flows — to add focus handling would mean
   touching money paths for an accessibility fix.

   Instead this watches for the visibility change and reacts. No existing
   open/close function is modified, so it cannot alter transaction sequencing.

   NOTHING HERE TOUCHES FINANCIAL STATE. It moves keyboard focus and sets ARIA
   attributes. Escape is refused outright while a dialog is marked busy, so a
   submitted refund or provider call can never be interrupted by a keystroke.
   ============================================================================ */
(function () {
  "use strict";

  var FOCUSABLE = [
    'a[href]', 'button:not([disabled])', 'input:not([disabled]):not([type="hidden"])',
    'select:not([disabled])', 'textarea:not([disabled])', '[tabindex]:not([tabindex="-1"])'
  ].join(',');

  var openStack = [];   // supports a dialog opened from another dialog

  function isVisible(el) {
    if (el.hidden) return false;
    var inline = el.getAttribute('style') || '';
    if (/display\s*:\s*none/i.test(inline)) return false;
    // .modal-overlay is display:none until `.open` is added.
    if (el.classList.contains('modal-overlay')) return el.classList.contains('open');
    return true;
  }

  function focusable(root) {
    return Array.prototype.filter.call(root.querySelectorAll(FOCUSABLE), function (el) {
      if (el.disabled || el.hidden) return false;
      if (el.getAttribute('aria-hidden') === 'true') return false;
      // A control inside a collapsed subtree is not reachable. Using closest()
      // rather than offsetParent keeps this correct in a browser AND in a test
      // DOM, where offsetParent is unimplemented and reads as null for
      // everything — which would otherwise empty the trap entirely.
      if (el.closest && el.closest('[hidden]')) return false;
      return true;
    });
  }

  /** A dialog marked busy has an operation in flight and must not be dismissed. */
  function isBusy(el) { return el.getAttribute('data-busy') === 'true'; }

  function onOpen(el) {
    if (openStack.indexOf(el) !== -1) return;
    var opener = document.activeElement;
    openStack.push(el);
    el.__apexOpener = (opener && opener !== document.body) ? opener : null;

    // Move focus to the dialog's own heading when it has one — the least
    // surprising landing spot, because a screen reader then reads the dialog's
    // purpose before its controls. Otherwise the first control.
    var heading = el.querySelector('h1,h2,h3,h4');
    var target;
    if (heading) {
      if (!heading.hasAttribute('tabindex')) heading.setAttribute('tabindex', '-1');
      target = heading;
    } else {
      target = focusable(el)[0] || el;
      if (target === el && !el.hasAttribute('tabindex')) el.setAttribute('tabindex', '-1');
    }
    try { target.focus(); } catch (e) { /* non-focusable in a test DOM */ }
  }

  function onClose(el) {
    var i = openStack.indexOf(el);
    if (i === -1) return;
    openStack.splice(i, 1);

    var opener = el.__apexOpener;
    el.__apexOpener = null;
    // Return focus only if the launcher still exists and can take it — after
    // "Save Forklift" the list is re-rendered and the original button is gone.
    if (opener && document.contains(opener) && !opener.disabled) {
      try { opener.focus(); return; } catch (e) { /* fall through */ }
    }
    // Try each selector IN PRIORITY ORDER. A single querySelector with a
    // comma-separated list returns the first match in DOCUMENT order, so
    // <body> — which precedes everything — always won, and focus was dumped at
    // the top of the page instead of on the content the user was working in.
    var fallback = null;
    var order = ['#main-content', 'main', '.view.active', '.view:not([hidden])', 'body'];
    for (var i = 0; i < order.length && !fallback; i++) {
      fallback = document.querySelector(order[i]);
    }
    if (fallback) {
      if (!fallback.hasAttribute('tabindex')) fallback.setAttribute('tabindex', '-1');
      try { fallback.focus(); } catch (e) { /* ignore */ }
    }
  }

  function top() { return openStack[openStack.length - 1] || null; }

  function onKeydown(e) {
    var el = top();
    if (!el) return;

    if (e.key === 'Escape') {
      if (isBusy(el)) { e.preventDefault(); return; }   // operation in flight
      var closer = el.querySelector('[data-a11y-close]') ||
                   Array.prototype.find.call(el.querySelectorAll('button'), function (b) {
                     return /^(cancel|close)\b/i.test((b.textContent || '').trim());
                   });
      if (closer) { e.preventDefault(); closer.click(); }
      return;
    }

    if (e.key !== 'Tab') return;
    var items = focusable(el);
    if (items.length === 0) { e.preventDefault(); return; }
    if (items.length === 1) { e.preventDefault(); try { items[0].focus(); } catch (x) {} return; }

    var first = items[0], last = items[items.length - 1];
    var active = document.activeElement;
    if (e.shiftKey && (active === first || !el.contains(active))) {
      e.preventDefault(); last.focus();
    } else if (!e.shiftKey && (active === last || !el.contains(active))) {
      e.preventDefault(); first.focus();
    }
  }

  function watch(el) {
    if (el.__apexWatched) return;
    el.__apexWatched = true;
    if (!el.getAttribute('role')) el.setAttribute('role', 'dialog');
    el.setAttribute('aria-modal', 'true');
    if (!el.getAttribute('aria-label') && !el.getAttribute('aria-labelledby')) {
      var h = el.querySelector('h1,h2,h3,h4');
      if (h) {
        if (!h.id) h.id = (el.id || 'dlg') + '-title';
        el.setAttribute('aria-labelledby', h.id);
      }
    }
    var was = isVisible(el);
    new MutationObserver(function () {
      var now = isVisible(el);
      if (now === was) return;
      was = now;
      now ? onOpen(el) : onClose(el);
    }).observe(el, { attributes: true, attributeFilter: ['hidden', 'class', 'style'] });
    if (was) onOpen(el);
  }

  function init() {
    var modals = document.querySelectorAll('.sp-modal, .modal-overlay, [data-a11y-dialog]');
    Array.prototype.forEach.call(modals, watch);
    document.addEventListener('keydown', onKeydown, true);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else { init(); }

  window.ApexA11y = {
    init: init,
    _openStack: openStack,
    _focusable: focusable,
    _isVisible: isVisible,
    /** Mark a dialog busy so Escape cannot dismiss it mid-operation. */
    setBusy: function (el, busy) {
      if (!el) return;
      busy ? el.setAttribute('data-busy', 'true') : el.removeAttribute('data-busy');
    }
  };
})();
