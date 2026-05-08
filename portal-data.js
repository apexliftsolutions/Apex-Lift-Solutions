// =============================================
// APEX LIFT SOLUTIONS — Supabase Portal Data
// Uses Supabase Auth (JWT) — no client-side
// role checks or hardcoded credentials.
// =============================================

const SUPABASE_URL = 'https://cjtezsgfdfijmdxzzbiq.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImNqdGV6c2dmZGZpam1keHp6YmlxIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzgxNjg2OTIsImV4cCI6MjA5Mzc0NDY5Mn0.FkfIFgm5TUKa05nK4QQWdBRgK2cv3oPvq5MQArEUqbw';

// XSS prevention — escape ALL user-supplied data before inserting into DOM
function esc(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ── SUPABASE AUTH CLIENT ─────────────────────
// We use the Supabase JS v2 CDN for Auth.
// Auth tokens are stored in localStorage by Supabase (httpOnly not available
// in a pure static site, but Supabase sessions are JWT-signed and validated
// server-side via RLS — the browser cannot forge a valid JWT).
const _sb = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// ── REST API HELPER (uses current session token) ──
const SB = {
  async headers() {
    const { data: { session } } = await _sb.auth.getSession();
    const token = session?.access_token || SUPABASE_ANON_KEY;
    return {
      'Content-Type': 'application/json',
      'apikey': SUPABASE_ANON_KEY,
      'Authorization': 'Bearer ' + token,
      'Prefer': 'return=representation'
    };
  },
  async get(table, params = '') {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}${params}`, { headers: await this.headers() });
    if (!res.ok) { console.error('SB.get error:', res.status, await res.text()); return []; }
    return res.json();
  },
  async post(table, body) {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}`, {
      method: 'POST', headers: await this.headers(), body: JSON.stringify(body)
    });
    if (!res.ok) { console.error('SB.post error:', res.status, await res.text()); return null; }
    const data = await res.json();
    return Array.isArray(data) ? data[0] : data;
  },
  async patch(table, filter, body) {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}?${filter}`, {
      method: 'PATCH', headers: await this.headers(), body: JSON.stringify(body)
    });
    if (!res.ok) { console.error('SB.patch error:', res.status, await res.text()); return null; }
    const data = await res.json();
    return Array.isArray(data) ? data[0] : data;
  },
  async delete(table, filter) {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}?${filter}`, {
      method: 'DELETE', headers: await this.headers()
    });
    if (!res.ok) { console.error('SB.delete error:', res.status, await res.text()); return false; }
    return true;
  }
};

// ── AUTH ─────────────────────────────────────
// All auth goes through Supabase Auth. Sessions are JWT-signed.
// RLS policies enforce data access server-side regardless of what
// the client sends. The browser cannot forge a valid session token.

const ADMIN_EMAIL = 'admin@apexliftsolutionsusa.com';

const Auth = {
  // Sign in via Supabase Auth email/password
  async signIn(email, password) {
    const { data, error } = await _sb.auth.signInWithPassword({ email, password });
    if (error) return { error: error.message };
    return { user: data.user, session: data.session };
  },

  // Sign up new customer via Supabase Auth
  async signUp(email, password, meta) {
    const { data, error } = await _sb.auth.signUp({
      email, password,
      options: { data: meta }  // name, company, phone stored in user_metadata
    });
    if (error) return { error: error.message };
    return { user: data.user };
  },

  // Sign out
  async signOut() {
    await _sb.auth.signOut();
  },

  // Get current session (null if not logged in)
  async getSession() {
    const { data: { session } } = await _sb.auth.getSession();
    return session;
  },

  // Get current user
  async getUser() {
    const { data: { user } } = await _sb.auth.getUser();
    return user;
  },

  // Check if current user is admin (server-validated via email)
  async isAdmin() {
    const user = await this.getUser();
    return user?.email === ADMIN_EMAIL;
  },

  // Reset password via Supabase (sends email with magic link)
  async resetPasswordEmail(email) {
    const { error } = await _sb.auth.resetPasswordForEmail(email, {
      redirectTo: window.location.origin + '/portal-reset.html'
    });
    return { error: error?.message || null };
  },

  // Update password (called from reset page after redirect)
  async updatePassword(newPassword) {
    const { error } = await _sb.auth.updateUser({ password: newPassword });
    return { error: error?.message || null };
  }
};

