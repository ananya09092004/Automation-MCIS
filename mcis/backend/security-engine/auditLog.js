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

// workspaceId is optional (Layer 2). Existing callers — including the voice
// command path — pass 4 arguments and write exactly the same row as before.
async function appendAuditLog(userId, action, payload, result, workspaceId = null) {
  const entry = {
    user_id: userId,
    action,
    payload,
    success: !!(result && result.success),
    error: result && result.error ? String(result.error) : null
  };
  if (workspaceId) entry.workspace_id = workspaceId;

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

// Workspace audit trail (Layer 2). Callers MUST pass a workspace id that was
// resolved server-side and authorize the reader (admin/owner) themselves.
async function getWorkspaceAuditLog(workspaceId, { limit = 50, before = null } = {}) {
  let q = supabase
    .from('audit_log')
    .select('id, user_id, action, payload, success, error, created_at')
    .eq('workspace_id', workspaceId)
    .order('created_at', { ascending: false })
    .limit(Math.min(Math.max(parseInt(limit, 10) || 50, 1), 200));
  if (before) q = q.lt('created_at', before);
  const { data, error } = await q;
  if (error) throw error;
  return data || [];
}

module.exports = { appendAuditLog, getAuditLog, getWorkspaceAuditLog };
