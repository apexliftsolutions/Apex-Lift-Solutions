// =============================================
//  APEX LIFT SOLUTIONS — portal-forgot.js
//  Password reset via Supabase server-side OTP.
//
//  HOW IT WORKS (and why it's secure):
//  ────────────────────────────────────
//  Step 1 — User enters email.
//            _sb.auth.signInWithOtp({ email }) is called.
//            Supabase generates a 6-digit code on its servers
//            and emails it directly. No code ever exists in JS.
//
//  Step 2 — User enters the 6-digit code.
//            _sb.auth.verifyOtp({ email, token, type:'email' })
//            sends it to Supabase for server-side verification.
//            Right code  → Supabase returns a real session.
//            Wrong code  → Supabase returns an error. Period.
//            Opening DevTools and typing _verified = true does
//            nothing because there IS no _verified flag — the
//            gate in step3() is whether updateUser() succeeds,
//            which requires a live Supabase session.
//
//  Step 3 — User sets new password.
//            _sb.auth.updateUser({ password }) is called using
//            the session from step 2. No session = Supabase
//            rejects it. Then we sign out and redirect.
//
//  Required Supabase dashboard setting (one-time):
//    Auth → Email Templates → "Email OTP" — make sure it is
//    enabled and the template references {{ .Token }} (6-digit).
//    Auth → Configuration → OTP expiry: 600s recommended.
//
//  Depends on: supabase.min.js (pinned local vendor file), portal-data.js (_sb client)
// =============================================

// Use the _sb client from portal-data.js (loaded before this file)
const SUPA_URL_F = 'https://cjtezsgfdfijmdxzzbiq.supabase.co';
const SUPA_KEY_F = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImNqdGV6c2dmZGZpam1keHp6YmlxIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzgxNjg2OTIsImV4cCI6MjA5Mzc0NDY5Mn0.FkfIFgm5TUKa05nK4QQWdBRgK2cv3oPvq5MQArEUqbw';
const sb2 = (typeof _sb !== 'undefined') ? _sb : supabase.createClient(SUPA_URL_F, SUPA_KEY_F);

// ── STATE ─────────────────────────────────────
// Note: _forgotEmail is NOT a secret. The OTP itself is never in JS.
let _forgotEmail = '';
let _cdTimer     = null;
let _attempts    = 0;
const MAX_ATTEMPTS = 5;

// ── LOADING ───────────────────────────────────
function showLoad(show, msg) {
  document.getElementById('loading').className = show ? 'loading-overlay show' : 'loading-overlay';
  if (msg) document.getElementById('load-msg').textContent = msg;
}

// ── STEPPER ───────────────────────────────────
function setStep(n) {
  [1, 2, 3].forEach(i => {
    document.getElementById('st' + i).className = 'step' + (i < n ? ' done' : i === n ? ' active' : '');
    document.getElementById('v'  + i).className = 'step-view' + (i === n ? ' active' : '');
  });
  document.getElementById('track-fill').style.width = ['0%', '50%', '100%'][n - 1];
}

// ── STEP 1: REQUEST OTP FROM SUPABASE ─────────
async function step1() {
  const email = document.getElementById('s1-email').value.trim().toLowerCase();
  const err   = document.getElementById('s1-err');
  err.style.display = 'none';

  if (!email || !email.includes('@')) {
    err.textContent = 'Please enter a valid email address.';
    err.style.display = 'block';
    return;
  }

  showLoad(true, 'Sending code…');

  // Supabase generates and emails the code. The browser never sees it.
  // shouldCreateUser: false means unregistered emails silently do nothing
  // (but we still advance to step 2 to prevent email enumeration attacks).
  await sb2.auth.signInWithOtp({
    email,
    options: { shouldCreateUser: false }
  });

  showLoad(false);

  _forgotEmail = email;
  _attempts    = 0;
  document.getElementById('v2-email').textContent = email;
  startCountdown(60);
  setStep(2);
  setTimeout(() => document.getElementById('o0')?.focus(), 150);
}

