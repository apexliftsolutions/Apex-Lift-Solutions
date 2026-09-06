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
    unpaid: 'badge-unpaid', active: 'badge-active', hidden: 'badge-hidden'
  };
  return `<span class="badge ${map[s] || ''}">${s}</span>`;
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

  // Which invoices already have a live Helcim attempt? An admin must not be
  // invited to hand-record a payment the processor is still confirming.
  const _live = {};
  try {
    const { data: lp } = await _sb.from('payments')
      .select('invoice_id, status')
      .eq('provider', 'helcim').in('status', ['initiated', 'pending', 'unknown', 'succeeded']);
    const rank = { succeeded: 4, pending: 3, unknown: 2, initiated: 1 };
    (lp || []).forEach(p => {
      const cur = _live[p.invoice_id];
      if (!cur || rank[p.status] > rank[cur.status]) _live[p.invoice_id] = p;
    });
  } catch (e) { console.warn('[Apex] could not load live payment attempts', e); }

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
        ${i.status === 'unpaid' ? `${payActionHtml(i, _live[i.id])}` : ''}
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
function payActionHtml(inv, live) {
  if (inv.status === 'paid') {
    const how = inv.paid_via === 'helcim' ? 'Online' : 'Offline';
    return `<span class="badge badge-paid">Paid</span>
            <div style="font-size:.66rem;color:var(--grey);margin-top:3px;">${esc(how)}</div>`;
  }
  if (inv.status === 'payment_pending' || (live && live.status === 'pending')) {
    return `<span class="badge badge-pending">Payment Pending</span>
            <div style="font-size:.66rem;color:var(--grey);margin-top:3px;">Bank payment clearing</div>`;
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
  // Last line of defence: refuse to open the offline form when the processor
  // already has something for this invoice.
  const { data: existing } = await _sb.from('payments').select('status')
    .eq('invoice_id', id).eq('provider', 'helcim')
    .in('status', ['initiated', 'pending', 'unknown', 'succeeded']);
  if ((existing || []).length) {
    alert(`Invoice ${id} already has an online payment attempt (status: ${existing[0].status}).\n\n` +
          `Recording an offline payment would create a second record for the same money.\n\n` +
          `Use Review instead to reconcile it against Helcim.`);
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

// Admin refund — uses the privileged server path. Customers cannot reach this.
async function refundPayment(paymentId, invoiceId, maxAmount) {
  const amt = prompt(`Refund amount for ${invoiceId} (max $${(maxAmount/100).toFixed(2)}):`, (maxAmount/100).toFixed(2));
  if (amt == null) return;
  if (!confirm(`Refund $${parseFloat(amt).toFixed(2)} on ${invoiceId}? This sends money back to the customer and cannot be undone.`)) return;
  const { data: { session } } = await _sb.auth.getSession();
  const r = await fetch(`${SUPABASE_URL}/functions/v1/payment-refund`, {
    method: 'POST', headers: { 'Authorization': `Bearer ${session.access_token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ payment_id: paymentId, amount: parseFloat(amt) }),
  });
  const out = await r.json();
  showToast(r.ok ? `✓ Refund issued on ${invoiceId}` : `Refund failed: ${out.error || 'unknown'}`);
  renderInvoices();
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
