// Server-side only. The Resend key never leaves this process.
const RESEND_URL = "https://api.resend.com/emails";

export const FROM     = () => Deno.env.get("TRANSACTIONAL_FROM_EMAIL") ?? "Apex Lift Solutions <notifications@apexliftsolutionsusa.com>";
export const REPLY_TO = () => Deno.env.get("TRANSACTIONAL_REPLY_TO")   ?? "service@apexliftsolutionsusa.com";
export const SITE     = () => Deno.env.get("PUBLIC_SITE_URL")          ?? "https://apexliftsolutionsusa.com";
const PHONE = "(516) 644-7187";

export async function sendViaResend(to: string, subject: string, html: string, text: string) {
  const r = await fetch(RESEND_URL, {
    method: "POST",
    headers: { "Authorization": `Bearer ${Deno.env.get("RESEND_API_KEY")}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from: FROM(), to: [to], reply_to: REPLY_TO(), subject, html, text }),
  });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`resend_${r.status}:${body?.message ?? "error"}`);
  return body?.id as string | undefined;
}

// ── Formatting helpers ────────────────────────────────────────────────────────
const esc = (s: unknown) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" }[c]!));
const usd = (n: unknown) => "$" + Number(n ?? 0).toFixed(2);
const date = (d: unknown) => d ? new Date(String(d)).toLocaleDateString("en-US", { year:"numeric", month:"long", day:"numeric" }) : "—";
const methodLabel = (m: unknown) => ({ card:"Card", ach:"Bank transfer (ACH)", check:"Check", cash:"Cash", bank_transfer:"Bank transfer", terminal:"Card (in person)", other:"Other" }[String(m)] ?? "Payment");


function totalsHtml(p: Record<string, unknown>): string {
  const sub = Number(p.subtotal ?? 0), tax = Number(p.tax ?? 0);
  if (!sub && !tax) return `<p style="font-size:18px;"><b>Total: ${usd(p.amount)}</b></p>`;
  const rateLbl = p.tax_exempt ? "Sales Tax (exempt)" : `Sales Tax (${Number(p.tax_rate ?? 0).toFixed(3)}%)`;
  return `<table role="presentation" style="width:100%;border-collapse:collapse;font-size:14px;margin:14px 0;">
    <tr><td style="padding:6px 0;color:#666;">Subtotal</td><td style="padding:6px 0;text-align:right;">${usd(sub)}</td></tr>
    <tr><td style="padding:6px 0;color:#666;border-bottom:1px solid #eee;">${esc(rateLbl)}</td><td style="padding:6px 0;text-align:right;border-bottom:1px solid #eee;">${usd(tax)}</td></tr>
    <tr><td style="padding:10px 0;font-size:17px;"><b>Total</b></td><td style="padding:10px 0;text-align:right;font-size:17px;"><b>${usd(p.amount)}</b></td></tr>
  </table>`;
}
function totalsText(p: Record<string, unknown>): string {
  const sub = Number(p.subtotal ?? 0), tax = Number(p.tax ?? 0);
  if (!sub && !tax) return `Total: ${usd(p.amount)}`;
  const rateLbl = p.tax_exempt ? "Sales Tax (exempt)" : `Sales Tax (${Number(p.tax_rate ?? 0).toFixed(3)}%)`;
  return `Subtotal: ${usd(sub)}\n${rateLbl}: ${usd(tax)}\nTotal: ${usd(p.amount)}`;
}

function itemsHtml(items: unknown): string {
  if (!Array.isArray(items) || !items.length) return "";
  const rows = items.map((i: Record<string, unknown>) => {
    const qty = Number(i.qty ?? 1), unit = Number(i.unit_price ?? i.amount ?? 0);
    return `<tr><td style="padding:8px 0;border-bottom:1px solid #eee;">${esc(i.desc)}</td><td style="padding:8px 0;border-bottom:1px solid #eee;text-align:center;">${qty}</td><td style="padding:8px 0;border-bottom:1px solid #eee;text-align:right;">${usd(qty*unit)}</td></tr>`;
  }).join("");
  return `<table role="presentation" style="width:100%;border-collapse:collapse;font-size:14px;margin:16px 0;">
    <tr><th style="text-align:left;padding:8px 0;border-bottom:2px solid #cc0000;font-size:12px;letter-spacing:.08em;color:#666;">DESCRIPTION</th><th style="text-align:center;padding:8px 0;border-bottom:2px solid #cc0000;font-size:12px;letter-spacing:.08em;color:#666;">QTY</th><th style="text-align:right;padding:8px 0;border-bottom:2px solid #cc0000;font-size:12px;letter-spacing:.08em;color:#666;">AMOUNT</th></tr>${rows}</table>`;
}
function itemsText(items: unknown): string {
  if (!Array.isArray(items) || !items.length) return "";
  return "\n" + items.map((i: Record<string, unknown>) => {
    const qty = Number(i.qty ?? 1), unit = Number(i.unit_price ?? i.amount ?? 0);
    return `  • ${i.desc} ×${qty}  ${usd(qty*unit)}`;
  }).join("\n") + "\n";
}

// ── Branded shell ─────────────────────────────────────────────────────────────
function shell(title: string, body: string, cta?: { label: string; href: string }): string {
  return `<!doctype html><html><body style="margin:0;padding:0;background:#f4f4f5;font-family:Arial,Helvetica,sans-serif;color:#1a1a1a;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f5;padding:28px 12px;"><tr><td align="center">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#fff;border-top:4px solid #cc0000;">
  <tr><td style="padding:26px 32px 8px;">
    <div style="font-size:20px;font-weight:900;letter-spacing:.06em;text-transform:uppercase;color:#0b0b0c;">Apex <span style="color:#cc0000;">Lift Solutions</span></div>
    <div style="font-size:11px;letter-spacing:.14em;text-transform:uppercase;color:#888;margin-top:2px;">Forklift repair &amp; preventive maintenance</div>
  </td></tr>
  <tr><td style="padding:16px 32px 0;"><h1 style="margin:0 0 12px;font-size:22px;line-height:1.25;color:#0b0b0c;">${esc(title)}</h1></td></tr>
  <tr><td style="padding:0 32px 8px;font-size:15px;line-height:1.65;">${body}</td></tr>
  ${cta ? `<tr><td style="padding:16px 32px 8px;"><a href="${cta.href}" style="display:inline-block;background:#cc0000;color:#fff;text-decoration:none;font-weight:700;letter-spacing:.06em;text-transform:uppercase;font-size:13px;padding:14px 26px;">${esc(cta.label)}</a></td></tr>` : ""}
  <tr><td style="padding:24px 32px 28px;font-size:13px;line-height:1.6;color:#666;border-top:1px solid #eee;margin-top:16px;">
    Questions? Call <a href="tel:+15166447187" style="color:#cc0000;text-decoration:none;font-weight:700;">${PHONE}</a> or reply to this email.<br>
    Apex Lift Solutions · Nassau &amp; Suffolk County, NY · <a href="${SITE()}" style="color:#888;">${SITE().replace(/^https?:\/\//,"")}</a>
  </td></tr>
</table></td></tr></table></body></html>`;
}
const textFoot = `\n\nQuestions? Call ${PHONE} or reply to this email.\nApex Lift Solutions · Nassau & Suffolk County, NY · ${SITE()}`;
const portal = () => `${SITE()}/portal-login.html`;

// ── Every event → { subject, html, text } ────────────────────────────────────
export function render(eventType: string, p: Record<string, unknown>): { subject: string; html: string; text: string } {
  const name = esc(p.customer_name || "there");
  const co   = p.company ? ` — ${esc(p.company)}` : "";
  switch (eventType) {

    case "quote_created": return {
      subject: `Apex Lift Solutions — Quote ${p.quote_id}`,
      html: shell(`Quote ${esc(p.quote_id)}`,
        `<p>Hi ${name},</p><p>Here is your quote from Apex Lift Solutions.${p.equipment ? ` <b>Equipment:</b> ${esc(p.equipment)}.` : ""}</p>
         ${p.description ? `<p>${esc(p.description)}</p>` : ""}${itemsHtml(p.items)}
         ${totalsHtml(p)}
         <p>Log in to review the full breakdown and approve or decline. Once approved, we'll contact you within 1 business day to schedule.</p>`,
        { label: "Review Quote", href: portal() }),
      text: `Hi ${p.customer_name || "there"},\n\nQuote ${p.quote_id} from Apex Lift Solutions.${p.equipment ? ` Equipment: ${p.equipment}.` : ""}\n${p.description ?? ""}${itemsText(p.items)}${totalsText(p)}\n\nReview and approve or decline: ${portal()}${textFoot}` };

    case "quote_approved": return {
      subject: `Your Apex Quote ${p.quote_id} Has Been Approved`,
      html: shell(`Quote ${esc(p.quote_id)} approved`,
        `<p>Hi ${name},</p><p>Thanks — you've approved quote <b>${esc(p.quote_id)}</b> for <b>${usd(p.amount)}</b>. We'll contact you within 1 business day to schedule the work.</p>`,
        { label: "View in Portal", href: portal() }),
      text: `Hi ${p.customer_name || "there"},\n\nYou've approved quote ${p.quote_id} for ${usd(p.amount)}. We'll contact you within 1 business day to schedule.${textFoot}` };

    case "quote_declined": return {
      subject: `Apex Quote ${p.quote_id} — Declined`,
      html: shell(`Quote ${esc(p.quote_id)} declined`,
        `<p>Hi ${name},</p><p>We've recorded that you declined quote <b>${esc(p.quote_id)}</b>. No further action is needed. If anything changes or you'd like to discuss, call us at ${PHONE}.</p>`),
      text: `Hi ${p.customer_name || "there"},\n\nWe've recorded that you declined quote ${p.quote_id}. If anything changes, call ${PHONE}.${textFoot}` };

    case "quote_approved_admin": return {
      subject: `Quote ${p.quote_id} Approved${co}`,
      html: shell(`Quote ${esc(p.quote_id)} approved${co}`,
        `<p><b>${name}</b>${co} approved quote <b>${esc(p.quote_id)}</b> for <b>${usd(p.amount)}</b> on ${date(p.responded_at)}.</p><p>Next step: convert it to an invoice in the admin portal.</p>`,
        { label: "Open Admin Portal", href: `${SITE()}/portal-admin.html` }),
      text: `${p.customer_name}${co} approved quote ${p.quote_id} for ${usd(p.amount)}.\n\nConvert to invoice: ${SITE()}/portal-admin.html` };

    case "quote_declined_admin": return {
      subject: `Quote ${p.quote_id} Declined${co}`,
      html: shell(`Quote ${esc(p.quote_id)} declined${co}`, `<p><b>${name}</b>${co} declined quote <b>${esc(p.quote_id)}</b> (${usd(p.amount)}). No action required.</p>`),
      text: `${p.customer_name}${co} declined quote ${p.quote_id} (${usd(p.amount)}). No action required.` };

    case "invoice_created": return {
      subject: `Apex Lift Solutions — Invoice ${p.invoice_id}`,
      html: shell(`Invoice ${esc(p.invoice_id)}`,
        `<p>Hi ${name},</p><p>Your invoice is ready.${p.quote_id ? ` This covers the work from quote <b>${esc(p.quote_id)}</b>.` : ""}</p>
         ${p.description ? `<p>${esc(p.description)}</p>` : ""}${itemsHtml(p.items)}
         ${totalsHtml(p)}
         <p style="font-size:15px;"><b>Amount due: ${usd(p.amount)}</b>${p.due ? `<br><span style="font-size:14px;color:#666;">Due ${date(p.due)}</span>` : ""}</p>
         <p>Pay securely online by card or bank transfer (ACH) from your portal.</p>`,
        { label: "View & Pay Invoice", href: portal() }),
      text: `Hi ${p.customer_name || "there"},\n\nInvoice ${p.invoice_id} is ready.${p.quote_id ? ` Covers quote ${p.quote_id}.` : ""}\n${p.description ?? ""}${itemsText(p.items)}${totalsText(p)}\nAmount due: ${usd(p.amount)}${p.due ? `\nDue ${date(p.due)}` : ""}\n\nPay securely: ${portal()}${textFoot}` };

    case "payment_received": return {
      subject: `Payment Received — Apex Invoice ${p.invoice_id}`,
      html: shell(`Payment received`,
        `<p>Hi ${name},</p><p>Thank you — we've received your payment.</p>
         <table role="presentation" style="font-size:14px;line-height:1.9;"><tr><td style="color:#666;padding-right:18px;">Invoice</td><td><b>${esc(p.invoice_id)}</b></td></tr>
         <tr><td style="color:#666;">Invoice amount</td><td><b>${usd(p.amount)}</b></td></tr>
         ${Number(p.fee ?? 0) > 0 ? `<tr><td style="color:#666;">Card convenience fee</td><td>${usd(p.fee)}</td></tr><tr><td style="color:#666;"><b>Total charged</b></td><td><b>${usd(p.total_charged ?? p.amount)}</b></td></tr>` : ""}
         <tr><td style="color:#666;">Date</td><td>${date(p.paid_at)}</td></tr>
         <tr><td style="color:#666;">Method</td><td>${esc(p.method_display || methodLabel(p.method))}</td></tr>
         ${p.reference ? `<tr><td style="color:#666;">Reference</td><td>${esc(p.reference)}</td></tr>` : ""}</table>`,
        { label: "View Receipt", href: portal() }),
      text: `Hi ${p.customer_name || "there"},\n\nPayment received.\nInvoice: ${p.invoice_id}\nInvoice total (incl. tax): ${usd(p.amount)}${Number(p.fee ?? 0) > 0 ? `\nCard convenience fee: ${usd(p.fee)}\nTotal charged: ${usd(p.total_charged ?? p.amount)}` : ""}\nDate: ${date(p.paid_at)}\nMethod: ${p.method_display || methodLabel(p.method)}${p.reference ? `\nReference: ${p.reference}` : ""}\n\nReceipt: ${portal()}${textFoot}` };

    case "payment_received_admin": return {
      subject: `Payment Received — ${p.invoice_id}`,
      html: shell(`Payment received${co}`,
        `<table role="presentation" style="width:100%;border-collapse:collapse;font-size:14px;">
           <tr><td style="padding:6px 0;color:#666;">Customer</td><td style="padding:6px 0;text-align:right;"><b>${name}</b>${co}</td></tr>
           <tr><td style="padding:6px 0;color:#666;">Invoice</td><td style="padding:6px 0;text-align:right;"><b>${esc(p.invoice_id)}</b></td></tr>
           <tr><td style="padding:6px 0;color:#666;border-bottom:1px solid #eee;">Date</td><td style="padding:6px 0;text-align:right;border-bottom:1px solid #eee;">${date(p.paid_at)}</td></tr>
           <tr><td style="padding:6px 0;color:#666;">Subtotal</td><td style="padding:6px 0;text-align:right;">${usd(p.subtotal ?? p.amount)}</td></tr>
           <tr><td style="padding:6px 0;color:#666;">Sales Tax</td><td style="padding:6px 0;text-align:right;">${usd(p.tax ?? 0)}</td></tr>
           <tr><td style="padding:6px 0;color:#666;border-bottom:1px solid #eee;"><b>Invoice Total</b></td><td style="padding:6px 0;text-align:right;border-bottom:1px solid #eee;"><b>${usd(p.amount)}</b></td></tr>
           <tr><td style="padding:6px 0;color:#666;">Payment Method</td><td style="padding:6px 0;text-align:right;">${esc(p.method_display || methodLabel(p.method))}</td></tr>
           ${Number(p.fee ?? 0) > 0 ? `<tr><td style="padding:6px 0;color:#666;">Helcim Fee Saver</td><td style="padding:6px 0;text-align:right;">${usd(p.fee)}</td></tr>` : ""}
           <tr><td style="padding:6px 0;color:#666;"><b>Total Charged</b></td><td style="padding:6px 0;text-align:right;"><b>${usd(p.total_charged ?? p.amount)}</b></td></tr>
           <tr><td style="padding:10px 0 6px;color:#666;">Payment Status</td><td style="padding:10px 0 6px;text-align:right;"><b style="color:#2e7d32;">PAID</b></td></tr>
           ${p.reference ? `<tr><td style="padding:6px 0;color:#666;">Transaction ID</td><td style="padding:6px 0;text-align:right;font-family:monospace;">${esc(p.reference)}</td></tr>` : ""}
         </table>
         <p style="font-size:13px;color:#666;margin-top:16px;">The Fee Saver amount is collected by the processor and is not Apex invoice revenue.</p>`,
        { label: "Open Admin Portal", href: `${SITE()}/portal-admin.html` }),
      text: `Payment Received — ${p.invoice_id}\n\n` +
            `Customer: ${p.customer_name}${co}\nInvoice: ${p.invoice_id}\nDate: ${date(p.paid_at)}\n\n` +
            `Subtotal: ${usd(p.subtotal ?? p.amount)}\nSales Tax: ${usd(p.tax ?? 0)}\nInvoice Total: ${usd(p.amount)}\n\n` +
            `Payment Method: ${p.method_display || methodLabel(p.method)}\n` +
            (Number(p.fee ?? 0) > 0 ? `Helcim Fee Saver: ${usd(p.fee)}\n` : "") +
            `Total Charged: ${usd(p.total_charged ?? p.amount)}\n\nPayment Status: PAID\n` +
            (p.reference ? `Transaction ID: ${p.reference}\n` : "") };

    case "ach_submitted": return {
      subject: `Bank Payment Submitted — Invoice ${p.invoice_id}`,
      html: shell(`Bank payment submitted`,
        `<p>Hi ${name},</p><p>Your bank payment of <b>${usd(p.amount)}</b> for invoice <b>${esc(p.invoice_id)}</b> has been submitted.</p>
         <p style="background:#fff8e6;border-left:3px solid #f0a500;padding:12px 14px;">Bank transfers take a few business days to clear. Your invoice will show <b>Payment Pending</b> until the bank confirms, and you'll get a second email when it's complete.</p>`,
        { label: "View Invoice", href: portal() }),
      text: `Hi ${p.customer_name || "there"},\n\nYour bank payment of ${usd(p.amount)} for invoice ${p.invoice_id} has been submitted. Bank transfers take a few business days to clear — you'll get another email when it completes.${textFoot}` };

    case "ach_submitted_admin": return {
      subject: `ACH Submitted — Invoice ${p.invoice_id}${co}`,
      html: shell(`Bank payment submitted${co}`,
        `<p>${name}${co} submitted a bank payment for invoice <b>${esc(p.invoice_id)}</b>.</p>
         <table role="presentation" style="width:100%;border-collapse:collapse;font-size:14px;">
           <tr><td style="padding:6px 0;color:#666;">Invoice Total</td><td style="padding:6px 0;text-align:right;"><b>${usd(p.amount)}</b></td></tr>
           <tr><td style="padding:6px 0;color:#666;">Payment Method</td><td style="padding:6px 0;text-align:right;">Bank transfer (ACH)</td></tr>
           <tr><td style="padding:6px 0;color:#666;">Payment Status</td><td style="padding:6px 0;text-align:right;"><b style="color:#f0a500;">PENDING SETTLEMENT</b></td></tr>
           ${p.reference ? `<tr><td style="padding:6px 0;color:#666;">Transaction ID</td><td style="padding:6px 0;text-align:right;font-family:monospace;">${esc(p.reference)}</td></tr>` : ""}
         </table>
         <p style="font-size:13px;color:#666;margin-top:14px;">The invoice stays at Payment Pending until the bank clears it. You'll get a second email when it settles.</p>`),
      text: `${p.customer_name}${co} submitted ACH ${usd(p.amount)} for invoice ${p.invoice_id}. Pending settlement.` };

    case "payment_declined": return {
      subject: `Payment Not Completed — Invoice ${p.invoice_id}`,
      html: shell(`Payment not completed`,
        `<p>Hi ${name},</p><p>A payment attempt for invoice <b>${esc(p.invoice_id)}</b> (${usd(p.amount)}) didn't go through. Your invoice is still open — you can try again from your portal, or call us at ${PHONE} if you'd like to pay another way.</p>`,
        { label: "Try Again", href: portal() }),
      text: `Hi ${p.customer_name || "there"},\n\nA payment attempt for invoice ${p.invoice_id} (${usd(p.amount)}) didn't go through. The invoice is still open. Try again: ${portal()}${textFoot}` };

    case "payment_refunded": return {
      subject: `Refund Issued — Invoice ${p.invoice_id}`,
      html: shell(`Refund issued`, `<p>Hi ${name},</p><p>A refund of <b>${usd(p.amount)}</b> has been issued for invoice <b>${esc(p.invoice_id)}</b>${p.reference ? ` (ref ${esc(p.reference)})` : ""}. Depending on your bank it may take several business days to appear.</p>`),
      text: `Hi ${p.customer_name || "there"},\n\nA refund of ${usd(p.amount)} was issued for invoice ${p.invoice_id}. It may take several business days to appear.${textFoot}` };

    case "payment_refunded_admin": return {
      subject: `Refund Issued — Invoice ${p.invoice_id}${co}`,
      html: shell(`Refund issued${co}`, `<p>Refund of <b>${usd(p.amount)}</b> on invoice <b>${esc(p.invoice_id)}</b> for ${name}${co}.${p.reference ? ` Ref ${esc(p.reference)}.` : ""}</p>`),
      text: `Refund of ${usd(p.amount)} on invoice ${p.invoice_id} for ${p.customer_name}${co}.` };


    case "registration_admin": return {
      subject: `New Portal Registration — ${p.name || p.email}`,
      html: shell(`New portal registration`,
        `<table role="presentation" style="font-size:14px;line-height:1.9;"><tr><td style="color:#666;padding-right:18px;">Name</td><td><b>${esc(p.name)}</b></td></tr><tr><td style="color:#666;">Email</td><td>${esc(p.email)}</td></tr><tr><td style="color:#666;">Company</td><td>${esc(p.company || "—")}</td></tr><tr><td style="color:#666;">Phone</td><td>${esc(p.phone || "—")}</td></tr></table>
         <p>Status: <b>PENDING</b>. Review and activate in the admin portal.</p>`,
        { label: "Review in Admin Portal", href: `${SITE()}/portal-admin.html` }),
      text: `New portal registration\nName: ${p.name}\nEmail: ${p.email}\nCompany: ${p.company || "—"}\nPhone: ${p.phone || "—"}\n\nStatus: PENDING — activate at ${SITE()}/portal-admin.html` };

    case "account_activated": return {
      subject: `Your Apex Lift Solutions Portal Account Is Active`,
      html: shell(`Your account is active`,
        `<p>Hi ${name},</p><p>Your Apex client portal account has been approved. You can now sign in to view quotes, approve work, see invoices, pay online, and track your service history.</p>`,
        { label: "Sign In", href: portal() }),
      text: `Hi ${p.customer_name || "there"},\n\nYour Apex client portal account has been approved. Sign in: ${portal()}${textFoot}` };

    case "service_request_admin": {
      const urg = String(p.urgency ?? "normal").toUpperCase();
      return {
        subject: `${urg === "EMERGENCY" ? "🚨 " : ""}Service Request [${urg}] — ${p.customer_name}${co}`,
        html: shell(`Service request${co}`,
          `<table role="presentation" style="font-size:14px;line-height:1.9;"><tr><td style="color:#666;padding-right:18px;">Customer</td><td><b>${name}</b>${co}</td></tr>
           <tr><td style="color:#666;">Email</td><td>${esc(p.customer_email)}</td></tr><tr><td style="color:#666;">Urgency</td><td><b style="color:${urg==="EMERGENCY"?"#cc0000":urg==="URGENT"?"#f0a500":"#333"};">${urg}</b></td></tr>
           <tr><td style="color:#666;">Equipment</td><td>${esc(p.equipment || "—")}</td></tr><tr><td style="color:#666;">Issue type</td><td>${esc(p.issue_type || "—")}</td></tr>
           <tr><td style="color:#666;">Attachments</td><td>${Number(p.attachment_count ?? 0)} — view in admin portal</td></tr></table>
           <p style="background:#f7f7f7;padding:12px 14px;white-space:pre-wrap;">${esc(p.description)}</p>`,
          { label: "Open Request", href: `${SITE()}/portal-admin.html` }),
        text: `Service request [${urg}] from ${p.customer_name}${co}\nEmail: ${p.customer_email}\nEquipment: ${p.equipment || "—"}\nIssue: ${p.issue_type || "—"}\nAttachments: ${p.attachment_count ?? 0}\n\n${p.description}\n\n${SITE()}/portal-admin.html` };
    }

    case "contact_request_service": return {
      subject: `Website Service Request — ${p.company || p.name}`,
      html: shell(`Website service request`,
        `<table role="presentation" style="font-size:14px;line-height:1.9;">${["company","name","phone","email","zip","make_model","machine_down"].map(k => p[k] ? `<tr><td style="color:#666;padding-right:18px;text-transform:capitalize;">${k.replace("_"," ")}</td><td><b>${esc(p[k])}</b></td></tr>` : "").join("")}</table>
         <p style="background:#f7f7f7;padding:12px 14px;white-space:pre-wrap;">${esc(p.issue)}</p>`),
      text: Object.entries(p).map(([k,v]) => `${k}: ${v}`).join("\n") };

    case "contact_careers": return {
      subject: `Job Application — ${p.name}`,
      html: shell(`Job application`, `<table role="presentation" style="font-size:14px;line-height:1.9;">${Object.entries(p).filter(([k]) => k !== "about").map(([k,v]) => `<tr><td style="color:#666;padding-right:18px;">${esc(k)}</td><td>${esc(v)}</td></tr>`).join("")}</table><p style="background:#f7f7f7;padding:12px 14px;white-space:pre-wrap;">${esc(p.about)}</p>`),
      text: Object.entries(p).map(([k,v]) => `${k}: ${v}`).join("\n") };

    default:
      return { subject: `Apex Lift Solutions — ${eventType}`, html: shell(eventType, `<pre>${esc(JSON.stringify(p, null, 2))}</pre>`), text: JSON.stringify(p, null, 2) };
  }
}
