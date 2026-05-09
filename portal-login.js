// =============================================
//  APEX LIFT SOLUTIONS — portal-login.js
//  Handles sign-in and self-registration.
//  Depends on: supabase.min.js (loaded before)
// =============================================

const SUPA_URL    = 'https://cjtezsgfdfijmdxzzbiq.supabase.co';
const SUPA_KEY    = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImNqdGV6c2dmZGZpam1keHp6YmlxIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzgxNjg2OTIsImV4cCI6MjA5Mzc0NDY5Mn0.FkfIFgm5TUKa05nK4QQWdBRgK2cv3oPvq5MQArEUqbw';
const ADMIN_EMAIL = 'admin@apexliftsolutionsusa.com';
const _sb         = supabase.createClient(SUPA_URL, SUPA_KEY);

let _activeTab = 'login';

// ── UI HELPERS ────────────────────────────────
function showLoad(on, msg) {
  document.getElementById('loading').className = on ? 'loading-overlay show' : 'loading-overlay';
  if (msg) document.getElementById('load-msg').textContent = msg;
}
function showErr(id, msg) { const el = document.getElementById(id); el.textContent = msg; el.style.display = 'block'; }
function clearErr(id) { document.getElementById(id).style.display = 'none'; }

// ── TAB SWITCHING ─────────────────────────────
function switchTab(tab, btn) {
  _activeTab = tab;
  document.querySelectorAll('.portal-tab').forEach(t => t.classList.remove('active'));
  document.querySelectorAll('.tab-content').forEach(t => t.classList.remove('active'));
  document.getElementById('tab-' + tab).classList.add('active');
  btn.classList.add('active');
  clearErr('login-err'); clearErr('reg-err');
  document.getElementById('reg-suc').style.display = 'none';
}

// ── PASSWORD EYE TOGGLE ───────────────────────
const SVG_EYE = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>`;
const SVG_OFF = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17.94 17.94A10.07 10.07 0 0112 20c-7 0-11-8-11-8a18.45 18.45 0 015.06-5.94"/><path d="M9.9 4.24A9.12 9.12 0 0112 4c7 0 11 8 11 8a18.5 18.5 0 01-2.16 3.19"/><line x1="1" y1="1" x2="23" y2="23"/></svg>`;

function togglePw(inputId, btn) {
  const inp = document.getElementById(inputId);
  const show = inp.type === 'password';
  inp.type = show ? 'text' : 'password';
  btn.innerHTML = show ? SVG_OFF : SVG_EYE;
}

// ── PASSWORD STRENGTH ─────────────────────────
function checkStrength(val) {
  const fill  = document.getElementById('str-fill');
  const label = document.getElementById('str-label');
  if (!val) { fill.style.width = '0'; label.textContent = ''; return; }
  let score = 0;
  if (val.length >= 8)          score++;
  if (val.length >= 12)         score++;
  if (/[A-Z]/.test(val))        score++;
  if (/[0-9]/.test(val))        score++;
  if (/[^A-Za-z0-9]/.test(val)) score++;
  const levels = [
    { w: '15%', c: '#cc0000', t: 'Too weak' },
    { w: '35%', c: '#ff6600', t: 'Weak'     },
    { w: '58%', c: '#ffaa00', t: 'Fair'     },
    { w: '80%', c: '#88cc00', t: 'Good'     },
    { w: '100%',c: '#4caf50', t: 'Strong ✓' }
  ];
  const l = levels[Math.min(score, 4)];
  fill.style.width      = l.w;
  fill.style.background = l.c;
  label.textContent     = l.t;
  label.style.color     = l.c;
}

