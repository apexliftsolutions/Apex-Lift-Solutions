# GROUP 7 — OWNER POLICY DECISIONS

Every unresolved policy question in one place. **Nothing here is answered by me.**

The public policy pages no longer display any of this. Where a decision affects a
specific passage, the source HTML carries an `<!-- OWNER POLICY REQUIRED: … -->`
comment pointing here. Visitors see accurate, conservative wording that makes no
promise either way.

`CURRENT IMPLEMENTATION FACT` is what the code does today, verified from source.
It constrains what the policy may truthfully say — it does not decide the policy.

---

## BUSINESS IDENTITY

| # | Decision needed | Current implementation fact | Legal/accounting review |
|---|---|---|---|
| B1 | Legal entity name (LLC, Inc., sole proprietor?) | Site says "Apex Lift Solutions" only. Footer reads `© 2026 Apex Lift Solutions` | Yes |
| B2 | Should a business/mailing address be public? | No address appears anywhere on the site | Yes — some disclosures assume a published address |
| B3 | Publish business hours? | None stated | No |
| B4 | Is `(516) 644-7187` the only public number? | It is the only number in the codebase | No |

---

## QUOTES AND SERVICE CALLS

| # | Decision needed | Current implementation fact | Legal review |
|---|---|---|---|
| Q1 | How long does a quote stay valid? | Quotes have no expiry field or logic | No |
| Q2 | Is there a diagnostic fee? | Not implemented | Yes if charged |
| Q3 | Is there a service-call / trip charge? | Not implemented | Yes if charged |
| Q4 | Travel fee outside a service area? | Not implemented; no service-area boundary in code | Yes if charged |

Terms §4 currently describes quotes without stating any of these.

---

## PAYMENTS

| # | Decision needed | Current implementation fact | Legal/accounting review |
|---|---|---|---|
| P1 | Invoice payment terms (due on receipt? net 15/30?) | Invoices have no due-date field and no terms | Yes |
| P2 | Late fees? | Not implemented | Yes — NY has usury and disclosure considerations |
| P3 | Interest on overdue balances? | Not implemented | Yes |
| P4 | Collection costs / attorney fees? | Not implemented | Yes |

Terms §5 describes how payment works and states no fee of any kind.

---

## FIXED-TERM SERVICE PLANS

**The most important open question in this document.**

### F1 — Early cancellation of a fixed term

When a customer cancels a fixed-term plan before the agreed number of monthly
payments is complete, does Apex:

- **A.** cancel all future automatic charges and waive the remaining term;
- **B.** stop automatic charging but invoice the remaining contractual balance;
- **C.** allow cancellation only under specified conditions (e.g. notice period,
  minimum months served); or
- **D.** something else?

**Current implementation fact.** Cancellation calls the payment provider to stop
future automatic charges and Apex records the cancellation. **There is no code
that invoices a remaining balance, and no code that waives one.** The system is
silent on the contractual question, which is why the policy is too.

**Why this matters.** An earlier draft said "Cancelling stops future billing,"
which reads as though the remaining term is waived — that would have decided
option A by accident. The public wording now separates stopping the provider
charge from any remaining obligation and says to contact Apex.

**Legal review: YES.**

### F2 — Notice period before the next charge

How much notice is needed for a cancellation to take effect before the next
billing date?

**Current implementation fact.** Cancellation takes effect when an administrator
performs it. There is no notice window in code. If it happens after the provider
has already initiated a cycle, that charge may still complete.

**Legal review: yes.**

### F3 — Who may perform lifecycle actions?

**Current implementation fact.** Pause, resume, term change and cancellation are
administrator actions. Customers request them; there is no self-service control
in the customer portal. The Terms say so.

Decision: keep it staff-mediated, or build customer self-service later? Note the
interaction with F4.

**Legal review: yes** — see F4.

### F4 — Automatic-renewal law exposure

**Verified against the official statute on 8 September 2026. Current revision
effective 2025-11-07.** Earlier drafts of this note described a superseded
version; do not rely on secondary summaries written before that date.

**Current Apex implementation fact.** Plans bill a fixed number of monthly
cycles (`term_months`, 1–120, default 6, bounded by `max_cycles`) and then stop.
There is no auto-renewal anywhere in the code, and no plan continues until a
customer cancels. Apex sells to businesses.

**The two statutory definitions that matter** (GBL § 527, current revision):

- **"Automatic renewal"** — an agreement *"automatically renewed at the end of a
  definite term for a subsequent term."*
- **"Consumer"** — *"any individual who seeks or acquires… goods, services,
  money, or credit for **personal, family, or household purposes**."*
- **"Continuous service"** — an arrangement that *"continues until the consumer
  cancels."*

Apex's plans terminate rather than renew into a subsequent term, do not continue
until cancelled, and are sold to businesses rather than to individuals for
household purposes. **Current Apex facts therefore appear to sit outside these
definitions — but counsel should confirm before anyone relies on that
conclusion.** This is issue spotting, not a determination.

