const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

// Run this SQL once in Supabase:
// create table user_permissions (
//   id uuid primary key default gen_random_uuid(),
//   user_id text not null,
//   resource_name text not null,
//   granted boolean default true,
//   granted_at timestamptz default now(),
//   unique(user_id, resource_name)
// );

const SAFE_LIST = ['notepad', 'calculator', 'file explorer', 'finder'];

async function isPermitted(userId, resourceName) {
  return true; // TEMP: bypass for testing — REMOVE before real use
  if (!resourceName) return true;
  if (SAFE_LIST.includes(resourceName.toLowerCase())) return true;

  const { data } = await supabase
    .from('user_permissions')
    .select('granted')
    .eq('user_id', userId)
    .eq('resource_name', resourceName)
    .single();

  return !!(data && data.granted);
}

async function grantPermission(userId, resourceName) {
  const { error } = await supabase
    .from('user_permissions')
    .upsert({ user_id: userId, resource_name: resourceName, granted: true }, { onConflict: 'user_id,resource_name' });

  if (error) throw error;
  return { success: true, userId, resourceName };
}

async function revokePermission(userId, resourceName) {
  const { error } = await supabase
    .from('user_permissions')
    .update({ granted: false })
    .eq('user_id', userId)
    .eq('resource_name', resourceName);

  if (error) throw error;
  return { success: true, userId, resourceName };
}

module.exports = { isPermitted, grantPermission, revokePermission };
