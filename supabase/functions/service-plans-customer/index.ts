// =============================================================================
//  APEX LIFT SOLUTIONS — service-plans-customer/index.ts
//
//  Actions:
//    preview-agreement   build the contract the customer is about to sign
//    sign                accept the offer + create the immutable agreement + PDF
//    agreement-url       short-lived signed URL for one agreement
//    decline-offer
//
//  DEPLOY: supabase functions deploy service-plans-customer
//
//  AUTHORITY
//    The browser sends an offer_id, a rail ('card' | 'ach'), the signer's name
//    and title, the typed signature, and four consent booleans. That is the
//    complete list. It does NOT send prices, customer identity, equipment
//    identity, term, activation date, or contract text — all of that is read
//    out of the database here and, for the money, read AGAIN inside
//    accept_offer_and_sign_agreement, which is where the authoritative amount
//    actually comes from.
//
//  LEGAL REVIEW REQUIRED
//    The agreement body below is a neutral business draft. Fixed-term / no-cancellation language,
//    failed-payment consequences, the ACH-vs-card price differential and
//    electronic-signature enforceability have NOT been reviewed by counsel.
//    While app_config.service_plan_contract_mode <> 'live', every page of the
//    PDF is stamped DRAFT so nobody mistakes one for an executed contract.
//
//  NO PAYMENT DETAILS ARE COLLECTED HERE. Phase C ends at the signature.
// =============================================================================
import { createClient } from "jsr:@supabase/supabase-js@2";
import { PDFDocument, StandardFonts, rgb } from "https://esm.sh/pdf-lib@1.17.1";

const FN_VERSION = "2026-09-07.v24.3";
const ADMIN_EMAIL = Deno.env.get("ADMIN_EMAIL") ?? "admin@apexliftsolutionsusa.com";
const SB_URL = Deno.env.get("SUPABASE_URL")!;
const SB_SERVICE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const SB_ANON = Deno.env.get("SUPABASE_ANON_KEY")!;
const BUCKET = "apex-agreements";
const SIGNED_URL_TTL = 300; // 5 minutes

const ALLOWED_ORIGIN = Deno.env.get("PUBLIC_SITE_URL")
  ?? Deno.env.get("APP_BASE_URL")
  ?? "https://apexliftsolutionsusa.com";

