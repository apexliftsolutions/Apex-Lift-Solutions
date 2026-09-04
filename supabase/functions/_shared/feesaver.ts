// Shared Fee Saver amount reconciliation. Used by payment-validate and
// payment-events so the browser path and the webhook path can never disagree.
//
// THE PROBLEM
//   With Fee Saver, a CARD transaction's `amount` from Helcim is the TOTAL
//   charged (base invoice + convenience fee). Helcim's card-transaction object
//   does not document a field that separates the two, so the fee can only be
//   INFERRED as (charged - base).
//
// THE RULE
//   ACH  : no fee is ever applied. charged must equal base EXACTLY.
//   CARD : charged must be >= base. The inferred fee must be within a ceiling
//          read from app_config. Anything else does not auto-settle.
//
// We are not calculating Helcim's fee. We are bounding what we will accept
// without a human looking at it.

export type Reconciled =
  | { ok: true;  baseCents: number; feeCents: number; totalCents: number }
  | { ok: false; reason: "underpaid" | "fee_out_of_bounds" | "currency_mismatch";
      baseCents: number; totalCents: number; impliedFeeCents: number };

export async function reconcileAmount(
  sb: { from: (t: string) => { select: (c: string) => { eq: (k: string, v: string) => { maybeSingle: () => Promise<{ data: { value?: string } | null }> } } } },
  opts: { baseCents: number; chargedCents: number; currency: string; expectedCurrency: string; isACH: boolean },
): Promise<Reconciled> {
  const { baseCents, chargedCents, currency, expectedCurrency, isACH } = opts;

  if (currency !== expectedCurrency) {
    return { ok: false, reason: "currency_mismatch", baseCents, totalCents: chargedCents, impliedFeeCents: 0 };
  }

  // Underpayment is never acceptable, on either rail.
  if (chargedCents < baseCents) {
    return { ok: false, reason: "underpaid", baseCents, totalCents: chargedCents,
             impliedFeeCents: chargedCents - baseCents };
  }

  const impliedFee = chargedCents - baseCents;

  // ACH carries no convenience fee. Any surplus is unexplained.
  if (isACH) {
    if (impliedFee !== 0) {
      return { ok: false, reason: "fee_out_of_bounds", baseCents, totalCents: chargedCents, impliedFeeCents: impliedFee };
    }
    return { ok: true, baseCents, feeCents: 0, totalCents: chargedCents };
  }

  if (impliedFee === 0) {
    // Fee Saver did not apply (or the card was exempt). Perfectly valid.
    return { ok: true, baseCents, feeCents: 0, totalCents: chargedCents };
  }

  // Card with a fee: bound it against the configured ceiling.
  const bps   = Number((await cfg(sb, "feesaver_max_fee_bps"))        ?? "500");
  const floor = Number((await cfg(sb, "feesaver_max_fee_floor_cents")) ?? "100");
  const ceiling = Math.max(Math.ceil((baseCents * bps) / 10_000), floor);

  if (impliedFee > ceiling) {
    return { ok: false, reason: "fee_out_of_bounds", baseCents, totalCents: chargedCents, impliedFeeCents: impliedFee };
  }
  return { ok: true, baseCents, feeCents: impliedFee, totalCents: chargedCents };
}

async function cfg(sb: never, key: string): Promise<string | null> {
  // deno-lint-ignore no-explicit-any
  const { data } = await (sb as any).from("app_config").select("value").eq("key", key).maybeSingle();
  return data?.value ?? null;
}

// Helcim reports ACH under a bank/ACH transaction type.
export const looksACH = (t: Record<string, unknown>, eventType = "") =>
  /ach|bank/i.test(String(t?.type ?? "")) || /bank/i.test(eventType) ||
  !!t?.bankAccountNumber || !!t?.bankToken;