**Possible additional exemption worth raising with counsel.** § 527-a(4)(e)
exempts *"sellers and administrators of a service contract, as defined pursuant
to section seven thousand nine hundred two of the insurance law."* Whether a
forklift preventive-maintenance plan is a "service contract" under Insurance Law
§ 7902 is a question for counsel, not something to assume.

### F4a — If Apex ever launches a consumer auto-renewal or continuous-service product

The current § 527-a imposes obligations including, at a high level:

- clear and conspicuous material terms presented **before** consent or billing
  information is requested, in visual or temporal proximity to the consent request;
- **affirmative consent** to the terms before the initial charge;
- affirmative consent to any later **price increase**, or alternatively a
  cancellation window of at least fourteen days after the charge with a pro-rata
  refund of the remaining term;
- a **retainable acknowledgement** promptly after consent, restating the terms,
  the amounts, the frequency, the cancellation deadline and how to cancel;
- a **simple cancellation mechanism** at least as easy as the method used to
  consent and through that same medium, plus cancellation through **all** media
  by which consent can be given;
- **no unreasonable conditions, obstruction or delay** on cancellation;
- several **notice windows**, each with its own trigger.

**On the notice windows.** The current statute contains more than one, and they
are not interchangeable. As an example, § 527-a(1)(f) currently requires notice
**at least fifteen days before, but not more than forty-five days before**, the
cancellation deadline — but only where the offer has an **initial paid term of
one year or longer** *and* **renews for a paid term of six months or longer**.
Separate timing rules apply to material changes to the terms and to qualifying
free-gift or trial arrangements.

**This 15–45 day window is current law, not an obsolete provision.** An earlier
draft of this note first described it imprecisely and then removed it as
"obsolete" — both were wrong. It simply does not reach Apex today, because Apex
has no automatic-renewal or continuous-service offer for the trigger to attach to.

Do not copy any of these windows into Apex product requirements. They are
recorded here only so a future implementer knows the obligations exist and where
to look.

**RECHECK CURRENT LAW BEFORE LAUNCHING ANY FUTURE AUTO-RENEWAL PRODUCT** — and
review **both** GBL §§ 527 / 527-a **and** GOB § 5-903 (below), which are
separate statutes with different scope and different notice periods.