const cors = {
  "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const j = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...cors, "Content-Type": "application/json" } });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) return j({ error: "unauthorized" }, 401);

    const userClient = createClient(SB_URL, SB_ANON, { global: { headers: { Authorization: authHeader } } });
    const { data: { user }, error: authErr } = await userClient.auth.getUser();
    if (authErr || !user) return j({ error: "unauthorized" }, 401);

    const db = createClient(SB_URL, SB_SERVICE);
    const body = await req.json().catch(() => ({}));
    const action = String(body.action ?? "");
    const isAdmin = (user.email ?? "").toLowerCase() === ADMIN_EMAIL.toLowerCase();

    // A disabled customer may still retrieve an already-signed legal record,
    // but may not take a new contractual action. This is enforced server-side
    // because a valid Supabase session can outlive an account deactivation.
    if (["preview-agreement", "sign", "decline-offer"].includes(action)) {
      const { data: account, error: accountErr } = await db.from("customers")
        .select("id, status").eq("id", user.id).maybeSingle();
      if (accountErr) {
        console.error("[service-plans-customer] account lookup failed", accountErr.message);
        return j({ error: "server_error" }, 500);
      }
      if (!account || account.status !== "active") {
        return j({ error: "account_not_active" }, 403);
      }
    }

    switch (action) {

      // ── PREVIEW ──────────────────────────────────────────────────────────
      case "preview-agreement": {
        const rail = railOf(body.payment_method);
        if (!rail) return j({ error: "choose_card_or_ach" }, 400);

        const ctx = await loadOffer(db, str(body.offer_id), user.id);
        if ("error" in ctx) return j(ctx, ctx.status ?? 400);

        const mode = await cfg(db, "service_plan_contract_mode", "test");
        const version = await cfg(db, "service_plan_agreement_version", "APEX-MSP-2026-09-DRAFT");
        const doc = buildAgreement(ctx.offer, ctx.equipment, ctx.customer, rail, version, mode);

        return j({
          ok: true,
          agreement_version: version,
          contract_mode: mode,
          legal_review_required: mode !== "live",
          selected_payment_method: rail,
          authorized: doc.authorized,
          sections: doc.sections,
          fn_version: FN_VERSION,
        });
      }

      // ── SIGN ─────────────────────────────────────────────────────────────
      case "sign": {
        const rail = railOf(body.payment_method);
        if (!rail) return j({ error: "choose_card_or_ach" }, 400);

        const signer_name = str(body.signer_name);
        const signer_title = str(body.signer_title);
        const signature = str(body.signature_typed);
        if (!signer_name) return j({ error: "signer_name_required" }, 400);
        if (!signature) return j({ error: "signature_required" }, 400);

        const consents = {
          scope: body.consent_service_scope === true,
          recurring: body.consent_recurring_auth === true,
          esign: body.consent_electronic_sig === true,
          term: body.consent_term_cancel === true,
        };
        if (!consents.scope || !consents.recurring || !consents.esign || !consents.term) {
          return j({ error: "all_consents_required" }, 400);
        }

        const offerId = str(body.offer_id);

        // Recovery path. If a previous attempt signed successfully but died
        // before the PDF was stored, do NOT try to sign again — the offer is
        // already accepted and the database would refuse. Finish the PDF.
        const { data: existing } = await db.from("service_plan_agreements")
          .select("*").eq("offer_id", offerId).eq("customer_id", user.id).maybeSingle();
        if (existing) {
          if (existing.pdf_path) {
            return j({ ok: true, already_signed: true, agreement_id: existing.id, fn_version: FN_VERSION });
          }
          const done = await finishPdf(db, existing);
          return j({ ok: true, resumed: true, agreement_id: existing.id, ...done, fn_version: FN_VERSION });
        }

        const ctx = await loadOffer(db, offerId, user.id);
        if ("error" in ctx) return j(ctx, ctx.status ?? 400);

        const mode = await cfg(db, "service_plan_contract_mode", "test");
        const version = await cfg(db, "service_plan_agreement_version", "APEX-MSP-2026-09-DRAFT");
        const doc = buildAgreement(ctx.offer, ctx.equipment, ctx.customer, rail, version, mode);

        // The snapshot is assembled here from database rows. Nothing in it comes
        // from the request except the signer's own details.
        const snapshot = {
          agreement_version: version,
          contract_mode: mode,
          legal_review_required: mode !== "live",
          generated_at: new Date().toISOString(),
          generated_by: FN_VERSION,
          customer: {
            id: ctx.customer.id, name: ctx.customer.name,
            company: ctx.customer.company, email: ctx.customer.email,
          },
          equipment: {
            id: ctx.equipment.id, unit_number: ctx.equipment.unit_number,
            year: ctx.equipment.year, make: ctx.equipment.make, model: ctx.equipment.model,
            serial_number: ctx.equipment.serial_number,
            service_location: ctx.equipment.service_location,
          },
          plan: {
            name: ctx.offer.plan_name, description: ctx.offer.description,
            included_services: ctx.offer.included_services, exclusions: ctx.offer.exclusions,
            term_months: ctx.offer.term_months, activation_date: ctx.offer.activation_date,
          },
          pricing: doc.authorized,
          signer: { name: signer_name, title: signer_title || null, signature_typed: signature },
          consents,
          sections: doc.sections,
        };

        // Fail closed. A missing salt must never silently weaken the signer-IP
        // audit hash. Existing signed agreements can still use agreement-url
        // and PDF recovery does not require a new signature hash.
        const signatureSalt = (Deno.env.get("SIGNATURE_IP_SALT") ?? "").trim();
        if (!signatureSalt) {
          console.error("[sign] SIGNATURE_IP_SALT is not configured");
          return j({ error: "server_config_error" }, 500);
        }
        const ipHash = await hashIp(req, signatureSalt);

        const { data: agreement, error: rpcErr } = await db.rpc("accept_offer_and_sign_agreement", {
          p_offer_id: offerId,
          p_customer_id: user.id,
          p_selected_payment_method: rail,
          p_agreement_version: version,
          p_signer_name: signer_name,
          p_signer_title: signer_title || null,
          p_signature_typed: signature,
          p_consent_service_scope: consents.scope,
          p_consent_recurring_auth: consents.recurring,
          p_consent_electronic_sig: consents.esign,
          p_consent_term_cancel: consents.term,
          p_snapshot: snapshot,
          p_signer_ip_hash: ipHash,
          p_signer_user_agent: (req.headers.get("user-agent") ?? "").slice(0, 300),
        });

        if (rpcErr) {
          console.error("[sign] rpc refused:", rpcErr.message);
          return j({ error: signError(rpcErr.message), detail: rpcErr.message }, 409);
        }

        const row = Array.isArray(agreement) ? agreement[0] : agreement;
        const done = await finishPdf(db, row);
        let subscription_id: string | null = null;
        try {
          const { data: made } = await db.rpc("create_subscription_from_agreement", { p_agreement_id: row.id });
          const sub = Array.isArray(made) ? made[0] : made;
          subscription_id = sub?.id ?? null;
        } catch { /* signing/PDF remain authoritative; setup can be resumed later */ }
        return j({ ok: true, agreement_id: row.id, subscription_id, ...done, fn_version: FN_VERSION });
      }

      // ── SIGNED URL ───────────────────────────────────────────────────────
      case "agreement-url": {
        const id = str(body.agreement_id);
        if (!id) return j({ error: "agreement_id required" }, 400);

        let q = db.from("service_plan_agreements").select("id, customer_id, pdf_path").eq("id", id);
        if (!isAdmin) q = q.eq("customer_id", user.id);   // IDOR → 404, not 403
        const { data: a } = await q.maybeSingle();
        if (!a) return j({ error: "not_found" }, 404);
        if (!a.pdf_path) return j({ error: "pdf_not_ready" }, 409);

        const { data: signed, error } = await db.storage.from(BUCKET)
          .createSignedUrl(a.pdf_path, SIGNED_URL_TTL);
        if (error || !signed) return j({ error: "could_not_sign_url" }, 500);

        return j({ ok: true, url: signed.signedUrl, expires_in: SIGNED_URL_TTL, fn_version: FN_VERSION });
      }

      // ── DECLINE ──────────────────────────────────────────────────────────
      case "decline-offer": {
        const ctx = await loadOffer(db, str(body.offer_id), user.id);
        if ("error" in ctx) return j(ctx, ctx.status ?? 400);

        const { data, error } = await db.from("service_plan_offers")
          .update({
            status: "declined", declined_at: new Date().toISOString(),
            declined_reason: str(body.reason) || null,
          })
          .eq("id", ctx.offer.id).eq("customer_id", user.id).eq("status", "sent")
          .select().maybeSingle();

        if (error) return j({ error: error.message }, 400);
        if (!data) return j({ error: "offer_not_declinable" }, 409);

        await db.from("service_plan_events").insert({
          event: "offer_declined", source: "customer", customer_id: user.id,
          equipment_id: data.equipment_id, offer_id: data.id,
          detail: { reason: str(body.reason) || null },
        });
        return j({ ok: true, fn_version: FN_VERSION });
      }

      default:
        return j({ error: "unknown_action" }, 400);
    }
  } catch (e) {
    console.error("[service-plans-customer]", e);
    return j({ error: "server_error" }, 500);
  }
});

