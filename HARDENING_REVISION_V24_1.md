# Phase B/C hardening revision v24.1

Changes made after independent audit:

- `service-plans-customer` requires an active customer account for preview, sign, and decline.
- Signed agreement retrieval remains available after account deactivation.
- `SIGNATURE_IP_SALT` now fails closed before a new agreement can be signed; no public fallback remains.
- `service-plans-admin` refuses to send an offer to an inactive customer. Draft preparation remains allowed.
- Added executable email-render smoke tests for all three Service Plan email event types.
- Production runbook/report now explicitly requires redeploying `outbox-worker` because `_shared/email.ts` is bundled into it.

No Phase A SQL, payment/refund/reversal logic, or recurring-billing gate was changed.
