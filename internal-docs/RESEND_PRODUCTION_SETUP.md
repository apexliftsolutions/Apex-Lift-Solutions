# Resend Setup

## 1–5. Account and domain
1. Sign up at resend.com.
2. **Domains → Add Domain** → `apexliftsolutionsusa.com`.
3. Resend shows DNS records — typically:
   - `MX` on `send.apexliftsolutionsusa.com` (bounce handling)
   - `TXT` SPF on `send.` → `v=spf1 include:amazonses.com ~all`
   - `TXT` DKIM on `resend._domainkey` → long public key
4. Add each record in **Namecheap → Domain List → Manage → Advanced DNS**.
   Namecheap appends the domain automatically — enter `resend._domainkey`, not
   the full hostname, or you'll get `resend._domainkey.apexliftsolutionsusa.com.apexliftsolutionsusa.com`.
5. Wait for **Verified**. Usually minutes; DNS can take up to 48h.

**DMARC (recommended, not required by Resend).** Add a `TXT` at `_dmarc`:
```
v=DMARC1; p=none; rua=mailto:admin@apexliftsolutionsusa.com
```
Start at `p=none` to observe. Move to `p=quarantine` after a few weeks of clean
reports. Going straight to `p=reject` can silently drop your own mail.

## 6–9. Key and addresses
6. **API Keys → Create** → *Sending access* only, restricted to your domain.
7. `supabase secrets set RESEND_API_KEY=…`
8. From: `Apex Lift Solutions <notifications@apexliftsolutionsusa.com>`
9. Reply-To: `service@apexliftsolutionsusa.com` — must be a mailbox you read.
   Customers *will* reply to receipts.

## 10–12. Verify
10. Insert one test row and run the worker:
```sql
select enqueue_notification('test:'||gen_random_uuid(), 'invoice_created',
  'your-own@email.com', 'invoice', 'INV-TEST',
  '{"invoice_id":"INV-TEST","customer_name":"Test","amount":123.45}'::jsonb);
```
```bash
curl -X POST https://cjtezsgfdfijmdxzzbiq.supabase.co/functions/v1/outbox-worker \
  -H "x-outbox-key: $OUTBOX_WORKER_KEY"
```
Expect `{"sent":1,"failed":0}` and an email.

11. Check `notification_outbox` — status should be `sent` with a
    `provider_msg_id`. Send to a Gmail address and check **Show original**:
    SPF, DKIM and DMARC should all read PASS.
12. EmailJS is already fully removed from this build. Nothing to disable.