// ═══════════════════════════════════════════════════════════════════════════
//  Loading
// ═══════════════════════════════════════════════════════════════════════════
async function loadOffer(db: any, offerId: string, userId: string) {
  if (!offerId) return { error: "offer_id required", status: 400 };

  // Scoped to the caller. Another customer's offer is a 404, never a 403 —
  // a 403 would confirm the id exists.
  const { data: offer } = await db.from("service_plan_offers")
    .select("*").eq("id", offerId).eq("customer_id", userId).maybeSingle();
  if (!offer) return { error: "not_found", status: 404 };
  if (offer.status !== "sent") return { error: "offer_not_open", detail: `This offer is ${offer.status}.`, status: 409 };
  if (offer.expires_at && new Date(offer.expires_at) <= new Date()) {
    return { error: "offer_expired", status: 409 };
  }

  const { data: equipment } = await db.from("customer_equipment")
    .select("*").eq("id", offer.equipment_id).maybeSingle();
  const { data: customer } = await db.from("customers")
    .select("id, name, company, email").eq("id", offer.customer_id).maybeSingle();
  if (!equipment || !customer) return { error: "not_found", status: 404 };

  return { offer, equipment, customer };
}

// ═══════════════════════════════════════════════════════════════════════════
//  The agreement itself
// ═══════════════════════════════════════════════════════════════════════════
function buildAgreement(offer: any, eq: any, cust: any, rail: "card" | "ach",
                        version: string, mode: string) {
  const sub = rail === "ach" ? Number(offer.ach_monthly_subtotal_cents) : Number(offer.card_monthly_subtotal_cents);
  const tax = rail === "ach" ? Number(offer.ach_monthly_tax_cents) : Number(offer.card_monthly_tax_cents);
  const tot = rail === "ach" ? Number(offer.ach_monthly_total_cents) : Number(offer.card_monthly_total_cents);

  const authorized = {
    selected_payment_method: rail,
    monthly_subtotal_cents: sub,
    monthly_tax_cents: tax,
    monthly_total_cents: tot,
    currency: offer.currency ?? "USD",
    term_months: Number(offer.term_months),
    activation_date: offer.activation_date,
    total_over_term_cents: tot * Number(offer.term_months),
    ach_monthly_total_cents: Number(offer.ach_monthly_total_cents),
    card_monthly_total_cents: Number(offer.card_monthly_total_cents),
    tax_rate_pct: Number(offer.tax_rate_milli_pct ?? 0) / 1000,
    tax_exempt: !!offer.tax_exempt,
    tax_jurisdiction: offer.tax_jurisdiction ?? null,
  };

  const unit = [eq.year, eq.make, eq.model].filter(Boolean).join(" ") || "Forklift";
  const railLabel = rail === "ach" ? "Bank transfer (ACH)" : "Credit or debit card";
  const otherLabel = rail === "ach" ? "credit or debit card" : "bank transfer (ACH)";
  const otherTotal = rail === "ach" ? authorized.card_monthly_total_cents : authorized.ach_monthly_total_cents;

  const included = asList(offer.included_services);
  const excluded = asList(offer.exclusions);

  const sections: { heading: string; body: string; legal_review?: boolean }[] = [
    {
      heading: "1. Parties",
      body: `This Monthly Service Plan Agreement is entered into between Apex Lift Solutions ("Apex") and `
        + `${cust.company ? `${cust.company}` : cust.name} ("Customer"), effective on the activation date stated below.`,
    },
    {
      heading: "2. Covered equipment",
      body: [
        `Unit: ${eq.unit_number || "—"}`,
        `Equipment: ${unit}`,
        `Serial number: ${eq.serial_number || "Not recorded at time of signing"}`,
        `Service location: ${eq.service_location || "Customer's primary service address"}`,
        ``,
        `This Agreement covers the single unit identified above. Additional units require separate agreements.`,
      ].join("\n"),
    },
    {
      heading: "3. Services included",
      body: included.length
        ? included.map((s) => `• ${s}`).join("\n")
        : "• As described in the accompanying service plan.",
    },
    {
      heading: "4. Not included",
      body: (excluded.length
        ? excluded.map((s) => `• ${s}`).join("\n")
        : "• Items not expressly listed in Section 3.")
        + `\n\nWork outside the scope of Section 3 will be quoted separately and is not covered by the monthly amount.`,
    },
    {
      heading: "5. Term",
      body: `${authorized.term_months} monthly billing cycles beginning ${fmtDate(offer.activation_date)}.\n\n`
        + `This Agreement does not renew automatically. At the end of the ${authorized.term_months} cycles the plan `
        + `completes. Continuing service requires a new offer and a new signed agreement.`,
    },
    {
      heading: "6. Price and payment method",
      body: [
        `Customer has selected: ${railLabel}`,
        ``,
        `Monthly service charge   ${usd(sub)}`,
        offer.tax_exempt
          ? `Sales tax                exempt${offer.exempt_cert_number ? ` (certificate ${offer.exempt_cert_number})` : ""}`
          : `Sales tax (${authorized.tax_rate_pct.toFixed(3)}%)      ${usd(tax)}`,
        `Total charged monthly    ${usd(tot)}`,
        ``,
        `Total over the ${authorized.term_months}-cycle term: ${usd(authorized.total_over_term_cents)}`,
        ``,
        `Apex prices bank transfer and card separately. Had Customer selected ${otherLabel}, `
        + `the monthly total would be ${usd(otherTotal)}. Customer may change payment method later; `
        + `if the monthly total changes as a result, that change requires a new signed agreement `
        + `before it takes effect.`,
      ].join("\n"),
      legal_review: true,
    },
    {
      heading: "7. Recurring payment authorization",
      body: [
        `Customer authorizes Apex to charge ${usd(tot)} to the ${railLabel.toLowerCase()} `
        + `Customer designates, once per monthly billing cycle, for ${authorized.term_months} cycles, `
        + `beginning ${fmtDate(offer.activation_date)}.`,
        ``,
        `This authorization is for this exact amount. Apex may not increase it under this Agreement. `
        + `Any change to the amount requires a new signed agreement.`,
        ``,
        `Payment details are held by Apex's payment processor. Apex does not store card numbers, `
        + `security codes, or bank account and routing numbers.`,
      ].join("\n"),
      legal_review: true,
    },
    {
      heading: "8. Failed payments",
      body: [
        `If a scheduled payment does not complete, the plan is marked past due and Apex will contact Customer.`,
        `Bank transfers are not settled at the time of submission and may be returned by Customer's bank `
        + `several business days later.`,
        ``,
        `Consequences of continued non-payment, including any suspension of service or recovery of costs, `
        + `are subject to review and are not finalized in this draft.`,
      ].join("\n"),
      legal_review: true,
    },
    {
      heading: "9. Fixed term; no customer cancellation",
      body: [
        `This is a fixed ${authorized.term_months}-payment service agreement. Once signed, Customer does not have an `
        + `ordinary right to cancel the Agreement before all ${authorized.term_months} scheduled payments are completed.`,
        ``,
        `Apex may stop automated billing only for an administrative error, duplicate setup, legal requirement, `
        + `or another exceptional circumstance documented by Apex. Stopping the payment processor does not by itself `
        + `waive any contractual amount that may remain due.`,
        ``,
        `This fixed-term / no-cancellation language requires attorney review before contract_mode is changed to live, `
        + `and nothing in this draft limits rights that cannot legally be waived.`,
      ].join("\n"),
      legal_review: true,
    },
    {
      heading: "10. Electronic signature",
      body: [
        `Customer agrees to sign this Agreement electronically and that a typed name constitutes Customer's `
        + `signature. Apex records the signature, the signer's name and title, the time of signing, and a `
        + `one-way hash of the signer's network address.`,
        ``,
        `Apex stores a permanent, unmodifiable copy of this Agreement as signed. Customer may retrieve it at `
        + `any time from the customer portal.`,
      ],
      legal_review: true,
    },
  ].map((s) => ({ ...s, body: Array.isArray(s.body) ? s.body.join("\n") : s.body }));

  if (mode !== "live") {
    sections.unshift({
      heading: "DRAFT — PENDING LEGAL REVIEW",
      body: "This document is a draft. The business terms are accurate and come from Apex's records, but "
        + "the contract language has not been reviewed by an attorney. It is not intended to be relied on "
        + "as an executed agreement while this notice appears.",
    });
  }

  return { authorized, sections, agreement_version: version };
}