// ── DATABASE ─────────────────────────────────
// RLS policies mean the database enforces access.
// Customers only get their own rows. Admin gets all rows.

const DB = {

  // ── CUSTOMERS ────────────────────────────────

  // Register: create auth user + customer profile row
  async registerCustomer({ name, company, email, phone, password }) {
    const { user, error } = await Auth.signUp(email, password, { name, company, phone });
    if (error) return { error };
    if (user) {
      // Create customer profile row (status: pending until admin activates)
      await SB.post('customers', {
        id: user.id,
        email,
        name,
        company: company || '',
        phone: phone || '',
        status: 'pending',
        since: new Date().toLocaleDateString('en-US', { month: 'long', year: 'numeric' })
      });
    }
    return { user };
  },

  async getAllCustomers() {
    return SB.get('customers', '?order=created_at.desc');
  },

  async updateCustomerStatus(id, status) {
    return SB.patch('customers', `id=eq.${encodeURIComponent(id)}`, { status });
  },

  async deleteCustomer(id) {
    return SB.delete('customers', `id=eq.${encodeURIComponent(id)}`);
  },

  // ── QUOTES ───────────────────────────────────

  async getCustomerQuotes(userId) {
    // RLS ensures this only returns rows where customer_id = auth.uid()
    return SB.get('quotes', `?customer_id=eq.${encodeURIComponent(userId)}&order=created_at.desc`);
  },

  async getAllQuotes() {
    return SB.get('quotes', '?order=created_at.desc');
  },

  async addQuote(quote) {
    return SB.post('quotes', quote);
  },

  async updateQuoteStatus(id, status) {
    return SB.patch('quotes', `id=eq.${encodeURIComponent(id)}`, {
      status,
      responded_at: new Date().toISOString()
    });
  },

  async updateQuoteField(id, fields) {
    return SB.patch('quotes', `id=eq.${encodeURIComponent(id)}`, fields);
  },

  async deleteQuote(id) {
    return SB.delete('quotes', `id=eq.${encodeURIComponent(id)}`);
  },

  // ── INVOICES ─────────────────────────────────

  async getCustomerInvoices(userId) {
    // RLS ensures this only returns rows where customer_id = auth.uid()
    return SB.get('invoices', `?customer_id=eq.${encodeURIComponent(userId)}&order=created_at.desc`);
  },

  async getAllInvoices() {
    return SB.get('invoices', '?order=created_at.desc');
  },

  async markInvoicePaid(id) {
    return SB.patch('invoices', `id=eq.${encodeURIComponent(id)}`, {
      status: 'paid',
      paid_at: new Date().toISOString()
    });
  },

  async quoteToInvoice(quoteId) {
    const quotes = await SB.get('quotes', `?id=eq.${encodeURIComponent(quoteId)}`);
    const q = quotes[0];
    if (!q) return null;
    const due = new Date();
    due.setDate(due.getDate() + 30);
    return SB.post('invoices', {
      customer_id: q.customer_id,
      customer_email: q.customer_email,
      customer_name: q.customer_name,
      company: q.company,
      description: q.description,
      items: q.items,          // pass line items so customer can see work summary
      amount: q.amount,
      status: 'unpaid',
      due: due.toISOString(),
      quote_id: q.id
    });
  },

  // ── SERVICE HISTORY ──────────────────────────

  async getCustomerServiceHistory(userId) {
    return SB.get('service_history', `?customer_id=eq.${encodeURIComponent(userId)}&order=date.desc`);
  },

  async getAllServiceHistory() {
    return SB.get('service_history', '?order=date.desc');
  }
};
