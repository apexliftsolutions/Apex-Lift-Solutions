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
      case 'create-invoice': {
        const { quoteId } = body;
        if (!quoteId) return json({ error: 'quoteId required' }, 400);

        const { data: quotes } = await admin.from('quotes').select('*').eq('id', quoteId);
        const q = quotes?.[0];
        if (!q) return json({ error: 'Quote not found' }, 404);

        const due = new Date();
        due.setDate(due.getDate() + 30);

        // Tax is COPIED from the approved quote, never recalculated. The quote
        // is a price the customer accepted; if the default rate changes later,
        // the invoice must still reflect what was agreed.
        const { data: inv, error: invErr } = await admin.from('invoices').insert({
          customer_id:        q.customer_id,
          customer_email:     q.customer_email,
          customer_name:      q.customer_name,
          company:            q.company,
          description:        q.description,
          items:              q.items,
          subtotal_cents:     q.subtotal_cents,
          tax_cents:          q.tax_cents ?? 0,
          tax_rate_milli_pct: q.tax_rate_milli_pct ?? 0,
          tax_exempt:         q.tax_exempt ?? false,
          tax_jurisdiction:   q.tax_jurisdiction,
          amount:             q.amount,       // already tax-inclusive
          status:             'unpaid',
          due:                due.toISOString(),
          quote_id:           q.id,
        }).select().single();

        if (invErr) return json({ error: invErr.message }, 500);

        // Mark quote as invoiced
        await admin.from('quotes').update({ invoiced: true }).eq('id', quoteId);

        // Audit log
        await logAction(admin, user.id, 'create_invoice',
          `Invoice ${inv.id} created from quote ${quoteId} for ${q.customer_name} — $${parseFloat(q.amount).toFixed(2)}`);

        return json({ invoice: inv });
      }

      // Mark invoice as paid
      // Record a payment taken outside the portal (check, cash, wire, terminal).
      // Writes a payments row — history is never overwritten — then marks paid.
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
      case 'delete-invoice': {
        const { invoiceId } = body;
        if (!invoiceId) return json({ error: 'invoiceId required' }, 400);

        await admin.from('invoices').delete().eq('id', invoiceId);
        await logAction(admin, user.id, 'delete_invoice', `Invoice ${invoiceId} deleted`);

        return json({ ok: true });
      }

      // Delete customer (also deletes auth user via cascade)
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