// ── COUNTDOWN + RESEND ────────────────────────
function startCountdown(sec) {
  const cd  = document.getElementById('resend-cd');
  const btn = document.getElementById('resend-btn');
  btn.style.display = 'none';
  let rem = sec;
  cd.textContent = '(' + rem + 's)';
  if (_cdTimer) clearInterval(_cdTimer);
  _cdTimer = setInterval(() => {
    rem--;
    if (rem <= 0) { clearInterval(_cdTimer); cd.textContent = ''; btn.style.display = 'inline'; }
    else cd.textContent = '(' + rem + 's)';
  }, 1000);
}

async function resendCode() {
  if (!_forgotEmail) return;
  for (let i = 0; i < 6; i++) {
    const el = document.getElementById('o' + i);
    if (el) { el.value = ''; el.className = 'otp-box'; }
  }
  document.getElementById('s2-err').style.display = 'none';
  document.getElementById('resend-btn').style.display = 'none';
  _attempts = 0;

  showLoad(true, 'Sending new code…');
  // New request invalidates the previous code on Supabase's side
  await sb2.auth.signInWithOtp({ email: _forgotEmail, options: { shouldCreateUser: false } });
  showLoad(false);

  startCountdown(60);
  document.getElementById('o0')?.focus();
}

// ── OTP BOX UX ────────────────────────────────
function otpIn(el, idx) {
  const raw = el.value.replace(/\D/g, '');
  if (raw.length > 1) {
    // Paste handling — fill boxes and auto-submit
    raw.slice(0, 6).split('').forEach((d, i) => {
      const box = document.getElementById('o' + i);
      if (box) { box.value = d; box.className = 'otp-box filled'; }
    });
    document.getElementById('o' + Math.min(raw.length - 1, 5))?.focus();
    el.value = raw[0];
    if (raw.length >= 6) setTimeout(step2, 120);
    return;
  }
  el.value = raw;
  el.className = raw ? 'otp-box filled' : 'otp-box';
  if (raw && idx < 5) document.getElementById('o' + (idx + 1)).focus();
  if (raw && idx === 5) setTimeout(step2, 120);   // auto-submit on last digit
}

function otpKey(e, idx) {
  if (e.key === 'Backspace' && !document.getElementById('o' + idx).value && idx > 0) {
    document.getElementById('o' + (idx - 1)).focus();
  }
  if (e.key === 'Enter') step2();
}

// ── STEP 2: VERIFY OTP SERVER-SIDE ───────────
async function step2() {
  let code = '';
  for (let i = 0; i < 6; i++) code += (document.getElementById('o' + i)?.value || '');
  const err = document.getElementById('s2-err');
  err.style.display = 'none';

  if (code.length < 6) {
    err.textContent = 'Please enter all 6 digits of the code.';
    err.style.display = 'block';
    return;
  }

  if (_attempts >= MAX_ATTEMPTS) {
    err.textContent = 'Too many incorrect attempts. Use "Resend code" to get a fresh code.';
    err.style.display = 'block';
    return;
  }

  showLoad(true, 'Verifying…');

  // THE REAL SECURITY GATE.
  // Supabase compares `code` against what it generated.
  // Success → real session returned. Failure → error returned.
  // There is nothing in JS to fake — no stored code, no flag to flip.
  const { error } = await sb2.auth.verifyOtp({
    email: _forgotEmail,
    token: code,
    type:  'email'
  });

  showLoad(false);

  if (error) {
    _attempts++;
    const left = MAX_ATTEMPTS - _attempts;
    for (let i = 0; i < 6; i++) {
      const b = document.getElementById('o' + i);
      if (b) { b.className = 'otp-box shake'; setTimeout(() => b.className = b.value ? 'otp-box filled' : 'otp-box', 500); }
    }
    err.textContent = left <= 0
      ? 'Too many incorrect attempts. Please use "Resend code".'
      : `Incorrect code — ${left} attempt${left === 1 ? '' : 's'} remaining.`;
    err.style.display = 'block';
    return;
  }

  // verifyOtp succeeded — Supabase has an active session.
  if (_cdTimer) clearInterval(_cdTimer);
  setStep(3);
  setTimeout(() => document.getElementById('s3-pass')?.focus(), 150);
}

