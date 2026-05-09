# Apex Lift Solutions — RLS & OTP Testing Guide

## What this document covers
1. One-time Supabase dashboard setup for the new OTP flow
2. How to test RLS with two real customer accounts
3. What to look for and how to confirm it's working

---

## Part 1 — Enable Supabase Email OTP (one-time setup)

The new `portal-forgot.js` uses `signInWithOtp()` instead of a browser-generated
code. Supabase needs one setting enabled for this to work.

**Step 1 — Enable OTP in Auth settings**
1. Supabase Dashboard → **Authentication → Providers**
2. Click **Email** (it should already be enabled)
3. Make sure **"Enable Email Signup"** is ON
4. Scroll to **"OTP expiry"** — set to `600` (10 minutes is standard)
5. Save

**Step 2 — Check the OTP email template**
1. Dashboard → **Authentication → Email Templates**
2. Select **"Magic Link"** from the dropdown
   (Supabase uses the Magic Link template for `signInWithOtp` OTP codes too)
3. Make sure `{{ .Token }}` appears somewhere in the body — this is the 6-digit code
4. If you want to customize the email, edit the template here

**Step 3 — Confirm your SMTP is set up (optional but recommended)**
By default Supabase uses its own email relay (limited to ~4 emails/hour on free tier).
For production: Dashboard → **Project Settings → Auth → SMTP Settings**
Add your own SMTP server (SendGrid, Postmark, etc.) for higher limits.

That is the only setup needed. No EmailJS configuration required for the reset flow.

---

## Part 2 — RLS Testing with Two Customer Accounts

### What you are testing
Row Level Security means that when Customer A is logged in, a Supabase query
for `quotes` returns **only Customer A's rows**, even if Customer A crafts a
direct API request removing their own filter. The database enforces it.

### Setup — Create two test accounts

**Option A: Self-register via the portal (easiest)**
1. Go to `portal-login.html` → Register tab
2. Create `testcustomer1@yourdomain.com` with any password
3. Create `testcustomer2@yourdomain.com` with any password
4. Both will have `status: 'pending'` — activate both in the Admin portal

**Option B: Create directly in Supabase**
1. Dashboard → Authentication → Users → Add User
2. Add both test emails and set passwords
3. Run this SQL to create their customer profile rows
   (replace the UUIDs with the actual IDs shown in Auth → Users):

```sql
INSERT INTO customers (id, email, name, company, phone, status, since) VALUES
  ('UUID-OF-USER-1', 'testcustomer1@yourdomain.com', 'Test Customer One', 'Company A', '(555) 111-0001', 'active', 'May 2026'),
  ('UUID-OF-USER-2', 'testcustomer2@yourdomain.com', 'Test Customer Two', 'Company B', '(555) 222-0002', 'active', 'May 2026');
```

### Setup — Create test data for each customer

Log in to `portal-admin.html` and create:
- 1 quote for Customer One (note the quote ID, e.g. `Q-1234`)
- 1 quote for Customer Two (note the quote ID, e.g. `Q-5678`)
- 1 invoice for each (convert the approved quote to an invoice)

---

### Test 1 — Portal UI isolation (basic check)

1. Log in as **Customer One** → My Quotes
   **Expected:** Only Q-1234 appears. Q-5678 is not visible.

2. Log in as **Customer Two** → My Quotes
   **Expected:** Only Q-5678 appears. Q-1234 is not visible.

If either customer can see the other's data in the UI, something is wrong with
how the query is filtered in `portal-customer.js`. Check `loadQuotes()` —
it should always include `.eq('customer_id', USER.id)`.

---

### Test 2 — Direct API bypass attempt (the real RLS test)

This tests whether RLS blocks requests that remove the customer_id filter.

1. Log in as **Customer One** in the browser
2. Open DevTools → Console
3. Get the Supabase anon key and Customer One's session token:

```javascript
const { data: { session } } = await sb.auth.getSession();
console.log('Token:', session.access_token);
console.log('User ID:', session.user.id);
```

4. Now try to fetch ALL quotes by removing the customer_id filter:

```javascript
// This is what a malicious user would try — no customer_id filter
const { data, error } = await sb.from('quotes').select('*');
console.log('Rows returned:', data?.length);
console.log('Data:', data);
console.log('Error:', error);
```

**Expected result:** `data` contains ONLY Customer One's quotes.
Customer Two's quotes do NOT appear, even though no `.eq('customer_id')` was set.
This is RLS working — the database adds the filter automatically based on the JWT.

5. Try the same for invoices and service_history:

