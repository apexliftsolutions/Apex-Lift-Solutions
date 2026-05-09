// =============================================
//  APEX LIFT SOLUTIONS — portal-customer.js
//  Customer portal logic. Depends on:
//    - supabase.min.js (CDN, loaded before this)
//    - emailjs (CDN, loaded before this)
//  Self-contained — does not use portal-data.js
//  so it can run independently of the admin flow.
// =============================================

const SB_URL  = 'https://cjtezsgfdfijmdxzzbiq.supabase.co';
const SB_KEY  = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImNqdGV6c2dmZGZpam1keHp6YmlxIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzgxNjg2OTIsImV4cCI6MjA5Mzc0NDY5Mn0.FkfIFgm5TUKa05nK4QQWdBRgK2cv3oPvq5MQArEUqbw';
const ADMIN   = 'admin@apexliftsolutionsusa.com';
const EJS_SVC = 'service_lfi9ixk';
const EJS_TPL = 'template_jpqlmic';

const sb = supabase.createClient(SB_URL, SB_KEY);

// ── STATE ─────────────────────────────────────
let USER      = null;  // { id, email, name, company }
let PAY_ID    = null;
let REQ_FILES = [];

// ── BOOT ──────────────────────────────────────
(async function boot() {
  emailjs.init('P0tnD3LQqQ6Pujijz');
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

    // Handle Stripe success redirect (?paid=INV-XXXX)
    const params = new URLSearchParams(window.location.search);
    const paidId = params.get('paid');
    if (paidId) {
      await sb.from('invoices').update({ status: 'paid', paid_at: new Date().toISOString() }).eq('id', paidId);
      history.replaceState({}, '', 'portal-customer.html');
      showBanner('✓ Payment confirmed! A receipt will be sent to your email.', 'ok');
      showView('invoices', document.querySelector('[onclick*="invoices"]'));
    } else {
      loadQuotes();
      // Check for pending quotes and show a notification banner
      checkPendingQuotes();
    }
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
      .eq('invoiced', false);
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
async function emailAdmin(subject, message) {
  for (const addr of [ADMIN, 'apexliftsolutions1@gmail.com']) {
    try {
      await emailjs.send(EJS_SVC, EJS_TPL, { to_email: addr, to_name: 'Apex Lift Solutions', subject, message });
    } catch (e) { console.error('Email failed:', addr, e); }
  }
}

// ── DATE + BADGE HELPERS ──────────────────────
function bdate(d) { return d ? new Date(d).toLocaleDateString('en-US') : '—'; }

function badgeHtml(s) {
  const cls = {
    pending: 'badge-pending', approved: 'badge-approved', declined: 'badge-declined',
    paid: 'badge-paid', unpaid: 'badge-unpaid', completed: 'badge-completed'
  }[s] || 'badge-pending';
  return `<span class="badge ${cls}">${xss(s)}</span>`;
}

// ── ATTACHMENT RENDERER ───────────────────────
function attHtml(urls) {
  if (!urls?.length) return '';
  const items = urls.map(url => {
    const raw   = decodeURIComponent(url.split('/').pop().split('?')[0]);
    const name  = raw.replace(/^\d+_/, '');
    const short = name.length > 18 ? name.slice(0, 16) + '…' : name;
    if (url.toLowerCase().endsWith('.pdf')) {
      return `<a href="${url}" target="_blank" class="att-pdf-box" title="${xss(name)}"><span>📄</span><small>${xss(short)}</small></a>`;
    }
    return `<a href="${url}" target="_blank" class="att-link" title="${xss(name)}"><img src="${url}" alt="${xss(name)}" loading="lazy" onerror="this.parentElement.style.display='none'"/></a>`;
  }).join('');
  return `<div style="margin-top:12px;">
    <div style="font-family:var(--font-head);font-size:.63rem;font-weight:700;letter-spacing:.12em;text-transform:uppercase;color:var(--grey);margin-bottom:8px;">📎 Attachments — click to view</div>
    <div class="att-grid">${items}</div>
  </div>`;
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

  const { data: quotes, error } = await sb
    .from('quotes').select('*')
    .eq('customer_id', USER.id)
    .eq('invoiced', false)
    .order('created_at', { ascending: false });

  if (error) { wrap.innerHTML = `<div class="empty-state" style="color:#ff4444;">Error: ${xss(error.message)}</div>`; return; }
  if (!quotes?.length) { wrap.innerHTML = '<div class="empty-state">No quotes yet — contact us or use Request Service to get started!</div>'; return; }

  wrap.innerHTML = '<div class="q-cards">' + quotes.map(q => `
    <div class="q-card">
      <div class="q-hdr">
        <span class="q-id">${xss(q.id)}</span>
        <div style="display:flex;align-items:center;gap:12px;">${badgeHtml(q.status)}<span class="q-amt">$${parseFloat(q.amount).toFixed(2)}</span></div>
      </div>
      ${q.description ? `<div class="q-desc">${xss(q.description)}</div>` : ''}
      ${lineItemsHtml(q.items)}
      ${attHtml(q.attachments)}
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
          ? `<p style="color:#4caf50;font-size:.88rem;font-weight:600;margin-top:6px;">✓ Approved on ${bdate(q.responded_at)} — we'll contact you to schedule.</p>`
          : `<div style="display:flex;align-items:center;gap:14px;flex-wrap:wrap;margin-top:6px;">
               <p style="color:#ff4444;font-size:.88rem;margin:0;">Declined on ${bdate(q.responded_at)}.</p>
               <button class="decline-btn" style="padding:6px 14px;font-size:.72rem;" onclick="removeQuote('${xss(q.id)}')">🗑 Remove</button>
             </div>`
      }
    </div>`).join('') + '</div>';
}

// ── LOAD INVOICES ─────────────────────────────
async function loadInvoices() {
  const wrap = document.getElementById('invoices-wrap');
  if (!USER) return;
  wrap.innerHTML = '<div class="loading-msg">Loading invoices…</div>';

  const { data: invoices, error } = await sb
    .from('invoices').select('*')
    .eq('customer_id', USER.id)
    .order('created_at', { ascending: false });

  if (error) { wrap.innerHTML = `<div class="empty-state" style="color:#ff4444;">Error: ${xss(error.message)}</div>`; return; }

  // Show unpaid always; show paid invoices for 90 days (receipt window); hide hidden
  const now = Date.now();
  const visible = (invoices || []).filter(i => {
    if (i.status === 'hidden') return false;
    if (i.status === 'paid') return (now - new Date(i.paid_at || 0).getTime()) < 90 * 864e5;
    return true;
  });

  if (!visible.length) { wrap.innerHTML = '<div class="empty-state">No outstanding invoices. All paid up! 🎉</div>'; return; }

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
          <button class="print-btn" onclick="printReceipt('" + i.id + "')">🖨 Print Receipt</button>
          <p style="color:var(--grey);font-size:.8rem;">Questions? Call (516) 644-7187.</p>
         </div>`
      : `${workSummary}<button class="approve-btn" onclick="openPay('${xss(i.id)}',${parseFloat(i.amount)})">💳 Pay Now — $${parseFloat(i.amount).toFixed(2)}</button>`;

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

  if (error) { wrap.innerHTML = `<div class="empty-state" style="color:#ff4444;">Error: ${xss(error.message)}</div>`; return; }
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
        const { error } = await sb.from('quotes')
          .update({ status: response, responded_at: new Date().toISOString() })
          .eq('id', id).eq('customer_id', USER.id);
        if (error) throw error;
        closeConfirm();
        emailAdmin(
          `Quote ${id} ${isApprove ? 'APPROVED ✓' : 'DECLINED ✗'} — ${USER.name}`,
          `Customer: ${USER.name}\nCompany: ${USER.company || '—'}\nEmail: ${USER.email}\n\nQuote ${id} has been ${response.toUpperCase()} by the customer.\n\n${isApprove
            ? 'Log in to the admin portal to convert to an invoice:\napexliftsolutionsusa.com/portal-admin.html'
            : 'No action required — customer declined.'}`
        );
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

// ── PAY INVOICE ───────────────────────────────
// ─────────────────────────────────────────────────────────────────────────────
// STRIPE INTEGRATION
// ─────────────────────────────────────────────────────────────────────────────
// When you're ready to go live:
//
// 1. Create a product + price in your Stripe dashboard
//    (or use Payment Links, or create a price dynamically via your backend).
//
// 2. Replace the openPay() body below with a Stripe Checkout redirect:
//
//    const stripe = Stripe('pk_live_YOUR_PUBLISHABLE_KEY');
//    const { error } = await stripe.redirectToCheckout({
//      lineItems: [{ price: 'price_YOUR_PRICE_ID', quantity: 1 }],
//      mode: 'payment',
//      successUrl: window.location.origin + '/portal-customer.html?paid=' + id,
//      cancelUrl:  window.location.origin + '/portal-customer.html',
//    });
//    if (error) showBanner(error.message, 'err');
//
// 3. Remove the "Demo mode" notice from the modal markup in portal-customer.html.
//
// 4. The ?paid= redirect is already handled in boot() above — it marks the
//    invoice paid in Supabase when the customer returns from Stripe.
//
// Until then, the modal shows a clear notice that payment is not yet live.
// ─────────────────────────────────────────────────────────────────────────────

function openPay(id, amount) {
  PAY_ID = id;
  document.getElementById('modal-inv-id').textContent  = id;
  document.getElementById('modal-inv-amt').textContent = '$' + Number(amount).toFixed(2);
  document.getElementById('pay-success-block').style.display = 'none';
  document.getElementById('pay-setup-notice').style.display  = 'block';
  document.getElementById('pay-modal').className = 'modal-overlay open';
}

function closePayModal() {
  document.getElementById('pay-modal').className = 'modal-overlay';
  PAY_ID = null;
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
    box.innerHTML = `<div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:12px;">
      <div>
        <div style="font-family:var(--font-head);font-weight:900;font-size:1rem;color:var(--white);">${xss(row.id)}</div>
        <div style="color:var(--grey-light);font-size:.86rem;margin-top:3px;">${xss(row.description || '')}</div>
        <div style="color:var(--grey);font-size:.76rem;margin-top:3px;">Due: ${bdate(row.due)}</div>
      </div>
      <div style="text-align:right;">
        <div style="font-family:var(--font-head);font-size:1.6rem;font-weight:900;color:var(--red);">$${parseFloat(row.amount).toFixed(2)}</div>
        ${row.status === 'unpaid'
          ? `<button class="approve-btn" style="margin-top:8px;" onclick="openPay('${xss(row.id)}',${parseFloat(row.amount)})">💳 Pay Now</button>`
          : `<span style="color:#4caf50;font-weight:700;font-family:var(--font-head);font-size:.88rem;">✓ Already Paid</span>`}
      </div>
    </div>`;
  } else {
    box.innerHTML = '<p style="color:#ff4444;font-family:var(--font-head);font-weight:700;font-size:.85rem;">Invoice not found on your account. Call (516) 644-7187 for help.</p>';
  }
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
          const { data: pub } = sb.storage.from('apex-uploads').getPublicUrl(safePath);
          urls.push(pub.publicUrl);
        } else {
          console.error('Upload failed:', upErr.message);
        }
      }
    }

    const { data: savedReq, error: reqErr } = await sb.from('service_requests').insert({
      customer_id:    USER.id,
      customer_email: USER.email,
      customer_name:  USER.name,
      company:        USER.company || '',
      equipment:      equip || '',
      issue_type:     type  || '',
      description:    desc,
      urgency,
      attachments:    urls.length ? urls : null,
      status:         'open'
    }).select().single();

    if (reqErr) console.error('Service request save error:', reqErr);

    const fileLinks = urls.length ? '\n\nPhoto attachments:\n' + urls.map((u, i) => `${i + 1}. ${u}`).join('\n') : '';
    await emailAdmin(
      `⚠️ Service Request [${urgency.toUpperCase()}] — ${USER.name} (${savedReq?.id || 'REQ'})`,
      `Customer: ${USER.name}\nCompany: ${USER.company || '—'}\nEmail: ${USER.email}\nRequest ID: ${savedReq?.id || '—'}\n\nEquipment: ${equip || 'Not specified'}\nIssue Type: ${type || 'Not specified'}\nUrgency: ${urgency.toUpperCase()}\n\nDescription:\n${desc}${fileLinks}\n\nView in admin portal:\napexliftsolutionsusa.com/portal-admin.html`
    );

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
  document.getElementById('view-' + v).classList.add('active');
  if (el) el.classList.add('active');
  if (v === 'quotes')   loadQuotes();
  if (v === 'invoices') loadInvoices();
  if (v === 'history')  loadHistory();
  if (v === 'account')  loadAccount();
  const titles = { quotes: 'My Quotes', invoices: 'My Invoices', pay: 'Pay Invoice', history: 'Service History', request: 'Request Service', account: 'My Account' };
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
  const { error } = await sb.from('quotes').update({ invoiced: true }).eq('id', id).eq('customer_id', USER.id);
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
    const { error } = await sb.from('customers').update({ name, company, phone }).eq('id', USER.id);
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
async function printReceipt(invoiceId) {
  const { data: invArr } = await sb.from('invoices').select('*').eq('id', invoiceId).eq('customer_id', USER.id);
  const inv = invArr?.[0];
  if (!inv) return;

  const itemRows = inv.items?.map(i => {
    const qty  = parseFloat(i.qty)  || 1;
    const unit = parseFloat(i.unit_price || i.amount || 0);
    return `<tr><td style="padding:8px 12px;border-bottom:1px solid #eee;">${xss(i.desc||'Service')}</td><td style="padding:8px 12px;border-bottom:1px solid #eee;text-align:center;">${qty}</td><td style="padding:8px 12px;border-bottom:1px solid #eee;text-align:right;">$${(qty*unit).toFixed(2)}</td></tr>`;
  }).join('') || '<tr><td colspan="3" style="padding:8px 12px;color:#666;">See invoice for details</td></tr>';

  const win = window.open('', '_blank');
  win.document.write(`<!DOCTYPE html><html><head><title>Receipt — ${xss(inv.id)}</title>
  <style>body{font-family:Arial,sans-serif;color:#111;max-width:680px;margin:40px auto;padding:0 20px;}
  h1{font-size:2rem;margin-bottom:4px;}
  .red{color:#cc0000;} .grey{color:#666;font-size:.9rem;}
  table{width:100%;border-collapse:collapse;margin:24px 0;}
  th{background:#f5f5f5;padding:10px 12px;text-align:left;font-size:.8rem;letter-spacing:.08em;text-transform:uppercase;}
  .total{text-align:right;font-size:1.3rem;font-weight:700;margin-top:8px;}
  .paid-stamp{display:inline-block;border:3px solid #4caf50;color:#4caf50;padding:6px 18px;font-size:1.1rem;font-weight:700;letter-spacing:.1em;text-transform:uppercase;transform:rotate(-3deg);margin-bottom:16px;}
  @media print{button{display:none;}}</style></head><body>
  <h1>Apex Lift <span class="red">Solutions</span></h1>
  <p class="grey">(516) 644-7187 · info@apexliftsolutionsusa.com · apexliftsolutionsusa.com</p>
  <p class="grey">Nassau &amp; Suffolk County, Long Island, NY</p>
  <hr style="margin:20px 0;border:none;border-top:2px solid #cc0000;"/>
  <div class="paid-stamp">✓ PAID</div>
  <table style="margin-bottom:8px;"><tr><td><strong>Invoice #</strong></td><td>${xss(inv.id)}</td></tr>
  <tr><td><strong>Customer</strong></td><td>${xss(inv.customer_name||USER.name)}</td></tr>
  <tr><td><strong>Company</strong></td><td>${xss(inv.company||USER.company||'—')}</td></tr>
  <tr><td><strong>Paid On</strong></td><td>${new Date(inv.paid_at||inv.created_at).toLocaleDateString('en-US',{year:'numeric',month:'long',day:'numeric'})}</td></tr>
  ${inv.quote_id ? `<tr><td><strong>Quote Ref</strong></td><td>${xss(inv.quote_id)}</td></tr>` : ''}
  </table>
  <table><thead><tr><th>Description</th><th style="text-align:center;">Qty</th><th style="text-align:right;">Amount</th></tr></thead>
  <tbody>${itemRows}</tbody></table>
  <div class="total">Total Paid: $${parseFloat(inv.amount).toFixed(2)}</div>
  <p class="grey" style="margin-top:32px;">Thank you for your business. For questions, call (516) 644-7187 or email service@apexliftsolutionsusa.com.</p>
  <button onclick="window.print()" style="margin-top:20px;padding:10px 24px;background:#cc0000;color:#fff;border:none;font-size:1rem;cursor:pointer;">Print / Save as PDF</button>
  </body></html>`);
  win.document.close();
}