Primary sources, official text:
[GBL § 527 — Definitions](https://www.nysenate.gov/legislation/laws/GBS/527) ·
[GBL § 527-a — Unlawful practices](https://www.nysenate.gov/legislation/laws/GBS/527-A)

**Legal review: YES** before any auto-renewal or continuous-service product, and
before selling a plan to an individual for personal, family or household use.

### F4b — GOB § 5-903: service, maintenance and repair contracts

**This one matters more to Apex's line of business than § 527-a does**, because
it is not limited to household consumers.

**Official source:** [GOB § 5-903](https://www.nysenate.gov/legislation/laws/GOB/5-903)
(most recent revision 2014-09-22).

What it covers, from the statute:

- **"Person" means "an individual, firm, company, partnership or corporation."**
  A business customer is squarely within that definition — unlike § 527-a, there
  is no personal-family-household limit.
- It applies to a **"contract for service, maintenance or repair to or for any
  real or personal property."** A forklift is personal property and Apex's plans
  are maintenance contracts, so the subject matter fits.
- The rule concerns a contract provision stating the term is **deemed renewed for
  a specified additional period** unless the recipient gives notice of intent to
  terminate. Where such a provision exists, it is **unenforceable against the
  recipient** unless the furnisher gave written notice — served personally or by
  certified mail — **at least fifteen days and not more than thirty days** before
  the deadline for the recipient's termination notice.
- Subdivision 3 excludes contracts where **the automatic renewal period is one
  month or less**.

**Note the windows differ.** § 527-a(1)(f) is 15–45 days; § 5-903 is 15–30 days,
and § 5-903 additionally requires personal service or certified mail. Do not
conflate them.

**Current Apex effect.** The current plan bills a fixed number of monthly cycles
and stops. There is no provision deeming the term renewed for an additional
period, so the trigger for § 5-903 **appears absent on current implementation
facts**. Classify as **likely not triggered — counsel to confirm, and to
re-confirm if the contract language changes.** This is issue spotting, not a
determination.

**Future true auto-renewal plan.** § 5-903 must be reviewed **in addition to**
GBL §§ 527 / 527-a. Because § 5-903 reaches business customers, it could bite
even where § 527-a does not.

**Legal review: YES** before adding any renewal provision to a service plan
agreement.

---

## REFUNDS

| # | Decision needed | Current implementation fact | Legal review |
|---|---|---|---|
| R1 | When does payment for completed labour become non-refundable? | Full and partial refunds are technically possible at any time. Capability is not entitlement | Yes |
| R2 | Are diagnostic / service-call payments refundable if work is declined? | Not implemented as a distinct charge (see Q2/Q3) | Yes |
| R3 | Are deposits taken, and are they refundable? | No deposit concept exists in the schema | Yes |
| R4 | Special-order parts once ordered? | No parts-ordering module exists | Yes |
| R5 | Target timeframe for reviewing a refund request? | No SLA in code | No |
| R6 | Any unused portion of a cancelled fixed-term plan? | No proration logic exists | Yes — tied to F1 |

**Current implementation fact for all of the above.** The ledger is append-only:
the original payment is never altered, a correction is appended and linked to it,
and the net retained amount is derived. Full refunds, partial refunds and
reversals are all supported. **None of this establishes who is entitled to one.**

---

## WARRANTY AND LIABILITY

| # | Decision needed | Current implementation fact | Legal review |
|---|---|---|---|
| W1 | Labour warranty period | Nothing in code or site | **Yes — start here** |
| W2 | Parts warranty (or pass-through of manufacturer warranty) | Nothing in code or site | Yes |
| W3 | Limitation of liability | No language anywhere | Yes |
| W4 | Insurance representations, if any | None made | Yes |

Terms §10 currently contains no warranty or liability language at all. This is
the largest single gap in the set and the first thing counsel should look at.

---

## ELECTRONIC SIGNATURES

**Current implementation fact.** Signing records: typed signature, signer name
and title, four separate affirmative consent confirmations, timestamp, user
agent, a salted one-way hash derived from the network address (**the raw address
is not stored**), an immutable snapshot of the agreement, a stored PDF, and
SHA-256 hashes of both the document and the snapshot. The customer can retrieve
the signed agreement from the portal at any time.

| # | Decision needed | Legal review |
|---|---|---|
| E1 | Does counsel want explicit ESIGN / NY ESRA consent language, including paper-copy rights and withdrawal of consent to electronic records? Terms now express **intent to sign electronically**, not a conclusion that the agreement is legally equivalent to paper | Yes |
| E2 | Should the four consent checkboxes be reworded by counsel? | Yes |
| E3 | Consumer vs business applicability of ESIGN / ESRA to these agreements | Yes |
| E4 | Does counsel want stronger account-risk language? Terms deliberately do NOT state that all activity through an account is authorised by the account holder | Yes |

**Do not represent the implementation as satisfying every element of ESIGN or
UETA without that review.**

---

## GOVERNING LAW AND VENUE

| # | Decision needed | Legal review |
|---|---|---|
| G1 | Governing state (New York assumed but not stated) | Yes |
| G2 | Venue / county | Yes |
| G3 | Any dispute-resolution mechanism (arbitration? class waiver?) — **none is currently asserted, and none should be added without counsel** | Yes |

---

## DATA RETENTION

**Current implementation fact.** There is **no retention or deletion logic
anywhere** — no scheduled purge, no TTL, no anonymisation job. Records persist
until deleted by hand. The public policy now says information is kept for as long
as reasonably necessary for the stated purposes, which is accurate, and states no
number.

| # | Category | Decision needed | Review |
|---|---|---|---|
| D1 | Customer account records | How long after an account closes? | Legal |
| D2 | Enquiries from people who never became customers | Contact/careers submissions | Legal |
| D3 | Service history | Retention period | Legal + accounting |
| D4 | Invoices, payments, refunds | Almost certainly the longest — tax and business records | **Accounting** |
| D5 | Signed service plan agreements | Contract record | Legal |
| D6 | Audit log / activity log / service plan events | Security records with PII in payloads | Legal |
| D7 | Uploaded files (`apex-uploads`) | Photos and documents attached to quotes and requests | Legal |

**Do not adopt 30 / 90 days or 7 years without an accounting and legal basis.**
Different categories will justify different answers.

---

## NEW YORK ISSUE SPOTTING (internal note)

Issue spotting only. Not legal advice, and no compliance determination.

| Topic | Assessment | Note |
|---|---|---|
| NY SHIELD Act — reasonable safeguards for private information | **LIKELY APPLICABLE** | Applies to any business holding NY residents' private information. Existing controls (RLS, hashed signer IPs, no stored card data, server-side authorisation) are relevant evidence but establish nothing on their own. Policy copy does not need to name the statute |
| Automatic renewal — consumer (GBL §§ 527, 527-a, rev. 2025-11-07) | **POSSIBLY APPLICABLE** | See F4. Current facts appear outside the statutory definitions; counsel to confirm |
| Automatic renewal — service/maintenance/repair contracts (GOB § 5-903) | **POSSIBLY APPLICABLE** | See F4b. **Not limited to household consumers** — reaches firms, companies, partnerships and corporations. Trigger appears absent because Apex plans contain no renewal provision; counsel to confirm |
| Electronic signatures (ESIGN / NY ESRA) | **LIKELY APPLICABLE** | See E1 |
| Website accessibility (ADA Title III) | **POSSIBLY APPLICABLE** | Group 3 work is genuine but unaudited. The statement claims no compliance |
| Refund / cancellation disclosure | **LIKELY APPLICABLE** in substance | A clear, accurate, reachable policy — which now exists, minus the open decisions above |
| Card surcharge disclosure | **POSSIBLY APPLICABLE** | Service plans price card and bank transfer differently and both prices are shown before signing. Worth confirming this presentation satisfies NY's surcharge disclosure rules |

**None of the above should be read as a statement that Apex complies with
anything.** Each row needs an attorney.
