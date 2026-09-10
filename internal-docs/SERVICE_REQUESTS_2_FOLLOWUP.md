# Service Requests 2.0 — follow-up

Not a P0. Recorded so the ordering problem is not rediscovered by accident.

## Uploads happen before the request row exists

`submitRequest()` in `docs/portal-customer.js` uploads each attachment to the
private `apex-uploads` bucket **first**, collects the object paths, and only then
inserts the `service_requests` row.

If that insert fails, the customer correctly sees an error and keeps their form
contents — but the uploaded objects are already in Storage with no row
referencing them. They are **orphaned**, not deleted.

This is why the error copy says *"Your service request was not saved, so your
form details are still here"* rather than *"nothing was saved"*. The second
version would be untrue.

## Impact today

Low. Orphans are private, cost a little storage, and are only created on an
insert failure, which is rare. Nothing is exposed: the bucket is private and RLS
scopes reads to the owning customer.

## What a redesign should do

- Create the request row first, then upload against a confirmed request id; or
- upload to a staging prefix and have a server-authorised step move or claim the
  objects once the row exists; or
- add a server-side sweep that removes unreferenced objects older than some
  agreed window.

**Do not solve this by letting customers delete arbitrary Storage objects.**
Widening the delete policy to clean up orphans would hand every customer a
delete primitive over the bucket — a much worse problem than the one it fixes.
Any cleanup must be server-authorised.

## Owner decision needed

How long an orphaned attachment may persist before a sweep removes it. Ties into
the retention decisions in `GROUP7_OWNER_POLICY_DECISIONS.md` (item D7).