// ── LOGIN ─────────────────────────────────────
async function handleLogin() {
  let email  = document.getElementById('login-email').value.trim().toLowerCase();
  const pass = document.getElementById('login-pass').value;
  clearErr('login-err');

  if (!email) { showErr('login-err', 'Please enter your email address.'); return; }
  if (!pass)  { showErr('login-err', 'Please enter your password.'); return; }

  // Convenience shortcut: type "admin" to log in as admin
  if (email === 'admin') email = ADMIN_EMAIL;

  showLoad(true, 'Signing in...');
  try {
    const { data, error } = await _sb.auth.signInWithPassword({ email, password: pass });
    if (error) { showLoad(false); showErr('login-err', 'Incorrect email or password. Please try again.'); return; }

    if (email === ADMIN_EMAIL) { window.location.href = 'portal-admin.html'; return; }

    const { data: profile } = await _sb.from('customers').select('*').eq('id', data.user.id).single();
    showLoad(false);

    if (!profile) {
      await _sb.auth.signOut();
      showErr('login-err', 'Account not found. Please contact us at (516) 644-7187.');
      return;
    }
    if (profile.status === 'pending') {
      await _sb.auth.signOut();
      showErr('login-err', "Your account is pending activation. We'll contact you within 1 business day.");
      return;
    }
    if (profile.status === 'inactive') {
      await _sb.auth.signOut();
      showErr('login-err', 'Your account has been deactivated. Please call (516) 644-7187.');
      return;
    }

    window.location.href = 'portal-customer.html';
  } catch (e) {
    showLoad(false);
    console.error('Login error:', e);
    showErr('login-err', 'Connection error. Please check your internet and try again.');
  }
}

// ── REGISTER ──────────────────────────────────
async function handleRegister() {
  const name    = document.getElementById('reg-name').value.trim();
  const company = document.getElementById('reg-company').value.trim();
  const email   = document.getElementById('reg-email').value.trim().toLowerCase();
  const phone   = document.getElementById('reg-phone').value.trim();
  const pass    = document.getElementById('reg-pass').value;
  const pass2   = document.getElementById('reg-pass2').value;
  const suc     = document.getElementById('reg-suc');
  clearErr('reg-err');
  suc.style.display = 'none';

  if (!name)               { showErr('reg-err', 'Please enter your full name.'); return; }
  if (!email)              { showErr('reg-err', 'Please enter your email address.'); return; }
  if (!email.includes('@')){ showErr('reg-err', 'Please enter a valid email address.'); return; }
  if (!pass)               { showErr('reg-err', 'Please create a password.'); return; }
  if (pass.length < 8)     { showErr('reg-err', 'Password must be at least 8 characters.'); return; }
  if (pass !== pass2)      { showErr('reg-err', 'Passwords do not match.'); return; }

  showLoad(true, 'Creating your account...');
  try {
    const { data, error } = await _sb.auth.signUp({
      email, password: pass,
      options: { data: { name, company, phone } }
    });

    if (error) {
      showLoad(false);
      showErr('reg-err', error.message.toLowerCase().includes('already')
        ? 'This email is already registered. Try signing in instead.'
        : error.message || 'Registration failed. Please try again.');
      return;
    }

    if (data.user) {
      const { error: pErr } = await _sb.from('customers').insert({
        id: data.user.id, email, name,
        company: company || '', phone: phone || '',
        status: 'pending',
        since: new Date().toLocaleDateString('en-US', { month: 'long', year: 'numeric' })
      });
      if (pErr) console.warn('Profile insert warning:', pErr.message);
    }

    await _sb.auth.signOut();
    showLoad(false);

    suc.textContent = `✓ Account created! We'll review and activate it within 1 business day. You'll hear from us at ${email}.`;
    suc.style.display = 'block';
    ['reg-name','reg-email','reg-pass','reg-pass2','reg-company','reg-phone']
      .forEach(id => { document.getElementById(id).value = ''; });
    checkStrength('');
  } catch (e) {
    showLoad(false);
    console.error('Register error:', e);
    showErr('reg-err', 'Connection error. Please try again.');
  }
}

// ── ENTER KEY ─────────────────────────────────
document.addEventListener('keydown', e => {
  if (e.key !== 'Enter') return;
  if (_activeTab === 'login')    handleLogin();
  else if (_activeTab === 'register') handleRegister();
});

// ── AUTO-REDIRECT IF ALREADY LOGGED IN ───────
(async () => {
  try {
    const { data: { session } } = await _sb.auth.getSession();
    if (session) {
      window.location.href = session.user.email === ADMIN_EMAIL
        ? 'portal-admin.html' : 'portal-customer.html';
    }
  } catch (e) { /* stay on page */ }
})();
