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