// ── STEP 3: SET NEW PASSWORD ──────────────────
// updateUser requires the session from step 2. No session → Supabase rejects.
// There is no JS bypass possible.
function strengthCheck() {
  const p  = document.getElementById('s3-pass').value;
  const sf = document.getElementById('sf');
  const sh = document.getElementById('sh');
  let score = 0;
  if (p.length >= 8)          score++;
  if (p.length >= 12)         score++;
  if (/[A-Z]/.test(p))        score++;
  if (/[0-9]/.test(p))        score++;
  if (/[^A-Za-z0-9]/.test(p)) score++;
  const lvl = [
    { w: '20%',  c: 'var(--red-danger)', t: 'Too weak' },
    { w: '40%',  c: '#ff7700', t: 'Weak'     },
    { w: '60%',  c: '#ffaa00', t: 'Fair'     },
    { w: '80%',  c: '#88cc00', t: 'Good'     },
    { w: '100%', c: '#4caf50', t: 'Strong ✓' }
  ][Math.min(score, 4)];
  sf.style.cssText = `width:${p ? lvl.w : '0'};background:${lvl.c}`;
  sh.textContent   = p ? lvl.t : 'Enter a password';
  sh.style.color   = p ? lvl.c : 'var(--grey)';
}

async function step3() {
  const pass  = document.getElementById('s3-pass').value;
  const pass2 = document.getElementById('s3-pass2').value;
  const err   = document.getElementById('s3-err');
  const suc   = document.getElementById('s3-suc');
  err.style.display = 'none';
  suc.style.display = 'none';

  if (pass.length < 8) { err.textContent = 'Password must be at least 8 characters.'; err.style.display = 'block'; return; }
  if (pass !== pass2)  { err.textContent = 'Passwords do not match.'; err.style.display = 'block'; return; }

  showLoad(true, 'Saving new password…');

  const { error } = await sb2.auth.updateUser({ password: pass });

  showLoad(false);

  if (error) {
    err.textContent = error.message.toLowerCase().includes('session')
      ? 'Your session expired. Please go back and request a new code.'
      : 'Could not update password: ' + error.message;
    err.style.display = 'block';
    return;
  }

  suc.textContent = '✓ Password updated! Redirecting to sign in…';
  suc.style.display = 'block';
  document.getElementById('s3-btn').style.display = 'none';

  await sb2.auth.signOut();
  setTimeout(() => window.location.href = 'portal-login.html', 2000);
}

document.getElementById('s1-email')?.addEventListener('keydown', e => { if (e.key === 'Enter') step1(); });


/* ── Event wiring (CSP readiness) ──────────────────────────────────────────
   Same shape as the login page. The six OTP boxes carry their position in
   data-index rather than in a generated function call, so no index is ever
   compiled as code. keydown is delegated too, which keeps the arrow/backspace
   behaviour identical. */
function wireForgotPage() {
  const root = document.body;
  if (!root || root.dataset.apexWired === '1') return;
  root.dataset.apexWired = '1';

  root.addEventListener('click', (e) => {
    const el = e.target.closest('[data-action]');
    if (!el) return;
    switch (el.dataset.action) {
      case 'send-code':      step1(); break;
      case 'verify-code':    step2(); break;
      case 'resend':         resendCode(); break;
      case 'reset-password': step3(); break;
      default: break;
    }
  });

  root.addEventListener('input', (e) => {
    const el = e.target.closest('[data-action]');
    if (!el) return;
    if (el.dataset.action === 'otp') otpIn(el, Number(el.dataset.index));
    else if (el.dataset.action === 'strength') strengthCheck();
  });

  root.addEventListener('keydown', (e) => {
    const el = e.target.closest('[data-action="otp"]');
    if (el) otpKey(e, Number(el.dataset.index));
  });
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', wireForgotPage);
else wireForgotPage();