// ═══════════════════════════════════════════════════════════════════════════
//  PDF + hashes + storage
// ═══════════════════════════════════════════════════════════════════════════
async function finishPdf(db: any, agreement: any) {
  const snapshot = agreement.snapshot ?? {};
  const mode = String(snapshot.contract_mode ?? "test");

  const bytes = await renderPdf(agreement, snapshot, mode);
  const path = `agreements/${agreement.customer_id}/${agreement.id}.pdf`;

  const { error: upErr } = await db.storage.from(BUCKET)
    .upload(path, bytes, { contentType: "application/pdf", upsert: true });
  if (upErr) {
    console.error("[finishPdf] upload failed:", upErr.message);
    // The agreement is signed and valid regardless. Report it and let the
    // customer retry; the recovery path in `sign` picks this up.
    return { pdf_ready: false, pdf_error: "storage_upload_failed" };
  }

  const documentHash = await sha256Hex(bytes);
  const snapshotHash = await sha256Hex(new TextEncoder().encode(canonical(snapshot)));

  // Write-once columns. The guard trigger refuses a second, different value.
  const { error: updErr } = await db.from("service_plan_agreements").update({
    pdf_path: path,
    pdf_generated_at: new Date().toISOString(),
    document_sha256: documentHash,
    snapshot_sha256: snapshotHash,
  }).eq("id", agreement.id);

  if (updErr) {
    console.error("[finishPdf] hash write failed:", updErr.message);
    return { pdf_ready: false, pdf_error: "hash_write_failed" };
  }

  await db.from("service_plan_events").insert({
    event: "agreement_pdf_stored", source: "edge",
    customer_id: agreement.customer_id, equipment_id: agreement.equipment_id,
    offer_id: agreement.offer_id, agreement_id: agreement.id,
    detail: { document_sha256: documentHash, snapshot_sha256: snapshotHash, bytes: bytes.length },
  });

  return { pdf_ready: true, document_sha256: documentHash, snapshot_sha256: snapshotHash };
}

