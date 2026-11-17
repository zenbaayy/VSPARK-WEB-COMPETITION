import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-client-info',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
});

Deno.serve(async request => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (request.method !== 'POST') return json({ error: 'POST required' }, 405);
  const url = Deno.env.get('SUPABASE_URL');
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY');
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || Deno.env.get('SUPABASE_SECRET_KEY');
  const authorization = request.headers.get('Authorization');
  if (!url || !anonKey || !serviceKey || !authorization) return json({ error: 'Admin account service is not configured' }, 500);

  const callerClient = createClient(url, anonKey, { global: { headers: { Authorization: authorization } }, auth: { persistSession: false } });
  const { data: { user: caller }, error: authError } = await callerClient.auth.getUser();
  if (authError || !caller) return json({ error: 'Sign in required' }, 401);
  const service = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data: callerProfile, error: callerProfileError } = await service.from('profiles').select('role').eq('id', caller.id).maybeSingle();
  if (callerProfileError) return json({ error: callerProfileError.message }, 500);
  if (callerProfile?.role !== 'admin') return json({ error: 'Organizer access required' }, 403);
  const { data: mainAdmin } = await service.from('profiles').select('id').eq('role', 'admin').order('created_at', { ascending: true }).limit(1).maybeSingle();

  let body: { action?: string; userId?: string; email?: string; password?: string };
  try { body = await request.json(); } catch { return json({ error: 'Invalid JSON request' }, 400); }

  if (body.action === 'list') {
    const [profilesResult, usersResult] = await Promise.all([
      service.from('profiles').select('id,full_name,role,created_at').order('created_at', { ascending: true }),
      service.auth.admin.listUsers({ page: 1, perPage: 1000 }),
    ]);
    if (profilesResult.error) return json({ error: profilesResult.error.message }, 500);
    if (usersResult.error) return json({ error: usersResult.error.message }, 500);
    const emails = new Map(usersResult.data.users.map(account => [account.id, account.email || '']));
    return json({ users: profilesResult.data.map(profile => ({ ...profile, email: emails.get(profile.id) || '' })) });
  }

  if (body.action !== 'update' || !body.userId) return json({ error: 'Unsupported action or missing user ID' }, 400);
  if (body.userId === caller.id) return json({ error: 'You cannot change your own account from this panel' }, 400);
  if (body.userId === mainAdmin?.id) return json({ error: 'The main administrator account is protected' }, 403);
  const updates: { email?: string; password?: string; email_confirm?: boolean } = {};
  if (body.email !== undefined) {
    const email = body.email.trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return json({ error: 'Enter a valid email address' }, 400);
    updates.email = email;
    updates.email_confirm = false;
  }
  if (body.password !== undefined) {
    if (body.password.length < 8) return json({ error: 'Password must contain at least 8 characters' }, 400);
    updates.password = body.password;
  }
  if (!updates.email && !updates.password) return json({ error: 'Provide a new email or password' }, 400);
  const { data, error } = await service.auth.admin.updateUserById(body.userId, updates);
  if (error) return json({ error: error.message }, 400);
  return json({ user: { id: data.user.id, email: data.user.email || '' }, emailConfirmationRequired: !!updates.email });
});
