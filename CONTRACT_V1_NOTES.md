# Apex Fixed-Term Monthly Maintenance Agreement V1

This revision is a production-candidate contract renderer for commercial forklift maintenance plans.

Changes from the prior draft:
- Contract title changed to Fixed-Term Monthly Maintenance Agreement.
- Removed draft-only phrases from substantive clauses.
- Fixed term / no ordinary customer cancellation is explicit.
- No automatic renewal.
- Failed or returned payment does not itself cancel the agreement.
- Added customer responsibilities, safe access, scheduling/service limitations, records/communications, entire-agreement/change control, severability/waiver language, New York governing-law clause, and stronger electronic-signature/record language.
- Recurring authorization remains tied to the exact monthly amount and exact number of cycles.
- Live PDFs no longer display "subject to legal review" annotations.
- Test-mode PDFs still display DRAFT/PENDING LEGAL REVIEW so test documents cannot be mistaken for live contracts.
- Agreement version is APEX-MMA-2026-09-V1.

Important implementation rule:
Existing signed agreements are immutable and are not rewritten. Create a new offer/agreement for any real customer who should sign V1.

`GO_LIVE_CONTRACT_V1.sql` changes only the contract mode/version and explicitly keeps `recurring_billing_enabled=false`.
