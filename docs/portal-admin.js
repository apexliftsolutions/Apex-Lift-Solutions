// Bundle marker. Check this in devtools to confirm which build is live —
// a stale cached bundle is otherwise invisible and looks like a broken feature.
const APEX_ADMIN_CLIENT_VERSION = "2026-09-08.v24.9-hardening";
console.info("[Apex] admin client", APEX_ADMIN_CLIENT_VERSION);

// =============================================
//  APEX LIFT SOLUTIONS — portal-admin.js
//  Admin portal logic. Depends on:
//    - supabase.min.js (CDN)
//    - supabase-js (CDN)
//    - portal-data.js  (Auth, DB, SB helpers)
// =============================================

// ── CONSTANTS ─────────────────────────────────

let _currentUser    = null;
let _allCustomers   = [];
let _pendingFiles   = [];
let lastQuoteStatuses = {};

// ── INIT ──────────────────────────────────────
async function initAdmin() {
  try {
    const session = await Auth.getSession();
    if (!session || session.user.email !== 'admin@apexliftsolutionsusa.com') {
      await Auth.signOut();
      window.location.href = 'portal-login.html';
      return;
    }
    _currentUser = session.user;
    document.getElementById('admin-name').textContent = 'Apex Admin';
    await refreshAll();
    await loadCustomerDropdown();
  } catch (e) {
    console.error('Admin init error:', e);
    window.location.href = 'portal-login.html';
  }
}

document.readyState === 'loading'
  ? document.addEventListener('DOMContentLoaded', initAdmin)
  : initAdmin();

// ── HELPERS ───────────────────────────────────
function badge(s) {
  const map = {
    pending: 'badge-pending', approved: 'badge-approved',
    declined: 'badge-declined', paid: 'badge-paid',
    unpaid: 'badge-unpaid', payment_pending: 'badge-pending',
    partially_refunded: 'badge-pending', refunded: 'badge-declined',
    void: 'badge-hidden', active: 'badge-active', hidden: 'badge-hidden'
  };
  const label = {
    payment_pending: 'payment pending',
    partially_refunded: 'partially refunded',
    refunded: 'refunded',
    void: 'void'
  }[s] || s;
  return `<span class="badge ${map[s] || ''}">${esc(label)}</span>`;
}

function fmtDate(d) {
  return d ? new Date(d).toLocaleDateString('en-US') : '—';
}

function showToast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.style.display = 'block';
  setTimeout(() => t.style.display = 'none', 3500);
}

// ── AUDIT LOG WRITER ──────────────────────────
// Writes directly to activity_log via REST API.
// Does not depend on Edge Functions being deployed.
// Non-fatal — a log failure never blocks the action.
async function logActivity(action, description) {
  try {
    await SB.post('activity_log', {
      actor_email: 'admin@apexliftsolutionsusa.com',
      action,
      description,
      created_at: new Date().toISOString()
    });
  } catch (e) {
    console.warn('Activity log write failed (non-fatal):', e);
  }
}

// ── EMAIL ─────────────────────────────────────
// Email is sent server-side by database triggers → notification_outbox → Resend.
// Creating a quote/invoice or recording a payment enqueues the email automatically.

// ── STATS ─────────────────────────────────────
async function renderStats() {
  const [quotes, invoices, customers] = await Promise.all([
    DB.getAllQuotes(), DB.getAllInvoices(), DB.getAllCustomers()
  ]);
  const pending     = quotes.filter(q => q.status === 'pending').length;
  const unpaid      = invoices.filter(i => i.status === 'unpaid').length;
  const activeCustomers = customers.filter(c => c.status === 'active').length;
  const revenue     = invoices.filter(i => i.status === 'paid')
    .reduce((s, i) => s + parseFloat(i.amount), 0);
  const outstanding = invoices.filter(i => i.status === 'unpaid')
    .reduce((s, i) => s + parseFloat(i.amount), 0);

  const pb = document.getElementById('pending-badge');
  if (pending > 0) { pb.style.display = 'inline'; pb.textContent = pending + ' NEW'; }
  else pb.style.display = 'none';

  document.getElementById('stats-grid').innerHTML = `
    <div class="stat-card"><div class="label">Active Customers</div><div class="value">${activeCustomers}<span style="font-size:.85rem;color:var(--grey);font-weight:400;"> / ${customers.length}</span></div></div>
    <div class="stat-card"><div class="label">Open Quotes</div><div class="value ${pending > 0 ? 'red' : ''}">${pending}</div></div>
    <div class="stat-card"><div class="label">Outstanding</div><div class="value ${outstanding > 0 ? 'red' : ''}">$${outstanding.toFixed(2)}</div></div>
    <div class="stat-card"><div class="label">Unpaid Invoices</div><div class="value ${unpaid > 0 ? 'red' : ''}">${unpaid}</div></div>
    <div class="stat-card"><div class="label">Revenue Collected</div><div class="value">$${revenue.toFixed(2)}</div></div>`;

  const changed = quotes.filter(q => {
    const prev = lastQuoteStatuses[q.id];
    return prev && prev !== q.status && (q.status === 'approved' || q.status === 'declined');
  });
  if (changed.length > 0) {
    const last = changed[0];
    document.getElementById('alert-text').textContent =
      `${last.customer_name} ${last.status === 'approved' ? '✓ APPROVED' : '✗ DECLINED'} quote ${last.id} for $${parseFloat(last.amount).toFixed(2)}`;
    document.getElementById('alert-banner').className = 'alert-banner show';
  }
  quotes.forEach(q => { lastQuoteStatuses[q.id] = q.status; });
}

// ── DASHBOARD QUOTES ──────────────────────────
async function renderDashQuotes() {
  const quotes = await DB.getAllQuotes();
  document.getElementById('dash-quotes-table').innerHTML = quotes.slice(0, 6).map(q => `
    <tr>
      <td><strong style="color:var(--white)">${esc(q.id)}</strong></td>
      <td>${esc(q.customer_name)} — <span style="color:var(--grey);font-size:.8rem;">${esc(q.company || '')}</span></td>
      <td><strong style="color:var(--red)">$${parseFloat(q.amount).toFixed(2)}</strong></td>
      <td>${badge(q.status)}</td>
      <td>${fmtDate(q.created_at)}</td>
      <td>
        ${q.status === 'approved' && !q.invoiced ? `<button class="action-btn green" onclick="convertToInvoice('${q.id}')">→ Invoice</button>` :
          q.invoiced ? `<span style="color:var(--grey);font-size:.75rem;font-family:var(--font-head);">INVOICED</span>` : ''}
        <button class="action-btn" onclick="viewQuoteDetail('${q.id}')">View</button>
        <button class="action-btn" onclick="printQuotePDF('${q.id}')">🖨 PDF</button>
      </td>
    </tr>`).join('');
}

// ── ALL QUOTES ────────────────────────────────
async function renderAllQuotes() {
  document.getElementById('all-quotes-table').innerHTML = '<tr><td colspan="7" style="text-align:center;color:var(--grey);padding:24px;">Loading…</td></tr>';
  let quotes = await DB.getAllQuotes();
  const company = document.getElementById('quotes-company-filter')?.value;
  const status  = document.getElementById('quotes-status-filter')?.value;
  const search   = (document.getElementById('quotes-search')?.value || '').toLowerCase();
  const dateFrom  = document.getElementById('quotes-date-from')?.value;
  const dateTo    = document.getElementById('quotes-date-to')?.value;
  if (company)  quotes = quotes.filter(q => q.company === company);
  if (status)   quotes = quotes.filter(q => q.status === status);
  if (dateFrom) quotes = quotes.filter(q => new Date(q.created_at) >= new Date(dateFrom));
  if (dateTo)   quotes = quotes.filter(q => new Date(q.created_at) <= new Date(dateTo + 'T23:59:59'));
  if (search)   quotes = quotes.filter(q =>
    (q.customer_name || '').toLowerCase().includes(search) ||
    (q.id || '').toLowerCase().includes(search) ||
    (q.customer_email || '').toLowerCase().includes(search));

  document.getElementById('all-quotes-table').innerHTML = !quotes.length
    ? '<tr><td colspan="7" style="text-align:center;color:var(--grey);padding:32px;">No quotes match your filters.</td></tr>'
    : quotes.map(q => `
    <tr>
      <td><strong style="color:var(--white)">${esc(q.id)}</strong></td>
      <td>${esc(q.customer_name)}<br/><span style="color:var(--grey);font-size:.8rem;">${esc(q.customer_email)}</span></td>
      <td style="max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:.85rem;">${esc(q.description || '')}</td>
      <td><strong style="color:var(--red)">$${parseFloat(q.amount).toFixed(2)}</strong></td>
      <td>${badge(q.status)}</td>
      <td>${fmtDate(q.responded_at)}</td>
      <td>
        ${q.status === 'approved' && !q.invoiced ? `<button class="action-btn green" onclick="convertToInvoice('${q.id}')">→ Invoice</button>` :
          q.invoiced ? `<span style="color:var(--grey);font-size:.75rem;font-family:var(--font-head);">INVOICED</span>` : ''}
        <button class="action-btn" onclick="viewQuoteDetail('${q.id}')">View</button>
        <button class="action-btn" onclick="printQuotePDF('${q.id}')">🖨 PDF</button>
        <button class="action-btn danger" onclick="deleteQuote('${q.id}')">Delete</button>
      </td>
    </tr>`).join('');
}

// ── INVOICES ──────────────────────────────────
async function renderInvoices() {
  document.getElementById('invoices-table').innerHTML = '<tr><td colspan="7" style="text-align:center;color:var(--grey);padding:24px;">Loading…</td></tr>';
  let invoices = await DB.getAllInvoices();
  const company = document.getElementById('invoices-company-filter')?.value;
  const status  = document.getElementById('invoices-status-filter')?.value;
  const search   = (document.getElementById('invoices-search')?.value || '').toLowerCase();
  const dateFrom  = document.getElementById('invoices-date-from')?.value;
  const dateTo    = document.getElementById('invoices-date-to')?.value;

  if (status === 'hidden') {
    invoices = invoices.filter(i => i.status === 'hidden');
  } else {
    if (company) invoices = invoices.filter(i => i.company === company);
    if (status)  invoices = invoices.filter(i => i.status === status);
    else         invoices = invoices.filter(i => i.status !== 'hidden');
    if (dateFrom) invoices = invoices.filter(i => new Date(i.created_at) >= new Date(dateFrom));
    if (dateTo)   invoices = invoices.filter(i => new Date(i.created_at) <= new Date(dateTo + 'T23:59:59'));
    if (search)  invoices = invoices.filter(i =>
      (i.customer_name || '').toLowerCase().includes(search) ||
      (i.id || '').toLowerCase().includes(search) ||
      (i.company || '').toLowerCase().includes(search));
  }

  // Load payment state once for the visible invoice list. Besides protecting
  // against duplicate offline entries, this drives the Refund / Void action.
  const _live = {};
  const _paymentSummary = {};
  try {
    const invoiceIds = invoices.map(i => i.id);
    let rows = [];
    if (invoiceIds.length) {
      const { data, error } = await _sb.from('payments')
        .select('id,invoice_id,status,kind,provider,method,amount_cents,refund_of,provider_transaction_id,created_at')
        .in('invoice_id', invoiceIds)
        .order('created_at', { ascending: true });
      if (error) throw error;
      rows = data || [];
    }

    const rank = { succeeded: 4, pending: 3, unknown: 2, initiated: 1 };
    rows.filter(p => p.provider === 'helcim' && p.kind === 'payment' &&
      ['initiated','pending','unknown','succeeded'].includes(p.status))
      .forEach(p => {
        const cur = _live[p.invoice_id];
        if (!cur || rank[p.status] > rank[cur.status]) _live[p.invoice_id] = p;
      });

    const byInvoice = {};
    rows.forEach(p => { (byInvoice[p.invoice_id] ||= []).push(p); });
    Object.entries(byInvoice).forEach(([invoiceId, prs]) => {
      const originals = prs.filter(p => p.kind === 'payment' && p.provider === 'helcim' &&
        p.status === 'succeeded' && p.provider_transaction_id);
      const original = originals.length ? originals[originals.length - 1] : null;
      if (!original) return;

      const corrections = prs.filter(p => p.refund_of === original.id &&
        (p.kind === 'refund' || p.kind === 'reversal'));
      const returnedCents = corrections
        .filter(p => p.status === 'succeeded')
        .reduce((sum, p) => sum + Number(p.amount_cents || 0), 0);
      const remainingCents = Math.max(0, Number(original.amount_cents || 0) - returnedCents);
      const correctionPending = corrections.some(p => ['initiated','pending','unknown'].includes(p.status));

      _paymentSummary[invoiceId] = {
        original,
        corrections,
        returnedCents,
        remainingCents,
        correctionPending
      };
    });
  } catch (e) {
    console.warn('[Apex] could not load payment/refund state', e);
  }

  document.getElementById('invoices-table').innerHTML = !invoices.length
    ? '<tr><td colspan="7" style="text-align:center;color:var(--grey);padding:32px;">No invoices match your filters.</td></tr>'
    : invoices.map(i => `
    <tr>
      <td><strong style="color:var(--white)">${esc(i.id)}</strong></td>
      <td>${esc(i.customer_name || '')}<br/><span style="color:var(--grey);font-size:.8rem;">${esc(i.company || '')}</span></td>
      <td>${!i.customer_id ? '<div style="color:#f0a500;font-size:.68rem;font-family:var(--font-head);font-weight:700;letter-spacing:.06em;">⚠ NO PORTAL LINK — customer cannot see or pay this</div>' : ''}<strong style="color:var(--red)">$${parseFloat(i.amount).toFixed(2)}</strong>${i.tax_exempt ? '<br><span style="font-size:.68rem;color:var(--grey);">TAX EXEMPT</span>' : (Number(i.tax_cents) > 0 ? `<br><span style="font-size:.68rem;color:var(--grey);">incl. $${(i.tax_cents/100).toFixed(2)} tax</span>` : '')}</td>
      <td>${badge(i.status)}</td>
      <td>${fmtDate(i.due)}</td>
      <td>${fmtDate(i.paid_at)}</td>
      <td>
        ${(i.status === 'unpaid' || i.status === 'payment_pending') ? `${payActionHtml(i, _live[i.id], _paymentSummary[i.id])}` : ''}
        ${refundActionHtml(i, _paymentSummary[i.id])}
        <button class="action-btn" onclick="printInvoicePDF('${i.id}')">🖨 PDF</button>
        ${i.status !== 'hidden' ? `<button class="action-btn" onclick="hideInvoice('${i.id}')">Hide</button>`
          : `<button class="action-btn green" onclick="unhideInvoice('${i.id}')">Unhide</button>`}
        <button class="action-btn danger" onclick="deleteInvoice('${i.id}')">Delete</button>
      </td>
    </tr>`).join('');
}

