// =============================================
// APEX LIFT SOLUTIONS — portal-data.js
// Supabase Auth + REST API helpers.
//
// Sensitive admin writes go through Edge Functions:
//   EDGE_FN_BASE_URL/admin-action  (create-invoice,
//   mark-paid, activate/delete customer, etc.)
//
// Read operations use the REST API directly —
// RLS enforces access server-side on every request.
// =============================================

const SUPABASE_URL      = 'https://cjtezsgfdfijmdxzzbiq.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImNqdGV6c2dmZGZpam1keHp6YmlxIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzgxNjg2OTIsImV4cCI6MjA5Mzc0NDY5Mn0.FkfIFgm5TUKa05nK4QQWdBRgK2cv3oPvq5MQArEUqbw';
const EDGE_FN_BASE_URL  = `${SUPABASE_URL}/functions/v1`;

// XSS prevention — escape all user-supplied data before inserting into DOM
function esc(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

const _sb = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// ── REST API HELPER ───────────────────────────
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

// ── EDGE FUNCTION CALLER ──────────────────────
// Routes sensitive admin writes through server-side Edge Functions.
// The function re-validates the JWT and email before acting —
// the browser cannot fake an admin action even with the anon key.
const EF = {
  async call(fnName, body) {
    const { data: { session } } = await _sb.auth.getSession();
    if (!session) throw new Error('Not authenticated');
    const res = await fetch(`${EDGE_FN_BASE_URL}/${fnName}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + session.access_token
      },
      body: JSON.stringify(body)
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Edge function error ${res.status}`);
    return data;
  },
  async adminAction(action, params = {}) {
    return this.call('admin-action', { action, ...params });
  }
};

// ── AUTH ──────────────────────────────────────
const ADMIN_EMAIL = 'admin@apexliftsolutionsusa.com';

const Auth = {
  async signIn(email, password) {
    const { data, error } = await _sb.auth.signInWithPassword({ email, password });
    if (error) return { error: error.message };
    return { user: data.user, session: data.session };
  },
  async signUp(email, password, meta) {
    const { data, error } = await _sb.auth.signUp({ email, password, options: { data: meta } });
    if (error) return { error: error.message };
    return { user: data.user };
  },
  async signOut()    { await _sb.auth.signOut(); },
  async getSession() { const { data: { session } } = await _sb.auth.getSession(); return session; },
  async getUser()    { const { data: { user } }    = await _sb.auth.getUser();    return user; },
  async isAdmin()    { const u = await this.getUser(); return u?.email === ADMIN_EMAIL; },
  async resetPasswordEmail(email) {
    const { error } = await _sb.auth.resetPasswordForEmail(email, {
      redirectTo: window.location.origin + '/portal-reset.html'
    });
    return { error: error?.message || null };
  },
  async updatePassword(newPassword) {
    const { error } = await _sb.auth.updateUser({ password: newPassword });
    return { error: error?.message || null };
  }
};

// ── DATABASE ──────────────────────────────────
const DB = {

  // ── CUSTOMERS ────────────────────────────────

  async registerCustomer({ name, company, email, phone, password }) {
    const { user, error } = await Auth.signUp(email, password, { name, company, phone });
    if (error) return { error };
    if (user) {
      await SB.post('customers', {
        id: user.id, email, name,
        company: company || '', phone: phone || '',
        status: 'pending',
        since: new Date().toLocaleDateString('en-US', { month: 'long', year: 'numeric' })
      });
    }
    return { user };
  },

  async getAllCustomers() { return SB.get('customers', '?order=created_at.desc'); },

  // Try Edge Function first (server-side audit log); fall back to direct REST if not deployed yet
  async updateCustomerStatus(id, status) {
    try {
      const action = status === 'active' ? 'activate-customer' : 'deactivate-customer';
      return await EF.adminAction(action, { customerId: id });
    } catch (e) {
      console.warn('Edge function unavailable, using direct update:', e.message);
      return SB.patch('customers', `id=eq.${encodeURIComponent(id)}`, { status });
    }
  },

  async deleteCustomer(id) {
    try {
      return await EF.adminAction('delete-customer', { customerId: id });
    } catch (e) {
      console.warn('Edge function unavailable, using direct delete:', e.message);
      return SB.delete('customers', `id=eq.${encodeURIComponent(id)}`);
    }
  },

  // ── QUOTES ───────────────────────────────────

  async getAllQuotes()             { return SB.get('quotes', '?order=created_at.desc'); },
  async getCustomerQuotes(userId) { return SB.get('quotes', `?customer_id=eq.${encodeURIComponent(userId)}&order=created_at.desc`); },
  async addQuote(quote)           { return SB.post('quotes', quote); },

  async updateQuoteStatus(id, status) {
    return SB.patch('quotes', `id=eq.${encodeURIComponent(id)}`, {
      status, responded_at: new Date().toISOString()
    });
  },

  async updateQuoteField(id, fields) {
    return SB.patch('quotes', `id=eq.${encodeURIComponent(id)}`, fields);
  },

  // Try Edge Function (audit log); fall back to direct REST if not deployed yet
  async deleteQuote(id) {
    try {
      return await EF.adminAction('delete-quote', { quoteId: id });
    } catch (e) {
      console.warn('Edge function unavailable, using direct delete:', e.message);
      return SB.delete('quotes', `id=eq.${encodeURIComponent(id)}`);
    }
  },

  // ── INVOICES ─────────────────────────────────

  async getAllInvoices()             { return SB.get('invoices', '?order=created_at.desc'); },
  async getCustomerInvoices(userId) { return SB.get('invoices', `?customer_id=eq.${encodeURIComponent(userId)}&order=created_at.desc`); },

  // Try Edge Function (audit log); fall back to direct REST if not deployed yet
  async markInvoicePaid(id) {
    try {
      return await EF.adminAction('mark-paid', { invoiceId: id });
    } catch (e) {
      console.warn('Edge function unavailable, using direct update:', e.message);
      return SB.patch('invoices', `id=eq.${encodeURIComponent(id)}`, {
        status: 'paid', paid_at: new Date().toISOString()
      });
    }
  },
  async quoteToInvoice(quoteId) {
    try {
      return await EF.adminAction('create-invoice', { quoteId });
    } catch (e) {
      console.warn('Edge function unavailable, using direct create:', e.message);
      const quotes = await SB.get('quotes', `?id=eq.${encodeURIComponent(quoteId)}`);
      const q = quotes[0];
      if (!q) return null;
      const due = new Date();
      due.setDate(due.getDate() + 30);
      const inv = await SB.post('invoices', {
        customer_id: q.customer_id, customer_email: q.customer_email,
        customer_name: q.customer_name, company: q.company,
        description: q.description, items: q.items,
        amount: q.amount, status: 'unpaid',
        due: due.toISOString(), quote_id: q.id
      });
      if (inv) await SB.patch('quotes', `id=eq.${encodeURIComponent(quoteId)}`, { invoiced: true });
      return inv;
    }
  },
  async deleteInvoice(id) {
    try {
      return await EF.adminAction('delete-invoice', { invoiceId: id });
    } catch (e) {
      console.warn('Edge function unavailable, using direct delete:', e.message);
      return SB.delete('invoices', `id=eq.${encodeURIComponent(id)}`);
    }
  },

  // ── SERVICE HISTORY ──────────────────────────

  async getAllServiceHistory()             { return SB.get('service_history', '?order=date.desc'); },
  async getCustomerServiceHistory(userId) { return SB.get('service_history', `?customer_id=eq.${encodeURIComponent(userId)}&order=date.desc`); },

  // ── ACTIVITY LOG ─────────────────────────────

  async getActivityLog(limit = 100) {
    return SB.get('activity_log', `?order=created_at.desc&limit=${limit}`);
  }
};
