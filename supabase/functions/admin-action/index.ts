// =============================================
//  APEX LIFT SOLUTIONS — admin-action/index.ts
//  Supabase Edge Function for sensitive admin ops.
//
//  Handles: create-invoice, mark-paid,
//           activate-customer, delete-customer,
//           delete-quote, delete-invoice
//
//  DEPLOY:
//    supabase functions deploy admin-action
//
//  Every request must include a valid Supabase
//  JWT for admin@apexliftsolutionsusa.com.
//  The function validates this server-side before
//  executing any action — the browser cannot fake it.
// =============================================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const ADMIN_EMAIL = 'admin@apexliftsolutionsusa.com';
const SB_URL      = Deno.env.get('SUPABASE_URL')!;
const SB_SERVICE  = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!; // server-only key

// Locked to the production origin. A wildcard here lets any website on the
// internet invoke this function with a victim's session.
const ALLOWED_ORIGIN = Deno.env.get('APP_BASE_URL') ?? 'https://apexliftsolutionsusa.com';
const corsHeaders = {
  'Access-Control-Allow-Origin':  ALLOWED_ORIGIN,
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

Deno.serve(async (req) => {
  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    // ── 1. VERIFY CALLER IS ADMIN ───────────────
    // Extract the JWT the browser sent
    const authHeader = req.headers.get('Authorization');
    if (!authHeader) {
      return json({ error: 'Unauthorized' }, 401);
    }

    // Create a user-scoped client to verify the JWT
    const userClient = createClient(SB_URL, Deno.env.get('SUPABASE_ANON_KEY')!, {
      global: { headers: { Authorization: authHeader } }
    });
    const { data: { user }, error: authErr } = await userClient.auth.getUser();

    if (authErr || !user || user.email !== ADMIN_EMAIL) {
      return json({ error: 'Forbidden — admin only' }, 403);
    }

    // ── 2. PARSE ACTION ─────────────────────────
    const body   = await req.json();
    const action = body.action as string;

    // Use service-role client for actual DB writes
    // (bypasses RLS — safe here because we verified admin above)
    const admin = createClient(SB_URL, SB_SERVICE);

    // ── 3. EXECUTE ACTION ───────────────────────
    switch (action) {

      // Convert approved quote → invoice
      // Equipment linking is server-authoritative. The admin browser still
      // inserts the quote row itself (unchanged), but it may only ask for a
      // forklift by id — the RPC verifies ownership and active status and
      // generates the snapshot from the live row. The browser can neither
      // supply a snapshot nor bypass the checks.
      case 'link-quote-equipment': {
        const quoteId = String(body.quoteId ?? '').trim();
        const equipmentId = String(body.equipmentId ?? '').trim();
        if (!quoteId) return json({ error: 'quoteId required' }, 400);
        if (!equipmentId) return json({ error: 'equipmentId required' }, 400);

        const { data, error } = await admin.rpc('link_quote_equipment', {
          p_quote_id: quoteId, p_equipment_id: equipmentId,
        });
        if (error) {
          const m = error.message || '';
          // Stable codes; the database is the authority for each rule.
          if (m.includes('equipment_not_owned'))     return json({ error: 'equipment_not_owned', detail: 'That forklift does not belong to this customer.' }, 409);
          if (m.includes('equipment_not_active'))    return json({ error: 'equipment_not_active', detail: 'That forklift is not active and cannot be used on a new quote.' }, 409);
          if (m.includes('quote_not_pending'))       return json({ error: 'quote_not_pending', detail: 'The customer has already responded to this quote; its equipment is now part of the record.' }, 409);
          if (m.includes('quote_already_invoiced'))  return json({ error: 'quote_already_invoiced', detail: 'This quote has been invoiced. Its equipment can no longer be changed.' }, 409);
          if (m.includes('document_snapshot_frozen')) return json({ error: 'document_snapshot_frozen', detail: 'This quote already records the forklift it was issued for.' }, 409);
          if (m.includes('quote_not_found'))         return json({ error: 'quote_not_found' }, 404);
          console.error('[admin-action] link-quote-equipment failed', m.slice(0, 120));
          return json({ error: 'link_failed' }, 500);
        }
        return json({ ok: true, quote: data });
      }

      // ONE authoritative conversion implementation: the database RPC. It takes
      // the row lock, enforces approved + not-already-invoiced, inserts exactly
      // one invoice, copies equipment/equipment_id/equipment_snapshot verbatim
      // and marks the quote invoiced — all in one transaction. Re-implementing
      // any of that here is how the two paths drifted apart in the first place.
      // ONE authoritative conversion implementation: quote_to_invoice_v2. It
      // takes the row lock, returns the EXISTING invoice when the quote was
      // already converted instead of raising, and never creates a second one.
      // A repeat attempt is a normal outcome here, not an error — the previous
      // version raised, the browser turned that into an unhandled exception,
      // and the admin saw nothing at all and clicked again.
      case 'create-invoice': {
        const quoteId = String(body.quoteId ?? '').trim();
        if (!quoteId) return json({ error: 'quoteId required' }, 400);

        const { data: res, error: rpcErr } = await admin.rpc('quote_to_invoice_v2', { p_quote_id: quoteId });
        if (rpcErr) {
          const m = rpcErr.message || '';
          if (m.includes('quote_not_found'))    return json({ error: 'quote_not_found' }, 404);
          if (m.includes('quote_not_approved')) return json({ error: 'quote_not_approved', detail: 'Only an approved quote can be invoiced.' }, 409);
          console.error('[admin-action] quote_to_invoice_v2 failed', m.slice(0, 120));
          return json({ error: 'conversion_failed' }, 500);
        }

        const { data: inv } = await admin.from('invoices').select('*').eq('id', res.invoice_id).maybeSingle();

        if (res.already_invoiced) {
          // 200, not an error: the desired end state already holds. The admin
          // gets the invoice id so the UI can show it instead of a button.
          // No second invoice, and no second notification — the invoice row was
          // not re-inserted, so notify_on_invoice never fires again.
          return json({ ok: true, already_invoiced: true, created: false,
                        invoice_id: res.invoice_id, repaired_flag: res.repaired_flag, ...(inv ?? {}) });
        }

        const audit = await admin.from('audit_log').insert({
          actor_email: user.email, actor_id: user.id, action: 'create_invoice',
          table_name: 'invoices', record_id: res.invoice_id,
          detail: `Invoice ${res.invoice_id} created from quote ${quoteId}`,
        });
        if (audit.error) console.error('[admin-action] audit write failed', audit.error.message?.slice(0, 80));

        return json({ ok: true, already_invoiced: false, created: true,
                      invoice_id: res.invoice_id, ...(inv ?? {}) });
      }

      case 'record-manual-payment': {
        const { invoiceId, method, amount, reference, notes } = body;
        const okMethods = ['check','cash','bank_transfer','terminal','other'];
        if (!invoiceId || !okMethods.includes(method)) return json({ error: 'invoiceId and a valid method required' }, 400);

        const { data: invArr } = await admin.from('invoices').select('*').eq('id', invoiceId);
        const inv = invArr?.[0];
        if (!inv) return json({ error: 'Invoice not found' }, 404);
        if (inv.status === 'paid') return json({ error: 'Invoice is already paid' }, 409);

        // Amount defaults to the invoice total; if supplied it must match to the cent.
        const invCents = Math.round(Number(inv.amount) * 100);
        const paidCents = amount != null ? Math.round(Number(amount) * 100) : invCents;
        if (!Number.isFinite(paidCents) || paidCents <= 0) return json({ error: 'Invalid amount' }, 400);
        if (paidCents !== invCents) return json({ error: `Amount must equal invoice total $${(invCents/100).toFixed(2)} (partial payments not supported yet)` }, 400);

        const { data: pay, error: payErr } = await admin.from('payments').insert({
          invoice_id: inv.id, customer_id: inv.customer_id, provider: 'manual', kind: 'payment',
          method, amount_cents: paidCents, currency: 'USD', status: 'succeeded',
          reference: reference || null, notes: notes || null, recorded_by: user.id,
          approved_at: new Date().toISOString(), settled_at: new Date().toISOString(), completed_at: new Date().toISOString(),
        }).select().single();
        if (payErr) return json({ error: payErr.message }, 500);

        await admin.from('payment_events').insert({ payment_id: pay.id, invoice_id: inv.id, event: 'settled', source: 'admin',
          detail: { method, reference: reference || null } });
        await admin.rpc('recalc_invoice_status', { p_invoice_id: inv.id });
        await admin.from('invoices').update({ paid_via: 'manual', payment_id: pay.id }).eq('id', inv.id);

        await logAction(admin, user.id, 'manual_payment_recorded',
          `${invoiceId} — $${(paidCents/100).toFixed(2)} via ${method}${reference ? ' ref ' + reference : ''} — ${inv.customer_name}`);
        return json({ ok: true, payment_id: pay.id });
      }

      // Activate customer account
      case 'activate-customer': {
        const { customerId } = body;
        if (!customerId) return json({ error: 'customerId required' }, 400);

        const { data: custArr } = await admin.from('customers').select('*').eq('id', customerId);
        const cust = custArr?.[0];
        if (!cust) return json({ error: 'Customer not found' }, 404);

        await admin.from('customers').update({ status: 'active' }).eq('id', customerId);

        await logAction(admin, user.id, 'activate_customer',
          `Customer ${cust.name || cust.email} (${cust.company || '—'}) activated`);

        return json({ ok: true });
      }

      // Deactivate / reject customer
      case 'deactivate-customer': {
        const { customerId, reason } = body;
        if (!customerId) return json({ error: 'customerId required' }, 400);

        const { data: custArr } = await admin.from('customers').select('name,email').eq('id', customerId);
        const cust = custArr?.[0];

        await admin.from('customers').update({ status: 'inactive' }).eq('id', customerId);

        await logAction(admin, user.id, 'deactivate_customer',
          `Customer ${cust?.name || cust?.email || customerId} deactivated${reason ? ' — ' + reason : ''}`);

        return json({ ok: true });
      }

      // Delete quote
      case 'delete-quote': {
        const { quoteId } = body;
        if (!quoteId) return json({ error: 'quoteId required' }, 400);

        await admin.from('quotes').delete().eq('id', quoteId);
        await logAction(admin, user.id, 'delete_quote', `Quote ${quoteId} deleted`);

        return json({ ok: true });
      }

      // Delete invoice
      // Hard-delete ONLY when nothing references the invoice. payments.invoice_id
      // is ON DELETE RESTRICT, so an invoice with any ledger row cannot be
      // removed -- and must not be, because that is accounting history. Those
      // are voided instead: gone from the customer's payable list, audit intact.
      // Recover a payment Helcim took but Apex never recorded. The admin reads
      // the transaction id off the Helcim dashboard; the SERVER then verifies it
      // against Helcim before touching anything. This never charges a card.
      // Resolve a Helcim attempt left in 'unknown' AFTER an offline payment was
      // already recorded to compensate. The invoice must end up representing the
      // money exactly ONCE.
      //
      // Design constraint: guard_payment() forbids reopening a succeeded payment
      // ("a succeeded payment cannot be reopened"). And netting the manual row
      // out with a reversal would push recalc_invoice_status to
      // 'partially_refunded', which is wrong. So the compensating manual row is
      // left as the settled record, and the Helcim attempt is closed as
      // 'voided' with the real transaction id preserved in payment_events.
      // One succeeded payment, full audit trail, no duplicate email.
      case 'resolve-orphan-attempt': {
        const { paymentId, helcimTransactionId } = body;
        if (!paymentId) return json({ error: 'paymentId required' }, 400);

        const { data: payArr } = await admin.from('payments').select('*').eq('id', paymentId);
        const pay = payArr?.[0];
        if (!pay) return json({ error: 'Payment attempt not found' }, 404);
        if (pay.provider !== 'helcim') return json({ error: 'Only a Helcim attempt can be resolved here.' }, 400);
        if (pay.status === 'succeeded') return json({ error: 'That attempt already succeeded.' }, 409);

        // Is the invoice already settled by something else?
        const { data: others } = await admin.from('payments')
          .select('id, provider, method, amount_cents')
          .eq('invoice_id', pay.invoice_id).eq('kind', 'payment')
          .eq('status', 'succeeded').neq('id', paymentId);
        const alreadySettled = (others ?? []).length > 0;

        // If a transaction id was supplied, verify it before recording anything.
        let txn = null;
        if (helcimTransactionId) {
          for (const seg of ['card-transactions', 'ach/transactions']) {
            const r = await fetch(`https://api.helcim.com/v2/${seg}/${encodeURIComponent(helcimTransactionId)}`,
              { headers: { 'api-token': Deno.env.get('HELCIM_ADMIN_API_TOKEN'), accept: 'application/json' } });
            if (r.ok) { txn = await r.json().catch(() => null); if (txn) break; }
          }
          if (!txn) return json({ error: `Helcim has no transaction ${helcimTransactionId}. Check the id.` }, 404);
          if (!/APPROV/i.test(String(txn.status ?? ''))) {
            return json({ error: `That transaction is ${txn.status}, not approved.` }, 409);
          }
        }

        if (alreadySettled) {
          // Close the Helcim attempt WITHOUT adding money. unknown -> voided is
          // not a succeeded transition, so notify_on_payment sends nothing and
          // the customer gets no second receipt.
          const { error: vErr } = await admin.from('payments').update({
            status: 'voided',
            failure_category: txn ? 'superseded_by_manual_record' : 'no_provider_transaction',
            provider_transaction_id: txn ? String(txn.transactionId ?? txn.id ?? helcimTransactionId) : null,
            completed_at: new Date().toISOString(),
          }).eq('id', paymentId);
          if (vErr) return json({ error: vErr.message }, 500);

          await admin.from('payment_events').insert({
            payment_id: paymentId, invoice_id: pay.invoice_id,
            event: 'orphan_attempt_resolved', source: 'admin',
            detail: {
              outcome: 'voided_attempt_manual_record_kept',
              helcim_transaction_id: txn ? String(txn.transactionId ?? txn.id ?? helcimTransactionId) : null,
              helcim_charged: !!txn,
              settled_by_payment_ids: (others ?? []).map((o) => o.id),
              note: txn
                ? 'Helcim DID charge this. The offline record entered earlier is kept as the single settled payment so the invoice is not counted twice; the real Helcim transaction id is preserved here.'
                : 'Helcim shows no approved transaction. The offline record stands as the correct payment.',
            },
          });
          await admin.rpc('recalc_invoice_status', { p_invoice_id: pay.invoice_id });
          await logAction(admin, user.id, 'orphan_attempt_resolved',
            `${pay.invoice_id}: Helcim attempt voided, existing settled payment kept${txn ? ` (Helcim txn ${helcimTransactionId})` : ''}`);
          return json({ ok: true, outcome: 'voided_attempt_manual_record_kept',
            helcim_charged: !!txn,
            message: txn
              ? 'Helcim did charge this card. Because an offline payment was already recorded for the same money, the Helcim attempt has been closed and the transaction id stored in the audit trail. The invoice remains paid exactly once.'
              : 'Helcim shows no approved transaction, so nothing was charged there. The offline payment record stands. The stale attempt is closed.' });
        }

        // Nothing else settled the invoice — promote the real Helcim charge.
        if (!txn) return json({ error: 'Supply the Helcim transaction id to settle this invoice from the real charge.' }, 400);
        return json({ error: 'Invoice is not already settled — use reconcile-payment instead.' }, 409);
      }

      // Diagnoses HELCIM_ADMIN_API_TOKEN without ever printing it. Uses Helcim's
      // documented connectivity-test endpoint plus one real read, so 401/403
      // (bad token / missing permission) is distinguished from 404 (no such
      // transaction). Those were previously conflated as "verify_unavailable".
      case 'helcim-connection-test': {
        const token = Deno.env.get('HELCIM_ADMIN_API_TOKEN');
        if (!token) {
          return json({ ok: false, stage: 'config',
            message: 'HELCIM_ADMIN_API_TOKEN is not set on this Edge Function. Run: supabase secrets set HELCIM_ADMIN_API_TOKEN=...' }, 200);
        }
        const results = [];
        for (const [label, path] of [
          ['connection-test', 'connection-test'],
          ['read a card transaction collection', 'card-transactions?dateStart=' + new Date(Date.now()-86400000).toISOString().slice(0,10)],
        ]) {
          const r = await fetch(`https://api.helcim.com/v2/${path}`, {
            headers: { 'api-token': token, accept: 'application/json' },
          });
          results.push({ check: label, http: r.status,
            meaning: r.status === 401 ? 'TOKEN INVALID — wrong value, or it is the CHECKOUT token rather than the ADMIN token'
                   : r.status === 403 ? 'TOKEN VALID but lacks permission — enable Transaction Processing on this API Access Configuration'
                   : r.status === 404 ? 'endpoint reachable, resource not found'
                   : r.ok             ? 'OK'
                   : 'unexpected' });
        }
        const allOk = results.every((x) => x.http >= 200 && x.http < 300);
        return json({ ok: allOk, token_length: token.length, results,
          next_step: allOk ? 'Provider API access is working.'
            : 'Helcim dashboard → All Tools → Integrations → API Access. The ADMIN configuration needs Transaction Processing = Admin. Regenerate if needed, then: supabase secrets set HELCIM_ADMIN_API_TOKEN=...' }, 200);
      }

      case 'reconcile-payment': {
        const { paymentId, helcimTransactionId } = body;
        if (!paymentId || !helcimTransactionId) {
          return json({ error: 'paymentId and helcimTransactionId are both required' }, 400);
        }

        const { data: payArr, error: pErr } = await admin.from('payments').select('*').eq('id', paymentId);
        if (pErr) return json({ error: pErr.message }, 500);
        const pay = payArr?.[0];
        if (!pay) return json({ error: 'Payment attempt not found' }, 404);
        if (pay.status === 'succeeded') return json({ error: 'This payment is already recorded as succeeded.' }, 409);

        // Verify with Helcim. The admin's word is not enough to move money state.
        let txn = null, lastStatus = 0;
        for (const seg of ['card-transactions', 'ach/transactions']) {
          const r = await fetch(`https://api.helcim.com/v2/${seg}/${encodeURIComponent(helcimTransactionId)}`, {
            headers: { 'api-token': Deno.env.get('HELCIM_ADMIN_API_TOKEN'), accept: 'application/json' },
          });
          lastStatus = r.status;
          if (r.ok) { txn = await r.json().catch(() => null); if (txn) break; }
        }
        if (!txn) return json({ error: `Helcim has no transaction ${helcimTransactionId} (HTTP ${lastStatus}). Check the id.` }, 404);

        if (!/APPROV/i.test(String(txn.status ?? ''))) {
          return json({ error: `That transaction is ${txn.status}, not approved. It cannot settle an invoice.` }, 409);
        }

        const chargedCents = Math.round(Number(txn.amount ?? 0) * 100);
        const base = Number(pay.amount_cents);
        if (chargedCents < base) {
          return json({ error: `Transaction charged $${(chargedCents/100).toFixed(2)} but the invoice is $${(base/100).toFixed(2)}. Refusing to settle an underpayment.` }, 409);
        }
        const fee = chargedCents - base;
        const ceiling = Math.max(Math.ceil(base * 0.10), 200);
        if (fee > ceiling) {
          return json({ error: `Transaction charged $${(chargedCents/100).toFixed(2)} vs invoice $${(base/100).toFixed(2)}. The $${(fee/100).toFixed(2)} difference is too large to assume it is a convenience fee. Reconcile manually.` }, 409);
        }

        const isBank = /ach|bank/i.test(String(txn.type ?? '')) || !!txn.bankAccountNumber;
        const nowIso = new Date().toISOString();
        const { error: uErr } = await admin.from('payments').update({
          status: isBank ? 'pending' : 'succeeded',
          provider_transaction_id: String(txn.transactionId ?? txn.id ?? helcimTransactionId),
          method: isBank ? 'ach' : 'card',
          method_display: txn.cardNumber ? `${txn.cardType ?? 'Card'} ····${String(txn.cardNumber).slice(-4)}` : null,
          fee_cents: fee, total_charged_cents: chargedCents,
          approved_at: nowIso, settled_at: isBank ? null : nowIso,
          completed_at: isBank ? null : nowIso, failure_category: null,
        }).eq('id', paymentId);
        if (uErr) return json({ error: uErr.message }, 500);

        await admin.from('payment_events').insert({ payment_id: paymentId, invoice_id: pay.invoice_id,
          event: 'recovered_settled', source: 'admin',
          detail: { txn_id: helcimTransactionId, base_cents: base, fee_cents: fee,
                    charged_cents: chargedCents, note: 'manually reconciled by admin from Helcim dashboard' } });
        await admin.rpc('recalc_invoice_status', { p_invoice_id: pay.invoice_id });
        if (!isBank) {
          await admin.from('invoices').update({ paid_via: 'helcim', payment_id: paymentId }).eq('id', pay.invoice_id);
        }
        await logAction(admin, user.id, 'payment_reconciled',
          `${pay.invoice_id} reconciled to Helcim txn ${helcimTransactionId} — $${(chargedCents/100).toFixed(2)}`);

        const { data: invAfter } = await admin.from('invoices').select('status').eq('id', pay.invoice_id).maybeSingle();
        return json({ ok: true, payment_status: isBank ? 'pending' : 'succeeded',
          invoice_status: invAfter?.status, fee_cents: fee, charged_cents: chargedCents });
      }

      case 'delete-invoice': {
        const { invoiceId } = body;
        if (!invoiceId) return json({ error: 'invoiceId required' }, 400);

        const { data: invArr, error: invErr } = await admin.from('invoices').select('*').eq('id', invoiceId);
        if (invErr) return json({ error: invErr.message }, 500);
        const inv = invArr?.[0];
        if (!inv) return json({ error: 'Invoice not found' }, 404);

        const { count, error: cErr } = await admin.from('payments')
          .select('id', { count: 'exact', head: true }).eq('invoice_id', invoiceId);
        if (cErr) return json({ error: cErr.message }, 500);

        if ((count ?? 0) > 0) {
          if (inv.status === 'paid') {
            return json({ error: 'A paid invoice cannot be deleted. Refund it in Helcim first if it was taken in error.' }, 409);
          }
          const { error: vErr } = await admin.from('invoices')
            .update({ status: 'void' }).eq('id', invoiceId);
          if (vErr) return json({ error: vErr.message }, 500);
          await logAction(admin, user.id, 'invoice_voided',
            `${invoiceId} voided (${count} payment record${count === 1 ? '' : 's'} preserved) — ${inv.customer_name || ''}`);
          return json({ ok: true, action: 'voided', payment_rows: count,
            message: `Invoice ${invoiceId} has payment history and cannot be permanently deleted. It has been voided instead — the customer can no longer pay it, and the payment records are preserved.` });
        }

        const { error: dErr } = await admin.from('invoices').delete().eq('id', invoiceId);
        if (dErr) return json({ error: dErr.message }, 500);
        await logAction(admin, user.id, 'invoice_deleted',
          `${invoiceId} permanently deleted (no payment history) — ${inv.customer_name || ''}`);
        return json({ ok: true, action: 'deleted', message: `Invoice ${invoiceId} permanently deleted.` });
      }

      case 'delete-customer': {
        const { customerId } = body;
        if (!customerId) return json({ error: 'customerId required' }, 400);

        const { data: custArr } = await admin.from('customers').select('name,email').eq('id', customerId);
        const cust = custArr?.[0];

        // Delete auth user — cascade removes customer row
        await admin.auth.admin.deleteUser(customerId);

        await logAction(admin, user.id, 'delete_customer',
          `Customer ${cust?.name || cust?.email || customerId} permanently deleted`);

        return json({ ok: true });
      }

      default:
        return json({ error: `Unknown action: ${action}` }, 400);
    }

  } catch (err) {
    console.error('Edge function error:', err);
    return json({ error: 'Internal server error' }, 500);
  }
});

// ── HELPERS ───────────────────────────────────
function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' }
  });
}

async function logAction(
  admin: ReturnType<typeof createClient>,
  adminUserId: string,
  action: string,
  description: string
) {
  try {
    await admin.from('activity_log').insert({
      actor_id:    adminUserId,
      actor_email: ADMIN_EMAIL,
      action,
      description,
      created_at:  new Date().toISOString()
    });
  } catch (e) {
    // Non-fatal — don't let audit log failure break the action
    console.warn('Audit log failed:', e);
  }
}
