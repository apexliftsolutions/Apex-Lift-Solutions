// =============================================
//  APEX LIFT SOLUTIONS — portal-customer.js
//  Customer portal logic. Depends on:
//    - supabase.min.js (CDN, loaded before this)
//    - supabase-js (CDN, loaded before this)
//  Self-contained — does not use portal-data.js
//  so it can run independently of the admin flow.
// =============================================

const SB_URL  = 'https://cjtezsgfdfijmdxzzbiq.supabase.co';
const SB_KEY  = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImNqdGV6c2dmZGZpam1keHp6YmlxIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzgxNjg2OTIsImV4cCI6MjA5Mzc0NDY5Mn0.FkfIFgm5TUKa05nK4QQWdBRgK2cv3oPvq5MQArEUqbw';
const ADMIN   = 'admin@apexliftsolutionsusa.com';

const sb = supabase.createClient(SB_URL, SB_KEY);

// ── STATE ─────────────────────────────────────
let USER      = null;  // { id, email, name, company }
let PAY_ID    = null;
let REQ_FILES = [];
// Invoice/payment UI state. Must stay in module scope — loadInvoices(),
// openPay() and the Helcim SUCCESS handler all read them.
let INVOICE_CACHE = {};              // invoice id -> row, for the tax breakdown
const LOCKED_INVOICES = new Set();   // approved this session; in-memory only,
                                     // never persisted. The DB is the authority.

// ── BOOT ──────────────────────────────────────
(async function boot() {
  try {
    const { data: { session }, error } = await sb.auth.getSession();
    if (error || !session) { location.href = 'portal-login.html'; return; }

    const u = session.user;
    if (u.email === ADMIN) { location.href = 'portal-admin.html'; return; }

    USER = {
      id:      u.id,
      email:   u.email,
      name:    u.user_metadata?.name || u.email.split('@')[0],
      company: u.user_metadata?.company || ''
    };

    // Supplement from DB if metadata incomplete
    if (!u.user_metadata?.name) {
      try {
        const { data: row } = await sb.from('customers').select('name,company').eq('id', u.id).single();
        if (row) { USER.name = row.name || USER.name; USER.company = row.company || USER.company; }
      } catch (e) { /* non-fatal */ }
    }

    document.getElementById('cust-name').textContent    = xss(USER.name);
    document.getElementById('cust-company').textContent = xss(USER.company);

    // NOTE: payment state is never set from a URL parameter. It is written
    // server-side by the helcim-validate Edge Function after the response hash
    // is verified. A browser redirect is not proof of payment.
    loadQuotes();
    checkPendingQuotes();
  } catch (e) {
    console.error('Boot error:', e);
    location.href = 'portal-login.html';
  }
})();

