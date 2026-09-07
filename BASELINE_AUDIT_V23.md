# Apex V23 Baseline Audit — 2026-09-06

This archive was reviewed before beginning the recurring Service Plans phase.

## Confirmed in source

- `portal-customer.js`: client version `2026-09-06.v23`.
- `payment-checkout`: function version `2026-09-06.v23`, includes net-retained-money retry logic after full provider reversal.
- `payment-validate`: version `2026-09-06.v21`; this is the intentionally preserved fixed validator.
- `payment-refund`: requires an admin refund/void reason and records correction rows via `refund_of`.
- `payment-events`: uses current ACH direct path shape `ach/transactions/{id}`.
- `payment-reconcile`: uses card `dateFrom/dateTo` and ACH `startDate/endDate`, plus direct `ach/transactions/{id}`.
- `outbox-worker`: handles refund/void correction emails with amount, reason, original reference, correction reference, and invoice state.
- `APEX_REFUND_VOID_V22.sql`: separates true refunds from reversals and emits `payment_voided` for reversals.
- Frontend JavaScript syntax checks passed.
- All 12 TypeScript files under `supabase/functions` transpile/parse with zero TypeScript syntax errors.
- No `.env`, PEM/PFX/P12/private key file was present in this reviewed archive. `docs/SECRETS_SETUP.md` contains secret NAMES/examples only, not values.

## Documentation correction

The supplied `CLAUDE_HANDOFF_V23.md` had a stale V22 title/client-version bullet even though the actual code is V23. The cleaned baseline corrects that documentation only; working source behavior is unchanged.

## Important

`CLAUDE_HANDOFF_V22.md` and older integration documents are historical context. For recurring implementation, use this priority:

1. `START_HERE_CLAUDE_MONTHLY_V24.md`
2. `CLAUDE_HANDOFF_V23.md`
3. current source code / production migrations
4. older V22/historical notes
