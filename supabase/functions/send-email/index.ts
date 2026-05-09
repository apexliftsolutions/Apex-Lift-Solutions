// =============================================
//  APEX LIFT SOLUTIONS — send-email/index.ts
//  Supabase Edge Function for transactional email.
//
//  Moves email sending from the browser (EmailJS)
//  to the server — the admin key stays server-side,
//  email is guaranteed even if browser closes.
//
//  DEPLOY:
//    supabase functions deploy send-email
//
//  Set secret: supabase secrets set EMAILJS_SERVICE_ID=service_lfi9ixk
//              supabase secrets set EMAILJS_TEMPLATE_ID=template_jpqlmic
//              supabase secrets set EMAILJS_PUBLIC_KEY=P0tnD3LQqQ6Pujijz
// =============================================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const ADMIN_EMAIL      = 'admin@apexliftsolutionsusa.com';
const ADMIN_EMAIL_2    = 'apexliftsolutions1@gmail.com';
const EMAILJS_SVC      = Deno.env.get('EMAILJS_SERVICE_ID')  || 'service_lfi9ixk';
const EMAILJS_TPL      = Deno.env.get('EMAILJS_TEMPLATE_ID') || 'template_jpqlmic';
const EMAILJS_KEY      = Deno.env.get('EMAILJS_PUBLIC_KEY')  || 'P0tnD3LQqQ6Pujijz';

const corsHeaders = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    // Verify caller has a valid Supabase session (admin or customer)
    const authHeader = req.headers.get('Authorization');
    if (!authHeader) return json({ error: 'Unauthorized' }, 401);

    const userClient = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_ANON_KEY')!,
      { global: { headers: { Authorization: authHeader } } }
    );
    const { data: { user } } = await userClient.auth.getUser();
    if (!user) return json({ error: 'Unauthorized' }, 401);

    const { to_email, to_name, subject, message } = await req.json();
    if (!to_email || !subject || !message) {
      return json({ error: 'to_email, subject, and message are required' }, 400);
    }

    // Customers can only send to admin (prevents email abuse)
    const isAdmin = user.email === ADMIN_EMAIL;
    const targets = isAdmin
      ? [{ email: to_email, name: to_name || '' }]
      : [
          { email: ADMIN_EMAIL,   name: 'Apex Lift Solutions' },
          { email: ADMIN_EMAIL_2, name: 'Apex Lift Solutions' }
        ];

    const results = await Promise.allSettled(
      targets.map(t =>
        fetch('https://api.emailjs.com/api/v1.0/email/send', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            service_id:  EMAILJS_SVC,
            template_id: EMAILJS_TPL,
            user_id:     EMAILJS_KEY,
            template_params: {
              to_email: t.email,
              to_name:  t.name,
              subject,
              message
            }
          })
        })
      )
    );

    const failed = results.filter(r => r.status === 'rejected').length;
    return json({ ok: true, sent: targets.length - failed, failed });

  } catch (err) {
    console.error('send-email error:', err);
    return json({ error: 'Internal server error' }, 500);
  }
});

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' }
  });
}
