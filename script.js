// =============================================
//  APEX LIFT SOLUTIONS — script.js
// =============================================

// ——— NAV: scroll effect ———
const navbar = document.getElementById('navbar');
window.addEventListener('scroll', () => {
  navbar.classList.toggle('scrolled', window.scrollY > 40);
});

// Force scrolled state on inner pages (no full hero)
if (!document.getElementById('hero')) {
  navbar.classList.add('scrolled');
}

// ——— NAV: mobile hamburger ———
const hamburger = document.getElementById('hamburger');
const mobileMenu = document.getElementById('mobileMenu');
hamburger.addEventListener('click', () => {
  hamburger.classList.toggle('open');
  mobileMenu.classList.toggle('open');
});

// Close mobile menu when a link is clicked
mobileMenu.querySelectorAll('a').forEach(link => {
  link.addEventListener('click', () => {
    hamburger.classList.remove('open');
    mobileMenu.classList.remove('open');
  });
});

// ——— SCROLL REVEAL ———
const revealEls = document.querySelectorAll(
  '.service-card, .fleet-card, .why-list li, .testimonial, .info-block, .section-header, .stat, .reveal, .perk-card, .job-card, .faq-item, .plan-step, .value-card'
);
revealEls.forEach(el => {
  if (!el.classList.contains('reveal')) el.classList.add('reveal');
});

const observer = new IntersectionObserver((entries) => {
  entries.forEach((entry) => {
    if (entry.isIntersecting) {
      const delay = entry.target.dataset.delay || 0;
      setTimeout(() => {
        entry.target.classList.add('visible');
      }, parseInt(delay));
      observer.unobserve(entry.target);
    }
  });
}, { threshold: 0.1 });

document.querySelectorAll('.reveal').forEach(el => observer.observe(el));

// ——— CONTACT FORM (Formspree) ———
// IMPORTANT: No e.preventDefault() — that would block Formspree from receiving the data.
// We just show a loading state and let the form POST naturally to Formspree.
const form = document.getElementById('contactForm');
if (form) {
  form.addEventListener('submit', function() {
    const btn = form.querySelector('.form-submit');
    btn.textContent = 'Sending...';
    btn.disabled = true;
  });
}

// ——— APPLY FORM (Formspree) ———
const applyForm = document.getElementById('applyForm');
if (applyForm) {
  applyForm.addEventListener('submit', function() {
    const btn = applyForm.querySelector('.form-submit');
    btn.textContent = 'Submitting...';
    btn.disabled = true;
  });
}

// ——— SMOOTH ACTIVE NAV HIGHLIGHT (homepage only) ———
const sections = document.querySelectorAll('section[id]');
const navLinks = document.querySelectorAll('.nav-links a');

if (sections.length > 0) {
  const sectionObserver = new IntersectionObserver((entries) => {
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
