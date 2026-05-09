// =============================================
//  APEX LIFT SOLUTIONS — main.js
//  Public site JS: nav, scroll reveal, forms.
//  Used by: index, about, services, plans,
//           contact, careers.
// =============================================

// ── NAV: scroll effect ────────────────────────
const navbar = document.getElementById('navbar');
window.addEventListener('scroll', () => {
  navbar.classList.toggle('scrolled', window.scrollY > 40);
});

// Inner pages have no hero — always show scrolled style
if (!document.getElementById('hero')) {
  navbar.classList.add('scrolled');
}

// ── NAV: mobile hamburger ─────────────────────
const hamburger = document.getElementById('hamburger');
const mobileMenu = document.getElementById('mobileMenu');

hamburger.addEventListener('click', () => {
  hamburger.classList.toggle('open');
  mobileMenu.classList.toggle('open');
});

mobileMenu.querySelectorAll('a').forEach(link => {
  link.addEventListener('click', () => {
    hamburger.classList.remove('open');
    mobileMenu.classList.remove('open');
  });
});

// ── SCROLL REVEAL ─────────────────────────────
const revealSelectors = [
  '.service-card', '.fleet-card', '.why-list li',
  '.testimonial', '.info-block', '.section-header',
  '.stat', '.perk-card', '.job-card', '.faq-item',
  '.plan-step', '.value-card', '.reveal'
];

document.querySelectorAll(revealSelectors.join(', ')).forEach(el => {
  if (!el.classList.contains('reveal')) el.classList.add('reveal');
});

const revealObserver = new IntersectionObserver((entries) => {
  entries.forEach(entry => {
    if (entry.isIntersecting) {
      const delay = parseInt(entry.target.dataset.delay) || 0;
      setTimeout(() => entry.target.classList.add('visible'), delay);
      revealObserver.unobserve(entry.target);
    }
  });
}, { threshold: 0.1 });

document.querySelectorAll('.reveal').forEach(el => revealObserver.observe(el));

// ── CONTACT FORM (Formspree) ──────────────────
// No preventDefault — Formspree needs the native POST.
const contactForm = document.getElementById('contactForm');
if (contactForm) {
  contactForm.addEventListener('submit', function () {
    const btn = this.querySelector('.form-submit');
    btn.textContent = 'Sending…';
    btn.disabled = true;
  });
}

// ── APPLY FORM (Formspree) ────────────────────
const applyForm = document.getElementById('applyForm');
if (applyForm) {
  applyForm.addEventListener('submit', function () {
    const btn = this.querySelector('.form-submit');
    btn.textContent = 'Submitting…';
    btn.disabled = true;
  });
}

// ── ACTIVE NAV HIGHLIGHT (section-based, homepage only) ──
const sections = document.querySelectorAll('section[id]');
const navLinks  = document.querySelectorAll('.nav-links a');

if (sections.length > 0) {
  const sectionObserver = new IntersectionObserver(entries => {
    entries.forEach(entry => {
      if (entry.isIntersecting) {
        navLinks.forEach(link => {
          link.style.color = '';
          if (link.getAttribute('href') === '#' + entry.target.id) {
            link.style.color = '#cc0000';
          }
        });
      }
    });
  }, { threshold: 0.4 });

  sections.forEach(s => sectionObserver.observe(s));
}

// ── PHONE FORMATTER ───────────────────────────
// Formats (555) 000-0000 in real time on all tel inputs.
// Handles: typing digit by digit, pasting a raw number,
// pasting with dashes/dots, copying from contacts, etc.
function formatPhone(input) {
  const digits = input.value.replace(/\D/g, '').slice(0, 10);
  let formatted = '';

  if (digits.length === 0) {
    formatted = '';
  } else if (digits.length <= 3) {
    // 5 → (5   |   51 → (51   |   516 → (516
    formatted = '(' + digits;
  } else if (digits.length <= 6) {
    // 5166 → (516) 6   |   516644 → (516) 644
    formatted = '(' + digits.slice(0, 3) + ') ' + digits.slice(3);
  } else {
    // 5166447 → (516) 644-7   |   5166447187 → (516) 644-7187
    formatted = '(' + digits.slice(0, 3) + ') ' + digits.slice(3, 6) + '-' + digits.slice(6);
  }

  // Only reassign if changed — prevents cursor jumping mid-edit
  if (input.value !== formatted) input.value = formatted;
}

document.querySelectorAll('input[type="tel"]').forEach(function(input) {
  input.addEventListener('input', function() { formatPhone(input); });
  // Paste needs a tick to let the browser write the pasted value first
  input.addEventListener('paste', function() { setTimeout(function() { formatPhone(input); }, 0); });
});

// ── AUTO COPYRIGHT YEAR ───────────────────────
// Updates every footer copyright year automatically so it never goes stale.
document.querySelectorAll('.footer-copy').forEach(el => {
  el.innerHTML = el.innerHTML.replace(/© \d{4}/, '© ' + new Date().getFullYear());
});

// ── GA4 BUSINESS EVENT TRACKING ──────────────
// Tracks key business interactions in Google Analytics.
// Events appear in GA4 → Reports → Events.
// Requires the GA4 gtag snippet in the <head> of each page.

(function setupTracking() {
  // Helper — fires gtag only if it's loaded
  function track(eventName, params) {
    if (typeof gtag === 'function') {
      gtag('event', eventName, params || {});
    }
  }

  // ── Phone click ──────────────────────────────
  document.querySelectorAll('a[href^="tel:"]').forEach(el => {
    el.addEventListener('click', () => {
      track('phone_click', { event_category: 'contact', event_label: 'tel:+15166447187' });
    });
  });

  // ── Email click ──────────────────────────────
  document.querySelectorAll('a[href^="mailto:"]').forEach(el => {
    el.addEventListener('click', () => {
      track('email_click', { event_category: 'contact', event_label: el.href });
    });
  });

  // ── Get a Quote CTA ──────────────────────────
  document.querySelectorAll('a[href="contact.html"], a[href="./contact.html"]').forEach(el => {
    if (el.textContent.trim().toLowerCase().includes('quote')) {
      el.addEventListener('click', () => {
        track('get_quote_click', { event_category: 'cta', event_label: document.title });
      });
    }
  });

  // ── View Plans click ─────────────────────────
  document.querySelectorAll('a[href="plans.html"], a[href="./plans.html"]').forEach(el => {
    el.addEventListener('click', () => {
      track('view_plans_click', { event_category: 'cta', event_label: document.title });
    });
  });

  // ── Client Portal click ──────────────────────
  document.querySelectorAll('a[href="portal-login.html"]').forEach(el => {
    el.addEventListener('click', () => {
      track('client_portal_click', { event_category: 'navigation' });
    });
  });

  // ── Contact form submit ───────────────────────
  const contactForm = document.getElementById('contactForm');
  if (contactForm) {
    contactForm.addEventListener('submit', () => {
      track('quote_request_submit', {
        event_category: 'lead',
        event_label: (document.getElementById('service')?.value || 'unknown service')
      });
    });
  }

  // ── Apply form submit ─────────────────────────
  const applyForm = document.getElementById('applyForm');
  if (applyForm) {
    applyForm.addEventListener('submit', () => {
      track('job_application_submit', {
        event_category: 'careers',
        event_label: (document.getElementById('a-position')?.value || 'unknown role')
      });
    });
  }

  // ── Page-level tracking (which pages get traffic) ──
  track('page_view_custom', {
    event_category: 'page',
    event_label: window.location.pathname
  });
})();