```javascript
const { data: inv } = await sb.from('invoices').select('*');
console.log('Invoices visible:', inv?.length, inv?.map(i => i.customer_email));

const { data: hist } = await sb.from('service_history').select('*');
console.log('History visible:', hist?.length);
```

**Expected:** Each returns only Customer One's rows.

6. Repeat steps 1–5 logged in as **Customer Two**.
   Expected: same behaviour — only their own rows.

---

### Test 3 — Direct REST API bypass (tightest test)

This removes even the Supabase JS client from the equation.

1. Logged in as Customer One, get the session token (step 2 above)
2. Open a new terminal or use the browser fetch API:

```javascript
// Attempt to read ALL quotes via raw REST — no customer_id filter
const token = session.access_token;
const res = await fetch(
  'https://cjtezsgfdfijmdxzzbiq.supabase.co/rest/v1/quotes?select=*',
  {
    headers: {
      'apikey': 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImNqdGV6c2dmZGZpam1keHp6YmlxIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzgxNjg2OTIsImV4cCI6MjA5Mzc0NDY5Mn0.FkfIFgm5TUKa05nK4QQWdBRgK2cv3oPvq5MQArEUqbw',
      'Authorization': 'Bearer ' + token
    }
  }
);
const rows = await res.json();
console.log('Rows returned:', rows.length, rows.map(q => q.customer_email));
```

**Expected:** Only Customer One's quotes. RLS applies to the REST API too —
it is not a JS-layer protection, it is a database-layer protection.

---

### Test 4 — Anon key attempt (unauthenticated)

```javascript
// Try reading quotes with no user session — just the anon key
const res = await fetch(
  'https://cjtezsgfdfijmdxzzbiq.supabase.co/rest/v1/quotes?select=*',
  {
    headers: {
      'apikey': 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImNqdGV6c2dmZGZpam1keHp6YmlxIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzgxNjg2OTIsImV4cCI6MjA5Mzc0NDY5Mn0.FkfIFgm5TUKa05nK4QQWdBRgK2cv3oPvq5MQArEUqbw',
      'Authorization': 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImNqdGV6c2dmZGZpam1keHp6YmlxIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzgxNjg2OTIsImV4cCI6MjA5Mzc0NDY5Mn0.FkfIFgm5TUKa05nK4QQWdBRgK2cv3oPvq5MQArEUqbw'
    }
  }
);
const rows = await res.json();
console.log('Rows returned unauthenticated:', rows);
```

**Expected:** Empty array `[]` — no quotes visible to an unauthenticated caller.

---

### Test 5 — OTP bypass attempt (confirms the fix)

1. Go to `portal-forgot.html`
2. Open DevTools Console
3. Enter a valid email and click "Send Verification Code"
4. While on step 2, try the old bypass in the console:

```javascript
// Old code had: _verified = true  → then step3() would run
// New code has no _verified variable at all
console.log(typeof _verified);        // should print "undefined"
console.log(typeof _forgotEmail);     // prints the email (not a secret)
```

5. Try calling `step3()` directly without entering the code:

```javascript
await step3();
```

**Expected:** Supabase returns an error like `"Auth session missing"` or
`"JWT expired"` because `updateUser()` requires a valid session that
`verifyOtp()` would have established. The password is not changed.

6. Enter a wrong code 5 times.
   **Expected:** UI shows "Too many incorrect attempts. Use Resend code."
   and the Verify button becomes inert until resend is clicked.

---

## Part 3 — Admin RLS test

While logged in as a customer, try to read the admin's data:

```javascript
// Try to read ALL customers (admin-only table)
const { data, error } = await sb.from('customers').select('*');
console.log('Customers visible:', data?.length);
```

**Expected:** `data` contains only the logged-in customer's own profile row
(because of the "Customer read own profile" policy). Not all customers.

Admin query (log in as admin to confirm the other side):

```javascript
// Logged in as admin — should see ALL customers
const { data } = await sb.from('customers').select('*');
console.log('All customers:', data?.length);   // should be total count
```

---

## Checklist — what passing looks like

| Test | Pass condition |
|---|---|
| Customer 1 UI only shows own data | ✓ |
| Customer 2 UI only shows own data | ✓ |
| Raw JS query (no filter) returns only own rows | ✓ |
| Raw REST API query returns only own rows | ✓ |
| Unauthenticated request returns empty array | ✓ |
| `_verified = true` in console does not change password | ✓ |
| Typing wrong OTP 5× locks the verify button | ✓ |
| `step3()` called without verifyOtp returns Supabase auth error | ✓ |
| Admin can see all customers | ✓ |
| Customer cannot see other customers | ✓ |