// ── CUSTOMERS ─────────────────────────────────
async function renderCustomers() {
  document.getElementById('customers-table').innerHTML = '<tr><td colspan="7" style="text-align:center;color:var(--grey);padding:24px;">Loading…</td></tr>';
  const customers = await DB.getAllCustomers();
  const search = (document.getElementById('customers-search')?.value || '').toLowerCase();
  const status = document.getElementById('customers-status-filter')?.value;
  let list = customers;
  if (search) list = list.filter(c =>
    (c.name || '').toLowerCase().includes(search) ||
    (c.email || '').toLowerCase().includes(search) ||
    (c.company || '').toLowerCase().includes(search));
  if (status) list = list.filter(c => c.status === status);

  document.getElementById('customers-table').innerHTML = !list.length
    ? '<tr><td colspan="7" style="text-align:center;color:var(--grey);padding:32px;">No customers match your filters.</td></tr>'
    : list.map(c => `
    <tr>
      <td><strong style="color:var(--white)">${esc(c.name || '—')}</strong></td>
      <td>${esc(c.company || '—')}</td>
      <td>${esc(c.email)}</td>
      <td>${esc(c.phone || '—')}</td>
      <td>${badge(c.status)}</td>
      <td>${esc(c.since || '—')}</td>
      <td>
        ${c.status !== 'active' ? `<button class="action-btn green" onclick="activateCustomer('${esc(String(c.id))}','${esc(c.email)}','${esc(c.name || '')}')">✓ Activate</button>` : ''}
        ${c.status === 'active' ? `<button class="action-btn" onclick="setCustomerStatus('${esc(String(c.id))}','inactive','${esc(c.name||'')}','${esc(c.company||'')}')" >Deactivate</button>` : ''}
        ${c.status === 'pending' ? `<button class="action-btn danger" onclick="setCustomerStatus('${esc(String(c.id))}','inactive','${esc(c.name||'')}','${esc(c.company||'')}')" >Reject</button>` : ''}
        <button class="action-btn danger" onclick="deleteCustomer('${esc(String(c.id))}','${esc(c.name || c.email)}')">Delete</button>
      </td>
    </tr>`).join('');
}

// ── CUSTOMER ACTIONS ──────────────────────────
async function activateCustomer(id, email, name) {
  await DB.updateCustomerStatus(id, 'active');
  await logActivity('activate_customer', `Customer ${name || email} activated`);
  showToast('✓ Customer activated and notified by email!');
  await renderCustomers();
  await loadCustomerDropdown();
}

async function setCustomerStatus(id, status, name, company) {
  await DB.updateCustomerStatus(id, status);
  const label = (name || id) + (company ? ` — ${company}` : '');
  const action = status === 'active' ? 'activate_customer' : 'deactivate_customer';
  const verb   = status === 'active' ? 'activated' : (status === 'inactive' ? 'deactivated' : status);
  await logActivity(action, `Customer ${label} ${verb}`);
  showToast(`✓ Customer ${status}!`);
  await renderCustomers();
  await loadCustomerDropdown();
}

async function deleteCustomer(id, name) {
  if (!confirm(`Permanently delete "${name}"? This cannot be undone.`)) return;
  const ok = await DB.deleteCustomer(id);
  if (ok) {
    await logActivity('delete_customer', `Customer "${name}" permanently deleted`);
    showToast('✓ Customer deleted.'); await renderCustomers(); await loadCustomerDropdown();
  } else alert('Delete failed — customer may have associated records.');
}


// What the admin may do about payment on this invoice.
// The manual form is for money that arrived OUTSIDE the portal only. If Helcim
// already has a live attempt, offering "record payment" invites a duplicate
// record for the same money.
function payActionHtml(inv, live, summary) {
  if (inv.status === 'paid') {
    const how = inv.paid_via === 'helcim' ? 'Online' : 'Offline';
    return `<span class="badge badge-paid">Paid</span>
            <div style="font-size:.66rem;color:var(--grey);margin-top:3px;">${esc(how)}</div>`;
  }
  if (inv.status === 'payment_pending' || (live && live.status === 'pending')) {
    return `<span class="badge badge-pending">Payment Pending</span>
            <div style="font-size:.66rem;color:var(--grey);margin-top:3px;">Bank payment clearing</div>`;
  }

  const successfulReversal = summary?.corrections?.some(p => p.kind === 'reversal' && p.status === 'succeeded');
  if (inv.status === 'unpaid' && successfulReversal && summary.remainingCents <= 0) {
    // The original Helcim payment was authoritatively reversed. It no longer
    // blocks this invoice from being paid again or recorded offline.
    return `<span class="badge badge-declined">Previous payment reversed</span>
            <div style="font-size:.66rem;color:#f0a500;margin-top:3px;">Invoice is unpaid again</div>
            <button class="action-btn green" style="margin-top:5px;" onclick="markPaid('${esc(inv.id)}')">Record Offline Payment</button>`;
  }

  if (live && live.status === 'succeeded') {
    // Payment recorded but the invoice has not caught up — a finalization bug,
    // not something to paper over with a manual entry.
    return `<span class="badge badge-pending">Confirming</span>
            <div style="font-size:.66rem;color:#f0a500;margin-top:3px;">Payment recorded — invoice not finalized</div>`;
  }
  if (live && (live.status === 'initiated' || live.status === 'unknown')) {
    return `<span class="badge badge-pending">Online payment being confirmed</span>
            <button class="action-btn" style="margin-top:5px;font-size:.66rem;" onclick="reviewOnlinePayment('${esc(inv.id)}')">Review</button>`;
  }
  return `<button class="action-btn green" onclick="markPaid('${esc(inv.id)}')">Record Offline Payment</button>`;
}

function refundActionHtml(inv, summary) {
  if (!summary?.original) return '';

  if (summary.correctionPending) {
    return `<span class="badge badge-pending">Refund / reversal pending</span>`;
  }

  const successfulReversal = summary.corrections?.some(p => p.kind === 'reversal' && p.status === 'succeeded');
  const successfulRefund   = summary.corrections?.some(p => p.kind === 'refund' && p.status === 'succeeded');

  if (summary.remainingCents <= 0) {
    if (successfulReversal) return `<span class="badge badge-declined">Payment voided / reversed</span>`;
    if (successfulRefund)   return `<span class="badge badge-declined">Fully refunded</span>`;
    return `<span class="badge badge-declined">Fully returned</span>`;
  }

  if (!['paid', 'partially_refunded'].includes(inv.status)) return '';

  const label = summary.remainingCents === Number(summary.original.amount_cents)
    ? '↩ Refund / Void'
    : '↩ Refund Remaining';

  return `<button class="action-btn danger"
            title="Full card cancellations are voided when the batch is still open; otherwise Helcim processes a refund."
            onclick="refundPayment('${esc(summary.original.id)}','${esc(inv.id)}',${summary.remainingCents})">${label}</button>`;
}

// Shows the admin what the processor actually has, and offers the verified
// reconcile path — never a manual duplicate.
async function reviewOnlinePayment(invoiceId) {
  const { data: rows } = await _sb.from('payments').select('*')
    .eq('invoice_id', invoiceId).order('created_at', { ascending: false });
  const p = (rows || [])[0];
  if (!p) { alert('No payment attempt found for ' + invoiceId); return; }
  const msg =
    `Invoice ${invoiceId}\n\n` +
    `Attempt status : ${p.status}\n` +
    `Method         : ${p.method || '(not yet known)'}\n` +
    `Amount         : $${(p.amount_cents/100).toFixed(2)}\n` +
    `Transaction id : ${p.provider_transaction_id || '(none recorded)'}\n` +
    `Started        : ${new Date(p.initiated_at || p.created_at).toLocaleString()}\n\n` +
    `A customer began paying this invoice online. Do NOT record an offline\n` +
    `payment for it — that would create a second record for the same money.\n\n` +
    `If Helcim shows this as APPROVED, paste its Transaction ID to reconcile.\n` +
    `Leave blank to cancel.`;
  const txn = prompt(msg, p.provider_transaction_id || '');
  if (!txn) return;
  const { data: { session } } = await _sb.auth.getSession();
  const r = await fetch(`${SUPABASE_URL}/functions/v1/admin-action`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${session.access_token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'reconcile-payment', paymentId: p.id, helcimTransactionId: txn.trim() }),
  });
  const out = await r.json();
  if (!r.ok) { console.error('[Apex] reconcile-payment failed', out); alert(out.error || 'Could not reconcile.'); return; }
  showToast(`✓ ${invoiceId} reconciled — invoice is now ${out.invoice_status}`);
  renderInvoices();
}

// ── INVOICE ACTIONS ───────────────────────────
// "Record Manual Payment" — for money received outside the portal (check, cash,
// wire, terminal). Writes a payments ledger row via admin-action; the invoice
// status is then DERIVED from the ledger. Online card/ACH never touch this.
let _manualInvoice = null;
async function markPaid(id) {
  const invs = await DB.getAllInvoices();
  _manualInvoice = invs.find(i => i.id === id);
  if (!_manualInvoice) return;
  // Last line of defence: block a manual record while a Helcim attempt is live
  // or while net online money is still retained. A fully reversed payment no
  // longer blocks the invoice — that is the whole purpose of the reversal row.
  const { data: existing, error: existingErr } = await _sb.from('payments')
    .select('id,status,kind,amount_cents,refund_of,provider')
    .eq('invoice_id', id).eq('provider', 'helcim');
  if (existingErr) {
    console.error('[Apex] could not verify online payment state before manual payment', existingErr);
    alert('Could not verify the online payment state. Please try again.');
    return;
  }
  const rows = existing || [];
  const inFlight = rows.find(p => p.kind === 'payment' && ['initiated','pending','unknown'].includes(p.status));
  if (inFlight) {
    alert(`Invoice ${id} already has an online payment attempt (status: ${inFlight.status}).\n\n` +
          `Recording an offline payment could create duplicate accounting.\n\n` +
          `Use Review instead to reconcile it against Helcim.`);
    return;
  }
  const paidCents = rows.filter(p => p.kind === 'payment' && p.status === 'succeeded')
    .reduce((sum,p) => sum + Number(p.amount_cents || 0), 0);
  const returnedCents = rows.filter(p => ['refund','reversal'].includes(p.kind) && p.status === 'succeeded')
    .reduce((sum,p) => sum + Number(p.amount_cents || 0), 0);
  if (paidCents - returnedCents > 0) {
    alert(`Invoice ${id} still has $${((paidCents-returnedCents)/100).toFixed(2)} of successful online payment applied.\n\n` +
          `Do not record another payment unless that money is first refunded/reversed.`);
    return;
  }
  document.getElementById('mp-inv-id').textContent  = id;
  document.getElementById('mp-inv-amt').textContent = '$' + parseFloat(_manualInvoice.amount).toFixed(2);
  document.getElementById('mp-amount').value = parseFloat(_manualInvoice.amount).toFixed(2);
  document.getElementById('mp-method').value = '';
  document.getElementById('mp-ref').value = '';
  document.getElementById('mp-notes').value = '';
  document.getElementById('mp-err').style.display = 'none';
  document.getElementById('manual-pay-modal').className = 'modal-overlay open';
}
function closeManualPay() { document.getElementById('manual-pay-modal').className = 'modal-overlay'; _manualInvoice = null; }

let _mpBusy = false;
async function submitManualPayment() {
  const inv = _manualInvoice; if (!inv || _mpBusy) return;
  const method    = document.getElementById('mp-method').value;
  const amount    = parseFloat(document.getElementById('mp-amount').value);
  const reference = document.getElementById('mp-ref').value.trim();
  const notes     = document.getElementById('mp-notes').value.trim();
  const err = document.getElementById('mp-err'); err.style.display = 'none';
  if (!method)      { err.textContent = 'Select how the payment was received.'; err.style.display = 'block'; return; }
  if (!(amount > 0)) { err.textContent = 'Enter the amount received.'; err.style.display = 'block'; return; }

  _mpBusy = true;
  const btn = document.getElementById('mp-submit'); btn.disabled = true; btn.textContent = 'Recording…';
  try {
    const { data: { session } } = await _sb.auth.getSession();
    const r = await fetch(`${SUPABASE_URL}/functions/v1/admin-action`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${session.access_token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'record-manual-payment', invoiceId: inv.id, method, amount, reference, notes }),
    });
    const out = await r.json();
    if (!r.ok) { err.textContent = out.error || 'Could not record payment.'; err.style.display = 'block'; return; }
    closeManualPay();
    showToast(`✓ ${inv.id} recorded as paid by ${method.replace('_',' ')} — receipt email queued`);
    renderInvoices();
  } catch (e) {
    err.textContent = 'Connection error. Please try again.'; err.style.display = 'block';
  } finally { _mpBusy = false; btn.disabled = false; btn.textContent = 'Record Payment'; }
}

// Admin refund / void — uses the privileged server path. Customers cannot
// reach this. For a FULL card cancellation the server first tries Helcim's
// reverse/void endpoint; if the batch is already closed it falls back to a
// refund. Partial amounts go straight to refund.
async function refundPayment(paymentId, invoiceId, maxAmount) {
  const suggested = (maxAmount / 100).toFixed(2);
  const amtRaw = prompt(
    `Refund / void amount for ${invoiceId} (max $${suggested}):\n\n` +
    `A full card amount will be VOIDED if the Helcim batch is still open; ` +
    `otherwise it will be REFUNDED. Partial amounts are refunds.`,
    suggested
  );
  if (amtRaw == null) return;

  const amount = Number(amtRaw);
  const cents = Math.round(amount * 100);
  if (!Number.isFinite(amount) || amount <= 0 || cents > Number(maxAmount)) {
    alert(`Enter an amount greater than $0.00 and no more than $${suggested}.`);
    return;
  }

  const reasonRaw = prompt('Reason for the refund or void (required — this is shown in the audit trail/email):', '');
  if (reasonRaw == null) return;
  const reason = reasonRaw.trim();
  if (!reason) {
    alert('Enter a reason before issuing the refund or void.');
    return;
  }
  if (!confirm(
    `Return $${amount.toFixed(2)} on ${invoiceId}?\n\n` +
    `This calls Helcim first and only updates Apex accounting after the provider confirms it.`
  )) return;

  const { data: { session } } = await _sb.auth.getSession();
  if (!session) { alert('Your admin session expired. Please sign in again.'); return; }

  const r = await fetch(`${SUPABASE_URL}/functions/v1/payment-refund`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${session.access_token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ payment_id: paymentId, amount, reason }),
  });
  const out = await r.json().catch(() => ({}));

  if (!r.ok) {
    console.error('[Apex] payment-refund failed', out);
    alert(`Refund / void failed: ${out.message || out.error || 'unknown provider error'}`);
    return;
  }

  const verb = out.action === 'reverse' ? 'Payment voided' : 'Refund issued';
  showToast(`✓ ${verb} on ${invoiceId} — $${(Number(out.amount_cents || cents)/100).toFixed(2)}`);
  await renderInvoices();
}


async function hideInvoice(id) {
  await SB.patch('invoices', `id=eq.${encodeURIComponent(id)}`, { status: 'hidden' });
  await logActivity('hide_invoice', `Invoice ${id} hidden from customer view`);
  showToast('Invoice hidden (use "Hidden" filter to view it).');
  renderInvoices();
}

async function unhideInvoice(id) {
  await SB.patch('invoices', `id=eq.${encodeURIComponent(id)}`, { status: 'unpaid' });
  showToast('Invoice restored to unpaid.');
  renderInvoices();
}

// Routed through admin-action so the server decides delete vs void. The old
// version called SB.delete() directly, ignored the result, and showed a success
// toast either way -- so an invoice with payment history silently stayed put
// (payments.invoice_id is ON DELETE RESTRICT).
async function deleteInvoice(id) {
  if (!confirm(`Delete invoice ${id}?\n\nIf it has any payment history it will be VOIDED instead, so the accounting record is preserved.`)) return;
  try {
    const res = await DB.deleteInvoice(id);
    if (res?.error) {
      console.error('[Apex] delete-invoice failed', res);
      alert(res.error);
      return;
    }
    showToast(res?.action === 'voided' ? `✓ ${id} voided — payment history preserved` : `✓ ${id} deleted`);
    if (res?.action === 'voided' && res.message) alert(res.message);
  } catch (e) {
    console.error('[Apex] delete-invoice threw', e);
    alert(`Could not delete invoice ${id}: ${e.message || e}`);
    return;
  }
  renderInvoices();
}

