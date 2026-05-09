# Apex Lift Solutions — Supabase Edge Functions

Two Edge Functions live in `supabase/functions/`:

| Function | Purpose |
|---|---|
| `admin-action` | Sensitive DB writes (create invoice, mark paid, activate customer, delete records) |
| `send-email` | Server-side email via EmailJS — prevents key exposure in browser |

---

## One-time setup

### 1. Install Supabase CLI
```bash
npm install -g supabase
supabase login
supabase link --project-ref cjtezsgfdfijmdxzzbiq
```

### 2. Set secrets
```bash
supabase secrets set EMAILJS_SERVICE_ID=service_lfi9ixk
supabase secrets set EMAILJS_TEMPLATE_ID=template_jpqlmic
supabase secrets set EMAILJS_PUBLIC_KEY=P0tnD3LQqQ6Pujijz
```

### 3. Deploy both functions
```bash
supabase functions deploy admin-action
supabase functions deploy send-email
```

### 4. Update portal-data.js
Change `EDGE_FN_BASE_URL` to your project URL:
```js
const EDGE_FN_BASE_URL = 'https://cjtezsgfdfijmdxzzbiq.supabase.co/functions/v1';
```
(Already set to the correct value in the file.)

---

## How the admin-action function works

Every sensitive admin write goes through this function instead of directly to Supabase:

1. Browser sends request with the admin's JWT
2. Edge Function verifies the JWT server-side
3. Only if `email === 'admin@apexliftsolutionsusa.com'` does it proceed
4. Uses the **service role key** (server-only) to write to the DB
5. Writes an audit log entry to `activity_log`

Actions supported:
- `create-invoice` — converts approved quote to invoice
- `mark-paid` — marks invoice as paid
- `activate-customer` — activates pending customer
- `deactivate-customer` — deactivates customer
- `delete-quote` — permanently deletes quote
- `delete-invoice` — permanently deletes invoice
- `delete-customer` — deletes auth user + customer row

---

## Activity Log table

Run this SQL in your Supabase SQL editor after deploying:

```sql
create table activity_log (
  id          bigint      generated always as identity primary key,
  actor_id    uuid,
  actor_email text,
  action      text        not null,
  description text        not null,
  created_at  timestamptz not null default now()
);

alter table activity_log enable row level security;

-- Only admin can read the log
create policy "admin_read_activity_log"
  on activity_log for select
  using (auth.jwt()->>'email' = 'admin@apexliftsolutionsusa.com');

-- Only the edge function (service role) can insert
-- No insert policy needed — service role bypasses RLS
```

---

## Testing

After deploying, test with curl:

```bash
# Get your admin JWT from the browser: localStorage.getItem('sb-...-auth-token')
TOKEN="your_admin_jwt_here"

curl -X POST \
  https://cjtezsgfdfijmdxzzbiq.supabase.co/functions/v1/admin-action \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"action":"mark-paid","invoiceId":"INV-1234"}'
```
