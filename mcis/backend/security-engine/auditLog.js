const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

// Run this SQL once in Supabase:
// create table audit_log (
//   id uuid primary key default gen_random_uuid(),
//   user_id text not null,
//   action text not null,
//   payload jsonb,
//   success boolean,
//   error text,
//   created_at timestamptz default now()
// );

async function appendAuditLog(userId, action, payload, result) {
  const entry = {
    user_id: userId,
    action,
    payload,
    success: !!(result && result.success),
    error: result && result.error ? String(result.error) : null
  };

  const { error } = await supabase.from('audit_log').insert(entry);
  if (error) console.error('Audit log write failed:', error.message);
  return entry;
}

async function getAuditLog(userId, limit = 50) {
  const { data, error } = await supabase
    .from('audit_log')
    .select('*')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .limit(limit);

  if (error) throw error;
  return data;
}

module.exports = { appendAuditLog, getAuditLog };