// ── QUOTE ACTIONS ─────────────────────────────
async function convertToInvoice(quoteId) {
  if (!confirm(`Convert quote ${quoteId} to an invoice?`)) return;
  const inv = await DB.quoteToInvoice(quoteId);
  if (inv) {
    await DB.updateQuoteField(quoteId, { invoiced: true });
    const invLines = inv.items && inv.items.length
      ? '\n\nWork Summary:\n' + inv.items.map(i => {
          const qty  = parseFloat(i.qty) || 1;
          const unit = parseFloat(i.unit_price || i.amount || 0);
          return `  • ${i.desc || 'Service'} x${qty} @ $${unit.toFixed(2)} = $${(qty * unit).toFixed(2)}`;
        }).join('\n')
      : '';
    await logActivity('create_invoice', `Invoice ${inv.id} created from quote ${quoteId} — $${parseFloat(inv.amount).toFixed(2)} — ${inv.customer_name || inv.customer_email}`);
    showToast(`✓ Invoice ${inv.id} created — customer notified!`);
    await refreshAll();
    showView('invoices');
  }
}

async function deleteQuote(id) {
  if (!confirm(`Delete quote ${id}?`)) return;
  await DB.deleteQuote(id);
  await logActivity('delete_quote', `Quote ${id} permanently deleted`);
  showToast('✓ Quote deleted.');
  renderAllQuotes();
}

async function viewQuoteDetail(id) {
  const quotes = await DB.getAllQuotes();
  const q = quotes.find(x => x.id === id);
  if (!q) return;
  const items = q.items ? q.items.map(i =>
    `  • ${i.desc} x${i.qty || 1} (${i.type}): $${parseFloat(i.unit_price || i.amount || 0).toFixed(2)} ea = $${(parseFloat(i.unit_price || i.amount || 0) * (i.qty || 1)).toFixed(2)}`
  ).join('\n') : '';
  alert(`QUOTE ${q.id}\n${'─'.repeat(40)}\nCustomer: ${q.customer_name} — ${q.company || ''}\nEquipment: ${q.equipment || 'N/A'}\nStatus: ${q.status.toUpperCase()}${q.responded_at ? ' on ' + fmtDate(q.responded_at) : ''}\n\nDescription:\n${q.description || ''}\n\nLine Items:\n${items}\n${'─'.repeat(40)}\nSubtotal: $${((q.subtotal_cents ?? Math.round(q.amount*100))/100).toFixed(2)}\n${q.tax_exempt ? 'Sales Tax: $0.00 (EXEMPT)' : `Sales Tax (${((q.tax_rate_milli_pct||0)/1000).toFixed(3)}%): $${((q.tax_cents||0)/100).toFixed(2)}`}\nTOTAL: $${parseFloat(q.amount).toFixed(2)}`);
}

// ── FILE HANDLING ─────────────────────────────
function handleFileSelect(input) {
  _pendingFiles = Array.from(input.files);
  const list = document.getElementById('uploaded-files-list');
  list.innerHTML = _pendingFiles.map((f, i) => `
    <div class="file-chip">
      📎 ${esc(f.name)}
      <button onclick="removeFile(${i})" title="Remove">×</button>
    </div>`).join('');
}

function removeFile(idx) {
  _pendingFiles.splice(idx, 1);
  handleFileSelect({ files: _pendingFiles });
}

async function uploadFiles(quoteId) {
  if (!_pendingFiles.length) return [];
  const urls = [];
  for (const file of _pendingFiles) {
    const safeName = file.name.replace(/\s+/g, '_').replace(/[^a-zA-Z0-9._-]/g, '');
    const path = `quotes/${quoteId}/${Date.now()}_${safeName}`;
    const { data, error } = await _sb.storage.from('apex-uploads').upload(path, file, { upsert: true, contentType: file.type });
    if (error) {
      console.error('Upload failed:', error.message);
    } else {
      urls.push(path);   // private bucket: store the PATH, mint signed URLs on read
    }
  }
  return urls;
}

// ── CUSTOMER DROPDOWN ─────────────────────────
async function loadCustomerDropdown() {
  _allCustomers = await DB.getAllCustomers();
  const sel = document.getElementById('q-customer-select');
  if (sel) {
    const active = _allCustomers.filter(x => x.status === 'active');
    sel.innerHTML = active.length === 0
      ? '<option value="">— No active customers yet —</option>'
      : '<option value="">— Select a customer —</option>' +
        active.map(x => `<option value="${esc(x.email)}" data-name="${esc(x.name || '')}" data-company="${esc(x.company || '')}" data-id="${esc(String(x.id || ''))}">${esc(x.name || '')}${x.company ? ' — ' + esc(x.company) : ''} &lt;${esc(x.email)}&gt;</option>`).join('');
    document.getElementById('q-email').value   = '';
    document.getElementById('q-company').value = '';
  }
  const companies = [...new Set(_allCustomers.map(x => x.company).filter(Boolean))].sort();
  const opts = '<option value="">All Companies</option>' +
    companies.map(co => `<option value="${esc(co)}">${esc(co)}</option>`).join('');
  ['quotes-company-filter', 'invoices-company-filter'].forEach(id => {
    const el = document.getElementById(id);
    if (el) { const v = el.value; el.innerHTML = opts; el.value = v; }
  });
}

function selectCustomer() {
  const sel = document.getElementById('q-customer-select');
  const opt = sel.options[sel.selectedIndex];
  document.getElementById('q-email').value   = opt.value || '';
  document.getElementById('q-company').value = opt.dataset.company || '';
}

// ── LINE ITEMS ────────────────────────────────
function lineItemHTML() {
  const style = 'background:var(--black);border:1px solid var(--border);color:var(--white);font-family:var(--font-body);font-size:.95rem;padding:10px 12px;outline:none;border-radius:0;width:100%;';
  return `
    <div class="line-item">
      <input type="text" placeholder="Description" class="item-desc" style="${style}"/>
      <input type="number" placeholder="1" class="item-qty" min="1" step="1" value="1" style="${style}" oninput="updateTotal()"/>
      <select class="item-type" style="${style}"><option>Parts</option><option>Labor</option><option>Travel</option><option>Other</option></select>
      <input type="number" placeholder="0.00" class="item-unit" step="0.01" oninput="updateTotal()" style="${style}"/>
      <button class="remove-line" onclick="removeLine(this)">×</button>
    </div>`;
}

function addLine() {
  document.getElementById('line-items-container').insertAdjacentHTML('beforeend', lineItemHTML());
}

function removeLine(btn) {
  btn.closest('.line-item').remove();
  updateTotal();
}

// ── TAX ───────────────────────────────────────
// New York taxes repair and maintenance of tangible personal property
// (Tax Law 1105(c)(3)), so parts, labor and travel on a forklift job are all
// normally taxable. Rate defaults to 8.625% (Nassau/Suffolk) and is editable
// per quote. All money math is done in integer cents.
const DEFAULT_TAX_MILLI_PCT = 8625;   // 8.625%

function subtotalCents() {
  return [...document.querySelectorAll('.line-item')].reduce((s, row) => {
    const qty  = parseFloat(row.querySelector('.item-qty')?.value) || 1;
    const unit = parseFloat(row.querySelector('.item-unit')?.value) || 0;
    return s + Math.round(qty * unit * 100);
  }, 0);
}

function taxMilliPct() {
  const el = document.getElementById('q-tax-rate');
  const pct = el ? parseFloat(el.value) : NaN;
  return Number.isFinite(pct) && pct >= 0 ? Math.round(pct * 1000) : DEFAULT_TAX_MILLI_PCT;
}

function isExempt() {
  const el = document.getElementById('q-tax-exempt');
  return !!(el && el.checked);
}

// subtotal * rate, rounded once at the end. Never float-multiply dollars.
function computeTotals() {
  const sub    = subtotalCents();
  const milli  = taxMilliPct();
  const exempt = isExempt();
  const tax    = exempt ? 0 : Math.round((sub * milli) / 100000);
  return { sub, tax, total: sub + tax, milli, exempt };
}

function toggleExempt() {
  const exempt = isExempt();
  const rate = document.getElementById('q-tax-rate');
  const cert = document.getElementById('q-exempt-cert');
  if (rate) rate.disabled = exempt;
  if (cert) cert.disabled = !exempt;
  updateTotal();
}

function updateTotal() {
  const { sub, tax, total, milli, exempt } = computeTotals();
  const set = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
  set('quote-subtotal-display', '$' + (sub / 100).toFixed(2));
  set('quote-tax-display',      '$' + (tax / 100).toFixed(2));
  set('quote-total-display',    '$' + (total / 100).toFixed(2));
  // Always show the tax line, even at $0.00 -- an invoice that silently omits
  // it is ambiguous to the customer and on audit.
  set('quote-tax-label', exempt ? 'Sales Tax (exempt)' : `Sales Tax (${(milli / 1000).toFixed(3)}%)`);
}

function resetLineItems() {
  document.getElementById('line-items-container').innerHTML = lineItemHTML();
  const ex = document.getElementById('q-tax-exempt'); if (ex) ex.checked = false;
  const rt = document.getElementById('q-tax-rate');   if (rt) { rt.value = (DEFAULT_TAX_MILLI_PCT/1000).toFixed(3); rt.disabled = false; }
  const ct = document.getElementById('q-exempt-cert');if (ct) { ct.value = ''; ct.disabled = true; }
  updateTotal();
}

// ── SAVE QUOTE ────────────────────────────────
async function saveQuote() {
  const sel = document.getElementById('q-customer-select');
  if (!sel || !sel.value) { alert('Please select a customer.'); return; }
  const email   = document.getElementById('q-email').value.trim();
  const company = document.getElementById('q-company').value.trim();
  const opt     = sel.options[sel.selectedIndex];
  const name    = opt.dataset.name || '';
  const custId  = opt.dataset.id || null;
  if (!email) { alert('Customer email missing. Re-select the customer.'); return; }
  // customer_id is the ONLY ownership link the customer portal and RLS use.
  // Without it the quote and any invoice made from it are invisible to the
  // customer and unpayable, while still showing up here in admin.
  if (!custId) {
    alert('This customer has no portal account linked, so they would never see the quote or be able to pay it.\n\nActivate their portal account first, then re-select them.');
    return;
  }

  const items = [...document.querySelectorAll('.line-item')].map(row => ({
    desc:       row.querySelector('.item-desc').value || 'Service',
    qty:        parseFloat(row.querySelector('.item-qty')?.value) || 1,
    type:       row.querySelector('.item-type').value,
    unit_price: parseFloat(row.querySelector('.item-unit')?.value) || 0,
    amount:     (parseFloat(row.querySelector('.item-qty')?.value) || 1) * (parseFloat(row.querySelector('.item-unit')?.value) || 0)
  })).filter(i => i.amount > 0);

  const { sub, tax, total, milli, exempt } = computeTotals();
  if (sub === 0) { alert('Add at least one line item with an amount.'); return; }
  if (exempt && !document.getElementById('q-exempt-cert').value.trim() &&
      !confirm('No exemption certificate number entered. New York requires a valid certificate on file to defend an exempt sale. Continue anyway?')) return;

  const newQuote = {
    customer_id:    custId,
    customer_email: email,
    customer_name:  name,
    company,
    equipment:   document.getElementById('q-equipment').value.trim(),
    description: document.getElementById('q-desc').value.trim() || 'Forklift Service',
    items,
    subtotal_cents:     sub,
    tax_cents:          tax,
    tax_rate_milli_pct: exempt ? 0 : milli,
    tax_exempt:         exempt,
    tax_jurisdiction:   document.getElementById('q-tax-juris').value.trim() || null,
    amount:             total / 100,          // GRAND TOTAL, tax-inclusive
    status: 'pending'
  };

  const saved = await DB.addQuote(newQuote);
  if (!saved) { alert('Error saving quote. Please try again.'); return; }

  if (_pendingFiles.length) {
    const urls = await uploadFiles(saved.id);
    if (urls.length) await DB.updateQuoteField(saved.id, { attachments: urls });
  }

  const attLinks = (_pendingFiles.length && saved.attachments?.length)
    ? `\n\n${saved.attachments.length} photo${saved.attachments.length>1?'s':''} attached — view them in your client portal.`
    : '';

  await logActivity('create_quote', `Quote ${saved.id} created for ${name} (${company || '—'}) — $${total.toFixed(2)}`);
  showToast(`✓ Quote sent to ${name} — email notification sent!`);

  // Reset form
  sel.value = '';
  document.getElementById('q-email').value     = '';
  document.getElementById('q-company').value   = '';
  document.getElementById('q-equipment').value = '';
  document.getElementById('q-desc').value      = '';
  _pendingFiles = [];
  document.getElementById('uploaded-files-list').innerHTML = '';
  resetLineItems();
  await refreshAll();
  showView('quotes');
}

// ── NAVIGATION ────────────────────────────────
// Event delegation on sidebar nav — no inline onclick needed.
// Nav items use data-view="quotes" instead of onclick="showView(..."
document.addEventListener('DOMContentLoaded', () => {
  const sidebarNav = document.querySelector('.sidebar-nav');
  if (sidebarNav) {
    sidebarNav.addEventListener('click', e => {
      const item = e.target.closest('[data-view]');
      if (!item) return;
      e.preventDefault();
      showView(item.dataset.view, item);
    });
  }
  // Sidebar overlay close (overlay has no onclick in HTML so this is needed)
  document.getElementById('sidebar-overlay')?.addEventListener('click', closeMobileSidebar);
  // NOTE: mobile-menu-btn uses onclick="toggleMobileSidebar()" in HTML — no addEventListener needed
  // NOTE: logout-btn uses onclick="logout()" in HTML — no addEventListener needed
});

function showView(v, el) {
  document.querySelectorAll('.view').forEach(x => x.classList.remove('active'));
  document.querySelectorAll('.nav-item').forEach(x => x.classList.remove('active'));
  const viewEl = document.getElementById('view-' + v);
  if (viewEl) viewEl.classList.add('active');
  if (el) {
    el.classList.add('active');
  } else {
    document.querySelectorAll(`[data-view="${v}"]`).forEach(n => n.classList.add('active'));
  }
  const actions = {
    subscriptions: renderSubscriptions,
    'service-plans': renderServicePlans,
    quotes:    renderAllQuotes,
    invoices:  renderInvoices,
    customers: renderCustomers,
    requests:  renderRequests,
    history:   renderHistory,
    activity:  renderActivityLog,
    dashboard: () => { renderStats(); renderDashQuotes(); }
  };
  actions[v]?.();
  closeMobileSidebar();
}

function toggleMobileSidebar() {
  const sidebar  = document.getElementById('admin-sidebar-el');
  const overlay  = document.getElementById('sidebar-overlay');
  const btn      = document.getElementById('mobile-menu-btn');
  const isOpen   = sidebar.classList.contains('mobile-open');
  sidebar.classList.toggle('mobile-open', !isOpen);
  overlay.classList.toggle('open', !isOpen);
  btn.classList.toggle('open', !isOpen);
}

function closeMobileSidebar() {
  document.getElementById('admin-sidebar-el')?.classList.remove('mobile-open');
  document.getElementById('sidebar-overlay')?.classList.remove('open');
  document.getElementById('mobile-menu-btn')?.classList.remove('open');
}

async function refreshAll() {
  await renderStats();
  await renderDashQuotes();
  const views = ['quotes', 'invoices', 'customers', 'requests', 'history'];
  for (const v of views) {
    if (document.getElementById('view-' + v)?.classList.contains('active')) {
      await { quotes: renderAllQuotes, invoices: renderInvoices, customers: renderCustomers, requests: renderRequests, history: renderHistory }[v]();
    }
  }
}

// ── SETTINGS: PASSWORD CHANGE ─────────────────
async function changeAdminPassword() {
  const pass  = document.getElementById('admin-new-pass').value;
  const pass2 = document.getElementById('admin-new-pass2').value;
  const err   = document.getElementById('pw-err');
  const suc   = document.getElementById('pw-suc');
  err.style.display = 'none';
  suc.style.display = 'none';
  if (pass.length < 8) { err.textContent = 'Password must be at least 8 characters.'; err.style.display = 'block'; return; }
  if (pass !== pass2)  { err.textContent = 'Passwords do not match.'; err.style.display = 'block'; return; }
  const result = await Auth.updatePassword(pass);
  if (result.error) { err.textContent = 'Error: ' + result.error; err.style.display = 'block'; }
  else {
    suc.textContent = '✓ Password updated!'; suc.style.display = 'block';
    document.getElementById('admin-new-pass').value  = '';
    document.getElementById('admin-new-pass2').value = '';
  }
}