async function renderPdf(agreement: any, snapshot: any, mode: string): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const mono = await pdf.embedFont(StandardFonts.Courier);

  const W = 612, H = 792, M = 54;
  const ink = rgb(0.09, 0.09, 0.11);
  const grey = rgb(0.42, 0.42, 0.46);
  const rule = rgb(0.85, 0.85, 0.88);
  const draftRed = rgb(0.72, 0.16, 0.16);

  let page = pdf.addPage([W, H]);
  let y = H - M;
  let pageNo = 1;

  const newPage = () => {
    footer();
    page = pdf.addPage([W, H]);
    pageNo++;
    y = H - M;
    if (mode !== "live") banner();
  };
  const need = (h: number) => { if (y - h < M + 40) newPage(); };

  const banner = () => {
    page.drawRectangle({ x: 0, y: H - 26, width: W, height: 26, color: rgb(0.99, 0.94, 0.94) });
    put("DRAFT - PENDING LEGAL REVIEW - NOT AN EXECUTED AGREEMENT", M, H - 18, 9, bold, draftRed);
    y = Math.min(y, H - 44);
  };
  const footer = () => {
    put(`Apex Lift Solutions - Monthly Service Plan Agreement - ${snapshot.agreement_version ?? ""} - page ${pageNo}`,
        M, 30, 7.5, font, grey);
  };

  // EVERY string drawn must go through safe(). StandardFonts are WinAnsi-encoded
  // and throw on any character outside it — and phone keyboards autocorrect a
  // plain apostrophe to U+2019, so "O'Brien Warehouse" is a realistic input,
  // not an exotic one. put() is the only way text reaches the page directly.
  const put = (s: unknown, x: number, yy: number, size: number, f = font, color = ink) =>
    page.drawText(safe(String(s ?? "")), { x, y: yy, size, font: f, color });

  // Truncate to fit a column so a long company name cannot run off the page.
  const fit = (s: unknown, f: any, size: number, maxW: number) => {
    let t = safe(String(s ?? ""));
    if (f.widthOfTextAtSize(t, size) <= maxW) return t;
    while (t.length > 1 && f.widthOfTextAtSize(t + "...", size) > maxW) t = t.slice(0, -1);
    return t + "...";
  };

  const text = (s: string, size: number, f = font, color = ink, indent = 0) => {
    for (const line of wrap(s, f, size, W - M * 2 - indent)) {
      need(size + 4);
      page.drawText(line, { x: M + indent, y, size, font: f, color });
      y -= size + 4;
    }
  };
  const gap = (n: number) => { y -= n; };

  if (mode !== "live") banner();

  // ── Header ────────────────────────────────────────────────────────────────
  put("APEX LIFT SOLUTIONS", M, y, 17, bold, ink);
  y -= 21;
  put("Monthly Service Plan Agreement", M, y, 12, font, grey);
  y -= 18;
  page.drawLine({ start: { x: M, y }, end: { x: W - M, y }, thickness: 1, color: rule });
  y -= 18;

  // ── At-a-glance box ───────────────────────────────────────────────────────
  const p = snapshot.pricing ?? {};
  const facts: [string, string][] = [
    ["Agreement ID", String(agreement.id)],
    ["Agreement version", String(snapshot.agreement_version ?? "")],
    ["Customer", String(snapshot.customer?.company || snapshot.customer?.name || "")],
    ["Unit", String(snapshot.equipment?.unit_number || "—")],
    ["Serial number", String(snapshot.equipment?.serial_number || "Not recorded")],
    ["Payment method", agreement.selected_payment_method === "ach" ? "Bank transfer (ACH)" : "Credit or debit card"],
    ["Authorized monthly total", usd(agreement.monthly_total_cents)],
    ["Term", `${agreement.term_months} monthly cycles`],
    ["First billing date", fmtDate(agreement.activation_date)],
    ["Signed", fmtDateTime(agreement.signed_at)],
  ];
  for (const [k, v] of facts) {
    need(15);
    put(k, M, y, 9.5, font, grey);
    put(fit(v, bold, 9.5, W - M * 2 - 165), M + 165, y, 9.5, bold, ink);
    y -= 15;
  }
  gap(6);
  page.drawLine({ start: { x: M, y }, end: { x: W - M, y }, thickness: 1, color: rule });
  gap(16);

  // ── Body ──────────────────────────────────────────────────────────────────
  for (const s of (snapshot.sections ?? [])) {
    need(34);
    text(String(s.heading ?? ""), 11.5, bold);
    gap(3);
    text(String(s.body ?? ""), 9.8, font, ink, 8);
    if (s.legal_review) {
      text("[ This section is subject to legal review. ]", 8, font, draftRed, 8);
    }
    gap(11);
  }

  // ── Signature block ───────────────────────────────────────────────────────
  need(150);
  gap(6);
  page.drawLine({ start: { x: M, y }, end: { x: W - M, y }, thickness: 1, color: rule });
  gap(16);
  text("Customer acknowledgements", 11.5, bold);
  gap(4);
  const c = snapshot.consents ?? {};
  const marks: [boolean, string][] = [
    [!!c.scope, "I have reviewed the services included and not included."],
    [!!c.recurring, `I authorize the recurring monthly charge of ${usd(agreement.monthly_total_cents)}.`],
    [!!c.esign, "I agree to sign electronically and that my typed name is my signature."],
    [!!c.term, `I understand the ${agreement.term_months}-cycle term and the cancellation process.`],
  ];
  for (const [ok, label] of marks) {
    need(14);
    put(ok ? "[X]" : "[ ]", M, y, 9.5, mono, ink);
    put(fit(label, font, 9.5, W - M * 2 - 26), M + 26, y, 9.5, font, ink);
    y -= 14;
  }
  gap(14);

  need(70);
  put("Signed by", M, y, 9, font, grey);
  y -= 22;
  put(fit(agreement.signature_typed, bold, 16, W - M * 2), M, y, 16, bold, ink);
  y -= 8;
  page.drawLine({ start: { x: M, y }, end: { x: M + 260, y }, thickness: 0.8, color: rule });
  y -= 14;
  put(fit(`${agreement.signer_name}${agreement.signer_title ? `, ${agreement.signer_title}` : ""}`,
          font, 9.5, W - M * 2), M, y, 9.5, font, ink);
  y -= 13;
  put(`Signed ${fmtDateTime(agreement.signed_at)}`, M, y, 8.5, font, grey);
  y -= 12;
  put("Electronic signature recorded by Apex Lift Solutions. Signer network address stored as a one-way hash.",
      M, y, 7.5, font, grey);

  footer();
  return await pdf.save();
}