// ── XSS HELPER ────────────────────────────────
function xss(s) {
  if (!s) return '';
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// ── PENDING QUOTE NOTIFICATION ───────────────
async function checkPendingQuotes() {
  if (!USER) return;
  try {
    const { data } = await sb
      .from('quotes')
      .select('id, amount')
      .eq('customer_id', USER.id)
      .eq('status', 'pending')
      .eq('invoiced', false).eq('hidden_by_customer', false);
    if (!data || data.length === 0) return;
    const count = data.length;
    const total = data.reduce((s, q) => s + parseFloat(q.amount), 0);
    const banner = document.createElement('div');
    banner.className = 'banner banner-ok';
    banner.style.cssText = 'margin-bottom:20px;display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:10px;cursor:pointer;';
    banner.innerHTML = `
      <span>🔔 You have <strong>${count} quote${count > 1 ? 's' : ''}</strong> waiting for your approval — total <strong>$${total.toFixed(2)}</strong>. Tap to review.</span>
      <span style="font-family:var(--font-head);font-size:.72rem;font-weight:700;letter-spacing:.08em;text-transform:uppercase;opacity:.7;">View Quotes →</span>`;
    banner.addEventListener('click', () => {
      showView('quotes', document.querySelector('[onclick*="quotes"]'));
      banner.remove();
    });
    // Prepend to the main content area
    const main = document.querySelector('.main');
    if (main) main.prepend(banner);
  } catch(e) { /* non-fatal */ }
}

// ── EMAIL ADMIN ───────────────────────────────
// Email is sent server-side by database triggers → notification_outbox → Resend.
// Nothing in the browser sends mail.

// ── DATE + BADGE HELPERS ──────────────────────
function bdate(d) { return d ? new Date(d).toLocaleDateString('en-US') : '—'; }

function badgeHtml(s) {
  const cls = {
    pending: 'badge-pending', approved: 'badge-approved', declined: 'badge-declined',
    paid: 'badge-paid', unpaid: 'badge-unpaid', payment_pending: 'badge-pending', refunded: 'badge-declined', partially_refunded: 'badge-pending', void: 'badge-hidden', completed: 'badge-completed'
  }[s] || 'badge-pending';
  return `<span class="badge ${cls}">${xss(s)}</span>`;
}

// ── ATTACHMENT RENDERER ───────────────────────
async function attHtml(paths) {
  if (!paths?.length) return '';
  // Bucket is PRIVATE. Each path becomes a 10-minute signed URL for the signed-in
  // user; storage RLS decides whether they may have it.
  const { data: signed } = await sb.storage.from('apex-uploads').createSignedUrls(paths, 600);
  const items = (signed || []).filter(s => s.signedUrl).map(s => {
    const raw   = decodeURIComponent(s.path.split('/').pop());
    const name  = raw.replace(/^\d+_/, '');
    const short = name.length > 18 ? name.slice(0, 16) + '…' : name;
    if (s.path.toLowerCase().endsWith('.pdf')) {
      return `<a href="${s.signedUrl}" target="_blank" rel="noopener" class="att-pdf-box" title="${xss(name)}"><span>📄</span><small>${xss(short)}</small></a>`;
    }
    return `<a href="${s.signedUrl}" target="_blank" rel="noopener" class="att-link" title="${xss(name)}"><img src="${s.signedUrl}" alt="${xss(name)}" loading="lazy"/></a>`;
  }).join('');
  if (!items) return '';
  return `<div style="margin-top:12px;"><div class="att-label">📎 Attachments — click to view</div><div class="att-grid">${items}</div></div>`;
}

// ── LINE ITEMS RENDERER ───────────────────────
function lineItemsHtml(items) {
  if (!items?.length) return '';
  return `<table class="li-table">
    <thead><tr><th>Description</th><th>Qty</th><th>Type</th><th>Total</th></tr></thead>
    <tbody>${items.map(i => {
      const qty  = parseFloat(i.qty)  || 1;
      const unit = parseFloat(i.unit_price || i.amount || 0);
      return `<tr>
        <td>${xss(i.desc || '')}</td>
        <td>${qty}</td>
        <td>${xss(i.type || '')}</td>
        <td style="color:var(--white);font-weight:600;">$${(qty * unit).toFixed(2)}</td>
      </tr>`;
    }).join('')}</tbody>
  </table>`;
}

// ── LOAD QUOTES ───────────────────────────────
async function loadQuotes() {
  const wrap = document.getElementById('quotes-wrap');
  if (!USER) return;
  wrap.innerHTML = '<div class="loading-msg">Loading quotes…</div>';

  // Invoiced quotes stay visible, read-only. A customer needs the document that
  // shows what they approved. Only quotes they explicitly dismissed are hidden.
  const { data: quotes, error } = await sb
    .from('quotes').select('*')
    .eq('customer_id', USER.id)
    .eq('hidden_by_customer', false)
    .order('created_at', { ascending: false });

  if (error) {
    console.error('[Apex] quote query failed', { code: error.code, message: error.message, details: error.details, hint: error.hint, customer_id: USER.id });
    wrap.innerHTML = `<div class="empty-state" style="color:#ff4444;">
      Couldn't load your quotes.<br/><span style="font-size:.82rem;color:var(--grey);">${xss(error.message)}</span><br/>
      <button class="approve-btn" style="margin-top:12px;" onclick="loadQuotes()">Try Again</button>
      <p style="font-size:.8rem;color:var(--grey);margin-top:10px;">If this keeps happening, call (516) 644-7187.</p></div>`;
    return;
  }
  console.info(`[Apex] quotes loaded: ${(quotes || []).length} for ${USER.id}`);
  if (!quotes?.length) { wrap.innerHTML = '<div class="empty-state">No quotes yet — contact us or use Request Service to get started!</div>'; return; }

  const cards = await Promise.all(quotes.map(async q => `
    <div class="q-card">
      <div class="q-hdr">
        <span class="q-id">${xss(q.id)}</span>
        <div style="display:flex;align-items:center;gap:12px;">${badgeHtml(q.status)}${q.invoiced ? '<span class="badge badge-hidden">Invoiced</span>' : ''}<span class="q-amt">$${parseFloat(q.amount).toFixed(2)}</span></div>
      </div>
      ${q.description ? `<div class="q-desc">${xss(q.description)}</div>` : ''}
      ${lineItemsHtml(q.items)}
      ${await attHtml(q.attachments)}
      <div class="q-meta" style="margin-top:12px;">
        <div class="q-meta-item">Sent<span>${bdate(q.created_at)}</span></div>
        ${q.equipment ? `<div class="q-meta-item">Equipment<span>${xss(q.equipment)}</span></div>` : ''}
        ${q.responded_at ? `<div class="q-meta-item">Responded<span>${bdate(q.responded_at)}</span></div>` : ''}
      </div>
      ${q.status === 'pending' ? `
        <p style="color:var(--grey-light);font-size:.88rem;margin-bottom:12px;">Please review and approve or decline this quote.</p>
        <div style="display:flex;gap:10px;flex-wrap:wrap;">
          <button class="approve-btn" onclick="respondQuote('${xss(q.id)}','approved')">✓ Approve — $${parseFloat(q.amount).toFixed(2)}</button>
          <button class="decline-btn" onclick="respondQuote('${xss(q.id)}','declined')">✗ Decline</button>
        </div>` :
        q.status === 'approved'
          ? `<p style="color:#4caf50;font-size:.88rem;font-weight:600;margin-top:6px;">✓ Approved on ${bdate(q.responded_at)}${q.invoiced ? ' — invoiced.' : " — we'll contact you to schedule."}</p>
             <div style="display:flex;gap:10px;flex-wrap:wrap;margin-top:10px;">
               <button class="print-btn" onclick="printQuote('${xss(q.id)}')">🖨 View / Print Quote</button>
             </div>`
          : `<div style="display:flex;align-items:center;gap:14px;flex-wrap:wrap;margin-top:6px;">
               <p style="color:#ff4444;font-size:.88rem;margin:0;">Declined on ${bdate(q.responded_at)}.</p>
               <button class="decline-btn" style="padding:6px 14px;font-size:.72rem;" onclick="removeQuote('${xss(q.id)}')">🗑 Remove</button>
             </div>`
      }
    </div>`));
  wrap.innerHTML = '<div class="q-cards">' + cards.join('') + '</div>';
}


// Fetch the latest successful financial correction for each invoice.
// A successful reversal is authoritative proof that a prior card payment no
// longer counts as collected, so it is the ONLY thing that may release the
// in-memory duplicate-payment lock for an invoice that returned to `unpaid`.
async function loadSucceededCorrections(invoiceIds) {
  const byInvoice = {};
  if (!USER || !invoiceIds?.length) return byInvoice;

  const { data, error } = await sb.from('payments')
    .select('id,invoice_id,kind,status,amount_cents,provider_transaction_id,refund_of,notes,created_at,approved_at,settled_at,completed_at')
    .eq('customer_id', USER.id)
    .in('invoice_id', invoiceIds)
    .in('kind', ['refund', 'reversal'])
    .eq('status', 'succeeded')
    .order('created_at', { ascending: false });

  if (error) {
    console.error('[Apex] correction ledger query failed', error);
    return byInvoice;
  }

  for (const row of data || []) {
    if (!byInvoice[row.invoice_id]) byInvoice[row.invoice_id] = row;
  }
  return byInvoice;
}

function correctionMetaHtml(correction) {
  if (!correction) return '';
  const amount = `$${(Number(correction.amount_cents || 0) / 100).toFixed(2)}`;
  const reason = correction.notes ? `<br/>Reason: ${xss(correction.notes)}` : '';
  const ref = correction.provider_transaction_id
    ? `<br/>Reference: ${xss(correction.provider_transaction_id)}`
    : '';
  return `<br/>Amount: <strong>${amount}</strong>${reason}${ref}`;
}

// Once the ledger proves a provider reversal succeeded, the previous checkout
// attempt is definitively over. Clear BOTH duplicate-payment guards so a fresh
// Helcim checkout can actually start again in the same browser session.
function unlockReversedInvoice(invoiceId) {
  LOCKED_INVOICES.delete(invoiceId);
  if (PAY_ID === invoiceId || PAY_ID == null) {
    PAY_BUSY = false;
  }
}

// ── LOAD INVOICES ─────────────────────────────
async function loadInvoices() {
  INVOICE_CACHE = {};
  const wrap = document.getElementById('invoices-wrap');
  if (!USER) return;
  wrap.innerHTML = '<div class="loading-msg">Loading invoices…</div>';

  const { data: invoices, error } = await sb
    .from('invoices').select('*')
    .eq('customer_id', USER.id)
    .order('created_at', { ascending: false });

  if (error) {
    console.error('[Apex] invoice query failed', { code: error.code, message: error.message, details: error.details, hint: error.hint, customer_id: USER.id });
    wrap.innerHTML = `<div class="empty-state" style="color:#ff4444;">
      Couldn't load your invoices.<br/><span style="font-size:.82rem;color:var(--grey);">${xss(error.message)}</span><br/>
      <button class="approve-btn" style="margin-top:12px;" onclick="loadInvoices()">Try Again</button>
      <p style="font-size:.8rem;color:var(--grey);margin-top:10px;">If this keeps happening, call (516) 644-7187.</p></div>`;
    return;
  }
  console.info(`[Apex] invoices loaded: ${(invoices || []).length} for ${USER.id}`);

  const correctionsByInvoice = await loadSucceededCorrections((invoices || []).map(i => i.id));

  // If a provider reversal has succeeded and recalc returned the invoice to
  // unpaid, the old checkout lock must be released. Do NOT unlock merely because
  // an invoice is unpaid: during a real confirmation window that would invite a
  // duplicate charge.
  for (const inv of invoices || []) {
    const correction = correctionsByInvoice[inv.id];
    if (inv.status === 'unpaid' && correction?.kind === 'reversal' && correction.status === 'succeeded') {
      unlockReversedInvoice(inv.id);
    }
  }

  // Index by id so openPay() can read the tax breakdown without stuffing JSON
  // into an onclick attribute.
  (invoices || []).forEach(r => { INVOICE_CACHE[r.id] = r; });

  // Show unpaid always; show paid invoices for 90 days (receipt window); hide hidden
  const now = Date.now();   // used by other status branches
  const visible = (invoices || []).filter(i => {
    if (i.status === 'hidden') return false;
    // Paid invoices are permanent records — the customer's proof of payment.
    // If this list ever gets long, add paging or a year filter; never hide history.
    if (i.status === 'paid') return true;
    return true;
  });

  if (!visible.length) {
    // Distinguish "genuinely nothing" from "we fetched zero rows", which can
    // mean the invoice was never linked to this portal account.
    wrap.innerHTML = (invoices || []).length
      ? '<div class="empty-state">No outstanding invoices. All paid up! 🎉</div>'
      : `<div class="empty-state">No invoices on your account yet.<br/>
         <span style="font-size:.82rem;color:var(--grey);">Expecting one? Call (516) 644-7187 and we'll check it's linked to your account.</span></div>`;
    return;
  }

  wrap.innerHTML = '<div class="q-cards">' + visible.map(i => {
    const workSummary = i.items?.length
      ? `<div style="margin:10px 0 14px;">
          <div style="font-family:var(--font-head);font-size:.63rem;font-weight:700;letter-spacing:.12em;text-transform:uppercase;color:var(--grey);margin-bottom:6px;">Work Summary</div>
          ${lineItemsHtml(i.items)}
         </div>` : '';

    const body = i.status === 'paid'
      ? `<div class="paid-confirm">
          <p style="color:#4caf50;font-weight:700;font-size:.92rem;margin-bottom:10px;">✓ Payment Confirmed — Thank You!</p>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:10px;">
            <div class="q-meta-item">Invoice #<span>${xss(i.id)}</span></div>
            <div class="q-meta-item">Paid On<span>${bdate(i.paid_at)}</span></div>
            <div class="q-meta-item">Amount Paid<span style="color:var(--white);">$${parseFloat(i.amount).toFixed(2)}</span></div>
            ${i.quote_id ? `<div class="q-meta-item">Quote Ref<span>${xss(i.quote_id)}</span></div>` : ''}
          </div>
          ${workSummary}
          <div style="display:flex;gap:10px;flex-wrap:wrap;">
            <button class="print-btn" onclick="printInvoice('${xss(i.id)}')">🖨 View / Print Invoice</button>
            ${i.payment_id ? `<button class="print-btn" onclick="printPaymentReceipt('${xss(i.payment_id)}')">🧾 Payment Receipt</button>` : ''}
            ${i.quote_id ? `<button class="print-btn" onclick="printQuote('${xss(i.quote_id)}')">📄 Original Quote</button>` : ''}
          </div>
          <p style="color:var(--grey);font-size:.8rem;">Questions? Call (516) 644-7187.</p>
         </div>`
      : invoiceActionHtml(i, workSummary, correctionsByInvoice[i.id]);

    return `<div class="q-card">
      <div class="q-hdr">
        <span class="q-id">${xss(i.id)}</span>
        <div style="display:flex;align-items:center;gap:12px;">${badgeHtml(i.status)}<span class="q-amt">$${parseFloat(i.amount).toFixed(2)}</span></div>
      </div>
      ${i.description ? `<div class="q-desc">${xss(i.description)}</div>` : ''}
      <div class="q-meta">
        <div class="q-meta-item">Due<span>${bdate(i.due)}</span></div>
        ${i.paid_at ? `<div class="q-meta-item">Paid<span>${bdate(i.paid_at)}</span></div>` : ''}
      </div>
      ${body}
    </div>`;
  }).join('') + '</div>';
}

// ── LOAD HISTORY ──────────────────────────────
async function loadHistory() {
  const wrap = document.getElementById('history-wrap');
  if (!USER) return;
  wrap.innerHTML = '<div class="loading-msg">Loading history…</div>';

  const { data: rows, error } = await sb
    .from('service_history').select('*')
    .eq('customer_id', USER.id)
    .order('date', { ascending: false });

  if (error) {
    console.error('[Apex] service history query failed', { code: error.code, message: error.message, details: error.details, hint: error.hint, customer_id: USER.id });
    wrap.innerHTML = `<div class="empty-state" style="color:#ff4444;">
      Couldn't load your service history.<br/><span style="font-size:.82rem;color:var(--grey);">${xss(error.message)}</span><br/>
      <button class="approve-btn" style="margin-top:12px;" onclick="loadHistory()">Try Again</button>
      <p style="font-size:.8rem;color:var(--grey);margin-top:10px;">If this keeps happening, call (516) 644-7187.</p></div>`;
    return;
  }
  console.info(`[Apex] service history loaded: ${(rows || []).length} for ${USER.id}`);
  if (!rows?.length) { wrap.innerHTML = '<div class="empty-state">No service history yet.</div>'; return; }

  wrap.innerHTML = '<div class="q-cards">' + rows.map(h => `
    <div class="q-card">
      <div class="q-hdr"><span class="q-id">${xss(h.id)}</span><span class="badge badge-completed">Completed</span></div>
      <div class="q-desc">${xss(h.description || '')}</div>
      <div class="q-meta">
        <div class="q-meta-item">Date<span>${h.date ? new Date(h.date).toLocaleDateString('en-US') : '—'}</span></div>
        <div class="q-meta-item">Technician<span>${xss(h.tech || 'Apex Tech')}</span></div>
        ${h.equipment ? `<div class="q-meta-item">Equipment<span>${xss(h.equipment)}</span></div>` : ''}
        ${h.amount ? `<div class="q-meta-item">Amount<span style="color:var(--red);font-size:.95rem;">$${parseFloat(h.amount).toFixed(2)}</span></div>` : ''}
        <div class="q-meta-item">Payment<span style="color:${h.paid ? '#4caf50' : 'orange'};font-weight:700;">${h.paid ? '✓ Paid' : 'Unpaid'}</span></div>
      </div>
      ${h.notes ? `<p style="color:var(--grey-light);font-size:.86rem;margin-top:6px;">${xss(h.notes)}</p>` : ''}
    </div>`).join('') + '</div>';
}

// ── QUOTE RESPOND ─────────────────────────────
function respondQuote(id, response) {
  const isApprove = response === 'approved';
  showConfirm(
    (isApprove ? 'Approve' : 'Decline') + ' Quote ' + id + '?',
    isApprove
      ? "By approving you authorize Apex Lift Solutions to proceed. We'll contact you within 1 business day to schedule."
      : 'Are you sure? You can always call (516) 644-7187 to discuss.',
    async () => {
      const btn = document.getElementById('confirm-yes');
      btn.disabled = true; btn.textContent = 'Saving…';
      try {
        // Direct UPDATE is not permitted for customers. This RPC allows exactly
        // one transition (pending -> approved/declined) and nothing else.
        const { error } = await sb.rpc('respond_to_quote', { p_quote_id: id, p_response: response });
        if (error) throw error;
        closeConfirm();
        showBanner(
          isApprove ? "✓ Quote approved! We'll contact you soon to schedule." : 'Quote declined. Call (516) 644-7187 with any questions.',
          isApprove ? 'ok' : 'err'
        );
        loadQuotes();
      } catch (e) {
        closeConfirm();
        showBanner('Error saving response. Please try again.', 'err');
      }
    }
  );
}

// ── PAY INVOICE (HelcimPay.js) ────────────────
// Card details are entered inside Helcim's iframe and never touch this page or
// our server, which is what keeps Apex's PCI scope minimal.
//
// Flow:  initialize (server) -> render modal (here) -> validate (server)
// The amount is resolved server-side from the invoice. Nothing this file sends
// can change what gets charged.

const FN_BASE = `${SB_URL}/functions/v1`;
// Bumped with each payment-path change; sent to the server so a stale frontend
// or a stale Edge Function shows up in payment_events instead of guesswork.
const APEX_CLIENT_VERSION = "2026-09-06.v23";
let PAY_BUSY = false;
let PAY_AMOUNT = 0;
let PAY_INVOICE = null;


// ── TAX BREAKDOWN ─────────────────────────────
// invoices.amount / quotes.amount are the GRAND TOTAL, tax inclusive.
// subtotal_cents + tax_cents reconcile to it. Older rows have tax_cents = 0.
function taxRows(r) {
  const sub = r.subtotal_cents ?? Math.round(Number(r.amount) * 100);
  const tax = Number(r.tax_cents) || 0;
  const rate = Number(r.tax_rate_milli_pct) || 0;
  const total = Math.round(Number(r.amount) * 100);
  if (tax === 0 && !r.tax_exempt) {
    return '';   // pre-tax historical record — show the total alone
  }
  return `
    <div class="tax-rows">
      <div class="tax-row"><span>Subtotal</span><span>$${(sub/100).toFixed(2)}</span></div>
      <div class="tax-row"><span>${r.tax_exempt ? 'Sales Tax (exempt)' : `Sales Tax (${(rate/1000).toFixed(3)}%)`}</span><span>$${(tax/100).toFixed(2)}</span></div>
      <div class="tax-row tax-row-total"><span>Total</span><span>$${(total/100).toFixed(2)}</span></div>
    </div>`;
}


// Mirror of supabase/functions/_shared/helcimpay.ts. Kept deliberately small:
// the SERVER normalizes authoritatively, this only produces useful diagnostics
// and a best-effort payload. Returns no card or bank fields.
function normalizeHelcimPay(input) {
  let cur = input, depth = 0, parsedOk = true;
  while (typeof cur === 'string' && depth < 3) {
    const t = cur.trim();
    if (!t) break;
    try { const nx = JSON.parse(t); cur = nx; depth++; if (typeof nx !== 'string' && typeof nx !== 'object') break; }
    catch { parsedOk = false; break; }
  }
  const root  = (cur && typeof cur === 'object') ? cur : {};
  const dataN = (root.data && typeof root.data === 'object') ? root.data : null;
  const innerN = (dataN && dataN.data && typeof dataN.data === 'object') ? dataN.data : null;
  const hasId = o => !!o && ('transactionId' in o || 'cardTransactionId' in o || 'bankTransactionId' in o);

  let txn = null, wrapper = 'unknown';
  if (hasId(innerN))      { txn = innerN; wrapper = 'data.data'; }
  else if (hasId(dataN))  { txn = dataN;  wrapper = 'data'; }
  else if (hasId(root))   { txn = root;   wrapper = 'root'; }
  else if (innerN)        { txn = innerN; wrapper = 'data.data(no-id)'; }
  else if (dataN)         { txn = dataN;  wrapper = 'data(no-id)'; }

  const hash = (typeof root.hash === 'string' && root.hash) ? root.hash
             : (dataN && typeof dataN.hash === 'string' && dataN.hash) ? dataN.hash : null;

  let id = null;
  if (txn) for (const k of ['transactionId','cardTransactionId','bankTransactionId','id']) {
    const v = txn[k];
    if (typeof v === 'number' && isFinite(v)) { id = String(v); break; }
    if (typeof v === 'string' && /^\d+$/.test(v.trim())) { id = v.trim(); break; }
  }

  let txnJson = null;
  try { if (txn) txnJson = JSON.stringify(txn); } catch (e) { /* ignore */ }

  return { transactionId: id, hash, txnJson,
    shape: { inputType: typeof input, parsedOk, depth, wrapper,
             transactionIdFound: !!id, hashFound: !!hash } };
}


// Explicit state renderer. The old chain was
//   paid ? ... : pending ? ... : Pay Securely
// so refunded / partially_refunded / void fell through to a Pay button on an
// invoice that must never be paid again.
function invoiceActionHtml(i, workSummary, correction = null) {
  const docs = `<div style="display:flex;gap:10px;flex-wrap:wrap;margin-top:10px;">
      <button class="print-btn" onclick="printInvoice('${xss(i.id)}')">🖨 View / Print Invoice</button>
      ${i.payment_id ? `<button class="print-btn" onclick="printPaymentReceipt('${xss(i.payment_id)}')">🧾 Payment Receipt</button>` : ''}
      ${i.quote_id ? `<button class="print-btn" onclick="printQuote('${xss(i.quote_id)}')">📄 Original Quote</button>` : ''}
    </div>`;

  switch (i.status) {
    case 'paid':
      return `${workSummary}${taxRows(i)}
        <div class="pay-ok">✓ Payment confirmed${i.paid_at ? ` on ${bdate(i.paid_at)}` : ''}</div>${docs}`;

    case 'payment_pending':
      return `${workSummary}${taxRows(i)}
        <div class="pay-locked">⏳ Payment received — being confirmed. No further payment is needed.</div>${docs}`;

    case 'partially_refunded':
      return `${workSummary}${taxRows(i)}
        <div class="pay-refund">↩ Partially refunded.${correctionMetaHtml(correction)}<br/>See Payment History for every refund entry.</div>${docs}`;

    case 'refunded':
      return `${workSummary}${taxRows(i)}
        <div class="pay-refund">↩ Refunded in full.${correctionMetaHtml(correction)}<br/>Nothing further is owed on this invoice.</div>${docs}`;

    case 'void':
      return `${workSummary}${taxRows(i)}
        <div class="pay-void">This invoice was cancelled by Apex. No payment is due.</div>${docs}`;

    case 'unpaid': {
      // Recurring invoices are never payable through the one-time Fee Saver
      // checkout. The signed service-plan authorization controls collection.
      if (i.invoice_source === 'recurring') {
        return `${workSummary}${taxRows(i)}
          <div class="pay-locked">This monthly service-plan payment is handled automatically by the payment method on your plan. If it failed, Apex will contact you or retry it through the recurring billing system.</div>${docs}`;
      }
      const reversed = correction?.kind === 'reversal' && correction?.status === 'succeeded';
      if (reversed) {
        // The provider reversal is authoritative and recalc_invoice_status has
        // returned the invoice to unpaid. It is now safe to allow a new payment.
        unlockReversedInvoice(i.id);
        return `${workSummary}${taxRows(i)}
          <div class="pay-refund">
            ↩ <strong>Previous payment was voided / reversed.</strong>
            ${correctionMetaHtml(correction)}
            <br/>This invoice is unpaid again and may be paid securely.
          </div>
          <div style="display:flex;gap:10px;flex-wrap:wrap;margin-top:10px;">
            <button class="approve-btn" onclick="openPay('${xss(i.id)}',${parseFloat(i.amount)})">Pay Securely — $${parseFloat(i.amount).toFixed(2)}</button>
            <button class="print-btn" onclick="printInvoice('${xss(i.id)}')">🖨 View / Print Invoice</button>
            ${i.quote_id ? `<button class="print-btn" onclick="printQuote('${xss(i.quote_id)}')">📄 Original Quote</button>` : ''}
          </div>`;
      }

      if (LOCKED_INVOICES.has(i.id)) {
        return `${workSummary}${taxRows(i)}
          <div class="pay-locked">⏳ Payment received — being confirmed. No further payment is needed.</div>${docs}`;
      }

      return `${workSummary}${taxRows(i)}
        <div style="display:flex;gap:10px;flex-wrap:wrap;">
          <button class="approve-btn" onclick="openPay('${xss(i.id)}',${parseFloat(i.amount)})">Pay Securely — $${parseFloat(i.amount).toFixed(2)}</button>
          <button class="print-btn" onclick="printInvoice('${xss(i.id)}')">🖨 View / Print Invoice</button>
        </div>`;
    }

    default:
      // Unknown status must never render a Pay button.
      return `${workSummary}${taxRows(i)}
        <div class="pay-locked">This invoice is being reviewed. Please call (516) 644-7187 if you have questions.</div>${docs}`;
  }
}

// ── PAY INVOICE (HelcimPay.js + Fee Saver) ────
// Fee Saver requires Helcim's modal to offer BOTH card and ACH so the customer
// can avoid the card fee. We therefore do not present our own method chooser --
// Helcim's modal does that and shows the exact fee once it reads the card.
//
// Modal lifecycle: our modal must be CLOSED before Helcim's iframe is appended,
// or the two overlays stack and the customer sees a dead screen.

let PAY_LISTENER = null;   // exactly one message listener per checkout

function openPay(id, amount) {
  // A recurring service-plan invoice is billed by Helcim under a signed
  // recurring authorization. Paying it here would be a second charge for the
  // same billing period. payment-checkout v24 refuses it server-side; this
  // stops the customer being offered a button that cannot work.
  const _inv = INVOICE_CACHE[id];
  if (_inv && _inv.invoice_source === 'recurring') {
    alert('This is a monthly service plan invoice. It is charged automatically to the payment method on your plan and cannot be paid here.');
    return;
  }

  if (LOCKED_INVOICES.has(id)) return;   // already approved this session
  PAY_ID = id;
  PAY_INVOICE = INVOICE_CACHE[id] || null;
  PAY_AMOUNT = Number(amount);
  document.getElementById('modal-inv-id').textContent  = id;
  document.getElementById('modal-inv-amt').textContent = '$' + Number(amount).toFixed(2);
  const ia = document.getElementById('pay-intro-amt');
  if (ia) ia.textContent = '$' + Number(amount).toFixed(2);
  const br = document.getElementById('pay-intro-breakdown');
  if (br) br.innerHTML = PAY_INVOICE ? taxRows(PAY_INVOICE) : '';
  showPayState('intro');
  document.getElementById('pay-modal').className = 'modal-overlay open';
}

async function startPay() {
  if (PAY_BUSY) return;                       // double-click guard
  PAY_BUSY = true;
  const id = PAY_ID;
  showPayState('loading');

  try {
    const { data: { session } } = await sb.auth.getSession();
    if (!session) { showPayState('error', 'Your session expired. Please sign in again.'); PAY_BUSY = false; return; }

    // Fresh key per attempt. A failed or abandoned attempt never blocks a retry;
    // the server voids stale sessions and lets a new one open.
    const idem = `${id}:${session.user.id}:${Date.now()}`;

    const res = await fetch(`${FN_BASE}/payment-checkout`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${session.access_token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ invoice_id: id, idempotency_key: idem }),
    });

    if (!res.ok) {
      const { error } = await res.json().catch(() => ({}));
      const msg = {
        already_paid:         'This invoice has already been paid.',
        payment_pending:      'A bank payment for this invoice is already processing. It will clear in a few business days.',
        payment_under_review: "A previous payment on this invoice is being reviewed. Please call (516) 644-7187 and we'll sort it out.",
        account_not_active:   'Your account is not active yet. Please call (516) 644-7187.',
        invoice_not_payable:  'This invoice is not currently payable.',
        duplicate_in_flight:  'A payment is already being started. Give it a moment and try again.',
      }[error] || 'We could not start the payment. Please try again, or call (516) 644-7187.';
      console.error('[Apex] payment-checkout rejected', { http: res.status, error, invoice_id: id });
      showPayState('error', msg);
      PAY_BUSY = false;
      return;
    }

    const { checkoutToken } = await res.json();

    // Tear down any previous listener before attaching a new one.
    if (PAY_LISTENER) { window.removeEventListener('message', PAY_LISTENER); PAY_LISTENER = null; }

    let settled = false;   // guards against SUCCESS followed by a HIDE event

    PAY_LISTENER = async (ev) => {
      // DEFECT 1 this fixes: ev.data may arrive as a JSON *string* rather than an
      // object depending on Helcim version/platform. The previous guard read
      // ev.data.eventName directly, so a string payload returned silently and the
      // SUCCESS branch never ran — producing exactly "checkout_created, then
      // nothing" with no console output at all.
      let d = ev.data;
      if (typeof d === 'string') { try { d = JSON.parse(d); } catch { /* not ours */ } }
      if (!d || typeof d !== 'object') return;

      // Log EVERY message that carries an eventName, matching or not.
      if ('eventName' in d) {
        console.info('[Apex] Helcim message received:', d.eventName, '| status:', d.eventStatus,
          '| raw type:', typeof ev.data,
          d.eventName === `helcim-pay-js-${checkoutToken}` ? '| TOKEN MATCHED' : '| different checkout, ignored');
      }
      if (d.eventName !== `helcim-pay-js-${checkoutToken}`) return;

      const status = String(d.eventStatus ?? '').toUpperCase();
      console.info('[Apex] checkout token matched — event status =', status);

      // DEFECT 2 this fixes: HIDE used to tear the listener down immediately.
      // If Helcim emits HIDE before (or racing) SUCCESS, the listener was gone
      // and SUCCESS could never be handled. HIDE now only closes the visuals and
      // starts a grace window; the listener stays alive for a late SUCCESS.
      if (status === 'ABORTED' || status === 'HIDE') {
        if (settled) return;                 // success already handled; ignore
        try { removeHelcimPayIframe(); } catch (e) { /* not rendered */ }
        document.body.classList.remove('helcim-active');
        document.getElementById('pay-modal').className = 'modal-overlay';
        PAY_BUSY = false;

        // The window closed without a SUCCESS reaching us. Helcim may still have
        // charged the card and told the server via webhook, so ask the server
        // rather than assuming nothing happened.
        setTimeout(() => { if (!settled) confirmFromServer(id, 0); }, 4000);
        return;
      }
      if (status !== 'SUCCESS') return;

      settled = true;
      const hp = normalizeHelcimPay(d.eventMessage);
      console.info('[Apex] client', APEX_CLIENT_VERSION, '— SUCCESS response shape:', JSON.stringify(hp.shape));
      console.info('[Apex] invoking payment-validate for', PAY_ID,
        '| transactionId:', hp.transactionId ?? '(none found)');
      cleanupHelcim();

      // Re-open our modal to show the verifying/result state.
      document.getElementById('pay-modal').className = 'modal-overlay open';
      showPayState('verifying');

      try {
        const vr = await fetch(`${FN_BASE}/payment-validate`, {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${session.access_token}`, 'Content-Type': 'application/json' },
          // Send eventMessage EXACTLY as Helcim delivered it. Helcim documents
          // it as "a JSON.stringify version of the transaction response", so
          // reading .data/.hash off it directly returns undefined when it is a
          // string — which is precisely what silently broke this before.
          // The server normalizes; the browser only forwards.
          body: JSON.stringify({
            checkoutToken,
            eventMessage: d.eventMessage,                 // verbatim
            rawDataResponse: hp.txnJson,                  // best-effort, advisory
            hash: hp.hash,
            clientVersion: APEX_CLIENT_VERSION,
          }),
        });
        const out = await vr.json();
        // Status + resulting state only. Never the transaction payload.
        console.info('[Apex] payment-validate HTTP', vr.status, '→ status:', out?.status ?? out?.error,
          '| server fn version:', out?.fn_version ?? '(not reported — Edge Function may be stale)');

        // Helcim already told the customer the card was approved. From here on
        // the ONLY safe outcomes are "paid", "processing" or "confirming".
        // Never "declined" — that invites a double payment.
        if (out.status === 'succeeded')    showPayState('success', null, out);
        else if (out.status === 'pending') showPayState('pending', null, out);
        else                               showPayState('confirming', null, out);
      } catch (e) {
        // Network/timeout AFTER Helcim approved. Same rule applies.
        console.error('[Apex] payment-validate threw after Helcim SUCCESS — invoice will be recovered by webhook/reconcile:', e);
        showPayState('confirming');
      } finally {
        // Deliberately NOT clearing PAY_BUSY: Helcim approved, so this invoice
        // must not accept another attempt in this session. LOCKED_INVOICES also
        // suppresses the Pay button after the refresh below.
        LOCKED_INVOICES.add(id);
        try { await loadInvoices(); } catch (e) { /* display only */ }
      }
    };
    window.addEventListener('message', PAY_LISTENER);

    // CLOSE our modal, THEN hand the screen to Helcim.
    document.getElementById('pay-modal').className = 'modal-overlay';
    document.body.classList.add('helcim-active');   // sinks Apex chrome below the iframe
    appendHelcimPayIframe(checkoutToken, true);

  } catch (e) {
    console.error('[Apex] payment-checkout threw', { invoice_id: PAY_ID, err: e });
    showPayState('error', 'Connection problem. Please try again or call (516) 644-7187.');
    PAY_BUSY = false;
  }
}


// After the Helcim window closes without a SUCCESS event reaching us, the server
// may still learn about the payment through the webhook. Poll a few times so the
// customer sees the real state instead of a stale Pay button. Read-only — this
// can never mark anything paid; it only reflects what the database already says.
async function confirmFromServer(invoiceId, attempt) {
  if (attempt > 5) return;
  try {
    const { data: inv } = await sb.from('invoices')
      .select('status').eq('id', invoiceId).eq('customer_id', USER.id).maybeSingle();
    if (inv && inv.status !== 'unpaid') {
      console.info('[Apex] server reports invoice', invoiceId, 'is now', inv.status);
      LOCKED_INVOICES.add(invoiceId);
      await loadInvoices();
      return;
    }
  } catch (e) { console.warn('[Apex] confirmFromServer failed', e); }
  setTimeout(() => confirmFromServer(invoiceId, attempt + 1), 5000);
}

function cleanupHelcim() {
  document.body.classList.remove('helcim-active');
  try { removeHelcimPayIframe(); } catch (e) { /* not rendered */ }
  if (PAY_LISTENER) { window.removeEventListener('message', PAY_LISTENER); PAY_LISTENER = null; }
}

// Single place that drives every visual state of the payment modal.
function showPayState(state, message, result) {
  const ids = ['pay-intro','pay-loading','pay-modal-host','pay-verifying','pay-success-block','pay-pending-block','pay-confirming-block','pay-error-block'];
  ids.forEach(i => { const el = document.getElementById(i); if (el) el.style.display = 'none'; });
  const show = (i) => { const el = document.getElementById(i); if (el) el.style.display = 'block'; };

  if (state === 'intro')      show('pay-intro');
  if (state === 'loading')    show('pay-loading');
  if (state === 'modal')      show('pay-modal-host');
  if (state === 'verifying')  show('pay-verifying');
  if (state === 'success') {
    show('pay-success-block');
    const d = document.getElementById('pay-success-detail');
    if (d && result) d.innerHTML =
      `Invoice <strong>${xss(result.invoice_id)}</strong><br/>` +
      `Invoice amount: <strong>$${(result.amount_cents/100).toFixed(2)}</strong><br/>` +
      (result.fee_cents > 0
        ? `Card convenience fee: $${(result.fee_cents/100).toFixed(2)}<br/>Total charged: <strong>$${(result.total_charged_cents/100).toFixed(2)}</strong><br/>`
        : '') +
      (result.method_display ? `Method: ${xss(result.method_display)}<br/>` : '') +
      (result.reference ? `Reference: ${xss(String(result.reference))}` : '');
  }
  if (state === 'pending') {
    show('pay-pending-block');
    const d = document.getElementById('pay-pending-detail');
    if (d && result) d.innerHTML =
      `Invoice <strong>${xss(result.invoice_id)}</strong><br/>` +
      `Amount: <strong>$${(result.amount_cents/100).toFixed(2)}</strong>`;
  }
  if (state === 'confirming') {
    show('pay-confirming-block');
    const d = document.getElementById('pay-confirming-detail');
    if (d && result) d.innerHTML =
      `Invoice <strong>${xss(result.invoice_id || '')}</strong>` +
      (result.amount_cents ? `<br/>Amount: <strong>$${(result.amount_cents/100).toFixed(2)}</strong>` : '');
  }
  if (state === 'error') {
    show('pay-error-block');
    const d = document.getElementById('pay-error-detail');
    if (d) d.textContent = message || 'Something went wrong.';
  }
}

function closePayModal() {
  PAY_BUSY = false;
  cleanupHelcim();
  try { removeHelcimPayIframe(); } catch (e) { /* not rendered */ }
  document.getElementById('pay-modal').className = 'modal-overlay';
  PAY_ID = null;
  PAY_BUSY = false;
}

// ── INVOICE LOOKUP ────────────────────────────
async function lookupInv() {
  const id  = document.getElementById('inv-lookup').value.trim().toUpperCase();
  const box = document.getElementById('lookup-result');
  box.style.display = 'block';
  box.innerHTML = '<p style="color:var(--grey);">Looking up…</p>';
  if (!USER || !id) { box.innerHTML = '<p style="color:#ff4444;font-family:var(--font-head);font-size:.85rem;">Please enter an invoice number.</p>'; return; }
  const { data: row } = await sb.from('invoices').select('*').eq('customer_id', USER.id).eq('id', id).single();
  if (row) {
    const corrections = await loadSucceededCorrections([row.id]);
    const correction = corrections[row.id] || null;
    const reversed = row.status === 'unpaid' && correction?.kind === 'reversal' && correction.status === 'succeeded';
    if (reversed) unlockReversedInvoice(row.id);

    const action = row.invoice_source === 'recurring'
      ? `<span style="color:#f0a500;font-weight:700;font-family:var(--font-head);font-size:.82rem;">Automatic service-plan billing</span>`
      : row.status === 'unpaid'
      ? ((LOCKED_INVOICES.has(row.id) && !reversed)
          ? `<span style="color:#f0a500;font-weight:700;font-family:var(--font-head);font-size:.82rem;">⏳ Payment being confirmed</span>`
          : `<button class="approve-btn" style="margin-top:8px;" onclick="openPay('${xss(row.id)}',${parseFloat(row.amount)})">Pay Securely</button>`)
      : `<span style="color:#4caf50;font-weight:700;font-family:var(--font-head);font-size:.88rem;">${xss(String(row.status).replace(/_/g,' '))}</span>`;

    box.innerHTML = `<div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:12px;">
      <div>
        <div style="font-family:var(--font-head);font-weight:900;font-size:1rem;color:var(--white);">${xss(row.id)}</div>
        <div style="color:var(--grey-light);font-size:.86rem;margin-top:3px;">${xss(row.description || '')}</div>
        <div style="color:var(--grey);font-size:.76rem;margin-top:3px;">Due: ${bdate(row.due)}</div>
        ${reversed ? `<div style="color:#f0a500;font-size:.78rem;margin-top:6px;">Previous payment reversed${correction.notes ? ` — ${xss(correction.notes)}` : ''}.</div>` : ''}
      </div>
      <div style="text-align:right;">
        <div style="font-family:var(--font-head);font-size:1.6rem;font-weight:900;color:var(--red);">$${parseFloat(row.amount).toFixed(2)}</div>
        ${action}
      </div>
    </div>`;
  } else {
    box.innerHTML = '<p style="color:#ff4444;font-family:var(--font-head);font-weight:700;font-size:.85rem;">Invoice not found on your account. Call (516) 644-7187 for help.</p>';
  }
}


// ── PAYMENTS / RECEIPTS ───────────────────────
// Sourced from the payments ledger — never from invoice.status, and never from
// anything the browser computed.
async function loadPayments() {
  const wrap = document.getElementById('payments-wrap');
  if (!USER || !wrap) return;
  wrap.innerHTML = '<div class="loading-msg">Loading payments…</div>';
  const { data: rows, error } = await sb.from('payments')
    .select('*').eq('customer_id', USER.id).order('created_at', { ascending: false });
  if (error) { wrap.innerHTML = '<div class="empty-state" style="color:#ff4444;">Could not load payments.</div>'; return; }
  const shown = (rows || []).filter(r => r.status !== 'initiated');
  if (!shown.length) { wrap.innerHTML = '<div class="empty-state">No payments yet.</div>'; return; }

  // A succeeded REFUND is money returned, not a payment. Labelling by status
  // alone showed refunds as "Paid".
  const labelFor = (r) => {
    if (r.kind === 'refund')   return r.status === 'succeeded' ? 'Refunded' : r.status === 'pending' ? 'Refund pending' : 'Refund failed';
    if (r.kind === 'reversal') return r.status === 'succeeded' ? 'Payment reversed' : 'Reversal failed';
    return { succeeded:'Paid', pending:'Processing', failed:'Failed', unknown:'Needs review', voided:'Voided' }[r.status] || r.status;
  };
  const clsFor = (r) => {
    if (r.kind === 'refund' || r.kind === 'reversal') return r.status === 'succeeded' ? 'badge-declined' : 'badge-pending';
    return { succeeded:'badge-paid', pending:'badge-pending', failed:'badge-declined', unknown:'badge-pending', voided:'badge-hidden' }[r.status] || 'badge-pending';
  };
  wrap.innerHTML = '<div class="q-cards">' + shown.map(r => `
    <div class="q-card">
      <div class="q-hdr">
        <span class="q-id">${xss(r.invoice_id)}${r.kind !== 'payment' ? ` · ${xss(r.kind)}` : ''}</span>
        <div style="display:flex;align-items:center;gap:12px;">
          <span class="badge ${clsFor(r)}">${xss(labelFor(r))}</span>
          <span class="q-amt" style="${r.kind === 'payment' ? '' : 'color:#f0a500;'}">${r.kind === 'payment' ? '' : '− '}$${(r.amount_cents/100).toFixed(2)}</span>
        </div>
      </div>
      <div class="q-meta">
        <div class="q-meta-item">Date<span>${bdate(r.settled_at || r.approved_at || r.created_at)}</span></div>
        <div class="q-meta-item">Method<span>${xss(r.method_display || methodName(r.method))}</span></div>
        ${r.provider_transaction_id ? `<div class="q-meta-item">Reference<span>${xss(r.provider_transaction_id)}</span></div>` : ''}
        ${r.reference ? `<div class="q-meta-item">Ref<span>${xss(r.reference)}</span></div>` : ''}
      </div>
      ${r.notes && r.kind !== 'payment'
        ? `<p style="color:var(--grey-light);font-size:.84rem;margin-top:6px;"><strong>Reason:</strong> ${xss(r.notes)}</p>`
        : ''}
      ${r.status === 'pending' && r.method === 'ach'
        ? `<p style="color:#f0a500;font-size:.86rem;margin-top:4px;">Bank payment processing — this usually clears in a few business days.</p>`
        : (r.kind === 'payment' && r.status === 'succeeded')
          ? `<button class="approve-btn" style="padding:8px 16px;font-size:.76rem;" onclick="printPaymentReceipt('${xss(r.id)}')">Print Receipt</button>` : ''}
    </div>`).join('') + '</div>';
}
function methodName(m) {
  return ({ card:'Card', ach:'Bank transfer (ACH)', check:'Check', cash:'Cash', bank_transfer:'Bank transfer', terminal:'Card (in person)', other:'Other' })[m] || '—';
}

// Receipt is rendered from the stored ledger row, fetched fresh at print time.


// ── PRINTABLE DOCUMENTS ───────────────────────
// Three distinctly named functions. There used to be two both called
// printReceipt() — one taking a payment id, one an invoice id — and the later
// declaration silently overrode the earlier, so the Payments page passed a
// payment id into the invoice printer.
//
// Every fetch is scoped to customer_id = USER.id, so a customer cannot type
// another company's id and pull their document. RLS enforces it independently.

const PRINT_CSS = `
  body{font-family:Arial,Helvetica,sans-serif;color:#111;max-width:720px;margin:0 auto;padding:40px 32px;}
  .hd{display:flex;justify-content:space-between;align-items:flex-start;border-bottom:3px solid #cc0000;padding-bottom:14px;}
  h1{font-size:22px;letter-spacing:.04em;text-transform:uppercase;margin:0;}
  .sub{font-size:11px;letter-spacing:.16em;text-transform:uppercase;color:#888;margin-top:3px;}
  .doc{text-align:right;font-size:12px;color:#555;line-height:1.7;}
  .stamp{display:inline-block;font-size:13px;font-weight:700;letter-spacing:.1em;padding:5px 12px;border:2px solid;margin-top:6px;}
  .paid{color:#2e7d32;border-color:#2e7d32;} .due{color:#cc0000;border-color:#cc0000;}
  .pend{color:#b26a00;border-color:#b26a00;} .info{color:#555;border-color:#999;}
  table{width:100%;border-collapse:collapse;font-size:13px;margin-top:20px;}
  th{text-align:left;border-bottom:2px solid #cc0000;padding:7px 0;font-size:11px;letter-spacing:.08em;color:#666;}
  td{padding:7px 0;border-bottom:1px solid #eee;}
  .r{text-align:right;} .tot{font-size:17px;font-weight:700;}
  .meta{margin-top:18px;font-size:13px;line-height:1.8;}
  .ft{margin-top:30px;padding-top:14px;border-top:1px solid #eee;font-size:11px;color:#666;line-height:1.7;}
  @media print{.noprint{display:none;}}
  .noprint{margin-top:22px;padding:10px 22px;background:#cc0000;color:#fff;border:none;font-size:14px;cursor:pointer;}
`;

function printDoc(title, bodyHtml) {
  const w = window.open('', '_blank', 'width=780,height=900');
  if (!w) { alert('Please allow pop-ups to print this document.'); return; }
  w.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>${title}</title>
    <style>${PRINT_CSS}</style></head><body>
    <div class="hd"><div><h1>Apex <span style="color:#cc0000">Lift Solutions</span></h1>
      <div class="sub">Forklift Repair &amp; Preventive Maintenance</div></div>
      <div class="doc">${title}</div></div>
    ${bodyHtml}
    <div class="ft">Apex Lift Solutions &middot; (516) 644-7187 &middot; service@apexliftsolutionsusa.com<br>
      Nassau &amp; Suffolk County, NY &middot; apexliftsolutionsusa.com</div>
    <button class="noprint" onclick="window.print()">Print / Save as PDF</button>
    </body></html>`);
  w.document.close();
}

const money = (cents) => '$' + (Number(cents || 0) / 100).toFixed(2);
const dollars = (n) => '$' + Number(n || 0).toFixed(2);

function itemsTable(items) {
  if (!Array.isArray(items) || !items.length) return '';
  const rows = items.map(it => {
    const qty = Number(it.qty ?? 1), unit = Number(it.unit_price ?? it.amount ?? 0);
    return `<tr><td>${esc(it.desc || '')}</td><td class="r">${qty}</td><td class="r">${dollars(qty * unit)}</td></tr>`;
  }).join('');
  return `<table><tr><th>Description</th><th class="r">Qty</th><th class="r">Amount</th></tr>${rows}</table>`;
}

function totalsTable(subCents, taxCents, rateMilli, exempt, totalDollars, label) {
  const hasTax = Number(taxCents) > 0 || exempt;
  return `<table style="margin-top:14px;">
    ${hasTax ? `
      <tr><td>Subtotal</td><td class="r">${money(subCents)}</td></tr>
      <tr><td>${exempt ? 'Sales Tax (exempt)' : `Sales Tax (${(Number(rateMilli || 0) / 1000).toFixed(3)}%)`}</td><td class="r">${money(taxCents)}</td></tr>` : ''}
    <tr><td class="tot">${label}</td><td class="r tot">${dollars(totalDollars)}</td></tr></table>`;
}

// Escape for a plain-HTML document window (portal xss() targets the portal DOM).
function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, ch =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}

async function printQuote(quoteId) {
  const { data: q, error } = await sb.from('quotes').select('*')
    .eq('id', quoteId).eq('customer_id', USER.id).maybeSingle();
  if (error || !q) { console.error('[Apex] printQuote failed', error); alert('Could not load that quote.'); return; }
  const stamp = q.status === 'approved' ? '<div class="stamp paid">Approved</div>'
              : q.status === 'declined' ? '<div class="stamp due">Declined</div>'
              : '<div class="stamp info">Pending</div>';
  printDoc(`Quote ${esc(q.id)}`, `
    <div class="meta">
      <strong>${esc(q.company || q.customer_name || '')}</strong><br>
      ${esc(q.customer_name || '')}<br>${esc(q.customer_email || '')}<br>
      Quote date: ${new Date(q.created_at).toLocaleDateString('en-US',{year:'numeric',month:'long',day:'numeric'})}
      ${q.responded_at ? `<br>Responded: ${new Date(q.responded_at).toLocaleDateString('en-US',{year:'numeric',month:'long',day:'numeric'})}` : ''}
      ${q.equipment ? `<br>Equipment: ${esc(q.equipment)}` : ''}
      ${q.invoiced ? '<br>Status: Invoiced' : ''}
      <div>${stamp}</div>
    </div>
    ${q.description ? `<p style="margin-top:16px;font-size:13px;">${esc(q.description)}</p>` : ''}
    ${itemsTable(q.items)}
    ${totalsTable(q.subtotal_cents, q.tax_cents, q.tax_rate_milli_pct, q.tax_exempt, q.amount, 'Quote Total')}
    ${Array.isArray(q.attachments) && q.attachments.length ? `<p style="font-size:12px;color:#666;margin-top:14px;">${q.attachments.length} photo(s) attached — view them in your client portal.</p>` : ''}
    <p style="font-size:11px;color:#666;margin-top:14px;">This is a quote, not a bill. No payment is due against this document.</p>`);
}

async function printInvoice(invoiceId) {
  const { data: i, error } = await sb.from('invoices').select('*')
    .eq('id', invoiceId).eq('customer_id', USER.id).maybeSingle();
  if (error || !i) { console.error('[Apex] printInvoice failed', error); alert('Could not load that invoice.'); return; }
  const stamp = { paid:'<div class="stamp paid">Paid</div>',
    payment_pending:'<div class="stamp pend">Payment Pending</div>',
    partially_refunded:'<div class="stamp info">Partially Refunded</div>',
    refunded:'<div class="stamp info">Refunded</div>',
    void:'<div class="stamp info">Void / Cancelled</div>',
    unpaid:'<div class="stamp due">Amount Due</div>' }[i.status]
    || '<div class="stamp info">' + esc(String(i.status).replace(/_/g,' ')) + '</div>';
  printDoc(`Invoice ${esc(i.id)}`, `
    <div class="meta">
      <strong>${esc(i.company || i.customer_name || '')}</strong><br>
      ${esc(i.customer_name || '')}<br>${esc(i.customer_email || '')}<br>
      Invoice date: ${new Date(i.created_at).toLocaleDateString('en-US',{year:'numeric',month:'long',day:'numeric'})}
      ${i.due ? `<br>Due: ${new Date(i.due).toLocaleDateString('en-US',{year:'numeric',month:'long',day:'numeric'})}` : ''}
      ${i.paid_at ? `<br>Paid: ${new Date(i.paid_at).toLocaleDateString('en-US',{year:'numeric',month:'long',day:'numeric'})}` : ''}
      ${i.quote_id ? `<br>From quote: ${esc(i.quote_id)}` : ''}
      <div>${stamp}</div>
    </div>
    ${i.description ? `<p style="margin-top:16px;font-size:13px;">${esc(i.description)}</p>` : ''}
    ${itemsTable(i.items)}
    ${totalsTable(i.subtotal_cents, i.tax_cents, i.tax_rate_milli_pct, i.tax_exempt, i.amount,
        i.status === 'paid' ? 'Total Paid' : 'Amount Due')}`);
}

async function printPaymentReceipt(paymentId) {
  const { data: p, error } = await sb.from('payments').select('*')
    .eq('id', paymentId).eq('customer_id', USER.id).maybeSingle();
  if (error || !p) { console.error('[Apex] printPaymentReceipt failed', error); alert('Could not load that receipt.'); return; }
  if (p.status !== 'succeeded') {
    alert(p.status === 'pending'
      ? 'This bank payment is still processing. A receipt will be available once it clears.'
      : 'A receipt is only available for a completed payment.');
    return;
  }
  // Tax breakdown comes from the linked invoice, not from the payment row.
  const { data: inv } = await sb.from('invoices')
    .select('subtotal_cents, tax_cents, tax_rate_milli_pct, tax_exempt, company, customer_name, quote_id')
    .eq('id', p.invoice_id).eq('customer_id', USER.id).maybeSingle();

  const isCard = p.method === 'card';
  const fee = Number(p.fee_cents || 0);
  printDoc('Payment Receipt', `
    <div class="meta">
      <strong>${esc(inv?.company || inv?.customer_name || '')}</strong><br>
      Invoice: ${esc(p.invoice_id)}<br>
      Payment date: ${new Date(p.settled_at || p.approved_at || p.created_at).toLocaleDateString('en-US',{year:'numeric',month:'long',day:'numeric'})}<br>
      Payment method: ${esc(p.method_display || (isCard ? 'Credit / Debit Card' : p.method === 'ach' ? 'Bank transfer (ACH)' : p.method || 'Payment'))}
      ${p.provider_transaction_id ? `<br>Transaction: ${esc(p.provider_transaction_id)}` : ''}
      ${p.reference ? `<br>Reference: ${esc(p.reference)}` : ''}
      <div class="stamp paid">Paid</div>
    </div>
    <table style="margin-top:18px;">
      ${inv && (Number(inv.tax_cents) > 0 || inv.tax_exempt) ? `
        <tr><td>Subtotal</td><td class="r">${money(inv.subtotal_cents)}</td></tr>
        <tr><td>${inv.tax_exempt ? 'Sales Tax (exempt)' : `Sales Tax (${(Number(inv.tax_rate_milli_pct || 0) / 1000).toFixed(3)}%)`}</td><td class="r">${money(inv.tax_cents)}</td></tr>` : ''}
      <tr><td>Invoice total</td><td class="r">${money(p.amount_cents)}</td></tr>
      ${fee > 0 ? `<tr><td>Card convenience fee</td><td class="r">${money(fee)}</td></tr>` : ''}
      <tr><td class="tot">Total charged</td><td class="r tot">${money(p.total_charged_cents ?? p.amount_cents)}</td></tr>
    </table>
    ${fee > 0 ? '<p style="font-size:11px;color:#666;margin-top:12px;">The convenience fee is collected by the payment processor. Paying by bank transfer (ACH) avoids it.</p>' : ''}`);
}

// ── SERVICE REQUEST ───────────────────────────
function handleReqFiles(input) {
  REQ_FILES = Array.from(input.files);
  document.getElementById('req-file-list').innerHTML = REQ_FILES.map((f, i) =>
    `<div class="file-chip">📎 ${xss(f.name)}<button onclick="removeReqFile(${i})">×</button></div>`
  ).join('');
}

function removeReqFile(idx) {
  REQ_FILES.splice(idx, 1);
  handleReqFiles({ files: REQ_FILES });
}

async function submitRequest() {
  const equip   = document.getElementById('req-equip').value.trim();
  const type    = document.getElementById('req-type').value;
  const desc    = document.getElementById('req-desc').value.trim();
  const urgency = document.getElementById('req-urgency').value;
  const msgEl   = document.getElementById('req-msg');
  msgEl.style.display = 'none';

  if (!desc) {
    msgEl.textContent = 'Please describe the issue before submitting.';
    msgEl.className = 'banner banner-err';
    msgEl.style.display = 'block';
    return;
  }

  const btn = document.getElementById('req-btn');
  btn.disabled = true; btn.textContent = 'Sending…';

  try {
    const urls = [];
    if (REQ_FILES.length) {
      for (const file of REQ_FILES) {
        const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, '_');
        const safePath = `service-requests/${USER.id}/${Date.now()}_${safeName}`;
        const { error: upErr } = await sb.storage.from('apex-uploads').upload(safePath, file, { upsert: true, contentType: file.type });
        if (!upErr) {
          urls.push(safePath);   // private bucket: store the PATH, mint signed URLs on read
        } else {
          console.error('Upload failed:', upErr.message);
        }
      }
    }

    // Identity fields (customer_id / email / name / company) are deliberately NOT
    // sent. A BEFORE INSERT trigger derives them from the authenticated customers
    // row, so a crafted request cannot appear to come from someone else. We send
    // only the request-specific fields.
    const { data: savedReq, error: reqErr } = await sb.from('service_requests').insert({
      customer_id: USER.id,          // still required to satisfy the RLS WITH CHECK
      equipment:   equip || '',
      issue_type:  type  || '',
      description: desc,
      urgency,
      attachments: urls.length ? urls : null
    }).select().single();

    if (reqErr) console.error('Service request save error:', reqErr);

    const fileLinks = urls.length ? '\n\nPhoto attachments:\n' + urls.map((u, i) => `${i + 1}. ${u}`).join('\n') : '';

    msgEl.innerHTML = `✓ Request sent! We'll contact you at <strong>${xss(USER.email)}</strong> within 1 business day.<br>Emergency? Call <strong><a href="tel:+15166447187" style="color:inherit;">(516) 644-7187</a></strong>.`;
    msgEl.className = 'banner banner-ok';
    msgEl.style.display = 'block';

    document.getElementById('req-equip').value   = '';
    document.getElementById('req-desc').value    = '';
    document.getElementById('req-type').value    = '';
    document.getElementById('req-urgency').value = 'normal';
    REQ_FILES = [];
    document.getElementById('req-file-list').innerHTML = '';
    document.getElementById('req-files').value = '';

  } catch (e) {
    console.error('Request error:', e);
    msgEl.textContent = 'Failed to send. Please call <a href="tel:+15166447187" style="color:inherit;">(516) 644-7187</a> directly.';
    msgEl.className = 'banner banner-err';
    msgEl.style.display = 'block';
  } finally {
    btn.disabled = false; btn.textContent = 'Send Service Request';
  }
}

// ── CONFIRM MODAL ─────────────────────────────
function showConfirm(title, body, onYes) {
  document.getElementById('confirm-title').textContent = title;
  document.getElementById('confirm-body').textContent  = body;
  const btn = document.getElementById('confirm-yes');
  btn.disabled = false; btn.textContent = 'Confirm';
  btn.onclick = onYes;
  document.getElementById('confirm-overlay').className = 'confirm-overlay open';
}
function closeConfirm() { document.getElementById('confirm-overlay').className = 'confirm-overlay'; }

// ── BANNER ────────────────────────────────────
function showBanner(msg, type) {
  const d = document.createElement('div');
  d.className = 'banner banner-' + (type || 'ok');
  d.innerHTML = msg;
  document.querySelector('.main').prepend(d);
  setTimeout(() => d.remove(), 6000);
}

// ── VIEW SWITCHER ─────────────────────────────
function showView(v, el) {
  document.querySelectorAll('.view').forEach(x => x.classList.remove('active'));
  document.querySelectorAll('.nav-item').forEach(x => x.classList.remove('active'));
  document.getElementById('view-' + v)?.classList.add('active');
  if (el) el.classList.add('active');
  if (v === 'quotes')   loadQuotes();
  if (v === 'invoices') loadInvoices();
  if (v === 'history')  loadHistory();
  if (v === 'payments') loadPayments();
  if (v === 'account')  loadAccount();
  if (v === 'service-plans') loadServicePlans();
  const titles = { quotes: 'My Quotes', invoices: 'My Invoices', pay: 'Pay Invoice', history: 'Service History', request: 'Request Service', account: 'My Account', 'service-plans': 'Service Plans', agreement: 'Agreement' };
  const titleEl = document.getElementById('mobile-page-title');
  if (titleEl && titles[v]) titleEl.textContent = titles[v];
  closeMobileSidebar();
}

// ── MOBILE SIDEBAR ────────────────────────────
function toggleMobileSidebar() {
  const sidebar = document.getElementById('portal-sidebar');
  const overlay = document.getElementById('sidebar-overlay');
  const btn     = document.getElementById('mobile-menu-btn');
  const isOpen  = sidebar.classList.contains('mobile-open');
  sidebar.classList.toggle('mobile-open', !isOpen);
  overlay.classList.toggle('open', !isOpen);
  btn.classList.toggle('open', !isOpen);
}

function closeMobileSidebar() {
  document.getElementById('portal-sidebar')?.classList.remove('mobile-open');
  document.getElementById('sidebar-overlay')?.classList.remove('open');
  document.getElementById('mobile-menu-btn')?.classList.remove('open');
}

// ── REMOVE DECLINED QUOTE ─────────────────────
async function removeQuote(id) {
  if (!confirm('Remove this declined quote from your view?')) return;
  const { error } = await sb.rpc('hide_declined_quote', { p_quote_id: id });
  if (!error) { showBanner('Quote removed from your view.', 'ok'); loadQuotes(); }
  else showBanner('Could not remove. Please try again.', 'err');
}

// ── LOGOUT ────────────────────────────────────
async function doLogout() {
  await sb.auth.signOut();
  location.href = 'portal-login.html';
}

// ── ACCOUNT: LOAD ─────────────────────────────
async function loadAccount() {
  if (!USER) return;
  document.getElementById('acct-name').value    = USER.name    || '';
  document.getElementById('acct-company').value = USER.company || '';
  document.getElementById('acct-phone').value   = USER.phone   || '';
  document.getElementById('acct-email').value   = USER.email   || '';

  // Attach phone formatter to account phone field
  const ph = document.getElementById('acct-phone');
  if (ph && !ph.dataset.fmtAttached) {
    ph.dataset.fmtAttached = '1';
    ph.addEventListener('input', () => {
      const digits = ph.value.replace(/\D/g,'').slice(0,10);
      let f = '';
      if (digits.length === 0)     f = '';
      else if (digits.length <= 3) f = '(' + digits;
      else if (digits.length <= 6) f = '(' + digits.slice(0,3) + ') ' + digits.slice(3);
      else                         f = '(' + digits.slice(0,3) + ') ' + digits.slice(3,6) + '-' + digits.slice(6);
      if (ph.value !== f) ph.value = f;
    });
  }

  // Load latest from DB to stay in sync
  try {
    const { data } = await sb.from('customers').select('name,company,phone').eq('id', USER.id).single();
    if (data) {
      document.getElementById('acct-name').value    = data.name    || '';
      document.getElementById('acct-company').value = data.company || '';
      document.getElementById('acct-phone').value   = data.phone   || '';
    }
  } catch(e) { /* non-fatal */ }
}

// ── ACCOUNT: SAVE PROFILE ─────────────────────
async function saveProfile() {
  const name    = document.getElementById('acct-name').value.trim();
  const company = document.getElementById('acct-company').value.trim();
  const phone   = document.getElementById('acct-phone').value.trim();
  const msg     = document.getElementById('acct-profile-msg');
  msg.style.display = 'none';

  if (!name) { msg.textContent = 'Name is required.'; msg.className = 'banner banner-err'; msg.style.display = 'block'; return; }

  const btn = document.querySelector('#view-account .account-section .btn-primary');
  if (btn) { btn.disabled = true; btn.textContent = 'Saving…'; }

  try {
    // Customers have no UPDATE policy on their row. This RPC edits exactly three fields.
    const { error } = await sb.rpc('update_my_profile', { p_name: name, p_company: company, p_phone: phone });
    if (error) throw error;
    USER.name    = name;
    USER.company = company;
    USER.phone   = phone;
    document.getElementById('cust-name').textContent    = xss(name);
    document.getElementById('cust-company').textContent = xss(company);
    msg.textContent = '✓ Profile updated!';
    msg.className = 'banner banner-ok';
    msg.style.display = 'block';
    setTimeout(() => msg.style.display = 'none', 3500);
  } catch(e) {
    msg.textContent = 'Error saving. Please try again.';
    msg.className = 'banner banner-err';
    msg.style.display = 'block';
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Save Changes'; }
  }
}

// ── ACCOUNT: CHANGE PASSWORD ──────────────────
async function changePassword() {
  const pass  = document.getElementById('acct-pass').value;
  const pass2 = document.getElementById('acct-pass2').value;
  const msg   = document.getElementById('acct-pass-msg');
  msg.style.display = 'none';

  if (pass.length < 8) { msg.textContent = 'Password must be at least 8 characters.'; msg.className = 'banner banner-err'; msg.style.display = 'block'; return; }
  if (pass !== pass2)  { msg.textContent = 'Passwords do not match.'; msg.className = 'banner banner-err'; msg.style.display = 'block'; return; }

  const { error } = await sb.auth.updateUser({ password: pass });
  if (error) {
    msg.textContent = 'Error: ' + error.message;
    msg.className = 'banner banner-err';
  } else {
    msg.textContent = '✓ Password updated successfully!';
    msg.className = 'banner banner-ok';
    document.getElementById('acct-pass').value  = '';
    document.getElementById('acct-pass2').value = '';
  }
  msg.style.display = 'block';
  setTimeout(() => msg.style.display = 'none', 4000);
}

// ── PRINT RECEIPT ─────────────────────────────

/* ═══════════════════════════════════════════════════════════════════════════
   SERVICE PLANS — Phase C (customer)

   Reads go direct through PostgREST under RLS: a customer sees only their own
   rows, and never a draft offer.

   Writes do not. The browser has no INSERT/UPDATE on these tables. Declining,
   previewing and signing all go through the service-plans-customer Edge
   Function, and the contract itself is authored server-side from database rows
   — this file never computes, sends or stores a price.

   Nothing here collects card or bank details. Phase C ends at the signature.
   ═══════════════════════════════════════════════════════════════════════════ */

const CP = { offers: [], equipment: {}, agreements: [], subs: [], current: null, rail: null, preview: null };

const cpUsd = c => '$' + (Number(c ?? 0) / 100).toFixed(2);
const cpDate = d => d ? new Date(String(d).length === 10 ? d + 'T12:00:00Z' : d)
  .toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' }) : '—';

async function cpCall(action, payload) {
  const { data: { session } } = await sb.auth.getSession();
  if (!session) { alert('Your session expired. Please sign in again.'); return null; }
  const r = await fetch(`${SB_URL}/functions/v1/service-plans-customer`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${session.access_token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ action, ...payload }),
  });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) { alert(cpError(body)); return null; }
  return body;
}

function cpError(b) {
  const map = {
    offer_no_longer_open: 'This offer is no longer open. Please refresh.',
    offer_expired: 'This offer has expired. Contact us and we will send a new one.',
    price_changed_reload: 'The plan details changed. Please reload and review again.',
    all_consents_required: 'Please check all four boxes before signing.',
    already_signed: 'This plan has already been signed.',
    pdf_not_ready: 'Your agreement PDF is still being prepared. Try again in a moment.',
    not_found: 'We could not find that plan.',
  };
  return map[b?.error] || b?.detail || b?.error || 'Something went wrong. Please try again.';
}

async function loadServicePlans() {
  const wrap = document.getElementById('cp-body');
  wrap.innerHTML = '<div class="empty-state">Loading…</div>';

  const [offers, equip, agrees, subs] = await Promise.all([
    sb.from('service_plan_offers').select('*').order('created_at', { ascending: false }),
    sb.from('customer_equipment').select('*'),
    sb.from('service_plan_agreements').select('*').order('signed_at', { ascending: false }),
    sb.from('service_subscriptions').select('*'),
  ]);

  CP.offers = offers.data || [];
  CP.agreements = agrees.data || [];
  CP.subs = subs.data || [];
  CP.equipment = {};
  for (const e of equip.data || []) CP.equipment[e.id] = e;

  const open = CP.offers.filter(o => o.status === 'sent');
  if (!open.length && !CP.agreements.length) {
    wrap.innerHTML = `<div class="empty-state">You don't have any service plans yet.<br>
      <span style="font-size:.85rem;color:var(--grey);">Ask us about monthly maintenance for your forklifts — (516) 644-7187.</span></div>`;
    return;
  }

  let html = '';
  for (const o of open) html += cpOfferCard(o);
  for (const a of CP.agreements) html += cpAgreementCard(a);
  wrap.innerHTML = html;
}

function cpUnitLine(equipmentId) {
  const e = CP.equipment[equipmentId] || {};
  const label = [e.year, e.make, e.model].filter(Boolean).join(' ') || 'Forklift';
  return {
    title: e.unit_number ? `${e.unit_number} — ${label}` : label,
    meta: [
      e.serial_number ? `Serial ${esc(e.serial_number)}` : null,
      e.service_location ? esc(e.service_location) : null,
    ].filter(Boolean).join(' · '),
  };
}

function cpOfferCard(o) {
  const u = cpUnitLine(o.equipment_id);
  const inc = (o.included_services || []).map(x => `<li>${esc(x)}</li>`).join('');
  const exc = (o.exclusions || []).map(x => `<li>${esc(x)}</li>`).join('');
  const saving = Number(o.card_monthly_total_cents) - Number(o.ach_monthly_total_cents);

  return `<div class="cp-card">
    <span class="cp-pill sent">Awaiting your decision</span>
    <h3 style="margin-top:8px;">${esc(o.plan_name)}</h3>
    <div class="cp-meta">${esc(u.title)}${u.meta ? `<br>${u.meta}` : ''}</div>
    ${o.description ? `<p style="margin:10px 0 0;font-size:.92rem;">${esc(o.description)}</p>` : ''}

    <div class="cp-rails">
      <div class="cp-rail">
        <div class="lbl">Bank transfer (ACH)</div>
        <div class="big">${cpUsd(o.ach_monthly_total_cents)}<span style="font-size:.8rem;font-weight:400;">/month</span></div>
        <div class="sub">Service ${cpUsd(o.ach_monthly_subtotal_cents)}${o.tax_exempt ? ' · tax exempt' : ` · tax ${cpUsd(o.ach_monthly_tax_cents)}`}</div>
        ${saving > 0 ? `<div class="save">Saves ${cpUsd(saving)} a month vs card</div>` : ''}
      </div>
      <div class="cp-rail">
        <div class="lbl">Card</div>
        <div class="big">${cpUsd(o.card_monthly_total_cents)}<span style="font-size:.8rem;font-weight:400;">/month</span></div>
        <div class="sub">Service ${cpUsd(o.card_monthly_subtotal_cents)}${o.tax_exempt ? ' · tax exempt' : ` · tax ${cpUsd(o.card_monthly_tax_cents)}`}</div>
      </div>
    </div>

    <div class="cp-lists">
      ${inc ? `<div><b>Included</b><ul>${inc}</ul></div>` : '<div></div>'}
      ${exc ? `<div><b>Not included</b><ul>${exc}</ul></div>` : '<div></div>'}
    </div>

    <div class="cp-meta cp-sec">
      <b>${esc(o.term_months)} monthly payments</b> starting ${cpDate(o.activation_date)}. No automatic renewal.
      ${o.expires_at ? `<br>This offer expires ${cpDate(o.expires_at)}.` : ''}
    </div>

    <div style="display:flex;gap:10px;flex-wrap:wrap;margin-top:16px;">
      <button class="approve-btn" type="button" onclick="cpReview('${o.id}')">Review agreement</button>
      <button class="btn-secondary" type="button" onclick="cpDecline('${o.id}')">Not right now</button>
    </div>
  </div>`;
}

function cpAgreementCard(a) {
  const u = cpUnitLine(a.equipment_id);
  const sub = CP.subs.find(s => s.agreement_id === a.id);
  const st = sub?.status || 'setup_pending';
  let setup = '';
  if (!sub || ['setup_pending','failed_setup'].includes(st)) {
    setup = `<div class="cp-meta cp-sec"><b>Payment setup required.</b> Nothing has been charged yet.</div>
      <button class="approve-btn" type="button" onclick="cpStartPlanPayment('${a.id}')">Add payment method</button>`;
  } else if (st === 'method_verified') {
    setup = `<div class="cp-meta cp-sec"><b>Payment method verified.</b> ${esc(sub.payment_method_display || '')}<br>
      The recurring subscription has not been activated yet.</div>
      <button class="approve-btn" type="button" onclick="cpActivatePlan('${sub.id}')">Activate service plan</button>`;
  } else if (st === 'active' || st === 'past_due') {
    setup = `<div class="cp-meta cp-sec"><b>${st === 'active' ? 'Active service plan' : 'Payment issue — plan is past due'}</b><br>
      ${esc(sub.payment_method_display || '')}${sub.next_billing_date ? ` · Next billing ${cpDate(sub.next_billing_date)}` : ''}<br>
      ${esc(sub.times_billed || 0)} of ${esc(sub.max_cycles || a.term_months)} billing cycles processed.</div>`;
  } else if (st === 'completed') {
    setup = `<div class="cp-meta cp-sec"><b>Completed.</b> All scheduled payments for this fixed-term agreement are complete.</div>`;
  } else {
    setup = `<div class="cp-meta cp-sec">Plan status: ${esc(st)}</div>`;
  }
  return `<div class="cp-card">
    <span class="cp-pill signed">${a.status === 'signed' ? 'Signed' : esc(a.status)}</span>
    <h3 style="margin-top:8px;">${esc(u.title)}</h3>
    <div class="cp-meta">
      ${cpUsd(a.monthly_total_cents)} a month by ${a.selected_payment_method === 'ach' ? 'bank transfer' : 'card'}<br>
      <b>Fixed ${esc(a.term_months)}-payment term</b> starting ${cpDate(a.activation_date)} · no automatic renewal<br>
      Signed by ${esc(a.signer_name)}${a.signer_title ? `, ${esc(a.signer_title)}` : ''} on ${cpDate(a.signed_at)}
    </div>
    ${setup}
    <div style="margin-top:14px;display:flex;gap:10px;flex-wrap:wrap;">
      <button class="btn-secondary" type="button" onclick="cpOpenPdf('${a.id}')"
        ${a.pdf_path ? '' : 'disabled title="Your PDF is still being prepared"'}>View signed agreement (PDF)</button>
    </div>
  </div>`;
}

let CP_VERIFY_LISTENER = null;
let CP_VERIFY_BUSY = false;

async function cpStartPlanPayment(agreementId) {
  if (CP_VERIFY_BUSY) return;
  CP_VERIFY_BUSY = true;
  try {
    const { data: { session } } = await sb.auth.getSession();
    if (!session) { alert('Your session expired. Please sign in again.'); return; }
    const r = await fetch(`${FN_BASE}/subscription-verify-checkout`, {
      method:'POST', headers:{'Authorization':`Bearer ${session.access_token}`,'Content-Type':'application/json'},
      body:JSON.stringify({agreement_id:agreementId}),
    });
    const out = await r.json().catch(()=>({}));
    if (!r.ok) { alert(cpPlanPayError(out)); return; }
    if (out.already_verified) { await loadServicePlans(); return; }
    const checkoutToken = out.checkoutToken;
    if (!checkoutToken) { alert('Payment setup could not start. Please try again.'); return; }
    if (CP_VERIFY_LISTENER) window.removeEventListener('message', CP_VERIFY_LISTENER);
    let settled = false;
    CP_VERIFY_LISTENER = async (ev) => {
      let d = ev.data; if (typeof d === 'string') { try { d = JSON.parse(d); } catch {} }
      if (!d || typeof d !== 'object' || d.eventName !== `helcim-pay-js-${checkoutToken}`) return;
      const status = String(d.eventStatus || '').toUpperCase();
      if (status === 'ABORTED' || status === 'HIDE') {
        if (settled) return;
        try { removeHelcimPayIframe(); } catch {}
        document.body.classList.remove('helcim-active');
        CP_VERIFY_BUSY = false;
        return;
      }
      if (status !== 'SUCCESS') return;
      settled = true;
      try { removeHelcimPayIframe(); } catch {}
      document.body.classList.remove('helcim-active');
      const hp = normalizeHelcimPay(d.eventMessage);
      const vr = await fetch(`${FN_BASE}/subscription-verify-validate`, {
        method:'POST', headers:{'Authorization':`Bearer ${session.access_token}`,'Content-Type':'application/json'},
        body:JSON.stringify({checkoutToken,eventMessage:d.eventMessage,rawDataResponse:hp.txnJson,hash:hp.hash}),
      });
      const vo = await vr.json().catch(()=>({}));
      if (!vr.ok) { alert(cpPlanPayError(vo)); CP_VERIFY_BUSY=false; return; }
      alert(`Payment method saved${vo.payment_method_display ? `: ${vo.payment_method_display}` : ''}.`);
      await loadServicePlans();
      // In production, activation succeeds only when the server-side recurring
      // gate has been deliberately enabled. In test mode this safely returns a
      // disabled message and leaves the method verified.
      await cpActivatePlan(vo.subscription_id, true);
      CP_VERIFY_BUSY = false;
    };
    window.addEventListener('message', CP_VERIFY_LISTENER);
    document.body.classList.add('helcim-active');
    appendHelcimPayIframe(checkoutToken, true);
  } catch (e) {
    console.error('[Apex] service plan payment setup failed', e);
    alert('Could not start payment setup. Please try again.');
  } finally {
    if (!document.body.classList.contains('helcim-active')) CP_VERIFY_BUSY = false;
  }
}

async function cpActivatePlan(subscriptionId, quietDisabled=false) {
  if (!subscriptionId) return;
  const { data: { session } } = await sb.auth.getSession();
  if (!session) return;
  const r = await fetch(`${FN_BASE}/subscription-activate`, {
    method:'POST', headers:{'Authorization':`Bearer ${session.access_token}`,'Content-Type':'application/json'},
    body:JSON.stringify({subscription_id:subscriptionId}),
  });
  const out = await r.json().catch(()=>({}));
  if (!r.ok) {
    if (out.error === 'recurring_billing_disabled' && quietDisabled) { await loadServicePlans(); return; }
    alert(cpPlanPayError(out)); return;
  }
  alert(out.already_active ? 'Service plan is already active.' : 'Service plan activated.');
  await loadServicePlans();
}

function cpPlanPayError(b) {
  const m = {
    account_not_active:'Your account is not active.', pdf_not_ready:'Your signed agreement PDF is not ready yet.',
    recurring_billing_disabled:'Your payment method is saved. Recurring billing is still in test mode and has not been activated.',
    recurring_plan_not_configured:'Apex has not finished configuring the recurring payment plan yet.',
    test_activation_date_must_be_future:'Test subscriptions must start on a future date.',
    payment_method_not_verified:'Please add your payment method first.', activation_under_review:'Apex is confirming a previous activation attempt. Do not try again.',
    gateway_init_failed:'Helcim payment setup could not start. Please try again.', verify_session_expired_or_used:'This setup session expired. Start again.',
    hash_mismatch:'We could not verify the payment-method response. No recurring plan was activated.'
  };
  return m[b?.error] || b?.detail || b?.error || 'Something went wrong. Please try again.';
}

async function cpDecline(offerId) {
  const reason = prompt('Let us know why, if you like. (Optional)');
  if (reason === null) return;
  if (await cpCall('decline-offer', { offer_id: offerId, reason })) await loadServicePlans();
}

async function cpOpenPdf(agreementId) {
  const res = await cpCall('agreement-url', { agreement_id: agreementId });
  if (res?.url) window.open(res.url, '_blank', 'noopener');
}

/* ── Review + sign ─────────────────────────────────────────────────────── */
async function cpReview(offerId) {
  CP.current = CP.offers.find(o => o.id === offerId) || null;
  if (!CP.current) return;
  CP.rail = null;
  CP.preview = null;
  showView('agreement');
  cpRenderChooser();
}

function cpRenderChooser() {
  const o = CP.current;
  const u = cpUnitLine(o.equipment_id);
  const saving = Number(o.card_monthly_total_cents) - Number(o.ach_monthly_total_cents);
  document.getElementById('cp-agr-title').textContent = 'Choose how you would like to pay';
  document.getElementById('cp-agr-body').innerHTML = `
    <div class="cp-card">
      <h3>${esc(o.plan_name)}</h3>
      <div class="cp-meta">${esc(u.title)}${u.meta ? `<br>${u.meta}` : ''}</div>
      <div class="cp-rails">
        <button class="cp-rail" type="button" id="cp-rail-ach" onclick="cpPick('ach')">
          <div class="lbl">Bank transfer (ACH)</div>
          <div class="big">${cpUsd(o.ach_monthly_total_cents)}<span style="font-size:.8rem;font-weight:400;">/month</span></div>
          <div class="sub">Service ${cpUsd(o.ach_monthly_subtotal_cents)}${o.tax_exempt ? ' · tax exempt' : ` · tax ${cpUsd(o.ach_monthly_tax_cents)}`}</div>
          ${saving > 0 ? `<div class="save">Saves ${cpUsd(saving)} a month</div>` : ''}
        </button>
        <button class="cp-rail" type="button" id="cp-rail-card" onclick="cpPick('card')">
          <div class="lbl">Card</div>
          <div class="big">${cpUsd(o.card_monthly_total_cents)}<span style="font-size:.8rem;font-weight:400;">/month</span></div>
          <div class="sub">Service ${cpUsd(o.card_monthly_subtotal_cents)}${o.tax_exempt ? ' · tax exempt' : ` · tax ${cpUsd(o.card_monthly_tax_cents)}`}</div>
        </button>
      </div>
      <p class="cp-meta">Card processing costs more, so card is priced higher. You are not entering any
      payment details on this page — we will set that up separately, after you sign.</p>
    </div>`;
}

async function cpPick(rail) {
  CP.rail = rail;
  document.getElementById('cp-rail-ach')?.classList.toggle('sel', rail === 'ach');
  document.getElementById('cp-rail-card')?.classList.toggle('sel', rail === 'card');

  const body = document.getElementById('cp-agr-body');
  body.insertAdjacentHTML('beforeend', '<div class="empty-state" id="cp-loading">Preparing your agreement…</div>');

  // The contract is authored on the server from database rows. The browser
  // sends only the offer id and the chosen rail.
  const res = await cpCall('preview-agreement', { offer_id: CP.current.id, payment_method: rail });
  document.getElementById('cp-loading')?.remove();
  if (!res) return;
  CP.preview = res;
  cpRenderAgreement();
}

function cpRenderAgreement() {
  const a = CP.preview;
  const auth = a.authorized;
  document.getElementById('cp-agr-title').textContent = 'Review and sign';

  const sections = (a.sections || []).map(s => `
    <div class="cp-sec"><h4>${esc(s.heading)}</h4><p>${esc(s.body)}</p>
    ${a.legal_review_required && s.legal_review ? '<div class="cp-legal">This section is subject to legal review.</div>' : ''}</div>`).join('');

  document.getElementById('cp-agr-body').innerHTML = `
    ${a.legal_review_required ? `<div class="cp-draft"><b>Draft agreement.</b> The amounts and equipment below come
      from our records and are accurate. The contract wording has not yet been reviewed by an attorney.</div>` : ''}

    <div class="cp-card">
      <h3>You are authorizing ${cpUsd(auth.monthly_total_cents)} a month</h3>
      <div class="cp-meta">
        ${auth.selected_payment_method === 'ach' ? 'Bank transfer (ACH)' : 'Card'} ·
        ${esc(auth.term_months)} monthly payments · first payment ${cpDate(auth.activation_date)}<br>
        Service ${cpUsd(auth.monthly_subtotal_cents)}${auth.tax_exempt ? ' · tax exempt' : ` · sales tax ${cpUsd(auth.monthly_tax_cents)}`}<br>
        Total across the whole term: <b>${cpUsd(auth.total_over_term_cents)}</b>
      </div>
      <p class="cp-meta" style="margin-top:10px;">
        <button class="btn-secondary" type="button" onclick="cpRenderChooser()">Change payment method</button>
      </p>
    </div>

    <div class="cp-card">${sections}</div>

    <div class="cp-card">
      <h3>Sign</h3>
      <label class="cp-consent"><input type="checkbox" id="cp-c1">
        I have reviewed the services included and not included.</label>
      <label class="cp-consent"><input type="checkbox" id="cp-c2">
        I authorize Apex Lift Solutions to charge <b>${cpUsd(auth.monthly_total_cents)}</b> per month for
        ${esc(auth.term_months)} months, starting ${cpDate(auth.activation_date)}.</label>
      <label class="cp-consent"><input type="checkbox" id="cp-c3">
        I agree to sign electronically and that my typed name is my signature.</label>
      <label class="cp-consent"><input type="checkbox" id="cp-c4">
        I understand this is a fixed ${esc(auth.term_months)}-payment term and I do not have an ordinary right to cancel it early.</label>

      <div class="cp-sign">
        <label>Your full name<input id="cp-signer" maxlength="120" autocomplete="name"></label>
        <label>Your title (optional)<input id="cp-title" maxlength="120" placeholder="Operations Manager"></label>
        <label>Type your name to sign<input id="cp-signature" class="cp-sig" maxlength="120" autocomplete="off"></label>
      </div>

      <p class="cp-meta" style="margin-top:14px;">Signing does not charge you. No payment details are collected on this page.</p>
      <button class="approve-btn" type="button" id="cp-sign-btn" style="margin-top:10px;">Sign agreement</button>
    </div>`;

  document.getElementById('cp-signer').addEventListener('input', e => {
    const sig = document.getElementById('cp-signature');
    if (!sig.dataset.touched) sig.value = e.target.value;
  });
  document.getElementById('cp-signature').addEventListener('input', e => { e.target.dataset.touched = '1'; });
  document.getElementById('cp-sign-btn').addEventListener('click', cpSign);
}

async function cpSign() {
  const btn = document.getElementById('cp-sign-btn');
  const consents = ['cp-c1', 'cp-c2', 'cp-c3', 'cp-c4'].map(id => document.getElementById(id).checked);
  if (consents.some(c => !c)) { alert('Please check all four boxes before signing.'); return; }

  const signer = document.getElementById('cp-signer').value.trim();
  const signature = document.getElementById('cp-signature').value.trim();
  if (!signer) { alert('Please enter your full name.'); return; }
  if (!signature) { alert('Please type your name to sign.'); return; }

  btn.disabled = true;
  btn.textContent = 'Signing…';

  const res = await cpCall('sign', {
    offer_id: CP.current.id,
    payment_method: CP.rail,
    signer_name: signer,
    signer_title: document.getElementById('cp-title').value.trim(),
    signature_typed: signature,
    consent_service_scope: consents[0],
    consent_recurring_auth: consents[1],
    consent_electronic_sig: consents[2],
    consent_term_cancel: consents[3],
  });

  btn.disabled = false;
  btn.textContent = 'Sign agreement';
  if (!res) return;

  document.getElementById('cp-agr-title').textContent = 'Agreement signed';
  document.getElementById('cp-agr-body').innerHTML = `
    <div class="cp-card">
      <h3>Thank you — your agreement is signed.</h3>
      <p class="cp-meta">We have emailed you a copy. Nothing has been charged, and no payment details
      have been collected yet. We will be in touch with the next step before your first billing date.</p>
      <div style="display:flex;gap:10px;flex-wrap:wrap;margin-top:16px;">
        ${res.pdf_ready
          ? `<button class="approve-btn" type="button" onclick="cpOpenPdf('${res.agreement_id}')">View signed agreement (PDF)</button>`
          : '<span class="cp-meta">Your PDF is being prepared and will appear in Service Plans shortly.</span>'}
        <button class="btn-secondary" type="button" onclick="showView('service-plans')">Back to Service Plans</button>
      </div>
    </div>`;
  await loadServicePlans();
}
