// =============================================
// APEX LIFT SOLUTIONS — Supabase Portal Data
// Real-time sync via Supabase REST API
// =============================================

const SUPABASE_URL = 'https://cjtezsgfdfijmdxzzbiq.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImNqdGV6c2dmZGZpam1keHp6YmlxIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzgxNjg2OTIsImV4cCI6MjA5Mzc0NDY5Mn0.FkfIFgm5TUKa05nK4QQWdBRgK2cv3oPvq5MQArEUqbw';

const SB = {
  get headers() {
    return {
      'Content-Type': 'application/json',
      'apikey': SUPABASE_ANON_KEY,
      'Authorization': 'Bearer ' + SUPABASE_ANON_KEY,
      'Prefer': 'return=representation'
    };
  },
  async get(table, params = '') {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}${params}`, { headers: this.headers });
    if (!res.ok) { console.error('SB.get error:', await res.text()); return []; }
    return res.json();
  },
  async post(table, body) {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}`, { method: 'POST', headers: this.headers, body: JSON.stringify(body) });
    if (!res.ok) { console.error('SB.post error:', await res.text()); return null; }
    const data = await res.json();
    return Array.isArray(data) ? data[0] : data;
  },
  async patch(table, filter, body) {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}?${filter}`, { method: 'PATCH', headers: this.headers, body: JSON.stringify(body) });
    if (!res.ok) { console.error('SB.patch error:', await res.text()); return null; }
    const data = await res.json();
    return Array.isArray(data) ? data[0] : data;
  },
  async delete(table, filter) {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}?${filter}`, { method: 'DELETE', headers: this.headers });
    if (!res.ok) { console.error('SB.delete error:', await res.text()); return false; }
    return true;
  }
};

// Simple password hash (for demo — in production use proper auth)
async function hashPassword(password) {
  const encoder = new TextEncoder();
  const data = encoder.encode(password + 'apex_salt_2026');
  const hash = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, '0')).join('');
}

const DB = {

  // ── AUTH ─────────────────────────────────────

  async loginCustomer(email, password) {
    const hash = await hashPassword(password);
    const rows = await SB.get('customers', `?email=eq.${encodeURIComponent(email)}&password_hash=eq.${hash}&select=*`);
    return rows[0] || null;
  },

  async registerCustomer(data) {
    const hash = await hashPassword(data.password);
    return SB.post('customers', {
      email: data.email,
      name: data.name,
      company: data.company || '',
      phone: data.phone || '',
      password_hash: hash,
      status: 'pending',
      since: new Date().toLocaleDateString('en-US', { month: 'long', year: 'numeric' })
    });
  },

  async resetPassword(email, newPassword) {
    const hash = await hashPassword(newPassword);
    const rows = await SB.get('customers', `?email=eq.${encodeURIComponent(email)}&select=id`);
    if (!rows.length) return false;
    await SB.patch('customers', `email=eq.${encodeURIComponent(email)}`, { password_hash: hash });
    return true;
  },

  // ── QUOTES ──────────────────────────────────

  async getCustomerQuotes(email) {
    return SB.get('quotes', `?customer_email=eq.${encodeURIComponent(email)}&order=created_at.desc`);
  },

  async getAllQuotes() {
    return SB.get('quotes', '?order=created_at.desc');
  },

  async updateQuoteStatus(id, status) {
    return SB.patch('quotes', `id=eq.${encodeURIComponent(id)}`, {
      status,
      responded_at: new Date().toISOString()
    });
  },

  async addQuote(quote) {
    return SB.post('quotes', quote);
  },

  async deleteQuote(id) {
    return SB.delete('quotes', `id=eq.${encodeURIComponent(id)}`);
  },

  // ── INVOICES ─────────────────────────────────

  async getCustomerInvoices(email) {
    return SB.get('invoices', `?customer_email=eq.${encodeURIComponent(email)}&order=created_at.desc`);
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

  async addInvoice(invoice) {
    return SB.post('invoices', invoice);
  },

  async quoteToInvoice(quoteId) {
    const quotes = await SB.get('quotes', `?id=eq.${encodeURIComponent(quoteId)}`);
    const q = quotes[0];
    if (!q) return null;
    const due = new Date();
    due.setDate(due.getDate() + 30);
    return SB.post('invoices', {
      customer_email: q.customer_email,
      customer_name: q.customer_name,
      company: q.company,
      description: q.description,
      amount: q.amount,
      status: 'unpaid',
      due: due.toISOString(),
      quote_id: q.id
    });
  },

  // ── CUSTOMERS ────────────────────────────────

  async getAllCustomers() {
    return SB.get('customers', '?order=created_at.desc&select=id,email,name,company,phone,status,since,created_at');
  },

  async deleteCustomer(id) {
    return SB.delete('customers', `id=eq.${id}`);
  },

  async updateCustomerStatus(id, status) {
    return SB.patch('customers', `id=eq.${id}`, { status });
  },

  // ── SERVICE HISTORY ──────────────────────────

  async getServiceHistory(email) {
    return SB.get('service_history', `?customer_email=eq.${encodeURIComponent(email)}&order=date.desc`);
  },

  async getAllServiceHistory() {
    return SB.get('service_history', '?order=date.desc');
  }
};