/** Greedy wrap that respects explicit newlines and never loops on long words. */
function wrap(s: string, font: any, size: number, maxWidth: number): string[] {
  const out: string[] = [];
  for (const para of String(s).split("\n")) {
    if (!para.trim()) { out.push(""); continue; }
    let line = "";
    for (const word of para.split(/\s+/)) {
      const test = line ? `${line} ${word}` : word;
      if (font.widthOfTextAtSize(safe(test), size) <= maxWidth) { line = test; continue; }
      if (line) out.push(safe(line));
      // A single word wider than the column: hard-split it.
      let w = word;
      while (font.widthOfTextAtSize(safe(w), size) > maxWidth && w.length > 1) {
        let cut = w.length;
        while (cut > 1 && font.widthOfTextAtSize(safe(w.slice(0, cut)), size) > maxWidth) cut--;
        out.push(safe(w.slice(0, cut)));
        w = w.slice(cut);
      }
      line = w;
    }
    out.push(safe(line));
  }
  return out;
}

/** StandardFonts are WinAnsi; anything outside it throws at draw time. */
function safe(s: string): string {
  return s
    .replace(/[\u2018\u2019]/g, "'").replace(/[\u201C\u201D]/g, '"')
    .replace(/[\u2010-\u2015]/g, "-").replace(/\u2026/g, "...")
    .replace(/\u00A0/g, " ").replace(/[•]/g, "-")
    // deno-lint-ignore no-control-regex
    .replace(/[^\x09\x0A\x0D\x20-\xFF]/g, "?");
}