// ── SERVICE REQUESTS ──────────────────────────
let _currentRequest = null;

async function renderRequests() {
  const tbody = document.getElementById('requests-table');
  let requests = await SB.get('service_requests', '?order=created_at.desc');
  const statusF = document.getElementById('req-status-filter')?.value;
  const search  = (document.getElementById('req-search')?.value || '').toLowerCase();
  if (statusF) requests = requests.filter(r => r.status === statusF);
  if (search)  requests = requests.filter(r =>
    (r.customer_name || '').toLowerCase().includes(search) ||
    (r.company || '').toLowerCase().includes(search) ||
    (r.id || '').toLowerCase().includes(search));

  const openCount = requests.filter(r => r.status === 'open').length;
  const rb = document.getElementById('req-badge');
  if (rb) { rb.style.display = openCount > 0 ? 'inline' : 'none'; if (openCount > 0) rb.textContent = openCount + ' NEW'; }

  if (!requests.length) {
    tbody.innerHTML = '<tr><td colspan="8" style="text-align:center;color:var(--grey);padding:32px;">No service requests yet.</td></tr>';
    return;
  }
  const urgencyColor = { normal: 'var(--grey)', urgent: 'orange', emergency: '#ff4444' };
  tbody.innerHTML = requests.map(r => `
    <tr>
      <td><strong style="color:var(--white)">${esc(r.id)}</strong></td>
      <td>${esc(r.customer_name || '')}<br/><span style="color:var(--grey);font-size:.78rem;">${esc(r.company || '')}</span></td>
      <td style="font-size:.85rem;">${esc(r.equipment || '—')}</td>
      <td style="font-size:.85rem;max-width:140px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${esc(r.issue_type || '—')}</td>
      <td><span style="font-family:var(--font-head);font-size:.72rem;font-weight:700;color:${urgencyColor[r.urgency] || 'var(--grey)'};">${(r.urgency || 'normal').toUpperCase()}</span></td>
      <td style="font-size:.82rem;">${fmtDate(r.created_at)}</td>
      <td>${badge(r.status)}</td>
      <td>
        <button class="action-btn primary" onclick="openReqDetail('${esc(r.id)}')">View</button>
        <button class="action-btn green" onclick="openReqDetailAndQuote('${esc(r.id)}')">→ Quote</button>
        <button class="action-btn" onclick="setReqStatus('${esc(r.id)}','closed')">Close</button>
      </td>
    </tr>`).join('');
}

async function openReqDetail(id, autoQuote) {
  const requests = await SB.get('service_requests', `?id=eq.${encodeURIComponent(id)}`);
  const r = requests[0]; if (!r) return;
  _currentRequest = r;
  document.getElementById('req-detail-id').textContent = r.id;
  const urgencyColor = { normal: 'var(--grey)', urgent: 'orange', emergency: '#ff4444' };
  // Private bucket: mint 10-minute signed URLs for the admin session.
  let attHtml = '<p style="color:var(--grey);font-size:.85rem;margin-top:10px;">No attachments.</p>';
  if (r.attachments?.length) {
    const { data: signed } = await _sb.storage.from('apex-uploads').createSignedUrls(r.attachments, 600);
    const items = (signed || []).filter(s => s.signedUrl).map(s => {
      const raw   = decodeURIComponent(s.path.split('/').pop());
      const name  = raw.replace(/^\d+_/, '');
      const short = name.length > 18 ? name.slice(0, 16) + '…' : name;
      if (/\.(pdf|txt|doc)/.test(s.path.toLowerCase())) {
        return `<a href="${s.signedUrl}" target="_blank" rel="noopener" class="req-att-pdf"><span style="font-size:1.8rem;">📄</span><small style="font-family:var(--font-head);font-size:.58rem;color:var(--grey);margin-top:3px;text-align:center;padding:0 4px;">${esc(short)}</small></a>`;
      }
      return `<a href="${s.signedUrl}" target="_blank" rel="noopener" class="req-att-img" title="${esc(name)}"><img src="${s.signedUrl}" alt="${esc(name)}"/></a>`;
    }).join('');
    if (items) attHtml = `<div style="margin-top:16px;">
        <div style="font-family:var(--font-head);font-size:.65rem;font-weight:700;letter-spacing:.12em;text-transform:uppercase;color:var(--grey);margin-bottom:8px;">📎 Attachments — click to open</div>
        <div class="req-att-grid">${items}</div></div>`;
  }

  document.getElementById('req-detail-body').innerHTML = `
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:16px;">
      <div class="form-group"><label style="font-family:var(--font-head);font-size:.7rem;font-weight:700;letter-spacing:.1em;text-transform:uppercase;color:var(--grey);display:block;margin-bottom:4px;">Customer</label><div style="color:var(--white);">${esc(r.customer_name || '—')}</div></div>
      <div class="form-group"><label style="font-family:var(--font-head);font-size:.7rem;font-weight:700;letter-spacing:.1em;text-transform:uppercase;color:var(--grey);display:block;margin-bottom:4px;">Company</label><div style="color:var(--white);">${esc(r.company || '—')}</div></div>
      <div class="form-group"><label style="font-family:var(--font-head);font-size:.7rem;font-weight:700;letter-spacing:.1em;text-transform:uppercase;color:var(--grey);display:block;margin-bottom:4px;">Email</label><div style="color:var(--white);">${esc(r.customer_email)}</div></div>
      <div class="form-group"><label style="font-family:var(--font-head);font-size:.7rem;font-weight:700;letter-spacing:.1em;text-transform:uppercase;color:var(--grey);display:block;margin-bottom:4px;">Equipment</label><div style="color:var(--white);">${esc(r.equipment || 'Not specified')}</div></div>
      <div class="form-group"><label style="font-family:var(--font-head);font-size:.7rem;font-weight:700;letter-spacing:.1em;text-transform:uppercase;color:var(--grey);display:block;margin-bottom:4px;">Issue Type</label><div style="color:var(--white);">${esc(r.issue_type || '—')}</div></div>
      <div class="form-group"><label style="font-family:var(--font-head);font-size:.7rem;font-weight:700;letter-spacing:.1em;text-transform:uppercase;color:var(--grey);display:block;margin-bottom:4px;">Urgency</label><div style="color:${urgencyColor[r.urgency] || 'var(--grey)'};font-weight:700;">${(r.urgency || 'normal').toUpperCase()}</div></div>
    </div>
    <div style="background:var(--dark-2);border:1px solid var(--border);padding:16px;margin-bottom:16px;">
      <div style="font-family:var(--font-head);font-size:.7rem;font-weight:700;letter-spacing:.1em;text-transform:uppercase;color:var(--grey);margin-bottom:8px;">Description</div>
      <p style="color:var(--white);line-height:1.7;white-space:pre-wrap;">${esc(r.description)}</p>
    </div>
    ${attHtml}
    <div style="margin-top:20px;display:flex;gap:8px;flex-wrap:wrap;">
      <button class="action-btn green" onclick="quoteFromRequest()">✏️ Create Quote from This Request</button>
      <button class="action-btn" onclick="setReqStatus('${esc(r.id)}','closed');closeReqModal();">✓ Mark Closed</button>
    </div>`;

  document.getElementById('req-detail-modal').className = 'modal-overlay open';
  if (autoQuote) quoteFromRequest();
}

function openReqDetailAndQuote(id) { openReqDetail(id, true); }

function closeReqModal() {
  document.getElementById('req-detail-modal').className = 'modal-overlay';
  _currentRequest = null;
}

async function setReqStatus(id, status) {
  await SB.patch('service_requests', `id=eq.${encodeURIComponent(id)}`, { status });
  renderRequests();
  showToast(`✓ Request marked ${status}.`);
}

function quoteFromRequest() {
  if (!_currentRequest) return;
  closeReqModal();
  showView('create-quote');
  setTimeout(async () => {
    const eqEl = document.getElementById('q-equipment');
    if (eqEl) eqEl.value = _currentRequest.equipment || '';
    const descEl = document.getElementById('q-desc');
    if (descEl) descEl.value = _currentRequest.description || '';
    const sel = document.getElementById('q-customer-select');
    if (sel && _currentRequest.customer_email) {
      for (const opt of sel.options) {
        if (opt.value === _currentRequest.customer_email) {
          sel.value = opt.value;
          selectCustomer();
          break;
        }
      }
    }
    showToast('Quote form pre-filled from service request!');
    await setReqStatus(_currentRequest.id, 'quoted');
  }, 200);
}

// ── SERVICE HISTORY ───────────────────────────
let _editingHistId = null;

async function renderHistory() {
  const tbody = document.getElementById('history-table');
  let rows = await SB.get('service_history', '?order=date.desc');

  const custFilter = document.getElementById('history-customer-filter');
  if (custFilter && custFilter.options.length <= 1) {
    const custs = _allCustomers.length ? _allCustomers : await DB.getAllCustomers();
    [...new Set(custs.map(c => c.company || c.name).filter(Boolean))].sort().forEach(n => {
      const o = document.createElement('option'); o.value = n; o.textContent = n;
      custFilter.appendChild(o);
    });
  }

  const custF  = document.getElementById('history-customer-filter')?.value;
  const paidF  = document.getElementById('history-paid-filter')?.value;
  const search = (document.getElementById('history-search')?.value || '').toLowerCase();

  if (custF)          rows = rows.filter(r => r.company === custF || r.customer_name?.includes(custF));
  if (paidF === 'paid')   rows = rows.filter(r => r.paid);
  if (paidF === 'unpaid') rows = rows.filter(r => !r.paid);
  if (search) rows = rows.filter(r =>
    (r.customer_name || '').toLowerCase().includes(search) ||
    (r.equipment || '').toLowerCase().includes(search) ||
    (r.description || '').toLowerCase().includes(search));

  if (!rows.length) {
    tbody.innerHTML = '<tr><td colspan="9" style="text-align:center;color:var(--grey);padding:32px;">No service history records yet.</td></tr>';
    return;
  }
  tbody.innerHTML = rows.map(r => `
    <tr>
      <td><strong style="color:var(--white);font-size:.82rem;">${esc(r.id)}</strong></td>
      <td>${esc(r.customer_name || '—')}<br/><span style="color:var(--grey);font-size:.76rem;">${esc(r.company || '')}</span></td>
      <td style="font-size:.85rem;">${esc(r.equipment || '—')}</td>
      <td style="font-size:.85rem;max-width:160px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="${esc(r.description || '')}">${esc(r.description || '—')}</td>
      <td style="font-size:.85rem;">${esc(r.tech || '—')}</td>
      <td style="font-size:.82rem;">${r.date ? new Date(r.date).toLocaleDateString('en-US') : '—'}</td>
      <td style="color:var(--red);font-family:var(--font-head);font-weight:700;">${r.amount ? '$' + parseFloat(r.amount).toFixed(2) : '—'}</td>
      <td>
        ${r.paid
          ? '<span style="color:#4caf50;font-family:var(--font-head);font-size:.72rem;font-weight:700;letter-spacing:.08em;">✓ PAID</span>'
          : r.amount
            ? '<span style="color:orange;font-family:var(--font-head);font-size:.72rem;font-weight:700;letter-spacing:.08em;">UNPAID</span>'
            : '<span style="color:var(--grey);font-family:var(--font-head);font-size:.72rem;">—</span>'}
        ${!r.paid && r.amount ? `<button class="action-btn green" style="margin-top:4px;display:block;" onclick="markHistPaid('${esc(r.id)}')">Record Payment</button>` : ''}
      </td>
      <td>
        <button class="action-btn" onclick="openEditHistory('${esc(r.id)}')">Edit</button>
        <button class="action-btn danger" onclick="deleteHistory('${esc(r.id)}')">Delete</button>
      </td>
    </tr>`).join('');
}

async function populateHistCustomerDropdown() {
  if (!_allCustomers.length) _allCustomers = await DB.getAllCustomers();
  const sel = document.getElementById('hist-customer');
  sel.innerHTML = '<option value="">— Select customer —</option>' +
    _allCustomers.map(x =>
      `<option value="${esc(String(x.id))}">${esc(x.name || x.email)}${x.company ? ' — ' + esc(x.company) : ''}</option>`
    ).join('');
}

async function openAddHistoryModal() {
  _editingHistId = null;
  document.getElementById('history-modal-title').textContent = 'Add Service Record';
  document.getElementById('hist-err').style.display = 'none';
  ['hist-equipment', 'hist-tech', 'hist-desc', 'hist-notes', 'hist-amount'].forEach(id => {
    document.getElementById(id).value = '';
  });
  document.getElementById('hist-date').value = new Date().toISOString().slice(0, 10);
  document.getElementById('hist-paid').value = 'false';
  await populateHistCustomerDropdown();
  document.getElementById('history-modal').className = 'modal-overlay open';
}

async function openEditHistory(id) {
  const rows = await SB.get('service_history', `?id=eq.${encodeURIComponent(id)}`);
  const r = rows[0]; if (!r) return;
  _editingHistId = id;
  document.getElementById('history-modal-title').textContent = 'Edit Service Record ' + id;
  document.getElementById('hist-err').style.display = 'none';
  await populateHistCustomerDropdown();
  const sel = document.getElementById('hist-customer');
  sel.value = r.customer_id || '';
  document.getElementById('hist-equipment').value = r.equipment    || '';
  document.getElementById('hist-tech').value      = r.tech         || '';
  document.getElementById('hist-desc').value      = r.description  || '';
  document.getElementById('hist-notes').value     = r.notes        || '';
  document.getElementById('hist-amount').value    = r.amount       || '';
  document.getElementById('hist-paid').value      = r.paid ? 'true' : 'false';
  document.getElementById('hist-date').value      = r.date ? r.date.slice(0, 10) : '';
  document.getElementById('history-modal').className = 'modal-overlay open';
}

function closeHistoryModal() {
  document.getElementById('history-modal').className = 'modal-overlay';
  _editingHistId = null;
}

async function saveHistoryRecord() {
  const sel    = document.getElementById('hist-customer');
  const custId = sel.value;
  const desc   = document.getElementById('hist-desc').value.trim();
  const err    = document.getElementById('hist-err');
  err.style.display = 'none';

  if (!custId) { err.textContent = 'Please select a customer.'; err.style.display = 'block'; return; }
  if (!desc)   { err.textContent = 'Description of work is required.'; err.style.display = 'block'; return; }

  const cust = _allCustomers.find(x => String(x.id) === String(custId)) || {};
  if (!cust.email) { err.textContent = 'Could not find customer details. Please refresh and try again.'; err.style.display = 'block'; return; }

  const isPaid  = document.getElementById('hist-paid').value === 'true';
  const amount  = parseFloat(document.getElementById('hist-amount').value) || null;
  const dateVal = document.getElementById('hist-date').value;

  const record = {
    customer_id:    custId,
    customer_email: cust.email,
    customer_name:  cust.name    || '',
    company:        cust.company || '',
    equipment:  document.getElementById('hist-equipment').value.trim(),
    tech:       document.getElementById('hist-tech').value.trim(),
    description: desc,
    notes:      document.getElementById('hist-notes').value.trim(),
    amount, paid: isPaid,
    paid_at: isPaid ? new Date().toISOString() : null,
    date:    dateVal ? new Date(dateVal).toISOString() : new Date().toISOString()
  };

  try {
    const url    = `${SUPABASE_URL}/rest/v1/service_history${_editingHistId ? `?id=eq.${encodeURIComponent(_editingHistId)}` : ''}`;
    const method = _editingHistId ? 'PATCH' : 'POST';
    const res    = await fetch(url, { method, headers: await SB.headers(), body: JSON.stringify(record) });
    if (!res.ok) { const txt = await res.text(); err.textContent = 'Save failed: ' + txt; err.style.display = 'block'; return; }
    closeHistoryModal();
    showToast(_editingHistId ? '✓ Service record updated!' : '✓ Service record added!');
    renderHistory();
  } catch (e) {
    console.error('History save error:', e);
    err.textContent = 'Connection error. Please try again.';
    err.style.display = 'block';
  }
}

