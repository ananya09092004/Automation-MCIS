const { createClient } = require('@supabase/supabase-js');
const logger = require('../services/logger');
const { isVoiceDevice } = require('./callerIdentity');

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

// ------------------------------------------------------------------
// PERMISSIONS_ENFORCED switch
//
// The first-time-access gate used to be disabled by an unconditional
// `return true; // TEMP: bypass for testing`. That behaviour is now an
// explicit, visible switch:
//
//   PERMISSIONS_ENFORCED unset / anything but 'true'  → gate OFF (same as
//       before: every resource is permitted). RED-tier actions are still
//       blocked separately by backend-routing/riskModel.js.
//   PERMISSIONS_ENFORCED=true → gate ON: resources outside SAFE_LIST
//       need a row in user_permissions for the caller.
//
// Do NOT turn it on for voice users yet: after a grant the voice client
// does not re-send the original command, so the user has to repeat it
// (see docs/SECURITY_FIXES_PRE_LAYER2.md → limitations).
//
// P-SEC-4: production deployments must set this EXPLICITLY ("true" or
// "false") -- config/validateConfig.js refuses to start the server in
// production if it is unset or some other value, and
// services/config/productionConfig.js's checkConfig() (scripts/
// check-config.js) reports the same as a fatal error before deploy.
// This module's own warning below is a secondary, best-effort log for
// anything that imports it directly without going through that gate.
// ------------------------------------------------------------------
function isPermissionsEnforced() {
  return process.env.PERMISSIONS_ENFORCED === 'true';
}

// Loud, once, at boot (this module is loaded by commandRoute at startup).
if (!isPermissionsEnforced() && process.env.NODE_ENV === 'production') {
  const msg = 'SECURITY WARNING: PERMISSIONS_ENFORCED is not "true" — first-time resource '
    + 'approval is DISABLED in production. Every non-RED automation action on any '
    + 'file/app/URL is permitted without a grant.';
  logger.warn(msg);
  console.warn(`[security] ${msg}`);
}

// Every holder of the voice device secret is one principal (see
// callerIdentity.isSamePrincipal): grants from a voice device must match
// checks from a voice device even though the client-supplied deviceId
// suffix differs between /api/command and /api/permissions/grant.
function permissionPrincipal(userId) {
  return isVoiceDevice(userId) ? 'voice-device' : userId;
}

// workspaceId (optional, Layer 2): when given, ONLY that workspace's
// admin-managed grants (workspace_permission_grants) count — a grant in one
// workspace never authorizes an execution in another. Without it (voice /
// device path) behaviour is exactly as before (per-principal user_permissions).
async function isPermitted(userId, resourceName, workspaceId = null) {
  if (!isPermissionsEnforced()) return true;
  if (!resourceName) return true;
  if (SAFE_LIST.includes(String(resourceName).toLowerCase())) return true;
  if (workspaceId) {
    const { data, error } = await supabase
      .from('workspace_permission_grants')
      .select('id')
      .eq('workspace_id', workspaceId)
      .eq('resource_name', resourceName)
      .maybeSingle();
    if (error) {
      logger.error(`isPermitted workspace lookup failed: ${error.message}`);
      return false; // fail closed when enforcement is on
    }
    return !!data;
  }
  if (!userId) return false;

  // permissionPrincipal(userId), not the raw userId: grantPermission/
  // revokePermission below both store/clear rows under that same
  // collapsed principal, so a voice-device grant must be looked up the
  // same way or it would never match. maybeSingle() (not single()) is
  // deliberate too -- "no row yet" is the ordinary not-granted case,
  // not a query error, and must not be conflated with one.
  try {
    const { data, error } = await supabase
      .from('user_permissions')
      .select('granted')
      .eq('user_id', permissionPrincipal(userId))
      .eq('resource_name', resourceName)
      .maybeSingle();

    // Fail CLOSED: an unreachable/misconfigured permissions store (or
    // any other query error) must never be treated as "granted" --
    // that would turn a database hiccup into a silent bypass, exactly
    // the failure mode this function previously had unconditionally.
    if (error) {
      logger.error(`isPermitted lookup failed: ${error.message}`);
      return false;
    }
    return !!(data && data.granted);
  } catch (error) {
    logger.error(`isPermitted lookup threw: ${error.message}`);
    return false;
  }
}

async function grantPermission(userId, resourceName) {
  const { error } = await supabase
    .from('user_permissions')
    .upsert({ user_id: permissionPrincipal(userId), resource_name: resourceName, granted: true }, { onConflict: 'user_id,resource_name' });

  if (error) throw error;
  return { success: true, userId, resourceName };
}

async function revokePermission(userId, resourceName) {
  const { error } = await supabase
    .from('user_permissions')
    .update({ granted: false })
    .eq('user_id', permissionPrincipal(userId))
    .eq('resource_name', resourceName);

  if (error) throw error;
  return { success: true, userId, resourceName };
}

module.exports = { isPermitted, grantPermission, revokePermission, isPermissionsEnforced, permissionPrincipal };