// ═══════════════════════════════════════════════════════════════════════════
//  Helpers
// ═══════════════════════════════════════════════════════════════════════════
function str(v: unknown): string { return typeof v === "string" ? v.trim() : (v == null ? "" : String(v).trim()); }
function railOf(v: unknown): "card" | "ach" | null {
  const s = String(v ?? "").toLowerCase();
  return s === "card" || s === "ach" ? s : null;
}
function asList(v: unknown): string[] {
  if (Array.isArray(v)) return v.map((x) => String(x)).filter(Boolean);
  return [];
}
const usd = (cents: unknown) => "$" + (Number(cents ?? 0) / 100).toFixed(2);
const fmtDate = (d: unknown) => d
  ? new Date(String(d) + (String(d).length === 10 ? "T12:00:00Z" : ""))
      .toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric", timeZone: "UTC" })
  : "—";
const fmtDateTime = (d: unknown) => d
  ? new Date(String(d)).toLocaleString("en-US", { dateStyle: "long", timeStyle: "short" })
  : "—";

async function cfg(db: any, key: string, dflt: string): Promise<string> {
  const { data } = await db.from("app_config").select("value").eq("key", key).maybeSingle();
  const v = String(data?.value ?? "").trim();
  return v || dflt;
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Stable JSON so the snapshot hash is reproducible. Postgres jsonb does not
 * preserve key order, so hashing JSON.stringify() of a round-tripped snapshot
 * would produce a different digest every time. Keys are sorted recursively.
 */
function canonical(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v) ?? "null";
  if (Array.isArray(v)) return "[" + v.map(canonical).join(",") + "]";
  const o = v as Record<string, unknown>;
  return "{" + Object.keys(o).sort().map((k) => JSON.stringify(k) + ":" + canonical(o[k])).join(",") + "}";
}

/** Salted one-way hash. The raw signer IP is never stored. */
async function hashIp(req: Request, salt: string): Promise<string | null> {
  const ip = (req.headers.get("x-forwarded-for") ?? "").split(",")[0].trim();
  if (!ip) return null;
  return (await sha256Hex(new TextEncoder().encode(`${salt}:${ip}`))).slice(0, 32);
}

/** Database refusals, translated for a customer. */
function signError(msg: string): string {
  if (/only a sent offer can be signed/.test(msg)) return "offer_no_longer_open";
  if (/expired at/.test(msg)) return "offer_expired";
  if (/does not match the offer/.test(msg)) return "price_changed_reload";
  if (/consents are required/.test(msg)) return "all_consents_required";
  if (/snapshot .* is required/.test(msg)) return "contract_not_generated";
  if (/duplicate key|already/i.test(msg)) return "already_signed";
  return "could_not_sign";
}