async function markHistPaid(id) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/service_history?id=eq.${encodeURIComponent(id)}`, {
    method: 'PATCH', headers: await SB.headers(),
    body: JSON.stringify({ paid: true, paid_at: new Date().toISOString() })
  });
  if (!res.ok) { showToast('Error marking paid.'); }
  else {
    await logActivity('mark_history_paid', `Service record ${id} marked as paid`);
    showToast('✓ Marked as paid!');
    renderHistory();
  }
}

async function deleteHistory(id) {
  if (!confirm('Delete this service record? This cannot be undone.')) return;
  await SB.delete('service_history', `id=eq.${encodeURIComponent(id)}`);
  showToast('✓ Record deleted.');
  renderHistory();
}

async function logout() { await Auth.signOut(); window.location.href = 'portal-login.html'; }


// ── CSV EXPORT ────────────────────────────────
// Converts an array of objects to a CSV string and triggers download.
function downloadCSV(rows, filename) {
  if (!rows || !rows.length) { showToast('No data to export.'); return; }
  const cols = Object.keys(rows[0]);
  const escape = v => {
    if (v == null) return '';
    const s = String(v).replace(/"/g, '""');
    return s.includes(',') || s.includes('"') || s.includes('\n') ? `"${s}"` : s;
  };
  const csv = [cols.join(','), ...rows.map(r => cols.map(c => escape(r[c])).join(','))].join('\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url  = URL.createObjectURL(blob);
  const a    = Object.assign(document.createElement('a'), { href: url, download: filename });
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
  showToast('✓ ' + filename + ' downloaded!');
}

async function exportInvoicesCSV() {
  const invoices = (await DB.getAllInvoices()).filter(i => i.status !== 'void');
  const rows = invoices.map(i => ({
    'Invoice #':     i.id,
    'Customer':      i.customer_name || '',
    'Company':       i.company || '',
    'Email':         i.customer_email,
    'Description':   i.description || '',
    'Amount':        parseFloat(i.amount).toFixed(2),
    'Status':        i.status,
    'Due Date':      i.due ? new Date(i.due).toLocaleDateString('en-US') : '',
    'Paid On':       i.paid_at ? new Date(i.paid_at).toLocaleDateString('en-US') : '',
    'Quote Ref':     i.quote_id || '',
    'Created':       new Date(i.created_at).toLocaleDateString('en-US'),
  }));
  const date = new Date().toISOString().slice(0,10);
  downloadCSV(rows, `apex-invoices-${date}.csv`);
}

async function exportQuotesCSV() {
  const quotes = await DB.getAllQuotes();
  const rows = quotes.map(q => ({
    'Quote #':       q.id,
    'Customer':      q.customer_name || '',
    'Company':       q.company || '',
    'Email':         q.customer_email,
    'Equipment':     q.equipment || '',
    'Description':   q.description || '',
    'Amount':        parseFloat(q.amount).toFixed(2),
    'Status':        q.status,
    'Invoiced':      q.invoiced ? 'Yes' : 'No',
    'Responded':     q.responded_at ? new Date(q.responded_at).toLocaleDateString('en-US') : '',
    'Created':       new Date(q.created_at).toLocaleDateString('en-US'),
  }));
  const date = new Date().toISOString().slice(0,10);
  downloadCSV(rows, `apex-quotes-${date}.csv`);
}

async function exportServiceHistoryCSV() {
  const rows_raw = await DB.getAllServiceHistory();
  const rows = rows_raw.map(h => ({
    'Record ID':     h.id,
    'Customer':      h.customer_name || '',
    'Company':       h.company || '',
    'Email':         h.customer_email,
    'Equipment':     h.equipment || '',
    'Description':   h.description || '',
    'Technician':    h.tech || '',
    'Date':          h.date ? new Date(h.date).toLocaleDateString('en-US') : '',
    'Amount':        h.amount != null ? parseFloat(h.amount).toFixed(2) : '',
    'Paid':          h.paid ? 'Yes' : 'No',
    'Paid On':       h.paid_at ? new Date(h.paid_at).toLocaleDateString('en-US') : '',
    'Notes':         h.notes || '',
    'Created':       new Date(h.created_at).toLocaleDateString('en-US'),
  }));
  const date = new Date().toISOString().slice(0,10);
  downloadCSV(rows, `apex-service-history-${date}.csv`);
}

async function exportCustomersCSV() {
  const customers = await DB.getAllCustomers();
  const rows = customers.map(c => ({
    'Name':      c.name || '',
    'Company':   c.company || '',
    'Email':     c.email,
    'Phone':     c.phone || '',
    'Status':    c.status,
    'Since':     c.since || '',
    'Created':   new Date(c.created_at).toLocaleDateString('en-US'),
  }));
  const date = new Date().toISOString().slice(0,10);
  downloadCSV(rows, `apex-customers-${date}.csv`);
}

// Auto-refresh every 12 seconds
setTimeout(() => {
  setInterval(() => { if (_currentUser) refreshAll(); }, 12000);
}, 4000);

// ── ACTIVITY LOG ──────────────────────────────
async function renderActivityLog() {
  const tbody = document.getElementById('activity-table');
  tbody.innerHTML = '<tr><td colspan="3" style="text-align:center;color:var(--grey);padding:24px;">Loading…</td></tr>';
  try {
    const rows = await DB.getActivityLog(150);
    if (!rows.length) {
      tbody.innerHTML = '<tr><td colspan="3" style="text-align:center;color:var(--grey);padding:32px;">No activity recorded yet. Actions like creating invoices, marking payments, and activating customers will appear here.</td></tr>';
      return;
    }
    const actionIcon = {
      create_invoice:      '🧾',
      mark_invoice_paid:   '✅',
      activate_customer:   '👤',
      deactivate_customer: '🔒',
      delete_quote:        '🗑',
      delete_invoice:      '🗑',
      delete_customer:     '🗑',
    };
    tbody.innerHTML = rows.map(r => `
      <tr>
        <td style="white-space:nowrap;font-size:.8rem;color:var(--grey);">${new Date(r.created_at).toLocaleString('en-US', { month:'short', day:'numeric', hour:'2-digit', minute:'2-digit' })}</td>
        <td><span style="font-family:var(--font-head);font-size:.72rem;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:var(--grey-light);">${actionIcon[r.action] || '•'} ${esc(r.action.replace(/_/g,' '))}</span></td>
        <td style="font-size:.88rem;color:var(--grey-light);">${esc(r.description)}</td>
      </tr>`).join('');
  } catch(e) {
    tbody.innerHTML = `<tr><td colspan="3" style="text-align:center;color:#ff4444;padding:24px;">Error loading activity log: ${esc(e.message)}</td></tr>`;
  }
}

// ── PDF PRINT — QUOTE ─────────────────────────
async function printQuotePDF(quoteId) {
  // Open the window SYNCHRONOUSLY before any await — mobile browsers block
  // popups that aren't opened directly from a user gesture click handler.
  const win = window.open('', '_blank');
  if (!win) { showToast('Popup blocked — please allow popups for this site and try again.'); return; }
  win.document.write('<html><body style="background:#fff;color:#666;font-family:sans-serif;padding:40px;text-align:center;"><p>Loading…</p></body></html>');

  const quotes = await DB.getAllQuotes();
  const q = quotes.find(x => x.id === quoteId);
  if (!q) { win.close(); showToast('Quote not found.'); return; }

  const itemRows = q.items?.map(i => {
    const qty  = parseFloat(i.qty) || 1;
    const unit = parseFloat(i.unit_price || i.amount || 0);
    return `<tr>
      <td style="padding:9px 12px;border-bottom:1px solid #eee;">${i.desc || 'Service'}</td>
      <td style="padding:9px 12px;border-bottom:1px solid #eee;text-align:center;">${qty}</td>
      <td style="padding:9px 12px;border-bottom:1px solid #eee;">${i.type || ''}</td>
      <td style="padding:9px 12px;border-bottom:1px solid #eee;text-align:right;font-weight:600;">$${(qty * unit).toFixed(2)}</td>
    </tr>`;
  }).join('') || '<tr><td colspan="4" style="padding:9px 12px;color:#666;">See description for details.</td></tr>';

  win.document.write(`<!DOCTYPE html><html><head><title>Quote ${q.id} — Apex Lift Solutions</title>
  <style>
    *{box-sizing:border-box;} html,body{background:#ffffff !important;} body{font-family:Arial,sans-serif;color:#111;max-width:720px;margin:40px auto;padding:0 24px;font-size:14px;background:#ffffff;-webkit-print-color-adjust:exact;print-color-adjust:exact;}
    h1{font-size:28px;margin:0 0 2px;} .red{color:#cc0000;} .grey{color:#666;font-size:13px;}
    .header{display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:24px;padding-bottom:16px;border-bottom:3px solid #cc0000;}
    .badge{display:inline-block;padding:4px 12px;font-size:11px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;border:2px solid;margin-bottom:12px;}
    .badge.pending{color:orange;border-color:orange;} .badge.approved{color:#4caf50;border-color:#4caf50;} .badge.declined{color:#cc0000;border-color:#cc0000;}
    .meta-grid{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin:20px 0;background:#f9f9f9;padding:16px;}
    .meta-item label{display:block;font-size:11px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:#666;margin-bottom:3px;}
    table{width:100%;border-collapse:collapse;margin:20px 0;}
    th{background:#f0f0f0;padding:10px 12px;text-align:left;font-size:11px;letter-spacing:.08em;text-transform:uppercase;}
    .total-row{text-align:right;font-size:18px;font-weight:700;padding:12px 0;border-top:2px solid #cc0000;}
    .footer{margin-top:32px;padding-top:16px;border-top:1px solid #eee;color:#666;font-size:12px;text-align:center;}
    @media print{button{display:none;} body{margin:20px;}}
  </style></head><body>
  <div class="header">
    <div>
      <h1>Apex Lift <span class="red">Solutions</span></h1>
      <div class="grey">(516) 644-7187 · info@apexliftsolutionsusa.com</div>
      <div class="grey">Nassau &amp; Suffolk County, Long Island, NY</div>
    </div>
    <div style="text-align:right;">
      <div style="font-size:22px;font-weight:700;color:#111;">${q.id}</div>
      <div class="grey">Quote Date: ${new Date(q.created_at).toLocaleDateString('en-US',{year:'numeric',month:'long',day:'numeric'})}</div>
      <div class="badge ${q.status}">${q.status.toUpperCase()}</div>
    </div>
  </div>
  <div class="meta-grid">
    <div class="meta-item"><label>Customer</label>${q.customer_name || '—'}</div>
    <div class="meta-item"><label>Company</label>${q.company || '—'}</div>
    <div class="meta-item"><label>Email</label>${q.customer_email}</div>
    <div class="meta-item"><label>Equipment</label>${q.equipment || 'Not specified'}</div>
  </div>
  ${q.description ? `<p style="margin:0 0 16px;line-height:1.6;">${q.description}</p>` : ''}
  <table>
    <thead><tr><th>Description</th><th style="text-align:center;">Qty</th><th>Type</th><th style="text-align:right;">Amount</th></tr></thead>
    <tbody>${itemRows}</tbody>
  </table>
  <div class="total-row">Total: $${parseFloat(q.amount).toFixed(2)}</div>
  ${q.notes ? `<div style="background:#fff8e1;border-left:3px solid #ffc107;padding:12px 16px;margin-top:16px;"><strong>Notes:</strong> ${q.notes}</div>` : ''}
  <div class="footer">
    <p>This quote is valid for 30 days. Questions? Call (516) 644-7187 or email info@apexliftsolutionsusa.com</p>
    <p>apexliftsolutionsusa.com</p>
  </div>
  <button onclick="window.print()" style="margin-top:20px;padding:10px 24px;background:#cc0000;color:#fff;border:none;font-size:14px;cursor:pointer;display:block;">🖨 Print / Save as PDF</button>
  </body></html>`);
  win.document.close();
}

// ── PDF PRINT — INVOICE ───────────────────────
async function printInvoicePDF(invoiceId) {
  // Open window synchronously before await — required for mobile popup policy
  const win = window.open('', '_blank');
  if (!win) { showToast('Popup blocked — please allow popups for this site and try again.'); return; }
  win.document.write('<html><body style="background:#fff;color:#666;font-family:sans-serif;padding:40px;text-align:center;"><p>Loading…</p></body></html>');

  const invoices = await DB.getAllInvoices();
  const inv = invoices.find(x => x.id === invoiceId);
  if (!inv) { win.close(); showToast('Invoice not found.'); return; }

  const itemRows = inv.items?.map(i => {
    const qty  = parseFloat(i.qty) || 1;
    const unit = parseFloat(i.unit_price || i.amount || 0);
    return `<tr>
      <td style="padding:9px 12px;border-bottom:1px solid #eee;">${i.desc || 'Service'}</td>
      <td style="padding:9px 12px;border-bottom:1px solid #eee;text-align:center;">${qty}</td>
      <td style="padding:9px 12px;border-bottom:1px solid #eee;">${i.type || ''}</td>
      <td style="padding:9px 12px;border-bottom:1px solid #eee;text-align:right;font-weight:600;">$${(qty * unit).toFixed(2)}</td>
    </tr>`;
  }).join('') || '<tr><td colspan="4" style="padding:9px 12px;color:#666;">See description for details.</td></tr>';

  const isPaid = inv.status === 'paid';
  win.document.write(`<!DOCTYPE html><html><head><title>Invoice ${inv.id} — Apex Lift Solutions</title>
  <style>
    *{box-sizing:border-box;} html,body{background:#ffffff !important;} body{font-family:Arial,sans-serif;color:#111;max-width:720px;margin:40px auto;padding:0 24px;font-size:14px;background:#ffffff;-webkit-print-color-adjust:exact;print-color-adjust:exact;}
    h1{font-size:28px;margin:0 0 2px;} .red{color:#cc0000;} .grey{color:#666;font-size:13px;}
    .header{display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:24px;padding-bottom:16px;border-top:5px solid #cc0000;padding-top:20px;}
    .meta-grid{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin:20px 0;background:#f9f9f9;padding:16px;}
    .meta-item label{display:block;font-size:11px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:#666;margin-bottom:3px;}
    table{width:100%;border-collapse:collapse;margin:20px 0;}
    th{background:#f0f0f0;padding:10px 12px;text-align:left;font-size:11px;letter-spacing:.08em;text-transform:uppercase;}
    .total-row{text-align:right;font-size:20px;font-weight:700;padding:14px 0;border-top:3px solid #cc0000;color:#cc0000;}
    .paid-stamp{display:inline-block;border:4px solid #4caf50;color:#4caf50;padding:8px 22px;font-size:18px;font-weight:900;letter-spacing:.1em;text-transform:uppercase;transform:rotate(-4deg);margin:16px 0;display:block;width:fit-content;}
    .due-box{background:#fff8e1;border:1px solid #ffc107;padding:12px 16px;margin:16px 0;font-weight:600;}
    .footer{margin-top:32px;padding-top:16px;border-top:1px solid #eee;color:#666;font-size:12px;text-align:center;}
    @media print{button{display:none;} body{margin:20px;}}
  </style></head><body>
  <div class="header">
    <div>
      <h1>Apex Lift <span class="red">Solutions</span></h1>
      <div class="grey">(516) 644-7187 · info@apexliftsolutionsusa.com</div>
      <div class="grey">Nassau &amp; Suffolk County, Long Island, NY</div>
    </div>
    <div style="text-align:right;">
      <div style="font-size:11px;font-weight:700;letter-spacing:.1em;text-transform:uppercase;color:#666;margin-bottom:4px;">INVOICE</div>
      <div style="font-size:24px;font-weight:700;color:#111;">${inv.id}</div>
      <div class="grey">Issued: ${new Date(inv.created_at).toLocaleDateString('en-US',{year:'numeric',month:'long',day:'numeric'})}</div>
      ${inv.quote_id ? `<div class="grey">Ref: ${inv.quote_id}</div>` : ''}
    </div>
  </div>
  ${isPaid ? `<div class="paid-stamp">✓ PAID — ${new Date(inv.paid_at).toLocaleDateString('en-US',{month:'long',day:'numeric',year:'numeric'})}</div>` : `<div class="due-box">⚠ Payment Due: ${inv.due ? new Date(inv.due).toLocaleDateString('en-US',{year:'numeric',month:'long',day:'numeric'}) : 'Upon receipt'}</div>`}
  <div class="meta-grid">
    <div class="meta-item"><label>Bill To</label>${inv.customer_name || '—'}</div>
    <div class="meta-item"><label>Company</label>${inv.company || '—'}</div>
    <div class="meta-item"><label>Email</label>${inv.customer_email}</div>
    <div class="meta-item"><label>Status</label>${isPaid ? '✓ Paid in Full' : 'Unpaid'}</div>
  </div>
  ${inv.description ? `<p style="margin:0 0 16px;line-height:1.6;"><strong>Description:</strong> ${inv.description}</p>` : ''}
  <table>
    <thead><tr><th>Description</th><th style="text-align:center;">Qty</th><th>Type</th><th style="text-align:right;">Amount</th></tr></thead>
    <tbody>${itemRows}</tbody>
  </table>
  <div class="total-row">Total: $${parseFloat(inv.amount).toFixed(2)}</div>
  <div class="footer">
    <p>${isPaid ? 'Thank you for your payment!' : 'Please remit payment to info@apexliftsolutionsusa.com or call (516) 644-7187.'}</p>
    <p>apexliftsolutionsusa.com · Nassau &amp; Suffolk County, Long Island, NY</p>
  </div>
  <button onclick="window.print()" style="margin-top:20px;padding:10px 24px;background:#cc0000;color:#fff;border:none;font-size:14px;cursor:pointer;display:block;">🖨 Print / Save as PDF</button>
  </body></html>`);
  win.document.close();
}

/* ═══════════════════════════════════════════════════════════════════════════
   SERVICE PLANS — Phase B (admin)

   Reads go direct through PostgREST: RLS policy "…_admin_all" gives the admin
   SELECT on customer_equipment / service_plan_offers / service_plan_agreements
   / service_subscriptions.

   Writes do NOT. SERVICE_PLANS_UPGRADE.sql revoked INSERT/UPDATE/DELETE on
   those tables from `authenticated`, which the admin also is. Every write below
   goes through the service-plans-admin Edge Function, which re-verifies the
   caller is the admin, derives tax server-side, and lets the database enforce
   the customer/equipment/price relationships.
   ═══════════════════════════════════════════════════════════════════════════ */

const SP = {
  customerId: null, customer: null, equipment: [], offers: [], agreements: [], subs: [],
  taxRateMilliPct: DEFAULT_TAX_MILLI_PCT,
  taxJurisdiction: 'Nassau / Suffolk County, NY'
};

function spEsc(v) {
  return String(v ?? '').replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
const spUsd = c => '$' + (Number(c ?? 0) / 100).toFixed(2);
const spDate = d => d ? new Date(String(d).length === 10 ? d + 'T12:00:00Z' : d)
  .toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' }) : '—';

async function spCall(action, payload) {
  const { data: { session } } = await _sb.auth.getSession();
  if (!session) { alert('Your session expired. Please sign in again.'); return null; }
  const r = await fetch(`${SUPABASE_URL}/functions/v1/service-plans-admin`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${session.access_token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ action, ...payload }),
  });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) {
    alert(body.detail || body.error || `Request failed (${r.status})`);
    return null;
  }
  return body;
}

async function renderServicePlans() {
  const sel = document.getElementById('sp-customer');
  if (sel) {
    // Use the same customer loader that powers the existing Customers/Quotes UI.
    // The previous direct supabase-js query could fail silently and leave this
    // dropdown empty even while the customer existed elsewhere in the admin portal.
    const previous = SP.customerId || sel.value || '';
    const customers = await DB.getAllCustomers();
    const list = Array.isArray(customers) ? customers : [];

    sel.innerHTML = list.length
      ? '<option value="">— Select a customer —</option>'
      : '<option value="">— No customers found —</option>';

    list
      .slice()
      .sort((a, b) => String(a.company || a.name || '').localeCompare(String(b.company || b.name || '')))
      .forEach(c => {
        const o = document.createElement('option');
        o.value = c.id;
        o.textContent = c.company ? `${c.company} — ${c.name || c.email || ''}` : (c.name || c.email || 'Customer');
        sel.appendChild(o);
      });

    if (previous && list.some(c => String(c.id) === String(previous))) {
      sel.value = previous;
      SP.customerId = previous;
    } else if (previous) {
      SP.customerId = null;
    }

    // Assign handlers rather than stacking duplicate listeners on every render.
    sel.onchange = () => spLoadCustomer(sel.value);
    const refresh = document.getElementById('sp-refresh');
    if (refresh) refresh.onclick = () => renderServicePlans();

    if (!sel.dataset.spWired) {
      spWireModals();
      sel.dataset.spWired = '1';
    }
  }
  if (SP.customerId) await spLoadCustomer(SP.customerId);
}

async function spLoadCustomer(customerId) {
  const body = document.getElementById('sp-body');
  if (!customerId) {
    SP.customerId = null;
    body.innerHTML = '<div class="empty-state">Select a customer to see their equipment and service plans.</div>';
    return;
  }
  SP.customerId = customerId;
  body.innerHTML = '<div class="empty-state">Loading…</div>';

  const [cust, equip, offers, agrees, subs, taxCfg] = await Promise.all([
    _sb.from('customers')
      .select('id, name, company, email, status')
      .eq('id', customerId).maybeSingle(),
    _sb.from('customer_equipment').select('*')
      .eq('customer_id', customerId).order('created_at', { ascending: true }),
    _sb.from('service_plan_offers').select('*')
      .eq('customer_id', customerId).order('created_at', { ascending: false }),
    _sb.from('service_plan_agreements').select('*')
      .eq('customer_id', customerId).order('signed_at', { ascending: false }),
    _sb.from('service_subscriptions').select('*').eq('customer_id', customerId),
    _sb.from('app_config').select('key,value')
      .in('key', ['sales_tax_default_milli_pct','sales_tax_default_jurisdiction']),
  ]);

  if (cust.error) {
    console.error('[Service Plans] customer load failed:', cust.error);
    body.innerHTML = `<div class="empty-state" style="color:#ff4444;">Could not load this customer: ${spEsc(cust.error.message)}</div>`;
    return;
  }

  SP.customer = cust.data || null;
  SP.equipment = equip.data || [];
  SP.offers = offers.data || [];
  SP.agreements = agrees.data || [];
  SP.subs = subs.data || [];

  for (const row of taxCfg.data || []) {
    if (row.key === 'sales_tax_default_milli_pct') {
      const n = Number(row.value);
      if (Number.isFinite(n) && n >= 0) SP.taxRateMilliPct = n;
    } else if (row.key === 'sales_tax_default_jurisdiction' && row.value) {
      SP.taxJurisdiction = row.value;
    }
  }
  spRender();
}

function spRender() {
  const body = document.getElementById('sp-body');
  const taxLine = `Sales tax ${(Number(SP.taxRateMilliPct ?? DEFAULT_TAX_MILLI_PCT) / 1000).toFixed(3)}%`
    + (SP.taxJurisdiction ? ` — ${spEsc(SP.taxJurisdiction)}` : '')
    + ' (calculated server-side)';

  let html = `<div class="sp-card"><div class="sp-row">
      <div><h4>${spEsc(SP.customer?.company || SP.customer?.name || 'Customer')}</h4>
        <div class="sp-meta">${spEsc(SP.customer?.email || '')}<br>${taxLine}</div></div>
      <div class="sp-actions"><button class="approve-btn" type="button" onclick="spOpenEquip()">Add forklift</button></div>
    </div></div>`;

  if (!SP.equipment.length) {
    html += '<div class="empty-state">No equipment on file. Add a forklift to create a service plan.</div>';
  }

  for (const eq of SP.equipment) {
    const label = [eq.year, eq.make, eq.model].filter(Boolean).join(' ') || 'Forklift';
    const offers = SP.offers.filter(o => o.equipment_id === eq.id);
    const live = offers.find(o => o.status === 'sent');
    const agreement = SP.agreements.find(a => a.equipment_id === eq.id && a.status === 'signed');
    const sub = SP.subs.find(x => x.equipment_id === eq.id
      && !['cancelled', 'completed', 'failed_setup'].includes(x.status));

    html += `<div class="sp-card">
      <div class="sp-row">
        <div>
          <h4>${spEsc(eq.unit_number || label)}</h4>
          <div class="sp-meta">
            ${spEsc(label)}${eq.serial_number ? ` · serial ${spEsc(eq.serial_number)}` : ' · no serial on file'}<br>
            ${spEsc(eq.service_location || 'No service location recorded')}
          </div>
        </div>
        <div class="sp-actions">
          <button class="btn-secondary" type="button" onclick="spOpenEquip('${eq.id}')">Edit</button>
          ${live || agreement
            ? ''
            : `<button class="approve-btn" type="button" onclick="spOpenOffer(null,'${eq.id}')">New offer</button>`}
        </div>
      </div>`;

    if (agreement) {
      html += `<div class="sp-meta" style="margin-top:12px;padding-top:12px;border-top:1px solid rgba(255,255,255,.1);">
        <b>Signed agreement</b> — ${spUsd(agreement.monthly_total_cents)}/month by
        ${agreement.selected_payment_method === 'ach' ? 'bank transfer' : 'card'},
        ${spEsc(agreement.term_months)} cycles from ${spDate(agreement.activation_date)}.
        Signed by ${spEsc(agreement.signer_name)} on ${spDate(agreement.signed_at)}.
        ${agreement.pdf_path ? 'PDF stored.' : 'PDF pending.'}<br>
        ${sub ? `Subscription status: <b>${spEsc(sub.status)}</b>. ${sub.payment_method_display ? spEsc(sub.payment_method_display) : 'Payment method not yet collected.'}
          ${sub.next_billing_date ? ` Next billing ${spDate(sub.next_billing_date)}.` : ''}
          ${Number(sub.times_billed || 0)} of ${Number(sub.max_cycles || agreement.term_months)} payments recorded.
          <div class="sp-actions" style="margin-top:10px;">
            ${sub.status === 'method_verified' ? `<button class="approve-btn" type="button" onclick="spActivateSubscription('${sub.id}')">Activate billing</button>` : ''}
            ${!['cancelled','completed','failed_setup'].includes(sub.status) ? `<button class="btn-secondary" type="button" onclick="showView('subscriptions')">Manage subscription</button>` : ''}
          </div>`
              : 'No subscription yet.'}
      </div>`;
    }

    if (offers.length) {
      html += '<div style="margin-top:12px;padding-top:12px;border-top:1px solid rgba(255,255,255,.1);">';
      for (const o of offers) {
        html += `<div class="sp-row" style="padding:6px 0;">
          <div class="sp-meta">
            <span class="sp-pill ${spEsc(o.status)}">${spEsc(o.status)}</span>
            &nbsp;${spEsc(o.plan_name)} — ACH ${spUsd(o.ach_monthly_total_cents)} / card ${spUsd(o.card_monthly_total_cents)} per month
            · ${spEsc(o.term_months)} cycles from ${spDate(o.activation_date)}
            ${o.expires_at && o.status === 'sent' ? ` · expires ${spDate(o.expires_at)}` : ''}
            ${o.declined_reason ? `<br>Declined: ${spEsc(o.declined_reason)}` : ''}
          </div>
          <div class="sp-actions">
            ${o.status === 'draft' ? `<button class="btn-secondary" type="button" onclick="spOpenOffer('${o.id}')">Edit</button>
              <button class="approve-btn" type="button" onclick="spSendOffer('${o.id}')">Send</button>` : ''}
            ${['draft', 'sent'].includes(o.status)
              ? `<button class="btn-secondary" type="button" onclick="spCancelOffer('${o.id}')">Cancel</button>` : ''}
          </div>
        </div>`;
      }
      html += '</div>';
    }
    html += '</div>';
  }

  body.innerHTML = html;
}

/* ── Equipment ─────────────────────────────────────────────────────────── */
function spOpenEquip(id) {
  const eq = id ? SP.equipment.find(e => e.id === id) : null;
  const locked = !!(eq && SP.agreements.some(a => a.equipment_id === eq.id && a.status === 'signed'));
  document.getElementById('sp-equip-title').textContent = eq ? 'Edit forklift' : 'Add forklift';
  document.getElementById('sp-equip-id').value = eq?.id || '';
  document.getElementById('sp-eq-unit').value = eq?.unit_number || '';
  document.getElementById('sp-eq-year').value = eq?.year || '';
  document.getElementById('sp-eq-make').value = eq?.make || '';
  document.getElementById('sp-eq-model').value = eq?.model || '';
  document.getElementById('sp-eq-serial').value = eq?.serial_number || '';
  document.getElementById('sp-eq-loc').value = eq?.service_location || '';
  document.getElementById('sp-eq-notes').value = eq?.notes || '';
  document.getElementById('sp-equip-lock').hidden = !locked;
  for (const f of ['sp-eq-year', 'sp-eq-make', 'sp-eq-model', 'sp-eq-serial']) {
    document.getElementById(f).disabled = locked;
  }
  document.getElementById('sp-equip-modal').hidden = false;
}
function spCloseEquip() { document.getElementById('sp-equip-modal').hidden = true; }

/* ── Offers ────────────────────────────────────────────────────────────── */
function spOpenOffer(offerId, equipmentId) {
  const o = offerId ? SP.offers.find(x => x.id === offerId) : null;
  const eqId = o?.equipment_id || equipmentId;
  const eq = SP.equipment.find(e => e.id === eqId);
  const label = [eq?.year, eq?.make, eq?.model].filter(Boolean).join(' ') || 'Forklift';

  document.getElementById('sp-offer-title').textContent = o ? 'Edit draft offer' : 'New service plan offer';
  document.getElementById('sp-offer-id').value = o?.id || '';
  document.getElementById('sp-offer-equip').value = eqId || '';
  document.getElementById('sp-offer-unit').textContent =
    `${eq?.unit_number || label}${eq?.serial_number ? ` · serial ${eq.serial_number}` : ''}`;

  document.getElementById('sp-plan-name').value = o?.plan_name || 'Monthly Planned Maintenance — Standard';
  document.getElementById('sp-plan-desc').value = o?.description || '';
  document.getElementById('sp-included').value = (o?.included_services || []).join('\n');
  document.getElementById('sp-excluded').value = (o?.exclusions || []).join('\n');
  document.getElementById('sp-ach').value = o ? (o.ach_monthly_subtotal_cents / 100).toFixed(2) : '';
  document.getElementById('sp-card').value = o ? (o.card_monthly_subtotal_cents / 100).toFixed(2) : '';
  document.getElementById('sp-term').value = o?.term_months ?? 6;

  const d = new Date(); d.setDate(d.getDate() + 7);
  document.getElementById('sp-activation').value = o?.activation_date || d.toISOString().slice(0, 10);
  document.getElementById('sp-expiry').value = 30;

  spPricePreview();
  document.getElementById('sp-offer-modal').hidden = false;
}
function spCloseOffer() { document.getElementById('sp-offer-modal').hidden = true; }

/* Advisory only. The server recomputes tax from app_config and the database
   re-checks that subtotal + tax = total on both rails. */
function spPricePreview() {
  const exempt = false;
  const rate = Number(SP.taxRateMilliPct ?? DEFAULT_TAX_MILLI_PCT);
  const box = (label, dollars) => {
    const sub = Math.round((Number(dollars) || 0) * 100);
    const tax = rate ? Math.round((sub * rate) / 100000) : 0;
    return `<div class="sp-quote"><div class="lbl">${label}</div>
      <div class="big">${spUsd(sub + tax)}<span style="font-size:.8rem;font-weight:400;">/mo</span></div>
      <div class="sp-meta">Service ${spUsd(sub)} · ${exempt ? 'exempt' : `tax ${spUsd(tax)}`}</div></div>`;
  };
  document.getElementById('sp-price-preview').innerHTML =
    box('Bank transfer (ACH)', document.getElementById('sp-ach').value) +
    box('Card', document.getElementById('sp-card').value);
}

function spOfferPayload() {
  return {
    offer_id: document.getElementById('sp-offer-id').value || undefined,
    equipment_id: document.getElementById('sp-offer-equip').value,
    plan_name: document.getElementById('sp-plan-name').value,
    description: document.getElementById('sp-plan-desc').value,
    included_services: document.getElementById('sp-included').value,
    exclusions: document.getElementById('sp-excluded').value,
    ach_monthly_subtotal: document.getElementById('sp-ach').value,
    card_monthly_subtotal: document.getElementById('sp-card').value,
    term_months: Number(document.getElementById('sp-term').value),
    activation_date: document.getElementById('sp-activation').value,
  };
}

async function spSaveOffer(thenSend) {
  const p = spOfferPayload();
  if (!p.equipment_id) { alert('No forklift selected.'); return; }
  const res = await spCall(p.offer_id ? 'update-offer' : 'create-offer', p);
  if (!res) return;
  if (thenSend) {
    const sent = await spCall('send-offer', {
      offer_id: res.offer.id,
      expiry_days: Number(document.getElementById('sp-expiry').value) || 30,
    });
    if (!sent) { await spLoadCustomer(SP.customerId); return; }
  }
  spCloseOffer();
  await spLoadCustomer(SP.customerId);
}

async function spSendOffer(id) {
  if (!confirm('Send this offer to the customer? They will get an email and can sign it.')) return;
  if (await spCall('send-offer', { offer_id: id })) await spLoadCustomer(SP.customerId);
}

async function spCancelOffer(id) {
  const reason = prompt('Cancel this offer? Optional reason:');
  if (reason === null) return;
  if (await spCall('cancel-offer', { offer_id: id, reason })) await spLoadCustomer(SP.customerId);
}


async function spActivateSubscription(id) {
  if (!confirm('Activate this verified service plan with Helcim recurring billing? The signed activation date and amount will be used.')) return;
  const { data: { session } } = await _sb.auth.getSession();
  if (!session) { alert('Your session expired. Please sign in again.'); return; }
  const r = await fetch(`${SUPABASE_URL}/functions/v1/subscription-activate`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${session.access_token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ subscription_id: id }),
  });
  const out = await r.json().catch(() => ({}));
  if (!r.ok) { alert(out.detail || out.error || `Activation failed (${r.status})`); return; }
  alert(out.already_active ? 'Billing is already active.' : 'Recurring billing activated.');
  await spLoadCustomer(SP.customerId);
}

async function spCancelSubscription(id) {
  const reason = prompt('Reason for cancelling future recurring billing (required):', 'Admin cancellation');
  if (reason === null) return;
  if (!reason.trim()) { alert('A cancellation reason is required.'); return; }
  if (!confirm('This will stop FUTURE Helcim subscription charges. Existing charges are not automatically refunded. Continue?')) return;
  const out = await spCall('cancel-subscription', { subscription_id: id, reason: reason.trim() });
  if (out) {
    alert(out.status === 'cancelled' ? 'Future recurring billing cancelled.' : `Cancellation status: ${out.status || 'submitted'}`);
    await spLoadCustomer(SP.customerId);
  }
}

function spWireModals() {
  document.getElementById('sp-equip-save')?.addEventListener('click', async () => {
    const id = document.getElementById('sp-equip-id').value;
    const payload = {
      customer_id: SP.customerId,
      equipment_id: id || undefined,
      unit_number: document.getElementById('sp-eq-unit').value,
      year: document.getElementById('sp-eq-year').value,
      make: document.getElementById('sp-eq-make').value,
      model: document.getElementById('sp-eq-model').value,
      serial_number: document.getElementById('sp-eq-serial').value,
      service_location: document.getElementById('sp-eq-loc').value,
      notes: document.getElementById('sp-eq-notes').value,
    };
    if (await spCall(id ? 'update-equipment' : 'create-equipment', payload)) {
      spCloseEquip();
      await spLoadCustomer(SP.customerId);
    }
  });
  document.getElementById('sp-offer-save')?.addEventListener('click', () => spSaveOffer(false));
  document.getElementById('sp-offer-send')?.addEventListener('click', () => spSaveOffer(true));
  document.getElementById('sp-ach')?.addEventListener('input', spPricePreview);
  document.getElementById('sp-card')?.addEventListener('input', spPricePreview);
}

/* ═══════════════════════════════════════════════════════════════════════════
   RECURRING SUBSCRIPTIONS — V24.6 (admin)

   Company-centric presentation over the unchanged one-forklift-per-subscription
   data model. Grouping happens here, in the view; the contract chain underneath
   is untouched.

   Every number shown comes from the server. Billing history is the existing
   append-only payments ledger joined to the recurring invoices the reconciler
   created — there is no second financial store in this file, and nothing here
   computes money.

   Four controls are deliberately absent: Pause, Resume, provider Cancel and
   Change Term. They require a Helcim PATCH whose request schema is not yet
   verified, and the server reports that in `capabilities`. Rendering a disabled
   button with the reason is honest; rendering a working-looking one is not.
   ═══════════════════════════════════════════════════════════════════════════ */

const RS = { subs: [], health: null, detail: null, refund: null };

const rsUsd  = c => '$' + (Number(c ?? 0) / 100).toFixed(2);
const rsDate = d => d ? new Date(String(d).length === 10 ? d + 'T12:00:00Z' : d)
  .toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' }) : '—';
const rsWhen = d => d ? new Date(d).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' }) : '—';
const rsNum  = v => (v === null || v === undefined || v === '') ? '—' : String(v);

async function rsCall(action, payload) {
  const { data: { session } } = await _sb.auth.getSession();
  if (!session) { alert('Your session expired. Please sign in again.'); return null; }
  const r = await fetch(`${SUPABASE_URL}/functions/v1/service-plans-admin`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${session.access_token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ action, ...payload }),
  });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) { alert(body.detail || body.error || `Request failed (${r.status})`); return null; }
  return body;
}

async function renderSubscriptions() {
  const list = document.getElementById('rs-list');
  list.innerHTML = '<div class="empty-state">Loading…</div>';
  const res = await rsCall('list-subscriptions', {});
  if (!res) { list.innerHTML = '<div class="empty-state">Could not load subscriptions.</div>'; return; }
  RS.subs = res.subscriptions || [];
  RS.health = res.sync_health || null;

  const s = document.getElementById('rs-search');
  const st = document.getElementById('rs-status');
  if (s && !s.dataset.wired) {
    s.dataset.wired = '1';
    s.addEventListener('input', rsPaint);
    st.addEventListener('change', rsPaint);
    document.getElementById('rs-refresh').addEventListener('click', renderSubscriptions);
    document.getElementById('rs-refund-go').addEventListener('click', rsDoRefund);
  }
  rsHealth();
  rsPaint();
}

/* Reconciliation health. This is the screen that catches the failure mode where
   the cron job 403s on a stale worker key: Helcim keeps billing, Apex silently
   stops recording it, and nothing else on the site would show you. */
function rsHealth() {
  const el = document.getElementById('rs-health');
  const h = RS.health;
  if (!h) {
    el.className = 'rs-health warn';
    el.innerHTML = '<b>Recurring sync: UNKNOWN</b><br>No health record yet. Run migration 0009 and let the reconciler run once.';
    return;
  }
  const last = h.last_success_at ? new Date(h.last_success_at) : null;
  const ageMin = last ? Math.floor((Date.now() - last.getTime()) / 60000) : null;
  const stale = ageMin === null || ageMin > 90;
  const forbidden = h.last_forbidden_at &&
    (!last || new Date(h.last_forbidden_at) > last);

  let cls = 'ok', msg = `<b>Recurring sync: Healthy</b><br>Last successful run ${rsWhen(h.last_success_at)}`
    + ` (${ageMin} min ago) via ${esc(h.last_run_source || 'cron')}.`;

  if (forbidden) {
    cls = 'bad';
    msg = `<b>Recurring sync: BLOCKED — worker key rejected</b><br>`
      + `A caller was refused at ${rsWhen(h.last_forbidden_at)}. `
      + `RECURRING_CRON_SETUP.sql still contains the <span class="rs-mono">&lt;RECONCILE_WORKER_KEY&gt;</span> placeholder, `
      + `or the key was rotated without updating the scheduled job.<br>`
      + `<b>Helcim is still billing customers. Apex has stopped recording it.</b>`;
  } else if (stale) {
    cls = 'bad';
    msg = `<b>Recurring sync: WARNING</b><br>`
      + (last ? `No successful run since ${rsWhen(h.last_success_at)} (${ageMin} min ago).`
              : 'No successful run has ever been recorded.')
      + ` Expected every 15 minutes.`
      + (h.last_error ? `<br>Last error: ${esc(h.last_error)}` : '');
  } else if (Number(h.consecutive_failures) > 0) {
    cls = 'warn';
    msg = `<b>Recurring sync: degraded</b><br>${h.consecutive_failures} consecutive failure(s) since the last success at ${rsWhen(h.last_success_at)}.`
      + (h.last_error ? `<br>${esc(h.last_error)}` : '');
  } else if (Number(h.ambiguous_transactions) > 0 || Number(h.provider_errors) > 0) {
    cls = 'warn';
    msg += `<br>Last run left ${h.ambiguous_transactions} ambiguous transaction(s) and hit ${h.provider_errors} provider error(s) — these were not guessed.`;
  }
  el.className = 'rs-health ' + cls;
  el.innerHTML = msg;
}

function rsPaint() {
  const list = document.getElementById('rs-list');
  const q = (document.getElementById('rs-search')?.value || '').toLowerCase().trim();
  const want = document.getElementById('rs-status')?.value || '';
  const LIVE = ['active', 'past_due', 'paused', 'cancel_requested', 'setup_pending', 'method_verified'];

  let rows = RS.subs.filter(s => {
    if (want === 'live' && !LIVE.includes(s.status)) return false;
    if (want && want !== 'live' && s.status !== want) return false;
    if (!q) return true;
    const hay = [s.customer?.company, s.customer?.name, s.equipment?.unit_number,
                 s.equipment?.serial_number, s.equipment?.make, s.equipment?.model,
                 s.provider_subscription_id].filter(Boolean).join(' ').toLowerCase();
    return hay.includes(q);
  });

  if (!rows.length) { list.innerHTML = '<div class="empty-state">No subscriptions match.</div>'; return; }

  // Group by company. The model stays one-per-forklift; only the view groups.
  const byCo = new Map();
  for (const s of rows) {
    const key = s.customer?.company || s.customer?.name || 'Unknown customer';
    if (!byCo.has(key)) byCo.set(key, []);
    byCo.get(key).push(s);
  }

  let html = '';
  for (const [company, subs] of [...byCo.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const liveTotal = subs
      .filter(s => ['active', 'past_due'].includes(s.status))
      .reduce((n, s) => n + Number(s.recurring_total_cents || 0), 0);

    html += `<div class="rs-co">
      <h3>${esc(company)}</h3>
      <div class="rs-coemail">${esc(subs[0].customer?.email || '')}
        · ${subs.length} subscription${subs.length === 1 ? '' : 's'}
        ${liveTotal ? `· <b>${rsUsd(liveTotal)}/month</b> billing now` : ''}</div>`;

    for (const s of subs) {
      const eq = s.equipment || {};
      const label = [eq.year, eq.make, eq.model].filter(Boolean).join(' ') || 'Forklift';
      const lp = s.last_payment;
      html += `<div class="rs-sub">
        <div class="sp-row">
          <div>
            <b>${esc(eq.unit_number || label)}</b>
            <span class="rs-pill ${esc(s.status)}" style="margin-left:8px;">${esc(s.status.replace(/_/g, ' '))}</span>
            ${s.has_failed_payments ? '<span class="rs-pill past_due" style="margin-left:6px;">failed payment</span>' : ''}
            <div class="sp-meta">${esc(label)}${eq.serial_number ? ` · serial ${esc(eq.serial_number)}` : ''}</div>
          </div>
          <button class="approve-btn" type="button" onclick="rsOpenDetail('${s.id}')">Manage</button>
        </div>
        <div class="rs-grid">
          <div class="rs-f"><div class="k">Monthly</div><div class="v">${rsUsd(s.recurring_total_cents)}</div></div>
          <div class="rs-f"><div class="k">Rail</div><div class="v">${s.payment_method === 'ach' ? 'Bank (ACH)' : 'Card'}</div></div>
          <div class="rs-f"><div class="k">Term</div><div class="v">${rsNum(s.term_months)} mo</div></div>
          <div class="rs-f"><div class="k">Billed</div><div class="v">${rsNum(s.times_billed)}</div></div>
          <div class="rs-f"><div class="k">Remaining</div><div class="v">${rsNum(s.remaining_cycles)}</div></div>
          <div class="rs-f"><div class="k">Activated</div><div class="v">${rsDate(s.activated_at || s.activation_date)}</div></div>
          <div class="rs-f"><div class="k">Next billing</div><div class="v">${rsDate(s.next_billing_date)}</div></div>
          <div class="rs-f"><div class="k">Last payment</div><div class="v">${lp ? esc(lp.status) : '—'}</div></div>
          <div class="rs-f"><div class="k">Last sync</div><div class="v">${rsWhen(s.last_synced_at)}</div></div>
          <div class="rs-f"><div class="k">Helcim ID</div><div class="v rs-mono">${rsNum(s.provider_subscription_id)}</div></div>
        </div>
      </div>`;
    }
    html += '</div>';
  }
  list.innerHTML = html;
}

/* ── Detail + billing history ──────────────────────────────────────────── */
async function rsOpenDetail(id) {
  document.getElementById('rs-detail').hidden = false;
  document.getElementById('rs-detail-body').innerHTML = '<div class="empty-state">Loading…</div>';
  const res = await rsCall('subscription-detail', { subscription_id: id });
  if (!res) { rsCloseDetail(); return; }
  RS.detail = res;
  rsPaintDetail();
}
function rsCloseDetail() { document.getElementById('rs-detail').hidden = true; RS.detail = null; }

function rsPaintDetail() {
  const d = RS.detail, s = d.subscription, eq = d.equipment || {}, a = d.agreement || {};
  const cap = d.capabilities || {};
  const label = [eq.year, eq.make, eq.model].filter(Boolean).join(' ') || 'Forklift';
  document.getElementById('rs-detail-title').textContent =
    `${d.customer?.company || d.customer?.name || 'Customer'} — ${eq.unit_number || label}`;

  const facts = [
    ['Status', s.status.replace(/_/g, ' ')],
    ['Monthly total', rsUsd(s.recurring_total_cents)],
    ['Breakdown', `${rsUsd(s.recurring_subtotal_cents)} + ${rsUsd(s.recurring_tax_cents)} tax`],
    ['Rail', s.payment_method === 'ach' ? 'Bank transfer (ACH)' : 'Card'],
    ['Method', s.payment_method_display || '—'],
    ['Agreed term', `${rsNum(s.term_months)} months`],
    ['Max cycles', rsNum(s.max_cycles)],
    ['Times billed', rsNum(s.times_billed)],
    ['Remaining cycles', rsNum(s.remaining_cycles)],
    ['Activation date', rsDate(s.activation_date)],
    ['Activated at', rsWhen(s.activated_at)],
    ['Next billing', rsDate(s.next_billing_date)],
    ['Helcim subscription', rsNum(s.provider_subscription_id)],
    ['Helcim customer', s.provider_customer_code || '—'],
    ['Helcim plan', rsNum(s.provider_payment_plan_id)],
    ['Provider verified', rsWhen(s.provider_verified_at)],
    ['Last synced', rsWhen(s.last_synced_at)],
    ['Signed by', a.signer_name ? `${a.signer_name}${a.signer_title ? ', ' + a.signer_title : ''}` : '—'],
    ['Signed at', rsWhen(a.signed_at)],
    ['Serial', eq.serial_number || '—'],
    ['Service location', eq.service_location || '—'],
  ];

  let html = `<div class="rs-grid" style="grid-template-columns:repeat(auto-fit,minmax(160px,1fr));">
    ${facts.map(([k, v]) => `<div class="rs-f"><div class="k">${esc(k)}</div><div class="v">${esc(v)}</div></div>`).join('')}
  </div>

  <div class="sp-modal-actions" style="justify-content:flex-start;margin-top:16px;">
    <button class="btn-secondary" type="button" onclick="rsSync('${s.id}')"
      ${cap.sync ? '' : 'disabled title="Not created at Helcim yet."'}>Sync with Helcim</button>
    ${rsBtn('Pause', cap.pause, cap.reasons?.pause, `rsPause('${s.id}')`)}
    ${rsBtn('Resume', cap.resume, cap.reasons?.resume, `rsResume('${s.id}')`)}
    ${rsBtn('Change term', cap.change_term, cap.reasons?.change_term, `rsChangeTerm('${s.id}')`)}
    ${rsBtn('Cancel future billing', cap.cancel_provider, cap.reasons?.cancel_provider, `rsCancel('${s.id}')`)}
  </div>
  ${s.status === 'cancelled' ? `<div class="rs-blocked">This subscription is cancelled. Future billing has stopped.
    Past months were <b>not</b> refunded by the cancellation — refund individual cycles below if that is intended.
    Sync and refunds remain available on the history.</div>` : ''}
  ${s.term_change_count ? `<div class="rs-blocked">Term changed ${esc(s.term_change_count)} time(s).
    Signed term ${esc(cap.signed_term_months)} months; current total ${esc(s.max_cycles)} cycles${
      s.previous_max_cycles ? ` (was ${esc(s.previous_max_cycles)})` : ''}.
    ${s.term_change_reason ? `Last reason: ${esc(s.term_change_reason)}` : ''}</div>` : ''}

  <h4 style="margin:22px 0 0;">Billing history</h4>
  <p class="sp-meta">One row per Helcim billing cycle, read from the Apex payments ledger.</p>`;

  if (!d.cycles.length) {
    html += `<div class="empty-state">No billing cycles recorded yet.${
      s.provider_subscription_id ? ' Press Sync to pull them from Helcim.' : ''}</div>`;
  } else {
    for (const c of d.cycles) {
      const p = c.payment;
      const state = !p ? 'no payment row'
        : p.status === 'succeeded' && c.refunded_cents > 0
          ? (c.net_retained_cents === 0 ? 'FULLY REFUNDED' : 'PARTIALLY REFUNDED')
        : p.status.toUpperCase();
      html += `<div class="rs-cycle">
        <div class="num">Cycle<br><b style="font-size:1.1rem;color:#fff;">${rsNum(c.cycle)}</b></div>
        <div>
          <div class="amt">${rsUsd(c.amount_cents)} <span style="font-size:.8rem;font-weight:400;">${esc(state)}</span></div>
          <div class="sub">
            ${rsDate(c.billing_period_start)} – ${rsDate(c.billing_period_end)} · invoice ${esc(c.invoice_id)} (${esc(c.invoice_status)})
            ${p?.provider_transaction_id ? `<br>Helcim transaction <span class="rs-mono">${esc(p.provider_transaction_id)}</span>` : ''}
            ${c.refunded_cents > 0 ? `<br>Original ${rsUsd(c.original_cents)} · refunded ${rsUsd(c.refunded_cents)} · <b>net retained ${rsUsd(c.net_retained_cents)}</b>` : ''}
            ${p?.retry_attempt_count ? `<br>${p.retry_attempt_count} retry attempt(s), last ${rsWhen(p.retry_attempted_at)}` : ''}
          </div>
        </div>
        <div class="sp-actions">
          ${c.refundable ? `<button class="btn-secondary" type="button"
              onclick="rsOpenRefund('${p.id}','${c.invoice_id}',${c.refundable_cents},${c.original_cents},${c.refunded_cents},${c.cycle ?? 'null'})">Refund</button>` : ''}
          ${c.retry_eligible ? `<button class="approve-btn" type="button"
              onclick="rsRetry('${s.id}',${c.cycle})">Retry payment</button>` : ''}
        </div>
      </div>`;
    }
  }

  if (d.events?.length) {
    html += `<h4 style="margin:22px 0 6px;">Recent activity</h4>
      <div class="sp-meta" style="line-height:1.9;">
      ${d.events.slice(0, 12).map(e =>
        `${rsWhen(e.created_at)} — <b>${esc(e.event.replace(/_/g, ' '))}</b> (${esc(e.source)})`).join('<br>')}</div>`;
  }
  document.getElementById('rs-detail-body').innerHTML = html;
}

/* ── Sync — reuses subscription-reconcile, the single reconciliation impl ── */
async function rsSync(id) {
  const { data: { session } } = await _sb.auth.getSession();
  if (!session) { alert('Your session expired.'); return; }
  const btnHost = document.getElementById('rs-detail-body');
  btnHost.insertAdjacentHTML('afterbegin', '<div class="empty-state" id="rs-syncing">Syncing with Helcim…</div>');
  const r = await fetch(`${SUPABASE_URL}/functions/v1/subscription-reconcile`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${session.access_token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ subscription_id: id }),
  });
  const out = await r.json().catch(() => ({}));
  document.getElementById('rs-syncing')?.remove();
  if (!r.ok) { alert(out.detail || out.error || 'Sync failed.'); return; }
  const bits = [`${out.payments_created || 0} new payment(s)`, `${out.invoices_created || 0} new invoice(s)`];
  if (out.ambiguous) bits.push(`${out.ambiguous} ambiguous transaction(s) left unresolved — not guessed`);
  if (out.provider_errors) bits.push(`${out.provider_errors} provider error(s)`);
  alert('Sync complete. ' + bits.join(', ') + '.');
  await rsOpenDetail(id);
  await renderSubscriptions();
}

/* ── Retry a declined cycle ────────────────────────────────────────────── */
async function rsRetry(subId, cycle) {
  if (!confirm(
    `Retry the declined payment for cycle ${cycle}?\n\n`
    + `This asks Helcim to charge the customer's stored payment method again.\n\n`
    + `Helcim also retries failed payments automatically. If the underlying problem `
    + `(expired card, insufficient funds) has not been fixed, this will decline again.\n\n`
    + `Confirm the cause has been corrected before continuing.`)) return;
  const out = await rsCall('retry-payment', { subscription_id: subId, payment_number: cycle });
  if (!out) return;
  alert(out.detail || 'Retry submitted.');
  await rsOpenDetail(subId);
  await renderSubscriptions();
}

/* ── Refund a specific cycle, through the existing payment-refund backend ── */
function rsOpenRefund(paymentId, invoiceId, maxCents, originalCents, refundedCents, cycle) {
  RS.refund = { paymentId, invoiceId, maxCents, cycle };
  document.getElementById('rs-refund-summary').innerHTML = `
    <div class="r"><span>Cycle</span><b>${rsNum(cycle)}</b></div>
    <div class="r"><span>Invoice</span><b class="rs-mono">${esc(invoiceId)}</b></div>
    <div class="r"><span>Original payment</span><b>${rsUsd(originalCents)}</b></div>
    <div class="r"><span>Already refunded</span><b>${rsUsd(refundedCents)}</b></div>
    <div class="r"><span>Remaining refundable</span><b>${rsUsd(maxCents)}</b></div>`;
  document.getElementById('rs-refund-amount').value = (maxCents / 100).toFixed(2);
  document.getElementById('rs-refund-amount').max = (maxCents / 100).toFixed(2);
  document.getElementById('rs-refund-max').textContent =
    `Maximum ${rsUsd(maxCents)}. Enter a smaller amount for a partial refund. `
    + `The server recalculates this limit from the ledger and will refuse anything above it.`;
  document.getElementById('rs-refund-reason').value = '';
  document.getElementById('rs-refund').hidden = false;
}
function rsCloseRefund() { document.getElementById('rs-refund').hidden = true; RS.refund = null; }

async function rsDoRefund() {
  const r = RS.refund; if (!r) return;
  const reason = document.getElementById('rs-refund-reason').value.trim();
  const dollars = Number(document.getElementById('rs-refund-amount').value);
  if (!reason) { alert('A reason is required. It is stored on the ledger and emailed to the customer.'); return; }
  if (!Number.isFinite(dollars) || dollars <= 0) { alert('Enter a refund amount.'); return; }
  const cents = Math.round(dollars * 100);
  if (cents > r.maxCents && !confirm(
    `${rsUsd(cents)} is more than the ${rsUsd(r.maxCents)} this browser believes is refundable.\n\n`
    + `The server will refuse it if that is wrong. Send anyway?`)) return;

  const partial = cents < r.maxCents;
  if (!confirm(`${partial ? 'PARTIAL refund' : 'Full refund'} of ${rsUsd(cents)} for cycle ${r.cycle}.\n\n`
    + `This does NOT cancel the subscription — future months will still bill.\n\nProceed?`)) return;

  const btn = document.getElementById('rs-refund-go');
  btn.disabled = true; btn.textContent = 'Processing…';

  const { data: { session } } = await _sb.auth.getSession();
  const res = await fetch(`${SUPABASE_URL}/functions/v1/payment-refund`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${session.access_token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ payment_id: r.paymentId, amount_cents: cents, reason }),
  });
  const out = await res.json().catch(() => ({}));
  btn.disabled = false; btn.textContent = 'Process refund';

  if (!res.ok) {
    alert(`Refund failed: ${out.message || out.detail || out.error || 'provider error'}`);
    return;
  }
  rsCloseRefund();
  alert(`Refund recorded. The original payment row is preserved; a linked correction was appended to the ledger.`);
  if (RS.detail?.subscription?.id) await rsOpenDetail(RS.detail.subscription.id);
  await renderSubscriptions();
}


/* ── Provider subscription actions (V24.7) ──────────────────────────────────
   Every one of these is a thin caller. Eligibility, the provider read-back and
   the contract rules all live on the server; this file only collects a reason
   and shows what came back. It never decides whether an action is allowed. */

function rsBtn(label, enabled, reason, onclick) {
  return enabled
    ? `<button class="btn-secondary" type="button" onclick="${onclick}">${label}</button>`
    : `<button class="btn-secondary" type="button" disabled title="${esc(reason || 'Not available in this state.')}">${label}</button>`;
}

async function rsProviderAction(action, payload, confirmText, busyLabel) {
  if (confirmText && !confirm(confirmText)) return null;
  const host = document.getElementById('rs-detail-body');
  host.insertAdjacentHTML('afterbegin', `<div class="empty-state" id="rs-busy">${esc(busyLabel)}</div>`);
  const out = await rsCall(action, payload);
  document.getElementById('rs-busy')?.remove();
  return out;
}

async function rsPause(id) {
  const reason = prompt('Why are you pausing this plan?\n\nStored on the subscription, audited, and emailed to the customer.');
  if (reason === null) return;
  if (!reason.trim()) { alert('A reason is required.'); return; }
  const out = await rsProviderAction('pause-subscription', { subscription_id: id, reason: reason.trim() },
    'Pause billing for this subscription?\n\nHelcim will stop charging until you resume. Remaining months are preserved.',
    'Pausing at Helcim…');
  if (!out) return;
  alert('Paused. Helcim confirmed the change before Apex was updated.');
  await rsOpenDetail(id); await renderSubscriptions();
}

async function rsResume(id) {
  const out = await rsProviderAction('resume-subscription', { subscription_id: id },
    'Resume billing for this subscription?\n\nHelcim will start charging again on the next billing date.',
    'Resuming at Helcim…');
  if (!out) return;
  alert('Resumed. Helcim confirmed the change before Apex was updated.');
  await rsOpenDetail(id); await renderSubscriptions();
}

async function rsCancel(id) {
  const reason = prompt('Why are you cancelling this plan?\n\nRequired. Stored on the subscription, audited, and emailed to the customer.');
  if (reason === null) return;
  if (!reason.trim()) { alert('A reason is required.'); return; }
  const out = await rsProviderAction('cancel-subscription', { subscription_id: id, reason: reason.trim() },
    'Cancel this subscription?\n\n'
    + '• Future billing STOPS at Helcim.\n'
    + '• Months already paid are NOT refunded — refund those separately if intended.\n'
    + '• A cancelled subscription CANNOT be resumed. A new plan needs a new signed agreement.\n\n'
    + 'Continue?',
    'Cancelling at Helcim…');
  if (!out) return;
  alert(out.detail || 'Cancelled. Future billing has stopped. No refunds were issued.');
  await rsOpenDetail(id); await renderSubscriptions();
}

async function rsChangeTerm(id) {
  const cap = RS.detail?.capabilities || {};
  const s = RS.detail?.subscription || {};
  const billed = Number(cap.times_billed || 0);
  const current = Number(cap.max_cycles || s.term_months || 0);
  const signed = Number(cap.signed_term_months || 0);

  const raw = prompt(
    `Change the TOTAL number of monthly payments.\n\n`
    + `This is the total over the life of the plan, NOT the number remaining.\n\n`
    + `Already billed: ${billed}\n`
    + `Current total:  ${current}\n`
    + `Signed term:    ${signed}\n\n`
    + `Enter the new TOTAL (minimum ${billed}):`, String(current));
  if (raw === null) return;
  const next = Number(raw);
  if (!Number.isInteger(next) || next < 1) { alert('Enter a whole number of cycles.'); return; }
  if (next < billed) {
    alert(`Helcim has already billed ${billed} time(s). The total cannot go below ${billed}.`);
    return;
  }

  let amendment = false;
  if (next > signed) {
    alert(
      `The signed agreement authorizes ${signed} monthly payments.\n\n`
      + `Extending to ${next} increases what this customer owes. That needs a revised agreement they sign — `
      + `it cannot be done by editing the subscription.\n\n`
      + `Issue a new offer instead.`);
    return;
  }

  const reason = prompt('Why is the term changing?\n\nRequired. Audited against the signed agreement.');
  if (reason === null) return;
  if (!reason.trim()) { alert('A reason is required.'); return; }

  const out = await rsProviderAction('change-term',
    { subscription_id: id, max_cycles: next, reason: reason.trim(), amendment_confirmed: amendment },
    `Change the total from ${current} to ${next} monthly payments?\n\n`
    + `${billed} already billed, so ${Math.max(0, next - billed)} would remain.`,
    'Updating the term at Helcim…');
  if (!out) return;
  alert(`Term updated. Total ${out.max_cycles} cycles, ${out.times_billed} billed, ${out.remaining} remaining.`);
  await rsOpenDetail(id); await renderSubscriptions();
}
